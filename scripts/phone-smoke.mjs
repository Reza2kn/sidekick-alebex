import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, readConfig, alebex, redact } from '../lib/config.mjs';

const cfg = await readConfig();
const evidence = { createdAt: new Date().toISOString(), test: 'Authorized builder callback through Alebex', provider: 'Twilio', destination: 'builder supplied own number', status: 'not_started' };
try {
  const result = await alebex('POST', '/public/call/phone', {
    agentId: cfg.ALEBEX_CALLER_AGENT_ID,
    to: cfg.DEMO_HUMAN_PHONE,
    twilio: { accountSid: cfg.TWILIO_ACCOUNT_SID, authToken: cfg.TWILIO_AUTH_TOKEN, phoneNumber: cfg.TWILIO_PHONE_NUMBER },
    context: 'This is a hackathon test explicitly requested by the builder at their own supplied phone number. Purpose: human_help. Requested task: Tell the builder that the Sidekick voice assistant is testing its phone connection, and ask what coffee they would like for the demo. Relay the answer and finish. No purchase, reservation, or business call is authorized. Do not claim this test succeeded unless the recipient answers.'
  }, true);
  Object.assign(evidence, { callId: result.id, providerCallId: result.providerCallId, status: result.status });
} catch (error) {
  Object.assign(evidence, { status: 'failed_to_start', httpStatus: error.status || null, error: redact(error.message, cfg) });
}
await mkdir(join(ROOT, 'research'), { recursive: true });
await writeFile(join(ROOT, 'research', 'phone-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
