/**
 * Incur command surface for smithers build.
 *
 * @since 0.1.0
 */
import * as Config from "@smthrs/targets/Config"
import * as Target from "@smthrs/targets/Target"
import { Cli, z } from "incur"
import * as NodePath from "node:path"
import * as Diagnostic from "./Diagnostic.ts"
import { runInstall } from "./engine.ts"
import * as Executor from "./Executor.ts"
import * as GitHooks from "./GitHooks.ts"
import * as GraphOutput from "./GraphOutput.ts"
import * as PackageDiscovery from "./PackageDiscovery.ts"
import * as PackageExec from "./PackageExec.ts"
import * as PackageIndex from "./PackageIndex.ts"
import * as PackageLoader from "./PackageLoader.ts"
import * as Planner from "./Planner.ts"
import * as Query from "./Query.ts"
import * as RepoResolution from "./RepoResolution.ts"
import {
  ensureGitignored,
  resolveConfig,
  type ResolvedRemoteCache,
  resolveRemoteCache,
  Workspace
} from "./Workspace.ts"

const workspaceOption = z.object({
  workspace: z.string().default(process.cwd()).describe("Workspace root containing BUILD.ts files"),
  cacheDir: z.string().optional().describe(
    "Workspace-relative cache directory; overrides the root BUILD.ts declaration and .flows"
  )
})

const executionOptions = workspaceOption.extend({
  plan: z.boolean().default(false).describe("Print the inert plan instead of executing"),
  jobs: z.number().int().min(1).optional().describe("Maximum concurrent targets; defaults to host parallelism"),
  cache: z.boolean().default(true).describe("Consult the result cache before running; --no-cache bypasses reads")
})

/** The flags outward and agent targets take: the commit message override and payload inputs. */
const invocationOptions = {
  message: z.string().optional().describe("Commit message for a Git.Commit target; wins over the declared message"),
  input: z.array(z.string()).optional().describe("Payload input for agent targets as name=value; repeatable")
}

const runOptions = executionOptions.extend({
  name: z.string().optional().describe("Package name supplied to scaffold targets"),
  ...invocationOptions
})

const executionAlias = { workspace: "w", jobs: "j" }

const invocationAlias = { message: "m", input: "i" }

const patternArgument = z.object({
  pattern: z.string().describe("Bazel label or recursive pattern")
})

/** The flags every command shares. */
interface WorkspaceFlags {
  readonly workspace: string
  readonly cacheDir?: string | undefined
}

/** The flags shared by commands that execute targets. */
interface ExecutionFlags extends WorkspaceFlags {
  readonly plan: boolean
  readonly jobs?: number | undefined
  readonly cache: boolean
}

/**
 * Process-scoped configuration captured before BUILD.ts evaluation.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RuntimeConfig {
  readonly cacheUrl?: string | undefined
  readonly cacheToken?: string | undefined
  readonly signal?: AbortSignal | undefined
  /**
   * The environment package-mode execution reads for agent-fake selection
   * (`SMTHRS_AGENT_FAKE`), backend PATH lookups, and outward preconditions.
   * Defaults to `process.env`; tests inject a hermetic record.
   */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
}

interface PreparedWorkspace {
  readonly root: string
  readonly cacheDirectory: string
  readonly remoteCache?: (ResolvedRemoteCache & { readonly token?: string | undefined }) | undefined
}

/**
 * Settles the cache directory one command runs under. Executing commands apply
 * the declared gitignore policy before writing state; query, graph, and plan
 * commands pass `writeState = false` and remain observational.
 *
 * Reading the declared token from the environment is a read, never a write.
 * Removing the name from `process.env` here would mutate state the caller
 * owns: `makeCli` is a library entry point, and two concurrent commands with
 * different declared token names would delete each other's credentials. The
 * child-process boundary is where the credential is withheld, and `ExecLive`
 * already strips both `SMITHERS_CACHE_URL` and every name in `sensitiveEnv`
 * from a spawned tool's environment. The process entry point in `main.ts`
 * captures and clears the default names for its own short-lived process,
 * which is a choice only a process owner may make.
 */
