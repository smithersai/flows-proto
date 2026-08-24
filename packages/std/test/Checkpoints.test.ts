/**
 * The checkpoint store's two halves, against a scripted process.
 *
 * `CheckpointsFixture.test.ts` drives the git half against a real repository;
 * this file pins the argv it spawns, the shape it answers with, and the whole of
 * the relocation table — which is the part that decides what a checkpoint can be
 * pointed at, and is therefore the part a wrong answer would silently corrupt.
 */
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Option, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Checkpoints from "../src/Checkpoints.ts"

interface Response {
  readonly stdout?: string
  readonly exitCode?: number
}

/** Records every argv and answers each from a table keyed by a fragment. */
const host = (
  spawns: Array<ReadonlyArray<string>>,
  responses: ReadonlyArray<readonly [string, Response]>
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.sync(() => {
        const standard = command as ChildProcess.StandardCommand
        const argv = [standard.command, ...standard.args]
        spawns.push(argv)
        const line = argv.join(" ")
        const found = responses.find(([fragment]) => line.includes(fragment))?.[1] ?? {}
        const encode = (text: string) => Stream.make(new TextEncoder().encode(text))
        const stdout = encode(found.stdout ?? "")
        const stderr = encode("")
        return makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.succeed(ExitCode(found.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr,
          all: Stream.concat(stdout, stderr),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
  }))

const store = (
  spawns: Array<ReadonlyArray<string>>,
  responses: ReadonlyArray<readonly [string, Response]>,
  options: Checkpoints.GitOptions = { root: "/work/repo" }
) => Effect.provide(Checkpoints.makeGit(options), host(spawns, responses))

const failureOf = <A>(exit: Exit.Exit<A, unknown>) =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as { code?: string; message?: string } | undefined
    : undefined

const materialized: Checkpoints.Materialized = {
  id: "cp-0-1",
  host: "/work/repo/.flows-checkpoints/cp-0-1",
  guest: "/testbed/.flows-checkpoints/cp-0-1"
}

describe("Checkpoints.makeGit capture", () => {
  it("records the working tree without touching the index or the worktree", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["stash create", { stdout: "abc123\n" }]])
      return yield* checkpoints.capture("cp-0-1")
    }))

    // `stash create` and nothing else. `add`, `read-tree` and `write-tree` all
    // write the repository's index, and the agent's own `git diff` — the run's
    // evidence — is read off that index.
    //
    // And the commit is named in config, never with a ref: a ref is history,
    // and a checkpoint holds the agent's own edit.
    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo stash create flows checkpoint cp-0-1",
      "git -C /work/repo config --local flows-checkpoint.cp-0-1 abc123"
    ])
    expect(snapshot).toMatchObject({ id: "cp-0-1", ref: "abc123" })
  })

  it("takes HEAD when the working tree has nothing of its own to record", async () => {
    // `stash create` prints nothing for a clean tree. That is not an error and
    // must not be read as one: the tree IS the commit it is sitting on.
    const spawns: Array<ReadonlyArray<string>> = []
    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["stash create", { stdout: "" }],
        ["rev-parse", { stdout: "head999\n" }]
      ])
      return yield* checkpoints.capture("cp-1-0")
    }))

    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo stash create flows checkpoint cp-1-0",
      "git -C /work/repo rev-parse --verify --quiet HEAD^{commit}",
      "git -C /work/repo config --local flows-checkpoint.cp-1-0 head999"
    ])
    expect(snapshot.ref).toBe("head999")
  })

  it("refuses an id that could not safely become a ref or a directory", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [])
      return yield* checkpoints.capture("../../etc/passwd")
    })))

    expect(failureOf(exit)?.code).toBe("invalid_input")
    expect(spawns).toEqual([])
  })

  it("says so when git could not record the tree", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["stash create", { exitCode: 1 }]])
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)?.message).toContain("Could not record the working tree")
  })

  it("says so when git could not be spawned at all", async () => {
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* Effect.provide(
        Checkpoints.makeGit({ root: "/work/repo" }),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop())
      )
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)?.message).toContain("git could not run")
  })

  it("says so when the checkpoint could not be named", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["stash create", { stdout: "abc123\n" }],
        ["config --local flows-checkpoint", { exitCode: 1 }]
      ])
      return yield* checkpoints.capture("cp-0-0")
    })))

    expect(failureOf(exit)?.message).toContain("Could not name the checkpoint")
  })
})

