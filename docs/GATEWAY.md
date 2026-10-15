# WorkBuddy2API — gateway guide

English reference for the gateway bundled with `dsh-workbuddy2dsh`. It is a self-hosted,
OpenAI-compatible reverse proxy that wraps one or more Tencent CodeBuddy / WorkBuddy
accounts behind a single `/v1/chat/completions` endpoint, with a web management panel.

The upstream project is [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel)
(MIT), itself a fork of [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api).
The original Chinese README is preserved at [upstream/README.zh.md](upstream/README.zh.md).

> **Personal use only.** This is an unofficial gateway for your own authorised account(s),
> on your own machine or private environment. Bulk account registration, paid API resale,
> shared pools and quota resale are prohibited and violate the platform's terms of service.
> See [../NOTICE](../NOTICE).

---

## 1. Requirements

- One or more registered CodeBuddy / WorkBuddy accounts, for the OAuth login.
- Either the single-file binary (no runtime needed), Docker, or Go ≥ 1.22 to build from source.
- A writable directory for credentials (`auths/`) and state (`data/`).

## 2. Running it

### 2.1 Windows / macOS / Linux — single binary

```powershell
# Build (once)
go build -trimpath -ldflags="-s -w" -o wb2api.exe ./cmd/server

# Run — the first start generates config.json with a random api_key and prints it once
.\wb2api.exe -config config.json

# Then open the panel and add an account
#   http://127.0.0.1:7863/panel/
```

The executable is self-contained: the panel's HTML and JavaScript are embedded, so copying
it to another machine is enough as long as `auths/` and `data/` are writable.

### 2.2 Docker Compose

```bash
cp config.example.json config.json
docker compose up -d --build
curl -s http://localhost:7863/healthz
# {"healthy":0,"realm_servable":{...},"service":"workbuddy2api","total":0}
```

### 2.3 From source

```bash
go build ./...
go vet ./...
go test ./...            # full suite
go run ./cmd/server -config config.json
```

### 2.4 Other binaries

```bash
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o wb2api   ./cmd/server
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o signin_bin ./cmd/signin
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o login    ./cmd/login
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o credit   ./cmd/credit
```

## 3. Adding an account

**Route A — the web panel (recommended, all platforms).** Open
`http://127.0.0.1:7863/panel/` and click **Add account**. The panel shows an authorisation
link, the browser completes the login, the credential is detected and written to
`auths/workbuddy-<uid>.json`, the account is hot-loaded into the pool without a restart, and
the first check-in runs.

**Route B — the command-line script (Linux/macOS only, needs `bash` + `python3`).**

```bash
./login.sh
# Follow the authorisation link in the browser, confirm in the terminal, the credential
# lands in auths/workbuddy-<uid>.json and the container restarts.
```

`login.sh` performs the authorisation-URL fetch, the browser login, the token poll, the
first check-in and the credential write; there is no PKCE (the state is issued server-side).
The pool is reconciled against `auths/` at startup, so dropping a credential file in is
enough for it to be discovered. Windows users should use Route A (or WSL).

## 4. Verifying

