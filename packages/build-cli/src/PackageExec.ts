/**
 * Package-mode planning and execution: the W2 execution core.
 *
 * Planning resolves every tool reference against the workspace (the
 * resolutions are key material), expands declared inputs, and computes each
 * node's content key through the shared injective encoder
 * (`Planner.keyOf`). Execution reuses the existing keep-going scheduler
 * (`Executor.schedule`), the shared exec implementation (`Exec.run`), and
 * the workspace cache (`Cache.openCache`).
 *
 * W2 implements Shell.Build, Shell.Test, Shell.Run, Shell.Diff, Generate,
 * Materialize, Clean, Suite, and Alias. Every other rule keeps a loud typed
 * refusal: it plans (so its key is visible) and fails at execution.
 *
 * @since 0.1.0
 */
import * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as BundlerTarget from "@smthrs/targets/BundlerTarget"
import * as Compose from "@smthrs/targets/Compose"
import * as Exec from "@smthrs/targets/Exec"
import * as GithubTarget from "@smthrs/targets/GithubTarget"
import * as Input from "@smthrs/targets/Input"
import * as Shell from "@smthrs/targets/Shell"
import * as Target from "@smthrs/targets/Target"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { minimatch } from "minimatch"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { performance } from "node:perf_hooks"
import * as AgentFake from "./AgentFake.ts"
import * as AgentSession from "./AgentSession.ts"
import { type CacheStore, openCache } from "./Cache.ts"
import * as Diagnostic from "./Diagnostic.ts"
import * as Executor from "./Executor.ts"
import * as GitCommit from "./GitCommit.ts"
import * as GithubRender from "./GithubRender.ts"
import * as MemoryBackend from "./MemoryBackend.ts"
import type * as PackageIndexModule from "./PackageIndex.ts"
import * as PackageTree from "./PackageTree.ts"
import * as Planner from "./Planner.ts"
import * as Resolver from "./Resolver.ts"
import * as RspackRunner from "./RspackRunner.ts"
import * as ServiceSupervisor from "./ServiceSupervisor.ts"
import type * as Workspace from "./Workspace.ts"

const posix = (value: string): string => value.split(NodePath.sep).join("/")

/**
 * Cache-key salt for package-mode execution semantics.
 *
 * @category keys
 * @since 0.1.0
 */
export const PACKAGE_EXECUTION_FORMAT = 1

/**
 * The mode one node executes under: `execute` for plain tool runs and
 * builds, `check` for the non-mutating drift verdict of Diff and Generate,
 * `write` for their applying form. Modes are distinct key material.
 *
 * @category models
 * @since 0.1.0
 */
export type Mode = "execute" | "check" | "write"

/**
 * The invocation surface: a CLI verb, or `auto` for the bare-label form
 * whose verb is implied by the target flavor.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageVerb = "build" | "test" | "lint" | "run" | "auto"

/** The rules the package executor implements (W2 core plus the W3 lanes). */
const implementedRules: ReadonlySet<string> = new Set([
  "Shell.Build",
  "Shell.Test",
  "Shell.Run",
  "Shell.Serve",
  "Shell.Diff",
  "Generate",
  "Materialize",
  "Clean",
  "Suite",
  "Alias",
  "Filegroup",
  "ImportClosure",
  "Test",
  "Bundler.Rspack.resolve",
  "Bundler.Rspack.build",
  "Agent.Lint",
  "Agent.Diff",
  "Agent.Pr",
  "Git.Commit",
  "Github.Setup",
  "Github.Workflow",
  "Github.CiGen",
  "Github.Pr",
  "Memory.Retain"
])

/** Rules whose default mode is the non-mutating check. */
const checkModeRules: ReadonlySet<string> = new Set(["Shell.Diff", "Generate", "Github.CiGen", "Agent.Lint"])

const refusalFor = (rule: string): string =>
  `NotImplemented: ${rule} has no package-mode execution; ` +
  "the implemented set is Shell.*, Generate, Materialize, Clean, Suite, Alias, ImportClosure, Test, " +
  "Bundler.Rspack.*, Agent.*, Git.Commit, Github.*, and Memory.Retain"

/**
 * The placeholder a bundler build's key template carries where the graph
 * dependency's key goes. Execution substitutes the resolved graph digest
 * (`bundler-graph:<digest>`) once the resolve node has settled, so a build
 * keys on the graph it bundles rather than on the declared universe; the
 * plan-time preview substitutes the digest when the cache already holds it
 * and the resolve node's own key otherwise.
 *
 * @category keys
 * @since 0.1.0
 */
export const graphKeySentinel = "{smthrs:bundler-graph-key}"

const replaceGraphKey = (value: unknown, key: string): unknown => {
  if (value === graphKeySentinel) return key
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) return value.map((entry) => replaceGraphKey(entry, key))
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const out: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(value)) out[name] = replaceGraphKey(entry, key)
  return out
}

/**
 * Substitutes the graph key into a bundler build's key template: the `graph`
 * attr reference and the dependency row both carry the sentinel.
 *
 * @category keys
 * @since 0.1.0
 */
export const keyMaterialWithGraph = (template: Planner.KeyMaterial, key: string): Planner.KeyMaterial => {
  const inputs = template.inputs as {
    readonly attrs: unknown
    readonly dependencies: ReadonlyArray<{ readonly label: string; readonly key: string }>
  }
  return {
    ...template,
    inputs: {
      ...inputs,
      attrs: replaceGraphKey(inputs.attrs, key),
      dependencies: inputs.dependencies.map((row) => row.key === graphKeySentinel ? { label: row.label, key } : row)
    }
  }
}

/**
 * One reduced `S.Test` operand as the executor evaluates it.
 *
 * @category models
 * @since 0.1.0
 */
export type TestOperandPlan =
  | { readonly kind: "sources"; readonly sources: ReadonlyArray<Compose.AnchoredSource> }
  | { readonly kind: "closure"; readonly entries: ReadonlyArray<Compose.AnchoredSource> }
  | { readonly kind: "bundler-files"; readonly label: string }

/**
 * The per-rule execution data a lane node carries beyond the shared shell
 * fields. Exactly one variant per lane rule; `undefined` for the W2 core
 * rules.
 *
 * @category models
 * @since 0.1.0
 */
export type LaneData =
  | {
    readonly kind: "serve"
    readonly readiness?: ServiceSupervisor.Readiness | undefined
    readonly health?: ServiceSupervisor.Health | undefined
    readonly stop?: ServiceSupervisor.Stop | undefined
  }
  | { readonly kind: "closure"; readonly entries: ReadonlyArray<Compose.AnchoredSource> }
  | { readonly kind: "files-test"; readonly left: TestOperandPlan; readonly right: TestOperandPlan }
  | { readonly kind: "bundler-resolve"; readonly payload: BundlerTarget.ResolvePayload }
  | { readonly kind: "bundler-build"; readonly payload: BundlerTarget.BuildPayload; readonly graphLabel: string }
  | {
    readonly kind: "agent"
    readonly flavor: "lint" | "diff" | "pr"
    readonly payload: AgentTarget.LintPayload | AgentTarget.DiffPayload
    /** Structural gate identity → planned gate label, in declared order. */
    readonly gateLabels: ReadonlyArray<readonly [string, string]>
  }
  | { readonly kind: "git-commit" }
  | { readonly kind: "ci-gen" }
  | { readonly kind: "github-decl" }
  | { readonly kind: "github-pr" }
  | { readonly kind: "memory-retain" }

/**
 * One planned package-mode node. Structurally a {@link Planner.PlannedTarget}
 * so the existing scheduler accepts the work list unchanged.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackageNode extends Planner.PlannedTarget {
  readonly rule: string
  readonly mode: Mode
  readonly packagePath: string
  /** The declaration object itself, for rule bodies that consume validated attrs. */
  readonly declaration: Target.AnyTarget
  /** Labels of the Serve targets this node's `services` attr acquires. */
  readonly serviceDeps: ReadonlyArray<string>
  readonly lane: LaneData | undefined
  /**
   * Bundler builds only: the key material with the graph dependency's key
   * left as {@link graphKeySentinel}. Execution derives the effective key
   * from it once the resolved graph digest is known.
   */
  readonly keyTemplate: Planner.KeyMaterial | undefined
  readonly refusal: string | undefined
  readonly sandbox: "none" | { readonly network?: boolean | undefined } | undefined
  readonly secrets: ReadonlyArray<string>
  readonly argv: ReadonlyArray<string> | undefined
  /**
   * The workspace-relative directory the tool spawns in. `bin`-form tools
   * run from the declaring package (their configs resolve upward and their
   * scope is the package); `command`, `bun`, and script forms run from the
   * workspace root, which their text is written against.
   */
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly bunTemplate:
    | { readonly template: string; readonly consts: Readonly<Record<string, string>>; readonly bunPath: string }
    | undefined
  readonly writeSet: ReadonlyArray<string>
  readonly outDirs: ReadonlyArray<string>
  readonly emit:
    | ReadonlyArray<{
      readonly path: string
      readonly value: { readonly kind: "bytes"; readonly text: string } | {
        readonly kind: "link"
        readonly target: string
      }
    }>
    | undefined
  readonly members: ReadonlyArray<string>
  readonly aliasOf: string | undefined
  readonly materializeOf: string | undefined
  readonly gateDeps: ReadonlyArray<string>
  readonly cleanOutDirs: ReadonlyArray<string>
  readonly cleanPaths: ReadonlyArray<string>
}

/**
 * The inert plan report `--plan` prints in package mode.
 *
 * @category models
 * @since 0.1.0
 */
export interface PlanReport {
  readonly verb: string
  readonly pattern: string
  readonly roots: ReadonlyArray<string>
  readonly targets: ReadonlyArray<{
    readonly label: string
    readonly rule: string
    readonly mode: Mode
    readonly key: string
    readonly cacheable: boolean
    readonly dependencies: ReadonlyArray<string>
    readonly argv?: ReadonlyArray<string> | undefined
    readonly refusal?: string | undefined
  }>
}

/**
 * Options accepted by {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunOptions {
  readonly index: PackageIndexModule.PackageIndex
  readonly cacheDirectory: string
  readonly verb: PackageVerb
  readonly pattern: string
  readonly write?: boolean | undefined
  readonly fix?: boolean | undefined
  readonly plan?: boolean | undefined
  readonly jobs?: number | undefined
  readonly readCache?: boolean | undefined
  readonly signal?: AbortSignal | undefined
  readonly log?: ((line: string) => void) | undefined
  /** `-m` override for `Git.Commit`; wins over the declared message. */
  readonly message?: string | undefined
  /** `--input name=value` payload values for agent targets. */
  readonly inputs?: Readonly<Record<string, string>> | undefined
}

/** Collects targets reachable inside one attr value, without user code. */
const collectTargets = (value: unknown, into: Array<Target.AnyTarget>, seen: Set<object>): void => {
  if (Target.isTarget(value)) {
    into.push(value)
    return
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) collectTargets(entry, into, seen)
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && "value" in descriptor) collectTargets(descriptor.value, into, seen)
  }
}

/** Collects tagged records of one tag inside an attr value. */
const collectTagged = (value: unknown, tag: string, into: Array<Record<string, unknown>>, seen: Set<object>): void => {
  if (typeof value !== "object" || value === null || seen.has(value) || Target.isTarget(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) collectTagged(entry, tag, into, seen)
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  if ((value as { readonly _tag?: unknown })._tag === tag) into.push(value as Record<string, unknown>)
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && "value" in descriptor) collectTagged(descriptor.value, tag, into, seen)
  }
}

const attrMember = (attrs: unknown, name: string): unknown => {
  if (typeof attrs !== "object" || attrs === null) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(attrs, name)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}

const attrTargets = (attrs: unknown, name: string): ReadonlyArray<Target.AnyTarget> => {
  const found: Array<Target.AnyTarget> = []
  collectTargets(attrMember(attrs, name), found, new Set())
  return found
}

