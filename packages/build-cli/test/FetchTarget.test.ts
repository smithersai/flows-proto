/**
 * `S.Fetch` through the package-mode CLI: a PACKAGE.ts that declares a
 * digest-pinned remote file (mirroring force's `//data:schemaPinned`) loads,
 * queries, plans as a typed NotImplemented refusal, and never writes the
 * declared output. The WORKSPACE.ts carries the split read/write remote
 * cache declaration force's `.smithers/WORKSPACE.ts` uses.
 */
import * as Target from "@smthrs/targets/Target"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const temporaryWorkspace = async (): Promise<string> =>
  Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-fetch-target-")))

/**
 * Serves one command against a workspace, capturing exit code and output.
 * Argv passes through `normalizeArgv` exactly as `main.ts` does, so the
 * bare-label form (`smthrs '//data:schemaPinned'`) is exercised as typed.
 */
const serve = async (
  root: string,
  args: ReadonlyArray<string>
): Promise<{ readonly exitCode: number; readonly output: string }> => {
  let exitCode = 0
  let output = ""
  await makeCli({}).serve([...normalizeArgv([...args, "--workspace", root])], {
    exit: (code) => {
      exitCode = code
    },
    stdout: (text) => {
      output += text
    }
  })
  return { exitCode, output }
}

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({
    directory: ".flows",
    remote: S.RemoteCache.make({
      endpoint: "https://build.example.invalid",
      read: S.Secret("FIXTURE_CACHE_READ_TOKEN"),
      write: S.Secret("FIXTURE_CACHE_WRITE_TOKEN"),
    }),
  }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

/**
 * Mirrors force's data/PACKAGE.ts: a declared schema file, the pinned
 * upstream fetch, and a consumer that names the fetch in `data`.
 */
const dataModule = `import { Smithers as S } from "@smthrs/targets"
const schema = S.file("schema.graphql")
const schemaPinned = S.Fetch({
  url: "https://raw.githubusercontent.com/artsy/metaphysics/e97558687736902fef8e037ffabc98dba33a3e0f/_schemaV2.graphql",
  sha256: "7f60276646f651505e048961954fa97c7ad8501b284ac3db362c04f1d23c72e0",
  out: "schema.upstream.graphql",
})
const schemaDrift = S.Shell.Test({
  command: "diff -q schema.graphql schema.upstream.graphql",
  data: [schemaPinned, schema],
})
export const Package = S.Package({ targets: { schema, schemaPinned, schemaDrift } })
`

const fixtureWorkspace = async (): Promise<string> => {
  const root = await temporaryWorkspace()
  await write(root, "WORKSPACE.ts", workspaceModule)
  await write(root, "data/PACKAGE.ts", dataModule)
  await write(root, "data/schema.graphql", "type Query { ok: Boolean }\n")
  return root
}

describe("S.Fetch in a PACKAGE.ts workspace", () => {
  it("loads, labels the fetch, classifies the consumer's data edge, and keeps the split remote cache", async () => {
    const root = await fixtureWorkspace()
    const discovery = await PackageDiscovery.discover(root)
    const loaded = await PackageLoader.load(discovery)
    const index = PackageIndex.make(loaded)
    expect(index.targets().map((row) => row.label)).toEqual([
      "//data:schema",
      "//data:schemaDrift",
      "//data:schemaPinned"
    ])
    const [pinned] = index.resolve("//data:schemaPinned")
    const metadata = Target.metadata(pinned!.target)
    expect(metadata.target).toBe("Fetch")
    expect(metadata.kinds).toEqual(["build"])
    expect(metadata.outputs).toEqual({ cwd: ".", paths: ["schema.upstream.graphql"] })
    expect(index.edges(index.resolve("//..."))).toContainEqual({
      from: "//data:schemaDrift",
      to: "//data:schemaPinned",
      kind: "data"
    })
    const remote = loaded.workspace.cache.remote
    expect(remote?.endpoint).toBe("https://build.example.invalid")
    expect(remote?.token).toEqual({ _tag: "Secret", env: "FIXTURE_CACHE_READ_TOKEN" })
    expect(remote?.write).toEqual({ _tag: "Secret", env: "FIXTURE_CACHE_WRITE_TOKEN" })
  })

  it("lists the fetch through query --format json with its rule and kinds", async () => {
    const root = await fixtureWorkspace()
    const { exitCode, output } = await serve(root, ["query", "//...", "--format", "json"])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output) as {
      readonly targets: ReadonlyArray<
        { readonly label: string; readonly target: string; readonly kinds: ReadonlyArray<string> }
      >
    }
    expect(parsed.targets).toContainEqual({ label: "//data:schemaPinned", target: "Fetch", kinds: ["build"] })
    expect(parsed.targets).toHaveLength(3)
  })

  it("plans the fetch as a typed NotImplemented refusal and never writes its output", async () => {
    const root = await fixtureWorkspace()
    const planned = await serve(root, ["//data:schemaPinned", "--plan", "--format", "json"])
    expect(planned.exitCode).toBe(0)
    const plan = JSON.parse(planned.output) as {
      readonly targets: ReadonlyArray<{ readonly label: string; readonly rule: string; readonly refusal?: string }>
    }
    expect(plan.targets).toHaveLength(1)
    expect(plan.targets[0]!.rule).toBe("Fetch")
    expect(plan.targets[0]!.refusal).toMatch(/^NotImplemented: Fetch/)

    // Executing the refused node is a red exit (the refusal text itself goes
    // to the log stream), and the declared output never appears on disk.
    const executed = await serve(root, ["//data:schemaPinned"])
    expect(executed.exitCode).toBe(1)
    expect(executed.output).toContain("targets_failed")
    await expect(Fs.access(NodePath.join(root, "data/schema.upstream.graphql"))).rejects.toThrow()
  })
})
