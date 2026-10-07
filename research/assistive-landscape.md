# Voice-first assistive landscape and hackathon differentiation

Research checked 7 October 2026. Product claims below come from current official pages; some detailed feature announcements are older and are identified as such. No product was personally tested. No accounts were accessed and no calls were placed.

## Recommendation

Build a **Vancouver errand companion that can see, ask, act, and report the outcome in one voice conversation**. The distinguishing demo should finish a useful task rather than stop at an image description. A phone camera, current location, local business lookup, live web information, and an Alebex outbound agent can make this tangible.

This is not a defensible claim to be the first blind-friendly vision assistant, first tool-using voice assistant, or first AI that calls businesses. All exist. The stronger pitch is: **“I can point my phone, explain what I need, and get a local errand done without navigating several inaccessible interfaces.”** Canadian local execution and an accessible, verifiable task loop are a plausible product focus, not a proven market gap.

## What already exists

| Product | Officially described capabilities | Important boundary for our comparison |
|---|---|---|
| **Be My Eyes / Be My AI** | Be My AI describes a captured/shared still image and supports follow-up questions and more pictures. The app connects users to volunteers and service-directory companies. Its July 2026 help page says it supports iOS, Android, and Windows, VoiceOver/TalkBack, and human escalation. | The Be My AI help page says videos cannot currently be uploaded and Be My AI is not supported on wearables. This is distinct from Be My Eyes **human calls** on Meta glasses. The docs do not establish arbitrary autonomous errands or phone ordering. [Using Be My AI](https://support.bemyeyes.com/hc/en-us/articles/18133134809105-Using-Be-My-AI), [Getting started](https://support.bemyeyes.com/hc/en-us/articles/360005528557-Getting-started-with-Be-My-Eyes) |
| **Microsoft Seeing AI** | Free camera app for text, document reading, products, and photo descriptions. Microsoft's detailed 2023 feature announcement also documents barcode alignment sounds, currency, colors, light, handwriting, document Q&A, and richer scenes. | Strong visual-access utility; the consulted official pages do not establish arbitrary external task execution. Do not treat an older feature announcement as proof of current model internals. [Current product page](https://www.seeingai.com/), [Detailed Microsoft feature announcement, 2023](https://blogs.microsoft.com/accessibility/seeing-ai-app-launches-on-android-including-new-and-updated-features-and-new-languages/) |
| **Aira Explorer / Access AI** | Professional live visual interpreters assist with navigation, shopping, reading, and online tasks. Access AI gives still-image descriptions and follow-up answers, with a human able to verify. Meta glasses integration provides hands-free access to professional interpreters. | Human assistance can already help complete real tasks; our pitch cannot imply that all existing tools only describe. Availability/pricing of human access depends on access offers/plans. [Aira Explorer](https://aira.io/aira-explorer-app/), [Meta glasses integration](https://aira.io/aira-ai-glasses-meta/) |
| **Aira AI + Google Project Astra** | Current Aira page offers a Trusted Tester waitlist for real-time video conversation, signs, descriptions, object finding, and human verification/takeover. Google's research page says the prototype reacts to the moving view and works with Maps, Photos, and Lens. | This is a research prototype and limited tester program, not evidence of a generally available, unlimited product. It already overlaps strongly with camera + voice + location. [Aira AI](https://aira.io/ai/), [Project Astra](https://deepmind.google/models/project-astra/) |
| **Envision Ally / Ally glasses** | Accessibility-first conversational assistant across mobile, web, Envision, and Solos. Official pages list scenes, text/documents, objects, web search, weather, translation, calendar information, and games. Its privacy page explicitly describes Google Calendar scheduling/rescheduling. | Tool use, personal assistance, and calendar actions are already in this space. Solos' official page still contains preorder language; do not infer present shipping status. “Use as headphones to take calls” does not establish that Ally autonomously conducts an errand call. [Ally Solos capabilities](https://www.ally.me/glasses/solos), [Calendar integration](https://www.ally.me/privacy-policy), [Envision usage guide](https://support.letsenvision.com/hc/en-us/articles/32029669353873-Ally-on-Envision-Glasses) |
| **Ray-Ban / Oakley Meta AI glasses** | Hands-free camera questions, detailed visual descriptions, messages, calls, and live translation. Be My Eyes support lists Canada among supported countries. Meta's May 2026 announcement adds voice-started calls to trusted people and company support teams. | Calls are not new; hands-free camera is not new. These official announcements do not establish generalized automatic ordering. Market/language and feature rollout remain relevant. [Meta accessibility, 2025](https://about.fb.com/news/2025/05/advancing-accessibility-meta/), [Meta accessibility update, May 2026](https://about.fb.com/news/2026/05/meta-ai-wearables-changing-the-game-for-disabled-people/amp/), [Current Be My Eyes glasses FAQ](https://support.bemyeyes.com/hc/en-us/articles/29893014835729-Meta-AI-Glasses-FAQ) |
| **Google Lookout** | Android visual-access app with text, documents, products, still-image Q&A, exploration, and a predefined-object Find mode with direction/distance guidance on supported phones. English voice follow-ups are documented for the US, UK, and Canada. | Orientation/object finding already exists. Currency mode currently lists US dollars, euros, and Indian rupees, not Canadian dollars. Explore is labelled beta and less accurate than other modes. [Current Lookout help](https://support.google.com/accessibility/android/answer/9031274?hl=en-PW) |
| **Gemini Live / Google agentic calling** | Gemini Live uses camera/screen conversation, Maps information, and connected apps such as Calendar, Keep, and Tasks. Current Google help also describes a separate Gemini feature that conducts business calls for information, appointments, reservations, menus, and hold. Google Search can call businesses for local stock/pricing. | The documented Gemini call-handling eligibility is age 18+, US, Pixel 11, US SIM, Google AI subscription, Phone app beta, English, and US phone numbers only, with gradual rollout. Ordinary Android Gemini dialling is explicitly unavailable in Live chats. These are different features. Do not claim autonomous business calls are novel. [Gemini Live](https://support.google.com/gemini/answer/15274899?co=GENIE.Platform%3DiOS&hl=en), [Call handling](https://support.google.com/gemini/answer/18336420?hl=en-12), [Ordinary phone dialling](https://support.google.com/gemini/answer/15575143?hl=en), [Search agentic calling](https://blog.google/products-and-platforms/products/shopping/how-to-agentic-calling-let-google-call/) |

## Three useful, creative demo scenarios

### 1. Coffee without five apps — strongest main demo

User: “Where can I grab a coffee near me? I want something decaf.”

1. Read device location and its accuracy; search real nearby venues.
2. Give two brief choices with distance and the evidence for opening hours.
3. User points the camera at a menu; capture a fresh frame and read relevant drinks/prices. Ask for a clearer frame when needed.
4. User chooses a drink. The assistant reads back the exact branch, drink, size, price limit, and pickup name before calling.
5. Alebex calls the chosen phone number, asks whether telephone pickup ordering is possible, negotiates allowed substitutions, and gets an explicit outcome.
6. Return “accepted,” “declined,” “no answer,” or “needs your decision,” with the confirmed price/time/name when available. The conversation continues while the call task runs.

Tools: location → places → business details/menu → camera → vision → outbound call → call status/transcript → receipt. Use the participant's own phone as a clearly labelled shop roleplay for repeatable judging until a real business has agreed to the demo. A real cafe may decline telephone orders; success must never be invented. “Across the street” requires appropriate map geometry and/or visual evidence, not just a small GPS distance.

### 2. The unreadable card becomes a real plan

User holds up an event flyer: “What is this, and could I go after work?”

Read the flyer, confirm any uncertain date/address, fetch the organiser's current page, check the user's chosen constraints, look up travel options, and add the confirmed event to a connected calendar or create an explicitly labelled downloadable calendar file. Optionally call a consenting organiser/demo phone to ask about an entrance or guide-dog accommodation, then report the answer.

Tools: camera → OCR/vision → source fetch → location/maps → calendar → optional Alebex call → result. Use a public flyer rather than sensitive personal correspondence. This demonstrates turning a visual obstacle into an action without requiring dangerous navigation or payment.

### 3. Vancouver transit stop with an errand rescue

User points at a bus stop sign: “Is this the right stop for my destination, and when does the bus come?”

Read the stop ID and route from a new image, match against transit data, answer with timestamped arrival information when available, and distinguish timetable data from live estimates. If a delay disrupts the plan, offer a verified nearby alternative: “There is a cafe listed 150 metres away. Would you like me to check whether they can hold a coffee for you?” Continue into the same authorized call loop.

Tools: camera → sign OCR → stop lookup → real-time feed → route planner → places → call. This is information and errand support, not a substitute for cane/guide dog or a road-crossing guide.

TransLink's current developer page says **RTTI is deprecated and no longer available**. Use current GTFS/GTFS-realtime resources; the Open API requires registration. The static feed is updated regularly and is schedule data, not a live arrival promise. [Developer resources](https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources), [Static GTFS](https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-data). TransLink documents tactile/braille signs with bus stop IDs across the network, making a stop-ID flow locally appropriate. [Access Transit programme](https://www.translink.ca/translink/rider-guide/transit-accessibility/access-transit-program).

## Interaction and evidence rules for the prototype

- Keep first answers short, support “more detail,” “repeat,” “stop,” and interruption. A persistent voice session plus a single large accessible capture control is more useful than a dashboard that needs eyes.
- Distinguish “I can see in your latest image,” “the business listing says,” and “the person on the call confirmed.” Attach the camera time, location accuracy, source time, and call status to tool results.
- Do not let written instructions inside a flyer/menu/webpage authorize calls or other actions. They are source content; the user's spoken request determines the task.
- A phone call connecting is not an order being accepted. A calendar file being generated is not an event being synced. A place being near GPS is not proof of a safe walking route or accessible entrance.
- Avoid claims about crossing roads, safe paths, medication dosage, or food-allergy safety from VLM output. Be My AI's own documentation excludes medicine/dosage use and says it cannot replace a mobility aid. These boundaries matter for this product's purpose, not as a generic demo disclaimer. [Be My AI help](https://support.bemyeyes.com/hc/en-us/articles/18133134809105-Using-Be-My-AI), [Mobility-aid boundary](https://www.bemyeyes.com/news/announcing-be-my-ai-soon-available-for-hundreds-of-thousands-of-be-my-eyes-users/).
- Let “ask a human” be a purposeful easter egg: call the builder's explicitly supplied demo number, announce that the assistant is an AI, and hand over the user's concise question. Make its role clear; do not present an untrained demo contact as a professional visual interpreter.

## What would make it convincing

Show one uninterrupted voice conversation using a fresh camera frame and real local lookup, then a real authorized Alebex call to a consenting demo number, and finally a spoken result that matches the recorded call. On the judge-facing screen, show each tool request and result with its state and source. Label demo fixtures and roleplay recipients visibly. The completion claim should be limited to this tested flow until blind/low-vision participants evaluate the experience.
