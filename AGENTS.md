# AGENTS.md — working notes for `dsh-workbuddy2dsh`

Orientation for anyone (human or agent) changing this plugin. Read this before
touching `index.js` or `src/`; the constraints below are the ones that cost time
to rediscover.

## What this package is

A DeepSeek Harness **bundle** that runs the upstream gateway as a sidecar
and publishes its model catalog into DSH's `llm-pi-ai` provider settings. It is
a thin lifecycle wrapper: the gateway is a separate Go binary and none of its
behaviour is reimplemented here.

Not a fork of the gateway. `bin/wb2api.exe` is a build of
[`linguo2625469/workbuddy2api-panel`](https://github.com/linguo2625469/workbuddy2api-panel);
see `NOTICE` for the provenance and `docs/GATEWAY.md` for how it was built.

## Layout

| Path | Role |
|---|---|
| `index.js` | Cordis entry: `name` / `inject` / `Config` / `apply`, plus re-exports |
| `src/paths.js` | Where the binary, data dir, and panel live |
| `src/health.js` | Free-port probe, `/healthz` poll, `delay` |
| `src/gateway-config.js` | Owns exactly two fields of the gateway's `config.json` |
| `src/gateway-process.js` | Child spawn, log forwarding, restart backoff, teardown |
| `src/provider.js` | Translates the catalog and writes the two `llm-pi-ai` routes |
| `src/runtime.js` | Lifecycle: owns the child, the timer, and the published routes |
| `scripts/build-gateway.mjs` | Cross-platform setup: puts `bin/wb2api[.exe]` in place, then smoke-tests it |
| `test/*.test.js` | `node --test`; no framework, no fixtures on disk |
| `cordis.patch.yml` | The bundle patch that inserts the plugin row |

## Hard rules

**Never add `export default` to `index.js`.** A namespace plugin (`name` +
`apply`) that also has a default export makes the Loader discard the namespace;
the plugin then crashes the first time it is used. DSH post-mortem 0001.
`scripts/check-plugin.mjs` fails the build on this.

**Keep `inject = []`.** The gateway has to come up in a composition that
composes no settings service — its panel is where a user adds an account, and
that must work before anything else does. Injecting `settings` or `credentials`
would park the fiber (and with it the gateway) wherever DSH composes no
`profileContext`. The runtime resolves both seams lazily through
`ctx.inject([...])` behind a bounded race instead.

**Two lanes, one gateway, one `mutate`.** The catalog is published as two
provider profiles over the same `baseURL` and the same `apiKeyEnv`:
`providerId` for the models the gateway calls free, `accountProviderId` for
the rest. Rule for the split: `promo_factor === 0` is free, everything else
— **including anything the gateway prices nowhere** — is account. Never let
an unpriced model into the free lane; "I could not find a price" is not the
same as "this is free", and the free lane is the one a user trusts blindly.
`fetchModels` prefers the panel's `/panel/api/models` because `/v1/models`
omits `promo_factor` entirely and would collapse every promotion into its
list price; `parseCredits` on `credits: 'x0.00'` is the fallback for when the
panel is down. Write both routes in a single `settings.mutate`, or the picker
shows a half-published split. A lane left empty is *withdrawn*, not written
with `models: []`.

**The lane ids were renamed, and the old ones are still withdrawn.** The
defaults are `dsh-workbuddy2dsh-free` / `dsh-workbuddy2dsh-acc`.
`LEGACY_LANE_IDS` in `src/runtime.js` still names the previous pair so the first
refresh after an upgrade takes those routes out of the picker: nothing refreshes
a route once its id stops being published, so an inherited pair would sit there
for good offering a frozen model list against a live port. A config that
deliberately still names one of the old ids keeps it — the active set is
consulted first.

**The retry policy mirrors `dsh-opencode-router`, and a test pins it.** The
numbers are that plugin's free-lane policy verbatim (8 retries, 1 s → 20 s,
jitter 0.2), because the same upstreams sit behind both gateways. It has to be
written in the *declared* shape — `mode`, `maxRetries`, `retryableCodes`, with
the backoff nested under `backoff` — because the flat `maxRetries` /
`maxRetryDelayMs` spelling was removed from `llm-pi-ai` and is now a hard error.
Changing the numbers means changing both plugins deliberately.

**Never read a seam off the context unguarded.** `inject = []` has a
consequence that is easy to miss: Cordis's context proxy *throws* on
`ctx.credentials` — `cannot get property "credentials" without inject` — it does
not answer `undefined`. A service is on the context only once the fiber asked
for it. So a plain `ctx.credentials` on the line before `ctx.inject(...)` kills
the whole call, and because `refresh()` has a catch-all that logs a warning, the
failure is silent: no credential stored, no route published, no error anyone
would read. `readService()` exists for exactly this — it swallows the refusal so
control reaches `ctx.inject()`. The regression test that pins this down is
`cordisLikeCtx` in `test/runtime.test.js`; `fakeCtx` cannot catch it because it
exposes the services as ordinary properties.

