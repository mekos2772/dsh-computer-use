#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, 'lib', 'overlay.ps1');
const child = spawn('powershell.exe', [
  '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Sta', '-File', script,
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

const started = Date.now();
let output = '';
let stderr = '';
let arrived = false;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  output += chunk;
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.event === 'arrived' && !arrived) {
        arrived = true;
        const elapsed = Date.now() - started;
        if (elapsed < 900 || elapsed > 4000) {
          throw new Error(`unexpected arrival time: ${elapsed}ms`);
        }
        child.stdin.write(`${JSON.stringify({ command: 'commit' })}\n`);
        child.stdin.end();
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      child.kill();
      throw error;
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

child.stdin.write(`${JSON.stringify({
  points: [{ x: 180, y: 180 }, { x: 520, y: 340 }],
  kind: 'click',
  fog: true,
  pulse: true,
  lens: false,
  interactionIndex: 1,
})}\n`);

const exitCode = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error(`overlay protocol test timed out\nstdout: ${output}\nstderr: ${stderr}`));
  }, 8000);
  child.once('error', reject);
  child.once('close', (code) => {
    clearTimeout(timeout);
    resolve(code);
  });
});

if (!arrived || exitCode !== 0) {
  throw new Error(`overlay failed: arrived=${arrived} exit=${exitCode}\nstdout: ${output}\nstderr: ${stderr}`);
}
console.log('overlay arrival/commit protocol passed');
