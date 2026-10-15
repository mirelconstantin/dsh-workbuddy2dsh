<p align="center">
  <img src="./icon.svg" width="96" alt="WorkBuddy2API">
</p>

<h1 align="center">dsh-workbuddy2dsh</h1>

<p align="center">
  <b>Your WorkBuddy account's models — including the free DeepSeek V4.1 Flash — inside DeepSeek Harness.</b><br>
  A DSH plugin that runs the self-hosted <a href="https://github.com/linguo2625469/workbuddy2api-panel">WorkBuddy2API</a>
  gateway as a sidecar and publishes its catalog to the normal model picker in two lanes — free
  and account-metered. No proxy, no exit pool, no API key to buy.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D22.19-FFC24D?style=flat-square&logo=node.js&logoColor=black" alt="Node">
  <img src="https://img.shields.io/badge/Go-1.22%2B-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/Transport-SSE%20%2F%20streaming-0DBD8B?style=flat-square" alt="Transport">
  <img src="https://img.shields.io/badge/Licence-MIT-F0522C?style=flat-square" alt="Licence">
</p>

---

## What this is

WorkBuddy (the international CodeBuddy app) currently ships **DeepSeek V4.1 Flash** on a
limited-time zero-credit promotion — the model shows a *"free now"* label and a `0.00`
multiplier in the app's picker. This plugin gets that same account-driven access into
DeepSeek Harness as a normal model provider.

It does **not** reimplement anything. The WorkBuddy protocol, the OAuth device login, the
account pool, the cooldown/breaker logic and the web panel all come from the upstream
**WorkBuddy2API** gateway, which lives in this repository under its original MIT licence.
The plugin adds one thing: it starts that gateway as a child process, waits for it to come
up, and registers its OpenAI-compatible `/v1` endpoint with DSH so the models appear in the
picker next to every other provider.

Compared to [`dsh-opencode-router`](../dsh-opencode-router), this is deliberately simpler:
there is no proxy/exit pool and no second protocol implementation. The only moving part is
the gateway process.

```
DeepSeek Harness ──llm-pi-ai route──▶ http://127.0.0.1:7863/v1 ──▶ WorkBuddy2API ──▶ WorkBuddy
        ▲                                    (sidecar child process)          (your account)
        ├── model picker: WorkBuddy2API Free  → hy3, step-5-preview, deepseek-v4.1-flash
        └── model picker: WorkBuddy2API Account → glm-5.2, kimi-k3, …
```

The two lanes are one gateway and one credential — the plugin only splits what it
publishes, so you can see at a glance which models cost nothing and which spend credits.

## Requirements