describe("Checkpoints.makeGit materialize", () => {
  it("checks the tree out beside the repository and removes it however the call ends", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["config --local --get", { stdout: "abc123\n" }]])
      return yield* checkpoints.materialize("cp-0-1", (found) => Effect.succeed(found))
    }))

    expect(seen).toEqual({
      id: "cp-0-1",
      host: "/work/repo/.flows-checkpoints/cp-0-1",
      // No container declared, so the two names of the one directory are the
      // same name.
      guest: "/work/repo/.flows-checkpoints/cp-0-1"
    })
    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo config --local --get flows-checkpoint.cp-0-1",
      "git -C /work/repo worktree add --detach --force /work/repo/.flows-checkpoints/cp-0-1 abc123",
      "git -C /work/repo worktree remove --force /work/repo/.flows-checkpoints/cp-0-1"
    ])
  })

  it("removes the checkout when the call inside it fails", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["config --local --get", { stdout: "abc123\n" }]])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.fail("the call failed"))
    })))

    expect(Exit.isFailure(exit)).toBe(true)
    // A run killed at its wall-clock budget would otherwise leave a second
    // checkout of the whole repository inside the tree whose diff is its answer.
    expect(spawns.at(-1)?.join(" ")).toContain("worktree remove --force")
  })

  it("gives the container's name for the directory when the host declared one", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["config --local --get", { stdout: "abc123\n" }]], {
        root: "/work/repo",
        cwd: "/testbed"
      })
      return yield* checkpoints.materialize("cp-0-1", (found) => Effect.succeed(found))
    }))

    // One directory, two names: the host checks it out under the workspace, and
    // the container sees it at the same subpath under its bind mount. That is
    // the whole reason the scratch lives inside the workspace.
    expect(seen.host).toBe("/work/repo/.flows-checkpoints/cp-0-1")
    expect(seen.guest).toBe("/testbed/.flows-checkpoints/cp-0-1")
  })

  it("resolves the base id against the capture base, then HEAD", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["capture-base", { stdout: "base999\n" }]])
      return yield* checkpoints.materialize(Checkpoints.baseId, () => Effect.void)
    }))

    expect(spawns[0]?.join(" ")).toContain("refs/flows/capture-base^{commit}")
  })

  it("falls back to HEAD when no capture base was recorded", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [["HEAD^", { stdout: "head999\n" }]])
      return yield* checkpoints.materialize(Checkpoints.baseId, () => Effect.void)
    }))

    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo rev-parse --verify --quiet refs/flows/capture-base^{commit}",
      "git -C /work/repo rev-parse --verify --quiet HEAD^{commit}",
      "git -C /work/repo worktree add --detach --force /work/repo/.flows-checkpoints/base head999",
      "git -C /work/repo worktree remove --force /work/repo/.flows-checkpoints/base"
    ])
  })

  it("takes only the declared base ref when the host named one", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [], { root: "/work/repo", baseRef: "refs/flows/absent" })
      return yield* checkpoints.materialize(Checkpoints.baseId, () => Effect.void)
    })))

    // A declared ref that does not resolve is an error rather than a fallback:
    // a baseline against the wrong tree answers the question wrong, which is
    // worse than not answering it.
    expect(failureOf(exit)?.code).toBe("not_found")
    expect(spawns.map((argv) => argv.join(" "))).toEqual([
      "git -C /work/repo rev-parse --verify --quiet refs/flows/absent^{commit}"
    ])
  })

  it("refuses an id that could not safely become a directory", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [])
      return yield* checkpoints.materialize("../escape", () => Effect.void)
    })))

    expect(failureOf(exit)?.code).toBe("invalid_input")
    expect(spawns).toEqual([])
  })

  it("says so when the checkout itself failed", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(spawns, [
        ["config --local --get", { stdout: "abc123\n" }],
        ["worktree add", { exitCode: 128 }]
      ])
      return yield* checkpoints.materialize("cp-0-1", () => Effect.void)
    })))

    expect(failureOf(exit)?.message).toContain("Could not check out checkpoint cp-0-1")
  })
})

describe("Checkpoints.makeNoop", () => {
  it("says plainly that this host pins nothing", async () => {
    const noop = Checkpoints.makeNoop()
    const captured = await Effect.runPromise(Effect.exit(noop.capture("cp-0-0")))
    const held = await Effect.runPromise(Effect.exit(noop.materialize("cp-0-0", () => Effect.void)))

    expect(failureOf(captured)?.code).toBe("provider_unavailable")
    expect(failureOf(held)?.message).toContain("Take the reading on the live tree instead")
  })

  it("is provided as a layer, for a host with no version control at all", async () => {
    const exit = await Effect.runPromise(Effect.exit(
      Effect.gen(function*() {
        const checkpoints = yield* Checkpoints.Checkpoints
        return yield* checkpoints.capture("cp-0-0")
      }).pipe(Effect.provide(Checkpoints.layerNoop))
    ))

    expect(failureOf(exit)?.code).toBe("provider_unavailable")
  })

  it("is what the layer constructor builds, given a store", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const snapshot = await Effect.runPromise(
      Effect.gen(function*() {
        const checkpoints = yield* Checkpoints.Checkpoints
        return yield* checkpoints.capture("cp-0-0")
      }).pipe(
        Effect.provide(Checkpoints.layerGit({ root: "/work/repo" })),
        Effect.provide(host(spawns, [["stash create", { stdout: "abc123\n" }]]))
      )
    )

    expect(snapshot.id).toBe("cp-0-0")
  })

  it("builds a store from an implementation", async () => {
    const built = Checkpoints.make({
      capture: (id) => Effect.succeed(new Checkpoints.Snapshot({ id, ref: `custom/${id}` })),
      materialize: (id, use) => use({ id, host: `/h/${id}`, guest: `/g/${id}` })
    })

    expect((await Effect.runPromise(built.capture("x"))).ref).toBe("custom/x")
    expect(await Effect.runPromise(built.materialize("x", (found) => Effect.succeed(found.guest)))).toBe("/g/x")
  })
})