const prepare = async (
  flags: WorkspaceFlags,
  runtime: RuntimeConfig = {},
  writeState = true
): Promise<PreparedWorkspace> => {
  runtime.signal?.throwIfAborted()
  const root = NodePath.resolve(flags.workspace)
  const config = await resolveConfig(root, flags.cacheDir)
  runtime.signal?.throwIfAborted()
  const remoteCache = await resolveRemoteCache(root, runtime.cacheUrl)
  let preparedRemote: PreparedWorkspace["remoteCache"]
  if (remoteCache !== undefined) {
    const token = remoteCache.tokenEnv === "SMITHERS_CACHE_TOKEN"
      ? runtime.cacheToken ?? process.env[remoteCache.tokenEnv]
      : process.env[remoteCache.tokenEnv]
    preparedRemote = { ...remoteCache, token }
  }
  if (writeState && config.gitignored) await ensureGitignored(root, config.cacheDirectory)
  runtime.signal?.throwIfAborted()
  return preparedRemote === undefined
    ? { root, cacheDirectory: config.cacheDirectory }
    : { root, cacheDirectory: config.cacheDirectory, remoteCache: preparedRemote }
}

/** Opens the workspace index under the resolved cache directory. */
const openWorkspace = async (
  flags: WorkspaceFlags,
  runtime: RuntimeConfig = {},
  writeState = true
): Promise<{ readonly workspace: Workspace; readonly remoteCache: PreparedWorkspace["remoteCache"] }> => {
  const prepared = await prepare(flags, runtime, writeState)
  return {
    workspace: await Workspace.make(prepared.root, process.cwd(), {
      cacheDirectory: prepared.cacheDirectory,
      signal: runtime.signal
    }),
    remoteCache: prepared.remoteCache
  }
}

/**
 * Opens the PACKAGE.ts index when the resolved workspace is in package mode:
 * the nearest ancestor of the workspace flag holding `.smithers/WORKSPACE.ts`
 * or a root `WORKSPACE.ts` decides. A BUILD.ts workspace has neither and
 * returns undefined, so BUILD mode is untouched.
 */
const openPackageIndex = async (
  flags: WorkspaceFlags,
  runtime: RuntimeConfig = {}
): Promise<PackageIndex.PackageIndex | undefined> => {
  runtime.signal?.throwIfAborted()
  const root = await PackageDiscovery.findWorkspaceRoot(NodePath.resolve(flags.workspace))
  if (root === undefined) return undefined
  // Evaluate the one root declaration before walking: both its cache and its
  // opaque child repositories are discovery boundaries. The full graph load
  // imports the same module instance together with the admitted Packages.
  const workspaceFile = await PackageDiscovery.workspaceFileOf(root)
  if (workspaceFile === undefined) return undefined
  const workspace = await PackageLoader.loadWorkspaceDeclaration(root, workspaceFile)
  const cacheDirectory = flags.cacheDir === undefined
    ? workspace.cache.directory
    : Config.normalizeCacheDirectory(flags.cacheDir)
  const discovery = await PackageDiscovery.discover(root, {
    cacheDirectory,
    repositories: workspace.repos,
    signal: runtime.signal
  })
  const loaded = await PackageLoader.load(discovery)
  return PackageIndex.PackageIndex.make(loaded, process.cwd())
}

/** Package-mode `query`: the same listing shape BUILD mode prints. */
const packageQuery = async (index: PackageIndex.PackageIndex, expression: string): Promise<unknown> => {
  const dependencyMatch = expression.match(/^deps\((.+)\)$/)
  if (dependencyMatch?.[1] !== undefined) {
    const rows = index.resolve(dependencyMatch[1].trim())
    if (rows.length !== 1) throw new Error("deps() requires one exact or default target")
    const root = rows[0]!
    const closure = new Set<string>()
    const stack = [root.target]
    const seen = new Set<Target.AnyTarget>()
    while (stack.length > 0) {
      const current = stack.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      const label = index.labelOf(current)
      if (label !== undefined && label !== root.label) closure.add(label)
      for (const dependency of Target.metadata(current).dependencies) stack.push(dependency)
    }
    return {
      query: expression,
      root: root.label,
      dependencies: [...closure].sort(),
      edges: index.edges(rows)
    }
  }
  const cache: RepoResolution.ResolutionCache = new Map()
  const rows = index.resolve(expression)
  return {
    query: expression,
    targets: await Promise.all(rows.map(async (row) => {
      const metadata = Target.metadata(row.target)
      const resolution = metadata.target === "Repo.Target"
        ? await RepoResolution.resolve(index, row.target, cache)
        : undefined
      return {
        label: row.label,
        target: metadata.target,
        kinds: await RepoResolution.effectiveKinds(index, row.target, cache),
        ...(resolution?.refusal === undefined ? {} : { refusal: resolution.refusal })
      }
    }))
  }
}

