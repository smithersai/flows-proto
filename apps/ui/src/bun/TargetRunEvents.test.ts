import { describe, expect, test } from "bun:test"
import { createRunStdoutParser } from "./Targets"

describe("run stdout parser", () => {
  test("parses every status, reasons, keys, summary, and ignores interleaved stderr", () => {
    const parser = createRunStdoutParser({ startedAt: 1_000, edges: [{ from: "//:root", to: "//:dep", kind: "data" }] })
    expect(parser.push("stdout", "//:dep  pending\n//:dep  running key=abc\n", 1_100)).toHaveLength(2)
    expect(parser.push("stderr", "//:noise failed 2ms\n", 1_101)).toEqual([])
    const events = parser.push("stdout", [
      "//:dep hit 20ms key=abc",
      "//:root ran 50ms",
      "//:bad failed 3ms compiler exploded",
      "//:skip skipped 1ms dependency failed",
      "//:no refused 2ms approval required",
      "//:cancel cancelled 1ms",
      "6 targets: 1 hit, 1 ran, 1 failed, 1 skipped, 1 refused (75ms)",
      ""
    ].join("\n"), 1_200)
    const nodes = events.filter((event) => event.type === "node").map((event) => event.node)
    expect(nodes.map((node) => node.status)).toEqual(["hit", "ran", "failed", "skipped", "refused", "cancelled"])
    expect(nodes.find((node) => node.status === "failed")?.reason).toBe("compiler exploded")
    expect(events.find((event) => event.type === "summary" && event.summary.total === 6)).toBeDefined()
  })

  test("computes the critical path from graph edges and fixture timings", () => {
    const parser = createRunStdoutParser({ startedAt: 0, edges: [
      { from: "//:root", to: "//:slow", kind: "data" },
      { from: "//:root", to: "//:fast", kind: "data" }
    ] })
    const events = parser.push("stdout", "//:slow ran 90ms\n//:fast hit 5ms\n//:root ran 10ms\n3 targets: 1 hit, 2 ran (100ms)\n", 100)
    const summary = events.find((event) => event.type === "summary")
    expect(summary?.type === "summary" ? summary.summary.criticalPath : []).toEqual(["//:slow", "//:root"])
  })
})
