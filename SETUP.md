# Running Sidekick

Use Node.js 22 or newer and Google Chrome on the host laptop. The current website flow requires an active Codex operator with computer-use access to the signed-in Tim Hortons tab. OpenAI proposes browser actions and reads checkout evidence; it does not replace that operator or authorize a purchase.

## Private configuration

```sh
npm install
cp .env.example .env.local
chmod 600 .env.local
```

Edit `.env.local` with literal, unquoted `KEY=value` lines. Supply your own Alebex, OpenRouter, and OpenAI keys. Set `ALEBEX_AGENT_ID` to the main agent created in your own Alebex account; no participant's private agent ID is distributed. Set `PUBLIC_BASE_URL` to the HTTPS tunnel forwarding to this server. Alebex tool callbacks must reach that URL while the voice conversation is running.

Generate the private demo-access token without printing it:

```sh
node --input-type=module <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const path = '.env.local';
const text = await readFile(path, 'utf8');
const line = `DEMO_ACCESS_TOKEN=${randomBytes(32).toString('base64url')}`;
await writeFile(path, /^DEMO_ACCESS_TOKEN=.*$/m.test(text)
  ? text.replace(/^DEMO_ACCESS_TOKEN=.*$/m, line)
  : text.trimEnd() + '\n' + line + '\n', { mode: 0o600 });
NODE
```

This creates a new access token; run it once during initial setup. Keep `.env.local`, pairing files, phone numbers, and private access links out of Git and screenshots.

| Setting | Purpose |
| --- | --- |
| `ALEBEX_API_KEY`, `ALEBEX_AGENT_ID` | Live Alebex voice conversation using your account's existing main agent |
| `PUBLIC_BASE_URL` | Public HTTPS callback origin for session-specific voice tools and signed Alebex reports |
| `DEMO_ACCESS_TOKEN` | Private demo-session access and local operator API authorization |
| `OPENROUTER_API_KEY`, `OPENROUTER_VISION_MODEL` | Camera analysis; template selects `google/gemini-3.5-flash-lite` |
| `OPENAI_API_KEY`, `BROWSER_ORDER_PROVIDER=openai` | OpenAI DOM planning and checkout evidence |
| `OPENAI_BROWSER_MODEL` | Defaults to `gpt-6-luna` |
| `OPENAI_BROWSER_USE_DECISIONS=true` | Optional fixed-choice target proposal when the caller supplies an explicit `next_goal`; otherwise Responses is used |
| `BROWSER_ORDER_OPERATOR=true` | Queues requests for the active Codex operator; does not start unattended browser mutations |
| `PROFILE_BROWSER_REQUIRED=true`, `PROFILE_PAIR_TOKEN` | Requires the privately paired, signed-in Chrome profile |
| `ALEBEX_CALLER_AGENT_ID`, `ALEBEX_WEBHOOK_SECRET` | Account-specific values written by `configure-agents.mjs` |
| `TWILIO_CALLER_VERIFIED=false` | Keeps optional outbound phone tasks disabled |

The app still uses the OpenRouter key for vision and its website-capability readiness check, so configure both provider keys for this build. Nearby places, City washrooms, fountains, and official Tim Hortons branch lookup use public sources without a paid location key. Keep `PORT=4317`: the extension and profile bridge currently use that fixed local port.

## Agents and Chrome

`node scripts/alebex-probe.mjs` reads your Alebex account catalog. If you need a main demo agent, `node scripts/alebex-probe.mjs --voice` creates or reuses the dedicated Sidekick agent and makes one bounded synthetic web-voice test; it does not dial a telephone. Set the generated `agent.id` from its private result in `ALEBEX_AGENT_ID`. This bootstrap does not populate that environment field automatically.

After setting the main agent ID and public HTTPS origin:

```sh
node scripts/configure-agents.mjs
node scripts/build-profile-extension.mjs
npm start
```

`configure-agents.mjs` updates the existing main agent's prompt, creates or reuses the optional caller agent, creates or updates the signed Alebex webhook, and writes the generated caller ID and signing secret to `.env.local`. It does not create the main agent. This command changes your Alebex account; it is a setup action rather than an offline test.

`build-profile-extension.mjs` generates a private pairing token when missing, enables the profile requirement, and copies the extension to `.local/chrome-profile-bridge` with a private `pairing.json`. Install that local folder through Chrome's **Load unpacked**, following [the extension setup instructions](extension/README.md). Keep the official Tim Hortons tab signed in and the connection active. Creating the build folder alone does not install the extension. Avoid a full page reload or navigation after adding items: the observed Tim Hortons cart used in this demo could be cleared by it; use the website's own controls and verify the cart again.

The server binds to `127.0.0.1:4317`. Open your HTTPS demo URL with `#token=<your private DEMO_ACCESS_TOKEN>` once to establish a session. Allow microphone and location during setup; the prepared demo then starts with one **Start Sidekick** press. The delivery contact phone must be collected from the person in that conversation and confirmed with the address and dropoff details. No builder phone, preset order, or maximum-budget question is required. Purchase requires fresh approval of the actual all-in total; an attempt is not confirmed until an actual website receipt is verified.

## Checks and entrypoints

`npm test` runs the offline Node test suite. It does not start a voice conversation, operate Chrome, call a person, or purchase anything. `GET /health` is a read-only local health check; `profileBrowser:true` verifies a connection, not a completed order.

| Entrypoint | Behavior |
| --- | --- |
| `npm start` | Starts `server.mjs`; host laptop, HTTPS tunnel, and active Codex operator must remain running |
| `node scripts/alebex-probe.mjs` | Read-only Alebex catalog probe |
| `node scripts/alebex-probe.mjs --voice` | Creates/reuses main demo agent and starts one synthetic web-voice probe |
| `node scripts/configure-agents.mjs` | Updates account agents/webhook and private local configuration |
| `node scripts/build-profile-extension.mjs` | Builds the private pairing extension; no browser installation or website action |
| `npm test` | Offline regression tests |
| `scripts/bridge-smoke.mjs`, `scripts/event-bridge-smoke.mjs` | Live voice/tool probes; separate from offline tests and require configured providers/tunnel |
| `scripts/phone-bridge-smoke.mjs --go`, `scripts/phone-smoke.mjs` | Optional real outbound-call probes; leave unrun for the disabled trial setup |

Twilio is optional and unnecessary for website ordering. The current trial strips the streaming instruction needed by the Alebex phone agent. Phone credentials and a configured human callback are therefore blank in the template; the disabled flag is explicit. Enabling that extension requires a working carrier/account and an authorized call, not merely filling the fields.
