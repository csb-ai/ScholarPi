import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, '.env');
const mode = process.argv[2] ?? 'status';
if (!['on', 'off', 'status'].includes(mode)) {
  console.error('Usage: node scripts/runtime-harness.mjs on|off|status'); process.exit(1);
}
const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
const pattern = /^\s*EXECUTION_HARNESS_ENABLED\s*=.*$/gm;
if (mode !== 'status') {
  const line = `EXECUTION_HARNESS_ENABLED=${mode === 'on'}`;
  const next = pattern.test(current) ? current.replace(pattern, line)
    : current + (current && !current.endsWith('\n') ? '\n' : '') + line + '\n';
  fs.writeFileSync(target, next, 'utf8');
  console.log(`Runtime harness ${mode}. Restart npm run dev to apply. Existing data is retained.`);
} else {
  const value = [...current.matchAll(/^\s*EXECUTION_HARNESS_ENABLED\s*=\s*(.*?)\s*$/gm)].at(-1)?.[1];
  console.log(`Runtime harness: ${value === 'false' ? 'off' : 'on (default)'}.`);
}
