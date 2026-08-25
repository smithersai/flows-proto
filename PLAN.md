# PACKAGE.ts / WORKSPACE.ts routing — final implementation plan

Status: final implementation plan, not implementation. Merged from two independent agent plans (codex sol; claude fable) and validated against primary source on 2026-08-24/25. The Artsy design-partner files are the API's only spec; this document is its missing prose companion.

## 1. Executive decision

The two Artsy repositories prototype a different abstraction from the current `@smthrs/fs` package. The current package turns `flows/**/{flow.ts,flow.mdx,SKILL.md}` registry descriptors into slash/CLI routes and then attempts to load a selected `Flow`. The Artsy API turns `**/PACKAGE.ts` modules into build packages, with one explicit `Package` export defining the addressable targets in that directory, and turns root `WORKSPACE.ts` into the workspace's typed host/toolchain configuration. These should not remain two meanings of one `Route` type.

The recommended replacement is therefore:

1. Make `S.Package(...)` and `S.Workspace(name, ...)` real, strictly typed constructors in `@smthrs/targets`.
2. Replace the `BUILD.ts` export scanner inside `@smthrs/build-cli` with a two-stage router: bounded inventory plus narrow static TypeScript extraction derives labels without evaluating repository modules; lazy trusted evaluation of selected package closures validates the one `Package` export and exact runtime target map.
3. Load the root `WORKSPACE.ts` through a separate, explicit workspace-config loader. A workspace declaration is not a target package and must not participate in package precedence.
4. Retire the public `@smthrs/fs` route/command API. Keep flow discovery in `@smthrs/registry`, where it is already implemented and better specified. Move any still-wanted CLI projection to the CLI/control owner instead of preserving it as a second generic file router. There are no application consumers of `@smthrs/fs` in this checkout; repository-wide searches found only its own tests/docs, lockfile entry, and generated doc copies.
5. Share only low-level, host-neutral path/admission/diagnostic primitives between flow discovery and package discovery. Do not make build targets pretend to be `FlowDescriptor`s, and do not make flow descriptors pretend to be build targets.

Backward compatibility with `BUILD.ts`, `FileRouter.scan`, `Route.load`, `Command`, `CommandTree`, `FlowInvoker`, `Incur`, or the broken `@smthrs/fs/vite` export is not recommended. The root instructions explicitly allow pre-1.0 breaking changes, the requested target API is materially different, and the old package has no source consumers. A short-lived migration diagnostic is useful; a compatibility execution path is not.

## 2. Evidence method and claim labels

### 2.1 Inventory method

I established the relevant inventory by combining:

- `rg --files` inventories of `packages/fs`, `packages/registry`, `packages/build-cli/src`, and `packages/targets/src`;
- repository-wide symbol searches for `@smthrs/fs`, `FileRouter`, `CommandTree`, `FlowInvoker`, `Route.Name/Input/Output`, `Incur.createCli`, `PACKAGE.ts`, `WORKSPACE.ts`, `S.Package`, and `S.Workspace`;
- exact-name inventories of all `PACKAGE.ts`, `WORKSPACE.ts`, `smithers.d.ts`, Smithers notes, and Force route-generation artifacts in the two Artsy repositories;
- full reads of the applicable instruction files before repository research;
- full reads of the current router and registry source and their directly relevant tests/fixtures, the current build module loader and its security/cache tests, the target marker/authoring entry point, canonical file-framework specs, and the Artsy prototype files;
- read-only `git status`, `git diff`, `git log`, `git show`, and `git blame` where the current Artsy worktree differed from its preceding prototype commit or the origin of `@smthrs/fs` was unclear.

Generated documentation copies under `docs/site` and `llms-*.txt` were inventoried but not treated as independent authority when the canonical Markdown source existed. Private chat exports and unrelated commercial/person notes in Smithers-Ops were not used. During the two independent evidence passes, neither agent read the other's file-routing plan; the final synthesis then read both completed drafts in full.

Useful primary anchors for a future implementer:

- `packages/fs/src/FileRouter.ts:81-130` (`scan`) proves metadata-only registry delegation and the `ui.tsx` probe.
- `packages/fs/src/Route.ts:47-75` proves the current name/input/output types are placeholders; `Route.ts:85-119` proves the unsupported-body and Vite-ignored dynamic import behavior.
- `packages/fs/package.json:35-75` declares the missing root/Vite sources.
- `packages/build-cli/src/Workspace.ts:82-106` defines deterministic code-unit ordering and Git inventory limits; `Workspace.ts:520-538` shows separate BUILD-era root cache discovery.
- `packages/targets/src/Target.ts:557-590,695-709` shows stack-derived BUILD ownership; `Target.ts:613-653` is the defensive diagnostic formatter worth retaining.
- Force `PACKAGE.ts:5-9,255-293` and `src/PACKAGE.ts:184-214` state and demonstrate explicit public maps; Force `WORKSPACE.ts:25-39` demonstrates direct workspace fields and hook targets.
- WhatsABI `PACKAGE.ts:6-11,341-381`, `src/PACKAGE.ts:29-31`, and `examples/PACKAGE.ts:12-14,37-46` independently demonstrate the same map/import/privacy contract and deliberate cycle avoidance; `WORKSPACE.ts:28-39` demonstrates the direct field composition and records `layer` as an intended escape hatch.
- Both `smithers.d.ts:1-14` files explicitly classify the code as a design-partner prototype with permissive placeholder types.

### 2.2 Truth precedence used here

Claims are tagged conceptually as follows:

- **Implemented**: behavior present in executable source and pinned by tests.
- **Prototype**: executable-looking design-partner code whose own ambient declarations say the real API is not implemented.
- **Proposed**: this document's recommended completion of an under-specified edge.
- **Superseded**: older documentation or `BUILD.ts` behavior contradicted by newer primary prototype evidence.

The order is current source and tests, then repository docs, then history, then dated research. Smithers-Ops' `Research/Flows3 Software Factory 2026-08-16.md` expressly says it contains no design decisions; its `flows3-design.md` is useful for then-settled BUILD-era cache/codegen principles but predates the Artsy PACKAGE API.

### 2.3 Explicit synthesis rulings

The independent drafts disagreed in several places; none is chosen silently:

- **One generic router versus domain owners:** selected domain-specific registry and PackageIndex owners sharing only low-level host-neutral primitives. Flow entries are untrusted/progressively disclosed prompt bodies; Package declarations are trusted executable build code with different precedence and fatality laws.
- **Eager versus lazy evaluation:** selected eager static identity indexing and lazy selected-closure evaluation. This is the only reading that both indexes every label before planning and preserves no-evaluation metadata discovery. Loading Workspace/every Package merely to list labels is rejected.
- **Index branding versus index-local identity:** selected index-local WeakMap/maps. Mutating target objects with labels risks cross-workspace and concurrent-snapshot contamination.
- **Alias semantics:** selected a distinct Alias target node. Two labels on the same non-Alias value remain fatal.
- **Private visibility:** selected public map members plus omission privacy; reject the unobserved `private` literal until authorization semantics exist.
- **Implicit package synthesis:** selected removal. The explicit Package map supersedes BUILD-era `PackageDefaults`; convenience must be an explicit macro.
- **Catalog breadth versus routing priority:** selected a routing spine first, with advanced execution capability lanes independently gated. All observed API symbols remain in the coverage contract; none may be faked to unblock routing.

### 2.4 Binding rulings that predate this plan (do not re-litigate)

These dated decisions constrain the implementation. They are older than the
Artsy prototypes and were not reversed by them:

- `~/Smithers-Ops/Research/Flows API Decisions 2026-08-11.md` (approved by
  will): a target body is a required pure plan-time field whose digest is key
  material ("Bazel parity: `implementation =` is a field of `rule()`"); plans
  are DAGs; no dynamic in-graph fan-out; `Planned<T>` values are pass-only;
  the word "Workflow" is banned in flows naming. `S.Github.Workflow` names
  GitHub's own artifact and is exempt; never use "workflow" for our own flow
  concepts in API names, docs, or diagnostics. Partner repos' `workflows/`
  directories are their trees; our docs call the things inside them agent
  flows.
- `~/Smithers-Ops/Research/flows3-2026-08-16/flows3-design.md` (settled with
  will): pluggability is dependency injection — a varying capability is a
  service with a Layer, never a config field (this is why no build file names
  a model); a `validate` step gates cache admission for generative output;
  generated code is not committed by default (`mirror` is an opt-in and is
  not key material); approval is mandatory before publish; secrets are
  placeholders in code and agent context, substituted at the edge — names are
  key material, values never are.
- `docs/specs/Concepts/File Dependency Hardening.md` (decided 2026-08-13):
  `Glob`/`TreeArtifact`/`Filegroup` are schema values with Bazel semantics.
- `docs/specs/Concepts/Materialized Inputs.md` (decided 2026-08-14): a node
  never dispatches until every file it reads is physically present in the
  workspace. This is the engine-side law behind the prototype comment "a
  dependency edge always means materialize files, never execute."
- Repository rule (CLAUDE.md): no backwards compatibility pre-release — the
  cutover deletes the old surface in the same drive, with no compat shim.
- will, 2026-08-25 (applied spec-first to the Artsy prototypes, then here):
  `onSuccess` is removed from the API — there are three edge kinds, not
  four; Serve targets carry a full probe contract — `readiness`
  (`{port}` or `{http, timeout}`), `health` (`{interval, failures}`,
  reusing the readiness probe while dependents run), and `stop`
  (`{signal, grace}`).

Reference-corpus routing for the new subsystems (repository rule: consult the
shelf before designing, and say which reference was read):

- Resolver and per-file rows: `reference/bazel` Skyframe
  (`src/main/java/com/google/devtools/build/skyframe/`) — keyed, memoized,
  incremental evaluation; its `GraphTester`-style harness is the model for
  deterministic resolver tests.
- Agent targets: `reference/effect` `packages/effect/src/unstable/ai/` and
  `reference/opencode` `packages/core/src/{session,permission,tool}` —
  session shape, permission gating, tool surfaces.
- Durable approvals and outward-action resume: `reference/temporal`
  `service/history/` — event-sourced pending decisions that survive a crash.
- Bundler two-phase resolve/build: the tool's own resolve options are the
  authority the `Rspack` wrapper reuses, per the Force `src/PACKAGE.ts`
  comment.

## 3. Complete source inventory and roles

### 3.1 Current `@smthrs/fs` package

All files under `packages/fs` were inventoried. The implementation-bearing files are:

- `packages/fs/src/FileRouter.ts` — adapter from `@smthrs/registry/Discovery` descriptors to path-named `Route` metadata; root entry excluded; sibling `ui.tsx` probed; routes sorted.
- `packages/fs/src/Route.ts` — old route model, placeholder type aliases, and selected-module dynamic loader.
- `packages/fs/src/CommandTree.ts` — segment trie, duplicate rejection, longest-prefix resolution, stable traversal.
- `packages/fs/src/Command.ts` — list/parse/execute/call facade over the trie and `FlowInvoker`.
- `packages/fs/src/Incur.ts` — Incur command/help/schema/MCP/OpenAPI projection, hydrating only a selected module for execution.
- `packages/fs/src/FlowInvoker.ts` — Effect service seam between route loading and a harness-owned run loop.
- `packages/fs/src/Directive.ts` — four placement literals to core `Placement` values.
- `packages/fs/src/FsError.ts` — old single error family and stable string codes.
- `packages/fs/src/internal/CommandLine.ts` — non-shell lexer and long-flag parser.
- `packages/fs/src/internal/SchemaBridge.ts` — registry schema-reference to CLI-shape bridge; typed module input remains undecoded pass-through.

Tests and fixtures, all relevant to the behavioral contract:

- `packages/fs/test/FileRouter.test.ts` and `test/fixtures/router/**` — entry precedence, path naming, root exclusion, ignored declared name, metadata-only scan, deterministic order, placement, skill and `ui.tsx` detection, and exclusion of tests/UI as routes.
- `packages/fs/test/Command.test.ts` — quoting, literal shell syntax, flags, and output-encoding failures.
- `packages/fs/test/Directive.test.ts` — the four placement values.
- `packages/fs/test/fixtures/three-projections/flows/review/flow.ts` — the aspiration that one typed flow projects across surfaces.

