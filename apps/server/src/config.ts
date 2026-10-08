import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
export const config = {
  model: process.env.AGNES_MODEL ?? 'agnes-3.0-flash',
  baseUrl: process.env.AGNES_BASE_URL ?? 'https://apihub.agnes-ai.com/v1',
  apiKey: process.env.AGNES_API_KEY ?? '',
  mcpUrl: process.env.MCP_URL ?? 'http://127.0.0.1:7332/mcp',
  port: Number(process.env.SERVER_PORT ?? 7331),
  runTimeout: Number(process.env.RUN_TIMEOUT_MS ?? 180000),
  maxTools: Number(process.env.MAX_TOOL_CALLS ?? 8),
};
for (const dir of [
  'data/uploads',
  'data/pi-sessions',
  'artifacts/runs',
  'artifacts/protocol',
  'artifacts/eval',
  'artifacts/incidents',
])
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
export function cleanError(error: unknown): string {
  let s = error instanceof Error ? error.message : String(error);
  if (config.apiKey) s = s.split(config.apiKey).join('[redacted]');
  return s.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').slice(0, 2000);
}
