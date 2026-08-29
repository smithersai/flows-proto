import { Smithers as S } from "@smthrs/targets"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as MiseExec from "../src/MiseExec.ts"

/**
 * A fake `mise` on PATH. It records `install`, answers `bin-paths` with the
 * directory the test names, and answers `which` only for an executable that
 * exists there, which is the contract the real launcher honors.
 */
const fakeMise = `#!/bin/sh
case "$1" in
  install) printf 'install\\n' >> "$MISE_FAKE_LOG"; exit 0 ;;
  bin-paths) printf '%s\\n' "$MISE_FAKE_BIN"; exit 0 ;;
  which)
    if [ -x "$MISE_FAKE_BIN/$2" ]; then printf '%s\\n' "$MISE_FAKE_BIN/$2"; exit 0; fi
    printf '%s is not a mise bin\\n' "$2" >&2; exit 1 ;;
  *) exit 2 ;;
esac
`

const workspaceWithMise = S.Workspace("mise-unit", {
  repository: "git+https://example.invalid/unit.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Pnpm({
    version: "11.21.0",
    runtime: S.Runtime.Node({ version: ">=22.19.0" })
  }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  toolchains: [S.Mise({ config: S.file("//mise.toml") })]
})

const workspaceWithoutMise = S.Workspace("plain-unit", {
  repository: "git+https://example.invalid/unit.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Pnpm({
    version: "11.21.0",
    runtime: S.Runtime.Node({ version: ">=22.19.0" })
  }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})

interface Harness {
  readonly root: string
  readonly launcherDir: string
  readonly toolBin: string
  readonly log: string
}

const savedEnvironment: Record<string, string | undefined> = {}
const temporaryDirectories: Array<string> = []

const setEnvironment = (name: string, value: string | undefined): void => {
  if (!(name in savedEnvironment)) savedEnvironment[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const makeHarness = async (options: { readonly launcher: boolean }): Promise<Harness> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-mise-")))
  temporaryDirectories.push(root)
  const launcherDir = NodePath.join(root, "launcher")
  const toolBin = NodePath.join(root, "tools", "bin")
  const log = NodePath.join(root, "install.log")
  await Fs.mkdir(launcherDir, { recursive: true })
  await Fs.mkdir(toolBin, { recursive: true })
  await Fs.writeFile(NodePath.join(root, "mise.toml"), "[tools]\nforge = \"1.7.1\"\n", "utf8")
  await Fs.writeFile(NodePath.join(toolBin, "forge"), "#!/bin/sh\necho forge\n", { mode: 0o755 })
  if (options.launcher) await Fs.writeFile(NodePath.join(launcherDir, "mise"), fakeMise, { mode: 0o755 })
  setEnvironment("MISE_FAKE_BIN", toolBin)
  setEnvironment("MISE_FAKE_LOG", log)
  // PATH holds only the launcher directory (plus /bin and /usr/bin for sh), so
  // the outcome depends on the fake and never on a mise the host may carry.
  setEnvironment("PATH", [launcherDir, "/usr/bin", "/bin"].join(NodePath.delimiter))
  return { root, launcherDir, toolBin, log }
}

beforeEach(() => {
  MiseExec.reset()
})

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const name of Object.keys(savedEnvironment)) delete savedEnvironment[name]
  MiseExec.reset()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => Fs.rm(directory, { recursive: true, force: true }))
  )
})

describe("MiseExec.activate", () => {
  it("is inert for a workspace that declares no mise layer", async () => {
    const harness = await makeHarness({ launcher: true })
    expect(await MiseExec.activate(harness.root, workspaceWithoutMise)).toBeUndefined()
    await expect(Fs.access(harness.log)).rejects.toThrow()
  })

  it("installs the declared pins once and leads PATH with their bin directories", async () => {
    const harness = await makeHarness({ launcher: true })
    const first = await MiseExec.activate(harness.root, workspaceWithMise)
    const second = await MiseExec.activate(harness.root, workspaceWithMise)
    expect(first).toMatchObject({ ok: true, config: "mise.toml", binPaths: [harness.toolBin], refusal: undefined })
    expect(second).toBe(first)
    expect(await Fs.readFile(harness.log, "utf8")).toBe("install\n")
    expect((process.env["PATH"] ?? "").split(NodePath.delimiter)[0]).toBe(harness.toolBin)
  })

  it("refuses by name when the host has no mise", async () => {
    const harness = await makeHarness({ launcher: false })
    const activation = await MiseExec.activate(harness.root, workspaceWithMise)
    expect(activation).toMatchObject({ ok: false, mise: undefined, binPaths: [] })
    expect(activation!.refusal).toContain("host binary \"mise\" is not present on PATH")
    expect(activation!.refusal).toContain("mise.toml")
    expect((process.env["PATH"] ?? "").split(NodePath.delimiter)[0]).toBe(harness.launcherDir)
  })
})

describe("MiseExec.which", () => {
  it("resolves a pinned tool to the executable the config installs", async () => {
    const harness = await makeHarness({ launcher: true })
    const resolved = await MiseExec.which(harness.root, workspaceWithMise, "forge")
    expect(resolved).toMatchObject({ ok: true, path: NodePath.join(harness.toolBin, "forge") })
  })

  it("refuses a tool the config does not pin", async () => {
    const harness = await makeHarness({ launcher: true })
    const resolved = await MiseExec.which(harness.root, workspaceWithMise, "anvil")
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.refusal).toBe("\"anvil\" is not a tool the declared mise config mise.toml pins")
  })

  it("refuses without a declared layer", async () => {
    const harness = await makeHarness({ launcher: true })
    const resolved = await MiseExec.which(harness.root, workspaceWithoutMise, "forge")
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.refusal).toContain("requires an S.Mise entry in Workspace toolchains")
  })
})