Packaging/build/docs:

- `packages/fs/package.json` — wildcard exports plus broken root and `./vite` entries whose sources do not exist; Vite is an optional peer.
- `packages/fs/scripts/build.mjs` — dual ESM/CJS build, enumerating `.ts` sources only.
- `packages/fs/scripts/circular.mjs`, tsconfigs, Vitest config, ESLint config, dprint config — package gates.
- `packages/fs/README.md`, `CHANGELOG.md`, `LICENSE` — public subpath documentation, explicit broken-export warning, and an unreconciled generation/Vite aspiration.

No source outside this package imports its API. Canonical external documentation is `../docs/reference/fs.md`; `../docs/site/reference/file-conventions.mdx` accurately separates implemented metadata routing from planned inherited flow-file conventions; `../docs/repo-split-plan.md` calls the package unfinished and unused.

### 3.2 `@smthrs/registry`, the actual owner of flow discovery

Relevant source was inventoried and read:

- `packages/registry/src/Descriptor.ts` — serializable descriptor, provenance, effects, body/schema references, warnings.
- `Discovery.ts` — deterministic directory traversal; exact precedence `flow.ts`, `flow.mdx`, `SKILL.md`; path/frontmatter naming modes; reserved roots; metadata ceiling; static module projection.
- `internal/ModuleMetadata.ts` — custom tokenizer/parser for direct default `Flow.make`/`Flow.agent` metadata, including conservative authority fallback.
- `internal/Frontmatter.ts`, `Names.ts`, `Authority.ts` — YAML metadata, name validation, capability/effect inference.
- `MarkdownFlow.ts` — fixed markdown `{args:string}`/string schemas, skills-compatible prompt loading and resource base.
- `Registry.ts` — ordered sources, first-found precedence, system-collision fatality, atomic refresh, lazy body loading.
- `Disclosure.ts`, `RegistryError.ts`, `index.ts` — model disclosure, typed errors, exports.

The package tests cover real/virtual filesystems, root failures, unreadable nodes, symlinks/special nodes, sort order, metadata ceilings, module syntax, schema refs, warnings, collision precedence, atomic refresh, lazy body rereads, frontmatter serialization, skills, and built CJS/ESM identity. Its README, changelog, manifest, build scripts, configs, fixtures, and license were also included in the inventory.

The important boundary fact is that `FileRouter.scan` does not discover flows independently: it constructs `Discovery` and remaps its result. Removing that remap does not remove flow discovery.

### 3.3 Current BUILD-era implementation that must be replaced

- `packages/build-cli/src/Workspace.ts` — current trusted-TS module loader and graph index. It uses a validated `git ls-files -z --cached --others --exclude-standard` inventory, a bounded fallback walk only when Git is absent/not a worktree, canonical-root admission, regular-file and symlink confinement, deterministic UTF-16 code-unit sorting, digest-keyed `tsx` imports, lazy exact/subtree loading, named-export scanning, target identity maps, `PackageDefaults`, and package-json synthesis.
- `packages/build-cli/src/Label.ts` — `//package:target`, `//package`, relative target, and subtree grammar.
- `Planner.ts`, `Query.ts`, `GraphOutput.ts`, `Executor.ts`, `Cache.ts`, `Diagnostic.ts`, `Cli.ts`, `engine.ts` — downstream consumers of the workspace's target/label/index contract.
- `packages/build-cli/test/Workspace.test.ts` — Git framing/path validation, fallback semantics, ignored files, root config, environment non-mutation, symlink containment, hard/regular file admission, cache invalidation by content rather than mtime, and same-command target identity.
- `PackageJsonWorkspace.test.ts`, `Filegroup.test.ts`, `Execute.test.ts`, `CacheTrust.test.ts`, `CommittedBuildFiles.test.ts`, and verb/query/read-only tests — cross-module target imports, labels, synthesized targets, execution, and graph use.
- `packages/targets/src/Target.ts` — branded target and metadata, schema validation, dependency/input collection, declaration-site stack inspection, call-site `sourceFile`, implementation digest, kinds and outputs.
- `packages/targets/src/Smithers.ts` and `index.ts` — current single-namespace authoring API. The package-root test requires `Smithers` to be the only root export.
- `packages/targets/src/Config.ts` — old `Workspace({cacheDirectory,gitignored})` declaration, not the Artsy workspace API.
- `packages/targets/src/PackageDefaults.ts`, `PackageJson.ts`, `StandardPackage.ts`, and related tests — old synthesis model.
- `BUILD.ts` and per-package `BUILD.ts` files — current public-by-named-export authoring shape.
- `packages/build/{README.md,DESIGN.md,API-REVIEW.md,WIRING.md}` and `docs/{concepts/labels.md,workspace/structure.md,workspace/writing-build-files.md}` — implemented BUILD-era architecture and admitted limitations, especially stack-derived identity and default synthesis.

### 3.4 Force prototype inventory

Applicable instructions: `/Users/williamcory/artsy/force/AGENTS.md`, its `CLAUDE.md`, `docs/best_practices.md`, and `.claude/rules/artsy-frontend-conventions.md`.

Every exact routing/build prototype artifact was inventoried and read:

- root `PACKAGE.ts`, `WORKSPACE.ts`, `smithers.d.ts`, `SMITHERS-NOTES.md`;
- `.github/PACKAGE.ts`, `.storybook/PACKAGE.ts`, `data/PACKAGE.ts`, `patches/PACKAGE.ts`, `playwright/PACKAGE.ts`;
- `src/PACKAGE.ts`, `src/Server/PACKAGE.ts`, and `src/Apps/{Auction,Order2,Settings}/PACKAGE.ts`;
- `workflows/{adding-a-new-app-route,beep,fix-sentry-issue}/PACKAGE.ts`;
- `scripts/generate-routes.mjs`, generated `src/appRoutes.gen.ts`, and consumer `src/routes.tsx`;
- root `package.json`, `tsconfig.json`, `.gitignore`, and README.

Read-only history established the sequence from an all-root PACKAGE prototype, through Effect-layer workspace composition and per-directory named exports, to the current explicit `targets` maps and direct workspace fields. The current dirty worktree is the newest primary evidence; no branch was changed.

### 3.5 WhatsABI prototype inventory

No repository-local AGENTS/CLAUDE instruction file exists. Every exact prototype artifact was read:

- root `PACKAGE.ts`, `WORKSPACE.ts`, `smithers.d.ts`;
- `src/PACKAGE.ts`, `examples/PACKAGE.ts`;
- `workflows/{triage-address,update-interfaces}/PACKAGE.ts`;
- README, package manifest, all TypeScript configs, and `.gitignore`.

History shows one committed Smithers prototype. The ambient declaration explicitly calls these files design-partner code whose usage defines an API to implement later.

### 3.6 Design and dated intent

Canonical relevant specs read include `../docs/specs/{Home.md,HQ.md,Specs/Harness.md}`, `Concepts/Flow Registry.md`, `Specs/File Conventions.md`, `Specs/Flow Directory.md`, `Specs/Input.md`, `Concepts/{Dual Target Rendering.md,UI Layer.md,Control API Protocol.md}`, and the three 2026-07-28 file-framework design studies. These are evidence for the old flow-directory surface and generated typing aspirations, not evidence that PACKAGE modules should inherit `ui.tsx` or registry descriptors.

Smithers-Ops searches found no later technical artifact defining the Artsy PACKAGE router. The relevant dated files were `Research/Flows3 Software Factory 2026-08-16.md` and `Research/flows3-2026-08-16/{flows3-design.md,flows3-full-digest.md,flows3-queue.md}`. They document the older BUILD.ts factory, generated-code/cache decisions, and open limitations. Newer Artsy source supersedes their BUILD-file syntax.

## 4. Current-state behavior: facts, not aspirations

### 4.1 Old flow router

**Implemented.** `FileRouter.scan({root})` invokes registry discovery with source `flows` and path naming. A directory entry is the route; a root entry is warned/skipped by registry discovery. `flow.ts` wins over `flow.mdx`, which wins over `SKILL.md`. A declared `name` is ignored for path-named sources. Routes retain schema references and authority metadata without evaluating the module. A colocated `ui.tsx` is only recorded as an optional path.

**Implemented but incomplete.** `Route.load` supports module routes only and performs `import(/* @vite-ignore */ route.sourcePath)`. Markdown/skill bodies fail even though discovery emits them. The loader requires a default `Flow` value. This absolute/dynamic import is not statically visible to a bundler, is Node-centric, and conflicts with the repository rule against inline dynamic imports in source.

**Implemented but not type-faithful.** `Route.Name` is `string`; `Input<N>` and `Output<N>` are `unknown`. The comment about generated declaration merging has no working augmentation hook: a type alias cannot be refined by interface merging. `SchemaBridge` cannot decode a module input before loading the real Flow schema; `Command.execute` and Incur therefore pass structured typed-module input through and depend on later code to make it safe. Markdown receives `{args,...options}` despite registry's fixed schema being `{args:string}`.

**Implemented projection only.** `CommandTree` and `Command` are CLI/slash routing helpers, not filesystem discovery. Incur adds metadata endpoints and selected-route hydration. None is used by the current CLI/control path.

**Broken/proposed.** The package manifest exports root and `./vite` sources that do not exist. No generator exists in this package. The changelog's generation statement and Vite peer are aspirations, not shipped behavior.

### 4.2 Current BUILD.ts routing

**Implemented.** Every named target export in a `BUILD.ts` is addressable. Package identity is inferred from the BUILD file path and target name from the export key. Direct imports carry target object identity across packages. `Workspace.loadBuild` scans all runtime named exports, recognizes target/config/synthesis declarations, and rejects one target value under two labels.

**Implemented but risky.** Target construction uses `node:util.getCallSites` to attach the declaring `BUILD.ts`. The loader has a structural workaround for duplicated module instances. This mixes declaration construction with route ownership, depends on a Node stack API and source maps, and becomes ambiguous when targets are returned by helpers or re-exported.

**Implemented and worth preserving.** Workspace file admission, symlink containment, Git path validation, deterministic sorting, digest-keyed module re-evaluation, atomic-ish host-file updates, exact target identity, and lazy subtree loading have unusually strong tests. The replacement should reuse these invariants, not replace them with a naive recursive glob.

### 4.3 Artsy status

**Prototype, not implemented library.** Both `smithers.d.ts` files intentionally define a permissive callable/indexed/yieldable value. Force's declarations also note that the build files sit outside its TypeScript include set; WhatsABI explicitly excludes PACKAGE files from every emit config. Thus a prototype file loading under the ambient declarations proves syntax and desired composition, not actual type correctness or runtime support.

**Prototype API facts repeated in both repositories.** `PACKAGE.ts` is auto-discovered; target label names come from an explicit `targets` object; values omitted from that map stay private; other packages import `Package` and use its properties; root `WORKSPACE.ts` exports `Workspace`; package modules use NodeNext-style `.js` relative specifiers even though source is `.ts`.

**Prototype application-specific generation.** Force's `generate-routes.mjs` recursively finds app `*Routes.ts(x)` modules and emits `appRoutes.gen.ts`. It demonstrates that `S.Generate` must model generated source and that generated files can feed other targets. It is not a generic implementation of PACKAGE discovery. Its current `localeCompare` ordering, synchronous direct write, URL pathname use, and basename-derived symbol names are not safe generic precedents.

### 4.4 Delta summary

