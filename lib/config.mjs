import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export async function readConfig() {
  const config = { ...process.env };
  try {
    for (const line of (await readFile(join(ROOT, '.env.local'), 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (match) config[match[1]] = match[2];
    }
  } catch {}
  return config;
}

export function redact(message, config = {}) {
  let text = String(message);
  for (const [key, value] of Object.entries(config)) {
    if (/KEY|SECRET|TOKEN/.test(key) && value && value.length > 8) text = text.replaceAll(value, '[redacted]');
  }
  return text.replace(/(?:wt_|sk-or-v1-|whsec_)[A-Za-z0-9_-]+/g, '[redacted]');
}

export async function alebex(method, path, body, engine = false) {
  const cfg = await readConfig();
  const base = engine ? (cfg.ALEBEX_ENGINE_URL || 'https://api.voice.alebex.ai') : (cfg.ALEBEX_API_URL || 'https://api.alebex.ai/api/v1');
  const response = await fetch(base + path, {
    method, headers: { Authorization: `Bearer ${cfg.ALEBEX_API_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(redact(payload.error?.message || (typeof payload.detail === 'string' ? payload.detail : `Alebex returned ${response.status}`), cfg)), { status: response.status });
  return payload;
}
