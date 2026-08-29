// Discrete grid-point selection demo ("编号十字准星网格选点") for dsh-computer-use.
// Zero new dependencies: drives the resident UIA kernel through lib/ps1.js and
// uses PowerShell System.Drawing (one execFileSync spawn per combo) for all
// image work. lib/ is not modified.
//
// Rationale (measured on this machine): direct vision coordinate regression is
// unstable (4px error on "5" but 115px on "3"), while a discrete multiple
// choice ("which marker id is closest to the target?") only requires
// recognition. This script overlays numbered crosshair markers (A1..J10 style)
// on the captured screenshot, maps each marker id back to capture pixels, and
// optionally snaps the point to the smallest invokable element frame that
// contains it before clicking (kernel click x/y are window-relative capture px,
// mapped internally via $rect.x + $x).
//
// Subcommands:
//   node scripts/_tmp-grid-demo.mjs observe [--mode full,roi:NumberPad] [--grid 10x10,adaptive]
//     1) list_apps -> find Calculator (ApplicationFrameHost + title 计算器/Calculator);
//        CU_TARGET_PID env overrides the discovered pid.
//     2) get_state (screenshot + treeText + window.bounds), save capture.png
//     3) per mode x grid combo: crop/resize the ROI to <=1024 display px, draw
//        numbered crosshair markers, write roi-<combo>.png / grid-<combo>.png /
//        grid-<combo>.json, and print a marker coverage matrix for the digit
//        buttons (5/7/3 bolded). No vision model involved.
//   node scripts/_tmp-grid-demo.mjs pick <markerId> [--no-snap] [--combo mode/grid]
//     marker -> capture px -> (snap to smallest invokable containing frame)
//     -> kernel click -> get_state -> prints {marker, rawPoint, snapped, display}.
//
// Artifacts under %TEMP%/dsh-cu-grid/: capture.png, roi-<combo>.png,
// grid-<combo>.png (annotated), grid-<combo>.json, state.json.
// (<combo> is the file-safe form of "<mode>-<grid>"; Windows filenames cannot
// contain ':', so roi:NumberPad becomes roi-NumberPad.)

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { invokePowerShell } from '../lib/ps1.js';

const DIR = join(tmpdir(), 'dsh-cu-grid');
mkdirSync(DIR, { recursive: true });

const DISPLAY_MAX = 1024;          // annotated display image: longest side
const TARGET_DIGITS = [5, 7, 3];   // bolded in the coverage matrix
const ADAPTIVE_FACTOR = 0.4;       // spacing_capture = factor * median(min(w,h))
const ADAPTIVE_GROWTH = 1.15;      // spacing growth per step while markers > limit
const MARKER_LIMIT = 100;