| Concern | Current behavior | Target behavior |
|---|---|---|
| Entry file | `flows/**/flow.*` in fs/registry; `**/BUILD.ts` in build CLI | exact `**/PACKAGE.ts` plus root `WORKSPACE.ts` |
| Identity | flow directory path; BUILD named export plus stack hint | Package directory path plus explicit `targets` key only |
| Public/private | all BUILD target exports public; flow registry visibility metadata | listed Package properties public, omitted locals private |
| Module shape | arbitrary named target exports | one branded `Package` export; one branded root `Workspace` export |
| Loading | flow metadata static, selected Flow dynamic; BUILD trusted TS via `tsx` | PACKAGE discovery static, trusted TS evaluation in source mode, static generated ESM for bundles |
| Types | old Route name is string and I/O unknown; BUILD imports typed target values | exact Package generic properties; no route declaration merging |
| UI | old flow sibling path is optional Route metadata | no package companion; graph manifest feeds an explicit UI adapter |
| Generation | fs declares but does not implement it; Force has app-specific script | deterministic versioned graph/loader generation plus ordinary target-owned app generation |
| Runtime ownership | fs mixes scan/command/load; build Workspace mixes inventory/load/index/config | registry owns flows; targets own declarations; build CLI owns Package loading/index; planner consumes an interface |
| Portability | absolute Vite-ignored import; Node stack ownership | Node source loader, Bun conformance/compiled path, browser static manifest only |
| Errors | broad `FsError`; BUILD throws mixed Errors | phase-specific tagged diagnostics with stable codes and import chains |

This is a replacement, not a rename: preserving the old `Route` shape would carry flow schemas, prompt bodies, placement, and UI metadata into a build-target graph where they are neither sufficient nor semantically correct.

## 5. Exact inferred target public API

Representative syntax, preserving the common intersection of Force and WhatsABI:

```ts
/// <reference path="./smithers.d.ts" /> // prototype-only; removed with real packages
import { Smithers as S } from "@smthrs/targets"
import { Package as src } from "./src/PACKAGE.js"

const privateConfig = S.file("//tsconfig.esm.json")
const privateInputs = S.Filegroup({ srcs: S.glob(["internal/**"]) })
const compileEsm = S.Shell.Build({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["--project", "tsconfig.esm.json"],
  data: [src.srcs, privateConfig, privateInputs],
  outDirs: ["lib.esm"],
})

export const Package = S.Package({
  defaultVisibility: "public",
  targets: {
    compileEsm,
    // privateInputs is intentionally omitted and has no label.
  },
})
```

```ts
import { Smithers as S } from "@smthrs/targets"
import { Package as root } from "./PACKAGE.js"

const packageJson = S.file("//package.json")
const lockfile = S.file("//pnpm-lock.yaml")
const runtime = S.Runtime.Node({ version: "26" })
const packageManager = S.PackageManager.Pnpm({
  manifest: packageJson,
  lockfile,
  version: "8",
})

export const Workspace = S.Workspace("whatsabi", {
  repository: "git+https://github.com/shazow/whatsabi.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager,
  nodeModules: S.Npm.NodeModules({ packageJson }),
  host: S.Host({ bins: ["python"] }),
  // gitHooks is observed only in Force's WORKSPACE.ts, which binds all four
  // of preCommit, postCommit, prePush, and postMerge; shown here for shape.
  gitHooks: { preCommit: root.preCommit },
})
```

The exact type-level contract should be:

```ts
declare const PackageTypeId: unique symbol

interface PackageMetadata {
  readonly abi: "@smthrs/targets/Package/v1"
  readonly defaultVisibility: "public"
  readonly keys: ReadonlyArray<string>
}

type PackageValue<T extends Readonly<Record<string, Target.Any>>> =
  Readonly<T> & { readonly [PackageTypeId]: PackageMetadata }

declare function Package<const T extends Readonly<Record<string, Target.Any>>>(options: {
  readonly targets: T
  readonly defaultVisibility?: "public"
}): PackageValue<T>

type NodeRuntimeOptions =
  | { readonly version: string; readonly manifest?: never }
  | { readonly manifest: Input.File; readonly version?: never }

interface WorkspaceOptions {
  readonly repository: string
  readonly cache: Cache.Declaration
  readonly runtime: Runtime.Declaration
  readonly packageManager: PackageManager.Declaration
  readonly nodeModules: Npm.NodeModulesDeclaration
  readonly flags?: Flags.Declaration
  readonly host?: Host.Declaration
  readonly gitHooks?: Readonly<Partial<{
    preCommit: Target.Runnable
    postCommit: Target.Runnable
    prePush: Target.Runnable
    postMerge: Target.Runnable
  }>>
  readonly layer?: Layer.Layer<unknown>
}

declare function Workspace<const Name extends string>(
  name: Name,
  options: WorkspaceOptions,
): Workspace<Name>
```

`Package` must return the target properties directly, because every cross-package prototype uses `import { Package as src } ...; src.build`. Its marker and options should be hidden under non-enumerable symbols. Do not expose a public `.targets` property that can collide with a target named `targets`; do not use a Proxy. Copy own enumerable string data properties from a plain, non-proxy `targets` object, validate every value as a target, define immutable properties, attach immutable symbol metadata, then freeze the result. Type inference must preserve exact keys and exact target types.

`defaultVisibility` defaults to and in v1 accepts only `public`: nested Artsy packages omit it while their comments and cross-package imports treat listed targets as public. Omission from `targets` is the privacy mechanism. Reject `private` until an authorization consumer and semantics exist. A future per-target visibility override should be a separate typed wrapper.

`S.Runtime.Node` accepts the exclusive `NodeRuntimeOptions` union: WhatsABI pins a literal version and Force derives it from the manifest. `Github.Setup` + `Github.Workflow` + `Github.CiGen` is the final primitive CI API; WhatsABI's compact `Github.Ci` is a typed macro that expands into the same declarations and executor path.

## 6. Required semantic contract

### 6.1 Discovery and ownership

- Inventory and static extraction perform no repository module evaluation. Accept only direct `export const Package = S.Package({ targets: { ... } })` syntax with statically enumerable direct object keys; reject spreads, computed keys, accessors, conditional construction, later mutation, and re-exports. Target values may be identifiers or direct expressions because only keys are extracted.
- Static extraction returns format version, relative module/package paths, sorted keys, direct Package imports/resolutions, and spans. Use a TypeScript-compatible parser behind `PackageMetadataExtractor`; do not extend registry's flow tokenizer into a general evaluator.
- Build the complete label/import graph before loading Workspace or Package code. Metadata/list/unknown-label operations execute no author code. After lazy evaluation, byte-compare runtime Package keys to static keys; mismatch is fatal `package_static_runtime_mismatch`.
- The workspace root contains exactly one regular, admitted `WORKSPACE.ts` with exactly one runtime `Workspace` export.
- Any admitted directory may contain at most one exact-case `PACKAGE.ts`. The path relative to the canonical workspace root is its package name; root is the empty package.
- A package module must export exactly one runtime `Package` value named `Package`. Type-only exports are irrelevant. Additional helper runtime exports may be allowed only if they are not Targets, Package values, or Workspace values; exporting a naked target is a fatal `legacy_target_export` diagnostic so accidental public exposure cannot return.
- Only keys in the explicit package map create labels. Construction call sites and local variable names never create identities.
- Importing a `Package` and reading a target property creates a dependency edge through normal target object identity; it does not create a second label.
- The router records canonical source module, package directory, target key, label, declaration object, content/import-closure digest, and visibility as separate facts.
- Target computation context is bound by the validated package index, not guessed from the target constructor's stack. When indexing a package, traverse each explicit target's dependency closure. Bind unowned, reachable local targets to that package (this covers omitted private helper targets); preserve the existing owner of targets reached through an imported Package; reject an unbound target reachable as a local of two packages. The executor supplies the bound package directory to the target implementation. This requires refactoring the current Flow body, which captures `sourceSite()` at construction, into an implementation callable evaluated with index-owned context.

### 6.2 Labels and precedence

- Canonical labels remain `//<posix-package-path>:<target>`, with root `//:<target>`.
- Existing shorthand `//pkg` may select a documented default target only. Do not guess from object insertion order. Recommended order remains explicit `default`, then a sole public target; otherwise return `ambiguous_default_target`.
- Subtree patterns are selection syntax, never route identities.
- Package path segments are normalized workspace-relative POSIX segments. Reject empty, `.`, `..`, backslash, NUL, absolute/drive/UNC paths, and Unicode strings that are not NFC.
- Target keys should use a portable ASCII grammar such as `[A-Za-z_][A-Za-z0-9._-]*`; reject `:`, `/`, `\\`, whitespace, controls, and reserved CLI syntax. Package directory segments must allow real examples such as `.github`, `.storybook`, and hyphens but must still reject `.`/`..` and separators.
- Compare and emit using an explicit UTF-16 code-unit comparator, not locale-sensitive `localeCompare`. Detect case-fold collisions (`Foo`/`foo`) even on a case-sensitive host so a graph cannot be checked out differently on Windows/macOS.
- Two labels for the same target object are fatal. Two Package modules for the same canonical directory are fatal. Two physical paths canonicalizing to one module are fatal unless they are the same admitted in-workspace symlink and policy explicitly permits it.

### 6.3 Module graph and cycles

Package imports are a real directed module graph. Force imports `src.Package` at root and root Package in workflows; WhatsABI deliberately avoids an `examples`/`src` cycle and comments on it. The loader must:

1. discover file names without evaluation;
2. parse local PACKAGE import specifiers sufficiently to build an initial graph or, at minimum, instrument the loader to report a deterministic import chain;
3. reject Package-to-Package cycles with `package_import_cycle` and the full relative chain before target indexing;
4. accept `.js` specifiers resolving to sibling `.ts` during source execution, while emitted JavaScript resolves the same `.js` path normally;
5. never rely on evaluation order as collision precedence.

Workspace importing root Package for hook targets is allowed and is one-way: no Package module may import `WORKSPACE.ts`.

### 6.4 Privacy

An omitted local target is constructible and usable inside its module but has no label and cannot be imported through the Package object. V1 permits only public map members and rejects `defaultVisibility:"private"` as an unsupported option. The examples use omission for privacy, and accepting an unenforced private literal would be a false access-control promise. A future private/visibility feature requires an authorization consumer and must enforce at graph resolution, manifest disclosure, completion, and CLI access—not display filtering.

### 6.5 Workspace configuration

`S.Workspace(name, options)` is a data declaration with branded, immutable fields. The router validates one workspace name and a known set of typed service declarations: repository, cache, runtime, package manager, installed modules, flags, host, and git hooks as demonstrated. Direct named fields are the primary API. WhatsABI `WORKSPACE.ts:28-31` says `layer` remains an escape hatch, but neither final example exercises it; therefore treat `layer?: Layer` as a proposed advanced option, require it to compose with rather than override named fields, and keep it out of serializable manifests. Secrets remain references by environment-variable name; values must never appear in the declaration, manifest, diagnostics, or target keys.

The existing `Config.Workspace({cacheDirectory,gitignored})` and separate root RemoteCache export should be replaced, not overloaded. Cache/host configuration is host state unless a target explicitly copies a declaration into attrs; target computation keys include only the resolved toolchain identities that affect computation.

### 6.6 CLI invocation surface and git hooks

Force's `AGENTS.md` (lines 31-40) fixes the partner-facing CLI form: the
binary is `smithers`, invoked with a bare label and no verb (`smithers
//:prePush`), and `--fix` may be added to any lint target. The contract:

- A bare exact label resolves the target's flavor to its primary verb and
  runs it: a Suite runs its tests, a Test tests, a Build builds, a
  Generate/Diff/Lint/CiGen target runs its check mode. `--fix` selects fix
  mode on agent lints; `--write` selects write mode on generators and CI
  generation. Each mode is a distinct verb view with its own cache key.
- Verb-first forms remain for patterns (`smithers test //src/...`) and behave
  as today's planner filtering by flavor.
- Run/Serve and outward targets execute only when named explicitly; a pattern
  never selects them (the existing `Verb.ts` pipeline law, generalized).

