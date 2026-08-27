import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTargetRunHistory } from "./TargetRunHistory"
import type { TargetRun } from "./Targets"

test("run history persists and reloads ordered events", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  const run: TargetRun = { runId: "run-1", repoId: "repo-1", repo, label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
  const history = createTargetRunHistory()
  await history.start(run)
  history.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: 100 })
  history.event(run, { type: "node", node: { label: "//:test", status: "ran", durationMs: 10 }, at: 110 })
  history.event(run, { type: "summary", summary: { total: 1, hit: 0, ran: 1, failed: 0, skipped: 0, durationMs: 10, ok: true, criticalPath: ["//:test"] }, at: 110 })
  history.event(run, { type: "exit", code: 0 })
  expect((await history.list("repo-1", repo))[0]).toMatchObject({ runId: "run-1", status: "done", exitCode: 0 })

  const reloaded = createTargetRunHistory()
  const listed = await reloaded.list("repo-1", repo)
  expect(listed).toHaveLength(1)
  const replay = await reloaded.replay("run-1")
  expect(replay?.events.map((event) => event.type)).toEqual(["started", "node", "summary", "exit"])
  expect(replay?.run.summary?.criticalPath).toEqual(["//:test"])
  await rm(repo, { recursive: true, force: true })
})