/** Package-mode `graph`: labeled nodes plus classified edges. */
const packageGraph = async (index: PackageIndex.PackageIndex, pattern: string): Promise<unknown> => {
  const rows = index.resolve(pattern)
  const localEdges = index.edges(rows)
  const cache: RepoResolution.ResolutionCache = new Map()
  const resolutions = await Promise.all(rows.map(async (row) =>
    Target.metadata(row.target).target === "Repo.Target"
      ? { row, resolution: await RepoResolution.resolve(index, row.target, cache) }
      : undefined
  ))
  const repositoryEdges = resolutions
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .map(({ resolution, row }) => ({ from: row.label, to: resolution.externalLabel, kind: "repo" as const }))
  const edges = [...localEdges, ...repositoryEdges]
  const lines = rows.map((row) => {
    const own = edges.filter((edge) => edge.from === row.label)
    const resolution = resolutions.find((entry) => entry?.row === row)?.resolution
    return own.length === 0
      ? `${row.label}${resolution?.refusal === undefined ? "" : `\n  refusal: ${resolution.refusal}`}`
      : `${row.label}\n${own.map((edge) => `  -${edge.kind}-> ${edge.to}`).join("\n")}${
        resolution?.refusal === undefined ? "" : `\n  refusal: ${resolution.refusal}`
      }`
  })
  return {
    pattern,
    format: "text",
    graph: lines.join("\n"),
    roots: rows.map((row) => row.label),
    targets: await Promise.all(rows.map(async (row) => {
      const resolution = resolutions.find((entry) => entry?.row === row)?.resolution
      return {
        label: row.label,
        target: Target.metadata(row.target).target,
        kinds: await RepoResolution.effectiveKinds(index, row.target, cache),
        ...(resolution?.refusal === undefined ? {} : { refusal: resolution.refusal })
      }
    })),
    edges,
    warnings: []
  }
}

/** The plan printed by `ci --plan`: all CI verb plans merged over one pattern. */
interface CiPlan extends Executor.MergedPlan {
  readonly verb: "ci"
  readonly pattern: string
}

/**
 * Refuses execution verbs in package mode that stay out of the W2 feature
 * set (`ci`, `docs`, `install`). Failing here is the no-fake-green rule at
 * the CLI boundary.
 */
const refusePackageMode = async (flags: WorkspaceFlags, verb: string): Promise<void> => {
  const root = await PackageDiscovery.findWorkspaceRoot(NodePath.resolve(flags.workspace))
  if (root !== undefined) {
    throw new Error(
      `NotImplemented: ${verb} does not execute PACKAGE.ts targets yet; ` +
        "query, graph, build, test, lint, run, and the bare-label form are the package-mode surface"
    )
  }
}

/** The mode and invocation flags the package-mode execution surface accepts. */
interface ModeFlags {
  readonly write?: boolean | undefined
  readonly fix?: boolean | undefined
  readonly message?: string | undefined
  readonly input?: ReadonlyArray<string> | undefined
}

/** Parses repeated `--input name=value` flags into the agent payload record. */
const parseInputs = (entries: ReadonlyArray<string> | undefined): Readonly<Record<string, string>> | undefined => {
  if (entries === undefined || entries.length === 0) return undefined
  const values: Record<string, string> = {}
  for (const entry of entries) {
    const separator = entry.indexOf("=")
    if (separator <= 0) throw new Error(`--input expects name=value, received ${JSON.stringify(entry)}`)
    const name = entry.slice(0, separator)
    if (name in values) throw new Error(`--input names ${JSON.stringify(name)} twice`)
    values[name] = entry.slice(separator + 1)
  }
  return values
}

/**
 * Runs one execution verb through the package-mode executor when the
 * resolved workspace is a PACKAGE.ts workspace, or returns undefined so the
 * caller falls through to BUILD mode.
 */
