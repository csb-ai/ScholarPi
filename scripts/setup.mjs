import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(cmd, args, cwd = root) {
  const p = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && cmd === 'npm',
    windowsHide: true,
  });
  if (p.status !== 0) process.exit(p.status ?? 1);
}
if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node 24+ required');
run('npm', ['ci']);
run('uv', ['sync', '--managed-python', '--python', '3.12'], path.join(root, 'services/knowledge'));
console.log('Dependencies ready. Configure .env before npm run dev.');