const [, , cmd, ...rest] = process.argv;
const flagOf = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const hasFlag = (name) => rest.includes(name);
const fileKey = (s) => s.replace(/[^A-Za-z0-9]+/g, '-');
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------------------------------------------------------------------------
// treeText parsing
// ---------------------------------------------------------------------------
// Element line shape (leading tabs = depth):
//   <index> <Role> [name] [Value: ...] [ID: <autoId>] [(disabled)] [Secondary Actions: a, b] frame=[x,y,w,h]
// frame is window-relative capture pixels — the same space as click x/y.
function parseElements(treeText) {
  const out = [];
  for (const line of treeText.split('\n')) {
    if (!/^\t*\d+ /.test(line)) continue;
    const frame = line.match(/frame=\[(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]\s*$/);
    if (!frame) continue;
    const idxRole = line.match(/^\t*(\d+) (\S+)/);
    const auto = line.match(/ ID: ([^\s()]+)/);
    const act = line.match(/Secondary Actions: (.*?) frame=\[/);
    const actions = act ? act[1].split(',').map((s) => s.trim()) : [];
    out.push({
      index: +idxRole[1],
      role: idxRole[2],
      automationId: auto ? auto[1] : null,
      invoke: actions.includes('Invoke'),
      actions,
      frame: { x: +frame[1], y: +frame[2], w: +frame[3], h: +frame[4] },
    });
  }
  return out;
}

function colLabel(i) { // 0-based -> A..Z, AA, AB, ...
  let s = '';
  let n = i + 1;
  while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Snap: smallest frame that contains the point AND supports Invoke.
function snapPoint(elements, px, py) {
  let best = null;
  for (const e of elements) {
    if (!e.invoke) continue;
    const f = e.frame;
    if (px < f.x || px > f.x + f.w || py < f.y || py > f.y + f.h) continue;
    const area = f.w * f.h;
    if (!best || area < best.area) best = { ...e, area };
  }
  if (!best) return null;
  return {
    automationId: best.automationId ?? null,
    role: best.role,
    center: [Math.round(best.frame.x + best.frame.w / 2), Math.round(best.frame.y + best.frame.h / 2)],
  };
}

// ---------------------------------------------------------------------------
// grid construction (display space markers -> capture space coords)
// ---------------------------------------------------------------------------
function buildMarkers(gridKind, dw, dh, roi, scaleX, scaleY, elements) {
  const fixed = gridKind.match(/^(\d+)x(\d+)$/);
  if (fixed) {
    const cols = +fixed[1];
    const rows = +fixed[2];
    const markers = [];
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const dx = (j + 0.5) * dw / cols;         // cell centers: every display
        const dy = (i + 0.5) * dh / rows;         // point has a nearby marker
        markers.push({ id: colLabel(j) + (i + 1), dx: r1(dx), dy: r1(dy), cx: r2(roi.x + dx * scaleX), cy: r2(roi.y + dy * scaleY) });
      }
    }
    return { kind: gridKind, cols, rows, spacingDisp: r1(dw / cols), spacingCap: r2(roi.w / cols), markers };
  }
  if (gridKind !== 'adaptive') throw new Error(`unknown grid kind "${gridKind}"`);
  // Invokable elements inside the ROI set the density: median of min(w,h).
  const inRoi = elements.filter((e) => e.invoke
    && e.frame.x >= roi.x - 1 && e.frame.y >= roi.y - 1
    && e.frame.x + e.frame.w <= roi.x + roi.w + 1
    && e.frame.y + e.frame.h <= roi.y + roi.h + 1);
  if (!inRoi.length) throw new Error('adaptive: no invokable elements inside ROI');
  const medCap = median(inRoi.map((e) => Math.min(e.frame.w, e.frame.h)));
  let spacing = Math.max(10, (ADAPTIVE_FACTOR * medCap) / scaleX); // display px
  let cols = Math.max(1, Math.floor(dw / spacing) + 1);
  let rows = Math.max(1, Math.floor(dh / spacing) + 1);
  while (cols * rows > MARKER_LIMIT) {
    spacing *= ADAPTIVE_GROWTH;
    cols = Math.max(1, Math.floor(dw / spacing) + 1);
    rows = Math.max(1, Math.floor(dh / spacing) + 1);
  }
  // Center the lattice so edge margins stay <= spacing/2.
  const mx = Math.max(0, (dw - (cols - 1) * spacing) / 2);
  const my = Math.max(0, (dh - (rows - 1) * spacing) / 2);
  const markers = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const dx = Math.min(dw, mx + j * spacing);
      const dy = Math.min(dh, my + i * spacing);
      markers.push({ id: colLabel(j) + (i + 1), dx: r1(dx), dy: r1(dy), cx: r2(roi.x + dx * scaleX), cy: r2(roi.y + dy * scaleY) });
    }
  }
  return { kind: 'adaptive', cols, rows, spacingDisp: r1(spacing), spacingCap: r2(spacing * scaleX), medianCap: r2(medCap), markers };
}

