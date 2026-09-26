# ROSE IA

A Manifest V3 browser extension (Chrome / Edge) that assists an operator during
online chat and webcam conversations: it detects incoming messages on the page,
understands them, keeps a per-client memory, and proposes replies in the
operator's chosen style and language.

ROSE assists a human operator. It does not bypass platform rules, does not
bypass browser or platform protections, and never captures passwords.

---

## What is verified vs. what is not

This is the honest status. "Tested" means an automated test exercises the real
code path; "Works in production" means it was observed working against the real
platform in a browser.

| Feature | Implemented | Tested | Works in production |
| --- | --- | --- | --- |
| Generic detector / heuristics | yes | yes (63 detection tests + 6-shape browser harness + live-site harness) | yes — resolves a real composer on web.libera.chat; correctly reports "no conversation" on chat-less pages |
| Cross-origin iframe chat (CooMeet shape) | yes | yes (16 arbiter + 23 frame-role tests + Phase 6 browser harness) | yes on the harness — the shell's panel mirrors the chat frame's name, incoming message and suggestions, and inserts into the frame's composer |
| Chat / message detection | yes | yes (E2E + adapter tests + 6-shape browser harness) | yes on the local demo harness; live guest pages exposed no *messages* (CooMeet's chat never loads, Flirtify's log was empty — see Phase 7) |
| Reply-field detection + text insertion | yes | yes (E2E insertion tests) | yes — text written into web.libera.chat's real composer and read back |
| Runtime site activation (host grant + dynamic script) | yes | yes (popup-flow check) | yes — registers and injects on an arbitrary live origin |
| AI generation (OpenAI-compatible / OpenRouter) | yes | yes (43 generation + 21 client tests) | yes — validated against a real keyless provider (Pollinations `gpt-oss-20b`), see Phase 5 |
| Client memory + isolation | yes | yes (22 memory + 27 E2E tests) | yes — facts and summaries persisted and read back against a real model |
| Translation / language detection | yes | yes (17 language tests + real-model fr→en / en→fr) | yes |
| Anti-repetition quality guard | yes | yes (27 tests) | yes |
| Manual mode | yes | yes | yes |
| Assisted mode | yes | yes | yes |
| Auto mode | yes | yes | yes, but see the safety notes |
| CooMeet adapter | yes | yes (adapter unit tests + live Phase 7 recon) | **not verified** — the chat only mounts behind the sign-in/consent gate; probed live and it stays `about:blank` |
| Flirtify adapter | yes | yes (adapter unit tests + Phase 7 live recon) | **partially** — detection, overlay, client name and message container verified live; send/insert not verifiable (composer requires sign-in) |
| Live call assistant (speech) | yes | yes (16 tests) | **not verified** — needs Chrome + a live call |

The CooMeet and live-assistant rows are deliberately not claimed as working in
production. Their adapters are unit-tested against representative DOM fixtures,
and Phase 7 probed both sites live, but no authenticated session was available:
CooMeet's chat iframe never leaves `about:blank` and Flirtify's composer is
gated behind sign-in. Revenue figures are **not** displayed anywhere, because
ROSE does not invent data.

Flirtify is the one platform where live probing produced verified corrections,
because its public stream pages expose the real chat DOM to a guest:

- detection picks `flirtify` (not `generic`), and the overlay mounts once;
- the partner name now resolves from the chat panel's `data-testid="chattingWith"`
  — it previously returned an unrelated sidebar model ("Sabnam Yadav" instead of
  "Night Queen Megha");
- `/streams/<slug>` is recognised as a conversation URL (only `/profile/<slug>`
  was);
- the message container now resolves to the real log `div._messagesWrapper_*`
  instead of a list-shaped language picker.

See "Phase 7 live recon" below for the exact evidence and what remains unproven.

### Phase 8 live re-validation

Phase 8 re-probed both platforms on the current build. **No authenticated Chromium
profile exists in this environment** — the only two cookie stores present are
empty (0 hosts each), so CooMeet's and Flirtify's chat remain behind sign-in and
could not be driven end to end. No session was simulated.

Guest probing did surface and fix two real regressions on Flirtify, both verified
live afterwards:

- **A SvelteKit route announcer was read as a chat.** `/shorts` (a swipe feed
  reached by redirect when a stream is not live) renders
  `<div id="svelte-announcer" aria-live="assertive">`. The Phase 7 rule that
  trusted `aria-live` therefore returned it as the message log, and because it
  always exists ROSE reported a conversation on a chat-less page — with the
  client identified as "shorts". Announcers/visually-hidden live regions are now
  excluded, and `aria-live` alone is only accepted when the element also names
  itself as a log (or is an explicit `role="log"`). Live: `/shorts` now reports
  `conversation: null`.
- **`feed`/`stream` were standalone container hints.** Flirtify's feed wrapper is
  `<div class="feed">`; those words describe content/video feeds far more often
  than a message log, so they were dropped as standalone hints. `chat-…-feed` and
  `chat-…-stream` still match.

