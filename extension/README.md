# Sidekick Tim Hortons profile bridge

This unpacked Manifest V3 extension uses the Tim Hortons tab already signed in inside the Chrome profile where it is installed. Source files contain no pairing secrets. Installation and the Chrome permission prompt remain a user action.

## One-time setup

1. Review `manifest.json`: the only site permissions are `https://www.timhortons.ca/*`, `https://timhortons.ca/*`, and the local bridge `http://127.0.0.1:4317/*`. It requests `storage` for its own pairing setting and `scripting` to connect an existing Tim Hortons tab.
2. Start the local Sidekick server. Open `chrome://extensions` in the desired signed-in Chrome profile, enable Developer mode, and use **Load unpacked** to choose this folder (or the generated private build folder).
3. A private build may contain a local-only `pairing.json` with `{ "pairToken": "..." }`. In that case it connects automatically. Otherwise open the extension popup and enter the code supplied by Sidekick setup once.
4. Leave the signed-in Tim Hortons tab open. The worker reuses an existing permitted tab, choosing the active or most recently used one. If none exists, it opens the official Tim Hortons home page in this profile.

Use **Disconnect** in the popup to stop and clear pairing. A disconnect also disables bundled automatic pairing until a code is entered again. Remove the extension to remove its stored setting entirely. This extension is not installed by creating these files.

## Fixed local protocol

Connects only to `ws://127.0.0.1:4317/profile-browser`, using one WebSocket subprotocol `sidekick.profile.<pairToken>`. The pair token never appears in a URL or page content. It sends `{ "type": "profile_ready", "protocol_version": 1 }` and a `ping` every 20 seconds while paired. Chrome 116 or newer is required for the active WebSocket service-worker lifetime behavior.

Request: `{ "id": 1, "type": "rpc", "method": "snapshot", "params": { "step": 1 } }`.

Reply: `{ "id": 1, "type": "rpc_result", "ok": true, "result": { ... } }`, or `ok:false` with `error:{code,message}`.

Methods:

- `snapshot`: returns `revision`, `url` without query/fragment, `captured_at`, `title`, `visibleText` (at most 12,000 characters), `controls` (at most 140), and `pickupAreas`. Controls match the existing browser-worker structure, including numbered ids, labels, context, branch context, tags, input types, checked/disabled states, and select options. No screenshot permission is requested.
- `navigate`: `{ "url": "https://www.timhortons.ca/..." }`, official Canadian Tim Hortons hosts over HTTPS only.
- `action`: `{ "revision": "...", "action": "click|fill|scroll|wait", "target_id": 1, "value": "...", "direction": "down", "submit": false }`. Each action consumes a fresh revision, which expires after 30 seconds. A trusted final click additionally requires `submit:true` and numeric `approvedTotal`. The displayed unique all-in Total must match that amount to the cent. No supplied selectors, arbitrary JavaScript, page evaluation, cookies, storage export, or debugger access exists.

Sensitive input values are never read. Password/email/phone/card/verification fields cannot be filled or clicked; recognizable email addresses, phone numbers, card numbers, and account greetings are scrubbed from page text. Sign-in is always private human control. This is DOM-only operation on the top Tim Hortons frame; embedded external checkout or authentication frames are outside scope.

The extension blocks final purchase controls unless a **trusted local server** explicitly sends `submit:true` and `approvedTotal` for a freshly observed final order button. The server must independently verify the precise cart, approved total, budget, selected Tim Card balance, and a new voice approval before sending that flag. The planner must never pass through a model-supplied submit flag. A persisted latch permits at most one final attempt per pairing, including after a tab reload or uncertain reply. New purchases require a new explicitly set-up pairing after checking the prior result. An action result is an attempted click, not proof that an order was placed; only the website receipt can confirm an order.

Chrome references: [permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions), [content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [service-worker WebSocket lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
