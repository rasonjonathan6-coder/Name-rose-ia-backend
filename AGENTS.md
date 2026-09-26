# AGENTS.md — ROSE IA

Repository-specific knowledge for future sessions. Keep it short and accurate.

## Commands

```bash
npm run verify     # typecheck + test + build (the one command that must pass)
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # dev build -> dist/
npm run build:prod # minified build -> dist/
npm run demo       # build, then serve http://localhost:4173/demo/demo.html
```

## Build layout

`scripts/build.mjs` runs four passes because the targets need incompatible module
formats: content script (IIFE — MV3 content scripts cannot be ES modules),
service worker (ES), the HTML pages (ES + code splitting), and the demo harness.
The demo lives outside `src/`, so it needs its **own pass rooted at `demo/`** —
Vite rejects HTML inputs that sit outside the configured root.

`scripts/manifest.mjs` generates `dist/manifest.json`. Permissions and host
permissions are defined there, not in a checked-in manifest.

## Testing conventions

- Tests run in the `node` environment (`@vitest-environment node`) when real
  `fetch` is involved. **jsdom's `AbortController`/`AbortSignal` are rejected by
  undici** ("Expected signal to be an instance of AbortSignal"), so the E2E
  harness in `tests/e2e/pipeline.test.ts` preserves Node's networking primitives
  (`KEEP_NODE_NATIVE`) and only installs other jsdom globals.
- Globals are installed with `defineProperty` — several (`navigator`, `location`)
  are getter-only accessors on Node's `globalThis`.
- jsdom has no `PointerEvent`; the harness aliases it to `MouseEvent`.
- `LiveCallAssistant.checkAvailability()` bails on a non-secure context. Tests
  must stub `window.isSecureContext = true`.
- `MutationObserver` callbacks are delivered as a microtask. A self-check that
  calls `disconnect()` synchronously after a probe insert will report a false
  negative — await a microtask first.
- **Check content-script presence in the isolated world.** `chrome.runtime` is
  not exposed to the page's main world, so `browser.eval(page, 'typeof chrome')`
  always reports false. Use `browser.evalIsolated` / `waitForIsolated` in
  `scripts/cdp.mjs` for anything touching `chrome.*` or the content script's
  `window.ROSE_IA`.
- Browser validation runs via `npm run verify:browser`, which starts its own
  mock server, runs all phases, and shuts the server down:
  `phase1-install.mjs` (extension surfaces), `phase2-generic.mjs` (detector +
  injection against six fixture shapes in `scripts/validation/fixtures/`),
  `phase3-demo.mjs` (the built extension driving `demo/demo.html` end to end),
  and `check-popup-flow.mjs` (popup activation ordering). `npm run verify:live`
  runs `phase4-live.mjs` against real sites instead of fixtures.
  `scripts/validation/probe-container.mjs` prints which container/messages the
  adapter resolves on a fixture — use it first when detection misbehaves.
  `scripts/validation/probe-live-site.mjs <url>` does the same against a real
  site (read-only, never inserts) when deciding whether an adapter is warranted.
  The runner refuses to start if something already holds port 8788, because a
  leftover server serves the previous build and makes a green run meaningless.
- **The mock provider in `scripts/validation/server.mjs` must mirror the real
  prompt contracts**, not just return plausible JSON. It once routed on the word
  "fact", which also appears in the generation prompt's own rule "Do not invent
  personal facts" — so reply generation was answered with a fact-extraction
  payload and ROSE was blamed for a bug that lived in the harness. Route on the
  distinctive opening line of each system prompt, and match the shapes the
  parsers read: summary and translation are plain text, facts are a JSON array
  of `{key,value,weight}`, suggestions are `{suggestions:[{kind,text}]}`.
- **The request records store `messages`, not a raw `body`.** Asserting against a
  `body` field silently passes a `JSON.stringify(undefined)` and reads as "the
  prompt was empty" when it was fine.
- Every bug the browser harness finds should also get a jsdom test in
  `tests/platforms/detection.test.ts` so it fails in `npm test` too. Verify the
  new test actually fails against the unfixed code — a regression test that
  cannot fail is worse than none.

## Domain invariants

- **API keys never ship.** They are entered at runtime and stored under a
  separate `chrome.storage.local` key (`rose:secrets`) from settings, so a
  settings export cannot leak them. There is a test-time check that `dist/`
  contains no key-like patterns.
- **Default automation mode is `manual`.** `stop` is unconditional in the
  automation state machine — no in-flight event can undo it.
- **The background service worker is the single writer** of settings, memory and
  stats, and the only place that makes outbound network calls. Everything else
  uses the typed RPC contract in `src/shared/rpc.ts`; add new message types to
  both `MSG` in `src/shared/types.ts` and `RpcMap` in `src/shared/rpc.ts`.