// ---------------------------------------------------------------------------
// coverage matrix: per digit button, how well does the marker lattice cover it
// ---------------------------------------------------------------------------
function coverageReport(numButtons, markers, elements) {
  return numButtons.map((b) => {
    const f = b.frame;
    const center = [f.x + f.w / 2, f.y + f.h / 2];
    const inside = [];
    let nearest = null;
    for (const m of markers) {
      if (m.cx >= f.x && m.cx <= f.x + f.w && m.cy >= f.y && m.cy <= f.y + f.h) inside.push(m);
      const d = Math.hypot(m.cx - center[0], m.cy - center[1]);
      if (!nearest || d < nearest.d) nearest = { id: m.id, d, cx: m.cx, cy: m.cy };
    }
    inside.sort((a, b2) => Math.hypot(a.cx - center[0], a.cy - center[1]) - Math.hypot(b2.cx - center[0], b2.cy - center[1]));
    const snap = nearest ? snapPoint(elements, nearest.cx, nearest.cy) : null;
    return { digit: b.digit, automationId: b.automationId, frame: f, inside, nearest, snap, pass: inside.length > 0 };
  });
}

function printReport(key, geo, gridInfo, report) {
  const lines = [];
  lines.push(`=== ${key} ===`);
  lines.push(`roi=[${geo.roi.x},${geo.roi.y},${geo.roi.w},${geo.roi.h}] display=${geo.dw}x${geo.dh} scale=${r2(geo.scaleX)} `
    + `grid=${gridInfo.kind} cols=${gridInfo.cols} rows=${gridInfo.rows} `
    + `spacing=${gridInfo.spacingDisp}disp/${gridInfo.spacingCap}cap markers=${gridInfo.markers.length}`);
  lines.push('digit  automationId  frame(capture px)    in  nearest  dist_px  snap->          inside markers');
  for (const r of report) {
    const isTarget = TARGET_DIGITS.includes(r.digit);
    const row = [
      `${r.digit}${isTarget ? '*' : ' '}`,
      r.automationId.padEnd(13),
      `[${r.frame.x},${r.frame.y},${r.frame.w},${r.frame.h}]`.padEnd(20),
      String(r.inside.length).padStart(2),
      (r.nearest ? r.nearest.id : '-').padEnd(8),
      r.nearest ? r1(r.nearest.d).toFixed(1) : '-',
      (r.snap ? r.snap.automationId : '-').padEnd(15),
      r.inside.slice(0, 6).map((m) => m.id).join(',') + (r.inside.length > 6 ? ` +${r.inside.length - 6}` : ''),
    ].join('  ').trimEnd() + (r.pass ? '' : '  << FAIL (0 markers inside)');
    lines.push(isTarget ? `\x1b[1m${row}\x1b[0m` : row);
  }
  const passCount = report.filter((r) => r.pass).length;
  lines.push(`coverage: ${passCount}/${report.length} digit buttons have >=1 marker; total markers ${gridInfo.markers.length} (limit ${MARKER_LIMIT})`);
  console.log(lines.join('\n') + '\n');
  return { passCount, total: report.length, rows: report };
}