const runPackageVerb = async (
  verb: PackageExec.PackageVerb,
  pattern: string,
  flags: ExecutionFlags & ModeFlags,
  config: RuntimeConfig
): Promise<Executor.Summary | PackageExec.PlanReport | undefined> => {
  const index = await openPackageIndex(flags, config)
  if (index === undefined) return undefined
  const cacheDirectory = flags.cacheDir === undefined
    ? index.workspace.cache.directory
    : Config.normalizeCacheDirectory(flags.cacheDir)
  return PackageExec.run({
    index,
    cacheDirectory,
    verb,
    pattern,
    write: flags.write,
    fix: flags.fix,
    plan: flags.plan,
    jobs: flags.jobs,
    readCache: flags.cache,
    signal: config.signal,
    message: flags.message,
    inputs: parseInputs(flags.input),
    environment: config.environment
  })
}

/**
 * The `gitHooks` command: renders the WORKSPACE.ts hook bindings to
 * `.git/hooks` scripts, byte-checks them by default, installs them under
 * `--write`. Drift is a red exit, like every other generated file.
 */
const runGitHooks = async (
  flags: WorkspaceFlags & { readonly write: boolean },
  config: RuntimeConfig
): Promise<
  | { readonly mode: "check"; readonly clean: boolean; readonly entries: ReadonlyArray<GitHooks.CheckEntry> }
  | { readonly mode: "install"; readonly installed: ReadonlyArray<string> }
> => {
  const index = await openPackageIndex(flags, config)
  if (index === undefined) {
    throw new Error("gitHooks renders PACKAGE.ts workspace bindings; this workspace has no WORKSPACE.ts")
  }
  const bindings = GitHooks.resolveHookLabels(index.workspace, index)
  const rendered = GitHooks.render(bindings)
  if (flags.write) {
    const { wrote } = await GitHooks.install(index.root, rendered)
    return { mode: "install", installed: wrote }
  }
  const report = await GitHooks.check(index.root, rendered)
  return { mode: "check", clean: report.clean, entries: report.entries }
}

/** Plans one verb and executes it unless `--plan` asked for the inert print. */
const runVerb = async (
  verb: "build" | "test" | "lint" | "run" | "docs",
  pattern: string,
  flags: ExecutionFlags & ModeFlags,
  config: RuntimeConfig
): Promise<Planner.Plan | Executor.Summary | PackageExec.PlanReport> => {
  if (verb === "docs") {
    await refusePackageMode(flags, verb)
  } else {
    const packaged = await runPackageVerb(verb, pattern, flags, config)
    if (packaged !== undefined) return packaged
  }
  const { remoteCache, workspace } = await openWorkspace(flags, config, !flags.plan)
  const plan = await Planner.make(workspace, verb, pattern)
  if (flags.plan) return plan
  return Executor.execute({
    workspace,
    verb,
    pattern,
    targets: plan.targets,
    jobs: flags.jobs,
    readCache: flags.cache,
    remoteCache,
    signal: config.signal,
    packageName: "name" in flags && typeof flags.name === "string" ? flags.name : undefined
  })
}

/**
 * The verbs `ci` merges, LINT FIRST.
 *
 * `mergePlans` deduplicates on label and first occurrence wins, so the plan a
 * target contributes to `ci` is the one from the first verb that selected it.
 * A generator target participates in both `build` and `lint`, and its `lint`
 * form is the non-mutating one (`attrsForKind` maps write to check). Planning
 * `build` first therefore made `smthrs ci` rewrite checked-in package
 * manifests and workflow files as a side effect of asking whether the
 * repository was green. Lint first makes the merged graph the checking form,
 * which is the only correct posture for a CI verb.
 */
const ciKinds = ["lint", "build", "test", "docs"] as const