**Ask for the two seams separately.** `settings` is the optional one: it ships
disabled wherever no `profileContext` exists. Resolving `credentials` and
`settings` on one child fiber makes the gateway key hostage to a service the
route merely needs — so each gets its own `ctx.inject()` and its own bounded
race, and a missing `settings` skips the route instead of the credential.

**The plugin owns only `listen` and `api_key` of the gateway's `config.json`.**
Everything else in that file is the user's. `ensureGatewayConfig` merges and
compares rather than overwriting, and refuses to touch a malformed file.

**The gateway API key is a published default, not a per-install secret.**
A fresh install gets `DEFAULT_API_KEY` (`sk-workbuddy2dsh`). The gateway's panel
demands a key before it renders anything, and a random one left every user — and
every agent setting the plugin up — hunting `config.json` for a value nobody had
told them. Resolution order is the `apiKey` setting, then an existing `api_key`
in the file, then the default: an install that already generated its own key
keeps it, so nothing is ever re-keyed behind a user's back. The resolved value is
logged once at startup together with where to change it. `apiKey` belongs in
`CONNECTION_FIELDS`, not `ROUTE_FIELDS` — the gateway reads the key when it
starts, so a change has to restart the child, not merely republish the routes.

**Never write into the plugin's own directory.** A package installed from npm
lives in a read-only tree. All state goes to `~/.workbuddy2dsh`.

**Publish the route, do not patch the profile by hand.** `src/provider.js`
writes through `ctx.settings.mutate('llm-pi-ai', …)`. That is the same seam the
Models page uses and the only one that reaches `llm-pi-ai`'s volatile route
table. Editing the profile's `cordis.patch.yml` directly would fight the
ConfigEditor for the same document.

**Do not call `credentials.set` on every refresh.** The local credentials
provider takes a document lock and rewrites `$DSH_HOME/.credentials.yaml` on
every call, unchanged value or not. `publishCredential` memoizes the pair it
last stored; only a store write is memoized, because a reference the launching
environment owns is never written and must be re-examined each cycle.

**Keep `src/provider.js` free of any dependency on `settings` internals.**
Field names there are read from `dsh-llm-pi-ai`'s own `Config` schema; if the
adapter's schema changes, this is the one file to update.

## Why the seam is `llm-pi-ai.providers` and not an adapter

`dsh-llm-pi-ai` declares `providers: z.dict(profile).default({}).volatile()`,
so a route is a live-editable setting. Writing one triggers this chain, with no
restart anywhere in it:

```
settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', id1], … },
                              { op: 'set', path: ['providers', id2], … }])
  → ConfigEditor persists into the profile patch
  → loader/volatile-update
  → llm-pi-ai's ensureRegistrationFacts()
  → ctx.llm.registerAdapter([…route ids], adapter)
```

Implementing an `LlmAdapter` would mean reimplementing request shaping, SSE
framing, tool-call mapping, image offloading, and retry policy that the adapter
already does. The gateway speaks OpenAI Chat Completions, which `openai-completions`
already covers.

## Verified against the shipped runtime

These were read from `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2` and
`@deepseek-ai/dsh-settings@0.2.0-rc.2`, not inferred from the docs:

- `MODALITIES` is `['text', 'image']`.
- `THINKING_LEVELS` is `['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']`.
- `PROTOCOLS` keys are `openai-completions` (first, therefore the default),
  `openai-responses`, `anthropic-messages`.
- A model entry is `{ id, name, contextWindow, maxTokens, input, reasoningEfforts, compat }`;
  `id` is required, the rest optional.
- A provider profile adds `apiKeyEnv` (`role('credential-ref')`), `displayName`,
  `api`, `baseURL`, `models`, `modelOverrides`, `defaultInput`,
  `defaultContextWindow`, `defaultMaxTokens`, `headers`, `reasoning`, `compat`,
  `transport`, `timeoutMs`, `retryPolicy` (a `RetryPolicySchema` from
  `@deepseek-ai/dsh-llm`, resolved by `resolveRetryPolicy`), and the image fields.
- `SettingsForms.mutate` refuses any path outside a volatile node, and an entry
  with no volatile fields at all. `providers` is volatile, so this works; a
  non-volatile sibling would throw `Config field "…" is not volatile`.
- `describe()` returns `{ autoGenerate, ns, schema, revision, applies, value, base, user }`
  keyed by profile entry id, and omits entries with no volatile fields.