`gitHooks` in `S.Workspace` binds git hook events to ordinary targets
(Force binds `preCommit`, `postCommit`, `prePush`, `postMerge`; `postCommit`
is a Suite that refreshes generated outputs the commit touched — cache hits
make it a no-op for unrelated commits). Hook installation is generated,
drift-checked output like CI generation: the CLI emits `.git/hooks/*` scripts
that invoke the bound label, `--check` compares, and nothing else writes
them. This is the workspace-level replacement for husky-style tooling. A hook
script must degrade cleanly when the CLI is absent (fail open with a printed
warning, never block a commit on a missing binary), and hook bindings accept
only gate-capable targets (suites, tests, checks) — never outward or Serve
targets.

## 7. Architectural boundaries

### 7.1 `@smthrs/targets`: authoring values only

Own `Package`, `Workspace`, their symbol brands, strict guards, schemas, and exact generic types. It may depend on target declarations but not on Node filesystem traversal or `tsx`. Package/Workspace constructors must be usable in typecheck/bundled declaration contexts and must not inspect call stacks. `Target.make` must stop using `sourceFile` as routing identity. Its current package-relative implementation context must move to an index-owned binding supplied when the target body is planned/executed; until that refactor lands, the old stack field may remain diagnostic-only and must never decide a label.

### 7.2 `@smthrs/build-cli`: Node source loader and graph index

Own workspace discovery, source-module execution, labels, query/planner adapter, watch mode, and generated manifest commands. Split the current 1,300-line `Workspace.ts` into explicit modules so security and cache invariants are reviewable:

- `WorkspaceInventory.ts` — Git/fallback inventory and deterministic normalized paths.
- `ModuleAdmission.ts` — canonical root, safe regular files, symlink/hardlink policy, bounded reads.
- `PackageDiscovery.ts` — exact file discovery and case/canonical collision checks, no evaluation.
- `PackageMetadataExtractor.ts` — narrow TypeScript key/import/span extraction, no evaluation.
- `PackageLoader.ts` — digest/import-closure keyed trusted TS execution and export validation.
- `WorkspaceLoader.ts` — root WORKSPACE load and schema validation.
- `PackageIndex.ts` — immutable label/target/module maps and privacy/collision checks.
- `Manifest.ts` / `Generate.ts` — serializable graph and generated static-loader artifacts.
- `Watch.ts` — atomic incremental refresh.

The planner/executor/query layers consume `PackageIndex` and should not know how TypeScript was loaded.

### 7.3 `@smthrs/registry`: flow discovery remains independent

Keep flow directories, Markdown skills, progressive disclosure, flow UI metadata, schema refs, and registry source precedence here. If CLI projection remains valuable, make it consume `Registry`/`Control` directly in the CLI package. Do not copy Package routing into registry; package modules are trusted executable build declarations, while registry discovery deliberately avoids evaluation.

### 7.4 Shared path contract

Factor a small platform-neutral module only if duplication proves real: normalized relative paths, containment checks over already-canonical paths, code-unit sorting, and structured diagnostics. Actual realpath/stat/read/import operations stay behind host adapters. Avoid a vague generic `FileRouter` abstraction; the two discovery domains have different entry rules, error severity, precedence, and evaluation laws.

### 7.5 Core, kernel, platform, build, and artifact boundaries

- `@smthrs/core` remains portable Flow/Node/Graph/key semantics; it does not learn repository inventory, TypeScript parsing, or Node loaders.
- `@smthrs/kernel` owns host-neutral Workspace/FileSystem/ChildProcess contracts and confinement semantics. `@smthrs/platform-node` supplies Git/process/module evaluation and descriptor-relative atomic filesystem behavior. Bun conforms to the same contract; browser consumes manifests but never declaration source.
- `@smthrs/build` resolves Workspace declarations into Runtime/PackageManager/Install Layers and owns execution services, not labels or source routing.
- `@smthrs/artifacts` owns immutable content-addressed bytes and output-tree storage. PackageIndex refers to artifacts; it does not implement another CAS.

## 8. Generated code and type strategy

### 8.1 No declaration merging for package imports

Cross-package TypeScript types flow through ordinary ESM imports because `Package` preserves the exact target-map generic. This is stronger and simpler than the old `Route.Name/Input/Output` aliases and requires no generated registry for authoring.

### 8.2 Generated runtime manifest

Generate two deterministic artifacts from a successfully validated snapshot:

1. a JSON-safe manifest containing format version, workspace name, canonical labels, relative module paths, target keys, target kind/schema identity digests, visibility, and dependency labels; never absolute paths, functions, secrets, or target attrs that are not explicitly serializable;
2. an ESM loader table with statically spelled imports for targets a bundler must include.

Example shape:

```ts
// generated; stable code-unit order
import { Package as p0 } from "../PACKAGE.js"
import { Package as p1 } from "../src/PACKAGE.js"
export const targets = {
  "//:test": () => p0.test,
  "//src:build": () => p1.build,
} as const
```

The source loader is for CLI/dev; the generated module is for packaged CLI, browser graph viewers, Vite/Rspack, and environments with no filesystem traversal. `generate --check` renders in memory and byte-compares. Publication is temp-file + fsync where supported + atomic rename, retaining the old file on failure. Headers include generator ABI, but timestamps and absolute roots are forbidden.

Generated files should be ignored by default if they are cache artifacts, consistent with the later Flows3 decision; applications may opt into a checked-in mirror with `@generated` and a drift gate. Force's `appRoutes.gen.ts` is application output of an ordinary `S.Generate` target and remains separate from the router manifest.

The JSON manifest, static loader, and optional declarations carry the same generator ABI and validated snapshot digest. A consumer must refuse an unknown ABI or mismatched/stale artifact set and request regeneration; it may never pair an old loader with a new manifest. Watch publication swaps the in-memory snapshot first only after validation, then publishes one complete digest-bound artifact set without invalidating the last-good set on failure.

### 8.3 Real declarations replace ambient `any`

Both Artsy repositories must remove `smithers.d.ts` after installing the real packages. Add a dedicated no-emit config that includes every `PACKAGE.ts` and `WORKSPACE.ts`, uses the repository's real module resolution, and does not ship build declarations in the application's published library. This gate must catch invalid target attrs, absent Package properties, cycles visible to TypeScript, and `.js`/`.ts` resolution errors.

## 9. Runtime loading, bundlers, and portability

### 9.1 Trust model

`PACKAGE.ts` and `WORKSPACE.ts` are trusted repository code. Evaluating them can read environment variables, import Node modules, or spawn work if authors write side effects. The loader must state this honestly; it is not a sandbox. Constructors should be inert, and lint/tests should forbid obvious declaration-time side effects, but security isolation requires a separate process/VM policy.

### 9.2 Node

Node is the source-loader reference platform. Retain `tsx` or replace it with an explicit compiler service, but hide it behind `ModuleLoader`. Cache on canonical module URL + content/import-closure digest + loader ABI + relevant compiler options. Never cache by path or mtime alone. Preserve one module instance per command so direct target identity is stable.

### 9.3 Bun

Bun may load `.ts` directly, but must pass the same conformance suite and produce the same snapshot bytes. Do not let Bun's resolver silently accept specifiers Node rejects. The safe initial support level is: run the generated/compiled ESM manifest under Bun; source-mode Bun loader is experimental until parity gates pass.

### 9.4 Browser and workers

Browsers cannot enumerate a repository or import an absolute filesystem path. They consume the JSON manifest and a bundler-generated static loader table only. Browser-safe graph/query code must not import `node:path`, `node:fs`, `node:crypto`, `process`, `tsx`, or build-module evaluation code. Executing build targets in a browser is a separate host capability question; viewing/querying the graph is supported once manifest schemas are portable.

### 9.5 Vite/Rspack/esbuild and CJS

Static import strings in generated ESM let bundlers build a module graph; never use `@vite-ignore` absolute imports. The package manifests should publish conditional `types`/`import`/`require` only for libraries that pass constructor-identity tests. Source workspace modules are ESM and use `.js` specifiers. CJS is an output format for the CLI/library, not an authoring mode for PACKAGE modules. A CommonJS application package must still evaluate PACKAGE files as isolated ESM, as the current Workspace test requires for BUILD files.

## 10. Diagnostics and error model

Use tagged errors with stable codes, phase, relative path, optional label, source span, import chain, and cause. Render human text at the CLI boundary. Minimum codes:

- inventory: `workspace_root_invalid`, `inventory_failed`, `invalid_inventory_path`, `inventory_limit_exceeded`;
- admission: `module_missing`, `module_not_regular`, `module_outside_workspace`, `module_link_collision`, `module_too_large`;
- static/load: `package_syntax_unsupported`, `workspace_syntax_unsupported`, `module_compile_failed`, `module_import_failed`, `package_import_cycle`, `runtime_import_cycle`, `unsupported_module_specifier`, `package_static_runtime_mismatch`;
- exports: `workspace_export_missing`, `workspace_export_duplicate`, `package_export_missing`, `invalid_package_export`, `legacy_target_export`;
- declarations: `invalid_package_options`, `invalid_target_key`, `invalid_target_value`, `invalid_workspace_options`, `package_mutated_after_declare`;
- identity: `duplicate_package_path`, `case_collision`, `duplicate_label`, `target_multiple_labels`, `unknown_label`, `ambiguous_default_target`, `visibility_denied`;
- generation/watch: `manifest_encode_failed`, `manifest_drift`, `manifest_write_failed`, `watch_refresh_failed`.

Malformed PACKAGE/WORKSPACE declarations, collisions, containment failures, and cycles are fatal. Warnings are limited to actionable non-lossy migration notices, such as an unused `defaultVisibility` or a legacy BUILD file that will be ignored after the cutoff. On watch refresh, diagnostics belong to the failed candidate snapshot; the last valid snapshot remains active.

Bound diagnostic detail and ensure malformed UTF-16 is made well-formed, following `Target.declarationRejected`. Never invoke getters, inspect Proxies, call `toString`, or serialize arbitrary author values while formatting an error.

## 11. High-risk invariants, failure modes, decisions, and gates

### 11.0 Pure discovery versus evaluation

Failure modes: listing targets executes arbitrary repository code, reads secrets, or spawns work; a file-only index cannot know labels; static and runtime Package maps disagree.

Chosen design: bounded inventory plus narrow AST extraction creates complete labels and the initial import graph without evaluation. Evaluate only selected closures and compare exact runtime/static keys.

Why alternatives fail: eager import-all makes metadata O(repository) and side-effectful; filename-only indexing cannot expand target patterns; a general static evaluator is unsound; registry's tokenizer implements a different narrow grammar.

Gate: fixtures with top-level throw/write/sentinel prove metadata/list/unknown-label performs zero evaluations; spreads/computed/accessors/conditionals fail with exact code/span; environment-dependent runtime keys fail `package_static_runtime_mismatch`; the partner static golden contains every label.

### 11.1 Identity must come only from package path plus explicit map key

Failure modes: stack frames point at a helper rather than the package; re-export gives two labels; minification/source maps change identity; a private local leaks because it was named-exported; direct imports create an alias label; removing stack ownership too early leaves package-relative target implementations without a correct `packageDirectory`; a private dependency used by two packages acquires two owners.

Chosen design: loader assigns labels only while indexing validated `Package.targets`; target constructors carry computation metadata but no source label. The index also builds a separate owner binding for every reachable target. Imported Package targets arrive pre-bound to their declaring package; previously unbound private dependencies bind to the package whose public closure reaches them. Planning/execution obtains `packageDirectory` from this binding rather than from a stack captured by `Target.make`.

Why alternatives fail: call-stack identity is host-specific and indirect; scanning all named exports recreates accidental-public semantics; deriving from a target's internal rule id cannot distinguish two instances of the same rule; mutating the target to attach an owner breaks reuse and concurrency; silently rebinding a private target gives the same computation two working-directory meanings.

Gate: fixtures with helpers, imported target references, local private dependency closure, the same unbound private target in two packages, two map keys pointing to one target, named naked target exports, re-exports, sourcemaps on/off, and minified compiled modules. Assert one canonical label/owner or the exact fatal code, and assert package-relative inputs/outputs resolve against the declaring Package directory.

### 11.2 Exact type/runtime agreement

