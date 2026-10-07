import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT, readConfig } from '../lib/config.mjs';

const envPath = join(ROOT, '.env.local');
const cfg = await readConfig();
let pairToken = cfg.PROFILE_PAIR_TOKEN;
if (!pairToken) {
  pairToken = randomBytes(32).toString('base64url');
  const env = await readFile(envPath, 'utf8');
  await writeFile(envPath, env.replace(/\s*$/, '\n') + `PROFILE_PAIR_TOKEN=${pairToken}\n`, { mode: 0o600 });
}
const currentEnv = await readFile(envPath, 'utf8');
const profileEnv = /^PROFILE_BROWSER_REQUIRED=/m.test(currentEnv)
  ? currentEnv.replace(/^PROFILE_BROWSER_REQUIRED=.*$/m, 'PROFILE_BROWSER_REQUIRED=true')
  : currentEnv.replace(/\s*$/, '\n') + 'PROFILE_BROWSER_REQUIRED=true\n';
await writeFile(envPath, profileEnv, { mode: 0o600 });
const destination = join(ROOT, '.local/chrome-profile-bridge');
await mkdir(destination, { recursive: true, mode: 0o700 });
for (const name of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js']) {
  await cp(join(ROOT, 'extension', name), join(destination, name));
}
await writeFile(join(destination, 'pairing.json'), JSON.stringify({ pairToken }), { mode: 0o600 });
console.log(`Private Tim Hortons bridge prepared at ${destination}. Pairing credentials are kept out of the source folder.`);
