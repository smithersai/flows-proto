/**
 * Executes `Memory.Retain` against the Smithers Cloud memory backend.
 *
 * The backend is the `smithers` CLI. It is resolved, never assumed: when the
 * workspace declares no `S.Memory.SmithersCloud` backend, or the CLI is not
 * on PATH, the invocation fails with the typed
 * {@link MemoryBackendUnavailable} notice. That notice is deliberately not
 * green and not a crash: the caller reports it as the target's outcome, so a
 * host without the backend says so instead of pretending the memory was
 * retained.
 *
 * The CLI invocation goes through the {@link MemoryCli} service so the
 * integration can respell the documented `smithers memory` surface in one
 * place; the default implementation shells out to the resolved binary.
 *
 * @since 0.1.0
 */
import * as MemoryTarget from "@smthrs/targets/MemoryTarget"
import type * as Target from "@smthrs/targets/Target"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"

/**
 * The memory backend is not available on this host or in this workspace.
 *
 * `no_backend_declared`: the WORKSPACE.ts declares no
 * `S.Memory.SmithersCloud`. `cli_not_found`: the `smithers` binary is not on
 * PATH. Either way nothing ran, nothing is green, and the message says what
 * to configure.
 *
 * @category errors
 * @since 0.1.0
 */
export class MemoryBackendUnavailable extends Error {
  override readonly name = "MemoryBackendUnavailable"
  readonly code: "no_backend_declared" | "cli_not_found"

  constructor(code: "no_backend_declared" | "cli_not_found", message: string) {
    super(`memory backend unavailable (${code}): ${message}`)
    this.code = code
  }
}

/**
 * Checks whether a value is the unavailable-backend notice.
 *
 * @category guards
 * @since 0.1.0
 */
export const isMemoryBackendUnavailable = (value: unknown): value is MemoryBackendUnavailable =>
  value instanceof MemoryBackendUnavailable

/**
 * The resolved backend ran and refused the retain.
 *
 * @category errors
 * @since 0.1.0
 */
export class MemoryCommandFailed extends Error {
  override readonly name = "MemoryCommandFailed"
  readonly exitCode: number
  readonly stderr: string

  constructor(exitCode: number, stderr: string) {
    super(`smithers memory exited ${exitCode}: ${stderr.trim()}`)
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/**
 * Checks whether a value is a backend command failure.
 *
 * @category guards
 * @since 0.1.0
 */
export const isMemoryCommandFailed = (value: unknown): value is MemoryCommandFailed =>
  value instanceof MemoryCommandFailed

/**
 * Finds the `smithers` binary, or undefined when the host has none.
 *
 * @category models
 * @since 0.1.0
 */
export interface CliLocator {
  find(): Promise<string | undefined>
}

/**
 * Runs one resolved backend invocation.
 *
 * @category models
 * @since 0.1.0
 */
export interface MemoryCli {
  run(binary: string, args: ReadonlyArray<string>, cwd: string): Promise<{
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
  }>
}

const executableCandidates = (name: string): ReadonlyArray<string> =>
  process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name]

/**
 * The default locator: scans PATH for an executable `smithers`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const pathLocator = (environment: Readonly<Record<string, string | undefined>> = process.env): CliLocator => ({
  find: async () => {
    const path = environment["PATH"] ?? ""
    for (const directory of path.split(NodePath.delimiter)) {
      if (directory === "") continue
      for (const candidate of executableCandidates("smithers")) {
        const absolute = NodePath.join(directory, candidate)
        try {
          await Fs.access(absolute, Fs.constants.X_OK)
          const stats = await Fs.stat(absolute)
          if (stats.isFile()) return absolute
        } catch {
          // Not here; keep scanning.
        }
      }
    }
    return undefined
  }
})

/**
 * Options for {@link spawnCli}.
 *
 * @category models
 * @since 0.1.0
 */
export interface SpawnCliOptions {
  /** Wall-clock cap on one backend invocation; the process is killed past it and the run fails. */
  readonly timeoutMs?: number | undefined
}

/**
 * The default runner: spawns the resolved binary with no shell.
 *
 * @category constructors
 * @since 0.1.0
 */
export const spawnCli = (options: SpawnCliOptions = {}): MemoryCli => ({
  run: (binary, args, cwd) =>
    new Promise((resolve) => {
      NodeChildProcess.execFile(
        binary,
        [...args],
        { cwd, maxBuffer: 8 * 1024 * 1024, ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }) },
        (error, stdout, stderr) => {
          const exitCode = error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 1
          const killed = error !== null && (error as { killed?: unknown }).killed === true
          resolve({
            exitCode,
            stdout,
            stderr: killed && options.timeoutMs !== undefined
              ? `${stderr}\nsmithers memory timed out after ${options.timeoutMs}ms`.trim()
              : stderr
          })
        }
      )
    })
})

/**
 * Options accepted by {@link retain}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetainOptions {
  /** The workspace root the CLI runs in. */
  readonly root: string
  /** The `Memory.Retain` target whose validated attrs drive the invocation. */
  readonly target: Target.AnyTarget
  /** The workspace memory declaration, or undefined when none is declared. */
  readonly memory: WorkspaceDeclaration.WorkspaceDeclaration["memory"]
  /** @default {@link pathLocator} over the process environment */
  readonly locator?: CliLocator | undefined
  /** @default {@link spawnCli} */
  readonly cli?: MemoryCli | undefined
}

/**
 * The completed retain: the binary that ran and the argv it received.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetainResult {
  readonly binary: string
  readonly args: ReadonlyArray<string>
  readonly stdout: string
}

/**
 * Retains the referenced commit in the declared Smithers Cloud bank.
 *
 * The documented backend surface is the `smithers memory` command family;
 * the exact argv spelling here (`memory retain --source <ref> --bank <bank>
 * --tag <tag>...`) is provisional and owned by this one function.
 *
 * @category execution
 * @since 0.1.0
 */
export const retain = async (options: RetainOptions): Promise<RetainResult> => {
  const attrs = MemoryTarget.retainAttrsOf(options.target)
  if (options.memory === undefined) {
    throw new MemoryBackendUnavailable(
      "no_backend_declared",
      "the WORKSPACE.ts declares no S.Memory.SmithersCloud backend"
    )
  }
  const locator = options.locator ?? pathLocator()
  const binary = await locator.find()
  if (binary === undefined) {
    throw new MemoryBackendUnavailable(
      "cli_not_found",
      "the smithers CLI is not on PATH; install it or remove the memory declaration"
    )
  }
  const args: Array<string> = ["memory", "retain", "--source", attrs.source.ref]
  for (const bank of options.memory.bank) args.push("--bank", bank)
  for (const tag of attrs.tags) args.push("--tag", tag)
  const cli = options.cli ?? spawnCli()
  const output = await cli.run(binary, args, options.root)
  if (output.exitCode !== 0) {
    throw new MemoryCommandFailed(output.exitCode, output.stderr)
  }
  return { binary, args, stdout: output.stdout }
}
