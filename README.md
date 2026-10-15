<p align="center">
  <img src="./icon.svg" width="96" alt="WorkBuddy2API">
</p>

<h1 align="center">dsh-workbuddy2dsh</h1>

<p align="center">
  <b>Your WorkBuddy account's models — including the free DeepSeek V4.1 Flash — inside DeepSeek Harness.</b><br>
  Runs the self-hosted <a href="https://github.com/linguo2625469/workbuddy2api-panel">WorkBuddy2API</a>
  gateway as a sidecar and publishes its catalog into the normal model picker, in two lanes:
  free and account-metered. No proxy, no exit pool, no API key to buy.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D22.19-FFC24D?style=flat-square&logo=node.js&logoColor=black" alt="Node">
  <img src="https://img.shields.io/badge/Go-1.22%2B-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/Platforms-Windows%20%7C%20Linux%20%7C%20macOS-0DBD8B?style=flat-square" alt="Platforms">
  <img src="https://img.shields.io/badge/Transport-SSE%20%2F%20streaming-0DBD8B?style=flat-square" alt="Transport">
  <img src="https://img.shields.io/badge/Licence-MIT-F0522C?style=flat-square" alt="Licence">
</p>

---

## What you get

- **Your WorkBuddy models in the normal model picker** — pick them like any other provider.
- **A free lane and a metered lane**, split from the gateway's own pricing, so you can see at a
  glance which model costs nothing.
- **A chip in the composer's bottom bar** — one click for pool health, live prices, credit
  spend, and a link straight to the gateway's management panel.
- **The gateway's full web panel** for account management, per-request logs and scheduled tasks.

Nothing is reimplemented. The WorkBuddy protocol, the OAuth login, the account pool and the
panel all come from the upstream gateway; this plugin starts it, keeps it alive, and publishes
what it advertises.

```
DeepSeek Harness ──llm-pi-ai route──▶ http://127.0.0.1:7863/v1 ──▶ WorkBuddy2API ──▶ WorkBuddy
        ▲                                    (sidecar child process)          (your account)
        ├── model picker: WorkBuddy2API Free    → hy3, deepseek-v4.1-flash, …
        ├── model picker: WorkBuddy2API Account → glm-5.2, kimi-k3, …
        └── composer chip: pool health · prices · credits spent · panel link
```

The two lanes are one gateway and one credential — the plugin only splits what it publishes.

## Install

### 1. Get the gateway binary

One command, on Windows, Linux or macOS:

```bash
node scripts/build-gateway.mjs
```

It puts `bin/wb2api[.exe]` in place — exactly where the plugin looks first — and boots it once
to prove it works before leaving it there.

| What you have | What it does |
|---|---|
| Go 1.22+ installed | Builds from source, so the binary always matches this tree |
| No Go toolchain | Downloads this repository's prebuilt binary for your platform, sha256-verified |

Force either route with `--build` or `--download`. See [docs/GATEWAY.md](docs/GATEWAY.md) for the
build-from-source and Docker routes.

### 2. Add the plugin to a profile

From the DSH GUI's **Add plugin** box:

```
dsh-workbuddy2dsh
```

or from a terminal, where the profile name is required:

```bash
dsh plugin add dsh-workbuddy2dsh --profile desktop
```

<details>
<summary>Other routes</summary>

| Route | Command |
|---|---|
| Local checkout | `dsh plugin add /absolute/path/to/dsh-workbuddy2dsh` |
| Tarball | `dsh plugin add ./dsh-workbuddy2dsh-1.0.0.tgz` |
| Pinned to a commit | `dsh plugin add github:mirelconstantin/dsh-workbuddy2dsh#<sha>` |

</details>

Restart the profile. The gateway starts immediately; the model list stays empty until you add
an account.

### 3. Add your WorkBuddy account

Open **<http://127.0.0.1:7863/panel/>** and click **Add account**. The panel shows an
authorisation link, your browser completes the login, and the credential is written to
`~/.workbuddy2dsh/auths/` — no password ever passes through this plugin. The account is
hot-loaded, and the first check-in runs as part of the same flow.

Within a few seconds, two provider groups appear in the model picker. `deepseek-v4.1-flash` is
in the free one.

> **Check the promotion is still on.** The free offer is WorkBuddy's pricing decision, not a
> feature of this project. It is advertised as a two-week promotion. Confirm the *"free now"*
> label is still showing in WorkBuddy before you plan real work around it. When it ends the
> model simply moves to the account lane — nothing else changes.

