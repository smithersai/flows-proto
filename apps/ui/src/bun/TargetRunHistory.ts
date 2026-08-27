import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { RunRecordSchema, TargetRunEventSchema } from "smithers-shared/TargetGraph"
import type { RunRecord, RunReplayResponse, TargetRunEvent } from "smithers-shared/TargetGraph"
import type { TargetRun } from "./Targets"

type HistoryLine = { readonly type: "record"; readonly record: RunRecord } | { readonly type: "event"; readonly event: TargetRunEvent }

interface StoredRun {
  record: RunRecord
  readonly events: Array<TargetRunEvent>
  readonly path: string
  queue: Promise<void>
}

export interface TargetRunHistory {
  readonly start: (run: TargetRun) => Promise<void>
  readonly event: (run: TargetRun, event: TargetRunEvent) => void
  readonly list: (repoId: string, repo: string) => Promise<ReadonlyArray<RunRecord>>
  readonly replay: (runId: string, repos?: ReadonlyArray<{ readonly id: string; readonly path: string }>) => Promise<RunReplayResponse | undefined>
}

const runsDir = (repo: string): string => join(repo, ".flows", "ui", "runs")
const encode = (line: HistoryLine): string => `${JSON.stringify(line)}\n`

export const createTargetRunHistory = (): TargetRunHistory => {
  const runs = new Map<string, StoredRun>()
  const loadedRepos = new Set<string>()

  const loadRepo = async (repoId: string, repo: string): Promise<void> => {
    if (loadedRepos.has(repo)) return
    loadedRepos.add(repo)
    const dir = runsDir(repo)
    let names: Array<string>
    try { names = await readdir(dir) } catch { return }
    await Promise.all(names.filter((name) => name.endsWith(".jsonl")).map(async (name) => {
      const path = join(dir, name)
      let text: string
      try { text = await readFile(path, "utf8") } catch { return }
      let record: RunRecord | undefined
      const events: Array<TargetRunEvent> = []
      for (const line of text.split(/\r?\n/)) {
        if (line === "") continue
        try {
          const parsed = JSON.parse(line) as { type?: unknown; record?: unknown; event?: unknown }
          if (parsed.type === "record") {
            const checked = RunRecordSchema.safeParse(parsed.record)
            if (checked.success && checked.data.repoId === repoId) record = checked.data
          } else if (parsed.type === "event") {
            const checked = TargetRunEventSchema.safeParse(parsed.event)
            if (checked.success) events.push(checked.data)
          }
        } catch { /* A partial final line after a crash is ignored. */ }
      }
      if (record !== undefined) runs.set(record.runId, { record, events, path, queue: Promise.resolve() })
    }))
  }

  return {
    start: async (run) => {
      const dir = runsDir(run.repo)
      await mkdir(dir, { recursive: true })
      const record: RunRecord = {
        runId: run.runId, repoId: run.repoId, label: run.label, labels: [...run.labels], status: "pending", startedAt: run.startedAt
      }
      const path = join(dir, `${run.runId}.jsonl`)
      await writeFile(path, encode({ type: "record", record }))
      runs.set(run.runId, { record, events: [], path, queue: Promise.resolve() })
      loadedRepos.add(run.repo)
    },
    event: (run, event) => {
      const stored = runs.get(run.runId)
      if (stored === undefined) return
      stored.events.push(event)
      if (event.type === "started") stored.record = { ...stored.record, status: "running" }
      else if (event.type === "summary") stored.record = { ...stored.record, summary: event.summary }
      else if (event.type === "exit") stored.record = {
        ...stored.record,
        status: event.code === 0 ? "done" : "failed",
        endedAt: Date.now(),
        exitCode: event.code
      }
      const line = encode({ type: "event", event }) + (event.type === "exit" ? encode({ type: "record", record: stored.record }) : "")
      stored.queue = stored.queue.then(() => appendFile(stored.path, line)).catch(() => {})
    },
    list: async (repoId, repo) => {
      await loadRepo(repoId, repo)
      const selected = [...runs.values()].filter((stored) => stored.record.repoId === repoId)
      await Promise.all(selected.map((stored) => stored.queue))
      return selected.map((stored) => stored.record).sort((a, b) => b.startedAt - a.startedAt)
    },
    replay: async (runId, repos = []) => {
      for (const repo of repos) await loadRepo(repo.id, repo.path)
      const stored = runs.get(runId)
      if (stored === undefined) return undefined
      await stored.queue
      return { run: stored.record, events: [...stored.events] }
    }
  }
}