describe("Checkpoints.relocate", () => {
  it("points a shell call at the checkpoint's own directory", () => {
    expect(Checkpoints.relocate("bash", { mode: "unhermetic", command: "bin/test" }, materialized)).toEqual({
      _tag: "Relocated",
      input: { mode: "unhermetic", command: "bin/test", cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
    })
  })

  it("gives a containerised shell call the path the container will resolve", () => {
    // The container reaches the workspace through a mount, so it reaches the
    // scratch checkout at the same subpath under that mount. `bash` says which
    // side it is on by naming a container, so this reads the same field.
    expect(
      Checkpoints.relocate(
        "bash",
        { mode: "unhermetic", command: "bin/test", container: "swebench-1" },
        materialized
      )
    ).toEqual({
      _tag: "Relocated",
      input: {
        mode: "unhermetic",
        command: "bin/test",
        container: "swebench-1",
        cwd: "/testbed/.flows-checkpoints/cp-0-1"
      }
    })
  })

  it("overrides a cwd the caller supplied, because at is where the call runs", () => {
    expect(Checkpoints.relocate("bash", { command: "x", cwd: "/elsewhere" }, materialized)).toEqual({
      _tag: "Relocated",
      input: { command: "x", cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
    })
  })

  it("treats an empty container name as no container", () => {
    expect(Checkpoints.relocate("bash", { command: "x", container: "" }, materialized)).toMatchObject({
      input: { cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
    })
  })

  it("prefixes a reader's relative path with the checkpoint's directory", () => {
    // These flows resolve their subject against the workspace root, and the
    // checkpoint is a directory under it, so the prefix is workspace-relative.
    expect(Checkpoints.relocate("read", { path: "sympy/stats/crv_types.py" }, materialized)).toEqual({
      _tag: "Relocated",
      input: { path: ".flows-checkpoints/cp-0-1/sympy/stats/crv_types.py" }
    })
    expect(Checkpoints.relocate("ls", { path: "sympy" }, materialized)).toMatchObject({
      input: { path: ".flows-checkpoints/cp-0-1/sympy" }
    })
    expect(Checkpoints.relocate("grep", { pattern: "def _cdf", root: "sympy/stats" }, materialized)).toMatchObject({
      input: { pattern: "def _cdf", root: ".flows-checkpoints/cp-0-1/sympy/stats" }
    })
    expect(Checkpoints.relocate("glob", { pattern: "**/*.py", root: "sympy/" }, materialized)).toMatchObject({
      input: { pattern: "**/*.py", root: ".flows-checkpoints/cp-0-1/sympy" }
    })
  })

  it("takes the checkpoint's own directory when the reader names no root", () => {
    for (const named of [{}, { root: "" }, { root: "." }]) {
      expect(Checkpoints.relocate("grep", { pattern: "x", ...named }, materialized)).toMatchObject({
        input: { root: ".flows-checkpoints/cp-0-1" }
      })
    }
  })

  it("refuses an absolute path rather than guessing which prefix names the tree", () => {
    // An absolute path in these runs is a container path, and the host cannot
    // know which part of it is the repository.
    expect(Checkpoints.relocate("read", { path: "/testbed/a.py" }, materialized)).toEqual({
      _tag: "AbsolutePath",
      path: "/testbed/a.py"
    })
  })

  it("refuses a flow that names what it touches with something other than a path", () => {
    expect(Checkpoints.relocate("read", { path: 7 }, materialized)).toEqual({ _tag: "UnsupportedFlow" })
  })

  it("treats an input that is not an object as naming nothing, and takes the checkpoint itself", () => {
    expect(Checkpoints.relocate("read", "a.py", materialized)).toMatchObject({
      input: { path: ".flows-checkpoints/cp-0-1" }
    })
  })

  it("refuses every flow the table does not name, `test` included", () => {
    for (const flow of ["edit", "write", "apply_patch", "remember", "webfetch"]) {
      expect(Checkpoints.relocate(flow, {}, materialized)).toEqual({ _tag: "UnsupportedFlow" })
    }
    // `test` answers this exact question already, with `against: "base"`. Two
    // mechanisms pointed at one tree are two answers that can disagree.
    expect(Checkpoints.relocate("test", { selection: [] }, materialized)).toEqual({ _tag: "UnsupportedFlow" })
  })
})