/** One resolved tool: the executable path plus its key-material identity. */
interface ResolvedTool {
  readonly path: string
  readonly identity: unknown
}

/** A tool that could not be resolved: the typed refusal plus its identity. */
interface RefusedTool {
  readonly refusal: string
  readonly identity: unknown
}

type ToolOutcome = { readonly _tag: "resolved"; readonly tool: ResolvedTool } | {
  readonly _tag: "refused"
  readonly tool: RefusedTool
}

/**
 * Resolves the `.bin` entry name of one `S.NodeModule.Bin` reference.
 *
 * With no explicit `bin` argument the package's own manifest decides: a
 * string-form `bin` names the package basename; an object `bin` with one
 * entry names its sole key; more than one entry is ambiguous and requires
 * the explicit second argument. An unreadable manifest falls back to the
 * package basename, which the executable probe then refuses if absent.
 */
const binNameOf = async (
  root: string,
  packageName: string,
  bin: string | undefined
): Promise<{ readonly name: string } | { readonly problem: string }> => {
  if (bin !== undefined) return { name: bin }
  const parts = packageName.split("/")
  const basename = parts[parts.length - 1]!
  let declared: unknown
  try {
    const manifest = NodePath.join(root, "node_modules", ...packageName.split("/"), "package.json")
    declared = (JSON.parse(await Fs.readFile(manifest, "utf8")) as { readonly bin?: unknown }).bin
  } catch {
    return { name: basename }
  }
  if (typeof declared === "string") return { name: basename }
  if (typeof declared === "object" && declared !== null) {
    const names = Object.keys(declared)
    if (names.length === 1) return { name: names[0]! }
    if (names.length > 1) {
      return {
        problem: `package ${JSON.stringify(packageName)} exposes ${names.length} binaries (${names.join(", ")}); ` +
          "name one explicitly: S.NodeModule.Bin(package, bin)"
      }
    }
  }
  return { name: basename }
}

interface PlanContext {
  readonly root: string
  readonly cacheDirectory: string
  readonly index: PackageIndexModule.PackageIndex
  readonly signal: AbortSignal | undefined
  readonly log: (line: string) => void
  readonly flags: Readonly<Record<string, string>>
  readonly managerBinary: string
  readonly tools: Map<string, ToolOutcome>
  readonly probes: Map<string, PackageTree.Probe>
  readonly nodes: Map<string, PackageNode>
  readonly privateLabels: WeakMap<Target.AnyTarget, string>
  privateCounter: number
  readonly visiting: Set<Target.AnyTarget>
  readonly ambient: unknown
  /**
   * The mode each selected root is planned under, by label. `mode` is genuine
   * key material and each mode is a distinct view, but the scheduler, the
   * reports, and the cache all key by label, so one invocation plans one node
   * per label. When a Diff or Generate target is both a check-mode dependency
   * (or gate) and a `--write` root in the same invocation, the root's mode is
   * authoritative: the single node runs and applies, which also satisfies the
   * dependent that wanted it green. Cross-invocation mode views stay on
   * distinct keys because each invocation plans the label in exactly one mode.
   */
  readonly rootModes: ReadonlyMap<string, Mode>
  /** Lazily opened cache store for plan-time closure rows and graph digests. */
  store: CacheStore | undefined
  storeWarned: boolean
  /** ImportClosure label → canonical result digest (plan-time, memoized). */
  readonly closureDigests: Map<string, string>
  /** ImportClosure label → computed closure result (plan-time, memoized). */
  readonly closureResults: Map<string, Compose.ClosureResult>
  /** Bundler resolve label → resolved graph digest (plan-time, memoized). */
  readonly graphDigests: Map<string, string>
}