// ---------------------------------------------------------------------------
// PowerShell System.Drawing: crop capture -> display ROI png -> annotated png
// (PS 5.1 syntax: no ternary, no ??; Add-Type System.Drawing directly.)
// Paths/params come in through env vars to avoid quoting issues.
// ---------------------------------------------------------------------------
const PS_ANNOTATE = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($env:G_SRC)
$dw = [int]$env:G_DW
$dh = [int]$env:G_DH
$srcRect = New-Object System.Drawing.Rectangle([int]$env:G_RX, [int]$env:G_RY, [int]$env:G_RW, [int]$env:G_RH)
$bmp = New-Object System.Drawing.Bitmap($dw, $dh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$dstRect = New-Object System.Drawing.Rectangle(0, 0, $dw, $dh)
$g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save($env:G_ROI_PNG, [System.Drawing.Imaging.ImageFormat]::Png)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$markers = ConvertFrom-Json $env:G_MARKERS
$font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.GraphicsUnit]::Pixel)
$halo = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 3.4)
$cross = New-Object System.Drawing.Pen([System.Drawing.Color]::Crimson, 1.5)
$back = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$ink = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Crimson)
foreach ($m in $markers) {
  $x = [int][math]::Round($m.dx)
  $y = [int][math]::Round($m.dy)
  $g.DrawLine($halo, $x - 5, $y, $x + 5, $y)
  $g.DrawLine($halo, $x, $y - 5, $x, $y + 5)
  $g.DrawLine($cross, $x - 5, $y, $x + 5, $y)
  $g.DrawLine($cross, $x, $y - 5, $x, $y + 5)
  $sz = $g.MeasureString($m.id, $font)
  $lw = [int][math]::Ceiling($sz.Width)
  $lh = [int][math]::Ceiling($sz.Height)
  $lx = $x + 4
  if ($lx + $lw -gt $dw) { $lx = $x - 4 - $lw }
  $ly = $y - 4 - $lh
  if ($ly -lt 0) { $ly = $y + 4 }
  $g.FillRectangle($back, $lx - 1, $ly - 1, $lw + 2, $lh + 2)
  $pt = New-Object System.Drawing.PointF($lx, $ly)
  $g.DrawString($m.id, $font, $ink, $pt)
}
$bmp.Save($env:G_ANNO_PNG, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$halo.Dispose(); $cross.Dispose(); $back.Dispose(); $ink.Dispose(); $font.Dispose()
$bmp.Dispose(); $src.Dispose()
Write-Output ('drawn ' + $markers.Count)
`;

function runPs(psScript, envExtra) {
  try {
    return execFileSync('powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...envExtra } }).trim();
  } catch (e) {
    throw new Error(`System.Drawing step failed: ${(e.stderr || e.message || '').slice(0, 400)}`);
  }
}

// get_state does NOT activate the target: its screenshot is a CopyFromScreen of
// the window rect, so any fullscreen/topmost window covering the app would be
// captured instead (UIA tree would still be the target's). Activate first.
const PS_ACTIVATE = `
$sig = @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@
$k = Add-Type -MemberDefinition $sig -Name CuGridActivate -Namespace Win32 -PassThru
$proc = Get-Process -Id ([int]$env:G_PID) -ErrorAction SilentlyContinue
if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { Write-Output 'activated=0 no-window'; exit 0 }
$h = $proc.MainWindowHandle
[void]$k::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[void]$k::ShowWindow($h, 9)
[void]$k::SetForegroundWindow($h)
[void]$k::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 500
if ($k::GetForegroundWindow() -eq $h) { Write-Output 'activated=1' } else { Write-Output 'activated=0' }
`;

function activateWindow(pid) {
  try {
    return runPs(PS_ACTIVATE, { G_PID: String(pid) }).includes('activated=1');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------
if (cmd === 'observe') {
  const modes = (flagOf('--mode') ?? 'full').split(',').map((s) => s.trim()).filter(Boolean);
  const grids = (flagOf('--grid') ?? '10x10').split(',').map((s) => s.trim()).filter(Boolean);

  let pid = Number(process.env.CU_TARGET_PID) || null;
  if (pid) {
    console.log(`target (CU_TARGET_PID): pid ${pid}`);
  } else {
    const listed = await invokePowerShell({ action: 'list_apps' });
    const hit = (listed.apps ?? []).find((a) =>
      (a.app === 'ApplicationFrameHost' || a.processName === 'ApplicationFrameHost')
      && /计算器|Calculator/i.test(String(a.title ?? '')));
    if (!hit) {
      console.error('FAIL: no Calculator window found (ApplicationFrameHost with 计算器/Calculator title). Open Calculator or set CU_TARGET_PID.');
      process.exit(1);
    }
    pid = hit.pid;
    console.log(`target: pid ${pid} "${hit.title}"`);
  }

  const activated = activateWindow(pid);
  if (!activated) console.log('WARNING: could not bring the target to foreground — the capture may show an occluding window');
  const t0 = Date.now();
  const st = await invokePowerShell({
    action: 'get_state', app: String(pid), includeScreenshot: true, fx: { overlay: false, screenshot: false },
  });
  if (!st.screenshot) { console.error('FAIL: kernel returned no screenshot'); process.exit(1); }
  if (!st.window.foreground) console.log('WARNING: target not foreground at capture time — annotated image may show the occluding window');
  console.log(`get_state: ${Date.now() - t0}ms, capture ${st.screenshotWidth}x${st.screenshotHeight}, tree ${st.treeText.split('\n').length} lines, foreground=${st.window.foreground}`);
  const capturePng = join(DIR, 'capture.png');
  writeFileSync(capturePng, Buffer.from(st.screenshot, 'base64'));

  const elements = parseElements(st.treeText);
  const numButtons = elements
    .filter((e) => /^num(\d)Button$/.test(e.automationId ?? ''))
    .map((e) => ({ ...e, digit: +e.automationId.match(/^num(\d)Button$/)[1] }))
    .sort((a, b) => a.digit - b.digit);
  if (!numButtons.length) { console.error('FAIL: no numNButton elements in tree (is standard calculator open?)'); process.exit(1); }

  const combos = {};
  const reports = {};
  for (const mode of modes) {
    for (const grid of grids) {
      const key = `${mode}/${grid}`;
      let roi;
      if (mode === 'full') {
        roi = { x: 0, y: 0, w: st.screenshotWidth, h: st.screenshotHeight };
      } else if (mode.startsWith('roi:')) {
        const anchor = elements.find((e) => e.automationId === mode.slice(4));
        if (!anchor) { console.log(`skip ${key}: element "${mode.slice(4)}" not in tree\n`); continue; }
        roi = { ...anchor.frame };
      } else { console.log(`skip ${key}: unknown mode "${mode}"\n`); continue; }
      if (roi.w < 8 || roi.h < 8) { console.log(`skip ${key}: roi too small\n`); continue; }

      const dw = roi.w >= roi.h ? DISPLAY_MAX : Math.max(1, Math.round(roi.w * DISPLAY_MAX / roi.h));
      const dh = roi.w >= roi.h ? Math.max(1, Math.round(roi.h * DISPLAY_MAX / roi.w)) : DISPLAY_MAX;
      const scaleX = roi.w / dw; // capture px per display px
      const scaleY = roi.h / dh;

      let gridInfo;
      try {
        gridInfo = buildMarkers(grid, dw, dh, roi, scaleX, scaleY, elements);
      } catch (e) { console.log(`skip ${key}: ${e.message}\n`); continue; }

      const fk = fileKey(key);
      const roiPng = join(DIR, `roi-${fk}.png`);
      const gridPng = join(DIR, `grid-${fk}.png`);
      const gridJson = join(DIR, `grid-${fk}.json`);
      const drawn = runPs(PS_ANNOTATE, {
        G_SRC: capturePng,
        G_DW: String(dw), G_DH: String(dh),
        G_RX: String(roi.x), G_RY: String(roi.y), G_RW: String(roi.w), G_RH: String(roi.h),
        G_ROI_PNG: roiPng, G_ANNO_PNG: gridPng,
        G_MARKERS: JSON.stringify(gridInfo.markers),
      });

      writeFileSync(gridJson, JSON.stringify({
        key, mode, grid, roi, display: { width: dw, height: dh },
        scaleX: r2(scaleX), scaleY: r2(scaleY), ...gridInfo,
        files: { roiPng, gridPng },
      }, null, 1));

      const report = coverageReport(numButtons, gridInfo.markers, elements);
      reports[key] = printReport(key, { roi, dw, dh, scaleX }, gridInfo, report);
      combos[key] = {
        mode, grid, roi, display: { width: dw, height: dh },
        scaleX: r2(scaleX), scaleY: r2(scaleY),
        gridKind: gridInfo.kind, cols: gridInfo.cols, rows: gridInfo.rows,
        spacingDisp: gridInfo.spacingDisp, spacingCap: gridInfo.spacingCap,
        markers: gridInfo.markers,
        files: { roiPng, gridPng, gridJson },
      };
      console.log(`${drawn} -> ${gridPng}\n`);
    }
  }

  if (!Object.keys(combos).length) { console.error('FAIL: no combo produced a grid'); process.exit(1); }

  // Pick the best combo: all digit buttons covered and <= MARKER_LIMIT markers,
  // then thickest per-button coverage, then smallest nearest-marker distance.
  const scored = Object.keys(combos).map((key) => {
    const rep = reports[key];
    return {
      key,
      total: combos[key].markers.length,
      passCount: rep.passCount,
      totalButtons: rep.total,
      minInside: Math.min(...rep.rows.map((r) => r.inside.length)),
      avgNearest: rep.rows.reduce((s, r) => s + (r.nearest ? r.nearest.d : 0), 0) / rep.rows.length,
    };
  });
  const okPool = scored.filter((s) => s.passCount === s.totalButtons && s.total <= MARKER_LIMIT);
  const pool = okPool.length ? okPool : scored;
  pool.sort((a, b) => (b.passCount - a.passCount) || (b.minInside - a.minInside)
    || (a.avgNearest - b.avgNearest) || (a.total - b.total));
  const best = pool[0];
  console.log(`SELECTED: ${best.key} (${okPool.length ? 'all buttons covered' : 'best-effort: no combo covers every button'})`);

  const state = {
    demo: 'dsh-computer-use discrete grid-point selection',
    pid,
    window: st.window,
    capture: { width: st.screenshotWidth, height: st.screenshotHeight },
    capturePng,
    treeText: st.treeText,
    capturedAt: new Date().toISOString(),
    targetDigits: TARGET_DIGITS,
    combos,
    selected: best.key,
  };
  writeFileSync(join(DIR, 'state.json'), JSON.stringify(state, null, 1));
  console.log(`state.json -> ${join(DIR, 'state.json')}`);
} else if (cmd === 'pick') {
  // ---------------------------------------------------------------------------
  // pick <markerId> [--no-snap] [--combo mode/grid]
  // ---------------------------------------------------------------------------
  const markerId = rest.find((a) => !a.startsWith('--'));
  if (!markerId) {
    console.error('usage: pick <markerId> [--no-snap] [--combo mode/grid]');
    process.exit(2);
  }
  const statePath = join(DIR, 'state.json');
  if (!existsSync(statePath)) { console.error(`FAIL: ${statePath} missing — run observe first`); process.exit(2); }
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const key = flagOf('--combo') ?? state.selected ?? Object.keys(state.combos)[0];
  const combo = state.combos[key];
  if (!combo) {
    console.error(`FAIL: combo "${key}" not in state.json (have: ${Object.keys(state.combos).join(', ')})`);
    process.exit(2);
  }
  const marker = combo.markers.find((m) => m.id.toLowerCase() === String(markerId).toLowerCase());
  if (!marker) {
    console.error(`FAIL: marker "${markerId}" not in combo ${key} (${combo.markers.length} markers, e.g. ${combo.markers.slice(0, 4).map((m) => m.id).join(',')})`);
    process.exit(2);
  }
  const elements = parseElements(state.treeText);
  const rawPoint = [marker.cx, marker.cy];
  let snapped = null;
  let clickAt = rawPoint;
  if (!hasFlag('--no-snap')) {
    snapped = snapPoint(elements, marker.cx, marker.cy);
    if (snapped) clickAt = snapped.center;
  }
  const click = await invokePowerShell({
    action: 'click', app: String(state.pid), x: Math.round(clickAt[0]), y: Math.round(clickAt[1]),
  });
  const after = await invokePowerShell({
    action: 'get_state', app: String(state.pid), includeScreenshot: false, fx: { disabled: true },
  });
  const dm = after.treeText.match(/显示为 (\d+)/) || after.treeText.match(/Display is (\d+)/);
  console.log(JSON.stringify({
    marker: marker.id,
    rawPoint,
    snapped,
    display: dm ? +dm[1] : null,
    clicked: [Math.round(clickAt[0]), Math.round(clickAt[1])],
    via: click.via ?? null,
  }, null, 1));
} else {
  console.error('usage:\n  node scripts/_tmp-grid-demo.mjs observe [--mode full,roi:NumberPad] [--grid 10x10,adaptive]\n  node scripts/_tmp-grid-demo.mjs pick <markerId> [--no-snap] [--combo mode/grid]');
  process.exit(2);
}
