import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import net from 'node:net';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });
const webPort = process.env.WEB_PORT ?? '5173';
const mcpUrl = process.env.MCP_URL ?? 'http://127.0.0.1:7332/mcp';
const children = [];
let closing = false;
function start(command, args, cwd = root) {
  const c = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32' && command === 'npm',
    env: { ...process.env, SCHOLARPI_MCP_PORT: new URL(mcpUrl).port || '7332' },
  });
  children.push(c);
  c.on('exit', (code) => {
    if (!closing) {
      console.error(`${command} exited ${code}`);
      stop(code || 1);
    }
  });
  return c;
}
function stop(exitCode = 0) {
  if (closing) return;
  closing = true;
  for (const c of children) {
    if (process.platform === 'win32' && c.pid)
      spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 500);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const port of [
  Number(webPort),
  Number(process.env.SERVER_PORT ?? 7331),
  Number(new URL(mcpUrl).port || 7332),
])
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () =>
      reject(Error(`端口 ${port} 已占用，请结束原 ScholarPi 启动器或修改 .env；不会连接该进程`)),
    );
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
start('uv', ['run', 'python', '-m', 'scholarpi_knowledge'], path.join(root, 'services/knowledge'));
for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(new URL('/health', mcpUrl));
    if (r.ok) break;
  } catch {}
  if (i === 119) {
    console.error('MCP health timeout');
    stop(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}
start('npm', ['run', 'server']);
for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.SERVER_PORT ?? 7331}/api/health`);
    if (r.ok) break;
  } catch {}
  if (i === 119) {
    console.error('API health timeout');
    stop(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}
start('npm', [
  '--workspace',
  'apps/web',
  'run',
  'dev',
  '--',
  '--host',
  '127.0.0.1',
  '--port',
  webPort,
  '--strictPort',
]);
console.log(
  `ScholarPi: http://127.0.0.1:${webPort} • API ${process.env.SERVER_PORT ?? 7331} • MCP ${mcpUrl}`,
);
