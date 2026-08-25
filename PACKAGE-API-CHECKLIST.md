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

- [ ] Tool refs resolve: S.NodeModule.Bin, S.NodeModule, S.Host.bin (declared-or-fatal, PATH at run start), S.PackageManager.bin, S.Runtime.bin, S.Runtime.npx — proof: `//src:lint` spawns force's node_modules/.bin/biome
- [ ] S.Shell.Test bin+args — proof: `smthrs //src:lint` real biome run; `//src:typeCheck` real tsc
- [ ] S.Shell.Run bin/command forms — proof: `//src:cleanRelay`; `//workflows/beep:beep`
- [ ] `bun:` + `using:` templates via bun -e with injected tool paths — proof: `//:detectSecretsRescan` ([b] if detect-secrets absent → correct Host.bin refusal); `//data:syncSchemaLocal` refusal without metaphysics
- [ ] env/secrets: narrowed env, secret names resolve at spawn only — proof: env dump target shows narrowing; missing secret = typed failure
- [ ] Sandbox policy: default no-network, `{network:true}`, `"none"`; macOS sandbox-exec enforcement where supported; declaration always keys — proof: undeclared network fetch fails; `//data:syncSchema` (network:true) succeeds
- [ ] S.Shell.Diff + `changes` write-set (mechanical diff, out-of-set reverts+fails) — proof: `//src:format` in e2e clone confined to write-set; adversarial out-of-set fixture fails
- [ ] S.Shell.Build + outDirs → CAS manifest capture, cache hit restores files — proof: `//src:relayArtifacts` real relay-compiler build, delete `__generated__`, re-run = hit + files restored
- [ ] S.Materialize — proof: `//src:relay` places artifacts in working tree
- [ ] data edge = materialize-before-dispatch; Run/Serve illegal in data — proof: type/graph-load error fixture
- [ ] gates edge (fresh re-check before act) — proof: `//:preCommit` suite gating a commit dry-run
- [ ] S.Suite / S.Alias — proof: `//:prePush` runs members; `//src:preDeploy` aliases
- [ ] S.gitDiff({paths,added,addedLines}) / S.gitCommit — proof: diff-scoped input keys change with staged edits in e2e clone
- [ ] S.Generate script+changes / emit+S.symlink; check default, --write — proof: `//src:routesGen` check green then drift red after adding a Routes file in e2e clone; `//:claudeMd --write` creates symlink
- [ ] S.Clean({targets,paths}) — proof: removes declared outputs only
- [ ] Cache: toolchain identity in keys; second `//src:typeCheck` run is a hit — proof: hit/miss log

## Phase W3 — capability lanes

Lane A (services): Serve readiness {port|http,timeout} / health {interval,
failures} / stop {signal,grace}; services edge refcount+teardown
- [ ] proof: `//src:dev` starts, /health readiness gates, SIGTERM stop; `//playwright:smoke` boots dev as service ([b] acceptable if app needs .env.shared)
- [ ] mid-run health failure fails dependent (kill dev mid-test fixture)

Lane B (resolver): S.ImportClosure per-file rows, S.Files.difference, S.Test({expect,toBe})
- [ ] proof: `//src/Server:test` keyed on closure — edit unrelated app file = cache hit, edit imported file = miss
- [ ] `//src:unreachableCode` end-to-end once importGraph lands

Lane C (bundler): S.Bundler.Rspack({config}), .resolve({entries,universe}), .build({environment,mode,graph,outDirs})
- [ ] proof: importGraph resolves force's client.tsx/server; `//src:buildClientDev` real rspack build keyed on graph digest

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
