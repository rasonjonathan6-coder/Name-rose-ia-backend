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
| Generic detector / heuristics | yes | yes (60 detection tests + 6-shape browser harness) | yes on the local demo harness |
| Chat / message detection | yes | yes (E2E + adapter tests + 6-shape browser harness) | yes on the local demo harness |
| Reply-field detection + text insertion | yes | yes (E2E insertion tests) | yes on the local demo harness |
| AI generation (OpenAI-compatible / OpenRouter) | yes | yes (37 generation + 18 client tests) | against a real HTTP server in tests; not billed against a live provider in CI |
| Client memory + isolation | yes | yes (22 memory + 27 E2E tests) | yes |
| Translation / language detection | yes | yes (17 language tests) | yes |
| Anti-repetition quality guard | yes | yes (27 tests) | yes |
| Manual mode | yes | yes | yes |
| Assisted mode | yes | yes | yes |
| Auto mode | yes | yes | yes, but see the safety notes |
| CooMeet adapter | yes | yes (adapter unit tests) | **not verified** — no live account used |
| Flirtify adapter | yes | yes (adapter unit tests) | **not verified** — no live account used |
| Live call assistant (speech) | yes | yes (16 tests) | **not verified** — needs Chrome + a live call |

The CooMeet, Flirtify and live-assistant rows are deliberately not claimed as
working in production. Their adapters are unit-tested against representative DOM
fixtures, but no live platform session was used to confirm them. Revenue
figures are **not** displayed anywhere, because ROSE does not invent data.

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
| `npm run verify:browser` | Starts its own mock server and drives all three phases (install, generic detection, demo) in headless Chrome. Needs `npm run build` first |
| `npm run demo` | Build and serve the local demo |