Failure modes: TypeScript exposes a property runtime validation drops; a Proxy/getter runs during discovery; Package mutates after indexing; duplicate library copies disagree about markers.

Chosen design: const generic over a copied plain target map; non-enumerable `Symbol.for` marker with a versioned structural guard; no Proxy; freeze target property table and metadata.

Why alternatives fail: ambient `any` proves nothing; declaration merging does not type direct package imports; Proxy lookup hides misspellings and executes user traps; closure-only metadata breaks installed/source constructor identity.

Gate: `tsd`/`tsc` positive and `@ts-expect-error` fixtures, CJS/ESM duplicate-copy guard tests, getter/proxy adversarial values, mutation attempts, keys named like object prototype members (`constructor`, `__proto__`) on a null-prototype input.

### 11.3 Safe path containment and symlinks

Failure modes: PACKAGE link escapes root; case-insensitive alias duplicates a module; symlink target changes between validation and import; Git emits hostile path framing; relative import escapes the workspace; Windows drive/UNC path is treated as relative.

Chosen design: reuse current canonical-root/admission machinery, validate every discovered module and every local module import, compare real paths, use bounded NUL-delimited Git output, and either compile/evaluate bytes already read or revalidate digest immediately after load. Treat declaration modules outside root as fatal even if reachable by symlink.

Why alternatives fail: lexical `startsWith` containment is bypassable; validating only top-level PACKAGE leaves transitive imports as an escape; stat-then-import has a TOCTOU gap; recursive glob follows platform-specific links inconsistently.

Gate: Linux/macOS/Windows matrix with POSIX absolute, drive-relative, drive absolute, UNC, mixed separators, `..`, NUL, NFC/NFD aliases, in-root/out-root links, link swap during load, hardlinks, FIFO/socket/directory, nested symlinked directories, and relative import escape. Outside sentinel bytes must remain unread/unmodified where the harness can observe it.

### 11.4 Deterministic discovery and generation

Failure modes: filesystem enumeration order or locale changes manifest bytes; concurrent refresh publishes half a graph; duplicate Git paths get silently deduped; generated output contains root-specific paths; Force-style `localeCompare` differs by locale.

Chosen design: explicit code-unit comparator, NFC validation, canonical relative POSIX paths, no timestamps, immutable snapshot assembled completely before swap, render-before-write and atomic publication.

Why alternatives fail: `Array.sort()` assumptions are underspecified around normalization; `localeCompare` is environment-sensitive; incremental mutation exposes mixed old/new state.

Gate: shuffled inventories, duplicated entries, Turkish and C locales, two absolute roots with byte-identical content, CRLF checkout, 8 concurrent refreshes, add/delete/rename bursts, generator interruption before rename, and byte comparison across Node/Bun and three OS runners.

### 11.5 Module caching and watch invalidation

Failure modes: edited declaration reuses old namespace with same mtime; imported Package changes but importer digest does not; deletion leaves stale target; failed edit erases last valid graph; two workspaces at same path reuse a namespace.

Chosen design: cache key covers canonical identity, exact content, transitive local import closure, loader ABI and compiler config; reverse import graph drives invalidation; refresh builds a candidate snapshot and atomically swaps only on success.

Why alternatives fail: mtime/size miss preserved-timestamp edits; query-string cache busting only the entry module leaves transitive imports cached; global path cache crosses recreated workspaces.

Gate: same-size/same-mtime rewrite, dependency-only rewrite, rename, delete, workspace delete/recreate at same path, syntax error then repair, cycle introduced then removed, and repeated commands in one long process.

### 11.6 Cycles and partial evaluation

Failure modes: ESM exposes an uninitialized Package property; behavior depends on traversal order; a cycle deadlocks an async loader; diagnostics show only `undefined` rather than the chain.

Chosen design: detect Package import cycles before indexing when statically resolvable and retain runtime import-chain detection as defense in depth. Workspace may depend on Package, never reverse.

Why alternatives fail: ESM technically permits some cycles, but target declarations read imported properties during module evaluation, so temporal dead zones and partial objects become graph semantics.

Gate: self-cycle, two-node, long cycle, `.js`-to-`.ts` aliases, cycle through a helper barrel, type-only cycle (allowed), and the known acyclic Force/WhatsABI package graphs.

### 11.7 Schema and target fidelity

Failure modes: a forged target marker enters the graph; two copies of Effect/target runtime disagree; attrs contain Proxy/accessor/cycle; generated manifest loses schema identity; executor accepts input planner did not validate.

Chosen design: keep `Target.isTarget`'s descriptor-level defensive guard; validate Package maps without invoking author code; carry stable schema identity/digest in manifest; planner and executor use the same target instance and schemas. Imported Package properties retain exact target generic parameters.

Why alternatives fail: `instanceof` fails across package copies; JSON serialization of callable targets loses schema/function identity; trusting a symbol alone permits trivial forgery.

Gate: forged markers, duplicate installed package copies, proxy arrays/objects, cyclic attrs, schema version change, and round-trip manifest schema tests. Planner/executor conformance must prove the same decoded attrs and declared outputs.

### 11.8 Visibility and imports

Failure modes: omitted target still addressable by guessed label; private target imported transitively; generated manifest exposes it; CLI completion leaks its description/name.

Chosen design: index only explicit map keys; enforce any private visibility in `PackageIndex` before planning; generated public manifest filters by audience, while an internal execution snapshot can retain authorized private references.

Why alternatives fail: display-only filtering is not access control; TypeScript `private` has no runtime effect; file-local variable naming is not discoverable safely.

Gate: omitted target by CLI/query/direct guessed label; an allowed public target depending on an omitted same-package private local; a rejected external/private cross-package dependency; manifest/disclosure leakage; and default-target selection with private candidates.

### 11.9 Trusted execution and secrets

Failure modes: declaration reads/processes secrets at import time; error serializer prints them; workspace token value enters target key; generator writes outside declared output.

Chosen design: declarations use `Secret(envName)` references; environment is never cleared/mutated by loader; diagnostics inspect own data only; host config excluded from computation keys unless resolved toolchain affects work. Document trusted execution and offer a subprocess policy later.

Why alternatives fail: temporarily deleting `process.env` neither isolates executable code nor preserves concurrent process state; claiming static metadata extraction is impossible for arbitrary target constructors used in the prototypes.

Gate: concurrent environment write during load, sentinel secret in env, thrown error containing accessor traps, manifest/key scan for secret value, and subprocess lint fixture.

## 12. UI companion handling

The old `ui.tsx` sibling probe is flow-specific. None of the Artsy PACKAGE prototypes defines a PACKAGE companion UI convention. Do not carry `Route.ui` into the build package router by inertia.

Migration decision:

- flow monitor panels remain `@smthrs/registry`/future flow-framework metadata and use the old flow-directory rules;
- build/factory UI consumes the serializable Package graph manifest and typed card/view registrations owned by the UI/plugin layer;
- if a build target needs a generated UI artifact, declare it as a normal target/output in `Package.targets`;
- no ambient `PACKAGE.ui.tsx`, directory inheritance, or automatic React import is introduced without primary evidence.

Acceptance gates verify that an unrelated `ui.tsx` beside PACKAGE is ignored, that old flow `ui.tsx` detection still works in registry-facing tests if retained there, and that browser graph code bundles without React unless the UI adapter is explicitly imported.

## 13. Migration and removal strategy

1. Land the new constructors and package index behind tests while existing BUILD routing still runs.
2. Add a read-only migration checker that loads both representations and prints a deterministic mapping of `BUILD.ts` export labels to expected `PACKAGE.ts` map keys. It must not generate or overwrite author files by default.
3. Convert this repository's own root/per-directory declarations to PACKAGE/WORKSPACE in a separate mechanical change, package by package. Each checkpoint proves graph/label parity for intentionally retained public targets.
4. Switch planner/query/executor to `PackageIndex` once committed PACKAGE coverage is complete. Reject mixed `BUILD.ts`/`PACKAGE.ts` ownership in the same directory; do not merge precedence silently.
5. Delete BUILD export scanning, `PackageDefaults` discovery behavior, stack-derived source ownership, and old Config workspace loading after the switch.
6. Delete `packages/fs` old public modules and docs, or replace the package with a narrow deprecated tombstone that throws a migration diagnostic for one release only. Remove broken root/vite exports and the Vite peer either way.
7. Keep registry flow discovery untouched; update docs that currently say `@smthrs/fs` records `ui.tsx` so ownership is accurate.
8. Convert Force and WhatsABI only in conformance fixtures or external validation; do not mutate their worktrees as part of the core implementation. Replace their ambient declarations only when real published/installable packages exist.

Because backward compatibility is not required, the recommended cutover does not execute BUILD and PACKAGE graphs side by side in production. Dual execution doubles identity and cache-key risk.

## 14. Implementation phases, file-level work, checkpoints, and rollback

Before the phase details, the intended disposition of each current routing hotspot is explicit:

| Current file/surface | Final action |
|---|---|
| `packages/fs/src/FileRouter.ts` | delete the descriptor-to-Route adapter; registry remains the discovery owner |
| `packages/fs/src/Route.ts` | delete; no generic route model or dynamic absolute loader survives |
| `packages/fs/src/{Command,CommandTree,FlowInvoker,Incur}.ts` | delete from fs; reimplement only proven CLI/control needs against Registry/Control in their owning package |
| `packages/fs/src/Directive.ts` | move four-value placement parsing to the declaration/compiler owner if still consumed; do not retain fs for one helper |
| `packages/fs/src/FsError.ts` | replace with domain-specific Package/Workspace diagnostics |
| `packages/fs/src/internal/{CommandLine,SchemaBridge}.ts` | delete; CLI owns argv/schema projection if retained |
| `packages/fs/test/**` | delete old projection tests after equivalent registry separation/migration gates exist |
| `packages/fs/package.json`, build/config/docs | remove package or publish only an intentional one-release tombstone; remove nonexistent exports |
| `packages/registry/src/**` | retain; only relocate `ui.tsx` probing here/framework if that implemented behavior is still required |
| `packages/build-cli/src/Workspace.ts` | split inventory, admission, loading, indexing, generation and watch responsibilities |
| `packages/build-cli/src/{WorkspaceInventory,ModuleAdmission,PackageDiscovery,PackageMetadataExtractor}.ts` | new/extracted pure inventory, admission, and no-evaluation static metadata modules |
| `packages/build-cli/src/{PackageLoader,WorkspaceLoader,PackageIndex}.ts` | new trusted loading boundary and immutable identity/owner index |
| `packages/build-cli/src/{Manifest,Generate,Watch}.ts` | new digest-bound portable artifacts and atomic refresh |
| `packages/build-cli/src/Label.ts` | retain syntax but harden portable target/package grammar and ambiguity rules |
| `packages/build-cli/src/{Planner,Query,GraphOutput,Executor,Cli}.ts` | depend on immutable workspace-index interface, then switch to PackageIndex |
| `packages/targets/src/Target.ts` | preserve schemas/guards/digests; replace stack-owned execution context with index binding and remove stack-derived labels |
| `packages/targets/src/Config.ts` | replace old workspace declaration with the exact named-field Workspace contract |
| `packages/targets/src/PackageDefaults.ts` | remove discovery-time synthesis after explicit Package migration, unless redesigned as an ordinary explicit target macro |
| `packages/targets/src/{Smithers,index}.ts` | add typed Package/Workspace while preserving the root `Smithers`-only export contract |
| root/per-directory `BUILD.ts` | migrate to root `WORKSPACE.ts` and per-directory `PACKAGE.ts`, then delete |
| `../docs/reference/fs.md` and file-framework status docs | rewrite ownership/status; remove broken generation/Vite claims |

### Phase 0 — contract fixtures and golden inventory

Work:

- Add sanitized fixture packages under `packages/build-cli/test/fixtures/package-routing/{force,whatsabi}` that preserve the routing shapes, imports, privacy, workspace fields, cycles avoided, and `.js` specifiers without copying unrelated app code.
- Add golden expected labels/import edges/workspace config/manifest bytes.
- Record existing BUILD graph labels for this repository via a read-only test helper.