```bash
KEY=your-api-key     # the value from config.json

# Model list
curl -s http://localhost:7863/v1/models -H "Authorization: Bearer $KEY"

# Account status (summary + per-account detail; disabled accounts expose disabled_reason)
curl -s http://localhost:7863/status -H "Authorization: Bearer $KEY"

# Streaming chat
curl -sN http://localhost:7863/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"stream":true}'

# Non-streaming (aggregated locally)
curl -s http://localhost:7863/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

## 5. Configuration reference

`config.example.json` is the most complete reference — every field, its default and its
shape. The table below is the field-by-field meaning. Values in the example file are
placeholders such as `test_key`; no real secret is ever committed.

### 5.1 Top level

| Field | Default | Meaning |
|---|---|---|
| `listen` | `:7863` | HTTP listen address. |
| `api_key` | empty | Gateway auth key. **Empty means no authentication at all** — always set it on anything reachable. |
| `auth_dir` | `./auths` | Credential directory. |
| `state_file` | `./data/state.json` | Pool-state persistence file. |
| `server.read_timeout` | `300s` | Total inbound read budget including body upload. Large contexts or file chunks forwarded through a reverse proxy will hit `400 read body: i/o timeout`. `0` disables. Requires restart. |
| `panel.package_detail_limit` | `5` | Credit-composition view: how many soonest-expiring packs to show per account; the rest are folded into aggregates. |

### 5.2 Logging

| Field | Default | Meaning |
|---|---|---|
| `logging.request_archive_enabled` | `true` | JSONL archive of request metadata. Prompts, response bodies and `Authorization` are never recorded. |
| `logging.request_retention_days` | `7` | Retention for archived requests; expired files are removed at startup and periodically. |
| `logging.request_archive_max_mb` | `100` | Total archive cap (MiB); oldest files go first. |
| `logging.request_client_info` | `true` | Record the caller's IP and User-Agent. |

### 5.3 Cooldown and circuit breaking

| Field | Default | Meaning |
|---|---|---|
| `cooldown.soft_rate` | `600s` | Base cooldown for soft rate limiting (429 / rate-limit text); doubles exponentially per consecutive hit on the same account. |
| `cooldown.soft_rate_max` | `2h` | Ceiling for the soft-cooldown backoff. |

### 5.4 Schedule (local time, whole hours)

| Field | Default | Meaning |
|---|---|---|
| `schedule.checkin_hours` | `[9, 21]` | Check-in plus balance-query unfreeze. An empty array / `null` falls back to the default — it does **not** disable it. |
| `schedule.travel_hours` | `[9, 21]` | Cat-travel state machine (adopt / dispatch / claim). |
| `schedule.activity_hours` | `[10]` | Daily conversation-activity report (lights up consecutive login, unlocks `first_buddy`). |
| `schedule.keepalive_hours` | `[22]` | Token keep-alive refresh. |
| `schedule.blackcat_hours` | `[23]` | Night-owl top-up (counting window 23:00–08:00). |
| `schedule.growth_hours` | `[1]` | Growth-task automation slot. |
| `schedule.checkin_enabled` | `true` | Master switch for check-in. |
| `schedule.travel_enabled` | `true` | Master switch for cat travel (independent of check-in). |
| `schedule.activity_enabled` | `true` | Master switch for the activity report. |
| `schedule.keepalive_enabled` | `true` | Master switch for token keep-alive. |
| `schedule.blackcat_enabled` | `true` | Master switch for night-owl. |
| `schedule.growth_enabled` | `true` | Master switch for growth tasks. |
| `schedule.include_disabled_in_tasks` | `false` | Run the four upkeep tasks (check-in / activity / keep-alive / balance refresh) for **disabled** accounts too. "Disabled" only removes an account from selection; it does not stop upkeep. |
| `schedule.balance_refresh_enabled` | `true` | Background balance refresh. |
| `schedule.balance_refresh_minutes` | `5` | Background balance-refresh period. |

### 5.5 Upstream

| Field | Default | Meaning |
|---|---|---|
| `upstream.timeout_seconds` | `120` | Total budget for short RPCs (token refresh, check-in, balance, model list). Expiry switches account / trips the breaker. |
| `upstream.header_timeout_seconds` | falls back to `timeout_seconds` | Budget for a chat SSE **before the first byte** (response headers). Timeout means "resend on another account". |
| `upstream.idle_timeout_seconds` | `300` | Budget for **idle time inside** a chat SSE stream. Active data keeps it alive; silence ends the stream and releases the lease. |
| `upstream.user_agent` | empty | Outbound User-Agent override (empty keeps `CLI/2.63.2 CodeBuddy/2.63.2`). The official WorkBuddy desktop UA is `WorkBuddy/<version>`. |
| `upstream.passthrough_ip` | `false` | Forward the caller's IP upstream. |

A chat stream — `stream: true` **and** `false` alike — has **no total time limit**: chat uses
a dedicated client with `Timeout=0`, so long reasoning and long output are never cut off.

### 5.6 Behaviour

| Field | Default | Meaning |
|---|---|---|
| `features.sanitize_blacklist_fingerprints` | `true` | Strip blacklisted fingerprint fields from the outbound body. |
| `prompt.mode` | `custom` | System-prompt strategy: `custom` replaces the client's system prompt with the gateway's own (kills system-originated content false positives at the source); `append` inserts the gateway prompt after leading system/developer blocks (existing messages untouched); `passthrough` forwards the client's system prompt verbatim (a downgrade retry still switches to a neutral prompt). |
| `prompt.file` | empty | Prompt file path. Empty uses the built-in ~2 KB default. A non-empty but unreadable path is a startup error. |
| `global.enabled` | `true` | Enable the `global` (international) realm. |
| `global.chat_base` / `global.billing_base` | empty | Override the international upstream bases. |

### 5.7 State and pool

| Field | Default | Meaning |
|---|---|---|
| `upstash.url` / `upstash.token` | empty | Empty means pure in-memory mode (Noop fallback; everything still works). |
| `pool.max_in_flight` | `3` | Max in-flight requests per account (`0` = unlimited). |
| `pool.max_in_flight_global` | `2` | Per-account in-flight cap on the `global` realm (the international WAF is stricter). |
| `pool.breaker_threshold` | `3` | Consecutive failures that trip the breaker. |
| `pool.breaker_cooldown` | `30m` | Base breaker backoff. |
| `pool.breaker_cooldown_max` | `6h` | Exponential ceiling for the breaker backoff. |
| `pool.degrade_threshold` | `5` | Consecutive unknown errors (client/transport) before temporary deprioritisation. |
| `pool.degrade_cooldown` / `degrade_cooldown_max` | `10m` / `2h` | Deprioritisation duration and ceiling. |
| `pool.idle_weight_per_hour` | `0.5` | Idle compensation: +0.5 weight per unused hour. |
| `pool.idle_weight_max` | `5.0` | Idle-compensation weight ceiling. |
| `pool.prefer_expiring` | `true` | Soon-expiring-credit weighting: accounts with a valid soon-expiring batch get ×3 selection weight. A soft preference — weaker than session stickiness and model cost tiering. |
| `pool.expiring_soon` | `168h` | Window for the above. Empty or `0` disables it. |
| `pool.cost_explore_interval` | `30m` | Conditional exploration window for `costTier`: while a free tier dominates and unknown accounts exist, one real request per window is detoured to an unknown account. `0` disables. |
| `pool.credit_floor` | `100` | **Credit floor**: below this balance an account stops being selected for **measured-paid** models (tier 2, ledger valid within 6 h) — so a paid model cannot drain the balance and leave even the free models 402-cooldowned until the next check-in. tier 0 (measured free) and tier 1 (no observation) are exempt. `0` disables. |
| `session_sticky.enabled` | `true` | Session-affinity routing. |
| `session_sticky.ttl` | `30m` | Session binding TTL (rolling renewal). |
| `session_sticky.gc_interval` | `5m` | Expired-binding GC period. |

### 5.8 Environment-variable overrides

Load order is JSON file → `WB2A_*` environment variables (a variable overrides only when
non-empty):

`WB2A_LISTEN`, `WB2A_API_KEY`, `WB2A_AUTH_DIR`, `WB2A_STATE_FILE`, `WB2A_MAX_BODY_MB`,
`WB2A_SOFT_RATE` (duration), `WB2A_SOFT_RATE_MAX` (duration), `WB2A_TIMEOUT_SECONDS`,
`WB2A_HEADER_TIMEOUT_SECONDS`, `WB2A_IDLE_TIMEOUT_SECONDS`, `WB2A_USER_AGENT`,
`WB2A_SANITIZE_FINGERPRINTS` (bool), `WB2A_PROMPT_MODE`, `WB2A_PROMPT_FILE`.

## 6. HTTP API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/chat/completions` | yes | Chat completions, streaming and non-streaming. |
| `GET` | `/v1/models` | yes | The live model catalog. |
| `GET` | `/status` | yes | Pool summary plus per-account detail. |
| `GET` | `/healthz` | no | Liveness. `503` when no account is usable. Body carries `service`, `healthy`, `total`, `realm_servable`. |
| `GET` | `/panel/` | no (data routes are) | The management panel. |
| `GET` | `/panel/api/*` | yes | Panel data endpoints. |