/** Opens (once) the cache store the planner uses for closure rows and graph digests. */
const planStore = async (context: PlanContext): Promise<CacheStore | undefined> => {
  if (context.store !== undefined) return context.store
  if (context.storeWarned) return undefined
  try {
    context.store = await openCache({
      workspaceRoot: context.root,
      cacheDirectory: context.cacheDirectory,
      warn: context.log
    })
    return context.store
  } catch (cause) {
    context.storeWarned = true
    context.log(`smthrs: plan-time cache unavailable: ${Diagnostic.message(cause)}`)
    return undefined
  }
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

/**
 * The canonical digest of one closure result: files, packages, and issue
 * rows. Consumers of an ImportClosure key on it.
 *
 * @category keys
 * @since 0.1.0
 */
export const closureResultDigest = (result: Compose.ClosureResult): string =>
  sha256Hex(JSON.stringify({
    files: result.files,
    packages: result.packages,
    unresolved: result.unresolved,
    dynamic: result.dynamic
  }))

/** The implementation context payload accessors expect for one declaration. */
const contextOf = (metadata: Target.Metadata): Target.ImplementationContext => ({
  sourceFile: metadata.sourceFile,
  packageDirectory: metadata.sourceFile === undefined ? undefined : NodePath.dirname(metadata.sourceFile)
})

/**
 * Computes (memoized per label) the closure result of one ImportClosure
 * target. Runs the resolver at plan time: the result digest is what keys the
 * closure's consumers, so an edit to any file in the closure re-keys them
 * while an unrelated edit does not.
 */
const closureResultOf = async (
  context: PlanContext,
  label: string,
  closureTarget: Target.AnyTarget
): Promise<Compose.ClosureResult> => {
  const known = context.closureResults.get(label)
  if (known !== undefined) return known
  const metadata = Target.metadata(closureTarget)
  const entries = Compose.closureEntrySources(
    (metadata.attrs as { readonly entries: never }).entries,
    contextOf(metadata)
  )
  if (typeof entries === "string") throw new Error(`ImportClosure: ${entries}`)
  const store = await planStore(context)
  const result = await Resolver.closureOfEntries(
    {
      workspaceRoot: context.root,
      cacheDirectory: context.cacheDirectory,
      cache: store
    },
    entries
  )
  context.closureResults.set(label, result)
  context.closureDigests.set(label, closureResultDigest(result))
  return result
}

/** Cache-output shape one bundler resolve stores. */
interface StoredResolve {
  readonly kind: "bundler-resolve"
  readonly result: BundlerTarget.ResolveResult
}

const decodeStoredResolve = (output: unknown): BundlerTarget.ResolveResult | undefined => {
  if (typeof output !== "object" || output === null) return undefined
  if ((output as { readonly kind?: unknown }).kind !== "bundler-resolve") return undefined
  const result = (output as { readonly result?: unknown }).result
  try {
    return Schema.decodeUnknownSync(BundlerTarget.ResolveResult)(result)
  } catch {
    return undefined
  }
}

/** The scratch directory bundler children redirect resolve emit and caches into. */
const bundlerScratchDirectory = (root: string, cacheDirectory: string): string =>
  NodePath.join(root, ...cacheDirectory.split("/"), "bundler-scratch")

/**
 * Reads (memoized per label) the resolved graph digest of one bundler
 * resolve node from the cache, under the resolve node's own key. The digest
 * substitutes for the graph dependency's key in every `Bundler.Rspack.build`
 * consumer, which is the caching win the spec names: an edit that does not
 * change the resolved file set replays the build from cache.
 *
 * Plan time is cache-only: the resolve target's universe (relay artifacts
 * and other data producers) may not be materialized before execution, so a
 * plan-time compile could be wrong or fail on a cold tree. With no cached
 * result the build keys conservatively on the resolve target's own key and
 * the execution of the resolve node stores the result for the next
 * invocation.
 */
const graphDigestOf = async (
  context: PlanContext,
  resolveNode: PackageNode
): Promise<string | undefined> => {
  const known = context.graphDigests.get(resolveNode.label)
  if (known !== undefined) return known
  if (resolveNode.lane?.kind !== "bundler-resolve") {
    throw new Error(`the graph of a bundler build must be a Bundler.Rspack.resolve target: ${resolveNode.label}`)
  }
  const store = await planStore(context)
  const cached = store === undefined ? null : await store.get(resolveNode.keyPreview).catch(() => null)
  if (cached !== null && cached.exitOk) {
    const result = decodeStoredResolve(cached.output)
    if (result !== undefined) {
      context.graphDigests.set(resolveNode.label, result.graphDigest)
      return result.graphDigest
    }
  }
  return undefined
}

const probeOnce = async (context: PlanContext, path: string): Promise<PackageTree.Probe> => {
  const known = context.probes.get(path)
  if (known !== undefined) return known
  const probe = await PackageTree.probeVersion(path)
  context.probes.set(path, probe)
  return probe
}

const moduleVersion = async (root: string, packageName: string): Promise<string | null> => {
  try {
    const manifest = NodePath.join(root, "node_modules", ...packageName.split("/"), "package.json")
    const parsed = JSON.parse(await Fs.readFile(manifest, "utf8")) as { readonly version?: unknown }
    return typeof parsed.version === "string" ? parsed.version : null
  } catch {
    return null
  }
}

const resolveTool = async (context: PlanContext, reference: Record<string, unknown>): Promise<ToolOutcome> => {
  const key = JSON.stringify(reference)
  const known = context.tools.get(key)
  if (known !== undefined) return known
  const tag = reference["_tag"]
  let outcome: ToolOutcome
  if (tag === "NodeModuleBin") {
    const packageName = String(reference["package"])
    const resolvedBin = await binNameOf(
      context.root,
      packageName,
      typeof reference["bin"] === "string" ? reference["bin"] : undefined
    )
    if ("problem" in resolvedBin) {
      outcome = {
        _tag: "refused",
        tool: {
          refusal: resolvedBin.problem,
          identity: { tag: "NodeModuleBin", package: packageName, ambiguous: true }
        }
      }
      context.tools.set(key, outcome)
      return outcome
    }
    const bin = resolvedBin.name
    const path = NodePath.join(context.root, "node_modules", ".bin", bin)
    const version = await moduleVersion(context.root, packageName)
    const identity = { tag: "NodeModuleBin", package: packageName, bin, version }
    let executable = false
    try {
      await Fs.access(path, 1)
      executable = true
    } catch {
      executable = false
    }
    outcome = executable
      ? { _tag: "resolved", tool: { path, identity } }
      : {
        _tag: "refused",
        tool: {
          refusal: `node_modules binary not found: ${posix(NodePath.relative(context.root, path))} ` +
            `(from S.NodeModule.Bin(${JSON.stringify(packageName)}))`,
          identity: { ...identity, absent: true }
        }
      }
  } else if (tag === "HostBin") {
    const name = String(reference["name"])
    const path = PackageTree.findOnPath(name)
    if (path === undefined) {
      outcome = {
        _tag: "refused",
        tool: {
          refusal: `host binary ${JSON.stringify(name)} is declared in S.Host({ bins }) but is not present on PATH`,
          identity: { tag: "HostBin", name, absent: true }
        }
      }
    } else {
      const probe = await probeOnce(context, path)
      outcome = {
        _tag: "resolved",
        tool: {
          path,
          identity: { tag: "HostBin", name, path, probe: { exitCode: probe.exitCode, output: probe.output } }
        }
      }
    }
  } else if (tag === "PackageManagerBin") {
    const name = context.managerBinary
    const path = PackageTree.findOnPath(name)
    if (path === undefined) {
      outcome = {
        _tag: "refused",
        tool: {
          refusal: `workspace package manager binary ${JSON.stringify(name)} is not present on PATH`,
          identity: { tag: "PackageManagerBin", manager: name, absent: true }
        }
      }
    } else {
      const probe = await probeOnce(context, path)
      outcome = {
        _tag: "resolved",
        tool: {
          path,
          identity: {
            tag: "PackageManagerBin",
            manager: name,
            path,
            probe: { exitCode: probe.exitCode, output: probe.output }
          }
        }
      }
    }
  } else if (tag === "RuntimeBin") {
    outcome = {
      _tag: "resolved",
      tool: { path: process.execPath, identity: { tag: "RuntimeBin", runtime: "node", version: process.version } }
    }
  } else if (tag === "RuntimeNpx") {
    const path = PackageTree.findOnPath("npx")
    if (path === undefined) {
      outcome = {
        _tag: "refused",
        tool: {
          refusal: "npx is not present on PATH",
          identity: { tag: "RuntimeNpx", spec: reference["spec"], absent: true }
        }
      }
    } else {
      const probe = await probeOnce(context, path)
      outcome = {
        _tag: "resolved",
        tool: {
          path,
          identity: {
            tag: "RuntimeNpx",
            spec: reference["spec"],
            path,
            probe: { exitCode: probe.exitCode, output: probe.output }
          }
        }
      }
    }
  } else {
    outcome = {
      _tag: "refused",
      tool: { refusal: `unknown tool reference: ${key}`, identity: { tag: "unknown", key } }
    }
  }
  context.tools.set(key, outcome)
  return outcome
}

const resolveBun = async (context: PlanContext): Promise<ToolOutcome> => {
  const key = "{bun}"
  const known = context.tools.get(key)
  if (known !== undefined) return known
  const path = PackageTree.findOnPath("bun")
  let outcome: ToolOutcome
  if (path === undefined) {
    outcome = {
      _tag: "refused",
      tool: {
        refusal: "bun is required for bun: templates but is not present on PATH",
        identity: { tag: "Bun", absent: true }
      }
    }
  } else {
    const probe = await probeOnce(context, path)
    outcome = {
      _tag: "resolved",
      tool: { path, identity: { tag: "Bun", path, probe: { exitCode: probe.exitCode, output: probe.output } } }
    }
  }
  context.tools.set(key, outcome)
  return outcome
}

const packagePathOf = (context: PlanContext, target: Target.AnyTarget): string => {
  const source = Target.metadata(target).sourceFile
  if (source !== undefined) {
    const relative = NodePath.relative(context.root, NodePath.dirname(source))
    if (relative === "") return ""
    if (!relative.startsWith("..") && !NodePath.isAbsolute(relative)) return posix(relative)
  }
  return context.index.ownerOf(target) ?? ""
}

const labelOf = (context: PlanContext, target: Target.AnyTarget): string => {
  const labeled = context.index.labelOf(target)
  if (labeled !== undefined) return labeled
  const known = context.privateLabels.get(target)
  if (known !== undefined) return known
  context.privateCounter += 1
  const label = `//${packagePathOf(context, target)}:__private_${
    Target.metadata(target).target.replace(/[^A-Za-z0-9]/g, "_")
  }_${context.privateCounter}`
  context.privateLabels.set(target, label)
  return label
}

/** Expands and digests one target's declared inputs against its package. */
const expandInputs = async (
  context: PlanContext,
  packagePath: string,
  declarations: ReadonlyArray<Input.Declared>
): Promise<ReadonlyArray<Workspace.ExpandedInput>> => {
  const expanded: Array<Workspace.ExpandedInput> = []
  for (const declaration of declarations) {
    if (declaration._tag === "File") {
      const path = Input.resolvePath(packagePath, declaration.path)
      const digest = await Input.digestFile(NodePath.join(context.root, path), {
        workspaceRoot: context.root,
        signal: context.signal
      })
      const files = [{ path, digest }]
      expanded.push({ declaration, files, digest: Input.digestText(JSON.stringify(files)) })
      continue
    }
    if (declaration._tag === "Glob") {
      const matches = await Input.expandGlob(context.root, packagePath, declaration, {
        cacheDirectory: context.cacheDirectory,
        signal: context.signal
      })
      const files = await Input.digestFiles(context.root, matches, { signal: context.signal })
      expanded.push({ declaration, files, digest: Input.digestText(JSON.stringify(files)) })
      continue
    }
    if (declaration._tag === "PnpmWorkspace") {
      const matches = await Input.expandPnpmWorkspace(context.root, packagePath, declaration, {
        cacheDirectory: context.cacheDirectory,
        signal: context.signal
      })
      const files = await Input.digestFiles(context.root, matches, { signal: context.signal })
      expanded.push({ declaration, files, digest: Input.digestText(JSON.stringify(files)) })
      continue
    }
    expanded.push(await expandGitDiff(context, declaration))
  }
  return expanded
}

/** One `git diff --name-status -z` row. */
interface DiffEntry {
  readonly status: string
  readonly path: string
}

const parseNameStatusZ = (raw: string): Array<DiffEntry> => {
  const parts = raw.split("\0")
  const entries: Array<DiffEntry> = []
  for (let index = 0; index < parts.length; index += 1) {
    const status = parts[index]!
    if (status === "") continue
    // Rename/copy rows carry two paths; the post-image is the second one.
    if (status.startsWith("R") || status.startsWith("C")) {
      const post = parts[index + 2]
      if (post !== undefined && post !== "") entries.push({ status, path: post })
      index += 2
      continue
    }
    const path = parts[index + 1]
    if (path !== undefined && path !== "") entries.push({ status, path })
    index += 1
  }
  return entries
}

/**
 * Expands one declared git diff to key material: the filtered file digests
 * plus the filtered patch bytes. `paths` narrows by glob; `added` narrows to
 * added files matching its globs; `addedLines` contributes its source text
 * (the patch already carries the lines).
 */
const expandGitDiff = async (
  context: PlanContext,
  declaration: Extract<Input.Declared, { readonly _tag: "GitDiff" }>
): Promise<Workspace.ExpandedInput> => {
  const base = Input.validateGitBase(declaration.base)
  const raw = await PackageTree.runGit(context.root, [
    "diff",
    "--name-status",
    "-z",
    "--end-of-options",
    base,
    "--"
  ])
  const entries = parseNameStatusZ(raw)
  const matchesAny = (path: string, patterns: ReadonlyArray<string>): boolean =>
    patterns.some((pattern) => minimatch(path, pattern, { dot: true }))
  const selected = entries.filter((entry) => {
    if (declaration.paths !== undefined && !matchesAny(entry.path, declaration.paths)) return false
    if (declaration.added !== undefined) {
      if (!entry.status.startsWith("A")) return false
      if (!matchesAny(entry.path, declaration.added)) return false
    }
    return true
  })
  const paths = selected.map((entry) => entry.path).sort()
  const files = await Input.digestFiles(context.root, paths, { signal: context.signal })
  const patch = paths.length === 0
    ? ""
    : await PackageTree.runGit(context.root, ["diff", "--binary", "--end-of-options", base, "--", ...paths])
  return {
    declaration,
    files,
    digest: Input.digestText(JSON.stringify({ patch, files, addedLines: declaration.addedLines ?? null }))
  }
}

/** The non-glob directory prefix of one write-set pattern. */
const staticPrefixOf = (pattern: string): string => {
  const segments = pattern.split("/")
  const kept: Array<string> = []
  for (const segment of segments) {
    if (/[*?{}[\]!]/.test(segment)) break
    kept.push(segment)
  }
  return kept.join("/")
}

const capabilitiesFor = (rule: string, mode: Mode, sandbox: PackageNode["sandbox"]): ReadonlyArray<string> => {
  const capabilities = ["fs:read", "proc:spawn"]
  if (
    mode === "write" || rule === "Shell.Build" || rule === "Bundler.Rspack.build" || rule === "Materialize" ||
    rule === "Clean"
  ) {
    capabilities.push("fs:write")
  }
  if (sandbox === "none" || (typeof sandbox === "object" && sandbox.network === true)) capabilities.push("net:open")
  return capabilities
}

interface VisitOptions {
  readonly mode: Mode
}

const visit = async (
  context: PlanContext,
  target: Target.AnyTarget,
  options: VisitOptions
): Promise<PackageNode> => {
  const label = labelOf(context, target)
  const known = context.nodes.get(label)
  if (known !== undefined) return known
  if (context.visiting.has(target)) throw new Error(`target dependency cycle reaches ${label}`)
  context.visiting.add(target)
  const metadata = Target.metadata(target)
  const rule = metadata.target
  const packagePath = packagePathOf(context, target)
  const attrs = metadata.attrs

  // Dependencies: always visited for key material; the execution edges are a
  // per-rule subset decided below.
  const depKeys = new Map<Target.AnyTarget, string>()
  const dependencyRows: Array<{ readonly label: string; readonly key: string }> = []
  const depLabels = new Map<Target.AnyTarget, string>()
  let graphResolveNode: PackageNode | undefined
  for (const dependency of metadata.dependencies) {
    const depMetadata = Target.metadata(dependency)
    const depRule = depMetadata.target
    const depMode: Mode = checkModeRules.has(depRule) ? "check" : "execute"
    const planned = await visit(context, dependency, { mode: depMode })
    let depKey = planned.keyPreview
    // An ImportClosure dependency keys its consumer on the RESOLVED closure
    // (the sorted path+digest set), not on the closure declaration: editing a
    // file inside the closure re-keys the consumer, editing an unrelated file
    // does not. The closure itself carries no such key (it is not cacheable).
    if (depRule === "ImportClosure" && rule !== "Clean" && planned.refusal === undefined) {
      const result = await closureResultOf(context, planned.label, dependency)
      depKey = `import-closure:${closureResultDigest(result)}`
    }
    // A bundler build keys on the RESOLVED graph digest of its resolve target.
    // The digest is known only once the resolve node has settled, so the key
    // material carries a sentinel here; execution substitutes the digest, and
    // the plan-time preview substitutes it when the cache already holds one
    // (conservatively the resolve node's own key otherwise).
    if (rule === "Bundler.Rspack.build" && depRule === "Bundler.Rspack.resolve" && planned.refusal === undefined) {
      depKey = graphKeySentinel
      graphResolveNode = planned
    }
    depKeys.set(dependency, depKey)
    depLabels.set(dependency, planned.label)
    dependencyRows.push({ label: planned.label, key: depKey })
  }

  const declaredInputs = await expandInputs(context, packagePath, metadata.inputs)
  const inputDigests = new Map<Input.Declared, string>()
  for (const expanded of declaredInputs) inputDigests.set(expanded.declaration, expanded.digest)

  // Tool resolution. Everything resolved here is key material; a refusal is
  // recorded on the node and fails the target at execution, typed and loud.
  const toolchain: Array<unknown> = []
  let refusal: string | undefined
  const noteRefusal = (message: string): void => {
    refusal ??= message
  }
  if (!implementedRules.has(rule)) {
    noteRefusal(refusalFor(rule))
  }
  // The services edge: every declared service must be a Serve target; the
  // consumer acquires it (readiness-gated) before dispatch and releases it
  // when done. Serve targets stay in the dependency rows (service identity is
  // key material) and are recorded as service labels for acquisition. They
  // are never execution edges: a Serve target is acquire-only, so its own
  // execution dependencies (the data its process needs) are hoisted onto the
  // consumer instead, and a service's own services are acquired first.
  const services = attrTargets(attrs, "services")
  const serviceDeps: Array<string> = []
  const hoistedDeps: Array<string> = []
  for (const service of services) {
    if (Target.metadata(service).target !== "Shell.Serve") {
      noteRefusal(`services entries must be Shell.Serve targets; ${depLabels.get(service) ?? "a member"} is not`)
      continue
    }
    const serviceLabel = depLabels.get(service) ?? labelOf(context, service)
    const serviceNode = context.nodes.get(serviceLabel)
    if (serviceNode !== undefined) {
      if (serviceNode.refusal !== undefined) noteRefusal(`service ${serviceLabel}: ${serviceNode.refusal}`)
      for (const nested of serviceNode.serviceDeps) {
        if (!serviceDeps.includes(nested)) serviceDeps.push(nested)
      }
      hoistedDeps.push(...serviceNode.dependencies)
    }
    if (!serviceDeps.includes(serviceLabel)) serviceDeps.push(serviceLabel)
  }

  const resolveToken = async (entry: string): Promise<string> => {
    if (entry.startsWith("{smthrs:tool:") && entry.endsWith("}")) {
      const reference = JSON.parse(entry.slice("{smthrs:tool:".length, -1)) as Record<string, unknown>
      const outcome = await resolveTool(context, reference)
      toolchain.push(outcome.tool.identity)
      if (outcome._tag === "refused") {
        noteRefusal(outcome.tool.refusal)
        return entry
      }
      return outcome.tool.path
    }
    if (entry.startsWith("{smthrs:flag:") && entry.endsWith("}")) {
      const name = entry.slice("{smthrs:flag:".length, -1)
      const value = context.flags[name]
      if (value === undefined) {
        noteRefusal(`S.Flags.${name} names no declared workspace flag`)
        return entry
      }
      // The reference in attrs keys the name; the workspace-declared value
      // the argv actually receives is keyed here.
      toolchain.push({ tag: "Flag", name, value })
      return value
    }
    if (entry.startsWith("{smthrs:script:") && entry.endsWith("}")) {
      const declared = entry.slice("{smthrs:script:".length, -1)
      const resolved = Input.resolvePath(packagePath, declared)
      try {
        await Fs.access(NodePath.join(context.root, resolved))
      } catch {
        noteRefusal(`generator script not found: ${resolved}`)
      }
      return resolved
    }
    if (entry === Shell.bunToken) {
      const outcome = await resolveBun(context)
      toolchain.push(outcome.tool.identity)
      if (outcome._tag === "refused") {
        noteRefusal(outcome.tool.refusal)
        return entry
      }
      return outcome.tool.path
    }
    return entry
  }

  // Per-rule extraction.
  let argv: Array<string> | undefined
  let env: Record<string, string> = {}
  let bunTemplate: PackageNode["bunTemplate"]
  let emit: PackageNode["emit"]
  const writeSet: Array<string> = []
  const outDirs: Array<string> = []
  const members: Array<string> = []
  let aliasOf: string | undefined
  let materializeOf: string | undefined
  const cleanOutDirs: Array<string> = []
  const cleanPaths: Array<string> = []
  const secrets: Array<string> = []
  const secretRecords: Array<Record<string, unknown>> = []
  collectTagged(attrMember(attrs, "secrets"), "Secret", secretRecords, new Set())
  for (const record of secretRecords) {
    if (typeof record["env"] === "string") secrets.push(record["env"])
  }
  const sandbox = attrMember(attrs, "sandbox") as PackageNode["sandbox"]

  const changes = attrMember(attrs, "changes")
  if (Array.isArray(changes)) {
    for (const pattern of changes) {
      if (typeof pattern === "string") writeSet.push(Input.resolvePath(packagePath, pattern))
    }
  }

  // Every tool spawns from the workspace root: the observed declarations are
  // written against it (root-relative config paths, `//`-anchored scripts,
  // shell text naming workspace paths), and tools that resolve their config
  // by walking upward behave identically. Package scoping happens through
  // declared inputs and write sets, not the process cwd.
  const cwd = "."
  const isShellExec = rule === "Shell.Build" || rule === "Shell.Test" || rule === "Shell.Run" ||
    rule === "Shell.Serve" || rule === "Shell.Diff"
  if (isShellExec && refusal === undefined) {
    const shellAttrs = attrs as Shell.ExecAttrs
    const payload = Shell.execPayload(shellAttrs)
    env = { ...(payload.env as Record<string, string>) }
    const resolved: Array<string> = []
    for (const entry of payload.argv as ReadonlyArray<string>) resolved.push(await resolveToken(entry))
    if (shellAttrs.bun !== undefined) {
      const bun = await resolveBun(context)
      const consts: Record<string, string> = {}
      for (const [name, reference] of Object.entries(shellAttrs.using ?? {})) {
        const outcome = await resolveTool(context, reference)
        toolchain.push({ slot: `using:${name}`, identity: outcome.tool.identity })
        if (outcome._tag === "refused") noteRefusal(outcome.tool.refusal)
        else consts[name] = outcome.tool.path
      }
      if (bun._tag === "resolved" && refusal === undefined) {
        bunTemplate = { template: shellAttrs.bun, consts, bunPath: bun.tool.path }
      }
    }
    // A Diff tool that names no path in its declared args is pointed at its
    // write set: the resolved patterns' static prefixes become trailing
    // arguments. `prettier --write` alone formats nothing; with the write
    // set's directory it formats exactly what the declaration confines it
    // to.
    if (
      rule === "Shell.Diff" &&
      shellAttrs.bin !== undefined &&
      (shellAttrs.args ?? []).every((entry) => typeof entry !== "string" || entry.startsWith("-"))
    ) {
      const appended = new Set<string>()
      for (const pattern of writeSet) {
        const prefix = staticPrefixOf(pattern)
        appended.add(prefix === "" ? "." : prefix)
      }
      for (const path of [...appended].sort()) resolved.push(path)
    }
    argv = resolved
    if (rule === "Shell.Build") {
      const declaredOut = attrMember(attrs, "outDirs")
      if (Array.isArray(declaredOut)) {
        for (const dir of declaredOut) {
          if (typeof dir === "string") outDirs.push(Input.resolvePath(packagePath, dir))
        }
      }
    }
  }

  if (rule === "Generate" && refusal === undefined) {
    const script = attrMember(attrs, "script")
    const emitAttr = attrMember(attrs, "emit")
    const bin = attrMember(attrs, "bin")
    if (script !== undefined && typeof (script as { readonly path?: unknown }).path === "string") {
      const resolved: Array<string> = []
      for (
        const entry of [
          Shell.toolToken({ _tag: "RuntimeBin" } as never),
          Shell.scriptToken((script as { readonly path: string }).path)
        ]
      ) {
        resolved.push(await resolveToken(entry))
      }
      argv = resolved
    } else if (emitAttr !== undefined && typeof emitAttr === "object" && emitAttr !== null) {
      const entries: Array<NonNullable<PackageNode["emit"]>[number]> = []
      for (const [name, value] of Object.entries(emitAttr)) {
        const path = Input.resolvePath(packagePath, name)
        if (typeof value === "string") {
          entries.push({ path, value: { kind: "bytes", text: value } })
        } else if (
          typeof value === "object" && value !== null &&
          (value as { readonly _tag?: unknown })._tag === "Symlink"
        ) {
          entries.push({ path, value: { kind: "link", target: (value as { readonly path: string }).path } })
        }
        writeSet.push(path)
      }
      emit = entries
    } else if (bin !== undefined) {
      noteRefusal("NotImplemented: the Generate bin/stdout form is not implemented in W2")
    }
  }

  if (rule === "Suite") {
    for (const member of attrTargets(attrs, "tests")) members.push(depLabels.get(member) ?? labelOf(context, member))
  }
  if (rule === "Alias") {
    const aliased = attrTargets(attrs, "target")[0]
    if (aliased !== undefined) aliasOf = depLabels.get(aliased) ?? labelOf(context, aliased)
  }
  if (rule === "Materialize") {
    const inner = attrTargets(attrs, "target")[0]
    if (inner !== undefined) materializeOf = depLabels.get(inner) ?? labelOf(context, inner)
  }
  if (rule === "Clean") {
    for (const cleaned of attrTargets(attrs, "targets")) {
      const cleanedMetadata = Target.metadata(cleaned)
      const cleanedPath = packagePathOf(context, cleaned)
      const collectOut = (candidate: Target.AnyTarget, candidatePath: string): void => {
        const declaredOut = attrMember(Target.metadata(candidate).attrs, "outDirs")
        if (Array.isArray(declaredOut)) {
          for (const dir of declaredOut) {
            if (typeof dir === "string") cleanOutDirs.push(Input.resolvePath(candidatePath, dir))
          }
        }
      }
      collectOut(cleaned, cleanedPath)
      // A filegroup of build targets contributes its members' outDirs.
      for (const nested of cleanedMetadata.dependencies) collectOut(nested, packagePathOf(context, nested))
    }
    const paths = attrMember(attrs, "paths")
    if (Array.isArray(paths)) {
      for (const path of paths) {
        if (typeof path === "string") cleanPaths.push(path)
      }
    }
  }

  // Lane data: the per-rule execution payload of each W3 lane rule, reduced
  // from the validated attrs at plan time so execution never re-reads
  // declarations. A reduction that cannot settle is a typed refusal on the
  // node, never a partial payload.
  const implementationContext = contextOf(metadata)
  const labelFor = (member: Target.AnyTarget): string => depLabels.get(member) ?? labelOf(context, member)
  const testOperandPlan = (operand: Compose.FileSet): TestOperandPlan | string => {
    const operandTarget = Target.isTarget(operand) ? operand : operand.target
    if (Target.metadata(operandTarget).target === "Bundler.Rspack.resolve") {
      return { kind: "bundler-files", label: labelFor(operandTarget) }
    }
    const reduced = Compose.checkOperand(operand)
    if (typeof reduced === "string") return reduced
    return reduced._tag === "SourceSet"
      ? { kind: "sources", sources: reduced.sources }
      : { kind: "closure", entries: reduced.entries }
  }
  const gateLabelsOf = (gates: ReadonlyArray<Target.AnyTarget>): ReadonlyArray<readonly [string, string]> =>
    gates.map((gate) => [AgentTarget.targetIdentity(gate), labelFor(gate)] as const)
  let lane: LaneData | undefined
  switch (rule) {
    case "Shell.Serve": {
      const serveAttrs = attrs as (typeof Shell.ServeAttrs)["Type"]
      lane = { kind: "serve", readiness: serveAttrs.readiness, health: serveAttrs.health, stop: serveAttrs.stop }
      break
    }
    case "ImportClosure": {
      const closureAttrs = attrs as (typeof Compose.ImportClosureAttrs)["Type"]
      const entries = Compose.closureEntrySources(closureAttrs.entries, implementationContext)
      if (typeof entries === "string") noteRefusal(`ImportClosure: ${entries}`)
      else lane = { kind: "closure", entries }
      break
    }
    case "Test": {
      const testAttrs = attrs as (typeof Compose.TestAttrs)["Type"]
      const left = testOperandPlan(testAttrs.expect.left)
      const right = testOperandPlan(testAttrs.expect.right)
      if (typeof left === "string") noteRefusal(`Test: ${left}`)
      else if (typeof right === "string") noteRefusal(`Test: ${right}`)
      else lane = { kind: "files-test", left, right }
      break
    }
    case "Bundler.Rspack.resolve": {
      const resolveAttrs = attrs as (typeof BundlerTarget.ResolveAttrs)["Type"]
      lane = {
        kind: "bundler-resolve",
        payload: {
          configPath: Input.resolvePath(packagePath, resolveAttrs.config.path),
          entries: [...resolveAttrs.entries],
          mode: "development"
        }
      }
      break
    }
    case "Bundler.Rspack.build": {
      const buildAttrs = attrs as (typeof BundlerTarget.BuildAttrs)["Type"]
      if (Target.metadata(buildAttrs.graph).target !== "Bundler.Rspack.resolve") {
        noteRefusal(
          `the graph of a bundler build must be a Bundler.Rspack.resolve target: ${labelFor(buildAttrs.graph)}`
        )
        break
      }
      const buildOutDirs = buildAttrs.outDirs.map((dir) => Input.resolvePath(packagePath, dir))
      outDirs.push(...buildOutDirs)
      lane = {
        kind: "bundler-build",
        graphLabel: labelFor(buildAttrs.graph),
        payload: {
          configPath: Input.resolvePath(packagePath, buildAttrs.config.path),
          environment: buildAttrs.environment,
          mode: buildAttrs.mode,
          env: buildAttrs.env === undefined ? {} : { ...buildAttrs.env },
          outDirs: buildOutDirs
        }
      }
      break
    }
    case "Agent.Lint": {
      const lintAttrs = attrs as (typeof AgentTarget.LintAttrs)["Type"]
      lane = {
        kind: "agent",
        flavor: "lint",
        payload: AgentTarget.lintPayload(lintAttrs, implementationContext),
        gateLabels: []
      }
      break
    }
    case "Agent.Diff": {
      const diffAttrs = attrs as (typeof AgentTarget.DiffAttrs)["Type"]
      lane = {
        kind: "agent",
        flavor: "diff",
        payload: AgentTarget.diffPayload(diffAttrs, implementationContext),
        gateLabels: gateLabelsOf(diffAttrs.gates)
      }
      break
    }
    case "Agent.Pr": {
      const prAttrs = attrs as (typeof AgentTarget.PrAttrs)["Type"]
      lane = {
        kind: "agent",
        flavor: "pr",
        payload: AgentTarget.prPayload(prAttrs, implementationContext),
        gateLabels: gateLabelsOf(prAttrs.gates)
      }
      break
    }
    case "Git.Commit":
      lane = { kind: "git-commit" }
      break
    case "Github.CiGen":
      lane = { kind: "ci-gen" }
      break
    case "Github.Setup":
    case "Github.Workflow":
      lane = { kind: "github-decl" }
      break
    case "Github.Pr":
      lane = { kind: "github-pr" }
      break
    case "Memory.Retain":
      lane = { kind: "memory-retain" }
      break
    default:
      lane = undefined
  }

  // NodeModule dependency references key the installed package version.
  const moduleRefs: Array<Record<string, unknown>> = []
  collectTagged(attrs, "NodeModule", moduleRefs, new Set())
  for (const reference of moduleRefs) {
    const packageName = String(reference["package"])
    toolchain.push({ tag: "NodeModule", package: packageName, version: await moduleVersion(context.root, packageName) })
  }

  // Current write-set state keys the check verdict: a hand-edited generated
  // file or a removed emitted symlink must re-key the check.
  let writeSetState: unknown = null
  if (rule === "Generate" || rule === "Shell.Diff") {
    if (emit !== undefined) {
      const states: Array<unknown> = []
      for (const entry of emit) {
        const state = await PackageTree.pathState(NodePath.join(context.root, ...entry.path.split("/")))
        states.push({ path: entry.path, state })
      }
      writeSetState = states
    } else {
      const states: Array<unknown> = []
      for (const pattern of writeSet) {
        const matches = await Input.expandGlob(context.root, "", pattern, {
          cacheDirectory: context.cacheDirectory,
          signal: context.signal
        })
        const files = await Input.digestFiles(context.root, matches, { signal: context.signal })
        states.push({ pattern, digest: Input.digestText(JSON.stringify(files)) })
      }
      writeSetState = states
    }
  }

  // The mode a target is planned under. A root's requested mode wins over the
  // dependency mode an earlier visitor asked for, so a `--write` root that is
  // also reached as a check-mode gate or dependency is planned once, in write
  // mode, and applies. See `PlanContext.rootModes`.
  const mode = context.rootModes.get(label) ?? options.mode
  const gateDeps = attrTargets(attrs, "gates").map((gate) => depLabels.get(gate) ?? labelOf(context, gate))

  // Execution edges: what must settle green before this node runs.
  let executionDeps: Array<string>
  if (rule === "Clean" || refusal !== undefined) {
    executionDeps = []
  } else if (rule === "Alias") {
    executionDeps = aliasOf === undefined ? [] : [aliasOf]
  } else if (rule === "Materialize") {
    executionDeps = materializeOf === undefined ? [] : [materializeOf]
  } else if (rule === "Suite") {
    executionDeps = [...members]
  } else {
    const serviceSet = new Set(serviceDeps)
    executionDeps = [
      ...new Set([
        ...dependencyRows.map((row) => row.label).filter((depLabel) => !serviceSet.has(depLabel)),
        ...hoistedDeps
      ])
    ]
  }

  const cacheable = refusal === undefined && (
    (rule === "Shell.Test" && mode === "execute") ||
    rule === "Shell.Build" ||
    (rule === "Generate" && mode === "check") ||
    rule === "Test" ||
    rule === "Bundler.Rspack.resolve" ||
    rule === "Bundler.Rspack.build"
  )

  const keyMaterial: Planner.KeyMaterial = {
    body: {
      flow: target._tag,
      target: rule,
      // `metadata.implementationDigest` is deliberately absent: function
      // identity carries per-process entropy (closures cannot be inspected),
      // so it can never answer a cross-process hit. The ambient
      // implementation fingerprint in `inputs` covers every byte of the
      // executor and rule implementations instead.
      schemas: metadata.schemaIdentity,
      mode,
      cwd,
      outputs: outDirs.length === 0 ? null : [...outDirs],
      executionFormat: Planner.EXECUTION_FORMAT,
      packageFormat: PACKAGE_EXECUTION_FORMAT
    },
    inputs: {
      ambient: context.ambient,
      attrs: Planner.attrsValue(attrs, depKeys, inputDigests),
      declared: declaredInputs,
      dependencies: dependencyRows,
      toolchain,
      writeSetState
    },
    layers: [],
    capabilities: capabilitiesFor(rule, mode, sandbox)
  }

  // A bundler build's preview key substitutes the cached graph digest when
  // the store holds one; the template keeps the sentinel for execution.
  let keyTemplate: Planner.KeyMaterial | undefined
  let previewMaterial = keyMaterial
  if (graphResolveNode !== undefined) {
    keyTemplate = keyMaterial
    const digest = await graphDigestOf(context, graphResolveNode)
    previewMaterial = keyMaterialWithGraph(
      keyTemplate,
      digest === undefined ? graphResolveNode.keyPreview : `bundler-graph:${digest}`
    )
  }

  // Key-material forensics: SMTHRS_DEBUG_KEYS=<file> appends every node's
  // injective encoding, so two runs' keys can be diffed byte for byte.
  if (process.env["SMTHRS_DEBUG_KEYS"] !== undefined) {
    NodeFs.appendFileSync(
      process.env["SMTHRS_DEBUG_KEYS"],
      `=== ${label}\n${Planner.encodeKeyMaterial(previewMaterial)}\n`
    )
  }
  const node: PackageNode = {
    label,
    target: rule,
    kinds: metadata.kinds,
    attrs,
    dependencies: executionDeps,
    declaredInputs,
    declaredOutputs: undefined,
    cacheable,
    cacheLookup: "not-wired",
    wouldRun: true,
    keyMaterial: previewMaterial,
    keyPreview: Planner.keyOf(previewMaterial),
    rule,
    mode,
    packagePath,
    declaration: target,
    serviceDeps,
    lane,
    keyTemplate,
    refusal,
    sandbox,
    secrets,
    argv,
    cwd,
    env,
    bunTemplate,
    writeSet,
    outDirs,
    emit,
    members,
    aliasOf,
    materializeOf,
    gateDeps,
    cleanOutDirs,
    cleanPaths
  }
  context.visiting.delete(target)
  context.nodes.set(label, node)
  return node
}

/** The mode one root executes under, given the invocation. */
const rootMode = (rule: string, options: RunOptions): Mode => {
  if (!checkModeRules.has(rule)) return "execute"
  if (options.write === true || options.fix === true) return "write"
  if (options.verb === "run") return "write"
  return "check"
}

const managerBinaryOf = (workspace: PackageIndexModule.PackageIndex["workspace"]): string => {
  const manager = workspace.packageManager as { readonly _tag?: unknown; readonly name?: unknown }
  if (manager._tag === "YarnPackageManager") return "yarn"
  if (typeof manager.name === "string") return manager.name
  return "pnpm"
}

/**
 * One planned package-mode execution: the keyed nodes plus the scheduled
 * work list.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackagePlan {
  readonly roots: ReadonlyArray<string>
  readonly workList: ReadonlyArray<PackageNode>
  readonly nodes: ReadonlyMap<string, PackageNode>
  /**
   * ImportClosure label → the closure computed at plan time to key its
   * consumers. Execution reports the same result rather than resolving twice.
   */
  readonly closures: ReadonlyMap<string, Compose.ClosureResult>
}

