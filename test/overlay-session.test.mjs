// Temporary E2E for the resident overlay session: the software cursor and the
// screen-edge glow must PERSIST between two consecutive actions (official
// turn-ended semantics) and only clear when the session ends.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokePowerShell } from '../lib/ps1.js';
import { buildTools, stopOverlay } from '../lib/tools.js';
import { ComputerUseSession } from '../lib/session.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const PS_ACTIVATE = `
$sig = @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@
$k = Add-Type -MemberDefinition $sig -Name CuOvActivate -Namespace Win32 -PassThru
$proc = Get-Process -Id ([int]$env:G_PID) -ErrorAction SilentlyContinue
if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { Write-Output 'activated=0'; exit 0 }
$h = $proc.MainWindowHandle
[void]$k::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[void]$k::ShowWindow($h, 9)
[void]$k::SetForegroundWindow($h)
[void]$k::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 400
if ($k::GetForegroundWindow() -eq $h) { Write-Output 'activated=1' } else { Write-Output 'activated=0' }
`;

function overlayPids() {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*overlay.ps1*' } | Select-Object -ExpandProperty ProcessId`],
    { encoding: 'utf8' }).trim();
  return out ? out.split(/\r?\n/).map((s) => parseInt(s, 10)).filter(Number.isFinite) : [];
}

function captureScreen(name, x, y, w, h) {
  const ps = `Add-Type -AssemblyName System.Drawing;` +
    `$b=New-Object System.Drawing.Bitmap(${w},${h});` +
    `$g=[System.Drawing.Graphics]::FromImage($b);` +
    `$g.CopyFromScreen(${x},${y},0,0,$b.Size);` +
    `$b.Save('${join(tmpdir(), name).replaceAll('\\', '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png);` +
    `$g.Dispose();$b.Dispose();'saved'`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
}

const listed = await invokePowerShell({ action: 'list_apps' });
const hit = (listed.apps ?? []).find((a) => a.app === 'ApplicationFrameHost' && /计算器|Calculator/i.test(String(a.title ?? '')));
if (!hit) { console.log('FAIL  no Calculator window'); process.exit(1); }
execFileSync('powershell.exe', ['-NoProfile', '-Command', PS_ACTIVATE],
  { encoding: 'utf8', env: { ...process.env, G_PID: String(hit.pid) } });

const ctx = { get: () => null, tools: { register() {} }, effect() {} };
const session = new ComputerUseSession();
const tools = Object.fromEntries(buildTools(ctx, session, {
  askBeforeActions: false,
  includeScreenshot: false,   // speed: annotations not needed here
  fx: { overlay: true, screenshot: false },
}).map((t) => [t.name, t]));
const app = String(hit.pid);

const st = await tools.get_app_state.execute({ app }, {});
const centerOf = (aid) => {
  const el = (session.state?.elements ?? []).find((e) => e.automationId === aid);
  if (!el) return null;
  return { x: el.frame.x + Math.round(el.frame.width / 2), y: el.frame.y + Math.round(el.frame.height / 2) };
};
const c3 = centerOf('num3Button');
const c2 = centerOf('num2Button');
if (!c3 || !c2) { console.log('FAIL  buttons not in tree'); process.exit(1); }

const display = () => tools.get_app_state.execute({ app }, {}).then((r) => (r.treeText.match(/显示为 (\d+)/) || [])[1] ?? null);

// --- action 1: resident session spawns ---------------------------------------
const r1 = await tools.click.execute({ app, x: c3.x, y: c3.y }, {}); console.log('click1:', r1.via, `(${r1.x},${r1.y})`, r1.note ?? '');
const pids1 = overlayPids();
check('overlay process alive after action 1 (resident, not faded)', pids1.length === 1, `pids=${pids1}`);
check('display gained a 3', (await display() ?? '').endsWith('3'));

// --- between actions: capture proof + same PID reuse --------------------------
await new Promise((r) => setTimeout(r, 1200));   // well inside hold; glow breathing
captureScreen('ov-between-glyph.png', 2137, 757, 500, 500);   // around the click point
captureScreen('ov-between-glow.png', 1080, 0, 400, 160);      // top screen edge
const pidsMid = overlayPids();

// --- action 2: same resident session must be reused ---------------------------
const r2 = await tools.click.execute({ app, x: c2.x, y: c2.y }, {}); console.log('click2:', r2.via, `(${r2.x},${r2.y})`, r2.note ?? ''); await new Promise((r) => setTimeout(r, 900));
const pids2 = overlayPids();
check('overlay process STILL alive after action 2', pids2.length === 1, `pids=${pids2}`);
check('SAME overlay process reused across actions (no per-action respawn)',
  pids1.length === 1 && pidsMid.length === 1 && pids1[0] === pidsMid[0] && pids2[0] === pids1[0],
  `${pids1[0]} -> ${pids2[0]}`);
check('display ends with 32 (3 then 2 clicked)', (await display() ?? '').endsWith('32'));

// --- session end: stopOverlay clears glyph + glow + restores cursor ------------
stopOverlay();
await new Promise((r) => setTimeout(r, 2500));
const pidsEnd = overlayPids();
check('overlay process gone after stopOverlay()', pidsEnd.length === 0, `pids=${pidsEnd}`);
captureScreen('ov-after-end.png', 1080, 0, 400, 160);
captureScreen('ov-after-end-glyph.png', 2137, 757, 500, 500);

console.log(`\ncaptures in ${tmpdir()}: ov-between-glyph.png ov-between-glow.png ov-after-end*.png`);
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
