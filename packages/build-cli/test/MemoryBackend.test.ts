import { Smithers as S } from "@smthrs/targets"
import type * as Target from "@smthrs/targets/Target"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as MemoryBackend from "../src/MemoryBackend.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const forceSpec = NodePath.resolve(import.meta.dirname, "fixtures/force-spec")

const openIndex = async (): Promise<PackageIndex> => {
  const discovery = await PackageDiscovery.discover(forceSpec)
  const loaded = await PackageLoader.load(discovery)
  return PackageIndex.make(loaded)
}

const temporaryRoot = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-memory-"))))

const retainTarget = (): Target.AnyTarget => S.Memory.Retain({ source: S.gitCommit("HEAD"), tags: ["commit", "unit"] })

const memory = S.Memory.SmithersCloud({ bank: ["repo"] })

const noCli: MemoryBackend.CliLocator = { find: async () => undefined }

const recordingCli = (): {
  readonly cli: MemoryBackend.MemoryCli
  readonly calls: Array<{ binary: string; args: ReadonlyArray<string>; cwd: string }>
} => {
  const calls: Array<{ binary: string; args: ReadonlyArray<string>; cwd: string }> = []
  return {
    calls,
    cli: {
      run: async (binary, args, cwd) => {
        calls.push({ binary, args, cwd })
        return { exitCode: 0, stdout: "retained\n", stderr: "" }
      }
    }
  }
}

describe("unavailable backend", () => {
  it("is a typed notice when the workspace declares no backend", async () => {
    await expect(MemoryBackend.retain({
      root: forceSpec,
      target: retainTarget(),
      memory: undefined,
      locator: noCli
    })).rejects.toMatchObject({
      name: "MemoryBackendUnavailable",
      code: "no_backend_declared"
    })
  })

  it("is a typed notice when the smithers CLI is not on PATH", async () => {
    const attempt = MemoryBackend.retain({
      root: forceSpec,
      target: retainTarget(),
      memory,
      locator: noCli
    })
    await expect(attempt).rejects.toMatchObject({
      name: "MemoryBackendUnavailable",
      code: "cli_not_found"
    })
    const error = await attempt.catch((cause) => cause)
    expect(MemoryBackend.isMemoryBackendUnavailable(error)).toBe(true)
    expect((error as Error).message).toContain("memory backend unavailable")
  })

  it("never spawns anything on either unavailable path", async () => {
    const { calls, cli } = recordingCli()
    await MemoryBackend.retain({
      root: forceSpec,
      target: retainTarget(),
      memory: undefined,
      locator: noCli,
      cli
    }).catch(() => undefined)
    await MemoryBackend.retain({
      root: forceSpec,
      target: retainTarget(),
      memory,
      locator: noCli,
      cli
    }).catch(() => undefined)
    expect(calls).toEqual([])
  })
})

describe("pathLocator", () => {
  it("finds an executable smithers on the configured PATH", async () => {
    const root = await temporaryRoot()
    const bin = NodePath.join(root, "bin")
    await Fs.mkdir(bin)
    const binary = NodePath.join(bin, "smithers")
    await Fs.writeFile(binary, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 })
    const locator = MemoryBackend.pathLocator({ PATH: `${NodePath.join(root, "empty")}${NodePath.delimiter}${bin}` })
    expect(await locator.find()).toBe(binary)
  })

  it("returns undefined when no directory on PATH carries one", async () => {
    const root = await temporaryRoot()
    const locator = MemoryBackend.pathLocator({ PATH: root })
    expect(await locator.find()).toBeUndefined()
  })

  it("returns undefined for an empty PATH", async () => {
    const locator = MemoryBackend.pathLocator({})
    expect(await locator.find()).toBeUndefined()
  })
})

describe("resolved backend", () => {
  it("shells out with the declared source, banks, and tags", async () => {
    const index = await openIndex()
    const [row] = index.resolve("//:retainCommit")
    const workspaceMemory = index.workspace.memory
    expect(workspaceMemory).toBeDefined()
    const { calls, cli } = recordingCli()
    const result = await MemoryBackend.retain({
      root: forceSpec,
      target: row!.target,
      memory: workspaceMemory,
      locator: { find: async () => "/opt/fake/smithers" },
      cli
    })
    expect(calls).toEqual([{
      binary: "/opt/fake/smithers",
      args: ["memory", "retain", "--source", "HEAD", "--bank", "repo", "--tag", "commit"],
      cwd: forceSpec
    }])
    expect(result).toEqual({
      binary: "/opt/fake/smithers",
      args: ["memory", "retain", "--source", "HEAD", "--bank", "repo", "--tag", "commit"],
      stdout: "retained\n"
    })
  })

  it("surfaces a nonzero backend exit as a typed command failure", async () => {
    const attempt = MemoryBackend.retain({
      root: forceSpec,
      target: retainTarget(),
      memory,
      locator: { find: async () => "/opt/fake/smithers" },
      cli: {
        run: async () => ({ exitCode: 3, stdout: "", stderr: "bank not found\n" })
      }
    })
    await expect(attempt).rejects.toMatchObject({
      name: "MemoryCommandFailed",
      exitCode: 3,
      stderr: "bank not found\n"
    })
    const error = await attempt.catch((cause) => cause)
    expect(MemoryBackend.isMemoryCommandFailed(error)).toBe(true)
  })

  it("spawns the resolved binary with no shell through the default runner", async () => {
    const root = await temporaryRoot()
    const binary = NodePath.join(root, "smithers")
    await Fs.writeFile(
      binary,
      "#!/bin/sh\nif [ \"$1\" = \"memory\" ]; then printf 'ok %s' \"$4\"; exit 0; fi\necho 'bad argv' >&2\nexit 9\n",
      { encoding: "utf8", mode: 0o755 }
    )
    const cli = MemoryBackend.spawnCli()
    const good = await cli.run(binary, ["memory", "retain", "--source", "HEAD"], root)
    expect(good).toEqual({ exitCode: 0, stdout: "ok HEAD", stderr: "" })
    const bad = await cli.run(binary, ["not-memory"], root)
    expect(bad.exitCode).toBe(9)
    expect(bad.stderr).toContain("bad argv")
  })

  it("refuses a non-Memory.Retain target before resolving anything", async () => {
    const commit = S.Git.Commit({ gates: [], message: "chore: wrong flavor" })
    await expect(MemoryBackend.retain({
      root: forceSpec,
      target: commit,
      memory,
      locator: noCli
    })).rejects.toThrow("expected a Memory.Retain target")
  })
})