Gate: fixtures typecheck only against a temporary strict contract, and golden inventories are stable on Linux/macOS/Windows. No production loader change.

Checkpoint/rollback: test-only commit; removing fixtures returns exactly to old behavior.

### Phase 1 — authoring constructors

Files:

- add `packages/targets/src/Package.ts` and `WorkspaceDeclaration.ts`;
- refactor/replace `Config.ts` without overloading the old constructor;
- export `Package` and new `Workspace` from `Smithers.ts`; preserve root namespace-only invariant in `index.ts`;
- add `packages/targets/test/{Package,WorkspaceDeclaration}.test.ts` and strict compile fixtures;
- update package README/API docs.

Gate: exact generic property inference, runtime guard/mutation/proxy/forgery suite, CJS/ESM constructor identity, no Node call-stack dependency in the new constructors.

Checkpoint/rollback: constructors are additive and unused by planner.

### Phase 2 — discovery and admission

Files:

- extract current inventory/admission logic from `Workspace.ts` into `WorkspaceInventory.ts` and `ModuleAdmission.ts` with behavior-preserving tests;
- add `PackageDiscovery.ts`, `PackageMetadataExtractor.ts`, and no-evaluation workspace discovery;
- add OS/adversarial fixture tests and diagnostic schemas.

Gate: old Workspace tests remain green; exact PACKAGE/WORKSPACE inventory, static label/import goldens, unsupported-syntax spans, case collision, symlink/path-containment and resource-limit matrices pass; instrumented metadata/list/unknown-label operations perform zero target module evaluations.

Checkpoint/rollback: new discovery is queryable but planner still uses BUILD loader.

### Phase 3 — source module loader and package graph

Files:

- add `PackageLoader.ts`, `WorkspaceLoader.ts`, `PackageIndex.ts`, and `PackageError.ts`/diagnostic codes;
- factor module-cache logic from `Workspace.ts` into a loader service;
- update `Target.ts` so route ownership no longer depends on `sourceSite`; introduce index-owned implementation context for package-relative behavior, retaining stack source spans only as optional constructor diagnostics during the transition;
- add import graph/cycle tests and exact Force/WhatsABI fixture conformance.

Gate: all labels derive from statically extracted path+map key; evaluated keys byte-match static keys; private omissions are invisible; direct imports preserve exact identity; transitive changes invalidate; failed candidate loads leave prior snapshot untouched; no target gets two labels.

Checkpoint/rollback: package index exists beside old `Workspace` index; no CLI switch.

### Phase 4 — planner/query/executor adapter

Files:

- define a small immutable workspace-index interface consumed by `Planner.ts`, `Query.ts`, `GraphOutput.ts`, `Executor.ts`, and `Cli.ts`;
- adapt old BUILD index first, then PackageIndex, to prove consumer separation;
- port label/default/subtree selection tests to PackageIndex;
- remove structural duplicate-module workarounds once exact module identity is proven.

Gate: planner plans fixture targets with identical dependency/attrs/schema/output semantics; query and graph output are deterministic; read-only CLI remains read-only; execution uses only indexed target objects.

Checkpoint/rollback: CLI selection flag can remain test-only until parity; rollback selects old adapter.

### Phase 5 — generation and watch

Files:

- add `Manifest.ts`, `Generate.ts`, `Watch.ts` and public CLI verbs `generate`/`generate --check`;
- add portable manifest schema to a Node-free subpath;
- add Vite/Rspack/esbuild fixture builds using static generated loaders.

Gate: byte-identical generation across roots/OS/runtimes; atomic failure tests; browser bundle has no Node builtins; watch add/change/delete/rename/cycle-repair suite; stale last-good snapshot retained.

Checkpoint/rollback: generated artifacts are optional; source CLI still works.

### Phase 5A — artifact and edge execution foundation

Files:

- extend target flavor/mode/edge metadata and planner/executor views;
- integrate output-tree manifests and atomic materialization with `@smthrs/artifacts`;
- implement the Shell Build/Test/Run/Diff, Generate, Copy, Materialize, Suite, Test, and Alias subset required for representative dogfood;
- add toolchain keying and write-set enforcement before enabling shared cache admission.

Gate: artifact/edge/write-set and key/secret gates in §15.3 pass; shell/generator conformance reaches L3; a restored artifact builds a dependent without producer re-execution; no cacheable target lacks measured toolchain identity.

Checkpoint/rollback: constructors remain unused by production Package declarations until their individual L3 gates.

### Phase 5B — independently gated capability lanes

- Lane A: gates, services, git/npm/GitHub outward targets, and durable approvals.
- Lane B: Agent/Input/MCP, overlay write enforcement, vacuous green, and bounded gate loops.
- Lane C: resolver, file algebra, Markdown blocks, and Bundler.
- Lane D: CI generation, affected equivalence, and Cron projection.

Each lane lands real schemas, types, implementation tests, key-material tests, diagnostics, and partner dry-run cases. The routing cutover need not wait for every lane if unsupported symbols are explicit catalog gaps, but full Force/WhatsABI execution validation does. No lane may use a permissive stub or report fake success.

### Phase 6 — repository dogfood migration

Files:

- add root `WORKSPACE.ts` and `PACKAGE.ts` plus per-directory PACKAGE files;
- update root TypeScript build-file include gate and package scripts;
- replace direct BUILD imports with `Package` imports;
- intentionally map every old public label or record its removal;
- update `CommittedBuildFiles.test.ts`, target-generation docs, examples, and CI.

Gate: complete old/new label delta reviewed; clean checkout can query, plan, and run representative build/test/lint/run/docs targets; cache keys change only where ownership/toolchain semantics intentionally changed; no ambient declarations.

Checkpoint/rollback: migrate in dependency-topological package batches; each batch has a graph golden. Do not remove BUILD loader until the final coverage gate.

### Phase 7 — cutover and deletion

Files:

- make PackageIndex the only `Workspace` implementation;
- delete BUILD export scanning, stack ownership and synthesis branches;
- remove/replace old `@smthrs/fs` sources, tests, Vite peer, broken exports, docs, and lockfile dependencies;
- update `packages/build/{DESIGN,API-REVIEW,WIRING}.md`, label/workspace docs, implementation status, changelogs, and release notes;
- make `@smthrs/targets` and `@smthrs/build-cli` publishable if Artsy is to install them (`private:true` currently contradicts that use).

Gate: repository search finds no production `BUILD.ts`, `FileRouter`, `Route.load`, old `Route.Name/Input/Output`, or broken `@smthrs/fs/vite` reference; package tarball export tests pass for ESM/CJS/types; two Artsy fixture graphs load and typecheck strictly.

Checkpoint/rollback: last pre-deletion checkpoint is the rollback boundary. After deletion, rollback is a normal revert of the cutover change, not a runtime compatibility switch.

### Phase 8 — external prototype validation

Against disposable clean copies of Force and WhatsABI, not their dirty source worktrees:

- install built tarballs;
- remove only the prototype ambient declarations in the copy;
- include PACKAGE/WORKSPACE files in a no-emit config;
- run discovery, manifest generation/check, query/graph, and representative dry-run planning;
- compare expected public targets and import edges; verify private locals absent.

Gate: both repositories pass without loader-specific source edits. App-specific target constructors not yet implemented must produce an explicit catalog-gap list; routing conformance is not waived by `any`.

## 15. Catalog delta separate from routing

The Artsy files exercise many namespaces absent from today's `Smithers.ts`: `Shell.*`, `Suite`, `Test`, `Generate`, `Alias`, `Copy`, `Materialize`, `ImportClosure`, `Files.difference`, `Bundler.Rspack`, `Agent.*`, `Git.*`, `Github.*`, `Npm.*`, `Api.Compat`, `Markdown.CodeBlocks`, `Cron`, richer Runtime/PackageManager/Host/Flags/NodeModule helpers, and more. These are target-catalog work, not reasons to weaken the router types.

### 15.1 Exact observed surface and prototype divergences

| Domain | Required observed API |
|---|---|
| files | `file`, `glob`, `Filegroup`, `gitDiff`, `ImportClosure`, `Files.difference`, `Markdown.CodeBlocks` |
| tool references | `NodeModule`, `NodeModule.Bin`, `PackageManager.bin`, `Runtime.bin`, `Runtime.npx`, `Host.bin` |
| shell | `Shell.Build`, `Shell.Test`, `Shell.Run`, `Shell.Serve`, `Shell.Diff` |
| composition | `Generate`, `Materialize`, `Copy`, `Test`, `Suite`, `Alias` |
| agent | `Agent.Codex`, `Agent.Lint`, `Agent.Diff`, `Agent.Pr`, `Input.*`, `Mcp.Http` |
| git/npm/API | `Git.Commit`, `Git.Pr`, `Npm.Pack`, `Npm.Publish`, `Npm.Published`, `Api.Compat` |
| GitHub | `Github.Pages`, `Github.Release`, `Github.Setup`, `Github.Workflow`, `Github.CiGen`, compact `Github.Ci` |
| bundler/trigger | `Bundler.make`, `Bundler.Rspack().resolve/build`, `Cron` |
| workspace | `Cache`, `Runtime.Node`, `PackageManager.Pnpm/Yarn`, `Npm.NodeModules`, `Host`, `Flags`, `Secret` |

Exact observed spellings are `S.file`, `S.glob`, `S.gitDiff`, `S.Filegroup`, `S.ImportClosure`, `S.Files.difference`, `S.Markdown.CodeBlocks`, `S.NodeModule`, `S.NodeModule.Bin`, `S.PackageManager.bin`, `S.Runtime.bin`, `S.Runtime.npx`, `S.Host.bin`, `S.Shell.Build`, `S.Shell.Test`, `S.Shell.Run`, `S.Shell.Serve`, `S.Shell.Diff`, `S.Generate`, `S.Materialize`, `S.Copy`, `S.Test`, `S.Suite`, `S.Alias`, `S.Agent.Codex`, `S.Agent.Lint`, `S.Agent.Diff`, `S.Agent.Pr`, `S.Input.String`, `S.Input.Optional`, `S.Input.Literals`, `S.Mcp.Http`, `S.Git.Commit`, `S.Git.Pr`, `S.Npm.Pack`, `S.Npm.Publish`, `S.Npm.Published`, `S.Api.Compat`, `S.Github.Pages`, `S.Github.Release`, `S.Github.Setup`, `S.Github.Workflow`, `S.Github.CiGen`, `S.Github.Ci`, `S.Bundler.make`, `S.Bundler.Rspack`, `S.Cron`, `S.Cache`, `S.Runtime.Node`, `S.PackageManager.Pnpm`, `S.PackageManager.Yarn`, `S.Npm.NodeModules`, `S.Host`, `S.Flags`, and `S.Secret`.

Cross-cutting attrs requiring real schemas are `data`, `outDirs`, `args`, `runtimeArgs`, `env`, `secrets`, `sandbox`, `approval`, `gates`, `changes`, `fixes`, `readiness`, `health`, `stop`, `services`, `maxRounds`, `payload`, `mcp`, `prompt`, `agent`, and the exclusive executable selector `bin | script | command`. `S.Flags.production` demonstrates typed property projection from declared flags. The coverage ledger must record each attr's allowed flavor, key-material behavior, output type, side-effect tier, and implementation owner.

Constructor semantics the prototypes pin beyond the symbol list (each is a
conformance case, sourced from the cited file):

- `S.Generate` has three observed forms (whatsabi `src/PACKAGE.ts`; Force
  root and `src/PACKAGE.ts`): `{bin, args, data, stdout: "file"}` where the
  tool prints the file's next contents; `{script, data, changes: [globs]}`
  where the script writes inside the write-set; `{data, emit: {path: text}}`
  as a literal emit with no tool. All three share check-by-default and
  `--write`.
- `S.gitDiff` accepts no argument, `{paths}`, `{added}`, or `{paths,
  addedLines: regex}` (Force root `testAccuracyLint`). The filtered diff
  content is key material; an empty filtered set makes a consuming agent
  target vacuously green, so static prechecks are expressed as data.