- **Memory functions take a `ConversationRef`, not a `ClientMemory`.**
  `getOrCreate(ref)` returns the memory; pass the *ref* to `recordIncoming` /
  `recordOutgoing`.
- **`normalizeSettings` is the repair path for malformed settings.** Anything
  typed as required can still arrive absent from hand-edited, imported or synced
  settings. Repair it there rather than defending at each use site: a provider
  without `label` reached the UI as `Provider "undefined" is disabled.`
- `recordIncoming` / `recordOutgoing` require an explicit `language` argument.
- `AutomationStateMachine.dispatch(event, guards)` takes a full `GuardInput`
  (`contentAllowed`, `rateAllowed`, `cooldownReady`, `policyAllowed`) and
  conversation-scoped events need `conversationId`.

## Runtime host access

The manifest can only declare content scripts for fixed origins. `generic` can
run anywhere, but the user must grant the origin at runtime — see
`src/background/site-access.ts` (extracted so it is testable) and the "Enable
ROSE on <host>" button in the popup.

## Generic detector invariants (`src/platforms/generic/adapter.ts`)

These were each a real mis-detection found by the fixture harness; keep them in
mind before "simplifying" the heuristics:

- **Direction is decided per class token, not per joined class string.** `"msg in"`
  contains `me` and `own` from `OUTGOING_HINTS`, so testing the concatenation
  labelled every client message as ours. Use `INCOMING_TOKEN` / `OUTGOING_TOKEN`.
- **A childless container can still be the message list.** An empty chat log is
  the normal state before the client writes. Skipping empty elements let a
  decorative header chip win the container vote.
- **Message text is `directText`, which must include `<td>`.** Legacy widgets put
  each message in a `<tr><td>`; without table cells the row looks textless.
- **Exclude per-message chrome (`META_HINTS`) and controls (`CONTROL_HINTS`).**
  Timestamps were being sent to the model as part of the client's message.
- **Container resolution is cached, and every `cache.set` must preserve the
  `hinted` flag.** The input cache refresh used to drop it, so after a few
  seconds ROSE forgot its container and reported page chrome as messages.
- **Fall back to unscoped candidates only when the container was not confidently
  identified** — otherwise an empty chat reports the page header as a message.
- **A guessed container and the unscoped fallback both require a composer.** Live
  marketing pages (coomeet.com, flirtify.com) have no chat DOM, but layout-only
  scoring picked the language picker and the FAQ list, and the unscoped fallback
  returned nav items and marketing copy ("Europe", "9+ million users") as the
  client's messages. No reply field means no conversation.
- **Nav/control surfaces are excluded before scoring (`NON_CONTAINER_HINTS`).**
  `ul.language-dropdown__list` satisfies `MESSAGE_CONTAINER_HINTS` via "…list…"
  and is a repeated-child list, so it outscored the real (empty) log.

## Live-site validation (`scripts/validation/phase4-live.mjs`)

Real Chromium, real sites, extension loaded. Two things to know before editing it:

- **Activation RPCs must be sent from an extension page.** Calling
  `rose/site/enable` from the page needs a content script, which is what
  activation is meant to create — the call cannot bootstrap itself. The harness
  opens `options/options.html` and sends from there, exactly like the popup.
- **Chrome's host-permission prompt cannot be automated.** It is a native bubble
  with no DOM and no window; CDP and xdotool both fail to click it. The harness
  seeds the resulting grant into a persistent profile (`seedHostPermission` in
  `helpers.mjs`), which writes what the prompt would have written. Only the grant
  is faked; everything downstream is ROSE's own code.
- A persistent profile must be closed gracefully (`Browser.close` sends SIGTERM)
  or Chrome never flushes `Preferences`. `launch` also clears a stale
  `DevToolsActivePort`, otherwise relaunching on the same profile reads the
  previous run's dead port.

## Real-provider validation (`scripts/validation/phase5-real-ai.mjs`)

Runs the full pipeline against a real keyless provider (Pollinations,
`https://text.pollinations.ai/openai`). Needs the validation server on
`127.0.0.1:8788` (`node scripts/validation/server.mjs`) — it does not start one
itself, so a bare run fails at "demo page loads".

- **Native `confirm()` freezes the renderer.** Enabling AUTO mode asks for
  confirmation. A modal dialog blocks the page, and the next CDP
  `Runtime.evaluate` times out with no useful error. `scripts/cdp.mjs` therefore
  auto-accepts dialogs (`Page.javascriptDialogOpening` →
  `Page.handleJavaScriptDialog`) and exposes `session.setDialogPolicy('dismiss')`
  for tests that need the refusal path.
- **Wait for a *change*, not for a value.** The overlay keeps the previous
  message's suggestions on screen, so "wait until a suggestion exists" returns
  instantly and every later assertion reads stale state. `ask()` fingerprints the
  suggestion list before adding a message and waits for it to differ.
- Restore the real provider before the latency section; the unreachable-provider
  case deliberately leaves a broken config active.
