import { z } from "zod"

/*
 * The target-graph contract between the local app's Bun backend
 * (`apps/ui/src/bun`) and the chat UI (`apps/ui/src/mainview`). It is the
 * product's API, not the CLI's: the backend maps `smthrs graph --format json`,
 * `smthrs <label> --plan --format json`, and a streamed `smthrs <label>` run
 * onto these shapes; the UI renders only these shapes.
 *
 * Everything a Bazel / Nx / Turborepo / Temporal operator expects to see is
 * expressed here once: the typed dependency DAG, per-node plan facts (rule,
 * key, cacheability, refusal, argv, sandbox), live per-node run status with
 * timings and cache hits, the run's critical path, run history for replay,
 * the diff-affected set, and the generated CI matrix.
 */

/** Edge kinds the loader classifies (`Concepts`: three edge kinds plus plain deps). */
export const GRAPH_EDGE_KINDS = ["data", "gates", "services", "deps"] as const
export const GraphEdgeKindSchema = z.enum(GRAPH_EDGE_KINDS)
export type GraphEdgeKind = z.infer<typeof GraphEdgeKindSchema>

/** One node of the target graph: the loader row plus the plan facts the backend could resolve. */
export const GraphNodeSchema = z.object({
  /** Canonical label, `//pkg/path:name`. */
  label: z.string(),
  package: z.string(),
  name: z.string(),
  /** Rule name as the loader prints it: `Shell.Test`, `Agent.Lint`, `Go.Binary`, ... */
  rule: z.string(),
  /** Flavor kinds (`build`, `test`, `lint`, `run`, `docs`); empty for pure data. */
  kinds: z.array(z.string()),
  /** Private (unlabeled) helper node reachable through an edge, e.g. `//src:__private_Overlay_4`. */
  private: z.boolean().default(false),
  /** Present when the backend planned the node (`--plan`). */
  plan: z
    .object({
      mode: z.enum(["execute", "check", "write"]).optional(),
      cacheable: z.boolean().optional(),
      /** Key preview (hex prefix); never a secret. */
      key: z.string().optional(),
      /** Typed refusal at plan time (host bin absent, approval required, missing input, NotImplemented). */
      refusal: z.string().optional(),
      argv: z.array(z.string()).optional(),
      sandbox: z.string().optional(),
      outDirs: z.array(z.string()).optional(),
      outFiles: z.array(z.string()).optional(),
      /** Input paths/globs when the CLI exposes them; used by affected analysis. */
      inputs: z.array(z.string()).optional()
    })
    .optional(),
  /** Declaration site for "open in editor". */
  source: z.object({ file: z.string(), line: z.number().optional() }).optional()
})
export type GraphNode = z.infer<typeof GraphNodeSchema>

export const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: GraphEdgeKindSchema
})
export type GraphEdge = z.infer<typeof GraphEdgeSchema>

/** `POST /api/targets/graph` `{ repoId, plan?: boolean, labels?: string[] }` */
export const TargetGraphResponseSchema = z.object({
  repoId: z.string(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  warnings: z.array(z.string()),
  /** ISO timestamp of the load; the UI shows staleness. */
  generatedAt: z.string(),
  durationMs: z.number()
})
export type TargetGraphResponse = z.infer<typeof TargetGraphResponseSchema>

/** Per-node run status as the executor reports it. */
export const NODE_RUN_STATUSES = ["pending", "running", "hit", "ran", "failed", "skipped", "refused", "cancelled"] as const
export const NodeRunStatusSchema = z.enum(NODE_RUN_STATUSES)
export type NodeRunStatus = z.infer<typeof NodeRunStatusSchema>

/** One node's timing row in a run (the Gantt row). */
export const NodeTimingSchema = z.object({
  label: z.string(),
  status: NodeRunStatusSchema,
  /** Epoch ms; absent until the node starts / settles. */
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  durationMs: z.number().optional(),
  key: z.string().optional(),
  /** Refusal or failure text, first line. */
  reason: z.string().optional(),
  exitCode: z.number().nullable().optional()
})
export type NodeTiming = z.infer<typeof NodeTimingSchema>

/** Run-level summary the executor prints at the end (`N targets: a hit, b ran, c failed, d skipped`). */
export const RunSummarySchema = z.object({
  total: z.number(),
  hit: z.number(),
  ran: z.number(),
  failed: z.number(),
  skipped: z.number(),
  durationMs: z.number(),
  ok: z.boolean(),
  /** Labels on the longest dependency chain by wall time, root last. */
  criticalPath: z.array(z.string())
})
export type RunSummary = z.infer<typeof RunSummarySchema>

/**
 * Frames on the WS topic `target-run:<runId>`. The first three are the
 * existing stdout/stderr/exit/error frames; `node` and `summary` are the
 * structured ones the graph overlay and the timeline consume. `stdout` and
 * `stderr` frames carry `label` when the backend can attribute the chunk.
 */
export const TargetRunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdout"), data: z.string(), label: z.string().optional() }),
  z.object({ type: z.literal("stderr"), data: z.string(), label: z.string().optional() }),
  z.object({ type: z.literal("exit"), code: z.number().nullable() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("started"), runId: z.string(), label: z.string(), at: z.number(), labels: z.array(z.string()) }),
  z.object({ type: z.literal("node"), node: NodeTimingSchema, at: z.number() }),
  z.object({ type: z.literal("summary"), summary: RunSummarySchema, at: z.number() })
])
export type TargetRunEvent = z.infer<typeof TargetRunEventSchema>