- `S.Filegroup.srcs` accepts build targets, not only globs (whatsabi
  `buildEsm = Filegroup({srcs: [compileEsm, esmPackageStamp]})`): a group of
  artifact producers is itself a materializable file set.
- `S.Npm.Pack` knows `<name>-<version>.tgz` naming from the manifest;
  `S.Npm.Published({manifest})` fetches the last published version's
  declaration files, content-addressed by version, as the `S.Api.Compat`
  baseline; `Api.Compat` classifies the API delta patch/minor/major and
  fails when the manifest version does not cover it (whatsabi root).
- `S.Markdown.CodeBlocks({file, lang})` derives virtual modules from fenced
  blocks so README snippets type-check against the local emit through the
  manifest's `exports` map (whatsabi `checkReadme` — an end-to-end
  conformance case for virtual files plus package-exports resolution).
- `S.Cron({schedule, refresh, run})` re-executes the `refresh` build targets
  bypassing cache reads, publishes their new results, then runs `run`
  against the refreshed store (whatsabi `refreshFixtures`: scheduled
  re-recording so fixture rot surfaces weekly, not during unrelated PRs).
- The hermetic-recording pattern (whatsabi `recordFixtures` -> `test`): a
  network-enabled Build's output tree is the response store; tests take it as
  `data` and replay with no network in their own sandbox. This pattern is the
  template for every record/replay target and depends on artifact
  materialization working.
- Per-app test targets key on `S.ImportClosure({entries: srcs})` plus shared
  configs (Force `src/Apps/*/PACKAGE.ts`), so an edit the app cannot reach is
  a cache hit; `.storybook` keys on the closure of story files, including
  cross-package `//src/**` globs in `entries`.
- `S.Shell.Serve` probes (Force `src/PACKAGE.ts`, `.storybook`, whatsabi
  `serveDocs`): `readiness: {port}` or `{http, timeout}` gates dependents;
  `health: {interval, failures}` repeats the same probe while dependents run
  and fails them on consecutive misses; `stop: {signal, grace}` is the
  graceful-exit contract before the kill. Omitting `health` is deliberate
  where probing lies (`startProdDebug`: a debugger pause is not an unhealthy
  server); omitting probes entirely is legal for portless serves (whatsabi
  `watch`), where liveness is process liveness.

Do not add `S.Go.*` or optimism/viem-only surfaces in this routing drive; those repositories were explicitly outside the audited API examples. Do not add a scheduler, dynamic graph fan-out, or a claim of hermetic subprocess execution.

Resolve the two prototype disagreements explicitly:

- Force's `Github.Setup` + `Github.Workflow` + `Github.CiGen` is the canonical primitive because it models reusable setup, separate workflows, preserved handwritten files, and drift checking. WhatsABI's `Github.Ci` is a typed macro lowering to the same intermediate representation, not a second executor.
- `Runtime.Node({version})` and `Runtime.Node({manifest})` are both canonical and form an exclusive union.
- `Npm.NodeModules({packageJson})` replaces the old authoring-level `Install`; runtime, manager, and lockfile arrive through Layer requirements.
- Plain TypeScript functions create target matrices. Do not introduce dynamic in-graph fan-out.
- `PackageDefaults` is not retained for undeclared directories. Explicit repository-local macros may return targets, but authors must place them in a Package map.

### 15.2 Graph semantics the index must preserve

Target constructors have a flavor; check/write/fix are modes with distinct validated attrs and cache keys. Three edges are separate:

1. `data` means materialize producer files. File/filegroup/artifact producers are legal; Run/Serve/outward targets are illegal, including transitively.
2. `gates` means execute or cache-hit green immediately before the consumer. Agent gates check the exact candidate tree.
3. `services` means acquire a Serve target, await bounded readiness, keep probing its health while consumers run, scope it to them, and always release it through the declared stop contract.

There is no `onSuccess` edge: will removed it from the spec on 2026-08-25
(the Force prototypes dropped `onSuccess: beep.beep` and the beep imports;
beep remains a standalone Run target). A follow-on side effect is the
invoker's concern, never graph structure — a fourth edge kind whose only
observed use was a celebration sound did not pay for its scheduling and
key-material rules.

`Suite.tests` accepts check/test-capable targets only. Run and outward targets appear only under explicit invocation.

Output directories become CAS tree manifests of relative path, blob digest, and mode. On a hit, verify every blob and atomically materialize every data edge before dispatch. Never symlink a writable worktree into CAS. Lock concurrent output roots, leave old or new whole trees, and make `Materialize(build)` the explicit editor/dev target.

Agent targets use DI-provided agents; empty expanded diff/data is green without spawning. Candidate writes occur in an overlay and are mechanically limited by `changes`/`fixes`, including symlink resolution. Gates run after every bounded round against the exact candidate. Decode payload and test MCP reachability before model spend. Exhaustion preserves diff/gate artifacts.

