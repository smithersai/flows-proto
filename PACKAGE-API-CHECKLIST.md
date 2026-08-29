# PACKAGE.ts API — e2e feature checklist (artsy/force)

Drive rule: one feature at a time; a feature is DONE only when its e2e proof
command runs against the force tree and behaves as specified. No fake
success: unimplemented execution fails with an explicit NotImplemented
error, never a green no-op.

Environments:
- READ/plan/query e2e: `/Users/williamcory/artsy/force` (live; another agent
  edits it — re-sync fixtures if load breaks).
- EXECUTE/mutating e2e: `/Users/williamcory/artsy-e2e/force` (git snapshot
  clone; node_modules symlinked to the live checkout; safe to write).
- Frozen spec fixture: `packages/build-cli/test/fixtures/force-spec/`
  (18 files, snapshot 2026-08-25).

Statuses: `[ ]` pending · `[c]` constructs (graph loads) · `[p]` plans
(correct edges/keys/refusals) · `[x]` executes e2e · `[b]` blocked (needs
creds/host bin — proof is the correct refusal).

## Phase W1 — core spine (routing)

- [x] S.Package: map-only labels, brand, freeze, helper exports legal, naked target export fatal — proof: `smthrs query '//...'` in force lists every label from the 14 Package maps (81 labels), nothing else (2026-08-25; a declared `S.file` map value wraps into a Filegroup so `//data:schema` labels one target)
- [x] Workspace at `.smithers/WORKSPACE.ts` (root fallback), one Workspace export, imports root Package + `.smithers/agents.ts` + `.smithers/sandbox.ts` — proof: workspace loads; gitHooks bind to the same target objects the index labels (PackageRouting.test.ts) (2026-08-25)
- [x] Ignore-blind filesystem discovery (prune `.git`, `node_modules`, cache) — proof: gitignored PACKAGE.ts fixture participates (PackageRouting.test.ts "ignore-blind discovery"); no-git temp workspaces load; discovery never invokes git (2026-08-25)
- [x] #229 direction 3: generated `KnownFile` literals narrow `S.file` under plain `tsc`; generated good and bad compile fixtures plus the ungenerated `string` fallback are covered by `KnownFile.test.ts` (2026-08-28)
- [x] PackageLoader: tsx-based, `.js`→`.ts` sibling specifiers, `@smthrs/targets` mapped to local package, one module instance per command — proof: single generated entry module per load; `src.relayArtifacts` identity shared across 4 importing packages (one label) (2026-08-25)
- [x] PackageIndex: path+key labels only, duplicate/two-label/cycle/case fatal, omission privacy, `no_default_target` — proof: fixture error suite (case_collision, target_multiple_labels, package_import_cycle with chain, legacy_target_export, module_not_regular symlink, no_default_target, unknown_agent, one-way WORKSPACE import) + force golden label list (2026-08-25)
- [c] Full S namespace constructs (every symbol below at least `[c]`) — proof: `smthrs graph '//...'` renders the complete force graph, 81 nodes / 94 classified edges (data/gates/services/deps); every implementation is `Target.notImplemented` and execution verbs refuse package mode loudly (2026-08-25)
- [x] CLI package-mode: `smthrs query|graph` auto-detect via WORKSPACE.ts — proof: runs from force cwd (and subdirectories, `:lint` relative form) with no flags; BUILD.ts mode unchanged (348/348 build-cli tests) (2026-08-25)
- [x] S.Fetch({url, sha256, out}) — constructs a data-legal `build` target; package mode resolves `out` against the declaring package, implies `sandbox: {network:true}`, downloads through Effect's Node HttpClient, verifies sha256 before an atomic file publish, and captures/restores the file through CAS — proof: live force `//data:schemaPinned --plan` has no refusal and declares the network sandbox; e2e force downloaded 866527 bytes, warm rerun hit, output digest `7f6027…72e0`; local HTTP fixture proves mismatch expected/actual with no write plus warm hit/deleted-file byte restore (`FetchTarget.test.ts`, 2026-08-27)
- [c] S.RemoteCache.make({endpoint, read, write}) — split read/write secrets alongside the BUILD-era `token` form (`token` and `read` are the same slot, exclusive); `write` is carried on the declaration — proof: live force WORKSPACE loads; `RemoteCache.test.ts` split-form cases (2026-08-26)
- [c] S.Cache({directory, remote}) — optional `remote` must be an `S.RemoteCache.make` declaration; inert data on the workspace, package-mode remote replication is not wired — proof: live force WORKSPACE loads; `FetchTarget.test.ts` reads `workspace.cache.remote` back (2026-08-26)

W1 e2e commands (run from `/Users/williamcory/artsy/force`):

```
node /Users/williamcory/flows/flows/packages/build-cli/src/main.js query '//...'
node /Users/williamcory/flows/flows/packages/build-cli/src/main.js graph '//...'
node /Users/williamcory/flows/flows/packages/build-cli/src/main.js query 'deps(//playwright:smoke)'
```

Test command: `pnpm -C packages/build-cli exec vitest run test/PackageRouting.test.ts test/PackageModeCli.test.ts --coverage.enabled=false` (27 passed) and `pnpm -C packages/targets exec vitest run test/PackageApi.test.ts --coverage.enabled=false` (17 passed).

Workspace decl constructors (parse+validate+store in W1): S.Workspace,
S.Cache, S.Runtime.Node({manifest|version}), S.PackageManager.Yarn({manifest,
lockfile,audit}), S.Npm.NodeModules, S.Flags (+S.Flags.<name> projection),
S.Host({bins}), S.Memory.SmithersCloud({bank,autoInject,init}),
S.Agents({...}), S.Agent.ClaudeCode, S.Agent.Codex, S.Agent.Pool,
S.Sandboxes({...}), S.Sandbox.Bubblewrap, S.Sandbox.Docker, gitHooks map.

## Phase W2 — execution core

- [x] Tool refs resolve: S.NodeModule.Bin, S.NodeModule, S.Host.bin (declared-or-fatal, PATH at run start), S.PackageManager.bin, S.Runtime.bin, S.Runtime.npx — proof: `smthrs '//src:lint'` spawns `<clone>/node_modules/.bin/biome` (visible in the failure argv); undeclared Host.bin = graph-load error `undeclared_host_bin`; declared-but-absent = typed run-start refusal (`//:detectSecretsRescan`); resolved paths, package versions, and `--version` probe output (once per command) are key material (2026-08-25)
- [x] S.Shell.Test bin+args — proof: `smthrs '//src:lint'` real biome run reporting the tree's true verdict (exit 1: 287 pre-existing biome errors in the snapshot, identical when biome is run by hand from root or src); `smthrs '//src:typeCheck'` real tsc, green (2026-08-25)
- [x] S.Shell.Run bin/command forms — proof: `smthrs '//src:cleanRelay'` (command form through `/bin/sh -c`, `$TMPDIR` expanded) and `smthrs '//workflows/beep:beep'` (afplay, sandbox "none", exit 0) (2026-08-25)
- [x] `bun:` + `using:` templates via the bun binary with injected tool paths — proof: `//:detectSecretsRescan` = correct typed Host.bin refusal `[b]` (detect-secrets absent); `//data:syncSchemaLocal` generates the program (`import { $ } from "bun"` + const per using entry + template), runs it, and fails with the template's own "metaphysics must be checked out beside force" text. Templates run from a generated file under `<cacheDir>/tmp`, not `bun -e` (imports need a module file) (2026-08-25)
- [x] env/secrets: narrowed env, secret names resolve at spawn only — proof: children spawn through the shared `Exec.run` bootstrap narrowing (PATH/HOME/TMPDIR/CI plus declared env, fixed locale/no-color); `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY smthrs '//:syncEnv'` fails typed before any spawn: "missing secret: environment variable AWS_ACCESS_KEY_ID is not set"; values never enter keys/logs/cache (names key via attrs) (2026-08-25)
- [x] Sandbox policy: default no-network, `{network:true}`, `"none"`; macOS sandbox-exec enforcement; declaration always keys — proof: fixture target fetching a local HTTP server fails under the default `(deny network*)` profile, succeeds under `{network:true}`, runs unwrapped under `"none"` (PackageExecution.test.ts, darwin-gated); `smthrs '//data:syncSchema' --write` real metaphysics fetch succeeds and updates data/schema.graphql in the clone; the three declarations key apart (injectivity test). Non-darwin logs "sandbox: unenforced on this platform" and never claims confinement (2026-08-25)
  - 2026-08-26: `sandbox: { network: "loopback" }` admits bind, accept, and connect on the loopback interface (127.0.0.1 and ::1) and nothing else; profile `(allow network-bind/inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))`. The services-consumer profile is the same one (it previously allowed outbound only, so a consumer that also listened failed). Keys apart from the other three declarations. Proof: PackageExecution.test.ts darwin case (node listener on both loopback addresses: default profile exit 1, loopback exit 0, `curl https://example.com` under loopback exit 1); tapes' ingest and extproc Go suites (httptest, `bind: operation not permitted` under the default profile) run green through the CLI under it (artsy/tapes/demo/loadable `//:contractSeals` 8.6s, `//:extprocGate`).
- [x] S.Shell.Diff + `changes` write-set (mechanical diff, out-of-set reverts+fails) — proof: adversarial fixtures: out-of-set write reverted+failed while in-set stays, out-of-set delete restored, write through a symlink judged by resolved location; `//src:formatProject` check reports drift then `--write` applies 16 files all inside the write-set; `//src:format` itself is red as declared (the repo `.prettierrc` pins `parser: "typescript"` globally, so `prettier --write src` chokes on markdown — true of the tool run by hand too) and a failed apply reverts every change it made (tree byte-identical after). Diff check mode runs against a scratch copy and never touches the real tree (2026-08-25)
- [x] S.Shell.Build + outDirs → CAS manifest capture, cache hit restores files — proof: `//src:relayArtifacts` real relay-compiler build captures src/__generated__ (1653 files) into `<cacheDir>/cas` + manifest in the cache; `rm -rf src/__generated__`; re-run = `hit`, tree restored, spot-checked byte-identical (shasum). Tampered blob = logged cache miss + re-execute, never a crash or partial tree (materialization is temp-dir + rename-swap) (2026-08-25)
- [x] S.Materialize — proof: `smthrs '//src:relay'` places artifacts (relayArtifacts hit → verified materialize → relay green) (2026-08-25)
- [x] data edge = materialize-before-dispatch; Run/Serve illegal in data — proof: `illegal_data_target` graph-load error fixture (Run reachable through data, transitively); `//src:typeCheck` schedules and settles relayArtifacts (run or verified hit) before tsc dispatches (2026-08-25)
- [p] gates edge — the mechanism lands: gates are scheduled before the consumer, keep-going within the gate set, and a red gate makes the consumer FAIL with the per-gate report attached (never a silent skip). The named proof (`//:preCommit` gating a commit dry-run) needs Git.Commit, which is lane E; "fresh re-check immediately before act" is same-invocation scheduling, not a second execution at consume time (2026-08-25)
- [x] S.Suite / S.Alias — proof: `//:preCommit` runs members keep-going and reports red with per-member statuses (`//:detectSecrets=failed` typed host-bin refusal, `//src:lint=failed`, `//src:typeCheck=ran` — this is CORRECT); `//:postMerge` alias delegates through `//src:relay` green (2026-08-25)
- [x] S.gitDiff({paths,added,addedLines}) — proof: `smthrs '//src:ssrLint' --plan` key changes with a staged edit in the clone (d0483d02… → 8fcd97a4…) and reverts with it; agent execution stays loudly refused. S.gitCommit keys as its inert ref record; resolving the ref to a sha is lane E (Memory.Retain refuses) (2026-08-25)
- [x] S.Generate script+changes / emit+S.symlink; check default, --write — proof: `//src:routesGen` check green (scratch-copy drift run), red after adding src/Apps/ZZDrive/ZZDriveRoutes.tsx ("drift … src/appRoutes.gen.ts"), `--write` regenerates appRoutes.gen.ts including ZZDrive (clone reset after); `//:claudeMd --write` emits the CLAUDE.md → AGENTS.md symlink, check green, red after `rm CLAUDE.md`. The Generate bin/stdout form keeps a loud NotImplemented refusal (2026-08-25)
  - 2026-08-26: the bin form executes through the same check/drift/write bracket (`S.Generate({ bin: S.Host.bin("sh"), args, changes })`: check green, hand edit red with the file named, `--write` repairs; PackageExecution.test.ts). The stdout form keeps its typed refusal (`NotImplemented: the Generate stdout form is not implemented`).
