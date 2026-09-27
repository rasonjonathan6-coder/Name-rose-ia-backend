# ROSE backend

A small, dependency-free proxy that sits between the extension and one or more
model providers:

```
ROSE extension  →  ROSE backend (HTTPS)  →  provider (OpenRouter, Groq, …)
```

The point is that the **extension never holds the provider credential**. The key
lives only in the backend's environment; the extension sends none.

It is multi-provider. A registry declares each supported provider and the
credential variable it needs; supplying that variable adds the provider to the
routing chain, and leaving it blank removes it. Each request is routed to a
*role* — `primary`, `fast`, `complex`, `translation` — with bounded retry and
fallback, and a provider that starts failing is temporarily taken out of the
chain. `GET /v1/rose/diagnostics` reports the whole picture. See
[`../AGENTS.md`](../AGENTS.md) for the invariants.

## Why a proxy

An MV3 extension bundle is readable by anyone who installs it, and anything in
`chrome.storage` is readable by anything running in the extension. Putting a
provider key in either place hands it to every user. The backend keeps the key
server-side and forwards only the provider's response.

## Run it

```bash
OPENROUTER_API_KEY=... node backend/rose-backend.mjs
# or
npm run backend
```

There is nothing to install — the files use only `node:http` and the built-in
`fetch` (Node 20+).

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | A provider credential. At least one provider must be configured. Never logged, never returned. |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `NVIDIA_API_KEY` | — | Additional providers. Optional; each joins the chain when set. |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | — | Cloudflare needs **both**; the account id builds the URL. |
| `<ID>_BASE_URL` | provider default | Override a provider's base URL. Point it at a mock to test without a real key. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Legacy alias for the OpenRouter base URL. |
| `ROSE_ROLE_PRIMARY` / `_FAST` / `_COMPLEX` / `_TRANSLATION` | see code | Which provider serves each role. |
| `ROSE_FALLBACK_ORDER` | (built-in order) | Comma-separated provider ids for the fallback tail. |
| `ROSE_MAX_PROVIDER_HOPS` | `3` | Ceiling on providers tried per request. |
| `ROSE_MAX_ATTEMPTS_PER_PROVIDER` | `2` | Ceiling on attempts against one provider. |
| `ROSE_DEGRADE_AFTER` | `2` | Consecutive transient failures before a provider is skipped. |
| `ROSE_DEGRADED_TTL_MS` | `60000` | How long that skip lasts. |
| `ROSE_AUTH_DEGRADED_TTL_MS` | `300000` | Longer skip after a rejected credential. |
| `PORT` | `8787` | Listen port. `0` picks a free one. |
| `HOST` | `0.0.0.0` when hosted, else `127.0.0.1` | Bind address. |
| `ROSE_BACKEND_TOKEN` | — | When set, callers must send `Authorization: Bearer <token>`. |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS allowlist. |
| `REQUEST_TIMEOUT_MS` | `60000` | Upstream timeout. |

### Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat/completions` | The OpenAI-compatible surface the extension calls. Accepts optional `rose_task` and `rose_complex` routing hints. On success returns `x-rose-provider`, `x-rose-model`, `x-rose-role`, `x-rose-latency-ms`. |
| `GET /health` | Liveness plus a stable `provider`/`keyConfigured` summary. |
| `GET /v1/rose/diagnostics` | Every provider with `configured`/`health`, the credential *variable names* required, the role assignment, the last error and average latency. Contains no credential. |
| `GET /v1/models` | Enough of the OpenAI surface for a client that probes it first. |

### Hosting (Render, Railway, Fly, Heroku)

The backend detects a hosted environment and binds `0.0.0.0` automatically. This
matters more than it looks: a platform router cannot reach a loopback socket, so
a service bound to `127.0.0.1` starts cleanly, logs that it is listening, and then
never answers a single request. The failure is silent — the logs look healthy and
every request times out.