## The composer chip

Click the globe chip in the composer's bottom bar, beside the context meter. It answers the
three questions you have while typing:

| What it shows | Where it comes from |
|---|---|
| **Is the gateway up?** | The chip says `not running` and why, rather than going quiet |
| **What's free right now?** | The free lane, with each model's live price and promotion label |
| **What am I spending?** | Credits spent, plus the account pool's health |
| **Pool health** | `3/5 usable`, and any cooling or disabled accounts |
| **Panel link** | Opens the gateway's management panel in a tab |

The free lane shows the price the gateway *actually charges* — a promotion reads `0.00` with
the pre-promotion price struck through beside it, so a temporary offer never looks permanent.

The chip polls every 15 seconds while the composer is open, and reads DSH's own web route
rather than the gateway's port, so your browser never sees the gateway's API key.

## Configuration

Everything is optional; the defaults work. Set fields in the plugin's card on the DSH
**Plugins** page, or in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: workbuddy2dsh
      name: 'dsh-workbuddy2dsh'
      config:
        port: 7863
        refreshSeconds: 300
```

| Field | Live? | Default | Meaning |
|---|---|---|---|
| `enabled` | live | `true` | Start the gateway. Off keeps the plugin loaded but idle. |
| `attachOnly` | live | `false` | Use a gateway already running on `port` instead of spawning one, and never write its `config.json` — for a container or a system service that owns the process. |
| `binaryPath` | live | *(resolved)* | Gateway binary. Blank tries `bin/wb2api[.exe]`, then `_runtime/wb2api[.exe]`, then `wb2api` on `PATH`. |
| `dataDir` | live | `~/.workbuddy2dsh` | Where `config.json`, `auths/` and `data/` live. |
| `port` | live | `7863` | Loopback port. `0` picks a free port at startup. |
| `refreshSeconds` | live | `300` | Model-list refresh interval once the catalog is populated. |
| `providerId` | — | `workbuddy2api-free` | Route name for the free lane. |
| `apiKeyEnv` | — | `WORKBUDDY2DSH_TOKEN` | Credential reference holding the gateway API key. Shared by both lanes. |
| `displayName` | — | `WorkBuddy2API Free` | Group name in the picker for the free lane. |
| `accountProviderId` | — | `workbuddy2api-acc` | Route name for the metered lane. |
| `accountDisplayName` | — | `WorkBuddy2API Account` | Group name in the picker for the metered lane. |
| `restartDelayMs` / `restartMaxDelayMs` | — | `1000` / `60000` | Restart backoff bounds. |
| `maxConsecutiveCrashes` | — | `5` | Consecutive crashes before the plugin stops restarting. |
| `startupTimeoutMs` | — | `30000` | How long to wait for `/healthz` before declaring startup failed. |
| `extraArgs` | — | `[]` | Extra CLI args appended after `-config <path>`. |

**Live** fields are declared `volatile()`, so saving one from the Plugins page reaches the
running gateway with no restart. The runtime does the minimum work: a connection change
restarts the child, a route-identity change republishes **both** routes, and a `refreshSeconds`
change only re-arms the timer.

The gateway has its **own**, much larger configuration file (`~/.workbuddy2dsh/config.json`):
account-pool tuning, cooldown windows, the check-in schedule, prompt mode, request logging and
more. This plugin owns exactly two fields in it — `listen` and `api_key` — and leaves
everything else as you set it. See [docs/GATEWAY.md](docs/GATEWAY.md).

## How it works

1. `apply()` hands the resolved config to a `GatewayRuntime` and subscribes to
   `loader/volatile-update`. It injects **nothing** on purpose: injecting `settings` would park
   the whole fiber — and with it the gateway — in any composition that composes no settings
   service, and the gateway's panel is where an account gets added, so it has to come up first.
2. The runtime picks a port, writes `~/.workbuddy2dsh/config.json` if absent, and spawns the
   gateway with `cwd` set to the data directory.
3. It polls `GET /healthz` until the listener answers. Any HTTP status counts — the endpoint
   replies `503` while the pool is empty, and "the listener answers" is the whole readiness
   contract.
4. It resolves the `credentials`, `settings` and `webServer` seams **lazily** through bounded
   `ctx.inject()` races, stores the gateway key under `apiKeyEnv`, and registers one status
   route for the browser half.
5. It reads the model catalogue and writes both `llm-pi-ai.providers.*` routes in a single
   `settings.mutate` call:

   ```
   settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', id], … }, …])
     → ConfigEditor persists into the profile patch
     → loader/volatile-update
     → llm-pi-ai's ensureRegistrationFacts()
     → ctx.llm.registerAdapter([…route ids], adapter)
   ```

   Nothing here patches the profile file behind the ConfigEditor's back.
6. It refreshes on a timer — every `refreshSeconds` once models exist, every 15 s while the
   catalog is empty, so a fresh login shows up within seconds.
7. It splits the catalogue into two lanes and keeps them separate on every refresh:

   | Lane | Contents |
   |---|---|
   | **Free** | Every model whose promotion factor is `0` — the "free now" set. |
   | **Account** | Everything priced above zero, **and every model published with no price at all**. |

   The split reads the gateway's promotion data, not a hard-coded list, so a promotion starting
   or ending moves the model between lanes by itself. The conservative default is deliberate: a
   model of unknown cost goes to the **account** lane, never the free one.
8. On unload it removes both routes and reaps the child (Windows gets `taskkill /T`; POSIX gets
   `SIGTERM`, then `SIGKILL`).

Nothing is written into the plugin directory. `~/.workbuddy2dsh/auths/` holds plaintext
tokens — treat it as a secret.

## The management panel

The gateway's panel is embedded in the binary at `http://127.0.0.1:<port>/panel/`, and stays
available while DSH runs.