/** One recorded run, for history and replay. */
export const RunRecordSchema = z.object({
  runId: z.string(),
  repoId: z.string(),
  /** The root label(s) the user ran. */
  label: z.string(),
  labels: z.array(z.string()).default([]),
  status: z.enum(["pending", "running", "done", "failed", "cancelled"]),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  summary: RunSummarySchema.optional()
})
export type RunRecord = z.infer<typeof RunRecordSchema>

/** `POST /api/targets/runs` `{ repoId }` */
export const RunHistoryResponseSchema = z.object({ runs: z.array(RunRecordSchema) })
export type RunHistoryResponse = z.infer<typeof RunHistoryResponseSchema>

/** `POST /api/targets/runs/replay` `{ runId }` — every recorded frame in order, for the scrubber. */
export const RunReplayResponseSchema = z.object({
  run: RunRecordSchema,
  events: z.array(TargetRunEventSchema)
})
export type RunReplayResponse = z.infer<typeof RunReplayResponseSchema>

/** `POST /api/targets/affected` `{ repoId }` — what the working-tree diff re-keys. */
export const AffectedResponseSchema = z.object({
  repoId: z.string(),
  base: z.string(),
  changedFiles: z.array(z.string()),
  affected: z.array(
    z.object({
      label: z.string(),
      /** Why: the changed input(s) that reach the node, or "transitive via <label>". */
      reason: z.string()
    })
  ),
  /** Signals used by this conservative local approximation. */
  signal: z.string().optional(),
  /** Known blind spots in the available CLI/declaration information. */
  limits: z.array(z.string()).optional(),
  durationMs: z.number()
})
export type AffectedResponse = z.infer<typeof AffectedResponseSchema>

/** `POST /api/targets/ci` `{ repoId }` — the generated GitHub matrix, as the graph implies it. */
export const CiMatrixResponseSchema = z.object({
  repoId: z.string(),
  workflows: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      yaml: z.string(),
      /** Scratch-rendered when possible; on-disk is an explicit fallback. */
      source: z.enum(["scratch-render", "on-disk"]).optional(),
      jobs: z.array(
        z.object({
          name: z.string(),
          targets: z.array(z.string()),
          /** Shard fan-out or other matrix axes. */
          matrix: z.record(z.string(), z.array(z.string())).optional()
        })
      )
    })
  ),
  warnings: z.array(z.string()).optional(),
  durationMs: z.number()
})
export type CiMatrixResponse = z.infer<typeof CiMatrixResponseSchema>

/*
 * Card payloads (the chat surface). Cards.ts adds one `kind` per payload:
 * `graph`, `run-timeline`, `run-history`, `affected`, `ci-matrix`.
 */
export const GraphCardPayloadSchema = z.object({
  repoId: z.string(),
  repoName: z.string(),
  status: z.enum(["pending", "done", "failed"]),
  graph: TargetGraphResponseSchema.optional(),
  error: z.string().optional(),
  /** Focused label: the UI highlights deps()/rdeps() and opens the detail drawer. */
  focus: z.string().optional(),
  /** When set, the DAG overlays this run's node statuses. */
  runId: z.string().optional()
})
export type GraphCardPayload = z.infer<typeof GraphCardPayloadSchema>