Detection is a platform marker (`RENDER`, `RAILWAY_ENVIRONMENT`, `DYNO`,
`FLY_APP_NAME`, `K_SERVICE`, …), or a container that was handed a `PORT`. A plain
`PORT=3000 node backend/rose-backend.mjs` on a laptop keeps the loopback default
rather than quietly exposing the service to the local network. `HOST` overrides
both. `render.yaml` is included; set `OPENROUTER_API_KEY` and
`ROSE_BACKEND_TOKEN` in the dashboard, never in the file.

**Set `ROSE_BACKEND_TOKEN` before exposing this publicly.** Without it the
endpoint is an open relay for your provider quota — anyone who learns the URL can
spend your credits. With it, the extension sends the token as the `Authorization`
header and the backend swaps it for the real provider key, which the client never
sees.

### About `ALLOWED_ORIGINS`

ROSE calls the provider from the **service worker**
(`src/background/index.ts`), and a cross-origin fetch from an extension sends an
`Origin` header — so the backend must authorise it or the browser blocks the
response.

**Leave the default `*`.** An extension sends no cookies, and the endpoint is
guarded by `ROSE_BACKEND_TOKEN`, so `*` gives nothing away. This is the
recommended setting.

An allowlist is possible but awkward: the value must be
`chrome-extension://<extension-id>`, **not** `https://`. The manifest ships no
`key`, so Chrome derives the id from the extension's absolute install path — it
is stable on one machine and different on the next. Read yours from
`chrome://extensions` (Developer mode) rather than guessing, and expect to update
the allowlist whenever the install path changes.

An origin that is not listed gets no `access-control-allow-origin` header, so the
browser refuses to read the response. Note this is CORS, which is
browser-enforced: the server still processes the request, so `ALLOWED_ORIGINS` is
a browser-side guard, not an access control. `ROSE_BACKEND_TOKEN` is the access
control.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health`, `/healthz` | Liveness. Reports `keyConfigured` as a boolean — never the value. |
| `POST` | `/v1/chat/completions` | OpenAI-compatible completion, forwarded to OpenRouter. |
| `GET` | `/v1/models` | Empty list; enough for a client that probes first. |

## Pointing the extension at it

Settings → AI → **ROSE Backend (secure proxy)**, set the base URL to
`https://your-backend/v1`, and leave the key field empty. The provider entry has
`viaProxy: true`, so ROSE skips the "no key" check and sends no `Authorization`
header of its own.

If you would rather not rely on CORS, declare the origin at build time and it is
added to `host_permissions`:

```bash
ROSE_BACKEND_ORIGIN=https://your-backend npm run build:prod
```

## Deploying behind TLS

The backend speaks plain HTTP and expects TLS to be terminated in front of it.
Any reverse proxy works:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
```

Bind `HOST=127.0.0.1` and let the proxy be the only thing reachable, so the
plaintext port is not exposed.

## Errors

Provider failures are mapped onto codes the extension already understands, so the
overlay shows a readable message instead of a raw HTTP status:

| Upstream | Returned | `error.code` |
|---|---|---|
| `401` | `401` | `unauthorized` |
| `402` | `402` | `credits` |
| `429` | `429` | `rate-limited` |
| `5xx` | `502` | `server` |
| timeout | `504` | `timeout` |
| unreachable | `502` | `network` |
| no key configured | `503` | `no-key` |

## Secret handling

- The key is read from the environment once at startup. It is never read from a
  file, a query string, or a request body.
- It is attached to the upstream request only, as `Authorization: Bearer …`.
- Log lines carry metadata only — event, status, duration, request id. No
  prompts, no headers, no key.
- Error bodies from the provider are passed through a redactor
  (`sk-or-v1-…`, `sk-…`) before being returned, so a provider that echoes a key
  back cannot leak it to the client.
- `/health` reports `keyConfigured: true|false`, never the value.

`tests/backend/rose-backend.test.ts` pins all of the above, including that the
key never reaches stdout, extension storage, or a response body.

## Testing without a real key

Point `OPENROUTER_BASE_URL` at the validation mock and use a placeholder:

```bash
OPENROUTER_API_KEY=dummy node backend/rose-backend.mjs
OPENROUTER_BASE_URL=http://127.0.0.1:8788/v1 ...
```

`npm run verify:browser` does exactly this in Phase 7, driving the real backend
process and asserting the credential never becomes observable to the extension.