| View | What it shows |
|---|---|
| **Overview** | Pool health, credit totals, per-account cards, expiry warnings. |
| **Usage** | Per-request usage, credit composition, model/tier breakdowns. |
| **Accounts** | Add, disable, inspect and re-authorise accounts. |
| **Models** | The live model catalog with context length, max output and reasoning tiers. |
| **Config** | Edit the gateway's own `config.json` live. |
| **Runtime logs** | Startup and scheduler output. |
| **Request logs** | One line per request: TTFB, token rate, model, account, client IP/UA. |
| **Task center** | The scheduled check-in / activity / travel / keep-alive tasks, with a one-click "Run all". |

## Developing

```bash
npm run setup     # fetch a gateway binary (build or download) — Windows/Linux/macOS
npm test          # 54 tests: catalog splitting, config ownership, bridge, lifecycle, entry
npm run check     # static contract check (manifest, patch, locale, client, README links)
npm run build     # typecheck + build the browser half (lib/client.js)
npm run e2e       # drive the real binary through the real lifecycle
```

All scripts are platform-neutral: every one is Node.js. Nothing forks on the operating system
except the child's teardown signal and the binary's name.

[AGENTS.md](AGENTS.md) records the constraints worth knowing before changing anything — the
`export default` rule, why `inject` stays empty, and how the browser half is built.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Picker never shows **WorkBuddy2API Free** | No account yet. Open the panel and add one; the plugin retries every 15 s. |
| Only one of the two lanes appears | Its model set is empty (e.g. the promotion ended), so the route is withdrawn instead of published empty. Check the panel's **Models** view. |
| The chip never appears | The browser half is not built. Run `npm run build`, then reload DSH. |
| The chip reads `not running` | The gateway is not answering. Check `binaryPath` and run the gateway by hand to see its output. |
| `the settings seam has no mutate()` in the log | The composition has no settings service (headless/CLI). The gateway still runs and the panel still works; only the picker route is skipped. |
| `gateway did not answer /healthz` | The binary did not start. Check `binaryPath` and run the gateway by hand. |
| Port already in use | Another gateway is running, or `port` collides. Set `port: 0` to auto-pick, or `attachOnly: true` to share one. |
| `WORKBUDDY2DSH_TOKEN is exported by the environment and does not match` | The variable is set in the shell you launched DSH from, and the credentials provider refuses to overwrite it. Unset it there and reload. |
| `MISSING_CREDENTIAL` from every request | The route resolves `apiKeyEnv` but nothing is stored under it. Set the variable, or reload so the plugin can store the key. |
| Models appear but every call fails | The account is expired or out of credits. The panel's **Accounts** view shows `disabled_reason`. |
| Gateway keeps restarting | Read the `[gateway]` lines in DSH's log. A malformed `~/.workbuddy2dsh/config.json` fails fast and loudly. |
| `winapi error #5` / `access is denied` from the gateway | On Windows this is an integrity-label mismatch: an executable created inside a low-integrity tree inherits a Low label, and a Low process cannot open a Medium-integrity file. Copy the binary outside that tree and set `binaryPath` to the copy. The plugin detects this and says so. |

## Licensing and attribution

