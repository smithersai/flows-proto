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
- [x] PackageLoader: tsx-based, `.js`→`.ts` sibling specifiers, `@smthrs/targets` mapped to local package, one module instance per command — proof: single generated entry module per load; `src.relayArtifacts` identity shared across 4 importing packages (one label) (2026-08-25)
- [x] PackageIndex: path+key labels only, duplicate/two-label/cycle/case fatal, omission privacy, `no_default_target` — proof: fixture error suite (case_collision, target_multiple_labels, package_import_cycle with chain, legacy_target_export, module_not_regular symlink, no_default_target, unknown_agent, one-way WORKSPACE import) + force golden label list (2026-08-25)
- [c] Full S namespace constructs (every symbol below at least `[c]`) — proof: `smthrs graph '//...'` renders the complete force graph, 81 nodes / 94 classified edges (data/gates/services/deps); every implementation is `Target.notImplemented` and execution verbs refuse package mode loudly (2026-08-25)
- [x] CLI package-mode: `smthrs query|graph` auto-detect via WORKSPACE.ts — proof: runs from force cwd (and subdirectories, `:lint` relative form) with no flags; BUILD.ts mode unchanged (348/348 build-cli tests) (2026-08-25)

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
- [x] S.Shell.Diff + `changes` write-set (mechanical diff, out-of-set reverts+fails) — proof: adversarial fixtures: out-of-set write reverted+failed while in-set stays, out-of-set delete restored, write through a symlink judged by resolved location; `//src:formatProject` check reports drift then `--write` applies 16 files all inside the write-set; `//src:format` itself is red as declared (the repo `.prettierrc` pins `parser: "typescript"` globally, so `prettier --write src` chokes on markdown — true of the tool run by hand too) and a failed apply reverts every change it made (tree byte-identical after). Diff check mode runs against a scratch copy and never touches the real tree (2026-08-25)
- [x] S.Shell.Build + outDirs → CAS manifest capture, cache hit restores files — proof: `//src:relayArtifacts` real relay-compiler build captures src/__generated__ (1653 files) into `<cacheDir>/cas` + manifest in the cache; `rm -rf src/__generated__`; re-run = `hit`, tree restored, spot-checked byte-identical (shasum). Tampered blob = logged cache miss + re-execute, never a crash or partial tree (materialization is temp-dir + rename-swap) (2026-08-25)
- [x] S.Materialize — proof: `smthrs '//src:relay'` places artifacts (relayArtifacts hit → verified materialize → relay green) (2026-08-25)
- [x] data edge = materialize-before-dispatch; Run/Serve illegal in data — proof: `illegal_data_target` graph-load error fixture (Run reachable through data, transitively); `//src:typeCheck` schedules and settles relayArtifacts (run or verified hit) before tsc dispatches (2026-08-25)
- [p] gates edge — the mechanism lands: gates are scheduled before the consumer, keep-going within the gate set, and a red gate makes the consumer FAIL with the per-gate report attached (never a silent skip). The named proof (`//:preCommit` gating a commit dry-run) needs Git.Commit, which is lane E; "fresh re-check immediately before act" is same-invocation scheduling, not a second execution at consume time (2026-08-25)
- [x] S.Suite / S.Alias — proof: `//:preCommit` runs members keep-going and reports red with per-member statuses (`//:detectSecrets=failed` typed host-bin refusal, `//src:lint=failed`, `//src:typeCheck=ran` — this is CORRECT); `//:postMerge` alias delegates through `//src:relay` green (2026-08-25)
- [x] S.gitDiff({paths,added,addedLines}) — proof: `smthrs '//src:ssrLint' --plan` key changes with a staged edit in the clone (d0483d02… → 8fcd97a4…) and reverts with it; agent execution stays loudly refused. S.gitCommit keys as its inert ref record; resolving the ref to a sha is lane E (Memory.Retain refuses) (2026-08-25)
- [x] S.Generate script+changes / emit+S.symlink; check default, --write — proof: `//src:routesGen` check green (scratch-copy drift run), red after adding src/Apps/ZZDrive/ZZDriveRoutes.tsx ("drift … src/appRoutes.gen.ts"), `--write` regenerates appRoutes.gen.ts including ZZDrive (clone reset after); `//:claudeMd --write` emits the CLAUDE.md → AGENTS.md symlink, check green, red after `rm CLAUDE.md`. The Generate bin/stdout form keeps a loud NotImplemented refusal (2026-08-25)
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
- [ ] proof: clean-diff `//src:ssrLint` vacuously green with zero spawns; staged bad-SSR edit in e2e clone triggers real luna run (or scripted fake with --agent-fake); cached verdict replays
- [ ] `//workflows/fix-sentry-issue:fixSentryIssue` headless missing-payload refusal; MCP unreachable = early fail

Lane E (git/github/memory): S.Git.Commit (gates+agent message), gitHooks --write install, S.Github.Setup/Workflow/CiGen (+preserve, affected), S.Github.Pr, S.Memory.Retain / S.Memory.SmithersCloud
- [ ] proof: `//:commit` in e2e clone produces gated conventional commit; `.github --write` renders 3 ymls + preserves 3 hand-written; `//github:pr` refuses without token+approval; Memory targets no-op gracefully without smithers cloud, real when configured

## Phase W4 — full sweep

- [ ] Every force label plans (`smthrs graph '//...'` zero NotImplemented at plan time)
- [ ] Executes-green set: lint, typeCheck, test (jest), routesGen, relayArtifacts+relay, format, suites, claudeMd, beep, syncSchema, importGraph, buildClientDev, server/app closure tests
- [ ] Correct-refusal set ([b]): syncEnv/publishAssets/danger (creds), deleteReviewApp (approval+sandbox none), hokusai/detect-secrets/yalc (host bins), fixSentryIssue (payload)
- [ ] Adversarial review pass + fixes; identity/cache-key/write-set invariant tests green
- [ ] Committed on main; checklist fully resolved

## Log

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