Serve targets are scoped resources with a full probe contract, demonstrated in the revised prototypes (Force `src/PACKAGE.ts` dev/startProd, `.storybook`, whatsabi `serveDocs`): `readiness` gates dependents and takes a `{port}` or `{http, timeout}` probe; `health` repeats the same probe on an `interval` while anything depends on the service, and `failures` consecutive misses fail the dependent (with the service's log tail) instead of hanging it — a target may omit `health` when liveness must not be probed, as `startProdDebug` does because a debugger pause is not an unhealthy server; `stop` is the graceful-exit contract (`{signal, grace}`) applied before the process group is killed. Per-command refcount sharing and guaranteed teardown apply regardless of probes. Publish/release/PR/pages/commit targets are explicit roots, freshly gated, idempotency-guarded where possible, side-effect-tiered, and use durable approval for `approval:"required"`. Secret values substitute only at the final process/provider edge.

Resolver rows key on file digest, resolver-config digest, and implementation fingerprint; unresolved/dynamic outcomes are explicit and dead-code checks fail closed. Bundler builds key on the resolved graph, not the declared universe. CI affected selection uses the same expanded-input implementation as keying, so affected must equal would-re-key. Cron projects onto generated GitHub schedules and the existing trigger door; it does not add a scheduler.

Sandbox declarations are policy/key material, but current subprocess execution is not generally OS-hermetic (`packages/build/DESIGN.md:20-21,248-260`). V1 narrows env/secrets and documents this Tier-0 truth. OS network/filesystem isolation is a later gated capability.

### 15.3 Capability risks and gates

#### Artifact, edge, and write-set integrity

Failure modes: data starts a Run/Serve target; a hit restores a partial/wrong tree; CAS is mutated through a link; a tool/agent writes outside its set.

Selected design: typed plus runtime edge validation, verified CAS tree manifests, atomic materialization, scratch-overlay write enforcement.

Rejected alternatives: “dependency means execute,” output-existence-only hits, writable CAS symlinks, prompt-only write discipline.

Adversarial tests: nested illegal data target; missing/tampered blob; kill/race/case-colliding output roots; writes to sibling, `.git`, deletion, and out-of-set symlink; check-mode mutation.

Gate: no consumer dispatch before verified files exist; every failed case leaves worktree and CAS whole; plan goldens distinguish all three edges.

#### Agent, service, and outward lifecycle

Failure modes: empty diff spends tokens; gates check a different tree; loop is unbounded; server leaks; publish uses stale gates or acts twice; approval disappears on crash.

Selected design: vacuous green before spawn, bounded candidate/gate loop, scoped services, fresh pre-action gate plus drift check, provider idempotency, durable approval.

Rejected alternatives: prompt-only safety, unbounded retry, global service daemon, autonomous invocation as irreversible consent, ephemeral approval prompt.

Adversarial tests: fake-agent never-spawn/converge/exhaust/flake/missing-input/MCP/write escape; shared service/readiness timeout/mid-run health failure (server dies or stops answering while a dependent runs)/probe-flap below the failures threshold/SIGINT and stop-grace expiry; provider double invoke/crash after green/deny/resume/secret scan.

Gate: deterministic fake conformance proves hard bounds, teardown, at-most-one outward effect, and durable decision replay.

#### Resolver and affected-mode correctness

Failure modes: missed import marks live code dead; dynamic import is silently omitted; unrelated universe edit rekeys build; affected CI skips a re-keyed target.

Selected design: explicit memoized rows, fail-closed unresolved/dynamic status, closure-based keys, one expanded-input engine for cache and CI.

Rejected alternatives: regex-only resolution, dropping unresolved edges, universe-based build keys, separate CI globs.

Adversarial tests: ESM/CJS/tsconfig paths/package exports/extension probing/dynamic expression; one-file row invalidation counter; graph-vs-universe edits; synthetic diff matrix.

Gate: stable cross-host golden closures, minimal row recomputation, and `affected(target) === keyChanged(target)` for every matrix case.

#### Key material, secrets, and environment

Failure modes: new attrs bypass the injective encoder; secret value/checkout path enters a shared key; toolchain drift fails to re-key; diagnostics leak; loader mutates global environment.

Selected design: every constructor uses the current canonical key path. Flavor/mode/implementation/policy/secret names/toolchain/gates/services/resolver identity key; values/cache roots/absolute checkout paths do not. Loader never clears or rewrites `process.env`.

Rejected alternatives: arbitrary attr JSON, secret values in declarations, temporary global env scrubbing, caching before toolchain measurement.

Adversarial tests: per-constructor property suite, two roots, secret-name/value changes, concurrent env writer, accessor with sentinel secret, artifact byte scan, tool version drift.

Gate: injectivity passes; secret value is absent from plan/manifest/diagnostic/log/cache; environment remains byte-for-byte equivalent.

Track them as a generated API coverage table:

- symbol used in Force/WhatsABI;
- current equivalent, if any (`TsBuild`, `Vitest`, `NpmPublish`, etc.);
- required attrs and output type inferred from actual calls;
- implementation state and owning module;
- routing fixture can use a minimal real target constructor only when semantics are irrelevant.

External validation is complete only when every used symbol is either implemented with its own semantic tests or explicitly declared outside the routing milestone. Never reintroduce the permissive ambient callable as a compatibility layer.

## 16. Cross-platform and adversarial acceptance matrix

Run the core matrix on Node 22/26 on Linux, macOS, and Windows; run portable snapshot/generation tests on current supported Bun; bundle portable entries with Vite, Rspack, and esbuild.

| Area | Required cases | Pass condition |
|---|---|---|
| Inventory | Git tracked, untracked, ignored, nested ignore, no Git, non-worktree, malformed NUL, duplicate path, oversized output | exact deterministic set or stable fatal code; never silent fallback on corrupt Git |
| Static extraction | direct/shorthand/string keys, helper exports, spread/computed/accessor/mutation/re-export, top-level sentinel | complete metadata or exact code/span; zero evaluation |
| Names | root, `.github`, `.storybook`, hyphen, Unicode NFC/NFD, case pairs, colon/slash/backslash/control, reserved defaults | portable canonical labels; ambiguous/colliding inputs fatal |
| Files | regular, directory, FIFO, socket, hardlink, in-root/out-root symlink, link race | only admitted regular contained modules execute |
| Modules | ESM, CommonJS host package, `.js` to `.ts`, top-level await, syntax error, throw, helper imports, missing export, extra naked target | same snapshot or exact diagnostic with chain/span |
| Graph | acyclic diamonds, self/two/long cycles, imported Package property, one target twice, public-to-private dependency | immutable graph; cycles/identity/visibility enforced before planning |
| Cache | same mtime rewrite, dependency-only change, loader ABI change, workspace recreated at same path | no stale namespace; unchanged closure evaluates once per command |
| Watch | burst add/change/delete/rename, transient syntax error, cycle then repair, concurrent readers | atomic last-good snapshots; one deterministic successor |
| Types | exact target keys, misspelling, wrong attrs, wrong imported property, forged `any`, duplicate package copies | strict expected successes/failures without ambient declarations |
| Generation | two roots, CRLF, shuffled input, locales, concurrent generators, interrupted write | byte-identical complete artifacts or old artifact retained |
| Bundlers | static loader chunking, browser graph viewer, tree shaking, CJS library consumer | no absolute/dynamic ignored imports; portable entry has no Node builtin |
| Secrets | env token, accessor throwing token, diagnostic cause, key/manifest output | secret values absent byte-for-byte; environment unchanged |
| Artifacts/write sets | illegal data edges, corrupt/missing blob, interrupted/racing materialization, sibling/git/symlink writes | no premature dispatch, partial tree, CAS mutation, or out-of-set change |
| Agents/services/outward | vacuous green, bounded rounds, payload/MCP, readiness/mid-run health failure/stop-grace/interrupt, fresh gates, approval/crash/idempotency | bounded fake calls, health failure fails the dependent, guaranteed teardown, at-most-one durable outward action |
| Resolver/CI | module-resolution variants, unresolved/dynamic, incremental rows, universe edit, synthetic affected diffs | explicit stable closure, minimal recompute, affected iff key changed |
| Old-flow separation | flow/skill discovery, flow `ui.tsx`, unrelated PACKAGE sibling `ui.tsx` | registry behavior independent; package router ignores UI companion |

Performance/resource gates: bounded Git output, bounded declaration file reads, maximum module count/path bytes/import depth, cancellation support, and a benchmark on Force-sized inventories. Limits must fail with typed diagnostics rather than truncate to a valid-looking graph.

## 17. Documentation, examples, and rollout receipts

Before cutover, update canonical docs and then regenerate site copies:

- exact PACKAGE/WORKSPACE source grammar, exact-case and Git-aware discovery;
- pure inventory/static extraction versus trusted evaluation and its trust boundary;
- labels, defaults, imports, omission privacy, Alias nodes, and collision rules;
- Workspace direct fields, Layer dependency wiring, and both Runtime.Node forms;
- flavors, modes, three edge types, service probe contract, artifact materialization, and key laws;
- Node/Bun/browser/bundler support matrix;
- path/symlink/secret/sandbox security posture without hermeticity claims;
- diagnostic codes/phases, watch last-good behavior, manifest ABI/staleness;
- BUILD/fs migration guide with reviewed label/key examples;
- sanitized Force/WhatsABI examples for direct imports, cycle avoidance, app-specific generation, services, agents, and CI;
- implementation-status table separating routing spine from gated capability lanes.

The repository runs documentation-driven development with `docs/specs/` as the
source of truth, so the decisions in this plan land as vault Concepts notes
before or with their implementation phases: `Package Files.md` (discovery,
identity, privacy, cycles), `Target Flavors.md` (flavors and modes), `Edge
Types.md` (the three edges), `Artifact Store.md` (CAS trees and
materialization), `Resolver.md` (rows, closures, affected equivalence), and
`Agent Targets.md` (payloads, write-sets, gate loops, approval). Every
`[[wikilink]]` must resolve; `vaultCheck` enforces it. `HQ.md` gets the
in-flight entry this work currently lacks.

Every phase/batch emits a machine-readable graph/label/key delta and records its rollback checkpoint. Documentation must not call generation, Vite, source-mode Bun, sandbox enforcement, a catalog capability, or an outward action implemented before its gate passes.

Conformance levels are: L0 strict types; L1 static/evaluated load plus labels/privacy; L2 normalized query/plan; L3 stub-tool/fake-agent execution; L4 real repository dogfood. External validation uses disposable clean Force/WhatsABI copies, never their dirty worktrees.

## 18. Unresolved questions and recommended defaults

1. **Does `defaultVisibility:"private"` ship in v1?** Evidence proves only the `public` literal and no private consumer. Default: type/accept `public`, reject `private`, use omission-based privacy until authorization semantics exist. Consequence: no false access-control promise. ANSWER: no just ship mvp in fact remove defaultVisibility from spec
2. **Are helper runtime exports allowed?** Default: yes for inert non-target values, but reject naked Target/Package/Workspace exports. Consequence: ordinary constants/functions remain possible without reopening target discovery. ANSWER: Of course most of our api are helpers that wrap the internal stuff
3. **Must PACKAGE discovery use Git?** Default: preserve current Git-aware inventory with bounded fallback. Consequence: ignored PACKAGE files do not participate; untracked nonignored files do. Document this because a raw filesystem glob would differ. ANSWER: no it shouldn't use git because some of these files are git ignored only use git for git specific stuff
4. **Are in-workspace symlinked PACKAGE files allowed?** Current BUILD admission allows an in-root link. Default: allow only when canonical module identity is unique, and label comes from the lexical containing directory; reject any second alias. Consequence: monorepo link layouts work without duplicate targets.ANSWER: just do whatever the minimum spec is for this 
5. **Should manifest files be committed?** Default: cache artifact, uncommitted; optional checked-in mirror plus `--check`. Consequence: source authoring has no generated-file prerequisite, while bundler consumers can require the target. ANSWER: Usually no it should be an option too where we can update git ignore to ignore things that are marked as ignored
6. **Which package owns portable graph schemas?** Default: a Node-free subpath of build-cli initially; extract only after a second consumer. Consequence: no premature package while browser UI can import safely. ANSWER we als
7. **Can arbitrary local imports leave the workspace?** Default: package-to-package declarations and workspace-local helpers must stay inside; npm/builtin imports are allowed by policy. Consequence: trusted declarations can use libraries but cannot smuggle a second workspace tree through relative paths.
8. **What is a root shorthand `//` default?** Default: explicit `default`, then sole public target, otherwise ambiguity. Consequence: no insertion-order API.
9. **Which CLI binary ships?** Default: partner-facing `smithers`; retain `smthrs` only during repository dogfood. This does not change labels.
10. **Does compact `Github.Ci` remain?** Default: yes as typed sugar lowering to Setup/Workflow/CiGen's one intermediate representation, never as a separate execution path.
11. **May Agent.Lint cache?** Default: no in v1; enable only after validate-gated admission proves the nondeterministic result safe.
12. **Does OS network sandboxing block routing?** Default: no; ship and document honest Tier-0 declared/revalidated policy, with OS enforcement as a separate capability gate.
13. **Dogfood granularity:** does this repository's migration create PACKAGE.ts files 1:1 with today's BUILD.ts files, or split per app/subsystem now (the per-route vision in Force's SMITHERS-NOTES.md, where an undeclared cross-boundary import becomes a missing edge)? Default: 1:1 now; per-app splits are follow-up refactors once the router is proven.
14. **Overlap with the eight open flows3 questions** (`~/Smithers-Ops/HQ.md` line 27: cache doctrine, naming register, OSS-repo shape, cache unification): which does this plan's defaults settle? Needs an explicit pass with will so HQ and this plan do not answer the same question differently.

## 19. Definition of done

The replacement is done only when all of the following are true:

- strict real types compile the two Artsy prototype shapes without `smithers.d.ts` or wildcard `any`;
- inventory/static extraction produces the complete label/import index while instrumented repository module evaluation remains zero, and evaluated keys exactly match static keys;
- package labels are derived exclusively from canonical PACKAGE path and explicit target-map key;
- WORKSPACE and PACKAGE loaders are distinct, immutable, typed, and emit stable diagnostics;
- direct Package imports preserve exact target types and one runtime identity;
- path/symlink/cycle/case/duplicate/privacy/cache/watch invariants pass the adversarial matrix;
- source-mode Node and generated-mode Node/Bun agree on snapshot bytes; browser/bundler consumers use static generated imports;
- planner, executor, query, graph, cache keying, generated sources, and output validation operate through PackageIndex;
- materialized-input, three-edge, artifact, write-set, service-probe, agent, outward-action, resolver, affected-CI, and sandbox-honesty contracts are either implemented behind their machine gates or explicitly unavailable—never represented by permissive fake behavior;
- the repository has a reviewed old/new public-label delta and dogfoods PACKAGE/WORKSPACE;
- old BUILD export scanning, stack-derived routing identity, and the unused `@smthrs/fs` public routing/command surface are removed;
- flow discovery and flow UI metadata remain correctly owned and tested in registry/framework code;
- package manifests export existing files only, tarball ESM/CJS/type tests pass, and installable packages are no longer marked private when external use is intended;
- docs and changelogs label implemented/prototype/proposed behavior accurately and contain no generation/Vite claim unsupported by a gate;
- a final repository-wide symbol/file inventory finds no unaccounted routing consumer or legacy entry file.

The riskiest invariant is identity: one target must have one label, and that label must be a pure function of admitted path plus explicit map key on every host and every reload. The second is snapshot atomicity: a consumer must see either the complete last-good graph or the complete new graph, never a mixture. Phase gates should block the cutover until both are mechanically proven.

## Appendix A. Old catalog to new surface: seed for the coverage ledger

| Today (`Smithers.*`, BUILD.ts) | New (`S.*`, PACKAGE.ts) |
|---|---|
| named exports are targets | `S.Package({targets})` map only; naked target export is fatal |
| `Workspace({cacheDirectory, gitignored})` + `RemoteCache` | `S.Workspace(name, {repository, cache: S.Cache({directory}), runtime, packageManager, nodeModules, flags?, host?, gitHooks?, layer?})` |
| `Runtime.Node/Bun` | `S.Runtime.Node({version} \| {manifest})` exclusive union |
| `PackageManager.Pnpm/BunPackages` | `S.PackageManager.Pnpm/Yarn({manifest, lockfile, version?})` |
| `Install({packageManager, lockfile, workspaceManifest})`, `Lockfile` | `S.Npm.NodeModules({packageJson})`; manager and lockfile arrive by Layer requirement |
| `file / glob / gitDiff(base) / pnpmWorkspace` | `S.file` (label grammar), `S.glob` (`//` cross-package allowed), `S.gitDiff({paths, added, addedLines})`; pnpmWorkspace stays internal to layers |
| `Filegroup` | `S.Filegroup` (srcs may be artifact-producing targets) |
| `TsBuild / DtsBuild / Typecheck / Vitest / VitestCoverage / VitestWatch / NodeTest / BiomeCheck / Dprint / EsLint / DepsLint / PackageLint / SortPackageJson` | `S.Shell.Build/Test` + `S.NodeModule.Bin`; tool-named catalog deleted; repo conveniences return as plain functions in that repo's PACKAGE.ts |
| `ToolBuild / ToolRun / Dev / Clean` | `S.Shell.Build / Run / Serve` + `command` |
| `GeneratedFile / PackageJson check+write / Tsconfig / PnpmWorkspace` | `S.Generate` (three forms) + repo-local macros |
| `LlmLint` | `S.Agent.Lint` on the DI agent stack (batching/limits carry over as implementation detail) |
| — | `S.Agent.Diff`, `S.Agent.Pr`, `S.Agent.Codex`, `S.Input.*`, `S.Mcp.Http` |
| `NpmPublish / JsrPublish / Changesets` | `S.Npm.Pack/Publish` (+ approval, provenance); changesets policy per flows3-design |
| — | `S.Npm.Published`, `S.Api.Compat`, `S.Markdown.CodeBlocks` |
| `GithubCiGen` (jobs/gates config) | `S.Github.Setup/Workflow/CiGen`, compact `S.Github.Ci` as sugar |
| — | `S.Github.Pages/Release`, `S.Git.Commit/Pr`, `S.Cron` |
| — | `S.ImportClosure`, `S.Files.difference`, `S.Bundler.make/Rspack`, `S.Materialize`, `S.Copy`, `S.Test`, `S.Suite`, `S.Alias`, `S.Host`, `S.Flags` |
| `Secret` | `S.Secret` unchanged (names key, values never) |
| `Verb.{Build,Test,Lint,Docs,Ci}` values | flavors + modes; verbs remain CLI words; bare-label form infers the verb (§6.6) |
| `PackageDefaults` / `StandardPackage` synthesis | removed; explicit PACKAGE.ts everywhere, generated once by the migration checker; convenience macros are plain functions whose results land in a Package map |
| `docs` kind / `DocsParity` | repo-local `Shell.Test` / `S.Agent.Lint` targets in this repository's own PACKAGE.ts |
