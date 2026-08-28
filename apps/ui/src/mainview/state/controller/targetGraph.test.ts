/*
 * The chat half of the target-graph cards (docs/LOCAL-APP.md "Cards: target
 * graph"): every command the human types — /target.graph, /target.timeline,
 * /target.history, /target.affected, /target.ci and the hidden replay acts —
 * runs through the ONE registry path and lands the right card kind, filled
 * from the routes in smithers-shared/TargetGraph TARGET_GRAPH_ROUTES. The
 * routes are stubbed here at the fetch seam with the captured force
 * fixtures; the backend lane implements them against the same contract.
 */
import type { StorageApi } from "@tanstack/db"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Repo } from "smithers-shared/LocalApp"
import type { RunReplayResponse } from "smithers-shared/TargetGraph"
import { TARGET_GRAPH_ROUTES } from "smithers-shared/TargetGraph"
import { fixtureRunEvents, fixtureTargetGraph } from "../../dev/fixtureRunStream"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import type { Card } from "../AppState"
import { replayAtCursor } from "./targetGraph"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: NativeAgent = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const REPO: Repo = {
  id: "force",
  path: "/tmp/force",
  name: "force",
  git: { branch: "main", remote: null },
  smithers: { detected: true, workspaceFile: null, declarationFiles: ["PACKAGE.ts"], reason: "declared" }
}

const GRAPH = fixtureTargetGraph("force")
const RUN_ID = "run-force-1"
const RUN_BASE = 1_700_000_000_000
const EVENTS = fixtureRunEvents(GRAPH, { runId: RUN_ID, root: "//:prePush", base: RUN_BASE })
const RUN_END = Math.max(...EVENTS.map((event) => ("at" in event ? event.at : 0)))
const SUMMARY = EVENTS.find((event) => event.type === "summary")
const REPLAY: RunReplayResponse = {
  run: {
    runId: RUN_ID,
    repoId: "force",
    label: "//:prePush",
    labels: ["//:prePush"],
    status: "failed",
    startedAt: RUN_BASE,
    endedAt: RUN_END,
    ...(SUMMARY?.type === "summary" ? { summary: SUMMARY.summary } : {})
  },
  events: [...EVENTS]
}

const AFFECTED = {
  repoId: "force",
  base: "HEAD",
  changedFiles: ["src/App.tsx"],
  affected: [{ label: "//src:typeCheck", reason: "src/App.tsx" }],
  durationMs: 42
}

const CI = {
  repoId: "force",
  workflows: [
    {
      name: "ci",
      path: ".github/workflows/ci.yml",
      yaml: "name: ci\n",
      jobs: [{ name: "check", targets: ["//src:typeCheck"], matrix: { shard: ["1/2", "2/2"] } }]
    }
  ],
  durationMs: 17
}

/* Every route answers its fixture; anything else is an honest 404. */
const stubRoutes = (): (() => void) => {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const answer = url.endsWith(TARGET_GRAPH_ROUTES.graph)
      ? GRAPH
      : url.endsWith(TARGET_GRAPH_ROUTES.runs)
      ? { repoId: "force", runs: [REPLAY.run] }
      : url.endsWith(TARGET_GRAPH_ROUTES.replay)
      ? REPLAY
      : url.endsWith(TARGET_GRAPH_ROUTES.affected)
      ? AFFECTED
      : url.endsWith(TARGET_GRAPH_ROUTES.ci)
      ? CI
      : undefined
    if (answer === undefined) return new Response("not found", { status: 404 })
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return () => {
    globalThis.fetch = real
  }
}

const freshController = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent)
  /* The commands resolve the one open repository, so open one. */
  store.dispatch({
    type: "card.upsert",
    actor: "user",
    card: {
      id: "repo-force",
      kind: "repo",
      title: "force",
      status: "acted",
      createdAt: 0,
      ordinal: 0,
      payload: { repo: REPO }
    }
  })
  return { store, controller }
}

const cardOf = (store: Awaited<ReturnType<typeof freshController>>["store"], id: string): Card | undefined =>
  store.collections.cards.get(id)

