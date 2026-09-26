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
- Browser validation is two phases: `node scripts/validation/phase1-install.mjs`
  (extension surfaces) and `node scripts/validation/phase2-generic.mjs`
  (detector + injection against six fixture shapes in
  `scripts/validation/fixtures/`). `scripts/validation/probe-container.mjs`
  prints which container/messages the adapter resolves on a fixture — use it
  first when detection misbehaves.
- Every bug the browser harness finds should also get a jsdom test in
  `tests/platforms/detection.test.ts` so it fails in `npm test` too.

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

## Honesty requirement

The user explicitly requires that features not be claimed as working unless
verified. `README.md` carries the status table. CooMeet, Flirtify and the live
call assistant are unit-tested against fixtures but were **never** verified
against a live platform session — do not upgrade those rows without actually
testing them.