- **DeepSeek Harness** `0.2.0-rc.x` (`engines.dsh` pins `>=0.2.0-0 <0.3.0`).
- **Node.js** 22.19+ or 24+ (DSH's own requirement).
- **Go 1.22+ — optional.** Only needed if you want to build the gateway from
  source. Without it the setup script downloads a prebuilt binary for your
  platform instead, so a fresh clone works with nothing but Node.js installed.
- A **WorkBuddy / CodeBuddy account** you are entitled to use. The gateway logs
  in through OAuth in your own browser; no password ever passes through this
  plugin.

## Install

One command on any of Windows, Linux or macOS:

```bash
node scripts/build-gateway.mjs
```

It puts a gateway binary at `bin/wb2api[.exe]` — exactly where the plugin looks
first — and then boots it once against a throwaway data directory to prove it
can bind a port, read its own config and answer `/healthz`. What happens in
between depends on what is installed:

| Go available? | What it does |
|---|---|
| Yes (on `PATH`, or a bundled `_tools/go`) | Builds from `./cmd/server`, so the binary always matches this source tree. Staged into `bin/`. |
| No | Downloads this repository's prebuilt release asset for **your** platform and verifies its sha256 against the release's `checksums.txt`. |

Force either route with `--build` or `--download`; `--go <path>` pins a specific
toolchain. Nothing about the plugin's behaviour differs — `defaultBinaryPath()`
resolves `bin/wb2api[.exe]` first on every platform.

### Add the plugin to a profile

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

Restart the profile. The plugin starts the gateway immediately — the model list
stays empty until you add an account, and the log says so.

Alternatively, run the gateway however you like (Docker Compose, a system
service, another container) and set `attachOnly: true` so the plugin borrows
that endpoint instead of spawning its own. See
[docs/GATEWAY.md](docs/GATEWAY.md) for the "bring your own gateway" route.

### Add your WorkBuddy account

Open the gateway's management panel:

**<http://127.0.0.1:7863/panel/>**

Click **Add account** in the top right. The panel shows an authorisation link, your browser
completes the login, the credential is detected and written to
`~/.workbuddy2dsh/auths/`, and the account is hot-loaded into the pool without a restart.
The first check-in runs as part of the same flow.

The plugin polls the gateway every 15 seconds while the catalog is empty, so within a few
seconds of that login **two provider groups** appear in the DSH model picker:
**WorkBuddy2API Free** holding the models the gateway advertises as free, and
**WorkBuddy2API Account** holding everything else. `deepseek-v4.1-flash` is in the first.

> **Verify the promotion is still on.** The free offer is WorkBuddy's pricing decision, not
> a feature of this project. It is advertised as a two-week promotion. Check that the
> *"free now"* label and the `0.00` multiplier are still showing in WorkBuddy before you
> plan real work around it. When the promotion ends the model simply moves to the
> account lane on the next refresh — nothing else changes.

## Use it

Pick **WorkBuddy2API Free → deepseek-v4.1-flash** for a free model, or
**WorkBuddy2API Account → glm-5.2** (or any other model in that group) when you want one
that spends credits. Nothing else to configure: the plugin already stored the gateway's API
key under the credential reference `WORKBUDDY2DSH_TOKEN` and wrote both `llm-pi-ai` routes,
so DSH's own dispatcher handles the rest.

Both lanes share one gateway process, one API key and one base URL — only the published
model list and the display name differ.

The panel stays available while DSH runs — that is where you watch credit balances, the
account pool, per-request logs and the scheduled check-in/keep-alive tasks.

## Configuration

Everything is optional; the defaults work. Set fields either in the plugin's card in the
DSH **Plugins** page or in the profile's `cordis.patch.yml`:

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
| `providerId` | — | `workbuddy2api-free` | Route name registered into `llm-pi-ai` for the free lane. |
| `apiKeyEnv` | — | `WORKBUDDY2DSH_TOKEN` | Credential reference holding the gateway API key. Shared by both lanes. |
| `displayName` | — | `WorkBuddy2API Free` | Group name shown in the model picker for the free lane. |
| `accountProviderId` | — | `workbuddy2api-acc` | Route name registered into `llm-pi-ai` for the metered lane. |
| `accountDisplayName` | — | `WorkBuddy2API Account` | Group name shown in the model picker for the metered lane. |
| `restartDelayMs` / `restartMaxDelayMs` | — | `1000` / `60000` | Restart backoff bounds. |
| `maxConsecutiveCrashes` | — | `5` | Consecutive crashes before the plugin stops restarting. |
| `startupTimeoutMs` | — | `30000` | How long to wait for `/healthz` before declaring startup failed. |
| `extraArgs` | — | `[]` | Extra CLI args appended after `-config <path>`. |

**Live** fields are declared `volatile()`, so saving one from the Plugins page reaches the
running gateway with no restart and no remount. The runtime diffs the new values against the
old and does the minimum work: a connection change restarts the child, a route-identity change
republishes **both** routes, and a `refreshSeconds` change only re-arms the timer.

The remaining fields are composition fields a profile sets once. Changing one needs a reload,
because they decide the plugin's identity rather than its state.

The gateway has its **own**, much larger configuration file
(`~/.workbuddy2dsh/config.json`): account-pool tuning, cooldown/breaker windows, the
check-in and keep-alive schedule, prompt mode, request logging, Upstash mirroring and more.
The plugin owns exactly two fields in it — `listen` and `api_key` — and leaves everything
else as you set it. See **[docs/GATEWAY.md](docs/GATEWAY.md)** for the full reference.

## How it works

The plugin is a thin lifecycle wrapper in `src/`. Nothing about the gateway's own behaviour
is reimplemented here.

1. `apply()` hands the resolved config to a `GatewayRuntime` and subscribes to
   `loader/volatile-update`. It injects **nothing** on purpose: injecting `settings` would
   park the whole fiber — and with it the gateway — in any composition that composes no
   settings service, and the gateway's panel is where an account gets added, so it has to
   come up first.
2. The runtime picks a port (or `port`), writes `~/.workbuddy2dsh/config.json` if absent
   (reusing an existing `api_key`), and spawns the gateway with `cwd` set to the data
   directory so the gateway's relative `auths/` and `data/` paths resolve there.
3. It polls `GET /healthz` until the listener answers. Any HTTP status counts — the endpoint
   replies `503` while the pool is empty, and "the listener answers" is the whole readiness
   contract.
4. It resolves the `credentials` and `settings` seams **lazily**, through a bounded
   `ctx.inject([...])` race, and stores the gateway key with `credentials.set` under
   `apiKeyEnv`. The key is memoized: the credentials provider rewrites its document on every
   `set`, so an unchanged pair is never re-sent.
5. It reads the model catalogue and writes `llm-pi-ai.providers.<providerId>` and
   `llm-pi-ai.providers.<accountProviderId>` in a single `settings.mutate` call. That write is
   what makes the models appear, and nothing about it needs a restart:

   ```
   settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', id], … }, …])
     → ConfigEditor persists into the profile patch
     → loader/volatile-update
     → llm-pi-ai's ensureRegistrationFacts()
     → ctx.llm.registerAdapter([…route ids], adapter)
   ```

   `dsh-llm-pi-ai` declares `providers` as a volatile dict, which is why a route is a
   live-editable setting and why this is the same seam the **Models → Add model provider**
   form writes through. Nothing here patches the profile file behind the ConfigEditor's back.
6. It refreshes on a timer — every `refreshSeconds` once models exist, every 15 s while the
   catalog is empty, so a fresh login shows up within seconds.
7. It splits the catalogue into two lanes and keeps them separate on every refresh:

   | Lane | Route id | Contents |
   |---|---|---|
   | Free | `providerId` | Every model whose promotion factor is `0` — the "free now" set. |
   | Account | `accountProviderId` | Everything the gateway prices above zero, **and every model it publishes no price for**. |

   The split reads the gateway's promotion data, not a hard-coded list, so a promotion
   starting or ending moves the model between lanes by itself. When the panel is reachable
   the plugin prefers its `/panel/api/models` view, because `/v1/models` carries only list
   prices and omits `promo_factor`; when it is not, `parseCredits` falls back to the list
   price and treats `x0.00` as free. The conservative default is deliberate: a model of
   unknown cost goes to the **account** lane, never the free one, so the free lane only ever
   advertises models the gateway has affirmatively called free.

   A lane left with no models is withdrawn rather than published empty, and a lane whose
   models moved to the other lane is republished on the same sweep.
8. On unload it removes both routes and reaps the child (Windows gets `taskkill /T`; POSIX
   gets `SIGTERM`, then `SIGKILL`).

Nothing is written into the plugin directory. `~/.workbuddy2dsh/auths/` holds plaintext
tokens — treat it as a secret.

## Developing

```bash
npm run setup    # fetch a gateway binary (build it, or download one) — Windows/Linux/macOS
npm test         # 48 tests: catalog splitting, config ownership, lifecycle, entry module
npm run check    # static contract check (manifest, patch, locale, README) — no host needed
npm run e2e      # drive the real binary through the real lifecycle
```

All of these are platform-neutral: every script the repo runs is Node.js, so
nothing here forks on `win32` except the two places the operating system forces
it — the child's teardown signal and the binary's name.

The runtime tests drive the real lifecycle against a stub HTTP gateway, so they cover the
parts that are easy to get wrong: that a refresh does not rewrite the credential store, that
an environment-supplied reference is reported rather than fought over, that a failed
readiness check still leaves the refresh loop armed, that a lane emptying out is withdrawn,
that the catalogue still splits on list prices when the panel is unreachable, and that
disposing really withdraws both routes.

[AGENTS.md](AGENTS.md) records the constraints worth knowing before changing anything — the
`export default` rule, why `inject` stays empty, and the sandbox recipe for rebuilding the
gateway binary on Windows.

## The management panel

The gateway's panel is embedded in the binary and served at
`http://127.0.0.1:<port>/panel/`. It has seven views:

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

The panel UI, the gateway's log lines, its HTTP error text and its CLI help were all
translated to English in this repository. The original Chinese README is preserved at
[docs/upstream/README.zh.md](docs/upstream/README.zh.md).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Picker never shows **WorkBuddy2API Free** | No account yet. Open the panel and add one; the plugin retries every 15 s. |
| Only one of the two lanes appears | Its model set is empty (e.g. the promotion ended), so the route is withdrawn instead of published empty. Check the gateway's panel **Models** view for current pricing. |
| `the settings seam has no mutate()` in the log | The composition has no settings service (headless/CLI). The gateway still runs and the panel still works; only the picker route is skipped. |
| `gateway did not answer /healthz` | The binary did not start. Check `binaryPath` and run the gateway by hand to see its output. |
| Port already in use | Another gateway instance is running, or `port` collides. Set `port: 0` to auto-pick, or `attachOnly: true` to share an existing one. |
| `WORKBUDDY2DSH_TOKEN is exported by the environment and does not match` | The variable is already set in the shell you launched DSH from, and the credentials provider refuses to write over it. Unset it there and reload, or set it to the key in `~/.workbuddy2dsh/config.json`. |
| `MISSING_CREDENTIAL` from every request | The route resolves `apiKeyEnv` but nothing is stored under it — the credentials seam was unavailable at startup. Set the variable in the environment, or reload so the plugin can store the key. |
| Models appear but every call fails | The account is expired or out of credits. The panel's **Accounts** view shows `disabled_reason`; the request log shows the upstream error. |
| Effort menu is missing for a model | The gateway advertised no reasoning tiers for it, so the plugin published none. Offering a level the model cannot use would be a lie in the UI. |
| Gateway keeps restarting | Read the `[gateway]` lines in DSH's log. A malformed `~/.workbuddy2dsh/config.json` fails fast and loudly. |
| `winapi error #5` / `access is denied` from the gateway | The binary cannot open its own data directory. On Windows this is an integrity-label mismatch: an executable created inside a low-integrity or sandboxed tree inherits a Low mandatory label, and a Low process cannot open a Medium-integrity file. Copy the binary somewhere outside that tree — an ordinary copy does not inherit the label — and set `binaryPath` to the copy. Relabelling with `icacls /setintegritylevel` is *not* a fix: it needs `SeRelabelPrivilege`, which an unelevated process lacks. The plugin detects this case and says so in its own log line. |

## Licensing and attribution

This repository is a **derivative work** and is distributed under the upstream **MIT**
licence, which is kept verbatim in [LICENSE](LICENSE) with both upstream copyright lines.
The gateway source is the upstream project, unmodified apart from an English translation of
its user-visible strings. The plugin code (`index.js`, `src/`, `package.json`,
`cordis.patch.yml`, `locale/`, `icon.svg`, `scripts/`) is original MIT work.

See [NOTICE](NOTICE) for the full attribution, the upstream usage declaration in English,
and the compliance notes for this integration.

> **Personal use only.** The upstream project is a self-use tool for managing *your own*
> account(s): automatic check-in, keep-alive, and an OpenAI-compatible entry point for your
> own local tools. Bulk account registration, offering a paid API, running a shared pool,
> or reselling quota is **expressly not supported and is prohibited**, and violates the
> target platform's terms of service. This project is not affiliated with or endorsed by
> Tencent, CodeBuddy, WorkBuddy, DeepSeek, or the upstream authors.

## Model Experience

Indirectly, through `dsh-llm-pi-ai`: this package contributes provider routes, not context.
It adds no system prompt, no tool schema, and no message content of its own. What it does
contribute is the catalog the adapter resolves — model ids, display names, context windows,
output caps, input modalities, and reasoning-effort levels — read from the gateway's
`GET /v1/models` and republished as an `llm-pi-ai` route. The adapter is what turns that
route into requests and into entries in the model picker.

#### KV Cache effect

Independent per route, and none of it is package-owned. A model reached through the gateway
is a separate model request from any other configured provider, so this package neither
appends to nor preserves a prompt prefix another provider established, and it replaces no
earlier request tokens. Whether a prefix is reusable is decided by the gateway's own
upstream and its cache behaviour, which this package does not observe or influence.

The one package-owned change that can invalidate reuse is a change to a published route
itself: a new `providerId`, `accountProviderId`, `port`, `binaryPath`, or `dataDir`
restarts the child and republishes at a different base URL, and a change in the gateway's
catalog changes the model ids. Each of those starts a new request identity, so any prefix
the previous route had made reusable is no longer reused. This is why the runtime treats a
connection change and a route-identity change as different work from a `refreshSeconds`
change, which only re-arms the timer and touches nothing the model sees. Moving a model
between lanes is deliberately **not** treated as a route change: the `model` string that
identifies a request stays the same, only which group in the picker it lives under.

## Known Limitations and Deferred Work

- **The gateway is a sidecar, not an adapter** — the plugin depends on the upstream binary
  being present and startable. If `bin/wb2api[.exe]` is missing and `binaryPath` is unset,
  the plugin logs a startup failure and the picker stays empty. There is no pure-Node
  fallback, and building one would mean reimplementing the protocol, the account pool, and
  the OAuth device flow.
- **`attachOnly` cannot verify the key it finds** — in attach mode the plugin reads
  `api_key` from a `config.json` it does not own. If that file is absent the plugin errors
  rather than inventing one, but a file whose key does not match the running gateway is only
  discovered as a `401` per request.
- **A shadowed credential reference is reported, not repaired** — when the launching
  environment exports `apiKeyEnv`, the credentials provider refuses to write over it. The
  plugin detects the mismatch and warns, but it cannot fix it; the user must unset the
  variable in the shell DSH was started from.
- **Restart backoff trips permanently** — after `maxConsecutiveCrashes` consecutive exits
  the plugin stops restarting and logs that it has given up. Recovery requires a plugin
  reload; there is no timed re-arm.
- **Reasoning levels are taken on trust** — `reasoningEfforts` is published from what the
  gateway advertises. A model that declares a tier its upstream rejects surfaces as a
  request error, not as a configuration error.
- **The lane split is a display decision, not a billing guarantee** — the split is read from
  the gateway's own promotion data at refresh time, but the gateway's `promo_factor` is a
  point-in-time advertisement, not a contract. A promotion that ends mid-session, or a
  model the gateway never priced at all, can move a model into the account lane only on the
  next refresh; nothing here meters requests or blocks a call. If you need certainty, watch
  the gateway panel's **Usage** view.
- **A model with no price data lands in the account lane** — `global:hy4-preview-f`,
  `global:default-model`, `global:enhance-1.0` and `global:o4-mini` publish no credits and
  no promotion factor in any endpoint the plugin can read. They are routed to the metered
  lane rather than guessed at, so an unpriced model never shows up as free.
- **`docs/upstream/` is vendored, not synchronised** — the upstream README is a point-in-time
  copy for attribution. It is not regenerated when upstream changes.
- **A restricted workspace can break a Windows build** — an executable created inside a
  low-integrity tree inherits a Low mandatory label and then cannot open a normal
  Medium-integrity config. The setup script keeps its caches inside the tree and carries a
  smoke test that catches this; a machine with no such restriction builds with plain
  `go build`. The full recipe, including the repair, is in [AGENTS.md](AGENTS.md).
- **The gateway is a sidecar, not an adapter** — the plugin depends on the upstream binary
  being present and startable. `scripts/build-gateway.mjs` handles that once; `attachOnly`
  borrows a gateway someone else owns. There is no pure-Node fallback, and building one
  would mean reimplementing the protocol, the account pool, and the OAuth device flow.
