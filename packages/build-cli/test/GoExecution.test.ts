import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () =>
  Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
)
const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}
const serve = async (root: string, args: ReadonlyArray<string>) => {
  let exitCode = 0, output = "", logs = ""
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    logs += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    await makeCli({}).serve([...normalizeArgv(args), "--workspace", root], {
      exit: (code) => {
        exitCode = code
      },
      stdout: (text) => {
        output += text
      }
    })
  } finally {
    process.stderr.write = original
  }
  return { exitCode, output, logs }
}
const fixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-go-exec-")))
  temporaryDirectories.push(root)
  await write(root, "go.mod", "module example.test/fixture\n\ngo 1.26.0\n")
  await write(root, "go.sum", "")
  await write(root, "flake.nix", "{}\n")
  await write(root, "flake.lock", "{}\n")
  await write(root, "lib/lib.go", "package lib\nfunc Value() string { return \"ok\" }\n")
  await write(
    root,
    "lib/lib_test.go",
    "package lib\nimport \"testing\"\nfunc TestValue(t *testing.T) { if Value() != \"ok\" { t.Fatal(Value()) } }\nfunc FuzzValue(f *testing.F) { f.Add(\"x\"); f.Fuzz(func(t *testing.T, s string) {}) }\n"
  )
  await write(
    root,
    "cmd/app/main.go",
    "package main\nimport (\"fmt\"; \"example.test/fixture/lib\")\nvar Version = \"unset\"\nfunc main() { fmt.Println(lib.Value(), Version) }\n"
  )
  await write(
    root,
    "gen/gen.go",
    "package gen\n//go:generate sh -c \"printf 'package gen\\nconst Generated = true\\n' > generated.go\"\n"
  )
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const nix = S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
const go = S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: nix, cgo: false })
export const Workspace = S.Workspace("fixture", { repository: "git+https://example.test/fixture.git", cache: S.Cache({ directory: ".flows" }), toolchains: [nix, go] })
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const all = S.Go.Packages({ pkgs: ["./..."] })
const test = S.Go.Test({ pkgs: ["./lib"] })
const binary = S.Go.Binary({ pkg: "./cmd/app", out: "//build/app", stamp: { "main.Version": S.Stamp.version } })
const smoke = S.Shell.Test({ bin: binary })
const generate = S.Go.Generate({ pkgs: ["./gen"], changes: ["gen/generated.go"] })
const fuzz = S.Go.Fuzz({ pkg: "./lib", fuzz: "FuzzValue", time: "1x", parallel: 1 })
const nixRefusal = S.Shell.Test({ bin: S.Nix.bin("hurl"), args: ["--version"] })
export const Package = S.Package({ targets: { all, binary, fuzz, generate, nixRefusal, smoke, test } })
`
  )
  NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
  NodeChildProcess.execFileSync("git", ["-C", root, "add", "-A"])
  NodeChildProcess.execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=t@t.t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init"
  ])
  NodeChildProcess.execFileSync("git", ["-C", root, "tag", "v1.2.3"])
  return root
}

describe("Go package execution", () => {
  it("loads, plans without NotImplemented, executes tests/build/tool edge/stamps, and hits", async () => {
    const root = await fixture()
    const query = await serve(root, ["query", "//..."])
    expect(query.exitCode).toBe(0)
    const plan = await serve(root, ["//:binary", "--plan"])
    expect(plan.exitCode).toBe(0)
    expect(plan.output).not.toContain("NotImplemented")
    const tested = await serve(root, ["//:test"])
    expect(tested.exitCode).toBe(0)
    const smoke = await serve(root, ["//:smoke"])
    expect(smoke.exitCode).toBe(0)
    expect(smoke.logs).toContain("//:binary  ran")
    expect(NodeChildProcess.execFileSync(NodePath.join(root, "build/app"), { encoding: "utf8" })).toContain("ok v1.2.3")
    const hit = await serve(root, ["//:smoke"])
    expect(hit.exitCode).toBe(0)
    expect(hit.logs).toContain("//:binary  hit")
    expect(hit.logs).toContain("//:smoke  hit")
  }, 120_000)

  it("runs Generate/Fuzz and gives Nix's typed host refusal", async () => {
    const root = await fixture()
    const generated = await serve(root, ["//:generate", "--write"])
    expect(generated.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "gen/generated.go"), "utf8")).toContain("Generated")
    expect((await serve(root, ["//:fuzz"])).exitCode).toBe(0)
    const nix = await serve(root, ["//:nixRefusal", "--plan"])
    expect(nix.output).toContain("host binary \\\"nix\\\" is not present on PATH")
  }, 120_000)

  it("keys on the Go import closure only", async () => {
    const root = await fixture()
    expect((await serve(root, ["//:test"])).exitCode).toBe(0)
    await write(root, "outside.txt", "outside\n")
    expect((await serve(root, ["//:test"])).logs).toContain("//:test  hit")
    await write(
      root,
      "lib/lib.go",
      "package lib\n// changed inside the closure\nfunc Value() string { return \"ok\" }\n"
    )
    const changed = await serve(root, ["//:test"])
    expect(changed.logs).toContain("//:test  ran")
  }, 120_000)
})
