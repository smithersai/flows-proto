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
  const path = NodePath.join(root, ...relative.split("/"))
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const marker = "tool-output-streams-here"

const workspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-stream-")))
  temporaryDirectories.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("stream", {
  repository: "git+https://example.invalid/stream.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [S.Rust.Toolchain({ channel: "1.91" })]
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const speak = S.Shell.Test({ command: "echo ${marker}" })
export const Package = S.Package({ targets: { speak } })
`
  )
  return root
}

/** Runs one target with the given environment overrides, returning what reached process.stdout. */
const runCapturing = async (root: string, environment: Record<string, string | undefined>): Promise<string> => {
  const saved: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(environment)) {
    saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  let streamed = ""
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    streamed += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stdout.write
  try {
    await makeCli({}).serve([...normalizeArgv(["//:speak", "--no-cache"]), "--workspace", root], {
      exit: () => undefined,
      stdout: () => undefined
    })
  } finally {
    process.stdout.write = write
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  return streamed
}

describe("tool output streaming", () => {
  it("streams a tool's stdout live when SMTHRS_STREAM=1", async () => {
    const root = await workspace()
    expect(await runCapturing(root, { SMTHRS_STREAM: "1", CI: undefined })).toContain(marker)
  })

  it("streams on a CI runner without being asked", async () => {
    const root = await workspace()
    expect(await runCapturing(root, { SMTHRS_STREAM: undefined, CI: "true" })).toContain(marker)
  })

  it("keeps a developer host quiet by default", async () => {
    const root = await workspace()
    expect(await runCapturing(root, { SMTHRS_STREAM: undefined, CI: undefined, SMTHRS_REPO_CHILD: undefined }))
      .not.toContain(marker)
  })
})
