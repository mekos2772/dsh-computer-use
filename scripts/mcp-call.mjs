// Temporary MCP client: one tools/call per invocation, prints text content or error.
// usage: node _tmp-mcp.mjs <tool> '<json-args>'
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tool = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const server = spawn('node', [join(here, '..', 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
server.stderr.on('data', (c) => process.stderr.write(c));
let buf = '';
server.stdout.setEncoding('utf8');
server.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === 2) {
      if (msg.error) { console.log('MCP ERROR:', msg.error.message); server.kill(); process.exit(1); }
      for (const block of msg.result.content ?? []) {
        if (block.type === 'text') console.log(block.text);
        else if (block.type === 'image') console.log(`[image ${block.mimeType} ${block.data?.length}b]`);
      }
      if (msg.result.isError) process.exit(3);
      // Let the overlay animation play out visibly (move + arrival + pulse +
      // graceful fade and cursor return) before tearing the session down.
      setTimeout(() => { server.kill(); process.exit(0); }, 2200);
    }
  }
});
server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } })}\n`);
setTimeout(() => { console.error('client timeout'); server.kill(); process.exit(4); }, 90000);