/** Plans every CI-safe verb over one pattern and executes the merged graph. */
const runCi = async (
  pattern: string,
  flags: ExecutionFlags,
  config: RuntimeConfig
): Promise<CiPlan | Executor.Summary> => {
  await refusePackageMode(flags, "ci")
  const { remoteCache, workspace } = await openWorkspace(flags, config, !flags.plan)
  const plans: Array<Planner.Plan> = []
  const refusals: Array<unknown> = []
  for (const kind of ciKinds) {
    try {
      plans.push(await Planner.make(workspace, kind, pattern))
    } catch (cause) {
      // An exact label that does not participate in one of the CI kinds is
      // fine as long as it participates in another; any other planning error
      // is real and propagates.
      if (cause instanceof Planner.UnsupportedVerbError && cause.verb === kind) refusals.push(cause)
      else throw cause
    }
  }
  if (plans.length === 0) throw refusals[0] ?? new Error(`no targets selected by ${pattern}`)
  const merged = Executor.mergePlans(plans)
  if (flags.plan) return { verb: "ci", pattern, ...merged }
  return Executor.execute({
    workspace,
    verb: "ci",
    pattern,
    targets: merged.targets,
    jobs: flags.jobs,
    readCache: flags.cache,
    remoteCache,
    signal: config.signal
  })
}

/** Whether an outcome is an execution summary rather than an inert plan. */
const failedSummary = (
  outcome: Planner.Plan | CiPlan | Executor.Summary | PackageExec.PlanReport
): outcome is Executor.Summary => "ok" in outcome && !outcome.ok

const failureMessage = (summary: Executor.Summary): string =>
  `${summary.counts.failed} of ${summary.results.length} targets failed` +
  (summary.counts.skipped === 0 ? "" : ` (${summary.counts.skipped} skipped)`)