/**
 * Plans one package-mode invocation: resolves roots, walks the graph,
 * resolves tools, and keys every node.
 *
 * @category planning
 * @since 0.1.0
 */
export const plan = async (options: RunOptions): Promise<PackagePlan> => {
  const index = options.index
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const rows = index.resolve(options.pattern)
  const verb = options.verb
  const selected = verb === "auto"
    ? rows
    : rows.filter((row) => Target.metadata(row.target).kinds.includes(verb))
  if (verb !== "auto" && rows.length === 1 && selected.length === 0) {
    throw new Error(`target selected by ${options.pattern} does not support the ${verb} verb`)
  }
  if (selected.length === 0) throw new Error(`no targets selected by ${options.pattern} for the ${verb} verb`)
  // The mode each selected root is planned under. Computed before the walk so a
  // target reached first as a dependency still adopts its root mode. A label
  // appears at most once in `selected`, so this maps each root to one mode.
  const rootModes = new Map<string, Mode>()
  for (const row of selected) {
    rootModes.set(row.label, rootMode(Target.metadata(row.target).target, options))
  }
  const workspace = index.workspace
  const lockfilePath = (workspace.packageManager as { readonly lockfile?: { readonly path?: unknown } }).lockfile?.path
  const lockfileDigest = typeof lockfilePath === "string"
    ? await Input.digestFile(NodePath.join(index.root, Input.resolvePath("", lockfilePath)), {
      workspaceRoot: index.root,
      signal: options.signal
    })
    : undefined
  const context: PlanContext = {
    root: index.root,
    cacheDirectory: options.cacheDirectory,
    index,
    signal: options.signal,
    log,
    flags: workspace.flags?.flags ?? {},
    managerBinary: managerBinaryOf(workspace),
    tools: new Map(),
    probes: new Map(),
    nodes: new Map(),
    privateLabels: new WeakMap(),
    privateCounter: 0,
    visiting: new Set(),
    rootModes,
    ambient: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      lockfile: lockfileDigest ?? null,
      implementation: await Planner.implementationFingerprint(options.signal)
    },
    store: undefined,
    storeWarned: false,
    closureDigests: new Map(),
    closureResults: new Map(),
    graphDigests: new Map()
  }
  const roots: Array<string> = []
  try {
    for (const row of selected) {
      const rule = Target.metadata(row.target).target
      const node = await visit(context, row.target, { mode: rootMode(rule, options) })
      roots.push(node.label)
    }
  } finally {
    // The plan-time store is scoped to planning; execution opens its own.
    if (context.store !== undefined) await context.store.close().catch(() => undefined)
  }
  // The work list is the closure of the roots over execution edges only;
  // key-only dependencies (a Clean's targets, a refused rule's attrs) stay
  // planned but unscheduled.
  const workLabels = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const label = queue.pop()!
    if (workLabels.has(label)) continue
    workLabels.add(label)
    const node = context.nodes.get(label)
    if (node === undefined) throw new Error(`planned execution edge names an unplanned node: ${label}`)
    for (const dependency of node.dependencies) queue.push(dependency)
    for (const gate of node.gateDeps) queue.push(gate)
  }
  const workList = [...workLabels].map((label) => context.nodes.get(label)!)
  return { roots, workList, nodes: context.nodes, closures: context.closureResults }
}

