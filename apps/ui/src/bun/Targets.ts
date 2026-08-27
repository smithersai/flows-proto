/*
 * Targets through the Node sidecar (LOCAL-APP.md, "Targets: load and run").
 * The loader is the existing build-cli, run under the loader sandbox policy;
 * its JSON listing maps 1:1 onto `Target`. A run streams the CLI's stdout,
 * stderr and exit as frames on the `target-run:<runId>` WebSocket topic.
 */
import { existsSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { resolve } from "node:path"
import type { Target, TargetRunFrame } from "smithers-shared/LocalApp"
import { splitLabel } from "smithers-shared/LocalApp"
import type { NodeSidecar } from "./Node"
import { currentSandboxHost, loaderPolicy, wrapSandbox } from "./Sandbox"
import type { SandboxHost, SandboxPaths } from "./Sandbox"

/** How long the loader may take before the query answers with a warning. */
export const QUERY_TIMEOUT_MS = 120_000

/**
 * The build-cli entry: SMITHERS_BUILD_CLI, else packages/build-cli/src/main.js
 * resolved from apps/ui (this file lives in apps/ui/src/bun).
 */
export const resolveBuildCli = (
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  fromDir: string = import.meta.dir
): string => {
  const explicit = env.SMITHERS_BUILD_CLI?.trim()
  if (explicit !== undefined && explicit !== "") return resolve(explicit)
  return resolve(fromDir, "..", "..", "..", "..", "packages", "build-cli", "src", "main.js")
}

/**
 * The paths the loader policy is built from. The temp dir is canonicalised:
 * seatbelt matches subpaths against real paths, and macOS hands out
 * /var/folders/... for /private/var/folders/..., which the profile would
 * otherwise deny.
 */
export const sandboxPathsFor = (repo: string): SandboxPaths => {
  let tmp = tmpdir()
  try {
    tmp = realpathSync(tmp)
  } catch {
    // The unresolved path is still the right one to allow.
  }
  return { repo, home: homedir(), tmpdir: tmp }
}

const isTargetRow = (value: unknown): value is { label: string; target?: unknown; kinds?: unknown } =>
  typeof value === "object" && value !== null && typeof (value as { label?: unknown }).label === "string"

/**
 * The loader's `{ targets: [{ label, target, kinds }] }` listing as Targets,
 * or an error message when the text is not that shape.
 */
export const mapTargets = (stdout: string): { readonly targets: Array<Target> } | { readonly error: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { error: `The loader did not answer JSON: ${stdout.trim().slice(0, 200)}` }
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "The loader answered a non-object." }
  const body = parsed as { targets?: unknown; message?: unknown; code?: unknown }
  if (!Array.isArray(body.targets)) {
    const message = typeof body.message === "string" ? body.message : "no targets[] in the loader's answer"
    return { error: typeof body.code === "string" ? `${body.code}: ${message}` : message }
  }
  return {
    targets: body.targets.filter(isTargetRow).map((row) => ({
      label: row.label,
      target: typeof row.target === "string" ? row.target : "",
      kinds: Array.isArray(row.kinds) ? row.kinds.filter((kind): kind is string => typeof kind === "string") : [],
      ...splitLabel(row.label)
    }))
  }
}

export interface TargetsQueryResult {
  readonly targets: Array<Target>
  readonly warnings: Array<string>
  readonly durationMs: number
}

export interface TargetsQueryOptions {
  readonly repo: string
  readonly node: NodeSidecar | null
  readonly cli?: string
  readonly sandboxHost?: SandboxHost
  readonly timeoutMs?: number
}

/**
 * `node <cli> query '//...' --format json` in the repository under the loader
 * policy. Loader errors become warnings and an empty list, never a throw.
 */
export const queryTargets = async (options: TargetsQueryOptions): Promise<TargetsQueryResult> => {
  const started = Date.now()
  const cli = options.cli ?? resolveBuildCli()
  const warnings: Array<string> = []
  if (options.node === null) {
    warnings.push("No Node.js >= 22.19 was found for the smthrs loader (SMITHERS_NODE, PATH, nvm, homebrew).")
    return { targets: [], warnings, durationMs: Date.now() - started }
  }
  if (!existsSync(cli)) {
    warnings.push(`The smthrs loader is missing at ${cli} (set SMITHERS_BUILD_CLI).`)
    return { targets: [], warnings, durationMs: Date.now() - started }
  }
  const wrapped = wrapSandbox(
    [options.node.path, cli, "query", "//...", "--format", "json"],
    loaderPolicy(sandboxPathsFor(options.repo)),
    options.sandboxHost ?? currentSandboxHost()
  )
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([...wrapped.argv], { cwd: options.repo, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  } catch (error) {
    warnings.push(`The loader could not start: ${error instanceof Error ? error.message : String(error)}`)
    return { targets: [], warnings, durationMs: Date.now() - started }
  }
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? QUERY_TIMEOUT_MS)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text()
  ])
  clearTimeout(timer)
  const mapped = mapTargets(stdout)
  if ("error" in mapped) {
    warnings.push(code === 0 ? mapped.error : `The loader exited ${code}: ${mapped.error}`)
    const trimmed = stderr.trim()
    if (trimmed !== "") warnings.push(trimmed.slice(0, 2000))
    return { targets: [], warnings, durationMs: Date.now() - started }
  }
  if (code !== 0) warnings.push(`The loader exited ${code}.`)
  return { targets: mapped.targets, warnings, durationMs: Date.now() - started }
}