export const RunTimelineCardPayloadSchema = z.object({
  repoId: z.string(),
  runId: z.string(),
  label: z.string(),
  status: RunRecordSchema.shape.status,
  nodes: z.array(NodeTimingSchema),
  summary: RunSummarySchema.optional(),
  /** Replay position (epoch ms) when scrubbing a recorded run; absent = live. */
  cursor: z.number().optional()
})
export type RunTimelineCardPayload = z.infer<typeof RunTimelineCardPayloadSchema>

export const RunHistoryCardPayloadSchema = z.object({
  repoId: z.string(),
  status: z.enum(["pending", "done", "failed"]),
  runs: z.array(RunRecordSchema),
  selected: z.string().optional()
})
export type RunHistoryCardPayload = z.infer<typeof RunHistoryCardPayloadSchema>

export const AffectedCardPayloadSchema = z.object({
  repoId: z.string(),
  status: z.enum(["pending", "done", "failed"]),
  result: AffectedResponseSchema.optional(),
  error: z.string().optional()
})
export type AffectedCardPayload = z.infer<typeof AffectedCardPayloadSchema>

export const CiMatrixCardPayloadSchema = z.object({
  repoId: z.string(),
  status: z.enum(["pending", "done", "failed"]),
  result: CiMatrixResponseSchema.optional(),
  error: z.string().optional()
})
export type CiMatrixCardPayload = z.infer<typeof CiMatrixCardPayloadSchema>

/** Routes this contract adds to the local server (LOCAL-APP.md "Targets: graph and runs"). */
export const TARGET_GRAPH_ROUTES = {
  graph: "/api/targets/graph",
  runs: "/api/targets/runs",
  replay: "/api/targets/runs/replay",
  affected: "/api/targets/affected",
  ci: "/api/targets/ci"
} as const

/** Labels reachable from `label` along the given direction (deps = outgoing, rdeps = incoming). */
export const reachable = (
  edges: ReadonlyArray<GraphEdge>,
  label: string,
  direction: "deps" | "rdeps"
): ReadonlySet<string> => {
  const next = new Map<string, Array<string>>()
  for (const edge of edges) {
    const [key, value] = direction === "deps" ? [edge.from, edge.to] : [edge.to, edge.from]
    const list = next.get(key)
    if (list === undefined) next.set(key, [value])
    else list.push(value)
  }
  const seen = new Set<string>()
  const stack = [label]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const neighbour of next.get(current) ?? []) {
      if (!seen.has(neighbour)) {
        seen.add(neighbour)
        stack.push(neighbour)
      }
    }
  }
  return seen
}

/**
 * The critical path of a settled run: the dependency chain whose summed
 * node durations is longest, root last. Nodes without timings count as 0.
 * Pure, so the backend computes it for `summary` and the UI can recompute
 * it for a replay cursor.
 */
export const criticalPath = (
  nodes: ReadonlyArray<NodeTiming>,
  edges: ReadonlyArray<GraphEdge>
): ReadonlyArray<string> => {
  const duration = new Map<string, number>()
  for (const node of nodes) duration.set(node.label, node.durationMs ?? 0)
  const deps = new Map<string, Array<string>>()
  for (const edge of edges) {
    if (!duration.has(edge.from) || !duration.has(edge.to)) continue
    const list = deps.get(edge.from)
    if (list === undefined) deps.set(edge.from, [edge.to])
    else list.push(edge.to)
  }
  const best = new Map<string, { total: number; via: string | undefined }>()
  const visiting = new Set<string>()
  const solve = (label: string): number => {
    const known = best.get(label)
    if (known !== undefined) return known.total
    if (visiting.has(label)) return 0
    visiting.add(label)
    let via: string | undefined
    let longest = 0
    for (const dep of deps.get(label) ?? []) {
      const total = solve(dep)
      if (total > longest || (via === undefined && total === longest && total > 0)) {
        longest = total
        via = dep
      }
    }
    visiting.delete(label)
    const total = longest + (duration.get(label) ?? 0)
    best.set(label, { total, via })
    return total
  }
  let root: string | undefined
  let rootTotal = -1
  for (const node of nodes) {
    const total = solve(node.label)
    if (total > rootTotal) {
      rootTotal = total
      root = node.label
    }
  }
  const path: Array<string> = []
  let cursor = root
  while (cursor !== undefined) {
    path.push(cursor)
    cursor = best.get(cursor)?.via
  }
  return path.reverse()
}
