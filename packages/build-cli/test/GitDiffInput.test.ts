import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"

const temporaryDirectories: Array<string> = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "smthrs",
      GIT_AUTHOR_EMAIL: "smthrs@example.invalid",
      GIT_COMMITTER_NAME: "smthrs",
      GIT_COMMITTER_EMAIL: "smthrs@example.invalid"
    }
  }).trim()

const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, ...relative.split("/"))
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

/**
 * A committed package-mode workspace whose one target keys on the working
 * tree's diff against HEAD.
 */
const workspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-git-diff-")))
  temporaryDirectories.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("diff-fixture", {
  repository: "git+https://example.invalid/diff.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [S.Rust.Toolchain({ channel: "1.91" })]
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const changed = S.Shell.Test({ command: "true", data: [S.gitDiff()] })
export const Package = S.Package({ targets: { changed } })
`
  )
  await write(root, "src/lib.ts", "export const one = 1\n")
  await write(root, ".gitignore", ".flows/\n")
  git(root, "init", "-q")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "init")
  return root
}

const serve = async (root: string, args: ReadonlyArray<string>): Promise<{ exitCode: number; output: string }> => {
  let exitCode = 0
  let output = ""
  const errWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
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
    process.stderr.write = errWrite
  }
  return { exitCode, output }
}

describe("gitDiff input expansion", () => {
  it("keys a changed submodule pointer without digesting the gitlink as a file", async () => {
    const root = await workspace()
    // A gitlink needs no object behind it: the index records the mode and the
    // commit id, which is exactly what a submodule bump changes.
    git(root, "update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,vendor/dep")
    git(root, "commit", "-q", "-m", "add submodule")
    git(root, "update-index", "--add", "--cacheinfo", "160000,2222222222222222222222222222222222222222,vendor/dep")
    await Fs.mkdir(NodePath.join(root, "vendor", "dep"), { recursive: true })
    await write(root, "src/lib.ts", "export const one = 2\n")
    const result = await serve(root, ["//:changed", "--plan"])
    expect(result.output).not.toContain("not a regular file")
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("//:changed")
  })

  it("still keys an ordinary file change", async () => {
    const root = await workspace()
    await write(root, "src/lib.ts", "export const one = 3\n")
    const result = await serve(root, ["//:changed", "--plan"])
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("//:changed")
  })
})
