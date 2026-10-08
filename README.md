# Sidekick

**Your voice, connected to the world.** A hackathon prototype for blind and low-vision people in Vancouver: start a conversation, share a camera view, find nearby places, and ask for help with a website errand.

Alebex powers the live voice conversation and tool calls. Gemini through OpenRouter reads shared images. OpenAI Responses and Decisions provide browser decisions. With `BROWSER_ORDER_PREPARE_EXECUTOR=openai`, a new website request immediately starts bounded cart preparation in the connected Chrome profile. **Codex remains required for private checkout fields and final submission.** The automatic preparation path never pays.

## What has worked

Live Alebex speech, fresh device location, nearby Tim Hortons discovery, a request for one fifty-pack, and spoken delivery-contact collection and confirmation were observed. Codex visibly prepared **one 50 Assorted Timbits pack** for delivery to **570 Dunsmuir Street, Vancouver, BC V6B 1Y1**, with **Alexander College, AIC Founders Lab** dropoff instructions. The reviewed total was **CAD $15.98 with $0.00 tip**. The user chose not to purchase.

Later, after direct typed authorization, Codex clicked the final payment button once and verified the actual Tim Hortons delivery receipt for one fifty-pack at CAD $15.98 with zero tip. The user reported fulfilment from 108 West Pender instead of the suggested 607 Dunsmuir; the tracking map was consistent with that report. This was a supervised purchase with incorrect branch verification; a full voice-triggered purchase remains unverified.

The corrected flow binds the chosen nearby place ID to its stored address, resolves that exact branch's published ordering link, and checks the actual restaurant separately from the delivery destination before adding items or approving payment. Selecting 607 Dunsmuir's own Order control was verified live to set pickup to **607 Dunsmuir St.** Delivery from that branch remains unverified because the observed delivery page does not identify its fulfilling restaurant; an unknown or different source blocks ordering. The automatic OpenAI preparation path passed mocked regression tests, but a fresh complete live voice run through that path has not been verified. The latest local suite passed **55 tests**. This prototype has not been validated with blind users and does not provide street-crossing clearance.

## Run locally

Requires Node.js 22 or newer, Google Chrome, provider credentials, and an active Codex operator with computer-use access to the intended Chrome profile.

```sh
npm ci
cp .env.example .env.local
```

Fill the placeholders in `.env.local` with your own credentials and a private demo access token. Keep this file local. The example documents the Alebex, Gemini/OpenRouter, OpenAI browser-provider, and operator settings. Use `BROWSER_ORDER_PROVIDER=openai`, `BROWSER_ORDER_PREPARE_EXECUTOR=openai`, and `BROWSER_ORDER_OPERATOR=true` for automatic preparation with supervised checkout.

```sh
node scripts/configure-agents.mjs
node scripts/build-profile-extension.mjs
npm start
```

Set an existing main Alebex agent ID first; the configuration script updates it and creates or reuses the optional caller and webhook. See [SETUP.md](SETUP.md) for bootstrap instructions. The extension builder creates an ignored private build at `.local/chrome-profile-bridge` with its local pairing code. Load that folder as an unpacked extension in the intended Chrome profile and keep the official Tim Hortons tab signed in. See [extension setup](extension/README.md) for the limited site permissions and one-time pairing setup.

Open `http://127.0.0.1:4317/#token=YOUR_DEMO_ACCESS_TOKEN`, using your own configured token. Allow microphone and location during one-time browser setup. For the demonstration, press **Start Sidekick** and speak naturally. Camera permission is requested when you ask it to look. Keep the server, Chrome connection, and actively running Codex operator available throughout website tasks. Remote demonstrations additionally require an HTTPS endpoint configured with `PUBLIC_BASE_URL`.

```sh
npm test
```

## Voice workflow

- Ask for nearby coffee, a listed public washroom, or drinking water. Locations use City of Vancouver data and OpenStreetMap with source labels. Distances are approximate straight-line distances; live availability and walking access require separate verification.
- Ask Sidekick to read useful text or describe a shared camera image. Photo uploads and demonstration images retain their source labels.
- Choose the nearby branch offered aloud, then give exact items, quantities, sizes, and changes. Sidekick carries that place ID and address into website ordering; it does not ask for the branch again. A new branch address is used only when explicitly supplied. A spending limit is used only if volunteered.
- For delivery, supply and freshly confirm the address, dropoff instructions, and delivery contact phone in the conversation. The operator uses those confirmed details on the real website.
- A purchase requires the actual fulfilling merchant branch, cart, and all-in total to be checked, read aloud, and approved in a new spoken turn. An unknown or different delivery branch blocks approval. Passwords and payment setup stay private in the website. A website receipt is required before reporting an order as completed.

## Submission

The initial version was submitted on **October 7, 2026 at 3:35 p.m. Vancouver time** as **Sidekick — Your voice, connected to the world**, team **Sidekick · Solo**. The current version and GitHub link were saved at **4:19:58 p.m.**; the portal confirmed it is submitted and visible to the participant, judges, and admin. [Alebex project](https://community.alebex.ai/#project/1a3db80c-cd91-4199-989b-8c8d0bad46bd). [SUBMISSION-DRAFT.md](SUBMISSION-DRAFT.md) records the project copy and verification limits.

Repository: [Reza2kn/sidekick-alebex](https://github.com/Reza2kn/sidekick-alebex)

Private configuration, pairing builds, phone numbers, account data, payment screenshots, and raw research logs are excluded from the public repository.