`/streams/<slug>` continues to resolve correctly (`Night Queen Megha`,
`flirtify-megha_83`, `div._messagesWrapper_*`), confirming Phase 7 was not
regressed.

### Phase 7 live recon (no authenticated session available)

Both sites were probed in a real Chromium with the built extension loaded, using
only public guest access — no credentials were requested, logged or stored.

| Observation | CooMeet | Flirtify |
| --- | --- | --- |
| Reachable | yes | yes |
| Adapter chosen | `coomeet` (correct, not `generic`) | `flirtify` (correct, not `generic`) |
| Overlay mounted | no — nothing to render yet | yes, exactly one |
| Chat accessible to a guest | no | yes, on `/streams/<slug>` |
| Client name | n/a | **yes** — "Night Queen Megha" |
| Message container | n/a | **yes** — `div._messagesWrapper_*` |
| Reply composer | no | no — gated behind "Sign up" |
| Insert / Send | not testable | not testable |

CooMeet serves a marketing shell on `www.coomeet.com` that embeds
`iframe.coomeet.com`. With no session the embedded app never loads: the frame
stays `about:blank` and offers no textareas, no contenteditable and no composer.
That is a **gate**, not a selector problem — the iframe's own document is empty,
so there is nothing for any adapter to resolve.

**Why CooMeet/Flirtify chat and the live-call assistant are still not claimed as
verified:** they need an authenticated session (and for the assistant, a live
call). If you can supply an authenticated browser profile, the remaining checks —
message detection, Generate, Insert, Send, conversation switch, SPA reload — can
be run against the real platforms.

### Real-provider validation (Phase 5)

`node scripts/validation/phase5-real-ai.mjs` (needs the validation server on
`127.0.0.1:8788`) drives the whole pipeline against a **real** AI provider over
real HTTP — a keyless Pollinations endpoint (`https://text.pollinations.ai/openai`,
model `gpt-oss-20b`). Nothing is mocked: the extension makes the network calls
and the harness reads back what the model produced.

31/31 checks pass, covering: three parsed suggestions for a fresh message; a
French message producing a non-echo reply; follow-up context; a stated fact
extracted and persisted (`name=Sofia`); a conversation summary rolled forward by
the model; per-client memory isolation; fr→en and en→fr translation; assisted
mode filling the composer without sending; auto mode sending exactly one reply
and STOP halting further sends immediately; a bad model and an unreachable
provider both surfacing a clear error and injecting nothing; real token
accounting; and measured latency.

Phase 5 also covers the failure paths that used to hide bugs: an empty
translation request is now rejected before any call is made, and enabling AUTO
answers the native confirmation dialog (the harness auto-accepts dialogs, since
a blocking `confirm()` otherwise freezes the renderer and times out CDP).

### Live-site validation (Phase 4)

`npm run verify:live` runs ROSE against real sites in a real Chromium with the
extension loaded. It reports what it observes rather than assuming success.

What it can prove, and did:

- ROSE's runtime activation path works end to end on an arbitrary origin
  (`web.libera.chat`): the host grant is honoured, a dynamic content script is
  registered, the script is injected, the overlay mounts, the generic adapter
  finds the site's real composer, and text is inserted into it and read back.
- On pages with no chat UI (`coomeet.com`, `flirtify.com` marketing pages) ROSE
  reports no conversation instead of mistaking nav items and marketing copy for
  the client's messages.

What it cannot prove:

- Chrome's host-permission prompt is a native bubble with no DOM and no window,
  so it cannot be clicked by CDP or xdotool. The harness seeds the resulting
  grant into a persistent test profile, which is exactly what the prompt writes.
  Everything downstream of the grant is ROSE's own code and runs untouched.
- CooMeet and Flirtify chat require an authenticated video session. Their public
  pages are marketing pages with no chat DOM, so the CooMeet/Flirtify adapters
  remain **not verified** against a live session.

---

## Architecture

```
src/
├── background/          service worker — the only writer of settings/memory/stats,
│                        the only place that makes outbound network calls
├── content/             content script: detection loop + overlay controller
├── core/
│   ├── ai/              provider client, model router, prompts, response cache
│   ├── automation/      automation state machine
│   ├── conversation/    conversation engine, live call assistant
│   ├── logging/         developer logger with a debug switch
│   ├── memory/          per-client memory store (summaries, facts, compression)
│   ├── safety/          policy, rate limiting, cooldown, quality guard
│   ├── stats/           statistics recorder
│   └── translation/     language detection and translation helpers
├── platforms/
│   ├── generic/         heuristic adapter + DemoAdapter + site-config overrides
│   ├── coomeet/         CooMeet adapter
│   └── flirtify/        Flirtify adapter
├── popup/ options/ sidepanel/ dashboard/    UI surfaces
├── ui/                  design system: styles, overlay, DOM helpers
├── shared/              types, settings defaults, RPC contract, utilities
└── storage/             chrome.storage wrapper with an in-memory fallback
```

