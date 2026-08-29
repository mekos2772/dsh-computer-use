// Temporary verification: tree lines carry frame=[x,y,w,h]; JS rescale maps
// capture-space frames into the attached-image space (modelScale); header noted.
import { invokePowerShell } from '../lib/ps1.js';
import { buildTools, scaleTreeFrames } from '../lib/tools.js';
import { ComputerUseSession } from '../lib/session.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// 1) Raw kernel tree: every element line ends with frame=[x,y,w,h]
const apps = await invokePowerShell({ action: 'list_apps' });
if (!apps.apps?.length) { console.log('FAIL  no visible windows to probe'); process.exit(1); }
const target = apps.apps.find((a) => a.foreground) ?? apps.apps[0];
console.log(`probing: ${target.app} (pid ${target.pid}) "${String(target.title).slice(0, 60)}"`);

const raw = await invokePowerShell({ action: 'get_state', app: String(target.pid), includeScreenshot: false, maxDepth: 6, maxNodes: 120 });
const frameRe = /frame=\[(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]$/;
const elementLines = raw.treeText.split('\n').filter((l) => /^\t*\d+ /.test(l));
check('kernel emits frame on element lines', elementLines.length > 0 && elementLines.every((l) => frameRe.test(l)),
  `${elementLines.length} element lines`);

// 2) scaleTreeFrames pure function: round(capture * scale)
const sample = elementLines.slice(0, 5).map((l) => {
  const m = l.match(frameRe);
  return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
});
const scaledText = scaleTreeFrames(raw.treeText, 0.7);
const scaledSample = scaledText.split('\n').filter((l) => /^\t*\d+ /.test(l)).slice(0, 5).map((l) => {
  const m = l.match(frameRe);
  return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
});
const roundOk = sample.every((f, i) =>
  scaledSample[i].x === Math.round(f.x * 0.7) && scaledSample[i].y === Math.round(f.y * 0.7)
  && scaledSample[i].w === Math.round(f.w * 0.7) && scaledSample[i].h === Math.round(f.h * 0.7));
check('scaleTreeFrames scales all four components', roundOk);
check('scaleTreeFrames is identity at scale 1', scaleTreeFrames(raw.treeText, 1) === raw.treeText);

// 3) buildTools integration: fake attachments reporting a downscaled ref
const scale = 0.7;
const fakeRefW = Math.max(1, Math.round(raw.screenshotWidth * scale));
const fakeRefH = Math.max(1, Math.round(raw.screenshotHeight * scale));
// The implementation derives modelScale as refWidth/captureWidth. With a
// nominal 0.7 ref that ratio deviates from 0.7 by rounding (e.g.
// round(2582*0.7)=1807 -> 1807/2582 ~= 0.69985), so expected frames must use
// the same effective scale — large frames otherwise cross a rounding boundary.
const effScale = fakeRefW / raw.screenshotWidth;
const fakeCtx = {
  get(name) {
    if (name === 'attachments') {
      return { saveImages: async (inputs) => [{ attachmentId: 'probe1', mediaType: inputs[0].mediaType, width: fakeRefW, height: fakeRefH }] };
    }
    return undefined;
  },
  tools: { register() {} },
  effect() {},
};
const tools = buildTools(fakeCtx, new ComputerUseSession(), { askBeforeActions: false, maxDepth: 6, maxNodes: 120, includeScreenshot: true });
const get = tools.find((t) => t.name === 'get_app_state');
const out = await get.execute({ app: String(target.pid) }, { signal: undefined });
const outLines = out.treeText.split('\n').filter((l) => /^\t*\d+ /.test(l));
const headOk = out.treeText.includes(`Screenshot: ${fakeRefW}x${fakeRefH} px — tree frame=[x,y,w,h] and click/scroll/drag x/y are all in these attached-image pixels`);
check('execute header declares attached-image space', headOk, `ref ${fakeRefW}x${fakeRefH}`);
const scaleOk = outLines.length === elementLines.length && sample.every((f, i) => {
  const m = outLines[i].match(frameRe);
  return m && +m[1] === Math.round(f.x * effScale) && +m[2] === Math.round(f.y * effScale)
    && +m[3] === Math.round(f.w * effScale) && +m[4] === Math.round(f.h * effScale);
});
check('execute rescales frames to attached-image space', scaleOk);
console.log('sample:', outLines.find((l) => /^\t*\d+ /.test(l)));

process.exit(failures ? 1 : 0);
