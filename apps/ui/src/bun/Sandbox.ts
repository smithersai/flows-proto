/*
 * The sandbox policy for every process the local app spawns (LOCAL-APP.md,
 * "Sandbox"). Policies are data: a policy names what a spawn may write and
 * whether it may reach the network, `renderProfile` turns it into seatbelt
 * text, and `wrapSandbox` prefixes an argv with `/usr/bin/sandbox-exec`.
 *
 * `wrapSandbox` reads only its arguments. The host facts it needs (platform,
 * the SMITHERS_SANDBOX switch) arrive as a `SandboxHost`, so tests can assert
 * the generated profile and the unenforced branches without touching the
 * process environment.
 */

export type SandboxPolicyId = "loader" | "harness" | "terminal"

export interface SandboxPolicy {
  readonly id: SandboxPolicyId
  readonly network: "allow" | "deny"
  /** Directories the spawn may write anywhere below. Absolute paths. */
  readonly writableDirs: ReadonlyArray<string>
  /** Single files the spawn may write. Absolute paths. */
  readonly writableFiles: ReadonlyArray<string>
}

/** What a policy is built from: the repository and the host's well-known dirs. */
export interface SandboxPaths {
  readonly repo: string
  readonly home: string
  readonly tmpdir: string
}

const HOME_DOT_DIRS = [".claude", ".codex", ".gemini", ".kimi", ".config", ".cache", ".local"] as const
const HOME_DOT_FILES = [".claude.json"] as const

const unique = (paths: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(paths.filter((path) => path !== ""))]

const scratchDirs = (paths: SandboxPaths): ReadonlyArray<string> => [paths.tmpdir, "/private/tmp"]

const homeDotDirs = (paths: SandboxPaths): ReadonlyArray<string> => HOME_DOT_DIRS.map((dir) => `${paths.home}/${dir}`)

const homeDotFiles = (paths: SandboxPaths): ReadonlyArray<string> => HOME_DOT_FILES.map((file) => `${paths.home}/${file}`)

/** `smthrs query`: no network; writes only the repo's `.flows` cache and scratch. */
export const loaderPolicy = (paths: SandboxPaths): SandboxPolicy => ({
  id: "loader",
  network: "deny",
  writableDirs: unique([`${paths.repo}/.flows`, ...scratchDirs(paths)]),
  writableFiles: []
})

/** A harness tab (claude, codex, ...): network on; writes the repo, its config dirs and scratch. */
export const harnessPolicy = (paths: SandboxPaths): SandboxPolicy => ({
  id: "harness",
  network: "allow",
  writableDirs: unique([paths.repo, ...homeDotDirs(paths), ...scratchDirs(paths)]),
  writableFiles: unique(homeDotFiles(paths))
})

/** A terminal tab: the same confinement as a harness tab. */
export const terminalPolicy = (paths: SandboxPaths): SandboxPolicy => ({
  id: "terminal",
  network: "allow",
  writableDirs: unique([paths.repo, ...homeDotDirs(paths), ...scratchDirs(paths)]),
  writableFiles: unique(homeDotFiles(paths))
})

export const sandboxPolicies: Readonly<Record<SandboxPolicyId, (paths: SandboxPaths) => SandboxPolicy>> = {
  loader: loaderPolicy,
  harness: harnessPolicy,
  terminal: terminalPolicy
}

/** Seatbelt string literal: backslashes and double quotes escaped. */
const seatbeltString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`

/**
 * The seatbelt profile for a policy. Later rules win in seatbelt, so the
 * profile allows everything, denies every write (and the network when the
 * policy says so), then re-allows the policy's writable paths plus the
 * device nodes an interactive process needs.
 */
export const renderProfile = (policy: SandboxPolicy): string => {
  const lines = [
    "(version 1)",
    `; smithers local app: ${policy.id}`,
    "(allow default)",
    ...(policy.network === "deny" ? ["(deny network*)"] : []),
    "(deny file-write*)",
    "(allow file-write* (literal \"/dev/null\") (regex #\"^/dev/tty\") (regex #\"^/dev/pty\") (regex #\"^/dev/fd/\"))",
    ...policy.writableDirs.map((dir) => `(allow file-write* (subpath ${seatbeltString(dir)}))`),
    ...policy.writableFiles.map((file) => `(allow file-write* (literal ${seatbeltString(file)}))`)
  ]
  return `${lines.join("\n")}\n`
}

export interface SandboxHost {
  /** `process.platform`. Only "darwin" enforces. */
  readonly platform: string
  /** `SMITHERS_SANDBOX=off` disables wrapping everywhere. */
  readonly disabled: boolean
  readonly log: (line: string) => void
}

export const currentSandboxHost = (env: Record<string, string | undefined> = Bun.env): SandboxHost => ({
  platform: process.platform,
  disabled: env.SMITHERS_SANDBOX === "off",
  log: (line) => console.error(line)
})

export interface WrappedSpawn {
  readonly argv: ReadonlyArray<string>
  readonly enforced: boolean
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

/** Whether spawns on this host run under seatbelt. */
export const sandboxEnforced = (host: SandboxHost): boolean => host.platform === "darwin" && !host.disabled

export const wrapSandbox = (
  argv: ReadonlyArray<string>,
  policy: SandboxPolicy,
  host: SandboxHost = currentSandboxHost()
): WrappedSpawn => {
  if (host.disabled) {
    host.log(`sandbox: disabled by SMITHERS_SANDBOX=off (${policy.id})`)
    return { argv, enforced: false }
  }
  if (host.platform !== "darwin") {
    host.log("sandbox: unenforced on this platform")
    return { argv, enforced: false }
  }
  return { argv: [SANDBOX_EXEC, "-p", renderProfile(policy), ...argv], enforced: true }
}