### 6.1 Streaming behaviour

Outbound is always `stream: true`; the SSE frames are rebuilt against a spec whitelist, and a
non-streaming client request is aggregated locally into a single response. `reasoning_content`
is carried across turns, and the DeepSeek thinking chain is injected via
`thinking.type=enabled` with an effort tier that degrades automatically.

### 6.2 Error classification and account handling

| Upstream signal | Gateway reaction |
|---|---|
| `429` / rate-limit text (e.g. code 6004) | Soft cooldown from `cooldown.soft_rate`, doubling per consecutive hit, capped by `soft_rate_max`. |
| `404` | Fixed 60 s short cooldown. |
| `402` | Hard cooldown until 04:00 the next day. |
| `11102` model not found | The model is marked blocked for that realm. |
| Consecutive failures | Breaker (per-account, exponential backoff to `breaker_cooldown_max`). |

## 7. The management panel

`http://127.0.0.1:<port>/panel/` — a single embedded page with a light/dark theme and seven
views.

| View | Contents |
|---|---|
| **Overview** | Pool health, credit totals, per-account cards, expiring-credit warnings, in-flight and sticky-session counts. |
| **Usage** | Per-request usage, credit composition, model and tier breakdowns, time-range queries (today / last 24 h / 3 d / 7 d / 30 d / all time / custom). |
| **Accounts** | Add, disable, inspect and re-authorise accounts; `disabled_reason` is surfaced. |
| **Models** | The live catalog with context length, max output and reasoning tiers, plus a conditional query view. |
| **Config** | Edit the gateway's `config.json` from the browser; most fields take effect live, restart-only fields are labelled. |
| **Runtime logs** | Startup and scheduler output. |
| **Request logs** | One compact row per request — TTFB, token rate, model, account, uid — including the caller's IP and User-Agent, with time-range filtering. |
| **Task center** | The scheduled tasks with per-task status, a one-click **Run all**, and the growth-task automation. |