export type TargetRunStatus = "pending" | "running" | "done" | "failed"

export interface TargetRun {
  readonly runId: string
  readonly repoId: string
  readonly repo: string
  readonly label: string
  status: TargetRunStatus
  exitCode: number | null
}

export interface TargetRunnerOptions {
  readonly publish: (topic: string, message: unknown) => void
  readonly cli?: string
  /** A run nobody attached to starts on its own after this long. */
  readonly autoStartMs?: number
  readonly log?: (line: string) => void
}

export interface TargetRunner {
  /** Registers a run; the child starts on `attach`, or after `autoStartMs`. */
  readonly start: (run: { readonly repoId: string; readonly repo: string; readonly label: string; readonly node: NodeSidecar }) => TargetRun
  /** A subscriber is listening: spawn now if not yet started. */
  readonly attach: (runId: string) => boolean
  readonly cancel: (runId: string) => boolean
  readonly get: (runId: string) => TargetRun | undefined
  readonly stop: () => void
}

export const runTopic = (runId: string): string => `target-run:${runId}`

/** `node <cli> '<label>'` per run, streamed to the run's topic. */
export const createTargetRunner = (options: TargetRunnerOptions): TargetRunner => {
  const cli = options.cli ?? resolveBuildCli()
  const log = options.log ?? (() => {})
  interface Live {
    readonly run: TargetRun
    readonly node: NodeSidecar
    child: ReturnType<typeof Bun.spawn> | undefined
    timer: ReturnType<typeof setTimeout> | undefined
  }
  const runs = new Map<string, Live>()

  const emit = (run: TargetRun, frame: TargetRunFrame): void => {
    options.publish(runTopic(run.runId), { type: "target-run", runId: run.runId, frame })
  }

  const pump = async (stream: ReadableStream<Uint8Array>, run: TargetRun, type: "stdout" | "stderr"): Promise<void> => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const data = decoder.decode(value, { stream: true })
      if (data !== "") emit(run, { type, data })
    }
    const rest = decoder.decode()
    if (rest !== "") emit(run, { type, data: rest })
  }

  const spawn = (live: Live): void => {
    if (live.run.status !== "pending") return
    if (live.timer !== undefined) clearTimeout(live.timer)
    live.timer = undefined
    live.run.status = "running"
    if (!existsSync(cli)) {
      live.run.status = "failed"
      emit(live.run, { type: "error", message: `The smthrs loader is missing at ${cli} (set SMITHERS_BUILD_CLI).` })
      emit(live.run, { type: "exit", code: null })
      return
    }
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn([live.node.path, cli, live.run.label], {
        cwd: live.run.repo,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore"
      })
    } catch (error) {
      live.run.status = "failed"
      emit(live.run, { type: "error", message: error instanceof Error ? error.message : String(error) })
      emit(live.run, { type: "exit", code: null })
      return
    }
    live.child = child
    log(`target-run ${live.run.runId}: ${live.run.label} in ${live.run.repo} (pid ${child.pid})`)
    void Promise.all([
      pump(child.stdout as ReadableStream<Uint8Array>, live.run, "stdout"),
      pump(child.stderr as ReadableStream<Uint8Array>, live.run, "stderr")
    ])
      .catch(() => {})
      .then(() => child.exited)
      .then((code) => {
        live.run.exitCode = code
        live.run.status = code === 0 ? "done" : "failed"
        emit(live.run, { type: "exit", code })
      })
  }

  return {
    start: ({ repoId, repo, label, node }) => {
      const run: TargetRun = { runId: crypto.randomUUID(), repoId, repo, label, status: "pending", exitCode: null }
      const live: Live = { run, node, child: undefined, timer: undefined }
      runs.set(run.runId, live)
      live.timer = setTimeout(() => spawn(live), options.autoStartMs ?? 1000)
      return run
    },
    attach: (runId) => {
      const live = runs.get(runId)
      if (live === undefined) return false
      spawn(live)
      return true
    },
    cancel: (runId) => {
      const live = runs.get(runId)
      if (live === undefined) return false
      if (live.run.status === "pending") {
        if (live.timer !== undefined) clearTimeout(live.timer)
        live.run.status = "failed"
        emit(live.run, { type: "error", message: "Cancelled before it started." })
        emit(live.run, { type: "exit", code: null })
        return true
      }
      if (live.run.status === "running") {
        live.child?.kill()
        return true
      }
      return false
    },
    get: (runId) => runs.get(runId)?.run,
    stop: () => {
      for (const live of runs.values()) {
        if (live.timer !== undefined) clearTimeout(live.timer)
        if (live.run.status === "running") live.child?.kill()
      }
    }
  }
}
