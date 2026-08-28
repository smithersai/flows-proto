import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { TargetGraphResponse } from "smithers-shared/TargetGraph"
import { reachable } from "smithers-shared/TargetGraph"
import type { Card } from "../state/AppState"
import { fixtureTargetGraph } from "../dev/fixtureRunStream"
import { criticalEdgeIds, focusFor, layoutTargetGraph, ruleFamily } from "./GraphCard"
import { GraphCardBody } from "./GraphCard"

/*
 * The graph card over the captured force fixture: 82 nodes, 94 edges; focus
 * highlights deps()/rdeps() and fades the rest; the drawer shows the plan
 * facts (and a refusal in red); the overlay paints node frames live.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const GRAPH: TargetGraphResponse = fixtureTargetGraph("force")

const card = (
  payload: Partial<Extract<Card, { kind: "graph" }>["payload"]>
): Extract<Card, { kind: "graph" }> => ({
  id: "graph-force",
  kind: "graph",
  title: "force graph",
  status: "acted",
  createdAt: 0,
  ordinal: 0,
  payload: { repoId: "force", repoName: "force", status: "done", graph: GRAPH, ...payload }
})

const render = (
  body: Extract<Card, { kind: "graph" }>,
  onRunCommand: (name: string, args?: string) => void = () => {}
): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<GraphCardBody card={body} onRunCommand={onRunCommand} />)
  })
  return host
}

describe("the fixture graph's layout", () => {
  test("the force fixture renders 82 nodes and 94 edges", () => {
    const laidOut = layoutTargetGraph(GRAPH, { showPrivate: true })
    expect(laidOut.nodes.length).toBe(82)
    expect(laidOut.edges.length).toBe(94)
  })

  test("private nodes drop out (with their edges) until asked for", () => {
    const withPrivate = layoutTargetGraph(GRAPH, { showPrivate: true })
    const without = layoutTargetGraph(GRAPH, { showPrivate: false })
    expect(without.nodes.length).toBe(withPrivate.nodes.filter((node) => !node.data.node.private).length)
  })

  test("focus highlights deps() ∪ rdeps() and fades the rest", () => {
    const focus = focusFor(GRAPH.edges, "//:prePush")
    const expected = new Set([
      ...reachable(GRAPH.edges, "//:prePush", "deps"),
      ...reachable(GRAPH.edges, "//:prePush", "rdeps"),
      "//:prePush"
    ])
    expect(focus.highlighted).toEqual(expected)
    const laidOut = layoutTargetGraph(GRAPH, { showPrivate: true, focus })
    for (const node of laidOut.nodes) {
      const state = node.data.focus
      if (node.id === "//:prePush") expect(state).toBe("root")
      else if (expected.has(node.id)) expect(state).toBe("highlighted")
      else expect(state).toBe("faded")
    }
  })

  test("edge kind styling: gates dashed, services dotted, deps thin, data solid", () => {
    const laidOut = layoutTargetGraph(GRAPH, { showPrivate: true })
    const gates = laidOut.edges.find((edge) => edge.data?.kind === "gates")
    const services = laidOut.edges.find((edge) => edge.data?.kind === "services")
    const data = laidOut.edges.find((edge) => edge.data?.kind === "data")
    expect(gates?.style?.strokeDasharray).toBe("7 4")
    expect(services?.style?.strokeDasharray).toBe("2 4")
    expect(data?.style?.strokeDasharray).toBeUndefined()
  })

  test("the critical path draws as a thick edge chain", () => {
    const path = ["//src:srcs", "//src:typeCheck", "//:prePush"]
    expect(criticalEdgeIds(path)).toEqual(new Set(["//src:typeCheck->//src:srcs", "//:prePush->//src:typeCheck"]))
    const laidOut = layoutTargetGraph(GRAPH, { showPrivate: true, criticalPath: path })
    const thick = laidOut.edges.filter((edge) => edge.data?.critical === true)
    expect(thick.length).toBe(2)
    expect(thick.every((edge) => edge.style?.strokeWidth === 3)).toBe(true)
  })

  test("the search filter keeps matching labels and the edges between them", () => {
    const laidOut = layoutTargetGraph(GRAPH, { showPrivate: true, filter: "typecheck" })
    expect(laidOut.nodes.map((node) => node.id)).toEqual(["//src:typeCheck"])
    expect(laidOut.edges.length).toBe(0)
  })

  test("rule families come off the loader's rule names", () => {
    expect(ruleFamily("Shell.Test")).toBe("Shell")
    expect(ruleFamily("Github.Workflow")).toBe("Github")
    expect(ruleFamily("Filegroup")).toBe("Filegroup")
  })
})

describe("the graph card over the fixture", () => {
  test("renders every node with its rule family and the counts line", () => {
    const host = render(card({}))
    expect(host.querySelector(".graph-card")).not.toBeNull()
    expect(host.textContent).toContain("82 targets · 94 edges")
    const nodes = host.querySelectorAll("[data-label]")
    expect(nodes.length).toBe(82)
    const typeCheck = host.querySelector("[data-label=\"//src:typeCheck\"]")
    expect(typeCheck?.getAttribute("data-rule-family")).toBe("Shell")
  })

  test("pending and failed stay honest", () => {
    const pending = render(card({ status: "pending", graph: undefined }))
    expect(pending.textContent).toContain("Loading the target graph…")
    const failed = render(card({ status: "failed", graph: undefined, error: "the CLI refused" }))
    expect(failed.textContent).toContain("the CLI refused")
  })

  test("the payload's focus opens the drawer with plan facts and argv", () => {
    const host = render(card({ focus: "//src:typeCheck" }))
    const drawer = host.querySelector("[data-testid=\"graph-drawer-//src:typeCheck\"]")
    expect(drawer).not.toBeNull()
    expect(drawer?.textContent).toContain("Shell.Test")
    expect(drawer?.textContent).toContain("execute")
    expect(drawer?.textContent).toContain("83972035")
    expect(drawer?.textContent).toContain("tsc")
    // Focus paints: the root and its deps highlighted, unrelated faded.
    const root = host.querySelector("[data-label=\"//src:typeCheck\"]")
    expect(root?.getAttribute("data-focus")).toBe("root")
    const rdep = host.querySelector("[data-label=\"//:prePush\"]")
    expect(rdep?.getAttribute("data-focus")).toBe("highlighted")
    const unrelated = host.querySelector("[data-label=\"//:hokusai\"]")
    expect(unrelated?.getAttribute("data-focus")).toBe("faded")
    const dep = host.querySelector("[data-label=\"//src:srcs\"]")
    expect(dep?.getAttribute("data-focus")).toBe("highlighted")
  })

  test("a refused node's drawer shows the refusal in red", () => {
    const graph: TargetGraphResponse = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((node) =>
        node.label === "//src:typeCheck"
          ? { ...node, plan: { ...node.plan, refusal: "host binary docker is not on PATH" } }
          : node
      )
    }
    const host = render(card({ graph, focus: "//src:typeCheck" }))
    const refusal = host.querySelector(".graph-drawer-refusal")
    expect(refusal?.textContent).toContain("host binary docker is not on PATH")
  })

  test("clicking a node focuses it; the drawer's Run dispatches target.run", () => {
    const ran: Array<string> = []
    const host = render(card({}), (name, args) => ran.push(`${name} ${args ?? ""}`))
    const node = host.querySelector("[data-label=\"//src:lint\"]")
    expect(node).not.toBeNull()
    flushSync(() => {
      node?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(node?.getAttribute("data-focus")).toBe("root")
    const run = host.querySelector(".graph-drawer-actions [data-flow=\"target.run\"]") as HTMLElement | null
    expect(run).not.toBeNull()
    flushSync(() => run?.click())
    expect(ran).toEqual(["target.run force //src:lint"])
  })

  test("the overlay paints node statuses, durations and hit badges from run frames", () => {
    const host = render(
      card({
        runId: "run-1",
        run: {
          nodes: [
            { label: "//src:typeCheck", status: "ran", startedAt: 0, endedAt: 4900, durationMs: 4900 },
            { label: "//src:srcs", status: "hit", startedAt: 0, endedAt: 0, durationMs: 0 },
            { label: "//src:lint", status: "running", startedAt: 0 },
            { label: "//src:test", status: "failed", startedAt: 0, endedAt: 1200, durationMs: 1200, reason: "exit 1" }
          ]
        }
      })
    )
    expect(host.querySelector(".graph-card-legend")).not.toBeNull()
    const typeCheck = host.querySelector("[data-label=\"//src:typeCheck\"]")
    expect(typeCheck?.getAttribute("data-run-status")).toBe("ran")
    expect(typeCheck?.textContent).toContain("4.9s")
    const srcs = host.querySelector("[data-label=\"//src:srcs\"]")
    expect(srcs?.getAttribute("data-run-status")).toBe("hit")
    expect(srcs?.textContent).toContain("hit")
    const test2 = host.querySelector("[data-label=\"//src:test\"]")
    expect(test2?.getAttribute("data-run-status")).toBe("failed")
  })

  test("the summary's critical path emphasizes its chain nodes", () => {
    const host = render(
      card({
        runId: "run-1",
        run: {
          nodes: [{ label: "//src:typeCheck", status: "ran", durationMs: 4900 }],
          summary: {
            total: 1,
            hit: 0,
            ran: 1,
            failed: 0,
            skipped: 0,
            durationMs: 4900,
            ok: true,
            criticalPath: ["//src:srcs", "//src:typeCheck"]
          }
        }
      })
    )
    expect(host.querySelector("[data-label=\"//src:srcs\"]")?.getAttribute("data-critical")).toBe("true")
    expect(host.querySelector("[data-label=\"//src:lint\"]")?.getAttribute("data-critical")).toBe("false")
  })
})