- Raise the CDP timeout for these runs — a real model can take tens of seconds
  (`scripts/cdp.mjs` uses 180s).

## Cross-origin iframe validation (`scripts/validation/phase6-iframe.mjs`)

Reproduces the CooMeet shape: a shell page on `127.0.0.1:8788` with **no chat of
its own** embedding the conversation in a child frame on `127.0.0.1:8789`, so the
frame is genuinely cross-origin. The shell carries a decoy search field, so a fix
that "writes into the first text field of the top frame" is caught rather than
passing by accident.

Four defects this harness surfaced, all now fixed — keep them in mind when
touching the overlay bridge:

- **The command listener must exist before `DETECTION_REPORT`.** Reporting is what
  makes the arbiter elect a renderer, and the election pushes `mount-overlay`
  straight back. Wiring `listenForCommands()` after the report drops that push
  (seen as `could not reach frame <tabId>:0`).
- **The initial conversation identity was never published.** `MessageDetector.start`
  primes existing history *without* emitting it, so nothing told the panel who the
  client was until their next message. `startDetection` now calls
  `onConversationChanged()` after `start`.
- **Suggestions were published while the machine was still busy.** Every action
  button is disabled while `busy`, so the panel showed replies whose Insert/Copy
  were greyed out. Publish after `syncOverlay` clears the busy state.
- **`Insert` was disabled in manual mode.** Manual means ROSE must not insert *by
  itself*; an explicit click is the operator asking. The state machine already
  allowed it.

Two harness rules, both learned the hard way:

- **Wait, don't read once.** The panel mounts before the first mirror snapshot
  arrives, so a single read races the bridge and fails spuriously.
- **Wait for the panel to leave `busy` before clicking an action.** Otherwise the
  click lands on a disabled button and proves nothing.

The mirror is keyed `tabId:frameId` in the background; the renderer only accepts a
snapshot whose `fromFrameId` matches the `mirrorFor` it was told to mirror.

## Phase 7 live recon (CooMeet + Flirtify)

Real Chromium, built extension, public guest access only. What it established:

- **CooMeet's chat needs a session.** `www.coomeet.com` is a marketing shell that
  embeds `iframe.coomeet.com`. With no session the embedded app never boots: the
  frame stays `about:blank`, so there is nothing to resolve. This is a gate, not a
  selector bug — do not "fix" it by adding selectors. The adapter *is* chosen
  correctly (`coomeet`, not `generic`), and the iframe gets a content script
  (`all_frames: true` + `match_about_blank: false`, so about:blank is skipped).
- **Flirtify exposes real chat DOM to a guest on `/streams/<slug>`.** This is why
  Flirtify, unlike CooMeet, could be corrected from live evidence.

Two Flirtify facts worth keeping, both confirmed live and encoded in tests:

- **CSS-modules keep a stable middle token.** Classes are `_messagesWrapper_1407h_104`
  — the trailing hash changes on every deploy but `messagesWrapper` does not.
  Match with `[class*="messagesWrapper"]` (token), never the full class name.
- **The partner name lives in the chat panel**, `<p data-testid="chattingWith">`.
  It is *not* the profile heading, and it is *not* any `[class*="name"]`: a
  "You may also like" sidebar full of other models matches those, which is how the
  adapter returned "Sabnam Yadav" instead of "Night Queen Megha". Conversation URLs
  are `/streams/<slug>`, not only `/profile/<slug>`.

Generic-adapter rule this surfaced: an **empty** message log is a valid state and
must beat list-shaped page chrome. Flirtify's real log is empty until the first
message, so the structural pass finds nothing; the fallback then let the footer
language picker (`ul._list_*`, a repeated-child list) win. `pickContainer` now
prefers a *declared* container (role=log / aria-live / messages-chat class) before
falling back to the score guess.

## Honesty requirement

The user explicitly requires that features not be claimed as working unless
verified. `README.md` carries the status table. CooMeet and the live call
assistant are unit-tested against fixtures and were probed live in Phase 7, but
never driven in an authenticated session — do not upgrade those rows without
actually testing them. Flirtify is verified live for detection, overlay, client
name and message container; its insert/send path could not be (sign-in gate).

Live validation did verify the generic path end to end on `web.libera.chat`
(runtime activation → injection → overlay → composer detection → text insertion
read back). CooMeet could not be verified because its chat requires an
authenticated session; its public shell embeds `iframe.coomeet.com`, which never
leaves `about:blank`, so ROSE correctly reports "no conversation" there. Flirtify
was partially verified: a guest sees the real chat DOM on `/streams/<slug>`, which
is what the Phase 7 corrections above are based on.

What *is* verified for the CooMeet shape is the structural problem it presents —
a chatless shell embedding a cross-origin chat frame — via Phase 6. That covers
the overlay bridge and cross-frame insertion, not CooMeet's own selectors.