- The adapter resolves `apiKeyEnv` per request through
  `ctx.credentials.resolve`, and raises `MISSING_CREDENTIAL` when it is unset.
- `credentials-local` rejects `set` when the launching environment supplies the
  reference, and `set` always rewrites the file.

`scripts/check-plugin.mjs` covers the static half; `npm test` covers the rest.

## Tests

```
npm test        # node --test over test/*.test.js
npm run check   # static contract check, no host required
```

`npm test` passes the four files explicitly: `node --test test/` is resolved as
a module path by the Node build in use, and a quoted glob makes the runner hang
before reporting.

The runtime tests use a stub HTTP gateway. It answers `Connection: close` and
destroys its sockets on close, because the global `fetch` pools keep-alive
sockets that would otherwise hold the test runner open after every assertion
had already passed.

Tests that touch a runtime **must** `dispose()` it. A failed readiness check
still arms the refresh loop, so a runtime that is not disposed leaves a pending
timer behind and the runner never exits.

## Rebuilding the gateway binary

`scripts/build-gateway.mjs` puts `bin/wb2api[.exe]` in place on **Windows,
Linux and macOS** with one command:

```bash
node scripts/build-gateway.mjs
```

It builds from `./cmd/server` when a Go toolchain is reachable (an explicit
`--go`, then a bundled `_tools/go`, then `go` on `PATH`) and downloads this
repository's verified prebuilt release asset for the current platform when none
is. It smoke-tests what it produces before leaving it in `bin/`, because a
binary that compiles but cannot read its own config is a broken plugin.

On a restricted machine the workspace at `C:\Users\mirel\.dsh` runs executables
with a restricted token, so a `go build` whose work directories live inside it
fails with `mkdir … winapi error #5`. The script therefore points `GOCACHE` and
`GOPATH` at `_tools/cache/` when it uses the bundled toolchain; if that is not
writable either, build with everything outside the workspace and point `-C` at
the source:

```bash
cd /c/tmp && GOROOT=C:/tmp/go GOTMPDIR=C:/tmp/gtmp GOCACHE=C:/tmp/gcache \
  GOPATH=C:/tmp/gopath GOFLAGS=-mod=mod /c/tmp/go/bin/go.exe build \
  -C "C:/Users/mirel/.dsh/plugins/dsh-workbuddy2dsh" \
  -trimpath -ldflags="-s -w" -o /c/tmp/out/wb2api.exe ./cmd/server
```

The upstream CI binary is built with Go 1.22 and panics on Windows with
`winmm.dll not found`; build locally instead of shipping that artifact.

## Windows integrity labels (this machine)

`C:\Users\mirel\.dsh` carries `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`, and
`Documents` does too. Every file created inside inherits the label, so
`bin/wb2api.exe` runs at **Low** integrity while `~/.workbuddy2dsh` is ordinary
Medium. A Low process cannot open a Medium file, so the gateway exits with
`winapi error #5` (`ERROR_ACCESS_DENIED`) on its own `config.json` — even though
the binary itself starts fine and prints its usage.

The label is put there by the agent sandbox that owns the workspace, so it is not
a property of DSH's own runtime; outside that sandbox the bundled binary is fine.
It matters here because the tests and the E2E script run inside it.

What works and what does not:

- **Works:** copy the binary anywhere outside the labelled tree. An ordinary copy
  does not inherit the label, and the copy runs normally.
- **Works:** `dataDir` inside the labelled tree, since both sides are then Low.
- **Does not work:** `icacls <file> /setintegritylevel Medium`. Setting an
  integrity label needs `SeRelabelPrivilege`, which an unelevated process does
  not have; the command reports `Access is denied`.
- **Does not work:** assuming the binary is at fault. It runs — its *child file
  access* is what is denied.

`describeAccessDenial` in `src/runtime.js` turns the child's `winapi error #5`
into an actionable message, and is unit-tested as a pure function. The same
`winapi error #5` appears from `go build` when its work directories are inside
the workspace, which is why the build recipe above puts every cache outside.

`scripts/e2e-gateway.mjs` fails on this machine when run with its default binary
path; pass `--binary <copy outside the tree>` to exercise the full path.

## Versioning

The plugin version and `dsh.compatibility.dshReleases` are separate facts. Add a
release to `dshReleases` only after running the plugin against it — the entry
means "verified", not "probably fine". Bump the patch version for a fix, minor
for a new setting, major for a change that breaks an existing profile's config.

## Attribution

Upstream is MIT. Keep `LICENSE` and `NOTICE` intact, keep the upstream
attribution in `README.md`, and do not add anything that bulk-registers accounts
or resells access — upstream prohibits both.