/** Renders a duration for status lines. */
const formatDuration = (durationMs: number): string =>
  durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${Math.round(durationMs)}ms`

const sandboxProfile = "(version 1)(allow default)(deny network*)"

/**
 * The profile of a consumer that declared `services`: the network stays
 * denied except outbound loopback, which is how the consumer reaches the
 * service the executor started for it.
 */
const sandboxProfileWithLoopback = `${sandboxProfile}(allow network-outbound (remote ip "localhost:*"))`

const wrapSandbox = (
  argv: ReadonlyArray<string>,
  sandbox: PackageNode["sandbox"],
  label: string,
  log: (line: string) => void,
  loopback = false
): ReadonlyArray<string> => {
  if (sandbox === "none") return argv
  if (typeof sandbox === "object" && sandbox !== null && sandbox.network === true) return argv
  if (process.platform !== "darwin") {
    log(`${label}  sandbox: unenforced on this platform`)
    return argv
  }
  return ["/usr/bin/sandbox-exec", "-p", loopback ? sandboxProfileWithLoopback : sandboxProfile, ...argv]
}

/** Joins the invocation's abort signal with a per-consumer one, when both exist. */
const joinSignals = (...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal | undefined => {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return AbortSignal.any(present)
}

const isServiceError = (value: unknown): value is ServiceSupervisor.ServiceError =>
  typeof value === "object" && value !== null &&
  (value as { readonly _tag?: unknown })._tag === "smithers-build/ServiceError"

const serviceErrorText = (error: ServiceSupervisor.ServiceError): string => {
  const tail = error.outputTail.trim()
  return `service ${error.key} ${error.reason}: ${error.message}${
    tail === "" ? "" : `\n--- ${error.key} output tail ---\n${tail}`
  }`
}

const isFilesTestError = (value: unknown): value is Compose.FilesTestError =>
  typeof value === "object" && value !== null &&
  (value as { readonly _tag?: unknown })._tag === "smithers-build/FilesTestError"

/** How many rows a file-set verdict names before summarizing the rest. */
const sampleLimit = 20

const sampleRows = (title: string, rows: ReadonlyArray<string>): string =>
  rows.length === 0
    ? ""
    : `\n  ${title}: ${rows.slice(0, sampleLimit).join(", ")}${
      rows.length > sampleLimit ? ` (+${rows.length - sampleLimit} more)` : ""
    }`

const filesTestErrorText = (error: Compose.FilesTestError): string =>
  error.message +
  sampleRows("leftover", error.leftover) +
  sampleRows("unresolved", error.unresolved.map((issue) => `${issue.file} -> ${issue.specifier}`)) +
  sampleRows("dynamic", error.dynamic.map((issue) => `${issue.file} -> ${issue.specifier}`))

const execErrorText = (error: Exec.ExecError): string => {
  const stderr = error.stderr.trim()
  const stdout = error.stdout.trim()
  const detail = stderr !== "" ? stderr : stdout
  return `command failed (exit ${error.exitCode}): ${error.argv.join(" ")}${detail === "" ? "" : `\n${detail}`}`
}

interface ExecOutcome {
  readonly ok: boolean
  readonly error?: string | undefined
  readonly result?: Exec.Result | undefined
}

/**
 * Executes one planned package-mode work list with keep-going scheduling.
 *
 * @category execution
 * @since 0.1.0
 */
export const execute = async (
  planned: PackagePlan,
  options: RunOptions
): Promise<Executor.Summary> => {
  const index = options.index
  const root = index.root
  const cacheDirectory = options.cacheDirectory
  const jobs = Executor.resolveJobs(options.jobs)
  const readCache = options.readCache ?? true
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const startedAt = performance.now()
  const store = await openCache({ workspaceRoot: root, cacheDirectory, warn: log })
  const reports = new Map<string, Executor.TargetReport>()
  const notGreen = new Set<string>()
  const byLabel = new Map(planned.workList.map((node) => [node.label, node]))

  const report = (entry: Executor.TargetReport): void => {
    reports.set(entry.label, entry)
    const line = `${entry.label}  ${entry.status}  ${formatDuration(entry.durationMs)}`
    log(entry.error === undefined ? line : `${line}  ${entry.error}`)
  }

  /** The supervisor of this invocation's services; set once the scheduler's scope opens. */
  const supervisorRef: { current: ServiceSupervisor.ServiceSupervisor | undefined } = { current: undefined }
  const supervisorOf = (): ServiceSupervisor.ServiceSupervisor => {
    if (supervisorRef.current === undefined) throw new Error("the service supervisor is not open")
    return supervisorRef.current
  }
  /** Bundler resolve label → the graph settled (ran or hit) in this invocation. */
  const resolveResults = new Map<string, BundlerTarget.ResolveResult>()
  /** Label → the key a node actually executed and cached under, when it differs from the preview. */
  const effectiveKeys = new Map<string, string>()
  const keyFor = (node: PackageNode): string => effectiveKeys.get(node.label) ?? node.keyPreview
  const resolverOptions: Resolver.LiveOptions = { workspaceRoot: root, cacheDirectory, cache: store }
  const runnerOptions: RspackRunner.RunnerOptions = {
    workspaceRoot: root,
    scratchDirectory: bundlerScratchDirectory(root, cacheDirectory)
  }

  /**
   * Resolves the argv and environment one node spawns with: secrets from the
   * host environment, the generated bun program for `bun:` templates. Shared
   * by tool runs and by service acquisition, so a Serve target spawns exactly
   * the process its declaration plans.
   */
  const resolveSpawn = async (
    node: PackageNode
  ): Promise<
    { readonly argv: [string, ...Array<string>]; readonly env: Record<string, string> } | { readonly error: string }
  > => {
    if (node.argv === undefined) return { error: `${node.rule} planned no executable` }
    const secretEnv: Record<string, string> = {}
    for (const name of node.secrets) {
      const value = process.env[name]
      if (value === undefined) {
        return {
          error: `missing secret: environment variable ${name} is not set (declared as S.Secret(${
            JSON.stringify(name)
          }))`
        }
      }
      secretEnv[name] = value
    }
    let argv = [...node.argv]
    if (node.bunTemplate !== undefined) {
      const directory = NodePath.join(root, ...cacheDirectory.split("/"), "tmp")
      await Fs.mkdir(directory, { recursive: true })
      const program = NodePath.join(directory, `bun-${node.keyPreview.slice(0, 16)}.ts`)
      const lines = [
        `import { $ } from "bun"`,
        ...Object.entries(node.bunTemplate.consts).map(([name, path]) => `const ${name} = ${JSON.stringify(path)}`),
        node.bunTemplate.template,
        ""
      ]
      await Fs.writeFile(program, lines.join("\n"), "utf8")
      argv = argv.map((entry) => entry === Shell.bunProgramToken ? program : entry)
    }
    return { argv: argv as [string, ...Array<string>], env: { ...node.env, ...secretEnv } }
  }

  const spawnNode = async (
    node: PackageNode,
    workspaceRoot: string,
    signal: AbortSignal | undefined = options.signal
  ): Promise<ExecOutcome> => {
    const resolved = await resolveSpawn(node)
    if ("error" in resolved) return { ok: false, error: resolved.error }
    const wrapped = wrapSandbox(resolved.argv, node.sandbox, node.label, log, node.serviceDeps.length > 0)
    const payload: Exec.Payload = {
      cwd: node.cwd,
      argv: wrapped as [string, ...Array<string>],
      env: resolved.env,
      secrets: [],
      expectedExitCodes: [0],
      timeoutMs: Shell.packageExecTimeoutMs
    }
    const exit = await Effect.runPromiseExit(
      Exec.run({ workspaceRoot, cacheDirectory }, payload),
      { signal }
    )
    if (Exit.isSuccess(exit)) return { ok: true, result: exit.value }
    // Exec.run fails only with ExecError; render whatever the cause carries.
    const value: unknown = Cause.squash(exit.cause)
    if (
      typeof value === "object" && value !== null &&
      (value as { readonly _tag?: unknown })._tag === "smithers-build/ExecError"
    ) {
      return { ok: false, error: execErrorText(value as Exec.ExecError) }
    }
    return { ok: false, error: Diagnostic.message(value, "tool run failed") }
  }

  const decodeBuildOutput = (output: unknown): ReadonlyArray<PackageTree.OutDirManifest> | undefined => {
    if (typeof output !== "object" || output === null) return undefined
    if ((output as { readonly kind?: unknown }).kind !== "build") return undefined
    const manifests = (output as { readonly manifests?: unknown }).manifests
    if (!Array.isArray(manifests)) return undefined
    const decoded: Array<PackageTree.OutDirManifest> = []
    for (const manifest of manifests) {
      const valid = PackageTree.decodeManifest(manifest)
      if (valid === undefined) return undefined
      decoded.push(valid)
    }
    return decoded
  }

  // A cache entry's own `outDir` is untrusted (a shared remote, a backup, a
  // hand edit). `decodeManifest` already confines it to a workspace-relative
  // path with no `..`, but a valid-looking outDir that the target never
  // declared must still not drive a materialize: the decoded set is required
  // to be exactly the target's declared output roots before any tree is
  // written or rename-swapped, so a poisoned entry cannot place bytes over a
  // directory this target does not own.
  const manifestsBindToDeclared = (
    manifests: ReadonlyArray<PackageTree.OutDirManifest>,
    declared: ReadonlyArray<string>
  ): boolean => {
    const declaredSet = new Set(declared)
    if (manifests.length !== declaredSet.size) return false
    const seen = new Set<string>()
    for (const manifest of manifests) {
      if (!declaredSet.has(manifest.outDir) || seen.has(manifest.outDir)) return false
      seen.add(manifest.outDir)
    }
    return true
  }

  const cacheGet = async (
    node: PackageNode,
    key: string = node.keyPreview
  ): Promise<{ readonly output: unknown } | undefined> => {
    if (!readCache || !node.cacheable) return undefined
    const cached = await store.get(key).catch(() => null)
    if (cached === null || !cached.exitOk || cached.target !== node.rule || cached.label !== node.label) {
      return undefined
    }
    return { output: cached.output }
  }

  const cachePut = async (node: PackageNode, output: unknown, key: string = node.keyPreview): Promise<void> => {
    if (!node.cacheable) return
    await store.put(key, {
      key,
      target: node.rule,
      label: node.label,
      exitOk: true,
      output,
      storedAt: new Date().toISOString()
    }).catch((cause: unknown) => {
      log(`smthrs: could not store ${node.label} in the cache: ${Diagnostic.message(cause)}`)
    })
  }

  /**
   * Restores a build's captured outDirs from a cache entry: the manifests
   * must bind to the declared outputs and every blob must verify before any
   * tree is materialized. Returns false on any doubt, which is a miss.
   */
  const restoreBuild = async (node: PackageNode, output: unknown): Promise<boolean> => {
    const manifests = decodeBuildOutput(output)
    if (manifests === undefined || !manifestsBindToDeclared(manifests, node.outDirs)) return false
    for (const manifest of manifests) {
      const problem = await PackageTree.verifyManifestBlobs(root, cacheDirectory, manifest)
      if (problem !== undefined) {
        log(`${node.label}  cache miss: ${problem}`)
        return false
      }
    }
    for (const manifest of manifests) {
      await PackageTree.materializeManifest(root, cacheDirectory, manifest)
    }
    return true
  }

  const captureBuild = async (node: PackageNode, key: string): Promise<void> => {
    const manifests: Array<PackageTree.OutDirManifest> = []
    for (const outDir of node.outDirs) {
      manifests.push(await PackageTree.captureOutDir(root, cacheDirectory, outDir))
    }
    await cachePut(node, { kind: "build", manifests }, key)
  }

  /** Resolves one Serve node to the spec the supervisor spawns and probes. */
  const serviceSpecOf = async (
    label: string
  ): Promise<ServiceSupervisor.ServiceSpec | { readonly error: string }> => {
    const serveNode = planned.nodes.get(label)
    if (serveNode === undefined) return { error: `service ${label} was not planned` }
    if (serveNode.refusal !== undefined) return { error: `service ${label}: ${serveNode.refusal}` }
    if (serveNode.lane?.kind !== "serve") return { error: `service ${label} is not a Shell.Serve target` }
    const resolved = await resolveSpawn(serveNode)
    if ("error" in resolved) return { error: `service ${label}: ${resolved.error}` }
    if (serveNode.sandbox !== "none") {
      // A service exists to be reached over the network, so it spawns without
      // the tool sandbox; said once per acquisition so the log never implies
      // confinement the supervisor does not apply.
      log(`${label}  sandbox: services spawn unconfined`)
    }
    return {
      key: label,
      cwd: Exec.resolveWorkspacePath(root, serveNode.cwd),
      argv: resolved.argv,
      env: resolved.env,
      readiness: serveNode.lane.readiness,
      health: serveNode.lane.health,
      stop: serveNode.lane.stop
    }
  }

  /** The outcome one node settles with; `runOne` reports it exactly once. */
  type Outcome =
    | { readonly status: "hit" | "ran"; readonly error?: undefined }
    | { readonly status: "failed" | "skipped"; readonly error: string }
  const fail = (error: string): Outcome => ({ status: "failed", error })
  const green = (status: "hit" | "ran"): Outcome => ({ status })

  const outcomeOfExit = (exit: Exit.Exit<Outcome, unknown>, what: string): Outcome => {
    if (Exit.isSuccess(exit)) return exit.value
    if (Cause.hasInterruptsOnly(exit.cause)) return fail(`${what} interrupted`)
    const value: unknown = Cause.squash(exit.cause)
    if (typeof value === "string") return fail(value)
    if (isServiceError(value)) return fail(serviceErrorText(value))
    return fail(Diagnostic.message(value, `${what} failed`))
  }

  /**
   * Runs a consumer under its declared services: every service is acquired
   * (readiness-gated) inside the consumer's scope, the consumer runs raced
   * against their health, and the scope closes in every outcome so the last
   * consumer's release applies each service's stop contract.
   */
  const underServices = (
    node: PackageNode,
    body: (signal: AbortSignal | undefined) => Promise<Outcome>
  ): Promise<Outcome> => {
    const program = Effect.scoped(Effect.gen(function*() {
      const supervisor = supervisorOf()
      const handles: Array<ServiceSupervisor.ServiceHandle> = []
      for (const serviceLabel of node.serviceDeps) {
        const spec = yield* Effect.promise(() => serviceSpecOf(serviceLabel))
        if ("error" in spec) return yield* Effect.fail(spec.error)
        log(`${node.label}  service ${serviceLabel}: starting`)
        const handle = yield* supervisor.acquire(spec)
        log(`${node.label}  service ${serviceLabel}: ready (pid ${handle.pid})`)
        handles.push(handle)
      }
      const consumer = Effect.promise((signal) => body(joinSignals(options.signal, signal)))
      return yield* handles.reduce<Effect.Effect<Outcome, ServiceSupervisor.ServiceError>>(
        (effect, handle) => handle.whileHealthy(effect),
        consumer
      )
    }))
    return Effect.runPromiseExit(program, { signal: options.signal })
      .then((exit) => outcomeOfExit(exit, `${node.label} under services`))
  }

  /** Reduces one `S.Test` operand to its workspace-relative path set. */
  const testOperandPaths = async (operand: TestOperandPlan, side: "left" | "right"): Promise<ReadonlyArray<string>> => {
    switch (operand.kind) {
      case "sources":
        return Resolver.expandAnchoredSources({
          workspaceRoot: root,
          cacheDirectory,
          sources: operand.sources,
          requireFiles: false
        })
      case "closure":
        return Resolver.operandPaths(resolverOptions, { _tag: "Closure", entries: operand.entries }, side)
      case "bundler-files": {
        const graph = resolveResults.get(operand.label)
        if (graph === undefined) {
          throw new Error(`bundler graph ${operand.label} settled no result in this invocation`)
        }
        return graph.files.map((file) => file.path)
      }
    }
  }

  const closureSummary = (result: Compose.ClosureResult): string =>
    `${result.files.length} files, ${result.packages.length} packages, ` +
    `${result.unresolved.length} unresolved, ${result.dynamic.length} dynamic`

  const graphSummary = (result: BundlerTarget.ResolveResult): string =>
    `${result.moduleCount} modules, ${result.files.length} workspace files, ` +
    `${result.packages.length} packages, graph ${result.graphDigest.slice(0, 16)}`

  const matchesWriteSet = (path: string, patterns: ReadonlyArray<string>): boolean =>
    patterns.some((pattern) => minimatch(path, pattern, { dot: true }) || path === pattern)

  /** Runs one mutating tool with mechanical write-set confinement. */
  const runWriteEnforced = async (node: PackageNode, signal: AbortSignal | undefined): Promise<ExecOutcome> => {
    const snapshot = await PackageTree.snapshotTree(root, cacheDirectory)
    // Git omits gitignored paths, so a cheap content-free guard records them
    // separately; an out-of-set write to a gitignored path would otherwise be
    // invisible to the change set and never reverted.
    const ignored = await PackageTree.snapshotIgnored(root, cacheDirectory)
    // Git cannot see a write that lands through an in-workspace symlink whose
    // real target leaves the workspace; those portals are measured directly.
    const portals = await PackageTree.snapshotPortals(
      root,
      cacheDirectory,
      (link) => log(`${node.label}  portal left unconfined (target too large): ${link}`)
    )
    try {
      const spawned = await spawnNode(node, root, signal)
      const changed = await PackageTree.changedSinceSnapshot(snapshot, cacheDirectory)
      const changedIgnored = await PackageTree.changedIgnored(ignored, cacheDirectory)
      // Any write through an escaping-symlink portal is out of the workspace and
      // therefore out of any write-set; it is reverted whether the run passed
      // or failed.
      const escapedPortals = await PackageTree.revertChangedPortals(portals)
      if (!spawned.ok) {
        // A failed apply reverts everything it touched: a partial write from
        // a tool that then errored is not a state anyone asked for.
        for (const path of changed) await PackageTree.revertPath(snapshot, path)
        for (const path of changedIgnored) {
          const resolved = PackageTree.resolveChangedPath(root, path)
          if (resolved === undefined || !matchesWriteSet(resolved, node.writeSet)) {
            await PackageTree.revertIgnored(ignored, path)
          }
        }
        return spawned
      }
      const outOfSet: Array<string> = []
      for (const path of changed) {
        const resolved = PackageTree.resolveChangedPath(root, path)
        if (resolved === undefined || !matchesWriteSet(resolved, node.writeSet)) outOfSet.push(path)
      }
      for (const path of outOfSet) await PackageTree.revertPath(snapshot, path)
      const ignoredOutOfSet: Array<string> = []
      for (const path of changedIgnored) {
        const resolved = PackageTree.resolveChangedPath(root, path)
        if (resolved === undefined || !matchesWriteSet(resolved, node.writeSet)) {
          await PackageTree.revertIgnored(ignored, path)
          ignoredOutOfSet.push(path)
        }
      }
      const offenders = [...outOfSet, ...ignoredOutOfSet, ...escapedPortals]
      if (offenders.length > 0) {
        return {
          ok: false,
          error: `wrote outside its declared write-set (reverted): ${offenders.join(", ")}`
        }
      }
      return { ok: true }
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
      await PackageTree.releasePortals(portals)
    }
  }

  /** Runs one check-mode tool against a scratch copy and reports drift. */
  const runCheckViaScratch = async (node: PackageNode, signal: AbortSignal | undefined): Promise<ExecOutcome> => {
    // The scratch copy carries the real tree's escaping symlinks verbatim, so a
    // dry-run write through one lands in the same external target the real tree
    // points at. Measure those portals against the real tree: check mode must
    // never touch it.
    const portals = await PackageTree.snapshotPortals(
      root,
      cacheDirectory,
      (link) => log(`${node.label}  portal left unconfined (target too large): ${link}`)
    )
    const scratch = await PackageTree.scratchCopy(root, cacheDirectory)
    try {
      const spawned = await spawnNode(node, scratch, signal)
      const escapedPortals = await PackageTree.revertChangedPortals(portals)
      if (!spawned.ok) return spawned
      if (escapedPortals.length > 0) {
        return {
          ok: false,
          error: `check touched the real tree through a symlink (reverted): ${escapedPortals.join(", ")}`
        }
      }
      const drift: Array<string> = []
      for (const pattern of node.writeSet) {
        const realFiles = await Input.expandGlob(root, "", pattern, {
          cacheDirectory,
          signal: options.signal
        })
        const scratchFiles = await Input.expandGlob(scratch, "", pattern, {
          cacheDirectory,
          signal: options.signal
        })
        const paths = [...new Set([...realFiles, ...scratchFiles])].sort()
        for (const path of paths) {
          const realState = await PackageTree.pathState(NodePath.join(root, ...path.split("/")))
          const scratchState = await PackageTree.pathState(NodePath.join(scratch, ...path.split("/")))
          const same = JSON.stringify(realState) === JSON.stringify(scratchState)
          if (!same) drift.push(path)
        }
      }
      if (drift.length > 0) {
        return { ok: false, error: `drift in declared write-set (run with --write to apply): ${drift.join(", ")}` }
      }
      return { ok: true }
    } finally {
      await Fs.rm(scratch, { recursive: true, force: true })
      await PackageTree.releasePortals(portals)
    }
  }

  const runEmit = async (node: PackageNode): Promise<ExecOutcome> => {
    const entries = node.emit ?? []
    if (node.mode === "write") {
      for (const entry of entries) {
        const absolute = NodePath.join(root, ...entry.path.split("/"))
        await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
        await Fs.rm(absolute, { force: true })
        if (entry.value.kind === "link") await Fs.symlink(entry.value.target, absolute)
        else await Fs.writeFile(absolute, entry.value.text, "utf8")
      }
      return { ok: true }
    }
    const wrong: Array<string> = []
    for (const entry of entries) {
      const state = await PackageTree.pathState(NodePath.join(root, ...entry.path.split("/")))
      if (entry.value.kind === "link") {
        if (state.kind !== "link" || state.target !== entry.value.target) wrong.push(entry.path)
      } else if (
        state.kind !== "file" ||
        state.digest !== PackageTree.digestBytes(Buffer.from(entry.value.text, "utf8"))
      ) {
        wrong.push(entry.path)
      }
    }
    if (wrong.length > 0) {
      return { ok: false, error: `drift in declared emit outputs (run with --write to apply): ${wrong.join(", ")}` }
    }
    return { ok: true }
  }

  /**
   * Executes one node's rule body and settles its outcome. `signal` is the
   * abort signal the node's processes honor: the invocation's own, joined
   * with the service race for a consumer running under services.
   */
  const dispatch = async (node: PackageNode, signal: AbortSignal | undefined): Promise<Outcome> => {
    try {
      switch (node.rule) {
        case "Filegroup":
          return green("ran")
        case "Suite": {
          const line = node.members
            .map((member) => `${member}=${reports.get(member)?.status ?? "unscheduled"}`)
            .join(", ")
          const red = node.members.filter((member) => {
            const status = reports.get(member)?.status
            return status !== "hit" && status !== "ran"
          })
          if (red.length > 0) return fail(`suite is red; members: ${line}`)
          log(`${node.label}  members: ${line}`)
          return green("ran")
        }
        case "Alias": {
          if (node.aliasOf === undefined) return fail("alias names no target")
          const status = reports.get(node.aliasOf)?.status
          if (status !== "hit" && status !== "ran") return fail(`aliased target ${node.aliasOf} did not succeed`)
          return green("ran")
        }
        case "Materialize": {
          if (node.materializeOf === undefined) return fail("materialize names no target")
          const producer = planned.nodes.get(node.materializeOf)
          if (producer === undefined) return fail(`materialize target ${node.materializeOf} was not planned`)
          const cached = await store.get(keyFor(producer)).catch(() => null)
          const manifests = cached !== null && cached.exitOk ? decodeBuildOutput(cached.output) : undefined
          if (manifests !== undefined) {
            // Bind the untrusted manifests to the producer's declared outputs
            // before materializing any of them: a cache entry whose outDir is a
            // valid relative path the producer never declared must not
            // rename-swap a directory this target does not own.
            if (!manifestsBindToDeclared(manifests, producer.outDirs)) {
              return fail(
                `cannot materialize: cached manifests for ${producer.label} do not match its declared outDirs`
              )
            }
            for (const manifest of manifests) {
              const matches = await PackageTree.treeMatchesManifest(root, manifest)
              if (matches === undefined) continue
              const blobProblem = await PackageTree.verifyManifestBlobs(root, cacheDirectory, manifest)
              if (blobProblem !== undefined) return fail(`cannot materialize: ${blobProblem}`)
              await PackageTree.materializeManifest(root, cacheDirectory, manifest)
            }
            return green("ran")
          }
          // No captured manifest: the producer ran in this invocation, so its
          // declared outDirs must exist on disk.
          for (const outDir of producer.outDirs) {
            try {
              const stats = await Fs.stat(NodePath.join(root, ...outDir.split("/")))
              if (!stats.isDirectory()) return fail(`declared outDir is not a directory: ${outDir}`)
            } catch {
              return fail(`no artifacts available to materialize: ${outDir} is absent`)
            }
          }
          return green("ran")
        }
        case "Clean": {
          for (const outDir of node.cleanOutDirs) {
            await Fs.rm(NodePath.join(root, ...outDir.split("/")), { recursive: true, force: true })
          }
          for (const declared of node.cleanPaths) {
            let absolute: string
            try {
              absolute = Exec.resolveWorkspacePath(root, declared)
            } catch (cause) {
              return fail(`clean path refused: ${Diagnostic.message(cause)}`)
            }
            await Fs.rm(absolute, { recursive: true, force: true })
          }
          return green("ran")
        }
        case "Shell.Build": {
          const cached = await cacheGet(node)
          if (cached !== undefined && await restoreBuild(node, cached.output)) return green("hit")
          const spawned = await spawnNode(node, root, signal)
          if (!spawned.ok) return fail(spawned.error ?? "tool run failed")
          await captureBuild(node, node.keyPreview)
          return green("ran")
        }
        case "Shell.Test": {
          const cached = await cacheGet(node)
          if (cached !== undefined) return green("hit")
          const spawned = await spawnNode(node, root, signal)
          if (!spawned.ok) return fail(spawned.error ?? "tool run failed")
          await cachePut(node, { kind: "shell-test" })
          return green("ran")
        }
        case "Shell.Run": {
          const spawned = await spawnNode(node, root, signal)
          if (!spawned.ok) return fail(spawned.error ?? "tool run failed")
          return green("ran")
        }
        case "Shell.Serve": {
          // Direct invocation: start, await readiness, hold the foreground
          // until the invocation is interrupted (or the service dies), then
          // let the scope's release apply the declared stop contract.
          const program = Effect.scoped(Effect.gen(function*() {
            const spec = yield* Effect.promise(() => serviceSpecOf(node.label))
            if ("error" in spec) return yield* Effect.fail(spec.error)
            const handle = yield* supervisorOf().acquire(spec)
            log(`${node.label}  ready (pid ${handle.pid}); serving until interrupted`)
            yield* handle.whileHealthy(Effect.never)
            return green("ran")
          }))
          const exit = await Effect.runPromiseExit(program, { signal })
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
            log(`${node.label}  stopped`)
            return green("ran")
          }
          return outcomeOfExit(exit, "serve")
        }
        case "Shell.Diff": {
          const outcome = node.mode === "write"
            ? await runWriteEnforced(node, signal)
            : await runCheckViaScratch(node, signal)
          if (!outcome.ok) return fail(outcome.error ?? "diff run failed")
          return green("ran")
        }
        case "ImportClosure": {
          if (node.lane?.kind !== "closure") return fail("import closure planned no entries")
          const result = planned.closures.get(node.label) ??
            await Resolver.closureOfEntries(resolverOptions, node.lane.entries)
          log(`${node.label}  closure: ${closureSummary(result)}`)
          return green("ran")
        }
        case "Test": {
          if (node.lane?.kind !== "files-test") return fail("file-set test planned no operands")
          const cached = await cacheGet(node)
          if (cached !== undefined) return green("hit")
          let left: ReadonlyArray<string>
          let right: Set<string>
          try {
            left = await testOperandPaths(node.lane.left, "left")
            right = new Set(await testOperandPaths(node.lane.right, "right"))
          } catch (cause) {
            return fail(isFilesTestError(cause) ? filesTestErrorText(cause) : Diagnostic.message(cause))
          }
          const leftover = left.filter((path) => !right.has(path))
          if (leftover.length > 0) {
            return fail(
              `expected the file-set difference to be empty, but ${leftover.length} of ${left.length} file(s) ` +
                `in the left set are missing from the right set${sampleRows("leftover", leftover)}`
            )
          }
          log(`${node.label}  difference empty: ${left.length} left, ${right.size} right`)
          await cachePut(node, { kind: "files-test" })
          return green("ran")
        }
        case "Bundler.Rspack.resolve": {
          if (node.lane?.kind !== "bundler-resolve") return fail("bundler resolve planned no payload")
          const cached = await cacheGet(node)
          if (cached !== undefined) {
            const result = decodeStoredResolve(cached.output)
            if (result !== undefined) {
              resolveResults.set(node.label, result)
              log(`${node.label}  graph: ${graphSummary(result)}`)
              return green("hit")
            }
          }
          const exit = await Effect.runPromiseExit(
            RspackRunner.resolveGraph(runnerOptions, node.lane.payload),
            { signal }
          )
          if (Exit.isFailure(exit)) {
            const value: unknown = Cause.squash(exit.cause)
            return fail(
              typeof value === "object" && value !== null &&
                (value as { readonly _tag?: unknown })._tag === "smithers-build/ExecError"
                ? execErrorText(value as Exec.ExecError)
                : Diagnostic.message(value, "bundler resolve failed")
            )
          }
          const stored: StoredResolve = { kind: "bundler-resolve", result: exit.value }
          resolveResults.set(node.label, exit.value)
          await cachePut(node, stored)
          log(`${node.label}  graph: ${graphSummary(exit.value)}`)
          return green("ran")
        }
        case "Bundler.Rspack.build": {
          if (node.lane?.kind !== "bundler-build" || node.keyTemplate === undefined) {
            return fail("bundler build planned no payload")
          }
          const graph = resolveResults.get(node.lane.graphLabel)
          if (graph === undefined) {
            return fail(`bundler graph ${node.lane.graphLabel} settled no result in this invocation`)
          }
          // The effective key carries the resolved graph digest: an edit that
          // leaves the resolved file set unchanged replays the build.
          const key = Planner.keyOf(keyMaterialWithGraph(node.keyTemplate, `bundler-graph:${graph.graphDigest}`))
          effectiveKeys.set(node.label, key)
          const cached = await cacheGet(node, key)
          if (cached !== undefined && await restoreBuild(node, cached.output)) return green("hit")
          const exit = await Effect.runPromiseExit(
            RspackRunner.runBuild(runnerOptions, node.lane.payload),
            { signal }
          )
          if (Exit.isFailure(exit)) {
            const value: unknown = Cause.squash(exit.cause)
            return fail(
              typeof value === "object" && value !== null &&
                (value as { readonly _tag?: unknown })._tag === "smithers-build/ExecError"
                ? execErrorText(value as Exec.ExecError)
                : Diagnostic.message(value, "bundler build failed")
            )
          }
          await captureBuild(node, key)
          return green("ran")
        }
        case "Generate": {
          if (node.emit !== undefined) {
            const outcome = await runEmit(node)
            if (!outcome.ok) return fail(outcome.error ?? "generate failed")
            if (node.mode === "check") await cachePut(node, { kind: "generate-check" })
            return green("ran")
          }
          if (node.mode === "check") {
            const cached = await cacheGet(node)
            if (cached !== undefined) return green("hit")
            const outcome = await runCheckViaScratch(node, signal)
            if (!outcome.ok) return fail(outcome.error ?? "generate check failed")
            await cachePut(node, { kind: "generate-check" })
            return green("ran")
          }
          const outcome = await runWriteEnforced(node, signal)
          if (!outcome.ok) return fail(outcome.error ?? "generate failed")
          return green("ran")
        }
        default:
          return fail(refusalFor(node.rule))
      }
    } catch (cause) {
      return fail(Diagnostic.message(cause, "target failed"))
    }
  }

  /** Settles one node: gate and dependency checks, refusal, then dispatch. */
  const settle = async (node: PackageNode): Promise<Outcome> => {
    // A red gate is a refusal with the gate report attached; a red data or
    // plain dependency skips the consumer. A suite aggregates its members
    // instead of skipping.
    if (node.rule !== "Suite") {
      const redGate = node.gateDeps.find((gate) => notGreen.has(gate))
      if (redGate !== undefined) {
        const gateReport = node.gateDeps
          .map((gate) => `${gate}=${reports.get(gate)?.status ?? "unscheduled"}`)
          .join(", ")
        return fail(`refused: gate ${redGate} is not green (gates: ${gateReport})`)
      }
      const blocked = node.dependencies.find((dependency) => notGreen.has(dependency))
      if (blocked !== undefined) return { status: "skipped", error: `dependency ${blocked} did not succeed` }
    }
    if (node.refusal !== undefined) return fail(node.refusal)
    if (node.serviceDeps.length > 0) return underServices(node, (signal) => dispatch(node, signal))
    return dispatch(node, options.signal)
  }

  const runOne = async (label: string): Promise<void> => {
    const node = byLabel.get(label)!
    const started = performance.now()
    const outcome = await settle(node)
    if (outcome.status === "failed" || outcome.status === "skipped") notGreen.add(label)
    report({
      label,
      target: node.rule,
      status: outcome.status,
      durationMs: outcome.status === "skipped" ? 0 : performance.now() - started,
      key: keyFor(node),
      ...(outcome.error === undefined ? {} : { error: outcome.error })
    })
  }

  // The scheduler runs inside one scope that owns the service supervisor:
  // every service a consumer acquired is released through its stop contract
  // by the time the scope closes, whether the run settled or was interrupted.
  const exit = await Effect.runPromiseExit(
    Effect.scoped(Effect.gen(function*() {
      supervisorRef.current = yield* ServiceSupervisor.make
      yield* Effect.tryPromise({
        try: () => Executor.schedule(planned.workList, jobs, runOne, options.signal),
        catch: (cause) => cause
      })
    }))
  )
  supervisorRef.current = undefined
  await store.close().catch(() => undefined)
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)

  const results = planned.workList
    .map((node) => reports.get(node.label))
    .filter((entry): entry is Executor.TargetReport => entry !== undefined)
  const counts = {
    hit: results.filter((entry) => entry.status === "hit").length,
    ran: results.filter((entry) => entry.status === "ran").length,
    failed: results.filter((entry) => entry.status === "failed").length,
    skipped: results.filter((entry) => entry.status === "skipped").length
  }
  const durationMs = performance.now() - startedAt
  log(
    `${results.length} targets: ${counts.hit} hit, ${counts.ran} ran, ` +
      `${counts.failed} failed, ${counts.skipped} skipped (${formatDuration(durationMs)})`
  )
  return {
    verb: options.verb,
    pattern: options.pattern,
    jobs,
    durationMs,
    counts,
    ok: counts.failed === 0,
    results
  }
}

/**
 * Plans and, unless `--plan` asked for the inert report, executes one
 * package-mode invocation.
 *
 * @category execution
 * @since 0.1.0
 */
export const run = async (options: RunOptions): Promise<Executor.Summary | PlanReport> => {
  const planned = await plan(options)
  if (options.plan === true) {
    return {
      verb: options.verb,
      pattern: options.pattern,
      roots: planned.roots,
      targets: planned.workList.map((node) => ({
        label: node.label,
        rule: node.rule,
        mode: node.mode,
        key: node.keyPreview,
        cacheable: node.cacheable,
        dependencies: node.dependencies,
        ...(node.argv === undefined ? {} : { argv: node.argv }),
        ...(node.refusal === undefined ? {} : { refusal: node.refusal })
      }))
    }
  }
  return execute(planned, options)
}
