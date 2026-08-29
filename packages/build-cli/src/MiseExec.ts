/**
 * mise activation for package-mode execution.
 *
 * `S.Mise({ config })` declares the version authority for the tools a
 * workspace pins outside its JavaScript runtime, package manager, and Rust
 * layer: a Foundry release, a Bun release, a Zig release. The declaration is
 * inert; this module is where it takes effect. Activation installs every pin
 * the declared config names (a no-op once they are installed), then prepends
 * the pinned tools' bin directories to the process `PATH`, so every
 * host-binary lookup and every spawned target sees the pinned release ahead
 * of whatever the host happens to carry. The generated CI setup action
 * reaches the same state through `jdx/mise-action`, so a target resolves the
 * same tool on a runner and on a developer machine.
 *
 * An absent `mise` is not an error at activation: query and plan keep
 * working, and each target that needs a pinned tool refuses by name with the
 * install hint. Activation runs once per workspace root and config per
 * process.
 *
 * @since 0.1.0
 */
import * as Input from "@smthrs/targets/Input"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as NodeChildProcess from "node:child_process"
import * as NodePath from "node:path"
import * as PackageTree from "./PackageTree.ts"

/**
 * The outcome of activating one declared mise config.
 *
 * @category models
 * @since 0.1.0
 */
export interface Activation {
  readonly ok: boolean
  /** The declared config, workspace-relative. */
  readonly config: string
  /** The resolved mise executable, or undefined when the host has none. */
  readonly mise: string | undefined
  /** The pinned tools' bin directories, in the order they were prepended to PATH. */
  readonly binPaths: ReadonlyArray<string>
  /** Why activation did not complete, when it did not. */
  readonly refusal: string | undefined
}

interface Completed {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Bounded tail of a failed command's stderr, for a refusal message. */
const tail = (text: string): string => {
  const lines = text.trim().split(/\r?\n/).filter((line) => line !== "")
  return lines.slice(-3).join(" | ").slice(0, 512)
}

const run = (
  file: string,
  args: ReadonlyArray<string>,
  cwd: string,
  configPath: string
): Promise<Completed> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      file,
      [...args],
      {
        cwd,
        timeout: 600_000,
        maxBuffer: 1 << 24,
        // MISE_YES answers the trust and install prompts a fresh host raises;
        // the trusted-path entry lets the read-only subcommands see the
        // declared config before the first install has recorded its trust.
        env: { ...process.env, MISE_YES: "1", MISE_TRUSTED_CONFIG_PATHS: configPath }
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : (error as { readonly code?: unknown }).code
        resolve({
          exitCode: typeof code === "number" ? code : error === null ? 0 : 1,
          stdout: String(stdout),
          stderr: String(stderr)
        })
      }
    )
  })

const activations = new Map<string, Promise<Activation>>()

const configLocation = (root: string, config: string): { readonly path: string; readonly directory: string } => {
  const path = NodePath.join(root, ...config.split("/"))
  return { path, directory: NodePath.dirname(path) }
}

const activateOnce = async (root: string, config: string): Promise<Activation> => {
  const location = configLocation(root, config)
  const mise = PackageTree.findOnPath("mise")
  if (mise === undefined) {
    return {
      ok: false,
      config,
      mise: undefined,
      binPaths: [],
      refusal: `host binary "mise" is not present on PATH; S.Mise({ config: ${
        JSON.stringify(config)
      } }) pins tools this host cannot install without it (https://mise.jdx.dev/installing-mise.html)`
    }
  }
  const install = await run(mise, ["install"], location.directory, location.path)
  if (install.exitCode !== 0) {
    return {
      ok: false,
      config,
      mise,
      binPaths: [],
      refusal: `mise install for ${config} failed: ${tail(install.stderr) || `exit ${install.exitCode}`}`
    }
  }
  const listed = await run(mise, ["bin-paths"], location.directory, location.path)
  if (listed.exitCode !== 0) {
    return {
      ok: false,
      config,
      mise,
      binPaths: [],
      refusal: `mise bin-paths for ${config} failed: ${tail(listed.stderr) || `exit ${listed.exitCode}`}`
    }
  }
  const binPaths = listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "")
  const current = (process.env["PATH"] ?? "").split(NodePath.delimiter).filter((entry) => entry !== "")
  const added = binPaths.filter((entry) => !current.includes(entry))
  if (added.length > 0) process.env["PATH"] = [...added, ...current].join(NodePath.delimiter)
  return { ok: true, config, mise, binPaths, refusal: undefined }
}

/**
 * Installs the declared mise pins and puts their bin directories on PATH.
 *
 * Returns undefined for a workspace that declares no `S.Mise` layer. The
 * result is memoized per root and config, so repeated calls from tool
 * resolution cost nothing after the first.
 *
 * @category activation
 * @since 0.1.0
 */
export const activate = (
  root: string,
  workspace: WorkspaceDeclaration.WorkspaceDeclaration
): Promise<Activation | undefined> => {
  const declaration = WorkspaceDeclaration.mise(workspace)
  if (declaration === undefined) return Promise.resolve(undefined)
  const config = Input.resolvePath("", declaration.config.path)
  const key = `${root}\0${config}`
  const known = activations.get(key)
  if (known !== undefined) return known
  const pending = activateOnce(root, config)
  activations.set(key, pending)
  return pending
}

/**
 * Forgets every memoized activation; tests use it between hermetic roots.
 *
 * @category activation
 * @since 0.1.0
 */
export const reset = (): void => {
  activations.clear()
}

/**
 * One resolved pinned tool, or the typed refusal that stands in for it.
 *
 * @category models
 * @since 0.1.0
 */
export type Resolved =
  | { readonly ok: true; readonly path: string; readonly activation: Activation }
  | { readonly ok: false; readonly refusal: string; readonly activation: Activation | undefined }

/**
 * Resolves `S.Mise.bin(name)` to the executable the declared config pins.
 *
 * @category activation
 * @since 0.1.0
 */
export const which = async (
  root: string,
  workspace: WorkspaceDeclaration.WorkspaceDeclaration,
  name: string
): Promise<Resolved> => {
  const activation = await activate(root, workspace)
  if (activation === undefined) {
    return {
      ok: false,
      refusal: `S.Mise.bin(${JSON.stringify(name)}) requires an S.Mise entry in Workspace toolchains`,
      activation
    }
  }
  if (!activation.ok || activation.mise === undefined) {
    return { ok: false, refusal: activation.refusal ?? "mise activation failed", activation }
  }
  const location = configLocation(root, activation.config)
  const found = await run(activation.mise, ["which", name], location.directory, location.path)
  const path = found.stdout.trim()
  if (found.exitCode !== 0 || path === "") {
    return {
      ok: false,
      refusal: `${JSON.stringify(name)} is not a tool the declared mise config ${activation.config} pins`,
      activation
    }
  }
  return { ok: true, path, activation }
}