- [x] S.Clean({targets,paths}) — proof: `//src:clean` removes the declared build/relay outDirs and `.cache`, then refuses `node_modules/.cache/rspack` typed ("path leaves the workspace" — the clone's node_modules is a symlink out of the tree) and fails; nothing else touched; Clean's `targets` are key-only references, never executed (2026-08-25)
- [x] Cache: toolchain identity in keys; second `//src:typeCheck` run is a hit — proof: hit/miss log (run 1: 4 ran; run 2: `//src:typeCheck hit 0ms`, `//src:relayArtifacts hit` across processes); node_modules package version change re-keys (unit test); Shell.Run/Diff never cache, Shell.Test/Build/Generate-check do; check/write modes key apart; the current write-set/emit state keys Generate and Diff so a hand edit re-keys the check (2026-08-25)

W2 e2e commands (run from `/Users/williamcory/artsy-e2e/force`; CLI =
`node /Users/williamcory/flows/flows/packages/build-cli/src/main.js`):

```
smthrs '//src:lint'                       # bare label, flavor-implied verb; real biome (red: tree's own verdict)
smthrs '//src:typeCheck'                  # relay materialized first, real tsc; repeat = hit
smthrs '//src:cleanRelay'                 # command form
smthrs '//workflows/beep:beep'            # sandbox "none", afplay
smthrs '//:detectSecretsRescan'           # typed Host.bin refusal [b]
smthrs '//data:syncSchemaLocal'           # bun template, metaphysics-missing error text
smthrs '//src:relayArtifacts'             # Shell.Build + CAS; rm -rf src/__generated__ then re-run = hit restore
smthrs '//src:relay'                      # Materialize
smthrs '//src:routesGen' [--write]        # Generate script: check/drift/apply
smthrs '//:claudeMd' --write              # Generate emit symlink
smthrs '//src:formatProject' [--write]    # Diff write-set confinement (format itself red: repo prettier config)
smthrs '//:preCommit'                     # Suite keep-going + per-member statuses
smthrs '//data:syncSchema' --write        # sandbox {network:true} real fetch
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY smthrs '//:syncEnv'   # typed missing-secret refusal
smthrs '//src:deadCode'                   # knip with S.Flags.production resolved (--plan shows argv)
smthrs '//src:ssrLint' --plan             # gitDiff keying; execution refused (agents = later lane)
smthrs '//src:dev'                        # Shell.Serve typed refusal (services = later lane)
```

Test command: `pnpm -C packages/build-cli exec vitest run test/PackageExecution.test.ts --coverage.enabled=false` (20 passed) plus the full suites (build-cli 381/381, targets 600/600).

## Phase W3 — capability lanes

Lane A (services): Serve readiness {port|http,timeout} / health {interval,
failures} / stop {signal,grace}; services edge refcount+teardown
- [b] proof: `//src:dev` starts, /health readiness gates, SIGTERM stop; `//playwright:smoke` boots dev as service ([b] acceptable if app needs .env.shared) — 2026-08-25 e2e clone (cold .flows): `//playwright:smoke` hoists dev's data edges (`//src:srcs`, `//src:relayArtifacts`, `//data:schema`; relayArtifacts hit 2.0s), the supervisor spawns `//src:dev` (real `bun` template → `node -r @swc-node/register ./src/dev.ts`, process listened on :4000) and probes GET /health for the declared 90s; the snapshot app cannot answer — its compiled `dist/server/index.js` requires `@sentry/profiling-node`'s missing `sentry_cpu_profiler-darwin-arm64-137.node` — so the consumer failed with the typed `readiness-timeout` carrying that server tail, exit 1 in 92.0s, and teardown proven (0 `dev.ts`/bun processes, :4000 released). The same acquire/readiness/stop path is green on the fixture server in `test/LaneExecution.test.ts` (readiness-gated success, release on consumer failure, foreground Serve root stopped via the stop contract on interrupt).
- [x] mid-run health failure fails dependent (kill dev mid-test fixture) — proven on the fixture server: consumer wedges `/health`, `health {interval: "150ms", failures: 2}` fails the running consumer with `unhealthy` + "answered 500" + the server tail, and the consumer's own process is killed (`test/LaneExecution.test.ts`, 2026-08-25).

Lane B (resolver): S.ImportClosure per-file rows, S.Files.difference, S.Test({expect,toBe})
- [x] proof: `//src/Server:test` keyed on closure — edit unrelated app file = cache hit, edit imported file = miss — 2026-08-25 e2e clone (cold .flows): closure 3062 files / 91 packages / 1 unresolved (`src/Server/PACKAGE.ts` → `@smthrs/targets`, not installed in force) / 0 dynamic; cold run REALLY ran jest scoped to src/Server (`ran 6.4s`; hand-run of the identical argv under the identical sandbox-exec profile: 31 suites / 225 tests green in 5.2s); warm run `hit`; `src/Server/config.ts` (inside the closure) touched → `ran`; `src/Apps/Auction/__tests__/AuctionApp.jest.tsx` (outside; `src/Apps/Auction/index.tsx` does not exist in the snapshot) touched → `hit`. One intermediate miss was self-inflicted: reformatting PackageExec.ts between runs changed the implementation fingerprint, which is key material by design.
- [x] `//src:unreachableCode` end-to-end once importGraph lands — 2026-08-25: honest red, `1001 of 2982 file(s) in the left set are missing from the right set` (tests, stories, mocks, READMEs unreached by the bundler graph), leftover sample printed, exit 1 in 1.5s with importGraph replayed from cache (22ms). Closure operands fail closed on unresolved/dynamic rows (fixture proof in `test/LaneExecution.test.ts`).

Lane C (bundler): S.Bundler.Rspack({config}), .resolve({entries,universe}), .build({environment,mode,graph,outDirs})
- [x] proof: importGraph resolves force's client.tsx/server — 2026-08-25 e2e clone (cold .flows): `//src:importGraph` ran the real rspack resolve in 12.0s (relayArtifacts ran 2.1s first): 5148 modules / 3228 workspace files / 233 packages, graph digest `f4cf7e159f0ac9f2…` byte-identical to the lane's live-force measurement; warm run `hit` in 27ms.
- [ ] `//src:buildClientDev` real rspack build keyed on graph digest — not run on force (production-scale rspack build; deferred as heavy). The keying is proven through the CLI on the rsbuild-mini fixture (`test/LaneExecution.test.ts`): build keys on `bundler-graph:<digest>` at execution (key template + sentinel), warm run hits, a universe-only edit re-resolves the graph but replays the build, an in-graph edit re-runs it; outputs captured through the CAS path and restored on hit.

Lane D (agents): S.Agents registry, Agent.Lint (vacuous green, fixes write-set, --fix), Agent.Diff (payload/S.Input.*, S.Mcp.Http, gates loop, maxRounds), Agent.Pr shape, agent caching
- [x] clean-diff `//src:ssrLint` vacuously green with zero spawns — proof: e2e clone 2026-08-27, `smthrs '//src:ssrLint'` → `ran 15ms`, exit 0, no agent process spawned (lane dispatch landed in af840f0a4; scripted-fake proofs in `test/AgentLaneExecution.test.ts`, 7cab74f67)
- [ ] staged bad-SSR edit in the e2e clone triggers a real luna run and the cached verdict replays — real sessions proven on artsy/slop-computer `//:harden` (86410b987, 97fdc3fd9), not yet on force
- [p] `//workflows/fix-sentry-issue:fixSentryIssue` headless refusal; MCP unreachable = early fail — proof: plan sweep 2026-08-27 refuses typed at plan time (`approval required … package mode has no durable approval store`) before payload/MCP; payload-missing and MCP-unreachable refusals proven with the scripted fake in `AgentLaneExecution.test.ts`

Lane E (git/github/memory): S.Git.Commit (gates+agent message), gitHooks --write install, S.Github.Setup/Workflow/CiGen (+preserve, affected), S.Github.Pr, S.Memory.Retain / S.Memory.SmithersCloud
- [x] `Github.Workflow` `on.schedule` (five-field cron strings, rendered as `schedule: [{ cron }]`, `invalid_schedule` refusal otherwise) and `on.release` (GitHub's seven activity types, rendered as `release: { types }`) — 2026-08-26, GithubRender.test.ts; the nightly.yaml/release.yaml shapes tapes and aomi preserved by hand.
- [b] `//:commit` in the e2e clone — refuses typed before staging: gate `//:detectSecrets` needs host bin `detect-secrets-hook` (absent); declared/-m/agent message paths proven with the fake (7cab74f67)
- [p] `//.github:github` check reports drift correctly (2026-08-27: 4 generated files missing, `run-claude-review.yml`/`run-danger-yarn.yml` `unexpected` — correct, the spec preserves only the 3 files it names); `--write` render+preserve proven in `AgentLaneExecution.test.ts`
- [p] `//.github:pr` plans; refuses without token+approval at execution (fake-proven)
- [ ] Memory targets: `//:retainCommit` fails `smithers memory exited 4:` — `MemoryBackend` calls `smithers memory retain`, which smithers 0.34.0 lacks (only get/list/rm/set); fix in flight on lane api/defects (2026-08-27)

## Phase W4 — full sweep

- [x] Every force label plans — proof: 2026-08-27 `--plan` sweep over all 81 e2e-clone labels: zero NotImplemented; every refusal typed (host bins hokusai/detect-secrets/yalc, approval-required ×3, missing `--input name`). Regression found: `S.NodeModule.Bin("knip"|"storybook"|"danger")` refuses on multi-bin packages (since 43b11003d) — fix in flight on lane api/defects
- [x] Executes-green set on force: lint (tree verdict), typeCheck, test (jest), routesGen, relayArtifacts+relay, format, suites, claudeMd, beep, syncSchema, importGraph, server/app closure tests, deadCode (restored 2026-08-27 by the NodeModule.Bin fix), schemaPinned (S.Fetch executes 2026-08-27: 866,527 bytes, sha256 verified, second run hit); buildClientDev keying proven on the rsbuild fixture, the production-scale rspack build itself still deferred as heavy
- [x] Correct-refusal set ([b]) — 2026-08-27 plan sweep: syncEnv (missing secret at spawn), deleteReviewApp/ruleOfThree/fixSentryIssue (approval required, no durable approval store), hokusai/detect-secrets/detect-secrets-hook/yalc (declared host bins absent), addAppRoute (missing `--input name`); every refusal typed, zero NotImplemented
- [x] Review passes: each 2026-08-27 lane (defects, node, go, chain, gaps, fetch) ran a review node that re-ran its proofs and fixed findings (node: byte-for-byte fixtures; go: six defects found by a verbatim tapes fixture; gaps: cargo driver refusals, tar-blob module caches); merged tree suites green (build-cli 711 + 1 skipped, targets 735), tsc and dprint clean
- [x] Committed on the live line (detached HEAD off curate/vibe-append-2026-08-21): merges 2dc6fb40f (defects), ca0f5d20a (chain), 8fd4d4a13 (node), e4f7acd12 (go), 1c45d61a1 (fetch), 13d19f43e (gaps incl. aomi/cargo-targets). Cross-repo bar (2026-08-27): all eight ~/artsy design-partner repos load, graph with zero warnings, and plan with zero NotImplemented — force 82, whatsabi 47, viem 76, tapes 67, optimism 79, aomi 121, aomi-sdk 36, slop-computer 35 labels; sweep script `~/flows-api/goals/verify-repos.sh`

## Phase D — deck PR pipeline (twaldin/deck) feature requests

Source: porting Deck's `lindy-pr-pipeline` (a 5k-line smithers `pipeline.tsx`,
fork at `~/artsy/deck`, spec `workflows/pr-pipeline/FLOWS-PORT.md`) onto the
static-spine + trampoline-tail split. Rows are requests, not changes: the port
uses the nearest existing idiom and records the gap here with the file that
would consume it. Statuses as above. Append rows with evidence; do not edit
the API for these until will decides.

- [ ] D1 **Flow ↔ target bridge.** A `Flow` body cannot call a `PACKAGE.ts` target and a target cannot hand off to a flow, so `deck/ship` has to assume the operator ran `smthrs build //workflows/pr-pipeline:publish` and re-derives the PR by `gh`. Ask: an `Action`-shaped `Target.call(label, inputs)` node (planned as a data edge, executed through `PackageExec`) and/or a `S.Flow.Run` target — the "static plans + workflow recursion" seam from the 08-25 factory memo — consumer: `flows/ship/flow.ts`.
- [ ] D2 **`S.Github.Pr` attrs and execution.** Today: `{ gates, secrets, sandbox, approval }` and a typed `NotImplemented` refusal. Deck's publisher needs `base`, `head`, `title`, `body`, `draft`, `reviewers`/CODEOWNERS resolution, `stack` (parent-first `gh stack submit`), plus the derived-commit-set invariant (`BASE..HEAD` verified against ancestry before push). Consumer: `workflows/pr-pipeline/PACKAGE.ts` `publish`.
- [ ] D3 **GitHub merge + queue + reviewer targets.** No `S.Github.Merge` / `MergeQueue` / `RequestReviewers`; the port wraps `gh` in `Action.make` (tier irreversible, idempotencyKey = head sha). Consumer: `flows/actions/github.ts`.
- [ ] D4 **Agent.Lint severity as a gate.** `Finding` has no blocking-vs-nit level, so any finding fails the gate and Deck's "approved with nits" outcome cannot be expressed; SPEC step 2 exits on "no blocking findings". Ask: `severity` on findings and `gateOn: ["error"]` (or `blocking`) on `S.Agent.Lint`. Consumer: `adversary` gate.
- [ ] D5 **Profile-driven approval.** `approval` is the constant `"required"`; Deck's `yolo` vs `stamp` is a runtime predicate on the project profile. The tail handles it with `Node.branch`, but the spine cannot: `publishEscalated` is a second target instead of one target with `approval: S.Input.Boolean(...)`. Consumer: `PACKAGE.ts`.
- [ ] D6 **External-event wake for `WaitFor`.** Watch loops poll with `Sleep` because `@smthrs/triggers` (webhook → signal) is not in release 1. Ask: a GitHub `Channel` (check_run / pull_request_review / issue_comment) that resolves the named `WaitFor` so a round wakes on the event, not the timer. Consumer: `flows/rounds.ts` `Watch`.
- [ ] D7 **Approval request card.** `Flow.park` / `WaitFor` carry `{ reason, token, wakeAt }`; Deck's stamp gate renders title, summary, metadata (head sha, PR, cars), and an action set (`stamp | hold | deny-gate`). Ask: a typed request record on the park (HITL note's `ApprovalRequest`) so the plan card shows what is being consented to. Consumer: `Ready` stamp step.
- [ ] D8 **Run coordination primitive.** Deck claims "main is red" per `repo:base` in `.deck-coordination` files so two runs don't both fight the same red main. flows has run ownership but no cross-run named lease. Ask: a `DurableLease`/named mutex on the engine store. Consumer: `Watch` on `ci === "red"`.
- [ ] D9 **Sleep backoff policy.** Deck's watch uses a fixed poll; a bounded-backoff `Sleep` (`{ millis, backoff: { factor, max } }`) keyed per round would make long waits cheaper than a constant timer. Consumer: `Watch`, `QueuePoll`, `Landing`.
- [ ] D10 **Agent-diff output as a data edge.** The spine's `implement` produces a commit set that `publish` consumes, but a `S.Agent.Diff` has no declared output (`S.gitCommit()` is a reference, not a produced edge). Ask: `Agent.Diff` exposes `{ base, head }` as an output consumers can name. Consumer: `publish`.
- [ ] D11 **Host bins in `S.Workspace`.** `gh` and `git` are declared via `S.Host({ bins })` today; fine. Recording that `gh` needs `NO_COLOR`/`GH_PAGER=cat` in the sandbox env (Deck's `MACHINE_ENV`) or JSON parsing breaks under a TTY-detecting `gh`. Consumer: `flows/actions/github.ts`.
- [ ] D12 **N-way conditional over one planned subject.** `Node.branch` is binary; nesting by reusing the source node re-dispatches a nondeterministic Action, and nesting through `Node.succeed(planned)` yields planned-of-planned values. The port uses three small decision trampoline flows after one Watch poll. Ask: `Node.match` / ordered cases that evaluate one subject once. Consumer: `deck/workflows/pr-pipeline/flows/rounds.ts` `Watch*Decision`. Verified 2026-08-27 against `packages/plan/src/Node.ts` (only `branch`).
- [ ] D13 **Recursive flow declaration reference.** Mutually recursive `.to()` declarations cannot name a later declaration; the port uses a module-initialized registry map (the trampoline-test idiom) with two `as unknown as` casts. Ask: a lazy typed `Flow.ref(tag)` resolved at interpretation. Consumer: `flows/rounds.ts`, `flows/migration.ts`.
- [ ] D14 **AgentAction prompt resource.** Targets accept `S.file`, but `AgentAction.make` takes only a prompt string/function; the port reads markdown once at module init to keep bodies pure. Ask: a prompt-file/resource attribute on `AgentAction`. Consumer: `flows/actions/agents.ts`.
- [ ] D15 **Planned optional-object composition.** `PlannedPayload<T | undefined>` rejects an object whose fields are planned references, so the stamp helper needs one `unknown` bridge. Ask: distribute optional/null unions after planning object fields. Consumer: `flows/rounds.ts` `stamp`.
- [ ] D16 **Payload-derived Action idempotency key.** `Action.make` takes a static `IdempotencyKey` (string | JSON; `packages/flow/src/Action/Action.ts:47`), unlike `Flow.make`'s payload callback, so merge/rebase/push cannot key on `headSha`; the port uses stable per-action keys and checks the expected head inside the implementation. Ask: `idempotencyKey: (payload) => Json`. Consumer: `flows/actions/github.ts`, `flows/actions/git.ts`.
- [ ] D17 **Plan-time validation of target inputs.** `query` cannot evaluate operator payloads (profile, worktree, brief), so the static half uses a `briefLint` gate and the durable entry validates in a typed Action. Ask: strict target input refinements that refuse before execution. Consumer: `deck/workflows/pr-pipeline/PACKAGE.ts`, `flows/ship/flow.ts`.
- [ ] D18 **Transitive target graph rendering.** `graph //workflows/pr-pipeline:publish` shows only the selected target's direct gate; proving the chain needs a second call. Ask: a `--depth`/transitive option. Consumer: FLOWS-PORT.md proof.
- [ ] D19 **Test entrypoint declarations.** Importing `@smthrs/kernel/test/TestHost` makes `tsc` traverse an unrelated `BrowserJj.ts` source error; the port ships a test-only `.d.ts` shim. Ask: published declarations for the test entrypoint that do not expose sibling package source. Consumer: `flows/test/browser-jj-shim.d.ts`, `flows/tsconfig.json`.

Implementation receipt (2026-08-27): the port landed on `~/artsy/deck` branch `smithers-factory-poc` (commits `00492c2`..`0efa9fc` + review); proofs and the review table are in `workflows/pr-pipeline/FLOWS-PORT.md`. Rows D1–D11 were written before implementation; D12–D19 during it. Nothing in this repository was changed for them.

## Log

- 2026-08-26 local-app L1 (targets API): live force had drifted past the
  frozen fixture (`S.Fetch` in data/PACKAGE.ts; `S.RemoteCache.make({read,
  write})` and `S.Cache({remote})` in .smithers/WORKSPACE.ts), so `query`
  failed at module import ("S.Fetch is not a function"). Added the three
  surfaces (new `packages/targets/src/Fetch.ts`; RemoteCache/Cache extended
  compatibly). Live force: `query '//...' --format json` = 82 targets,
  `graph '//...'` = 82 nodes / 94 edges / 0 warnings, zero load-time
  refusals. The frozen force-spec fixture is unchanged (still 81 labels).
  Suites: targets 641/641, build-cli suite green (see lane report).
- 2026-08-25: checklist created; fixtures frozen (18 files); e2e clone built.
- 2026-08-25 slice 2 (resolver/bundler/services dispatch): `PackageExec`
  executes ImportClosure, Test, Bundler.Rspack.resolve/build, Shell.Serve
  (foreground root) and the `services` edge (per-invocation
  ServiceSupervisor inside the scheduler's scope; Serve targets are
  acquire-only, their data edges hoist onto the consumer; consumers get
  loopback-only network in the sandbox profile). Proofs above; suites:
  build-cli green incl. 10 new `LaneExecution` tests, targets 629/629.
  Known: `pnpm lint` in build-cli still reports the seven unused lane
  imports (AgentFake, AgentSession, GitCommit, GithubRender, MemoryBackend,
  GithubTarget, Deferred) that the agents/github/memory dispatch slice
  consumes.
- 2026-08-25 host probe: PRESENT bun, node, yarn, git, aws, kubectl, afplay,
  sandbox-exec, and every force node_modules bin (biome, tsc, jest,
  relay-compiler, prettier, knip, storybook, playwright, danger,
  patch-package). ABSENT: hokusai, detect-secrets, detect-secrets-hook,
  yalc — their targets prove as correct Host.bin refusals `[b]`.
- 2026-08-25: W1 workflow launched (run wf_5dd0b436-6ba): full S namespace
  construct-only + discovery/loader/index + query/graph e2e vs live force.
- 2026-08-25: W1 landed. New targets modules: Reference, Attr, Shell,
  Compose, AgentTarget, GitTarget, GithubTarget, MemoryTarget, BundlerTarget,
  WorkspaceDeclaration, Package; Input/Runtime/PackageManager extended;
  Smithers.ts exports the full S surface (S.Workspace replaces the
  Config.Workspace export; S.Clean replaced; BUILD-era Config.Workspace stays
  importable from `@smthrs/targets/Config`). New build-cli modules:
  PackageError, PackageDiscovery, PackageLoader, WorkspaceLoader,
  PackageIndex; Cli routes query/graph through the index in package mode and
  refuses execution verbs there with an explicit NotImplemented error.
  Live-force e2e: query/graph over `//...` list all 81 labels and 94
  classified edges from cwd force with no flags; deps() and relative labels
  work from subdirectories. Suites green: build-cli 349/349, targets
  597/597.
- 2026-08-25 adversarial-review fix wave (10 findings, all fixed):
  - P1 unknown attr keys: every Target.make constructor now validates with
    `onExcessProperty: "error"` — a typo'd `gate`/`approvals` rejects the
    declaration with file:line and the offending key instead of silently
    dropping the edge; nested structs (readiness) reject unknown keys too;
    Bundler.Rspack method options reject unknown names explicitly. One
    NodeTest test updated from asserts-stripping to asserts-rejection.
  - P1 case-mismatched PACKAGE imports: the static scan case-folds every
    resolved specifier against the discovered PACKAGE.ts set and fails
    `case_collision` before tsx can mint a second module instance; a
    belt-and-suspenders index-time guard rejects any reachable target whose
    metadata.sourceFile is a case variant of a discovered PACKAGE.ts.
  - P1 cwd outside workspace: PackageIndex.currentPackage is now optional;
    absolute `//...` patterns resolve from any cwd (query/graph with -w from
    anywhere works), only `:name`-relative labels require a current package
    and fail as PackageError `unknown_label` otherwise.
  - P1 masked author errors: the tsImport failure wrapper folds the cause's
    message into `module_import_failed` and no longer blames WORKSPACE.ts —
    a rejected declaration surfaces its PACKAGE.ts path:line:column plus the
    formatted schema issue at the CLI.
  - P2 comment/string false edges: the import scan is a token walk (skips
    comments, strings, templates, regex literals; a specifier counts only
    after a `from`/`import` token), so a commented specifier can no longer
    fabricate a cycle or one-way violation.
  - P2 helper-module blind spots: the scan now walks the transitive
    relative-import closure of every PACKAGE.ts — a cycle through a helper
    fails `package_import_cycle` with the full chain, a helper importing
    WORKSPACE.ts fails the one-way rule naming the helper, and the load
    digest covers helpers so an edit re-keys the per-process cache.
  - P2 edge kinds through nested privates: edges() threads the entry attr's
    classification down private chains (with a per-kind visited set), so a
    labeled leaf two privates deep keeps `data`/`gates`/`services`.
  - P2 install in package mode: `smthrs install` now refuses with the typed
    NotImplemented message like the other execution verbs.
  - P2 declared cache directory: openPackageIndex probes WORKSPACE.ts for
    `cache: S.Cache({directory})` before discovery, so a non-`.flows` cache
    tree is pruned and cannot mint phantom labels; --cache-dir still wins.
  Suites green after the wave: build-cli 361/361, targets 600/600, both
  `pnpm run check` clean; live-force query/graph/deps unchanged (81 labels,
  94 edges). Known baseline (pre-existing, untouched): build-cli eslint
  fails on committed `@slop` JSDoc tags and a `main.js` import resolution.
- 2026-08-25: W1 core spine proven. Independent e2e verification from live
  force cwd: query/graph `//...` emit exactly the 81 labels derived by hand
  from the 14 fixture Package maps (zero missing, zero extra); 94 classified
  edges; edge sanity confirmed (`//:preCommit` deps `//src:lint` +
  `//src:typeCheck`, `//playwright:smoke` services `//src:dev`, `//src:relay`
  deps `//src:relayArtifacts`, addAppRoute gates typeCheck/lint/routesGen);
  `build`/`run` verbs refuse with explicit NotImplemented, exit 1. Suites:
  routing 27/27, PackageApi 17/17, full build-cli 361/361, targets 600/600.
  Force tree untouched (all 17 declaration files byte-identical to frozen
  fixtures; dirty set pre-dates the run); flows HEAD unchanged (16cc97b91,
  no commits).
- 2026-08-25: W2 execution core landed. New build-cli modules: PackageExec
  (planning: tool resolution/probes, input expansion incl. filtered gitDiff,
  keys through the existing Planner.keyOf/encodeKeyMaterial encoder;
  execution: Executor.schedule reuse, Exec.run reuse, per-rule runOne) and
  PackageTree (PATH lookup + version probes, CAS blob store + manifests +
  atomic materialize, git-based write-set snapshot/diff/revert, scratch
  copies). Shell.Build/Test/Run/Diff and Generate script/bin bodies now plan
  the real shared exec node via the exported `Shell.execPayload` builder
  (sentinel argv tokens resolved by the executor at spawn); Serve keeps its
  typed refusal; Suite/Alias/Materialize/Clean/Generate-emit keep marker
  bodies — their semantics live in the package executor, a documented
  deviation from "replace all nine bodies" (a flow node has no meaning for
  them in W2's executor design and the marker stays loud). CLI: bare-label
  form (`smthrs '//src:lint'` via argv normalization into the `target`
  command) with flavor-implied verbs plus `--write`/`--fix`; verb-first
  build/test/lint/run execute in package mode; docs/ci/install keep the
  typed refusal. PackageIndex additions: undeclared Host.bin = graph-load
  error; Run/Serve reachable through data = `illegal_data_target` (one W1
  edge-classification fixture updated to a legal graph). Ruling notes:
  (1) all tools spawn from the workspace root — the observed declarations
  are written against it (relay.config.js paths, `//`-anchored scripts,
  shell text); a Diff tool whose args are all flags gets its write-set
  static prefixes appended (`prettier --write src`), which is what confines
  `format`-shaped targets without inventing per-tool knowledge. (2)
  package-mode keys deliberately omit Target.Metadata.implementationDigest:
  Node.functionIdentity carries per-process entropy by design, so it can
  never answer a cross-process hit; the ambient implementation fingerprint
  (every byte of build-cli/targets/deps sources) covers implementation
  drift instead — this is also why BUILD-mode cross-process caching is
  currently broken upstream of this wave (pre-existing; not fixed here).
  (3) a failed write-mode apply reverts every change the tool made, not
  only out-of-set ones. (4) resolved S.Flags values key (the name alone
  would miss a workspace redefinition). Known limits, recorded not hidden:
  write-set diffing sees what git status sees, so writes into gitignored
  paths are invisible to enforcement; secrets are checked at spawn, which
  in check mode is after the scratch copy; some force declarations assume
  invocation shapes later lanes must settle (jest `--config jest.config.js`
  and `publishAssets` root-relative script paths vs any non-root cwd).
  Suites green: build-cli 381/381 (20 new PackageExecution tests: write-set
  adversarial incl. symlink escape and out-of-set delete, CAS tamper→miss,
  hit/restore, toolchain-version and sandbox key injectivity, check/write
  key split, secrets refusal, darwin sandbox enforcement, suite
  aggregation, host-bin refusals, data-edge law, Generate emit/script),
  targets 600/600; dprint clean; eslint clean except the pre-existing
  committed `@slop` baseline. E2e clone left clean (git status empty;
  src/__generated__ restored from CAS; schema/appRoutes/format edits
  reverted).
- 2026-08-25: security + correctness hardening pass on the W2 executor
  (PackageExec/PackageTree), from a review of the untrusted-cache and
  write-confinement boundaries. Seven findings; five fixed with tests, two
  recorded to the degree the phase's design permits.
  - [fixed, P0] Cache-manifest path confinement. `decodeManifest` now
    refuses an `outDir`, entry path, or link target that is absolute or bears
    a `..` segment, and the Shell.Build cache-hit and Materialize paths bind
    the decoded manifests to the target's declared `outDirs` before any tree
    is written (`manifestsBindToDeclared`). A poisoned entry naming
    `outDir: "../victim"` (or a valid-but-undeclared outDir) can no longer
    rename-swap a directory the target does not own. `materializeManifest`
    additionally realpath-confines every destination inside the temp tree, so
    a symlink entry placed ahead of a file beneath it cannot be written
    through out of the outDir.
  - [fixed, P1] Mode-aware planning. The plan keyed nodes by label alone, so a
    Diff/Generate reached first as a check-mode gate/dep and then as a
    `--write` root reused the stale check node and applied nothing. The plan
    now computes each selected root's mode first (`PlanContext.rootModes`) and
    a root's mode wins over an incoming dependency mode; the label→node,
    scheduler, and report keys stay single-per-label. Cross-invocation mode
    views keep distinct keys (each invocation plans a label in one mode).
  - [fixed, P1] Gitignored out-of-set writes. Rather than run the full
    write-set snapshot with `--ignored` (which would hash and byte-stash the
    ~20 MB / 1858-file gitignored tree — build artifacts and the jj store —
    on every write-mode run), a separate content-free guard records ignored
    paths by name + `lstat` identity (`snapshotIgnored`/`changedIgnored`) and
    reverts by deletion any that a write-mode tool creates or overwrites out
    of set. `node_modules`, the cache, and `.git`/`.jj` are excluded.
  - [fixed, P2] CAS self-healing. `captureOutDir` re-verifies an existing
    blob's digest and rewrites it (temp+rename) when it does not match, so a
    rebuild after a tampered/corrupt blob heals the store instead of leaving
    it permanently un-hittable.
  - [fixed, P1/P2 partial] Writes through an escaping in-workspace symlink.
    A bounded portal guard (`snapshotPortals`/`revertChangedPortals`)
    measures the target contents of every in-workspace symlink — tracked or
    untracked — whose real target leaves the workspace (`node_modules`
    excluded; a target over 20 000 entries left unconfined with a logged
    line), and reverts any write that lands through one, in write mode and in
    the check-mode scratch run. This implements ruling 7's "a write through a
    symlink judged by its resolved location" for the symlinks git never
    surfaces.
  Recorded, not hidden (the residual of the two write-confinement findings):
  a write to an absolute path outside the workspace is not caught. Git-based
  write-set checking provably cannot observe it (verified: an absolute-path
  and a symlink-through write are both invisible to `git status`, even with
  `--ignored`), and OS-level write confinement is the mechanism ruling 6
  explicitly assigns to a later phase, not this one. A sandbox `file-write`
  deny would also break the real tool rows (TMPDIR resolves outside the
  workspace, so tools legitimately write there) and the accepted
  `node_modules/.cache` writes (`node_modules` is a symlink into the live
  checkout, whose cache writes the environment declares acceptable), which is
  the same path class as the absolute escape — so it cannot both permit the
  legitimate writes and block the escape. Writes through the `node_modules`
  symlink specifically stay accepted per the e2e environment note. Suites
  green after the pass: build-cli 393/393 (12 new: PackageTree unit
  confinement/heal ×8, mode-aware apply, gitignored revert, escaping-symlink
  write + check ×2), targets 600/600; build-cli tsc clean. E2e re-proof on
  the mutating clone: `//src:routesGen` check green in ~2.6 s (real tree
  untouched after), `--write` green in ~0.33 s with the ignored + portal
  guards active over the real `node_modules` symlink and 1858 gitignored
  entries and no false out-of-set; clone reset clean.
- 2026-08-25: W2 execution core proven. Independent re-verification from a
  cold cache (`.flows` deleted first) in the e2e clone: all 17 listed W2
  commands re-run and behave as specified — lint red matches a hand biome run
  (both exit 1; hand count today 298, drifted from the logged 287 via the
  live node_modules symlink), typeCheck green with relayArtifacts settled
  first then `hit` on rerun (11.4 s cold → 1.3 s), CAS restore of all 1653
  `src/__generated__` files verified byte-identical (full-tree shasum, not
  spot-check), tampered blob = logged miss + re-execute + blob healed
  (relay-compiler's own "artifactDirectory does not exist" refusal when the
  tree is empty is the tool's, not the harness's), routesGen
  check/drift/apply with ZZDrive, claudeMd emit/check/red, formatProject
  16-file apply all in-set, preCommit keep-going per-member report, syncSchema
  real fetch under {network:true}, syncEnv typed missing-secret refusal,
  deadCode with `--production` resolved from S.Flags, ssrLint gitDiff key
  changes/reverts with a tracked edit and execution stays refused, dev Serve
  refusal, clean removes outDirs/.cache then refuses the symlink-escaping
  path, postMerge alias delegates green. Fresh adversarial fixture
  (`//e2eprover:evil`): out-of-set write failed naming only the escaping path,
  reverted it, kept the in-set change. check/write keys differ
  (routesGen 64d29da6… vs 102b3a58…); Shell.Run and Shell.Diff plan
  `cacheable: false`; a red target re-runs rather than hitting (failures are
  not cached — the row 64 proof claims hits only for typeCheck/
  relayArtifacts). Suites: build-cli 394/394, targets 600/600. Live force
  untouched (18 declaration files byte-identical to force-spec, dirty set
  unchanged, zero non-node_modules mtimes younger than run start). Flows HEAD
  at 88d364f12: three sibling-lane commits (harness/std) landed after
  4bebca87f; none touch packages/build-cli, packages/targets, or this file,
  and the W2 work itself remains uncommitted.
- 2026-08-26 (Go readiness pass, from artsy/tapes): four additions landed with tests; suites green
  (targets PackageApi+Smithers 24/24, build-cli GithubRender+PackageExecution 54/54; full-suite counts in the
  commit). (1) `Attr.Sandbox` admits `{ network: "loopback" }` and the executor's loopback profile now
  allows bind/inbound as well as outbound on localhost. (2) `Github.Workflow` `on.schedule`/`on.release`.
  (3) Generate bin form executes. (4) `module_import_failed` appends the exported `S.` namespaces when
  the cause is a property read off `undefined` (a PACKAGE.ts naming `S.Go.*` before it ships now says which
  namespaces exist instead of a bare TypeError). The remaining Go gaps (toolchains workspace key, S.Go.*,
  S.Docker.*, S.Nix.*, S.Stamp, build target as tool edge, readiness exec probe) are listed with estimates
  in artsy/FLOWS-GO-READINESS.md.

- 2026-08-27 (Rust/Cargo readiness pass, from aomi-labs/aomi-sdk): the full-fidelity
  design-partner files load and execute. (1) `S.Workspace` takes a `toolchains` layer
  list; the runtime/packageManager/nodeModules trio is required only for a workspace
  that declares no layer, and the JavaScript path is unchanged. (2) `S.Rust.Toolchain`
  in both forms (`{ workspace, channel }` and `{ toolchain, lockfile }`); the declared
  channel reaches every cargo run as `RUSTUP_TOOLCHAIN`, so a host without the pin
  fails at the start of the run naming the channel. (3) `S.Cargo.Fetch/Build/Test/
  Clippy/Fmt/Doc` and the `S.Cargo.AppSet` crate set, keyed on the expanded set's
  manifests and their contents; `S.Files.difference` composes over crate sets.
  `Cargo.Fmt/Clippy/Test` keep their BUILD-era check constructors under the same names,
  told apart by the crate selector. (4) A build target as a tool edge
  (`S.Shell.Build({ bin: sdk.buildCli })`, `S.Generate({ bin })`), resolving to the one
  binary that build declares. (5) `S.Agent.Codex("luna")` (bare model name) and an
  agent declaration written inline on a lane's `agent` attr, for a repository with no
  `S.Agents` map. Proof, from `/Users/williamcory/aomi/aomi-sdk`: `query '//...'` lists
  40 labels with zero refusals; `graph '//:ci'` renders the Suite and its 11 edges;
  `lint '//sdk:format'` really runs `cargo fmt --all -- --check` green and hits the
  cache on the repeat; `build '//sdk:fetch'` delivers `Cargo.lock` and a 655M
  `.cargo-home` in 21.7s, after which `lint '//sdk:clippy'` runs
  `cargo clippy --workspace --lib --locked --offline -- -D warnings` green under the
  sandbox in 27.6s and hits on the repeat. `//apps:compile` plans 35 per-crate commands
  from the AppSet difference. The aomi (JavaScript) regression is unchanged at 121
  labels. Deferred, with reasons, in the same pass: `Cargo.Build`/`Cargo.Doc` are not
  cacheable (their product is a `target/` tree this lane does not capture into the
  store, so replaying the verdict would report a build the working tree may no longer
  hold; cargo's own incremental compilation is what makes the repeat cheap), the
  toolchain layer does not install a missing channel (it renders the argv and the CI
  setup step; a local host installs it with `rustup toolchain install <channel>`), and
  a crate-set target is one node running N cargo commands rather than N keyed nodes
  (per-crate node fan-out needs planner-level synthesis of labels that no Package map
  declares). Two `//:ci` members stay red against the live design-partner tree, both
  because the declaration says something the tree does not support, and neither is a
  loader refusal: `//ext:test` has two `aomi-ext` unit tests that call
  `https://blue-api.morpho.org/graphql` for real while the declaration opens no network
  (the fix is `sandbox: { network: true }` on that target, or `#[ignore]` on the two
  tests), and `//apps:{compile,clippy,test}` pass `--locked` against 35 crates excluded
  from the root workspace, so each is its own lockfile domain that `//sdk:fetch` — one
  fetch over one workspace manifest — never locked. `S.Cargo.Fetch` now takes a `crates`
  selector so that second one is a one-line declaration fix
  (`S.Cargo.Fetch({ crates, outDirs: ["//.cargo-home"], sandbox: { network: true } })`,
  named in the apps targets' `data`); proved in `CargoPlan.test.ts`, not applied, because
  the design-partner files are read-only here. Mid-pass the live design partner moved:
  aomi-sdk 5d2adbc..542c6d0 (2026-08-27 03:14-03:17) added five agent lanes and three
  guard scripts, and four of the new lanes name `S.Agents.luna`/`S.Agents.sol` while
  WORKSPACE.ts still declares no `agents` map, so every command against that revision
  refuses at index time with `unknown_agent`. The measurements above are the revision
  before it. On the new revision, with `agents: S.Agents({ default, luna, sol })` added
  to a read-only `git archive` copy and nothing else changed, `query '//...'` lists 48
  labels and `test '//:ci' --plan` reports zero refusals.
- 2026-08-27 (Rust/Cargo review pass, same design partner): the surface above re-verified
  against `aomi-labs/aomi-sdk` d135b86 and four defects fixed. (1) A macOS `cc` reached
  through `PATH` — the Xcode toolchain clang, not the `/usr/bin/cc` shim — takes its
  sysroot from `SDKROOT` and looks nowhere else, and `Exec.inheritedEnvironmentNames`
  withheld it, so every cargo target with a `-sys` dependency died on
  `fatal error: 'stdlib.h' file not found` three processes down. `SDKROOT` and
  `DEVELOPER_DIR` now inherit like `PATH` does. It went unseen in the first pass because
  that pass measured against the design partner's warm `target/`, where `aws-lc-sys` was
  already built; a clean tree fails every time. (2) A `Cargo.Fetch` dependency substituted
  the digest of its delivered files for its own key, which dropped the `CARGO_HOME` it
  delivers to: two workspaces differing only in the fetch's `outDirs` keyed their offline
  dependents identically, and a fetch declaring no `outFiles` contributed a constant. The
  substitute key now carries the resolved cargo home. (3) `S.Shell.Build({ bin: <target>,
  runtimeArgs })` dropped the runtime flags silently; a built binary is not a JavaScript
  runtime, so the declaration is refused instead of running a different argv. (4)
  `S.Cargo.Fetch` accepted `workspace` and `crates` together and silently locked only the
  first, and the planner refused a fetch that named neither even though the rendering
  handles it; naming both is now a declaration error and naming neither plans the bare
  `cargo fetch`. Proof, from a read-only `git archive` copy of d135b86 with the missing
  `agents` map added (see below): `query '//...'` lists 48 labels across 6 packages with
  zero refusals; `graph '//:ci'` renders the Suite and its 11 edges; `lint '//sdk:format'`
  runs `cargo fmt --all -- --check` green in 720ms and hits the cache on the repeat;
  `build '//sdk:fetch'` delivers an 89KB `Cargo.lock` and a 655M `.cargo-home` in 14.4s;
  `lint '//sdk:clippy'` then runs
  `cargo clippy --workspace --lib --locked --offline -- -D warnings` green under the
  sandbox against that fetch. The JavaScript regression was re-measured directly rather
  than recalled: the same `query '//...'` over `/Users/williamcory/aomi/aomi` at the branch
  base and at HEAD returns the identical 151-label set with zero refusals (the earlier
  "121 labels" line above predates the design partner's own growth and is superseded by
  this measurement, not by a behavior change). The live d135b86 revision still refuses at
  index time with `unknown_agent: S.Agents.luna names no declared workspace agent`: five
  agent lanes in `PACKAGE.ts` and `apps/PACKAGE.ts` name `S.Agents.luna`/`S.Agents.sol`
  while `WORKSPACE.ts` declares no `agents` map. That is the partner's declaration to fix
  — a reference to an undeclared agent has no correct resolution — and the one-line fix is
  `agents: S.Agents({ default, luna, sol })` in `WORKSPACE.ts`, or the inline
  `S.Agent.Codex("luna")` form on each lane. `//apps:*` was not exercised in this pass:
  the 35 excluded app crates are each their own lockfile domain and `//apps:fetch` was
  outside the time budget.
### Lane api/defects 2026-08-27

Three defects fixed test-first on branch `api/defects` (worktree
`/Users/williamcory/flows-api/defects`); commits `726a608f3` (D1),
`af8a368f8` (D2), `d70c3778f` + `ba81c3446` (D3). CLI for every proof:
`node /Users/williamcory/flows-api/defects/packages/build-cli/src/main.js`,
run from the artsy repo named in the row.

#### Symbols

| Symbol | Status | Proof command | Output tail |
| --- | --- | --- | --- |
| `S.NodeModule.Bin(pkg)` one-arg bin-map resolution | [x] | `'//src:deadCode' --plan`, `'//.storybook:storybook' --plan`, `'//.github:danger' --plan` in `~/artsy-e2e/force`, then `'//src:deadCode'` | plans: 0 `refusal` lines each (was `package "knip" exposes 2 binaries…`, `"storybook" … 3 binaries`, `"danger" … 9 binaries`); execute: `"//src:deadCode",Shell.Test,ran,3382.6ms` … `ok: true` (knip's own verdict, green) |
| `S.NodeModule.Bin(pkg)` still-ambiguous refusal | [p] | `pnpm -C packages/build-cli exec vitest run test/PackageExecution.test.ts -t "bin map"` | 5 passed: unscoped multi-map → package-name entry; scoped `@biomejs/biome` → `biome`; sole differently-named entry wins; multi-map without the package-name entry keeps `name one explicitly: S.NodeModule.Bin(package, bin)`; explicit second arg honored |
| `S.PackageManager.Pnpm({manifest,lockfile,version?,audit?,workspaces?})` | [x] | `pnpm -C packages/targets exec vitest run test/PackageApi.test.ts` + `pnpm -C packages/build-cli exec vitest run test/PackageExecution.test.ts -t "pnpm manifest"` | targets 21/21 (workspace form validates, BUILD-era `{version,runtime}` keeps working and keeps its runtime TypeError, Workspace accepts the declaration); fixture pnpm workspace loads, `--plan` has no refusal, `//:check  ran` |
| pnpm CI render / manager binary / lockfile digest | [x] | `pnpm -C packages/build-cli exec vitest run test/GithubRender.test.ts -t "workspace-era pnpm"` | 2 passed: `pnpm/action-setup@v4` with `version: "8"` when pinned (omitted otherwise — the manifest's `packageManager` field pins), `node-version: "26"` / `node-version-file: package.json` from the workspace runtime, `pnpm-store-${{ hashFiles('pnpm-lock.yaml') }}` from the declared lockfile, `pnpm install --frozen-lockfile`; `managerBinaryOf` returns `pnpm` for the tagged declaration and the plan digests the declared lockfile |
| `S.Memory.Retain` | [x] | `'//:retainCommit'` in `~/artsy-e2e/force` (after `smithers init` seeded the store), then `smithers memory list repo` | `"//:retainCommit",Memory.Retain,ran,1777.8ms`; list shows `commit:3c6f3063d14929cceb99fb61a9663c0014f81790 = {"source":"HEAD","commit":"3c6f3063…","tags":["commit"]}` in namespace `repo`. Without the store the same run is the readable typed failure `smithers memory set repo commit:3c6f3063… {…} exited 4: Error: No workflow found to resolve this workspace's store. Run smithers init…` (argv + stdout now in the text; stderr was empty) |
| `MemoryCapabilityMissing` typed refusal + help-fixture contract | [x] | `pnpm -C packages/build-cli exec vitest run test/MemoryBackend.test.ts` | 15/15: captured `smithers memory --help` fixture parses to `get, list, rm, set`; a test fails if retain's argv names an unshipped subcommand; `assertMemoryCliCommand("retain")` throws naming `retain` and the shipped set; nonzero exit message carries argv and falls back to stdout when stderr is empty |

#### Repos

| Repo | Load | Proof | Output tail |
| --- | --- | --- | --- |
| `~/artsy-e2e/force` | loads, targeted plans/executes above | D1/D3 rows | `//.github:github` unchanged (verified-correct): `run-claude-review.yml=unexpected, run-danger-yarn.yml=unexpected` still reported; clone reset clean after (`git status` empty; smithers-init artifacts and the retained fact removed) |
| `~/artsy/whatsabi` | still blocked, but not by pnpm | `query '//...'` | the `pnpm requires a declared runtime` failure is gone; new first error verbatim: `module_import_failed: evaluating the workspace's declaration modules failed: Generate declaration at /Users/williamcory/artsy/whatsabi/src/PACKAGE.ts:22:21 is invalid: Expected "file" \| undefined\n  at ["stdout"]` |
| `~/artsy/viem` | still blocked, but not by pnpm | `query '//...'` | new first error verbatim: `module_import_failed: evaluating the workspace's declaration modules failed: S.Git.Submodules is not a function` (another lane's namespace) |

#### Suites

- targets: `vitest run --coverage.enabled=false` 645/645; `tsc --noEmit` clean; `dprint check` clean.
- build-cli: `vitest run --coverage.enabled=false` 660 passed, 1 skipped (solo run; a run concurrent with the targets suite flaked 8 timing-sensitive service/agent tests that pass solo); `tsc --noEmit` clean; `dprint check` reports 2 pre-existing unformatted files (`test/SweepHarness.test.ts`, `test/fixtures/sweep-expectations.json`, committed in `43b11003d`, untouched here) — recorded, not new.

#### Spec conflicts found (recorded, not silently narrowed)

- `~/artsy/whatsabi/src/PACKAGE.ts:22` writes `stdout: "_generated-interfaces.ts"` (a filename), but `packages/targets/src/Compose.ts:139` types Generate's `stdout` as the literal `"file"` — PLAN §15.1's `{bin, args, data, stdout: "file"}` notation read as a literal. This is whatsabi's current first load error; fixing Generate's stdout attr is outside this lane's three defects.
- The defect brief cites smithers 0.34.0; the installed binary (`~/.nvm/versions/node/v24.18.0/bin/smithers`) is 0.33.0 with the identical `memory get|list|rm|set` surface.
- `smithers memory list` has no `--namespace` flag; the namespace is positional (`smithers memory list repo`), used as the brief's "or the equivalent".
- `S.Memory.SmithersCloud`'s `init`/`autoInject` have no CLI counterpart in 0.33.0 and do not gate a retain (init is the bank's initialization script, autoInject is agent-context injection); Retain treats them as inert declaration config, documented in `MemoryBackend.retain`'s docs. A memory operation that genuinely needs an unshipped subcommand refuses typed via `assertMemoryCliCommand`.
- This worktree has no root `CLAUDE.md`/`AGENTS.md` and no `reference/` dir; the corpus lives at `/Users/williamcory/flows/reference`. No new subsystem was designed: D1 extends the existing `binNameOf` manifest reader with npm/npx's own convention, D2 copies the sibling `YarnDeclaration` shape in the same module, D3 reuses `MemoryBackend`'s existing locator/cli seams plus `GitCommit.ts`'s git `execFile` helper for ref resolution.

#### Shared-file hunks (for the merge)

- `packages/build-cli/src/PackageExec.ts`: `binNameOf` (basename selection in a multi-entry map + doc), `managerBinaryOf` (explicit `PnpmPackageManager` tag branch), Memory.Retain dispatch (per-fact log line; catches `MemoryCapabilityMissing`).
- `packages/build-cli/src/GithubRender.ts`: `toolchainOf` (new `isPnpmDeclaration` branch).
- `packages/targets/src/WorkspaceDeclaration.ts`: `packageManager` union type ×2 + validator accept `PnpmDeclaration`.
- `packages/targets/src/PackageManager.ts`: `PnpmWorkspaceOptions`, overloaded `Pnpm`, `PnpmDeclaration`/`isPnpmDeclaration` (new exports; BUILD-era surface unchanged).
- `packages/build-cli/src/MemoryBackend.ts`: retain rewritten onto `memory set`; new exports `memoryCliCommands`, `parseMemoryHelpCommands`, `MemoryCapabilityMissing`, `assertMemoryCliCommand`, `RetainedFact`; `MemoryCommandFailed` signature now `(exitCode, {args, stdout, stderr})`; `RetainOptions.resolveSource` injection.
- Tests: `PackageExecution.test.ts` (+2 bin-map, +1 pnpm workspace), `GithubRender.test.ts` (+2), `PackageApi.test.ts` (+3), `MemoryBackend.test.ts` (resolved-backend describe rewritten to the real CLI, +help-fixture/capability/argv-text tests), `AgentLaneExecution.test.ts` (dispatch argv contract), new fixture `test/fixtures/smithers-memory-help.txt`.

#### Not done / out of scope

- whatsabi and viem still do not fully load; both blockers are recorded verbatim above and belong to the Generate-stdout ruling and the Git namespace lane.
- `smthrs install` in package mode keeps its typed NotImplemented refusal (the W2 surface rule); the "install names pnpm with the workspace runtime" proof lands through the CI render and the manager-binary/lockfile key path.
- The two pre-existing unformatted build-cli test files and the known eslint baseline (`@slop` tags, `main.js` resolution) are untouched.


### Lane api/chain 2026-08-27

Scope ruling: the 2026-08-27 02:35 brief delegates every `S.Rust.*` and
`S.Cargo.*` surface, including Nextest/Deny and build-target-as-tool planning,
to `aomi/cargo-targets`. This lane did not modify those APIs. The partner
worktree now has its Rust-specific `toolchains` hunk; this lane's deliberately
generic, additive hunk is called out below for merge reconciliation.

#### Owned symbol proof

| Symbol | Status | Exact proof command | Output tail |
| --- | --- | --- | --- |
| `S.Mise` | `[p]` | `node packages/build-cli/src/main.js '//:foundryBuild' --plan --workspace packages/build-cli/test/fixtures/chain-exec` | `Foundry.Build`; real Foundry argv; config and `mise.toml` digests/version pin are key material; no refusal |
| `S.Mise.bin` | `[b]` | `node packages/build-cli/src/main.js '//:miseTool' --plan --workspace packages/build-cli/test/fixtures/chain-exec` | `host binary "mise" is not present on PATH; S.Mise.bin("mockery") is pinned to 2.53.6 but cannot execute on this host` |
| `S.Foundry` | `[p]` | same `//:foundryBuild --plan` command | `rule: Foundry.Build`, `cacheable: true`, `argv: /Users/williamcory/.foundry/bin/forge,build,--config-path,foundry.toml` |
| `S.Foundry.Toolchain` | `[p]` | `pnpm -C packages/targets exec vitest run test/ChainTargets.test.ts --coverage=false` | `8 passed`; workspace layer carries `foundry.toml` and the `S.Mise` authority |
| `S.Foundry.Build` | `[x]` | `pnpm -C packages/build-cli exec vitest run test/ChainExecution.test.ts --coverage=false` | real forge build plus nested-package relative config; OCI-independent CAS restore: `8 passed`; cold `ran`, second run `hit` and restored `out/` |
| `S.Foundry.Test` | `[x]` | same `ChainExecution.test.ts` command | real `forge test`: cold `ran`, second run `hit` |
| `S.Foundry.Fmt` | `[x]` | same `ChainExecution.test.ts` command | formatted tree green; deliberately malformed Solidity returns exit 1 with `Diff in src/Counter.sol` |
| `S.Anvil.Fork` | `[x]` | same `ChainExecution.test.ts` command | real local Anvil fork acquired, RPC readiness passed, consumer green, fork released; `latest` consumer plan says `cacheable: false` |
| `S.Docker` | `[p]` | fixture plan sweep command below | Build/Bake/Serve/Service/Push all plan with zero `NotImplemented` |
| `S.Docker.Serve` | `[x]` | `pnpm -C packages/build-cli exec vitest run test/ChainExecution.test.ts --coverage=false` | Alpine service: `service //:dockerService: ready`; exec probe and post-readiness init pass; container absent after release |
| `S.Docker.Service` | `[x]` | same `ChainExecution.test.ts` command | alias-shaped service: `service //:dockerServiceAlias: ready`; container absent after release |
| `S.Docker.Build` | `[x]` | same `ChainExecution.test.ts` command | real buildx OCI exporter writes `docker-image/image.tar`; cold `ran`, deleted output restored on `hit` |
| `S.Docker.Bake` | `[x]` | same `ChainExecution.test.ts` command | declared bake file/target writes `docker-image-fixture/image.tar`; second run `hit` |
| `S.Docker.Push` | `[b]` | `node packages/build-cli/src/main.js '//:dockerPush' --workspace packages/build-cli/test/fixtures/chain-exec` | exit 1: `approval required ... refuses before any effect`; uncached and image dependency is not run before approval |

Constructor validation is covered by `ChainTargets.test.ts`: every constructor
constructs its observed attrs, rejects excess keys, rejects empty exec probes,
and preserves `Secret(..., { fallback })` without reading the environment.
`ServiceSupervisor.test.ts` covers direct exec readiness, sequential init, and
the init failure path.

#### Repository proof

| Repo | Load / graph / plan sweep | Execute set | Refusal set |
| --- | --- | --- | --- |
| `~/artsy/viem` | `[b]` `cd ~/artsy/viem && node <lane>/packages/build-cli/src/main.js query '//...' --format json` stops before package discovery: `pnpm requires a declared runtime, for example Runtime.Node({ version: ">=22.19.0" })`. This is the api/node/defects boundary; `WORKSPACE.ts:9,15-19` does declare the runtime and pnpm. | `[x]` the fixture runs viem's owned shapes: package-relative `S.file("foundry.toml")` through real forge, and local Anvil fork/readiness/release. | `[b]` `AnvilExec.serviceSpec` with no environment value/fallback: `missing secret: environment variable CHAIN_TEST_RPC_ABSENT is not set for Anvil.Fork //:fork`. |
| `~/artsy/optimism` | `[b]` same query command stops at `WORKSPACE.ts:17`: `Cannot read properties of undefined (reading 'Toolchain')` for delegated `S.Go.Toolchain`; the exported-namespace tail includes `Docker`, `Foundry`, and `Mise`. | `[x]` fixture real forge build/test/fmt and real Docker bake cover this lane's declarations; plan binds Foundry to the declared mise/config authorities. | `[b]` `S.Mise.bin` correctly refuses because mise is absent while reporting the config pin. |
| `~/artsy/tapes` | `[b]` same query command stops at `.smithers/module.ts:21`: `Cannot read properties of undefined (reading 'ModDownload')`; delegated to api/go before any full-repo graph/sweep can exist. Fixture sweep: `query=11 targets`; `graph=11 nodes, 6 edges, 0 warnings`; all 11 plans have zero `NotImplemented`, one approval refusal, and one typed host refusal. | `[x]` real Docker Build and scoped Serve/Service execute on fixtures. The exact Postgres declaration at `pkg/storage/postgres/PACKAGE.ts:24-30` constructs in unit coverage; its image pull was attempted with `docker pull public.ecr.aws/g4e5l3z3/papercomputeco/postgres:17.7-pgduckdb-1.1.1`. | `[b]` ECR returned `toomanyrequests: Rate exceeded`, so the exact pgduckdb Postgres process could not reach `pg_isready` on this host/run. Push refuses before credentials/effects via its required approval. |
| `~/artsy/aomi-sdk` | Delegated: query still stops at `sdk/PACKAGE.ts:7`, `S.Cargo.Fetch is not a function`. Per the scope change, no Cargo load/graph/sweep work was performed here. | Delegated to `aomi/cargo-targets`: Fetch/Build/Test/Clippy/Fmt/Doc/AppSet and the requested clone execution/cache proof. | Delegated: Nextest/Deny and Cargo host-subcommand refusals. |

Fixture sweep command:

`node packages/build-cli/src/main.js query '//...' --workspace packages/build-cli/test/fixtures/chain-exec --format json`, then the same CLI `graph '//...'`, then each returned label with `--plan`.

Suite tails after implementation:

- `pnpm -C packages/targets exec vitest run --coverage=false`: `34 passed`, `650 passed`.
- `pnpm -C packages/build-cli exec vitest run --coverage=false`: `38 passed`, `659 passed`, `1 skipped`.
- `pnpm -C packages/build-cli exec vitest run test/ChainExecution.test.ts --coverage=false`: `1 passed`, `8 passed` after the package-relative config regression was added.
- `pnpm -C packages/build-cli exec vitest run test/ChainExecution.test.ts test/ServiceSupervisor.test.ts --coverage=false`: `2 passed`, `27 passed`.
- Both packages' production and test `tsc --noEmit` configs pass. A targeted dprint check over every changed/new source and fixture passes. The full build-cli dprint scan still reports only the untouched baseline files `test/SweepHarness.test.ts` and `test/fixtures/sweep-expectations.json`; they were not reformatted in this lane.

#### Host and spec conflicts

- `mise` is absent. `.mise.toml` / `mise.toml` `[tools]` entries and the
  declared config digest remain the version authority, and execution refuses
  rather than falling back to an unpinned binary.
- PATH's first `forge` is `/Users/williamcory/.local/bin/forge` (`forge
  1.31.2`), not Foundry. The planner probes every PATH candidate and selects
  `/Users/williamcory/.foundry/bin/forge` only after its output starts with
  `forge Version:` (1.5.1-stable). Anvil is 1.5.1-stable.
- Docker CLI and daemon both answer at 29.4.0. The default Docker driver does
  not support the OCI exporter; the planner therefore selects the available
  running `docker-container` builder (`smithers-e2e-builder`). Docker daemon
  access on macOS uses the existing explicit `sandbox: "none"` escape because
  `sandbox-exec` cannot reach the daemon Unix socket.
- `viem/test/PACKAGE.ts:23-55` requires an RPC secret fallback. `Secret`'s
  prior implementation ignored the observed second argument, so the
  constructor was extended strictly with a public `fallback`; resolution is
  deferred until service spawn and secret values do not enter keys or logs.
- `tapes/pkg/storage/postgres/PACKAGE.ts:28` introduced the new
  `readiness: { exec, timeout }` union member. It runs through
  `ServiceSupervisor`, as do init and cleanup; no constructor spawns.
- There is no `reference/` directory in this worktree, so no reference-corpus
  implementation could be read. The closest shipped prior art followed was
  `Shell.ts`/`execPayload`, `Target.make`, `Reference.ts`,
  `WorkspaceDeclaration.ts`, `PackageExec.ts`/`PackageTree.ts` CAS capture,
  and `ServiceSupervisor.ts` scoped acquisition/refcount/finalization.

#### Shared-file hunks for merge

- `packages/targets/src/WorkspaceDeclaration.ts` (`WorkspaceDeclaration`,
  `WorkspaceOptions`, `knownOptions`, `Workspace`): made the Node triple
  optional but all-or-none; added `toolchains?: non-empty readonly array`;
  requires either the Node triple or toolchains; freezes the stored list. The
  sibling Cargo worktree now types this list specifically to Rust layers, so
  the merged definition must use the union of all lane toolchain declarations
  (Mise, Foundry, Go, Rust) rather than either lane's temporary local type.
- `packages/targets/src/Smithers.ts`: four additive exports (`Mise`,
  `Foundry`, `Anvil`, `Docker`).
- `packages/targets/src/Reference.ts`: additive `MiseBin` schema/constructor
  and `Tool` union member. `Attr.ts`: additive exec-readiness union member.
  `Secret.ts`: strict optional public fallback.
- `packages/build-cli/src/PackageExec.ts`: additive resolution/planning,
  cache/output, service, and execution dispatch; Node manager/lockfile reads
  tolerate toolchains-only workspaces. `PackageIndex.ts` adds service/push to
  the illegal-data rule set. `GithubRender.ts` gives toolchains-only
  workspaces an explicit delegated renderer refusal instead of a type crash.
- `packages/build-cli/src/PackageTree.ts`: all-PATH lookup and bounded generic
  command probe. `ServiceSupervisor.ts`: exec readiness, post-readiness init,
  and best-effort final cleanup.

#### Aomi Rust notes answers and remaining work

For `SMITHERS-RUST-NOTES.md:274-290`: (1) yes, Workspace grows a real
`toolchains` list; no fake JS runtime. (2) Cargo Fetch/vendor semantics are
delegated to `aomi/cargo-targets`. (3) build targets as tool edges are
delegated there. (4) Cargo AppSet algebra is delegated there. (5) Cargo
feature/profile convergence is delegated there. (6) Agent.Pr secrets/sandbox
is outside api/chain and was not changed.

Not done here: full viem/optimism/tapes loads and sweeps remain blocked by the
exact cross-lane errors above; aomi-sdk and every Rust/Cargo symbol/proof are
explicitly delegated; the tapes pgduckdb image could not be executed after
the upstream registry rate-limited the pull. No `~/artsy` file was edited.

Review addendum (2026-08-27, second pass): the implementation above was
re-reviewed against the goal. One defect class was found and fixed: the
lane's new modules and exports violated the repo's eslint JSDoc rules
(missing module headers, missing `@since`/`@category` tags, unnecessary
type assertions on the target constructors, a value import of the unused
`@smthrs/targets/Foundry` in `PackageExec.ts`, and two
`no-useless-escape` quotes in `DockerExec.ts`). All are corrected;
`eslint src --max-warnings=0` is clean for `packages/targets` and reports
only the known baseline (`@slop` tags, `main.js` import resolution,
`effect-resolution.d.ts`) for `packages/build-cli`. Re-verified after the
fixes: both packages' `tsc -b tsconfig.json` + `tsc -p tsconfig.test.json
--noEmit`, targets vitest 650/650, build-cli vitest 659 passed + 1
skipped, targets dprint clean, build-cli dprint shows only the two known
baseline files, and the chain-exec fixture sweep still plans 11 targets
with zero `NotImplemented` and the same two typed refusals.


### Lane `api/node` — whatsabi + viem (2026-08-27)

Implemented the Node/npm package-mode surface from the verbatim Artsy declarations. The graph now has only the ruled
edge kinds (`data`, `gates`, `services`); source globs exclude `PACKAGE.ts`/`WORKSPACE.ts` build declarations unless an
author names one explicitly. Computational file outputs use the existing CAS, including single-file capture/restore.
Outward rules are never cacheable and fail before effects on an undeclared/missing credential or unsatisfied approval.

| Symbol | Status | Proof / honest boundary |
| --- | --- | --- |
| `Npm.Pack` | `[x]` | whatsabi tarball created; stable rerun hit; moved tarball restored byte-for-byte from CAS |
| `Npm.Publish` | `[b]` | typed `NPM_TOKEN` refusal, then approval refusal when a token is present; no package-mode approval store |
| `Npm.Published` | `[x]` | fetched whatsabi registry baseline with pinned `pacote@21.0.0`; rerun hit and restored declared output |
| `Npm.Downstream` | `[p][b]` | verbatim viem fixture loads/plans; isolated remote checkout/override runner is not present |
| `Changesets.Version` | `[x]` | check drift, write, post-write green, cache and write-set confinement fixture |
| `Changesets.Publish` | `[b]` | typed secret/approval outward gate; no effect performed |
| `Github.Ci` | `[x]` | lowers to the same `Github.CiGen` object; root-package `.github/workflows/**` drift/write/clean cycle proven |
| `Github.Release` | `[b]` | typed missing `GITHUB_TOKEN`; approval-required path remains effect-free |
| `Github.Pages` | `[b]` | site gate ran, then typed missing `GITHUB_TOKEN` refusal |
| `Git.Pr` | `[b]` | gate-first execution and typed missing `GITHUB_TOKEN` refusal; no PR created |
| `Git.Submodules` | `[p][b]` | strict constructor and verbatim viem graph proof; viem execution is blocked earlier by chain tooling |
| `Git.Submodule` | `[p][b]` | strict shared optimism constructor; no owned repo reaches it before the chain-lane boundary |
| `Cron` | `[x]` | package-level inert execution plus generated `on.schedule` workflow and confined write proof |
| `Copy` | `[x]` | real whatsabi build copies and fixture green/cache/CAS restore |
| `Literal` | `[x]` | fixture green/cache/CAS restore |
| `Overlay` | `[p][b]` | verbatim viem fixture loads/plans; consumer-scoped virtual source mount is unavailable |
| `Markdown.CodeBlocks` | `[x]` | alias-aware (`ts`/`typescript`, `js`/`javascript`) semantic `tsc` runner; fixture green/hit and whatsabi honest syntax-red |
| `Api.Compat` | `[x]` | real published/current whatsabi declaration comparison green, then cache hit |
| `Size.Budgets` | `[x]` | fixture tool green then cache hit |
| `Files.digest` | `[x]` | CLI fixture green/hit and changed-baseline red; target outputs are digested deterministically |

whatsabi proof used `/Users/williamcory/artsy-e2e/whatsabi` with a frozen clone, dependency install, and only the live
`PACKAGE.ts` declaration copied in. Live `/Users/williamcory/artsy/whatsabi` was read-only.

| whatsabi target set | Status |
| --- | --- |
| query + graph `//...` | `[x]` 47 public labels, 47 graph nodes, 102 edges, zero warnings; edge kinds only `data`/`gates` |
| full plan sweep | `[x]` 54 public/private nodes; zero `NotImplemented`; only typed payload/tool/secret/approval refusals |
| `build`, `buildCjs`, `buildEsm`, `buildTypes`, `buildDocs`, `typeCheck` | `[x]` green; build outputs also hit CAS |
| `pack` | `[x]` green, hit, and missing tarball restored from CAS |
| `apiCompat`, `audit`, `checkSize`, `deadCode`, `src:generated`, `githubCi`, `refreshFixtures`, `clean` | `[x]` green; CI drift/write/clean and Generate check brackets exercised |
| `checkReadme` | `[b]` executor works and reports five fences; upstream README currently has real TS syntax errors (blocks 2–4) |
| `recordFixtures`, `test`, provider matrix | `[b]` typed missing `INFURA_API_KEY`; no fake green |
| `publish`, `release`, `deployDocs`, `pr` | `[b]` typed missing credential and/or approval/gate refusal; no outward effect |
| `ci`, `preCommit`, `prePush`, `prePublish` | `[b]` aggregate the preceding real red/blocked members |
| `serveDocs`, `watch` | `[b]` valid long-lived service declarations; not held open during the finite proof run |
| `commit`, workflow agents, examples | `[p][b]` load/plan; commit/PR/payload actions were not invoked, and examples are not release gates |

Viem live loading gets past every Node-owned symbol. Its exact new first boundary is
`/Users/williamcory/artsy/viem/contracts/PACKAGE.ts:22:29`, `S.Foundry.Build`, owned by lane `api/chain`. A test fixture
copies `WORKSPACE.ts`, `smithers.d.ts`, and the owned node-only `PACKAGE.ts` files byte-for-byte; query and graph pass,
exercise the Node constructors, report no warnings, and contain no fourth edge kind.

Tests: targets full suite 663/663; build-cli full suite 658 passed, 1 skipped; Node lane constructor matrix 21/21;
Node CLI lane 5/5; viem verbatim fixture 2/2; resolver declaration-glob regression 39/39. Both target and build-cli
TypeScript checks pass; targets lint/dprint passes; every changed build-cli source passes eslint+dprint. The pre-existing
full build-cli lint baseline still fails in untouched files on committed `@slop` JSDoc tags plus `main.js` import
resolution. The requested `reference/bazel` and `reference/opencode` shelves are absent from this worktree.

Merge note: `PackageManager.ts` contains the same tiny Pnpm workspace-declaration compatibility hunk expected from
lane `api/defects` (`{manifest, lockfile, version?, workspaces?, audit?}`; runtime comes from `Workspace`). Deduplicate
that overlap when lanes merge.

Review pass (2026-08-27, same lane branch): re-ran every headline proof and fixed three findings. (1) The viem fixture
copies had been dprint-reformatted despite the byte-for-byte claim; they are now literal copies of the `~/artsy/viem`
files and `packages/build-cli/dprint.json` excludes `test/fixtures/viem-node-spec` (the `force-spec` precedent) so the
format gate accepts them. (2) Removed a dead `if (cwd === ".") cwd = "."` no-op in the `Npm.Pack` planner.
(3) Repaired the pre-existing dprint failures in `test/SweepHarness.test.ts` and
`test/fixtures/sweep-expectations.json` (untouched by this lane; format-only). Re-verified after the fixes: targets
663/663, build-cli 658 passed + 1 skipped, both `tsc --noEmit` checks, dprint clean in both packages, whatsabi
query/graph warning-free with only `data`/`gates` edges, a fresh 47-label plan sweep with zero `NotImplemented`,
plan-time typed refusals for `publish`/`release`/`deployDocs`, `pack` green with cache hit and restored tarball,
`apiCompat` green over a cache-hit published baseline, `checkReadme` honestly red on the upstream README fences, and
`testViem` refused with typed missing `INFURA_API_KEY`. One host caveat for reproducing `pack`: the first `pnpm` on
this machine's PATH is a corepack shim that exits 1 on whatsabi's bare `"packageManager": "pnpm"` field ("No version
specified"); the real pnpm at `/opt/homebrew/bin/pnpm` (10.10.0) packs it cleanly, so run the e2e proofs with
`PATH=/opt/homebrew/bin:$PATH`. `Git.Submodules`/`Git.Submodule` plans were additionally probed in a scratch
workspace (argv `git submodule update --init --recursive --force -- <paths>`, cacheable, `//`-prefix stripped).



### Lane api/go 2026-08-27

Status: targets 654/654; build-cli 654 passed + 1 skipped; both package `tsc --noEmit` checks green; changed-file eslint and dprint green. The full tapes graph now reaches the foreign `S.Docker.Build` namespace; optimism reaches the foreign `S.Mise` constructor. No file under `~/artsy` was edited.

| Owned symbol | Status | Exact proof | Output tail |
| --- | --- | --- | --- |
| `Workspace.toolchains` and optional Node trio | [x] | `pnpm -C packages/targets exec vitest run test/Go.test.ts --coverage.enabled=false` | `12 passed`; toolchain-only workspace accepted, partial Node trio rejected |
| `S.Go.Toolchain` | [x] | same | module files, Nix authority, CGO and experiments frozen; excess attrs rejected |
| `S.Go.bin` / `S.Go.run` | [x]/[p] | `pnpm -C packages/build-cli exec vitest run test/GoExecution.test.ts --coverage.enabled=false` | `3 passed`; Go binary resolved/probed in module cwd; `Go.run` expands to `go run <spec>` in Shell/Generate planning |
| `S.Go.Test` | [x] | same | real `go test`, warm hit, inside-closure edit reran, outside edit hit |
| `S.Go.Binary` | [x] | same | real binary captured/restored; warm build hit |
| `S.Go.Packages` | [x] | same | `go list -json -deps`; closure includes Go/test/cgo/embed files and composes with `Files.difference` |
| `S.Go.ModDownload` | [p] | `pnpm -C packages/targets exec vitest run test/Go.test.ts --coverage.enabled=false` | strict constructor and `go mod download`/`GOMODCACHE` plan; production network execution deferred with tapes root blocked before planning by Docker |
| `S.Go.Lint` | [p] | same plus build-cli full suite | pinned `go run golangci-lint@version`; changes uses scratch/write-set bracket; production v2.8.0 run deferred by Docker load blocker |
| `S.Go.Generate` | [x] | `pnpm -C packages/build-cli exec vitest run test/GoExecution.test.ts --coverage.enabled=false` | real `go generate --write` produced confined output |
| `S.Go.Fuzz` | [x] | same | real `go test -fuzz ... -fuzztime=1x` green |
| `S.Go.ldflags` | [p] | targets Go test | shared strip/`-X` declaration renders without resolving stamps |
| `S.Stamp.version` | [x] | build-cli Go test | tagged `v1.2.3` fixture binary printed `ok v1.2.3` |
| `S.Stamp.commit` / `commitDate` | [p] | targets Go test + `StampExec.ts` | spawn-time `rev-parse HEAD` / `%cI`; omitted from key material |
| `S.Stamp.buildTime` / `versionMeta` | [p] | targets Go test + `StampExec.ts` | spawn-time UTC ISO / exact-tag metadata; omitted from key material |
| secret-valued stamps | [p] | targets Go test + `StampExec.ts` | only env name keys; value read at spawn, absent value becomes empty, never logged |
| build target as `Reference.Tool` | [x] | build-cli Go test `//:smoke` | `Go.Binary` ran then Shell consumer ran; second invocation `binary hit`, `smoke hit` |
| `S.Nix.DevShell` / `S.Nix.bin` | [b] | build-cli Go test `//:nixRefusal --plan` | `host binary \"nix\" is not present on PATH`; flake and lock digests remain in tool identity |
| Go-only GitHub setup | [x] | `pnpm -C packages/build-cli exec vitest run test/GithubRender.test.ts --coverage.enabled=false` | `actions/setup-go@v6`, `go-version-file: go.mod`, no Node/package install |

| Repository | Load / graph / plan | Execute / refusal proof | Result |
| --- | --- | --- | --- |
| tapes | `cd ~/artsy/tapes && node /Users/williamcory/flows-api/go/packages/build-cli/src/main.js query '//...'` (same for graph) | semantic Go fixture: `pnpm -C packages/build-cli exec vitest run test/GoExecution.test.ts --coverage.enabled=false` | exact new first error: `Cannot read properties of undefined (reading 'Build')` from absent `S.Docker.Build`; all Go/Stamp/toolchains/Nix declarations before it loaded; fixture executes Test/Binary/Generate/Fuzz/tool-edge/stamp/cache/closure/refusal |
| optimism | `cd ~/artsy/optimism && node /Users/williamcory/flows-api/go/packages/build-cli/src/main.js query '//...'` | Go fixture above | exact first error: `S.Mise is not a function`; no Go/Stamp/toolchains error is reached before the foreign owner |
| package suites | `pnpm -C packages/targets exec vitest run --coverage.enabled=false`; `pnpm -C packages/build-cli exec vitest run --coverage.enabled=false --maxWorkers=4` | both `tsc --noEmit -p tsconfig.json` | `654 passed`; `654 passed, 1 skipped`; both type checks green |

Open questions from tapes `SMITHERS-GO-NOTES.md`, answered:

1. Loopback was already closed by the prior lane and is reused unchanged.
2. Yes: Workspace grows a branded, ordered `toolchains` list; the Node trio is all-or-none and optional when that list is non-empty.
3. Fetch-as-resource is used: `Go.ModDownload` owns network/module cache; offline consumers set `GOPROXY=off GOFLAGS=-mod=readonly`. This follows the readiness spec over the note's conflicting `-mod=mod` sentence; vendoring is not introduced.
4. Build targets are tool edges. The target is a normal dependency/data edge; the executable path comes from the producer's declared `out` and its captured outDir restores before the consumer.
5. The graph smoke remains the host triple; release triples are separate keyed binaries. A GitHub matrix API was not invented in this lane.
6. Docker readiness/init remain lane `api/chain`; no stand-ins were added.
7. The loader hint remains and now lists `Go`, `Nix`, and `Stamp`; tapes advances to the Docker error.
8. Secret stamps resolve only at spawn, do not key or log values, and use empty when absent as tapes requested.

Prior art and deviations: the requested `reference/bazel` checkout is absent from this worktree and from the host search, so the implementation follows the design note's Bazel workspace-status split: source/tool/closure facts key, stamp values resolve after keying. It deviates by using direct typed tokens instead of a workspace-status command and by replaying the captured stamped binary on a cache hit. The readiness note's closest shipped siblings were followed for `Shell.execPayload`, sandboxing, CAS capture/restore, services scope, and ImportClosure-style digest keying.

Coordination: before editing shared declarations, `git -C /Users/williamcory/flows-aomi/cargo-targets diff` was empty. The smallest additive shared hunk therefore introduced a generic symbol-branded `Toolchain.Declaration` accepted by Workspace; later the Rust lane developed a Rust-specific declaration shape independently. Merge should retain the generic brand and have `S.Rust.Toolchain` use it. No `S.Cargo.Fetch` or `S.Cargo.AppSet` hunk was made.

Shared-file hunks for merge: `WorkspaceDeclaration.ts` (`WorkspaceDeclaration`, `WorkspaceOptions`, `knownOptions`, `Workspace` validation/storage); `Reference.ts` (`GoBin`, `GoRun`, `NixBin`, target-tool member of `Tool`); `Smithers.ts` (`Go`, `Stamp`, `Nix` exports); `PackageExec.ts` (rule/tool dispatch only); `PackageTree.ts` (`probeVersion` optional cwd); `GithubRender.ts` (typed Go-only toolchain projection/setup).

Not done: full tapes `//:check`, release binaries, and a zero-NotImplemented tapes plan sweep cannot be selected until lane `api/chain` supplies the Docker constructors used during module evaluation. Optimism cannot pass its first `S.Mise` declaration until that owner lands. The committed fixture is semantic rather than a verbatim transformed copy of tapes, because construct-only Docker substitutes are explicitly forbidden. `Go.ModDownload`, pinned `Go.Lint`, and a production `Go.run(sqlc)` are planned but do not have a real tapes execution receipt under that load blocker.

### Lane api/go review 2026-08-27 — verbatim-tapes proof and six defect fixes

The lane above proved its Go surface on a hand-written semantic fixture. The
proof bar asked for a fixture that copies the tapes files **verbatim** minus
the Docker-dependent packages. Building that fixture (`/tmp/tapes-fixture`,
a clone of `~/artsy/tapes` with `e2e/`, `pkg/storage/postgres/` and the
`S.Docker.*`/`S.Agent.Codex`/`S.Git.Commit` declarations removed; `~/artsy`
untouched) surfaced six defects the semantic fixture could not: it declares
no `experiments`, no cross-compilation, no `runner`, no `parallel`, no
`tools`, and no package-relative `out`.

Foreign-lane blockers found while trimming, in the order the loader hits them
(each is the exact first error for its owner, and none is a Go symbol):

1. `S.Docker.Build` — `Cannot read properties of undefined (reading 'Build')`
   (`cli/PACKAGE.ts:109`), lane `api/chain`.
2. `S.Agent.Codex("luna")` — `Schema validation failed` at
   `AgentTarget.ts:916` from `PACKAGE.ts:162`, the agent lane.
3. `S.Git.Commit` — `Missing key at ["message"]` (`PACKAGE.ts:193`), the git
   lane; tapes declares `message: S.Agent.Codex("luna")`, which (2) rejects.

| Defect | Where | Effect | Fix |
| --- | --- | --- | --- |
| Plan-time `go list` ran with the ambient environment | `GoExec.ts` `listed`/`selectedPackages`/`closure` | Every Go target on tapes refused: `build constraints exclude all Go files in .../encoding/json/jsontext`, because the toolchain's `experiments: ["jsonv2"]` never reached `go list`. A cross-compiled `S.Go.Binary` also computed the host triple's file set, so `goos`/`goarch` keyed a closure the build never compiles | `graphEnvironment` (cgo, experiments, GOOS/GOARCH, declared env) is threaded into every `go list`; the fetch-shaping knobs stay on the spawn |
| `go` was probed with `--version` | `PackageTree.probeVersion`, `GoExec.resolveGo` | `go --version` is a usage error that prints the help text, so the resolved toolchain never entered the key: a `go.mod` toolchain bump would replay a stale cache entry, defeating key material item 6 of `SMITHERS-GO-NOTES.md` | `probeVersion(path, { cwd, args })`; the Go probe is `go version` inside the module directory |
| `S.Go.ldflags` returned `["-X", name, StampValue]` | `Go.ts` | The spec's only consumer is `buildArgs: { LDFLAGS: … }` against `go build -ldflags="${LDFLAGS}"` — a string. The array embedded a live `Stamp` object and never spelled the `-X name=value` pair the Go linker requires | Returns the flag string with `-X name=<Stamp.token>`; the token encoder moved to `Stamp.token` so `StampExec` and the renderer share one spelling |
| `offline: true` never used the fetch resource's cache | `GoExec.environment` | `GOPROXY=off` ran against the host's ambient `GOMODCACHE`: green on a warm machine, and on a cold one `//cli:tapes` failed with `verifying module: golang.org/toolchain@…: dial tcp: lookup sum.golang.org`. The declared `data: [fetch]` edge did nothing | When `offline` is set, `GOMODCACHE` points at the `Go.ModDownload` on the target's own `data` edge |
| `runner: "gotestsum"` silently fell back to `go test` | `GoExec.planRule` | gotestsum is absent on this host, so optimism's `//:testGo`, `//op-e2e:test` and `//op-e2e:faultProofs` would have reported green for a run their declaration did not describe | Typed refusal naming the binary and the attr; `Planned.refusal` carries it to `PackageExec` |
| `parallel` and `Go.Generate`'s `tools` were accepted and dropped | `GoExec.planRule`, `PackageExec` Go branch | optimism declares `parallel: 1` to stop workers starving on fuzztime, and `tools: [S.Mise.bin("mockery")]` so a mockery bump re-checks every mock. Neither reached the run; the generator's version keyed nothing | A numeric `parallel` becomes `-parallel=N` (`"cpus"` stays off argv — it is Go's own default, and spelling the host core count would split the cache per machine); `tools` resolve through `resolveTool`, key in `toolchain`, and join PATH for the spawn only |

Also removed: `Go.Binary`'s `outputs` declaration. `DeclaredOutputs.cwd` is
workspace-relative (`ToolBuild.verifyOutputs` → `measureOutput`), but `out`
may be package-relative — optimism's `out: "bin/cannon"` in `//cannon` would
have declared root-level `bin/cannon`. It is inert in package mode today
(`PackageExec` sets `declaredOutputs: undefined`), so a wrong path was worse
than none; `GoExec.planRule` resolves `out` against the package and is what
actually drives capture.

Proofs after the fixes, all against the verbatim tapes fixture:

| Proof | Command | Result |
| --- | --- | --- |
| Load | `node …/main.js query '//...'` | 45 labels, zero warnings |
| Plan sweep | `--plan` over all 45 labels | zero `NotImplemented`; the only refusals are the six correct `approval required` ones on `S.Docker.Push`/`S.Shell.Run` outward actions and `//.github:pr` |
| Real build with stamps | `'//cli:tapes'` | `ran`; `go version -m build/tapes` shows `-ldflags="-s -w -X …utils.Version=nightly-2-g8d6219e-dirty -X …utils.Sha=8d6219e… -X …utils.Buildtime=2026-08-27T10:29:28.837Z"` and `./build/tapes version` prints them. `go version -m` also reports `go1.26.1-X:jsonv2`, so the experiment reached the compile |
| Stamps stay out of the key | `'//cli:tapes' --plan` | argv carries `{smthrs:stamp:…}` tokens, never a resolved value |
| Offline is real | `HOME=/tmp/emptyhome …/main.js '//cli:tapes'` | `ran` with no ambient module cache — the build used the fetch resource's `.gomodcache` |
| Cache | `'//:parity'` twice | `ran 5.4s` then `hit 1ms` |
| Closure keying | edit outside the Go closure, then inside | `hit 2ms`, then `ran 437ms` |

optimism still stops at `S.Mise is not a function` in its `WORKSPACE.ts`, so
its load cannot be advanced from this lane. Every optimism Go/Stamp
declaration shape was constructed directly instead (`cannon64Impl` with
`cgo: true` and a package-relative `out`, `cannon:fuzz`, `op-e2e:test` with
`runner`/`timeout`/`parallel: "cpus"`, `op-node:binary` with `versionMeta`,
`//:testGo` over `S.Files.difference`, `linter:opGolangciLint`, and
`S.Shell.Test({ bin: <Go binary> })`): all nine construct.

Still open, reported rather than fixed:

- `//:fetch` never caches: `could not store //:fetch in the cache: cached
  JSON has too many members`. A module cache is too large for the CAS
  manifest, so `S.Go.ModDownload` re-runs every invocation (13–34 s). It is
  honest, not fake, but `Go.ModDownload` needs a capture strategy that is not
  a per-file manifest. That is shared cache work, not a Go-lane hunk.
- `SMITHERS-GO-NOTES.md:159` says `offline` sets `GOFLAGS=-mod=mod`;
  `FLOWS-GO-READINESS.md:36` says `-mod=readonly`. The readiness sequencing
  wins per the lane brief, and `-mod=readonly` is what a committed `go.sum`
  wants. Unchanged, restated here so the merge sees the conflict.
- Two build-cli files fail `dprint check` on this branch; neither is touched
  by this lane. Pre-existing baseline.

### Lane api/fetch 2026-08-27

`S.Fetch` now executes honestly in PACKAGE.ts mode. The fetch itself implies
`sandbox: { network: true }`: network is intrinsic to the rule and is printed
in `--plan`; authors cannot accidentally select the default no-network profile
because the observed declaration surface has no `sandbox` attr. No secret
values are involved in the observed contract. Downloading uses Effect's
Undici-backed Node `HttpClient` host seam (with bounded redirects), not a
constructor or ad-hoc global `fetch`. Sha256 verification completes before the
workspace is touched; the verified bytes land through a synced sibling temp
file and atomic rename, then the existing single-file CAS path captures them.

| Owned symbol | Status | Exact proof command | Output tail |
| --- | --- | --- | --- |
| `S.Fetch({url, sha256, out})` plan | [x] | `cd ~/artsy/force && node /Users/williamcory/flows-api/fetch/packages/build-cli/src/main.js '//data:schemaPinned' --plan --format json` | `rule: Fetch`; `cacheable: true`; `sandbox.network: true`; no `refusal` |
| `S.Fetch` execute/cache | [x] | `cd ~/artsy-e2e/force && cp ~/artsy/force/data/PACKAGE.ts data/PACKAGE.ts && rm -rf .flows && node /Users/williamcory/flows-api/fetch/packages/build-cli/src/main.js '//data:schemaPinned'` — twice, then `rm data/schema.upstream.graphql` and a third time, then `rm -f data/schema.upstream.graphql; rm -rf .flows; git checkout -- data/PACKAGE.ts` | cold `ran 429ms`; warm `hit 4.7ms`; post-delete `hit 4.8ms` and the file is back; `shasum -a 256` = `7f60276646f651505e048961954fa97c7ad8501b284ac3db362c04f1d23c72e0`, 866527 bytes, mode 644 all three times; clone `git status` clean afterwards. The `data/PACKAGE.ts` copy is required: the `e2e snapshot of force spec + sources` commit predates `schemaPinned`, so the bare form answers `unknown_label`. |
| `S.Fetch` local HTTP contract | [x] | `pnpm -C packages/build-cli exec vitest run test/FetchTarget.test.ts --coverage.enabled=false` | `8 passed`; key varies with url/sha256/out; package output law; typed mismatch expected/actual with absent destination and unchanged pre-existing file; typed `unexpected_status` on HTTP 404 and `request_failed` naming `ECONNREFUSED`; warm hit; deleted output restored byte-for-byte and mode-for-mode |

| Repository | Load / graph / plan proof | Execute / refusal proof | Result |
| --- | --- | --- | --- |
| force | `cd ~/artsy/force && node /Users/williamcory/flows-api/fetch/packages/build-cli/src/main.js '//...' --plan --format json` (condensed parser) | `//data:schemaPinned` in the e2e clone, twice; clone restored clean afterwards | 82 public roots / 89 planned nodes / 10 typed host-or-approval refusals / **0 NotImplemented**; Fetch real download then hit |
| package suites | `pnpm -C packages/targets exec vitest run --coverage.enabled=false`; `pnpm -C packages/build-cli exec vitest run --coverage.enabled=false` | both requested package `tsc --noEmit -p tsconfig.json`; package dprint checks; eslint on every touched source | targets 686/686; build-cli 691 passed + 1 skipped; tsc, dprint, touched-source eslint clean |

Contract audit and conflicts: `rg 'S\\.Fetch\\(' ~/artsy` found exactly one
declaration, `~/artsy/force/data/PACKAGE.ts:6`, with only `url`, required
`sha256`, and package-relative `out`. The named tapes, aomi, aomi-sdk, viem,
optimism, and whatsabi trees declare no other `S.Fetch`, so headers, secrets,
optional digests, and archive extraction were not invented. There is no spec
conflict. The requested `reference/` prior-art shelf is absent in this
worktree; the implementation followed `packages/std/src/Fetch.ts` for the
Effect HttpClient seam and `PackageExec`/`PackageTree` single-file
capture/verified restore for CAS behavior.

Shared-file hunk: `packages/build-cli/src/PackageExec.ts` only registers and
dispatches `FetchExec`, projects its output/sandbox into the generic node,
admits Fetch to the existing computational cache, and prints the implied
sandbox in its plan report. `packages/targets/src/Fetch.ts` has documentation
only; its legacy non-package Flow implementation deliberately remains a typed
NotImplemented refusal so host access is not duplicated in the declaration
constructor.

Not done: no unobserved headers, secrets, optional-sha, extraction, or BUILD.ts
execution surface was added. Those are not present in the design-partner
corpus and would widen the contract without a declaration to prove.

Review pass (same day, same lane): three defects found and fixed in place.
(1) A transport failure reported the generic fallback `HTTP transport failed`
and dropped the reason entirely, because Effect's `HttpClientError` keeps
`message` on its prototype and `Diagnostic.message` reads own data properties
only, by design. `FetchExec.transportReason` now walks the own-`cause` chain
(bounded to four hops, accessors never invoked) so a dead host reports
`connect ECONNREFUSED 127.0.0.1:1`. (2) A fresh download took its mode from the
process umask while a CAS restore chmods to `0o644`, so a warm tree could
differ from a cold one in metadata; `atomicWrite` now chmods explicitly.
(3) The `unexpected_status` and `request_failed` branches had no coverage; the
fixture server answers 404 on `/missing*` and the suite asserts both typed
failures write nothing. Suites, `tsc`, eslint, and dprint re-run green.

### Lane api/gaps 2026-08-27

The Rust/Cargo lane was merged first as `4e53080d9`, resolving every shared
conflict as a union. The completed Fetch lane was subsequently merged as
`a57beda81` so force also meets the cross-repository zero-NotImplemented bar.
No file under `~/artsy` was edited. Execution used disposable clones under
`~/artsy-e2e`; all four clones were restored with `git reset --hard HEAD` and
`git clean -fdx`, and finish with zero status rows.

| Owned surface | Status | Exact proof command | Output tail |
| --- | --- | --- | --- |
| `S.Shell.Test({ shards })` and graph-derived CI matrix | [x] | `pnpm -C packages/build-cli exec vitest run --coverage.enabled=false test/PackageExecution.test.ts test/GithubRender.test.ts`; `cd ~/artsy/viem && node /Users/williamcory/flows-api/gaps/packages/build-cli/src/main.js '//test:test' --plan --format json` | independent shard keys/hits; CI matrix `shard: [1, 2, 3]`; viem plan prints `shards: 3` and the honest missing-`vitest` refusal |
| `S.Shell.Serve({ services })` | [p] | `cd ~/artsy/tapes && node /Users/williamcory/flows-api/gaps/packages/build-cli/src/main.js graph '//...'` plus build-cli service suites | 67 labels, `warnings: []`; nested service edges load and use the existing supervisor path |
| Shell `script`/`timeout`; `S.Generate({ command })` | [x] | targets `PackageApi.test.ts`; build-cli `PackageExecution.test.ts`; optimism all-label plan sweep | strict duration syntax; script argv executes; declaration timeout reaches `Exec`; zero NotImplemented |
| direct `S.Agent.Codex("luna")`, agent-composed Git message, `Agent.Pr` payload/MCP | [p] | targets `AgentTarget.test.ts`; build-cli `AgentSession.test.ts`; tapes all-label plan sweep | tapes root loads all 67 labels; payload/MCP retained; direct selector validates |
| Go/Rust version authority via Mise/Nix | [p] | targets `Go.test.ts` and `RustToolchainDeclaration.test.ts`; optimism query/graph | 79 labels, `warnings: []`; Mise config is keyed without requiring the generic toolchain brand |
| `Cargo.Nextest`, `Cargo.Deny`, build `target`/`container`, fmt toolchain, implicit workspace | [p]/[b] | targets `CargoPackage.test.ts`; build-cli `CargoPlan.test.ts`; optimism `//rust:deny` and `//rust:konaPrestate` plans | nextest resolves installed `cargo-nextest`; absent `cargo-deny` is typed; underspecified Docker container build refuses rather than running on the host |
| nested workspace discovery boundary | [x] | `pnpm -C packages/build-cli exec vitest run --coverage.enabled=false test/PackageRouting.test.ts`; root queries for tapes and aomi-sdk | nested demo workspaces are pruned; tapes 67 and aomi-sdk 36 root labels load |
| `Go.ModDownload` large-directory caching | [x] | build-cli `GoExecution.test.ts`; tapes e2e `//:contractSeals` twice | module cache captured as one tar CAS blob; production run `fetch ran 42.9s`, test `ran 7.7s`; repeat `fetch hit`, test `hit 2ms` |
| merged `S.Fetch` execution | [x] | build-cli `FetchTarget.test.ts`; force repository sweep | Effect HttpClient, digest-before-write, atomic output, CAS restore; force has zero NotImplemented |

| Repository | Load / graph / plan sweep | Execute / typed-refusal proof | Result |
| --- | --- | --- | --- |
| force | `/Users/williamcory/flows-api/goals/verify-repos.sh /Users/williamcory/flows-api/gaps force` | Fetch lane's real download/hit receipt | 82 labels, `warnings: []`, 0 NotImplemented, 12 typed refusals |
| whatsabi | `/Users/williamcory/flows-api/goals/verify-repos.sh /Users/williamcory/flows-api/gaps whatsabi` | typed host/outward refusals; upstream README fence check remains honestly red | 47 labels, `warnings: []`, 0 NotImplemented, 38 typed refusals |
| viem | `/Users/williamcory/flows-api/goals/verify-repos.sh /Users/williamcory/flows-api/gaps viem` | e2e `//src:srcs` ran; `//test:test --plan` says `node_modules binary not found ... vitest`; shard fan-out executes in the unit e2e | 76 labels, `warnings: []`, 0 NotImplemented, 56 typed refusals |
| tapes | `/Users/williamcory/flows-api/goals/verify-repos.sh /Users/williamcory/flows-api/gaps tapes` | e2e `//:contractSeals` ran then hit with the fetched module-cache resource | 67 labels, `warnings: []`, 0 NotImplemented, 13 typed refusals |
| optimism | `/Users/williamcory/flows-api/goals/verify-repos.sh /Users/williamcory/flows-api/gaps optimism`; `//rust:deny` and `//rust:konaPrestate` plans | e2e `//:checkOpGethVersion` ran 697ms then hit 18ms; exact Cargo refusals name absent driver / missing container contract | 79 labels, `warnings: []`, 0 NotImplemented, 40 typed refusals |
| aomi | `/Users/williamcory/flows-api/goals/verify-repos.sh /Users/williamcory/flows-api/gaps aomi` | typed host, approval, and input refusals only | 121 labels, `warnings: []`, 0 NotImplemented, 27 typed refusals |
| aomi-sdk | `/Users/williamcory/flows-api/goals/verify-repos.sh /Users/williamcory/flows-api/gaps aomi-sdk` | e2e `//sdk:format` ran 969ms then hit 3ms; `//:sdkVersionBump` honestly red because base/current are both 4.0.0 | 36 labels, `warnings: []`, 0 NotImplemented, 2 typed refusals |
| slop-computer | `/Users/williamcory/flows-api/goals/verify-repos.sh /Users/williamcory/flows-api/gaps slop-computer` | typed host/outward refusals only | 35 labels, `warnings: []`, 0 NotImplemented, 7 typed refusals |

Final package proof:

| Check | Exact command | Result |
| --- | --- | --- |
| targets suite | `pnpm -C packages/targets exec vitest run --coverage.enabled=false` | 39 files, 734 passed |
| build-cli suite | `pnpm -C packages/build-cli exec vitest run --coverage.enabled=false` | 42 files, 706 passed, 1 skipped |
| type checks | `pnpm -C packages/{targets,build-cli} exec tsc --noEmit -p tsconfig.json` | both green |
| format / lint | package-local `pnpm exec dprint check`; eslint over every touched source | green |

Spec conflicts and rulings:

1. `optimism/rust/PACKAGE.ts:61-66` asks for `container: "docker"` but names
   neither an image nor a container command. The host has Docker, but choosing
   an image would invent reproducibility inputs, so planning returns the typed
   refusal `declares no image or container command`.
2. The live viem clone has no installed `node_modules`; sharded vitest targets
   therefore plan with the existing exact missing-binary refusal. Installing
   dependencies was not silently folded into a test target.
3. aomi-sdk's SDK version guard is executable but correctly red on the current
   snapshot (`base=4.0.0 current=4.0.0`); Cargo fmt is the green cached receipt.
4. The earlier Go lane reported that a per-file CAS manifest could not hold
   tapes' module cache. This lane stores it as one tar blob and validates every
   archive path before extraction; it no longer reports `cached JSON has too
   many members`.

Shared-file hunks: `PackageExec.ts` (new rule dispatch, Cargo drivers,
timeouts, shard execution, tar capture), `GithubRender.ts` (shard matrix),
`PackageDiscovery.ts` (nested workspace boundary), `GoExec.ts` (Mise config
authority), and targets `Shell.ts`, `Cargo.ts`, `Compose.ts`, `AgentTarget.ts`,
`Go.ts`, `RustToolchain.ts`. The initial Cargo merge also unions the prior
lane's `AgentSession.ts`, `Reference.ts`, `WorkspaceDeclaration.ts`, and
`Smithers.ts` additions.

Not done by design: `Overlay` and `Npm.Downstream` retain their existing typed
refusals; missing nix/mise/hurl/gotestsum/cargo-deny and approvals/secrets
remain explicit plan refusals. The Docker-container Cargo build stays blocked
until the declaration supplies its image/command contract. No fake green was
introduced for those cases.

#### Implementation receipt for api/viem

Implemented viem's two remaining executor boundaries. Overlay consumers now run from a scratch workspace carrying
all reachable replacements, capture declared outputs from scratch into the real CAS, and atomically materialize only
those outputs. Git submodule inputs now resolve path patterns from the config file's directory, expand them against
`.gitmodules`, key on stage-0 gitlink SHAs, require clean matching worktrees, and check out only missing/empty paths
under an implied network sandbox. The real e2e clone was reset clean after the proofs and retained `node_modules`.

| Owned symbol | Status | Exact proof command | Output tail |
| --- | --- | --- | --- |
| `Overlay` | `[x]` | `pnpm -C packages/build-cli exec vitest run test/NodeLaneExecution.test.ts --coverage.enabled=false` | replacement changes output; source byte-identical; warm hit; deleted outDir restored; replacement edit re-keyed; two-overlay conflict refused |
| `Overlay` (viem) | `[x]` | from `~/artsy-e2e/viem`: `PATH=/opt/homebrew/bin:$PATH node /Users/williamcory/flows-api/viem/packages/build-cli/src/main.js '//src:buildCjs'` | `5 targets: 0 hit, 5 ran, 0 failed`; warm run: private `Shell.Build hit`; `_cjs/node/trustedSetups.js` uses `__dirname`, proving `trustedSetups_cjs.ts` was compiled |
| `Git.Submodules` | `[x]` | `pnpm -C packages/build-cli exec vitest run test/GitSubmoduleExecution.test.ts --coverage.enabled=false` | root-config path law and `vendor/*` expansion; `{network:true}` plan; missing checkout materialized; warm hit; deleted checkout restored; gitlink repin changed key; dirty/divergent worktrees refused |
| `Git.Submodule` | `[x]` | same | `//vendor/one` planned as the indexed root path with its gitlink SHA |
| scratch/CAS bridge | `[x]` | `pnpm -C packages/build-cli exec vitest run test/PackageTree.test.ts --coverage.enabled=false` | real `node_modules` linked as host state; scratch artifacts captured into the real CAS |

| Repository | Load / graph / plan | Execute / refusal set | Result |
| --- | --- | --- | --- |
| viem | `PATH=/opt/homebrew/bin:$PATH bash /Users/williamcory/flows-api/goals/verify-repos.sh /Users/williamcory/flows-api/viem viem` | `//src:buildCjs`, `//:size`, `//:typeCheck`, `SMTHRS_SHARD=1/3 //test:test` in `~/artsy-e2e/viem` | `ok`, `warnings:[]`, 76 labels, 0 NotImplemented, 56 typed refusals; CJS and typeCheck green; size reached size-limit's forge postinstall red; shard's four Anvil services became ready then vitest reached its own no-network red |

`//:typeCheck` crossed `//contracts:libs` (`ran 959ms`), `//contracts:artifacts`, typed-artifact generation,
and finished root `tsc -b` green: `9 targets: 0 hit, 9 ran, 0 failed`. The submodule plan expands the viem glob to
the seven indexed `contracts/lib/*` paths and prints `sandbox: { network: true }`; no literal glob becomes an outDir.
`//:size` crossed both ESM and overlaid CJS builds, then size-limit invoked its own dependency-status install and
reported the host PATH's incompatible `forge` (`unrecognized subcommand 'build'`). The selected test shard planned a
real vitest argv and `shards: 3`; all four Anvil forks reached readiness before vitest reported denied external RPC
fetches under the target's declared no-network sandbox.

Final package proof:

| Check | Exact command | Result |
| --- | --- | --- |
| targets suite | `pnpm -C packages/targets exec vitest run --coverage.enabled=false` | 39 files, 735 passed |
| build-cli suite | `pnpm -C packages/build-cli exec vitest run --coverage.enabled=false` | 43 files, 714 passed, 1 skipped |
| type checks | `pnpm -C packages/{targets,build-cli} exec tsc --noEmit -p tsconfig.json` | both green |
| format | package-local `pnpm exec dprint check` in targets and build-cli | both green; root has no `dprint` command |
| lint | `pnpm -C packages/build-cli exec eslint src/OverlayExec.ts src/GitSubmoduleExec.ts src/PackageExec.ts src/PackageTree.ts --max-warnings=0` | green |

Spec conflicts: none. The viem comments and both declarations agree on config-rooted paths, gitlink authority,
checkout-on-absence, and consumer-scoped overlays. The requested `reference/` shelf is absent in this worktree; the
implementation followed the repository's existing `PackageTree.scratchCopy`, write-set portal guard, output-manifest
capture, CAS verification, and atomic materialization prior art.

Shared-file hunks: `PackageExec.ts` (`visit` overlay/submodule planning and key material, `captureBuild`,
`runWithOverlays`, `runBuild`, Shell/submodule dispatch, plan sandbox rendering); `PackageTree.ts` (`scratchCopy`,
`captureOutDir`, `captureFile`). New focused modules are `OverlayExec.ts` and `GitSubmoduleExec.ts`; focused coverage
is in `NodeLaneExecution.test.ts`, `GitSubmoduleExecution.test.ts`, and `PackageTree.test.ts`.

Not done by design: viem's upstream lint/format verdicts were left unchanged; `//:size` remains honestly red on the
host PATH's forge used by size-limit's nested install; the core shard remains honestly red when its setup fetches
external RPCs under a no-network test sandbox. `Npm.Downstream` retains its existing isolated-checkout refusal.

#### Review pass over lane api/gaps

Six defects found by re-reading the lane diff against the `~/artsy` corpus and
fixed on the branch. Each has a regression test that fails without its fix.

| Defect | Where | Evidence | Fix |
| --- | --- | --- | --- |
| A `.sh` script handed to `S.Generate` planned as `node <script>`, while the same file under `S.Shell.Build` planned as `/bin/sh <script>` | `Compose.ts` generate script branch, `PackageExec.ts` Generate block | `optimism/op-core/PACKAGE.ts:21,31` declare one `sync-superchain.sh` under both rules; the plan printed `node,op-core/superchain/sync-superchain.sh` | `Shell.scriptInterpreterToken` picks `/bin/sh` for `.sh`/`.bash` and the workspace runtime otherwise, for both rules; force's `.mjs` generators still plan under node |
| `Shell.Test({ command, shards })` appended the shard selector after `/bin/sh -c <text>`, where it becomes `$0` and never reaches a runner: N identical runs, N green shards | `PackageExec.ts` shard extraction | no `~/artsy` declaration uses it; viem shards through `bin` | typed plan refusal naming the forms that can carry the selector |
| The shard selector read `process.env` directly, bypassing the executor's `options.environment` seam | `PackageExec.ts` `Shell.Test` dispatch | seam already exists at `const environment = options.environment ?? process.env` | reads through the seam |
| Nested-workspace pruning treated a repository's own `.smithers/WORKSPACE.ts` as a nested workspace and dropped every package beneath `.smithers/` | `PackageDiscovery.ts` `nestedWorkspace` | force, tapes, aomi, slop-computer all root at `.smithers/WORKSPACE.ts` | the walk carries its own `workspaceFile` and never counts it as nested |
| `Cargo.Nextest` admitted `noRun` (its attrs are `PackageTestAttrs`) but never rendered `--no-run`, so a compile-only declaration ran the tests | `Cargo.ts` `packageArgs` | `optimism/rust/PACKAGE.ts:18` uses `S.Cargo.Nextest` | renders `--no-run` like `Cargo.Test` |
| `S.Generate({ command, stdout })` admitted `stdout` and dropped the redirection; only the script and bin branches applied it | `PackageExec.ts` Generate block | `whatsabi/src/PACKAGE.ts:22` uses the bin form with `stdout` | one hoisted write-set entry covers script, command, and bin; the emit form plans no process and is untouched |

Also: `packages/targets/src` was not eslint-clean on the merged line (five
missing JSDoc blocks in `GithubTarget.ts`, one unnecessary assertion in
`PackageManager.ts`, both arriving with earlier lane merges). Both fixed;
`eslint src --max-warnings=0` is now clean for `@smthrs/targets`, and
`@smthrs/build-cli` is down to its documented `@slop`/`main.js` baseline.

| Check | Exact command | Result |
| --- | --- | --- |
| targets suite | `pnpm -C packages/targets exec vitest run --coverage.enabled=false` | 39 files, 735 passed |
| build-cli suite | `pnpm -C packages/build-cli exec vitest run --coverage.enabled=false` | 42 files, 710 passed, 1 skipped |
| type checks | `pnpm -C packages/{targets,build-cli} exec tsc --noEmit -p tsconfig.json` | both green |
| format | package-local `npx dprint check` | both green |
| whatsabi bin-form `stdout` after the hoist | `cd ~/artsy-e2e/whatsabi && node <tree>/packages/build-cli/src/main.js '//src:generated'` | `ok: true`, `//src:generated Generate ran`, clone status unchanged |

### Lane api/viem 2026-08-27

| Owned symbol | Status | Exact proof command | Output tail |
| --- | --- | --- | --- |
| `Overlay` | `[x]` | `pnpm -C packages/build-cli exec vitest run test/NodeLaneExecution.test.ts --coverage.enabled=false`; from `~/artsy-e2e/viem`, `PATH=/opt/homebrew/bin:$PATH node /Users/williamcory/flows-api/viem/packages/build-cli/src/main.js '//src:buildCjs'` | fixture proves replacement output, byte-identical source, hit, CAS restore, re-key, conflict refusal; viem CJS `5 targets: 0 hit, 5 ran, 0 failed`, warm build hit, emitted file uses CJS-only `__dirname` |
| `Git.Submodules` | `[x]` | `pnpm -C packages/build-cli exec vitest run test/GitSubmoduleExecution.test.ts --coverage.enabled=false` | config-root path law, glob expansion, `{network:true}`, gitlink keying, missing checkout, hit/restore, dirty and divergent typed refusals |
| `Git.Submodule` | `[x]` | same | root-anchored direct path planned and keyed on its stage-0 gitlink SHA |
| scratch/CAS bridge | `[x]` | `pnpm -C packages/build-cli exec vitest run test/PackageTree.test.ts --coverage.enabled=false` | `node_modules` remains host state; scratch outputs enter the real CAS and materialize atomically |

| Repository | Load / graph / plan sweep | Execute / refusal proof | Result |
| --- | --- | --- | --- |
| viem | `PATH=/opt/homebrew/bin:$PATH bash /Users/williamcory/flows-api/goals/verify-repos.sh /Users/williamcory/flows-api/viem viem` | e2e `//src:buildCjs`, `//:size`, `//:typeCheck`, and `SMTHRS_SHARD=1/3 //test:test` | re-measured against the restored, unedited spec: `viem ok warnings:[] 76 0 56`; buildCjs green with `_cjs/node/trustedSetups.js` carrying `__dirname` and tracked `src/` byte-identical across the run; `//:typeCheck` `9 targets: 0 hit, 9 ran, 0 failed` past `//contracts:libs`; size reached its forge-postinstall red; four Anvil services ready before the shard's declared no-network RPC red; clone reset clean with node_modules preserved |

Final gates: targets 735/735; build-cli 714 passed + 1 skipped; both package TypeScript and dprint checks green;
eslint green on `OverlayExec.ts`, `GitSubmoduleExec.ts`, `PackageExec.ts`, and `PackageTree.ts`. `//:typeCheck`
crossed `//contracts:libs` in 959ms and finished all 9 nodes green. The real submodule plan names the seven indexed
`contracts/lib/*` paths and prints its implied network sandbox. The selected shard has a real vitest argv and
`shards: 3`.

Spec conflicts: one. `~/artsy/viem/PACKAGE.ts:241` declares `S.Package({ defaultVisibility: "public", ... })`, which
`Package.ts` rejected with `Package received unknown option "defaultVisibility"`; the checkout carried an uncommitted
working-copy edit deleting that line, so the "viem loads" baseline was measured against a narrowed spec. `S.Package`
now accepts `defaultVisibility`, records it in `PackageMetadata`, and refuses any value but `"public"` by name
(omission from the target map is still the only privacy mechanism). The design-partner file was restored with
`git checkout -- PACKAGE.ts`; pristine `~/artsy/viem` loads and graphs with `warnings: []`.

The requested `reference/` shelf is absent; the implementation follows existing
`PackageTree.scratchCopy`, portal guarding, CAS capture/verification, and atomic materialization. Shared-file hunks:
`PackageExec.ts` (`visit`, key material, `captureBuild`, overlay build/spawn helpers, submodule/Shell dispatch, sandbox
plan rendering, the `overlayScratchRules` dispatch guard) and `PackageTree.ts` (`scratchCopy`, source-root/CAS-root
capture split); `targets/src/Package.ts` (`defaultVisibility`). New modules: `OverlayExec.ts`, `GitSubmoduleExec.ts`.
Tests: `NodeLaneExecution.test.ts`, `GitSubmoduleExecution.test.ts`, `PackageTree.test.ts`, `PackageApi.test.ts`.

Review pass over this lane found and fixed two overlay defects. (1) `OverlayExec.resolve` walked a dependency
target's `data`, so an overlay declared as one build's private input leaked to every downstream consumer of that
build's *outputs*: `//:size` (`Size.Budgets`) carried viem's `trustedSetups` replacement. The walk now descends a
`Filegroup`'s `srcs` and an `Overlay`'s `base` only — a target contributes its declared outputs, not its inputs.
(2) Only `Shell.Build`/`Foundry.Build`/`Shell.Test`/`Foundry.Test`/`Shell.Run` mount the overlay scratch tree; every
other spawning rule dropped the overlay silently and reported green. `dispatch` now refuses those by name
(`... but this rule runs against the real tree; it has no consumer-scoped overlay mount`). Two smaller repairs:
`scratchCopy` takes a `skip` list so an overlay build's own `outDirs` — cleared in scratch before it runs — are not
copied first (viem `//src:buildCjs` went 77.9s back to 37.7s once `src/_esm`/`src/_cjs` stopped being duplicated),
and `configPaths` reads `git config -z` so a submodule name or path carrying whitespace still parses exactly.

Not done by design: upstream viem lint/format verdicts were left unchanged; size-limit remains honestly red on the
nested install's incompatible PATH `forge`; the core shard remains honestly red when setup fetches external RPCs
under its no-network sandbox; `Npm.Downstream` retains its isolated-checkout refusal.

### Lane le/aomi-mono 2026-08-28

| Owned symbol | Status | Exact proof command | Output tail |
| --- | --- | --- | --- |
| `S.LocalRepository` | `[x]` | `pnpm -C packages/build-cli exec vitest run test/MultiRepo.test.ts --coverage.enabled=false` | declared repositories are opaque discovery boundaries; undeclared nested workspaces and invalid repository roots refuse with typed diagnostics |
| `S.Repo.Target` | `[x]` | same; fallback-fixture CLI proof recorded in `goals/le/aomi-mono-REPORT.md` | child kinds and `-repo->` graph edge resolve; plan delegates to the child label; execution runs in the child workspace and the clean repeat hits cache |
| Workspace `repos` key | `[x]` | same | the parent declaration loads, declared child workspaces are validated before discovery, and broad globs stay outside the child boundaries |
| extended `S.Github.Workflow` | `[x]` | `pnpm -C packages/build-cli exec vitest run test/GithubRender.test.ts --coverage.enabled=false`; `pnpm -C packages/targets exec vitest run test/GithubTarget.test.ts --coverage.enabled=false` | env, environment, jobName, runsOn, permissions, concurrency, typed workflow-dispatch inputs, and raw steps validate and render against the workflow goldens |