describe("the chat commands dispatch the target-graph cards", () => {
  let restore = () => {}
  beforeEach(() => {
    restore = stubRoutes()
  })
  afterEach(() => {
    restore()
  })

  test("/target.graph lands a graph card filled from the graph route", async () => {
    const { store, controller } = await freshController()
    expect((await controller.commands.run("target.graph")).status).toBe("executed")
    const card = cardOf(store, "graph-force")
    expect(card?.kind).toBe("graph")
    if (card?.kind !== "graph") throw new Error("expected a graph card")
    expect(card.payload.status).toBe("done")
    expect(card.payload.graph?.nodes.length).toBe(82)
    expect(card.payload.graph?.edges.length).toBe(94)
    expect(card.payload.focus).toBeUndefined()
  })

  test("/target.graph //src:typeCheck focuses the card on that label", async () => {
    const { store, controller } = await freshController()
    expect((await controller.commands.run("target.graph", "//src:typeCheck")).status).toBe("executed")
    const card = cardOf(store, "graph-force")
    if (card?.kind !== "graph") throw new Error("expected a graph card")
    expect(card.payload.focus).toBe("//src:typeCheck")
    /* And the drawer's dismissal clears it, so the drawer can actually close. */
    expect((await controller.commands.run("target.graph.focus", "force")).status).toBe("executed")
    const cleared = cardOf(store, "graph-force")
    if (cleared?.kind !== "graph") throw new Error("expected a graph card")
    expect(cleared.payload.focus).toBeUndefined()
  })

  test("/target.history lands the run table; selecting a row replays it into a timeline", async () => {
    const { store, controller } = await freshController()
    expect((await controller.commands.run("target.history")).status).toBe("executed")
    const history = cardOf(store, "run-history-force")
    if (history?.kind !== "run-history") throw new Error("expected a run-history card")
    expect(history.payload.status).toBe("done")
    expect(history.payload.runs.map((run) => run.runId)).toEqual([RUN_ID])

    expect((await controller.commands.run("target.runs.select", `force ${RUN_ID}`)).status).toBe("executed")
    const selected = cardOf(store, "run-history-force")
    if (selected?.kind !== "run-history") throw new Error("expected a run-history card")
    expect(selected.payload.selected).toBe(RUN_ID)

    const timeline = cardOf(store, `run-timeline-${RUN_ID}`)
    if (timeline?.kind !== "run-timeline") throw new Error("expected a run-timeline card")
    expect(timeline.payload.cursor).toBe(RUN_END)
    expect(timeline.payload.summary?.total).toBe(timeline.payload.nodes.length)
    /* Time travel paints the graph overlay too. */
    const graphAfter = cardOf(store, "graph-force")
    expect(graphAfter).toBeUndefined()
  })

  test("the scrubber replays deterministically into the timeline and the graph overlay", async () => {
    const { store, controller } = await freshController()
    expect((await controller.commands.run("target.graph")).status).toBe("executed")
    expect((await controller.commands.run("target.history")).status).toBe("executed")
    expect((await controller.commands.run("target.runs.select", `force ${RUN_ID}`)).status).toBe("executed")

    const midpoint = RUN_BASE + Math.round((RUN_END - RUN_BASE) / 2)
    expect((await controller.commands.run("target.run.scrub", `${RUN_ID} ${midpoint}`)).status).toBe("executed")
    const timeline = cardOf(store, `run-timeline-${RUN_ID}`)
    if (timeline?.kind !== "run-timeline") throw new Error("expected a run-timeline card")
    expect(timeline.payload.cursor).toBe(midpoint)
    /* The same fold the pure replay produces — no state the events did not carry. */
    const expected = replayAtCursor(EVENTS, midpoint)
    expect(timeline.payload.nodes.length).toBe(expected.nodes.length)
    expect(timeline.payload.nodes.length).toBeLessThan(EVENTS.filter((e) => e.type === "node").length)
    expect(timeline.payload.summary).toBeUndefined()

    const graph = cardOf(store, "graph-force")
    if (graph?.kind !== "graph") throw new Error("expected a graph card")
    expect(graph.payload.runId).toBe(RUN_ID)
    expect(graph.payload.run?.nodes.length).toBe(expected.nodes.length)

    /* Scrubbing back to the end restores the whole run — replay is a pure fold. */
    expect((await controller.commands.run("target.run.scrub", `${RUN_ID} ${RUN_END}`)).status).toBe("executed")
    const restored = cardOf(store, `run-timeline-${RUN_ID}`)
    if (restored?.kind !== "run-timeline") throw new Error("expected a run-timeline card")
    expect(restored.payload.summary?.total).toBe(restored.payload.nodes.length)
  })

  test("/target.affected and /target.ci land their cards from their routes", async () => {
    const { store, controller } = await freshController()
    expect((await controller.commands.run("target.affected")).status).toBe("executed")
    const affected = cardOf(store, "affected-force")
    if (affected?.kind !== "affected") throw new Error("expected an affected card")
    expect(affected.payload.status).toBe("done")
    expect(affected.payload.result?.affected[0]?.label).toBe("//src:typeCheck")

    expect((await controller.commands.run("target.ci")).status).toBe("executed")
    const ci = cardOf(store, "ci-force")
    if (ci?.kind !== "ci-matrix") throw new Error("expected a ci-matrix card")
    expect(ci.payload.status).toBe("done")
    expect(ci.payload.result?.workflows[0]?.jobs[0]?.name).toBe("check")
  })

  /*
   * No fake data in the product path (UI-COMMON "Rules"): a route that does
   * not answer leaves the card failed with the error, never a green state.
   */
  test("a route that refuses leaves the card failed, not green", async () => {
    restore()
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
    try {
      const { store, controller } = await freshController()
      await controller.commands.run("target.graph")
      const card = cardOf(store, "graph-force")
      if (card?.kind !== "graph") throw new Error("expected a graph card")
      expect(card.payload.status).toBe("failed")
      expect(card.status).toBe("error")
      expect(card.payload.graph).toBeUndefined()
    } finally {
      globalThis.fetch = real
    }
  })
})