### 7.1 Scheduled tasks

Four independent schedules run alongside the gateway:

- **Check-in** (09/21) — plus a consecutive-login steward that redeems unlocked tiers and
  spends remaining draw attempts.
- **Activity report** (10) — lights up consecutive login and unlocks `first_buddy`.
- **Cat travel** (09/21) — its own state machine (adopt / dispatch / claim).
- **Token keep-alive** (22) — refreshes credentials.
- **Night owl** (23) — tops up `glm-5.2` conversation counts inside the 23:00–08:00 window.

### 7.2 Growth tasks

Of the platform's 18 growth tasks, 17 can be completed from the panel with a single click —
no official client, no manual interaction. The gateway advances the progress, waits for the
asynchronous scoring to settle, and claims the reward. A fresh account completing everything
nets roughly **+1950 credits and +78 energy**, of which only a handful of tasks involve real
conversation (one `glm-5.2` message and a few short fast-model exchanges); the rest are
behavioural event reports that consume no conversation. The one task that cannot be automated
is shown with instructions instead.

## 8. Security and compliance

1. **Credentials.** `auths/` stores plaintext `accessToken` / `refreshToken`. Treat the
   directory as a secret; it is created under `~/.workbuddy2dsh/auths` by default and is
   never written into the plugin repository.
2. **Network exposure.** Bind to loopback. The API key is a single shared secret with no
   per-user scoping, and the panel's data routes are protected by the same key.
3. **Request logs.** Metadata only — no prompts, no response bodies, no `Authorization`.
4. **Scope of use.** Your own authorised account(s), your own machine or private
   environment. No bulk registration, no resale, no shared pool. See [../NOTICE](../NOTICE)
   for the upstream usage declaration in full.
