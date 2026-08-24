/**
 * Checkpoints over a real repository, a real git, and a real process.
 *
 * `Checkpoints.test.ts` pins the argv and the relocation table against a
 * scripted spawner. It cannot say whether the thing works, because the whole of
 * the thing is git and a bind mount: a commit recorded without disturbing the
 * index, a detached worktree checked out *inside* the tree under test, a command
 * run in it through the path a container would use, and the checkout removed
 * afterwards with the live edit still standing.
 *
 * The container is a double rather than docker, and the double is the point: it
 * resolves `/testbed/...` to the workspace exactly as a bind mount does, so a
 * test that passes here is a test that the subpath — and only the subpath — is
 * what makes a checkpoint reachable from inside the container.
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Bash from "../src/Bash.ts"
import * as Checkpoints from "../src/Checkpoints.ts"
import * as Container from "../src/Container.ts"
import * as TestRunner from "../src/TestRunner.ts"

const git = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

/** A repository holding one file, at one commit. */
const repository = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flows-checkpoint-")))
  writeFileSync(join(root, "mod.py"), "value = 'pristine'\n")
  writeFileSync(join(root, "probe.sh"), "#!/bin/bash\ncat mod.py\n", { mode: 0o755 })
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "rig@localhost"])
  git(root, ["config", "user.name", "rig"])
  git(root, ["add", "-A"])
  git(root, ["commit", "-qm", "base"])
  return root
}

/**
 * A container whose mount is the workspace, resolved by rewriting the path.
 *
 * This is what `docker run -v "$WORK:/testbed"` does, minus docker: the
 * container's `/testbed` and the host's workspace are one directory under two
 * names. A scratch checkout under the workspace is therefore reachable from
 * inside at the same subpath, and one anywhere else on the host is not
 * reachable at all — which is the constraint that put `.flows-checkpoints`
 * inside the tree it belongs to.
 */
const mounted = (root: string): Container.Container =>
  Container.make({
    exec: (request) =>
      Effect.succeed({
        file: request.file,
        args: [
          "-c",
          `cd ${(request.cwd ?? "/testbed").replace(/^\/testbed/, root)} && ${request.args.slice(1).join(" ")}`
        ]
      })
  })

const services = (root: string) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Container.Container)(mounted(root))
  )

const store = (root: string, options: Partial<Checkpoints.GitOptions> = {}) =>
  Effect.provide(Checkpoints.makeGit({ root, ...options }), NodeServices.layer)

describe("Checkpoints over a real repository", () => {
  it("hands back the tree as it stood, while the live tree keeps the edit", async () => {
    const root = repository()
    // The tree the run opened on, recorded the way `snapshot-base.sh` records
    // it for a benchmark workspace.
    git(root, ["update-ref", TestRunner.captureBase, "HEAD"])
    // The agent's edit. This is the work a proof must not cost.
    writeFileSync(join(root, "mod.py"), "value = 'fixed'\n")

    const [pinned, base] = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      const snapshot = yield* checkpoints.capture("cp-0-1")
      expect(snapshot.ref).toBe(`${Checkpoints.refPrefix}/cp-0-1`)
      const held = yield* checkpoints.materialize(
        "cp-0-1",
        (found) => Effect.sync(() => readFileSync(join(found.host, "mod.py"), "utf8"))
      )
      const opening = yield* checkpoints.materialize(
        Checkpoints.baseId,
        (found) => Effect.sync(() => readFileSync(join(found.host, "mod.py"), "utf8"))
      )
      return [held, opening]
    }))

    // The checkpoint minted after the edit holds the edit; `ctx.base` holds the
    // tree the run opened on. Two trees, both readable, neither of them the one
    // the run is working in.
    expect(pinned).toBe("value = 'fixed'\n")
    expect(base).toBe("value = 'pristine'\n")

    // And the live tree is untouched by any of it. This is the assertion that
    // would have failed on the recorded `sympy__sympy-13878` run, where the
    // only way to read the pristine bytes was `git checkout --`.
    expect(readFileSync(join(root, "mod.py"), "utf8")).toBe("value = 'fixed'\n")
    expect(git(root, ["status", "--porcelain"])).toContain("M mod.py")
  }, 60_000)

  it("leaves the repository's own index exactly as it found it", async () => {
    // The agent runs git in this workspace and its `git diff` is the run's
    // evidence. A capture that staged anything would be the harness editing the
    // evidence while recording it.
    const root = repository()
    writeFileSync(join(root, "mod.py"), "value = 'fixed'\n")
    writeFileSync(join(root, "staged.py"), "x = 1\n")
    git(root, ["add", "staged.py"])
    const before = git(root, ["status", "--porcelain"])

    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      yield* checkpoints.capture("cp-0-0")
    }))

    expect(git(root, ["status", "--porcelain"])).toBe(before)
    expect(git(root, ["stash", "list"])).toBe("")
  }, 60_000)

  it("removes the checkout however the call ends", async () => {
    const root = repository()
    const scratch = join(root, Checkpoints.scratchDirectory, "cp-0-0")

    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      yield* checkpoints.capture("cp-0-0")
      return yield* checkpoints.materialize("cp-0-0", (found) =>
        Effect.sync(() => {
          expect(existsSync(join(found.host, "mod.py"))).toBe(true)
        }).pipe(Effect.andThen(Effect.fail("the call failed"))))
    })))

    expect(exit._tag).toBe("Failure")
    expect(existsSync(scratch)).toBe(false)
    expect(git(root, ["worktree", "list"])).not.toContain(Checkpoints.scratchDirectory)
  }, 60_000)

  it("runs a real command against the pinned tree, through the container's own path", async () => {
    const root = repository()
    git(root, ["update-ref", TestRunner.captureBase, "HEAD"])
    writeFileSync(join(root, "mod.py"), "value = 'fixed'\n")

    const [pinnedOutput, liveOutput] = await Effect.runPromise(
      Effect.gen(function*() {
        const checkpoints = yield* store(root, { cwd: "/testbed" })
        const call = { mode: "unhermetic", command: "bash probe.sh", container: "double" } as const
        const atBase = yield* checkpoints.materialize(Checkpoints.baseId, (found) => {
          const relocated = Checkpoints.relocate("bash", call, found)
          expect(relocated._tag).toBe("Relocated")
          // The container's name for the scratch checkout, which is the workspace
          // path with the mount's prefix on it.
          expect(relocated._tag === "Relocated" && relocated.input).toMatchObject({
            cwd: `/testbed/${Checkpoints.scratchDirectory}/${Checkpoints.baseId}`
          })
          return Bash.run(
            (relocated._tag === "Relocated" ? relocated.input : call) as Bash.Input
          )
        })
        const live = yield* Bash.run(call)
        return [atBase.stdout, live.stdout]
      }).pipe(Effect.provide(services(root)))
    )

    // One command, two trees, one frame. This is the whole shape the ruling
    // buys, running for real: the baseline reports the bytes the run opened on
    // while the edit stands in the working copy.
    expect(pinnedOutput?.trim()).toBe("value = 'pristine'")
    expect(liveOutput?.trim()).toBe("value = 'fixed'")
    expect(readFileSync(join(root, "mod.py"), "utf8")).toBe("value = 'fixed'\n")
  }, 60_000)

  it("refuses a checkpoint nothing ever pinned", async () => {
    const root = repository()
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      return yield* checkpoints.materialize("cp-9-9", () => Effect.void)
    })))

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("No checkpoint is stored under")
  }, 60_000)
})