/**
 * Creates the configured smthrs CLI.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeCli = (config: RuntimeConfig = {}) =>
  Cli.create("smthrs", {
    description: "Execute BUILD.ts targets and install pnpm workspaces with flows",
    version: "0.1.0"
  })
    .command("install", {
      description: "Plan and execute the pnpm install Flow",
      options: workspaceOption,
      alias: { workspace: "w" },
      async run(context) {
        try {
          await refusePackageMode(context.options, "install")
          const prepared = await prepare(context.options, config)
          return await runInstall(prepared.root, {
            cacheDirectory: prepared.cacheDirectory,
            sensitiveEnvironment: prepared.remoteCache === undefined
              ? []
              : [prepared.remoteCache.tokenEnv],
            signal: config.signal
          })
        } catch (cause) {
          return context.error({
            code: "install_failed",
            exitCode: 1,
            message: Diagnostic.message(cause),
            retryable: false
          })
        }
      }
    })
    .command("build", {
      description: "Execute the build targets selected by a pattern",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      async run(context) {
        let outcome: Planner.Plan | Executor.Summary | PackageExec.PlanReport
        try {
          outcome = await runVerb("build", context.args.pattern, context.options, config)
        } catch (cause) {
          return context.error({ code: "build_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("test", {
      description: "Execute the test targets selected by a pattern",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      async run(context) {
        let outcome: Planner.Plan | Executor.Summary | PackageExec.PlanReport
        try {
          outcome = await runVerb("test", context.args.pattern, context.options, config)
        } catch (cause) {
          return context.error({ code: "test_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("lint", {
      description: "Execute the lint targets selected by a pattern",
      args: patternArgument,
      options: executionOptions.extend({
        fix: z.boolean().default(false).describe("Apply agent lint fixes inside the declared fixes write-set")
      }),
      alias: executionAlias,
      async run(context) {
        let outcome: Planner.Plan | Executor.Summary | PackageExec.PlanReport
        try {
          outcome = await runVerb("lint", context.args.pattern, context.options, config)
        } catch (cause) {
          return context.error({ code: "lint_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("docs", {
      description: "Execute the documentation-parity targets selected by a pattern",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      async run(context) {
        let outcome: Planner.Plan | Executor.Summary | PackageExec.PlanReport
        try {
          outcome = await runVerb("docs", context.args.pattern, context.options, config)
        } catch (cause) {
          return context.error({ code: "docs_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("run", {
      description: "Execute run targets selected by a pattern",
      args: patternArgument,
      options: runOptions,
      alias: { ...executionAlias, ...invocationAlias, name: "n" },
      async run(context) {
        let outcome: Planner.Plan | Executor.Summary | PackageExec.PlanReport
        try {
          outcome = await runVerb("run", context.args.pattern, context.options, config)
        } catch (cause) {
          return context.error({ code: "run_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("target", {
      description: "Execute one package-mode label with its flavor-implied verb (the bare-label form)",
      args: patternArgument,
      options: executionOptions.extend({
        write: z.boolean().default(false).describe("Apply Diff/Generate/CiGen targets instead of checking drift"),
        fix: z.boolean().default(false).describe("Apply agent lint fixes inside the declared fixes write-set"),
        ...invocationOptions
      }),
      alias: { ...executionAlias, ...invocationAlias },
      async run(context) {
        let outcome: Executor.Summary | PackageExec.PlanReport | undefined
        try {
          outcome = await runPackageVerb("auto", context.args.pattern, context.options, config)
          if (outcome === undefined) {
            throw new Error("the bare-label form executes PACKAGE.ts targets; this workspace has no WORKSPACE.ts")
          }
        } catch (cause) {
          return context.error({ code: "target_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("gitHooks", {
      description: "Check the WORKSPACE.ts gitHooks scripts against .git/hooks, or install them with --write",
      options: workspaceOption.extend({
        write: z.boolean().default(false).describe("Install the rendered hook scripts into .git/hooks")
      }),
      alias: { workspace: "w" },
      async run(context) {
        let outcome: Awaited<ReturnType<typeof runGitHooks>>
        try {
          outcome = await runGitHooks(context.options, config)
        } catch (cause) {
          return context.error({ code: "git_hooks_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (outcome.mode === "check" && !outcome.clean) {
          return context.error({
            code: "git_hooks_drift",
            exitCode: 1,
            message: `git hooks drift (run with --write to install): ${
              outcome.entries.filter((entry) => entry.status !== "clean").map((entry) =>
                `${entry.file}=${entry.status}`
              )
                .join(", ")
            }`,
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("ci", {
      description: "Execute build, test, lint, and documentation targets over one merged graph",
      args: patternArgument,
      options: executionOptions,
      alias: executionAlias,
      async run(context) {
        let outcome: CiPlan | Executor.Summary
        try {
          outcome = await runCi(context.args.pattern, context.options, config)
        } catch (cause) {
          return context.error({ code: "ci_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
        if (failedSummary(outcome)) {
          return context.error({
            code: "targets_failed",
            exitCode: 1,
            message: failureMessage(outcome),
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("query", {
      description: "List labels or evaluate deps(label)",
      args: z.object({ expr: z.string().describe("Label, pattern, or deps(label)") }),
      options: workspaceOption,
      alias: { workspace: "w" },
      async run(context) {
        try {
          const index = await openPackageIndex(context.options, config)
          if (index !== undefined) return await packageQuery(index, context.args.expr)
          const { workspace } = await openWorkspace(context.options, config, false)
          return await Query.run(workspace, context.args.expr)
        } catch (cause) {
          return context.error({ code: "query_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
      }
    })
    .command("graph", {
      description: "Print the target graph without executing it",
      args: patternArgument,
      options: workspaceOption.extend({
        mermaid: z.boolean().default(false).describe("Render Mermaid instead of a text tree")
      }),
      alias: { workspace: "w", mermaid: "m" },
      async run(context) {
        try {
          const index = await openPackageIndex(context.options, config)
          if (index !== undefined) return await packageGraph(index, context.args.pattern)
          const { workspace } = await openWorkspace(context.options, config, false)
          const plan = await Planner.make(workspace, "graph", context.args.pattern)
          return {
            pattern: context.args.pattern,
            format: context.options.mermaid ? "mermaid" : "text",
            graph: context.options.mermaid ? GraphOutput.mermaid(plan) : GraphOutput.text(plan),
            roots: plan.roots,
            targets: plan.targets.map((target) => ({ label: target.label, target: target.target })),
            edges: plan.edges,
            warnings: plan.warnings
          }
        } catch (cause) {
          return context.error({ code: "graph_failed", exitCode: 1, message: Diagnostic.message(cause) })
        }
      }
    })

/**
 * Rewrites a bare-label argv into the `target` command.
 *
 * `smthrs '//src:lint'` — a first argument that is a label rather than a
 * command — executes the label under its flavor-implied verb. Every other
 * argv passes through unchanged.
 *
 * @category parsing
 * @since 0.1.0
 * @slop
 */
export const normalizeArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const first = argv[0]
  if (first !== undefined && (first.startsWith("//") || first.startsWith(":"))) {
    return ["target", ...argv]
  }
  return argv
}

/**
 * Programmatic CLI without process-scoped remote cache or interruption state.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const cli = makeCli()
