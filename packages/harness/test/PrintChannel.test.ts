/**
 * The print channel: budget sharing, honest notices, and compact structures.
 *
 * The cases here are the unit half of what `ReplRealm.test.ts` proves through a
 * real realm. They fix the two properties the r95repl lane says the channel was
 * missing — one long statement may spend the whole frame budget, and what it
 * loses is the middle rather than the tail — and the one property the change may
 * not break: a frame never delivers more than `Sandbox.printFrameBytes`.
 */
import type { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as elide from "../src/internal/elide.ts"
import * as printChannel from "../src/internal/printChannel.ts"
import * as Sandbox from "../src/Sandbox.ts"

const statement = (text: string): printChannel.Statement => ({ text, bytes: text.length })

const record = (file: string, line: number, text: string): Schema.Json => ({ file, line, text })

describe("printChannel.shares", () => {
  it("gives every statement what it needs when the budget covers them all", () => {
    expect(printChannel.shares([10, 20, 30], 1000)).toEqual([10, 20, 30])
  })

  it("hands a short statement's remainder to the long one", () => {
    // The whole point: 100 spent on the two short values leaves the rest for the
    // one that would otherwise have been cut to a quarter of the budget.
    expect(printChannel.shares([10, 4000, 20], 1000)).toEqual([10, 970, 20])
  })

  it("splits a budget no statement fits into evenly, oldest first on a tie", () => {
    expect(printChannel.shares([4000, 4000, 4000], 999)).toEqual([333, 333, 333])
  })

  it("apportions nothing across nothing", () => {
    expect(printChannel.shares([], 1000)).toEqual([])
  })
})

describe("printChannel.buffer", () => {
  it("is empty for a frame that printed nothing and lost nothing", () => {
    expect(printChannel.buffer([], 0)).toBe("")
  })

  it("leaves short statements exactly as they were", () => {
    expect(printChannel.buffer([statement("first"), statement("second")], 0)).toBe("first\nsecond")
  })

  it("elides one long statement from the middle and names the whole size", () => {
    const text = `HEAD${"x".repeat(Sandbox.printFrameBytes * 3)}TAIL`
    const out = printChannel.buffer([statement(text)], 0)
    expect(out.startsWith("HEAD")).toBe(true)
    expect(out.endsWith("TAIL")).toBe(true)
    expect(out).toContain(`of ${text.length} bytes elided from the middle`)
    expect(out).toContain(printChannel.recall)
  })

  it("never delivers more than one frame's budget", () => {
    for (
      const frame of [
        [statement("x".repeat(200_000))],
        Array.from({ length: 12 }, () => statement("y".repeat(4_095))),
        Array.from({ length: 400 }, (_, index) => statement(`line ${index} ${"z".repeat(index)}`))
      ]
    ) {
      expect(printChannel.buffer(frame, 0).length).toBeLessThanOrEqual(Sandbox.printFrameBytes)
    }
  })

  it("drops whole statements from the middle rather than cutting each to a notice", () => {
    const capacity = Math.floor(Sandbox.printFrameBytes / Sandbox.printStatementFloor)
    const out = printChannel.buffer(
      Array.from({ length: capacity + 5 }, (_, index) => statement(`line ${index}`)),
      0
    )
    expect(out).toContain("line 0")
    expect(out).toContain(`line ${capacity + 4}`)
    expect(out).toContain("5 print statements elided from the middle of this frame")
    expect(out).not.toContain(`line ${Math.ceil(capacity / 2)}\n`)
  })

  it("states the statements the host never copied out, with or without others", () => {
    expect(printChannel.buffer([statement("kept")], 3))
      .toBe("kept\n… 3 further print statements were not kept: this frame printed more than the harness holds.")
    expect(printChannel.buffer([], 2)).toContain("2 further print statements were not kept")
  })

  it("states both losses when a frame overran the count and the retention alike", () => {
    const capacity = Math.floor(Sandbox.printFrameBytes / Sandbox.printStatementFloor)
    const out = printChannel.buffer(
      Array.from({ length: capacity + 2 }, (_, index) => statement(`line ${index}`)),
      7
    )
    expect(out).toContain("2 print statements elided from the middle of this frame")
    expect(out).toContain("7 further print statements were not kept")
  })

  it("keeps the head and tail of a value the host had already reduced", () => {
    // What `printed` hands over for a value larger than a whole frame: the two
    // ends, with the size it had. The notice has to name the original, not the
    // part that survived the first reduction.
    const out = printChannel.buffer([{ text: `HEAD${"x".repeat(1000)}TAIL`, bytes: 900_000 }], 0)
    expect(out.startsWith("HEAD")).toBe(true)
    expect(out.endsWith("TAIL")).toBe(true)
    expect(out).toContain("of 900000 bytes elided from the middle")
  })
})

describe("printChannel.render", () => {
  it("renders an ordinary value as canonical JSON, and a string as itself", () => {
    expect(printChannel.render({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`)
    expect(printChannel.render([1, 2, 3])).toBe("[1,2,3]")
    expect(printChannel.render("plain")).toBe("plain")
    expect(printChannel.render(null)).toBe("null")
  })

  it("renders a list of identically-keyed records as a table with the keys named once", () => {
    const matches = [
      record("src/units/widen.ts", 42, "  return value"),
      record("src/units/widen.ts", 71, "  return value"),
      record("src/units/other.ts", 12, "  return value")
    ]
    expect(printChannel.render(matches)).toBe(
      "file | line | text\n" +
        "src/units/widen.ts | 42 |   return value\n" +
        "src/units/widen.ts | 71 |   return value\n" +
        "src/units/other.ts | 12 |   return value"
    )
  })

  it("renders the envelope around a single such member, with the count", () => {
    const found = {
      matches: [record("a.ts", 1, "one"), record("a.ts", 2, "two"), record("a.ts", 3, "three")],
      truncated: false
    }
    const shown = printChannel.render(found)
    expect(shown.split("\n")[0]).toBe(`{"truncated":false}`)
    expect(shown).toContain("matches (3):")
    expect(shown).toContain("file | line | text")
  })

  it("quotes a cell that would be ambiguous, and leaves the plain ones plain", () => {
    const rows = [
      { name: "plain", note: "no separator" },
      { name: "piped", note: "a | b" },
      { name: "lined", note: "one\ntwo" }
    ]
    const shown = printChannel.render(rows)
    expect(shown).toContain("plain | no separator")
    expect(shown).toContain(`piped | "a | b"`)
    expect(shown).toContain(`lined | "one\\ntwo"`)
  })

  it("is shorter than the JSON at the smallest shape it applies to", () => {
    // The claim the module makes instead of measuring both and picking: three
    // rows, two one-character keys, one-character values is the tightest case
    // the floor admits, and the table still wins by 20 bytes. Everything wider
    // widens the gap, so no case exists where this is the more expensive
    // rendering.
    const rows = [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }]
    expect(printChannel.render(rows)).toBe("a | b\n1 | 2\n3 | 4\n5 | 6")
    expect(printChannel.render(rows).length).toBe(`[{"a":1,"b":2},{"a":3,"b":4},{"a":5,"b":6}]`.length - 20)
    const wrapped = { rows, ok: true }
    expect(printChannel.render(wrapped).length).toBeLessThan(JSON.stringify(wrapped).length)
  })

  it("refuses a table for anything that is not a uniform list of records", () => {
    const wide = "w".repeat(80)
    // Too few rows, ragged keys, keys in a different order, a scalar element,
    // a single column, and a nested array of arrays: every one stays JSON.
    for (
      const value of [
        [record("a", 1, wide), record("b", 2, wide)],
        [record("a", 1, wide), { file: "b", line: 2 }, record("c", 3, wide)],
        [{ file: "a", line: 1, text: wide }, { line: 2, file: "b", text: wide }, record("c", 3, wide)],
        [record("a", 1, wide), "not a record", record("c", 3, wide)],
        [{ file: wide }, { file: wide }, { file: wide }],
        [[1, 2], [3, 4], [5, 6]]
      ] satisfies ReadonlyArray<Schema.Json>
    ) {
      expect(printChannel.render(value).startsWith("[")).toBe(true)
    }
  })

  it("refuses the envelope form when two members would both be tables", () => {
    const wide = "w".repeat(80)
    const rows = [record("a", 1, wide), record("b", 2, wide), record("c", 3, wide)]
    expect(printChannel.render({ first: rows, second: rows }).startsWith("{")).toBe(true)
  })
})

describe("elide.noticeCost", () => {
  it("bounds the notice a value of that size can produce", () => {
    const text = "q".repeat(5_000)
    const shortened = elide.middleFrom(text, text.length, 1_000, printChannel.recall)
    expect(shortened.length - 1_000).toBeLessThanOrEqual(elide.noticeCost(text.length, printChannel.recall))
  })

  it("costs nothing for a value there is nothing to say about", () => {
    expect(elide.noticeCost(0, printChannel.recall)).toBe(0)
  })
})