This repository is a **derivative work**, distributed under the upstream **MIT** licence, kept
verbatim in [LICENSE](LICENSE) with both upstream copyright lines. The gateway source is the
upstream project, unmodified apart from an English translation of its user-visible strings. The
plugin code (`index.js`, `src/`, `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg`,
`scripts/`) is original MIT work.

See [NOTICE](NOTICE) for the full attribution and compliance notes. The original Chinese
upstream README is preserved at [docs/upstream/README.zh.md](docs/upstream/README.zh.md).

> **Personal use only.** The upstream project is a self-use tool for managing *your own*
> account(s). Bulk account registration, offering a paid API, running a shared pool, or
> reselling quota is **expressly not supported and is prohibited**, and violates the target
> platform's terms of service. This project is not affiliated with or endorsed by Tencent,
> CodeBuddy, WorkBuddy, DeepSeek, or the upstream authors.

## Model Experience

Indirectly, through `dsh-llm-pi-ai`: this package contributes provider routes, not context.
It adds no system prompt, no tool schema, and no message content of its own. What it does
contribute is the catalog the adapter resolves — model ids, display names, context windows,
output caps, input modalities, and reasoning-effort levels — read from the gateway's
`GET /v1/models` and republished as an `llm-pi-ai` route.

The composer chip adds no model experience either: it is a readout of the gateway's own
catalogue and pool, published verbatim.

#### KV Cache effect

Independent per route, and none of it is package-owned. A model reached through the gateway
is a separate model request from any other configured provider, so this package neither
appends to nor preserves a prompt prefix another provider established. Whether a prefix is
reusable is decided by the gateway's own upstream and its cache behaviour, which this package
does not observe or influence.

The one package-owned change that can invalidate reuse is a change to a published route
itself: a new `providerId`, `accountProviderId`, `port`, `binaryPath`, or `dataDir` restarts
the child and republishes at a different base URL, and a change in the gateway's catalog
changes the model ids. Moving a model between lanes is deliberately **not** treated as a route
change: the `model` string that identifies a request stays the same, only which group in the
picker it lives under.

## Known Limitations and Deferred Work

- **The gateway is a sidecar, not an adapter** — the plugin depends on the upstream binary
  being present and startable. `scripts/build-gateway.mjs` handles that once; `attachOnly`
  borrows a gateway someone else owns. There is no pure-Node fallback, and building one would
  mean reimplementing the protocol, the account pool, and the OAuth device flow.
- **The chip polls, it does not subscribe** — it refreshes every 15 s while the composer is
  open, so a state change is visible within that window rather than instantly. A push channel
  would need a socket the plugin does not have.
- **The chip shows the catalogue, not a picker** — unlike `dsh-opencode-router`'s proxy chip,
  this one only reports. There is no per-request routing decision for a user to make here, so
  there is nothing for a picker to choose.
- **The chip's price is the gateway's advertisement** — `promo_factor` is a point-in-time
  value, not a contract. A promotion that ends mid-session shows until the next refresh.
- **`attachOnly` cannot verify the key it finds** — in attach mode the plugin reads `api_key`
  from a `config.json` it does not own. If that file is absent the plugin errors rather than
  inventing one, but a file whose key does not match the running gateway is only discovered as
  a `401` per request.
- **A shadowed credential reference is reported, not repaired** — when the launching
  environment exports `apiKeyEnv`, the credentials provider refuses to write over it. The
  plugin detects the mismatch and warns, but cannot fix it; the user must unset the variable.
- **Restart backoff trips permanently** — after `maxConsecutiveCrashes` consecutive exits the
  plugin stops restarting. Recovery requires a plugin reload; there is no timed re-arm.
- **Reasoning levels are taken on trust** — `reasoningEfforts` is published from what the
  gateway advertises. A model that declares a tier its upstream rejects surfaces as a request
  error, not as a configuration error.
- **The lane split is a display decision, not a billing guarantee** — it is read from the
  gateway's own promotion data at refresh time. Nothing here meters requests or blocks a call.
  Watch the gateway panel's **Usage** view for certainty.
- **A model with no price data lands in the account lane** — `global:hy4-preview-f`,
  `global:default-model`, `global:enhance-1.0` and `global:o4-mini` publish no credits and no
  promotion factor in any endpoint the plugin can read. They are routed to the metered lane
  rather than guessed at.
- **`docs/upstream/` is vendored, not synchronised** — the upstream README is a point-in-time
  copy for attribution, not regenerated when upstream changes.
