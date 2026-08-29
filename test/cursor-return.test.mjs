// Temporary check: after an overlay-driven click and session end, the physical
// pointer must return to where the user's hand was (pre-session position).
// Target: the ZCode window's own title bar (a title-bar click is a no-op).
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { buildTools, stopOverlay } from '../lib/tools.js';
import { ComputerUseSession } from '../lib/session.js';
import { invokePowerShell } from '../lib/ps1.js';

writeFileSync(join(tmpdir(), 'cursor-pos.ps1'),
  `Add-Type @'
using System; using System.Runtime.InteropServices;
public class CP { [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p); public struct P { public int X, Y; } }
'@
$p = New-Object CP+P
[void][CP]::GetCursorPos([ref]$p)
Write-Output "$($p.X),$($p.Y)"`);
const cursorPos = () => {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', join(tmpdir(), 'cursor-pos.ps1')], { encoding: 'utf8' }).trim();
  const [x, y] = out.split(',').map(Number);
  return { x, y };
};

const before = cursorPos();
console.log('cursor before:', before);

const listed = await invokePowerShell({ action: 'list_apps' });
const hit = (listed.apps ?? []).find((a) => a.app === 'ZCode');
if (!hit) { console.log('FAIL no ZCode window'); process.exit(1); }
const ctx = { get: () => null, tools: { register() {} }, effect() {} };
const session = new ComputerUseSession();
const tools = Object.fromEntries(buildTools(ctx, session, { askBeforeActions: false, includeScreenshot: false, fx: { overlay: true } }).map((t) => [t.name, t]));
const app = String(hit.pid);
const st = await tools.get_app_state.execute({ app }, {});
const b = st.window.bounds;
const tx = Math.round(b.width / 2), ty = 16;   // title bar, harmless
await tools.click.execute({ app, x: tx, y: ty }, {});
stopOverlay();
await new Promise((r) => setTimeout(r, 3000));   // overlay exit + position return
const after = cursorPos();
console.log('cursor after :', after);
const dx = Math.abs(after.x - before.x), dy = Math.abs(after.y - before.y);
console.log(`${dx <= 3 && dy <= 3 ? 'PASS' : 'FAIL'}  pointer returned to pre-session position (dx=${dx}, dy=${dy})`);
process.exit(dx <= 3 && dy <= 3 ? 0 : 1);