Data flow:

```
new message → MessageDetector (MutationObserver)
            → PlatformAdapter.getConversation / getMessages
            → background (memory + policy + generation)
            → quality guard
            → overlay (3 suggestions) → insertion → manual/assisted/auto send
```

The background service worker is the single writer of persisted state. Content
scripts and UI pages talk to it exclusively through typed RPC (`src/shared/rpc.ts`).

---

## Requirements

- Node.js >= 20
- Chrome 110+ or Edge 110+ (Manifest V3, service worker modules)
- An API key for a chat-completions provider (OpenRouter, OpenAI, Groq, Gemini,
  or any OpenAI-compatible endpoint). No key ships with the extension.

---

## Install, build, test

```bash
npm install          # install dependencies
npm run typecheck    # TypeScript, no emit
npm test             # full Vitest suite (328 tests)
npm run build        # development build -> dist/
npm run build:prod   # minified production build -> dist/
npm run verify       # typecheck + tests + build, in one shot
```

---

## Load the extension

1. Run `npm run build`.
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `dist/` folder.
5. Open the local demo page (below) or a supported platform.

### Try the local demo

```bash
npm run demo     # builds, then serves http://localhost:4173/demo/demo.html
```

The demo page mirrors the DOM shape ROSE looks for, with buttons to simulate an
incoming message, a greeting, a question, a personal detail, a French message, a
repeat, and an idle conversation. Its **Run self-checks** button verifies that
the page itself is well-formed for ROSE.

The demo's last self-check ("ROSE overlay detected") only passes once the
unpacked extension is loaded and the page is reloaded — that is expected.

---

## Enable ROSE on an arbitrary site

The manifest declares content scripts for CooMeet, Flirtify and localhost. The
`generic` adapter can run anywhere, but browsers require a permission grant per
origin, so:

1. Open the site.
2. Open the ROSE popup.
3. Click **Enable ROSE on \<host\>**.
4. Accept the browser permission prompt. ROSE registers a persistent content
   script for that origin and injects into the tab.

This is the intended path for adding a new platform without shipping a new
manifest. A purpose-built adapter (see below) still gives better detection.

---

## Configuration

Open the popup → ⚙, or the extension's Options page.

- **AI** — provider, base URL, model, fast model, API key, temperature, max
  response length. **API keys are entered by you at runtime and stored in
  `chrome.storage.local` separately from settings**, so exporting settings never
  leaks credentials. No key is bundled in the source.
- **Conversation** — response delay, language, style (Natural, Friendly, Warm,
  Flirty, Playful, Direct, Custom) and length (Short, Medium, Long).
- **Automation** — mode (Manual / Assisted / Auto), global pause, per-platform
  and per-conversation pause.
- **Memory** — enable/disable, retention, clear one conversation, clear all.
- **Appearance** — theme, floating-window size, position, opacity.

### Modes

- **Manual** — ROSE only generates and shows suggestions.
- **Assisted** — ROSE generates and can insert into the field; you confirm the send.
- **Auto** — ROSE can insert *and* send, after the configured delay, only when
  you have explicitly switched to this mode.

The default mode is `manual`. **STOP** is always available in the popup and the
overlay, and always takes back control. It is unconditional in the state machine:
no in-flight event can undo it.

---

## Adding a platform adapter

Create `src/platforms/<name>/adapter.ts` implementing the `PlatformAdapter`
interface from `src/platforms/types.ts`:

- `matches(url)` — which hosts this adapter owns
- `getConversation(document)` — identity (clientId, conversationId, displayName)
- `getMessages(document)` — visible messages, with direction
- `findComposer(document)` / `insertText(el, text)` / `send(el)`

Then register it in the platform detector. Prefer selector *hints* over hard-coded
selectors; `src/platforms/generic/config.ts` holds per-site overrides for when
the generic heuristics are not enough.

---

## Security notes

- Manifest V3, minimal permissions. Host permissions for providers are listed
  explicitly; any other origin is requested at runtime by user action.
- No password capture, no credential scraping, no unrelated data collection.
- Data is separated per client; memory is local to the browser profile.
- No secret API key is exposed in the source or in the built bundle.
- `connect-src *` is required because the user configures an arbitrary
  OpenAI-compatible base URL. Narrow it in `scripts/manifest.mjs` if you only
  use known providers.

---

## Project scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Development build to `dist/` |
| `npm run build:prod` | Minified production build to `dist/` |
| `npm test` | Full test suite |
| `npm run typecheck` | TypeScript check |
| `npm run verify` | typecheck + test + build |
| `npm run verify:browser` | Starts its own mock server and drives every browser phase (install, generic detection, demo, cross-origin iframe, popup flow) in headless Chrome. Needs `npm run build` first |
| `npm run demo` | Build and serve the local demo |
