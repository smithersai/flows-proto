import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const workspace = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("node-lane", {
  repository: "git+https://example.invalid/node-lane.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  host: S.Host({ bins: ["git"] }),
})
`

const packageModule = `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
const gate = S.Shell.Test({ command: "true" })
const pack = S.Npm.Pack({ manifest, data: [S.file("//input.txt")] })
const literal = S.Literal({ path: "out/literal.txt", content: "literal" })
const copy = S.Copy({ from: S.file("//input.txt"), to: "out/copied.txt" })
const markdown = S.Markdown.CodeBlocks({ file: S.file("//README.md"), lang: ["ts"] })
const version = S.Changesets.Version({ config: S.file("//changeset.json"), changes: ["version.txt"] })
const size = S.Size.Budgets({ manifest })
const digestBuild = S.Shell.Build({ command: "mkdir -p digest && printf hi > digest/a.txt", outDirs: ["digest"] })
const digest = S.Test({ expect: S.Files.digest(digestBuild), toBe: S.file("//digest-baseline.json") })
const cron = S.Cron({ schedule: "0 6 * * 1", run: [gate] })
const ci = S.Github.Ci({
  workflows: { test: { on: { pullRequest: true }, run: gate } },
  changes: [".github/workflows/**"]
})
const overlay = S.Overlay({ base: literal, replace: { "x.ts": S.file("//input.txt") } })
const downstream = S.Npm.Downstream({
  repository: "https://example.invalid/repo",
  overrides: { fixture: literal },
  run: ["test"]
})
const publishMissing = S.Npm.Publish({ pack, gates: [gate] })
const publishApproval = S.Npm.Publish({
  pack,
  gates: [gate],
  secrets: [S.Secret("NPM_TOKEN")],
  approval: "required"
})
const pages = S.Github.Pages({ site: literal, secrets: [S.Secret("GITHUB_TOKEN")] })
const pr = S.Git.Pr({ gates: [gate], secrets: [S.Secret("GITHUB_TOKEN")] })
export const Package = S.Package({ targets: {
  ci, copy, cron, digest, digestBuild, downstream, gate, literal, markdown, overlay, pack, pages, pr,
  publishApproval, publishMissing, size, version
} })
`

const fixture = async (): Promise<string> => {
  const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-node-lane-"))
  temporaryDirectories.push(root)
  await write(root, "WORKSPACE.ts", workspace)
  await write(root, "PACKAGE.ts", packageModule)
  await write(
    root,
    "package.json",
    JSON.stringify({ name: "node-lane-fixture", version: "1.0.0", files: ["input.txt"] })
  )
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  await write(root, "input.txt", "input")
  await write(root, "README.md", "```ts\nconst answer: number = 42\n```\n")
  await write(root, "changeset.json", "{}")
  await write(
    root,
    "digest-baseline.json",
    JSON.stringify([
      { path: "digest/a.txt", digest: "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4" }
    ])
  )
  await write(root, "version.txt", "old")
  for (
    const [name, body] of [
      ["tsc", "#!/bin/sh\nexit 0\n"],
      ["size-limit", "#!/bin/sh\nexit 0\n"],
      ["changeset", "#!/bin/sh\nprintf next > version.txt\n"]
    ] as const
  ) {
    await write(root, `node_modules/.bin/${name}`, body)
    await Fs.chmod(NodePath.join(root, "node_modules", ".bin", name), 0o755)
  }
  NodeChildProcess.execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: root,
    stdio: "ignore"
  })
  NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
  NodeChildProcess.execFileSync("git", ["-C", root, "add", "-A"])
  NodeChildProcess.execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=test",
    "commit",
    "-qm",
    "fixture"
  ])
  return root
}

const serve = async (root: string, args: ReadonlyArray<string>) => {
  let exitCode = 0
  let output = ""
  let logs = ""
  const writeError = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    logs += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stderr.write
  try {
    await makeCli({}).serve([...normalizeArgv(args), "--workspace", root], {
      exit: (code) => void (exitCode = code),
      stdout: (text) => void (output += text)
    })
  } finally {
    process.stderr.write = writeError
  }
  return { exitCode, output, logs }
}

describe("Node lane package execution", () => {
  it("writes, caches, and CAS-restores Literal, Copy, and Npm.Pack files", async () => {
    const root = await fixture()
    expect((await serve(root, ["//:literal"])).exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out/literal.txt"), "utf8")).toBe("literal")
    await Fs.rm(NodePath.join(root, "out/literal.txt"))
    const restored = await serve(root, ["//:literal"])
    expect(restored.exitCode).toBe(0)
    expect(restored.logs).toContain("//:literal  hit")
    expect(await Fs.readFile(NodePath.join(root, "out/literal.txt"), "utf8")).toBe("literal")

    expect((await serve(root, ["//:copy"])).exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out/copied.txt"), "utf8")).toBe("input")

    expect((await serve(root, ["//:pack"])).exitCode).toBe(0)
    const tarball = NodePath.join(root, "node-lane-fixture-1.0.0.tgz")
    expect((await Fs.stat(tarball)).isFile()).toBe(true)
    await Fs.rm(tarball)
    const packHit = await serve(root, ["//:pack"])
    expect(packHit.exitCode).toBe(0)
    expect(packHit.logs).toContain("//:pack  hit")
    expect((await Fs.stat(tarball)).isFile()).toBe(true)
  })

  it("checks Markdown blocks and size budgets with cache hits", async () => {
    const root = await fixture()
    const before = await serve(root, ["//:markdown", "--plan"])
    const markdown = await serve(root, ["//:markdown"])
    expect(markdown.exitCode).toBe(0)
    expect(markdown.logs).toContain("checked 1 fenced code block")
    const after = await serve(root, ["//:markdown", "--plan"])
    expect(after.output, `${before.output}\n--- after ---\n${after.output}`).toBe(before.output)
    expect((await serve(root, ["//:markdown"])).logs).toContain("//:markdown  hit")
    expect((await serve(root, ["//:size"])).exitCode).toBe(0)
    expect((await serve(root, ["//:size"])).logs).toContain("//:size  hit")
    expect((await serve(root, ["//:digest"])).exitCode).toBe(0)
    expect((await serve(root, ["//:digest"])).logs).toContain("//:digest  hit")
    await write(root, "digest-baseline.json", "[]")
    expect((await serve(root, ["//:digest"])).logs).toContain("file digest differs")
  })

  it("confines Changesets.Version writes and distinguishes check/write", async () => {
    const root = await fixture()
    const red = await serve(root, ["//:version"])
    expect(red.exitCode).toBe(1)
    expect(red.logs).toContain("drift in declared write-set")
    expect(await Fs.readFile(NodePath.join(root, "version.txt"), "utf8")).toBe("old")
    const applied = await serve(root, ["//:version", "--write"])
    expect(applied.exitCode, applied.logs).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "version.txt"), "utf8")).toBe("next")
    expect((await serve(root, ["//:version"])).exitCode).toBe(0)
  })

  it("keeps Cron inert and gives unsupported virtual/remote runners typed reasons", async () => {
    const root = await fixture()
    const cron = await serve(root, ["//:cron"])
    expect(cron.exitCode).toBe(0)
    expect(cron.logs).toContain("inert schedule 0 6 * * 1")
    const drift = await serve(root, ["//:ci"])
    expect(drift.exitCode).toBe(1)
    expect(drift.logs).toContain("drift in generated GitHub files")
    expect((await serve(root, ["//:ci", "--write"])).exitCode).toBe(0)
    expect((await serve(root, ["//:ci"])).exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, ".github/workflows/cron-cron.yml"), "utf8"))
      .toContain("cron: \"0 6 * * 1\"")
    expect((await serve(root, ["//:overlay"])).logs).toContain("consumer-scoped virtual source mount")
    expect((await serve(root, ["//:downstream"])).logs).toContain("isolated remote checkout runner")
  })

  it("refuses outward rules before effects for missing secrets and approval", async () => {
    const root = await fixture()
    const missing = await serve(root, ["//:publishMissing", "--plan"])
    expect(missing.output).toContain("missing secret")
    const oldNpm = process.env["NPM_TOKEN"]
    process.env["NPM_TOKEN"] = "fixture-token"
    try {
      const approval = await serve(root, ["//:publishApproval", "--plan"])
      expect(approval.output).toContain("approval required")
    } finally {
      if (oldNpm === undefined) delete process.env["NPM_TOKEN"]
      else process.env["NPM_TOKEN"] = oldNpm
    }
    const oldGithub = process.env["GITHUB_TOKEN"]
    delete process.env["GITHUB_TOKEN"]
    try {
      expect((await serve(root, ["//:pages"])).logs).toContain("missing secret")
      expect((await serve(root, ["//:pr"])).logs).toContain("missing secret")
    } finally {
      if (oldGithub !== undefined) process.env["GITHUB_TOKEN"] = oldGithub
    }
  })
})
