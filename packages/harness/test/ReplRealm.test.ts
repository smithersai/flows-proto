/**
 * The persistent realm: one QuickJS context for a whole run.
 *
 * These cases fix what the REPL mode promises the model — declarations survive
 * into the next cell, a throw leaves the names it had already bound, printing is
 * the channel to the next turn, and the transition is a call rather than a
 * return.
 */
import { Effect, Exit, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as CellValidation from "../src/CellValidation.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.ts"
import type * as VariablesPanel from "../src/VariablesPanel.ts"

const projection = (name: string): Cell.FlowProjection =>
  new Cell.FlowProjection({
    name,
    description: `The ${name} flow.`,
    capabilities: [],
    tier: "sealed",
    placement: Option.none(),
    input: Option.none()
  })

const flows = { echo: projection("echo") }

const succeeds: Sandbox.Handler = (invocation) =>
  Effect.succeed(new Cell.CallResult({ outcome: "success", value: { seen: invocation.input } }))

/** Runs a sequence of cells against one realm and reports every frame. */
const session = (
  cells: ReadonlyArray<string>,
  options: {
    readonly limits?: Sandbox.Limits | undefined
    readonly call?: Sandbox.Handler | undefined
  } = {}
): Promise<ReadonlyArray<Sandbox.RealmFrame>> =>
  Effect.gen(function*() {
    const sandbox = yield* QuickJSSandbox.make
    const open = sandbox.openRealm
    expect(open).toBeDefined()
    const realm = yield* open!({ flows, limits: options.limits })
    const frames: Array<Sandbox.RealmFrame> = []
    for (const [index, text] of cells.entries()) {
      frames.push(
        yield* realm.evaluate({
          cell: Cell.source(text),
          frame: index,
          call: options.call ?? succeeds
        })
      )
    }
    return frames
  }).pipe(Effect.scoped, Effect.runPromise)

const named = (bindings: ReadonlyArray<VariablesPanel.Binding>, name: string): VariablesPanel.Binding | undefined =>
  bindings.find((binding) => binding.name === name)

describe("QuickJSSandbox.openRealm", () => {
  it("keeps a cell's top-level declarations bound in the next cell", async () => {
    const frames = await session([
      "const kept = 41\nlet counter = 1",
      "counter = counter + kept\nconsole.log(counter)"
    ])
    expect(frames[1]!.prints).toBe("42")
    expect(named(frames[1]!.bindings, "kept")).toEqual({ name: "kept", type: "number", size: "41" })
  })

  it("lets a later cell re-declare a name instead of dying on a redeclaration", async () => {
    const frames = await session([
      "const result = 1",
      "const result = 2\nconsole.log(result)"
    ])
    expect(frames[1]!.outcome._tag).toBe("settled")
    expect(frames[1]!.prints).toBe("2")
  })

  it("clears a name re-declared without an initializer", async () => {
    const frames = await session([
      "let held = 'first'",
      "let held\nconsole.log(String(held))"
    ])
    expect(frames[1]!.prints).toBe("undefined")
    expect(named(frames[1]!.bindings, "held")).toEqual({ name: "held", type: "unset", size: "" })
  })

  it("binds a top-level class as a redeclarable name", async () => {
    const frames = await session([
      "class Widget { constructor(size) { this.size = size } }",
      "const made = new Widget(3)\nconsole.log(made.size)"
    ])
    expect(frames[1]!.prints).toBe("3")
    expect(named(frames[1]!.bindings, "Widget")?.type).toBe("function")
  })

  it("keeps the names a cell bound before it threw, and lets the next cell carry on", async () => {
    const frames = await session([
      "const before = 'kept'\nthrow new Error('stop')\nconst after = 'never'",
      "console.log(before, typeof after)"
    ])
    expect(frames[0]!.outcome._tag).toBe("raised")
    expect(named(frames[0]!.bindings, "before")).toEqual({ name: "before", type: "string", size: "4 chars" })
    expect(named(frames[0]!.bindings, "after")).toEqual({ name: "after", type: "unset", size: "" })
    expect(frames[1]!.prints).toBe("kept undefined")
  })

  it("renders a printed structure as JSON rather than as [object Object]", async () => {
    const frames = await session(["console.log('Source:', { b: 2, a: 1 })"])
    expect(frames[0]!.prints).toBe(`Source: {"a":1,"b":2}`)
  })

  it("prints functions, symbols and undefined as themselves", async () => {
    const frames = await session([
      "console.info(undefined)\nconsole.warn(function named() {})\nconsole.error(Symbol('tag'))"
    ])
    expect(frames[0]!.prints.split("\n")[0]).toBe("undefined")
    expect(frames[0]!.prints.split("\n")[2]).toBe("Symbol(tag)")
  })

  it("bounds one print statement and names the recall as the variable", async () => {
    const frames = await session([
      `const wide = "x".repeat(${Sandbox.printStatementBytes + 100})\nconsole.log(wide)`
    ])
    expect(frames[0]!.prints).toContain("still bound in the realm")
    expect(frames[0]!.prints.length).toBeLessThan(Sandbox.printStatementBytes + 200)
  })

  it("bounds a whole frame's print buffer from the middle", async () => {
    const frames = await session([
      `for (let index = 0; index < 12; index++) console.log("y".repeat(${Sandbox.printStatementBytes - 1}))`
    ])
    expect(frames[0]!.prints).toContain("elided from the middle")
  })

  it("resolves a flow call and hands the result back inside the same cell", async () => {
    const frames = await session([
      "const answer = await ctx.call('echo', { ask: 1 })\nconsole.log(answer)"
    ])
    expect(frames[0]!.prints).toBe(`{"seen":{"ask":1}}`)
  })

  it("settles a completion from ctx.done", async () => {
    const frames = await session(["ctx.done('the check passes')"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag).toBe("settled")
    expect(outcome._tag === "settled" && outcome.transition._tag).toBe("complete")
    expect(outcome._tag === "settled" && outcome.transition._tag === "complete" && outcome.transition.output)
      .toBe("the check passes")
  })

  it("lets the last intent call win", async () => {
    const frames = await session(["ctx.done('first')\nctx.done('second')"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "settled" && outcome.transition._tag === "complete" && outcome.transition.output)
      .toBe("second")
  })

  it("settles a park from ctx.park", async () => {
    const frames = await session(["ctx.park('waiting-input', 'which branch?')"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "settled" && outcome.transition._tag).toBe("park")
  })

  it("refuses a park whose reason is not one of the three", async () => {
    const frames = await session(["ctx.park('tea-break', 'later')"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag).toBe("rejected")
    expect(outcome._tag === "rejected" && outcome.message).toContain("waiting-input")
  })

  it("carries a justification on the continue a quiet cell settles", async () => {
    const frames = await session(["ctx.justify('the failing assertion is still unread')"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "settled" && outcome.transition._tag === "continue" && outcome.transition.justification)
      .toBe("the failing assertion is still unread")
  })

  it("ends a turn when a cell calls nothing", async () => {
    const frames = await session(["const noted = 1"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "settled" && outcome.transition._tag).toBe("continue")
  })

  it("refuses a top-level return in the frame that wrote it", async () => {
    const frames = await session(["return { intent: 'continue' }"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag).toBe("rejected")
    expect(outcome._tag === "rejected" && outcome.message).toContain("ctx.done")
  })

  it("refuses a non-serializable completion output by name", async () => {
    const frames = await session(["ctx.done(function () {})"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag).toBe("raised")
    expect(outcome._tag === "raised" && outcome.message).toContain("ctx.done output")
  })

  it("charges each frame its own step budget and survives spending one", async () => {
    const frames = await session([
      "let spun = 0\nwhile (spun < 5000000) spun = spun + 1",
      "console.log('still here')"
    ], { limits: { steps: 200 } })
    expect(frames[0]!.outcome._tag).toBe("rejected")
    expect(frames[1]!.prints).toBe("still here")
  })

  it("keeps the realm alive after a heap exhaustion and frees it by assignment", async () => {
    const frames = await session([
      "var big = []\ntry { while (true) big.push('x'.repeat(1024)) } catch (error) { console.log(error.name) }",
      "big = null\nconsole.log('recovered')"
    ], { limits: { memoryBytes: 4 * 1024 * 1024 } })
    expect(frames[0]!.prints).toContain("Error")
    expect(frames[1]!.prints).toBe("recovered")
  })

  it("reports a cell that awaits something the realm can never settle", async () => {
    const frames = await session(["await new Promise(function () {})"])
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "rejected" && outcome.code).toBe("stalled")
  })

  it("refuses a cell the boundary parse rejects without touching the realm", async () => {
    const frames = await session(["const broken = (", "console.log('unharmed')"])
    expect(frames[0]!.outcome._tag).toBe("rejected")
    expect(frames[1]!.prints).toBe("unharmed")
  })

  it("stops a cell at its flow-call ceiling", async () => {
    const frames = await session([
      "await ctx.call('echo', { n: 1 })\nawait ctx.call('echo', { n: 2 })"
    ], { limits: { calls: 1 } })
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "rejected" && outcome.code).toBe("limit_exceeded")
  })

  it("gives up the frame at the whole-evaluation ceiling", async () => {
    const frames = await session(["await ctx.call('echo', { slow: true })"], {
      limits: { totalMs: 10, callMs: 5000 },
      call: () => Effect.never
    })
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "rejected" && outcome.code).toBe("limit_exceeded")
  })

  it("hands a failed call back as a value the cell can branch on", async () => {
    const frames = await session(["const got = await ctx.call('echo', {})\nconsole.log(got.ok, got.error.code)"], {
      call: () =>
        Effect.succeed(
          new Cell.CallResult({ outcome: "failure", value: null, code: "unknown_flow", message: "no such flow" })
        )
    })
    expect(frames[0]!.prints).toBe("false unknown_flow")
  })

  it("leaves an inner const scoped to its block", async () => {
    const frames = await session([
      "for (const item of [1, 2]) { const doubled = item * 2 }\nconsole.log(typeof doubled)"
    ])
    expect(frames[0]!.prints).toBe("undefined")
    expect(named(frames[0]!.bindings, "doubled")).toBeUndefined()
    expect(named(frames[0]!.bindings, "item")).toBeUndefined()
  })

  it("refuses a limit it cannot validate before the realm is built", async () => {
    const failure = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.make
      return yield* sandbox.openRealm!({ flows, limits: { steps: -1 } }).pipe(Effect.flip)
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(failure.code).toBe("unsupported")
  })

  it("holds no name of its own in the panel before any cell runs", async () => {
    const frames = await session(["console.log('opened')"])
    expect(frames[0]!.bindings.map((binding) => binding.name)).toEqual([])
  })

  it("reads compute time through the injected synchronous clock, per frame", async () => {
    let now = 0
    const frames = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.makeWithClock
      const realm = yield* sandbox.openRealm!({
        flows,
        limits: { timeMs: 2, steps: Number.MAX_SAFE_INTEGER }
      })
      return [yield* realm.evaluate({ cell: Cell.source("while (true) {}"), frame: 0, call: succeeds })]
    }).pipe(
      Effect.scoped,
      Effect.provideService(QuickJSSandbox.ComputeClock, { now: () => now++ }),
      Effect.runPromise
    )
    expect(frames[0]!.outcome).toMatchObject({ _tag: "rejected", code: "limit_exceeded" })
  })

  it("fails to open at all when the prelude cannot fit the heap", async () => {
    // A prelude that cannot be installed is the binding failing at its job, not
    // a cell failing at its own, so it travels in the error channel.
    const wide: Record<string, Cell.FlowProjection> = {}
    for (let index = 0; index < 400; index++) {
      wide[`flow${index}`] = new Cell.FlowProjection({
        name: `flow${index}`,
        description: "z".repeat(8192),
        capabilities: [],
        tier: "sealed",
        placement: Option.none(),
        input: Option.none()
      })
    }
    const failure = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.make
      return yield* sandbox.openRealm!({
        flows: wide,
        limits: { memoryBytes: Sandbox.minimumMemoryBytes, steps: Number.MAX_SAFE_INTEGER }
      }).pipe(Effect.flip)
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(failure).toMatchObject({ code: "runtime_failed", message: "The sandbox prelude failed to install" })
  })

  it("dies instead of opening when a budget of zero stops the realm's own scaffolding", async () => {
    // Recorded, not endorsed, exactly as the per-cell binding records it: a
    // zero budget interrupts the property helper the binding evaluates before
    // any cell exists, and that failure escapes the acquire as a defect. The
    // runtime is still torn down, which every later case in this file proves.
    const exit = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.make
      return yield* sandbox.openRealm!({ flows, limits: { steps: 0 } })
    }).pipe(Effect.scoped, Effect.exit, Effect.runPromise)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("refuses source the boundary parse accepts and the realm does not", async () => {
    const frames = await session(["const o = { a: 1 }\nconsole.log(String(#a in o))"])
    const outcome = frames[0]!.outcome
    expect(outcome).toMatchObject({ _tag: "rejected", code: "compile_failed" })
    expect(outcome._tag === "rejected" && outcome.message).toContain("The cell did not compile:")
  })

  it("hands a call that settled with no value at all back as null", async () => {
    const frames = await session(["const got = await ctx.call('echo', {})\nconsole.log(String(got))"], {
      call: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))
    })
    expect(frames[0]!.prints).toBe("null")
  })

  it("keeps driving a cell whose first call is issued after an await", async () => {
    const frames = await session([
      "await Promise.resolve(1)\nconst late = await ctx.call('echo', { n: 1 })\nconsole.log(late.seen.n)"
    ])
    expect(frames[0]!.prints).toBe("1")
  })

  it("settles every bridge queued behind the call that trips the ceiling", async () => {
    const frames = await session([
      `const all = await Promise.all([ctx.call('echo', { n: 1 }), ctx.call('echo', { n: 2 }), ctx.call('echo', { n: 3 })])`
    ], { limits: { calls: 1 } })
    const outcome = frames[0]!.outcome
    expect(outcome._tag === "rejected" && outcome.code).toBe("limit_exceeded")
  })

  it("keeps the last panel it could read when a cell replaces the reflection it reads through", async () => {
    const frames = await session([
      "const kept = 'held'",
      "Object.getOwnPropertyNames = null\nconst added = 1"
    ])
    expect(named(frames[0]!.bindings, "kept")).toBeDefined()
    // The second frame's reading is the first frame's: nothing false is said,
    // and nothing new can be.
    expect(frames[1]!.bindings).toEqual(frames[0]!.bindings)
  })
})

describe("Sandbox.replTransition", () => {
  it("never populates the filing mode's fields", () => {
    const transition = Sandbox.replTransition(undefined, undefined)
    expect(transition).toEqual(
      new Cell.Continue({ state: null, context: [], render: undefined, recall: undefined, justification: undefined })
    )
    expect(Schema.encodeUnknownSync(Cell.Transition)(transition)).toBeDefined()
  })
})

describe("CellValidation.normalize", () => {
  const normalized = (text: string): string => CellValidation.normalize(text)

  it("moves only the keyword of a top-level declaration", () => {
    expect(normalized("const a = 1")).toBe("var a = 1")
    expect(normalized("let b = 2")).toBe("var b = 2")
    expect(normalized("const { x, y = 2 } = source")).toBe("var { x, y = 2 } = source")
    expect(normalized("let p = 1, q = 2")).toBe("var p = 1, q = 2")
  })

  it("gives an uninitialized declaration an explicit undefined, so re-declaring clears it", () => {
    expect(normalized("let held")).toBe("var held = undefined")
    expect(normalized("let one = 1, two")).toBe("var one = 1, two = undefined")
  })

  it("binds a top-level class to a name a later cell may rebind", () => {
    expect(normalized("class Widget { run() {} }")).toBe("var Widget = class Widget { run() {} };")
  })

  it("leaves a top-level function alone, because it already redeclares", () => {
    expect(normalized("function f() { const inner = 1; return inner }"))
      .toBe("function f() { const inner = 1; return inner }")
  })

  it("leaves every nested declaration exactly as written", () => {
    const nested = "if (true) {\n  const inner = 1\n}\nfor (const item of list) { let seen = item }"
    expect(normalized(nested)).toBe(nested)
  })

  it("changes nothing in a cell that declares nothing at the top level", () => {
    expect(normalized("await ctx.call('echo', {})")).toBe("await ctx.call('echo', {})")
  })

  it("erases type-only syntax before it normalizes, so a typed cell persists too", () => {
    const validated = CellValidation.validate(Cell.source("const total: number = 1", "typescript"), "repl")
    expect(validated.compiled).toContain("var total = 1")
  })

  it("leaves the filing mode's parse byte-identical", () => {
    const filing = CellValidation.validate(Cell.source("const a = 1\nreturn { intent: 'continue' }"))
    expect(filing.rejected).toBeUndefined()
    expect(filing.compiled).toBe("const a = 1\nreturn { intent: 'continue' }")
  })

  it("refuses a return the realm could not compile, wherever the cell put it", () => {
    const nested = CellValidation.validate(
      Cell.source("if (ready) {\n  return { intent: 'continue' }\n}"),
      "repl"
    )
    expect(nested.rejected?.code).toBe("compile_failed")
    expect(nested.rejected?.message).toContain("line 2")
  })
})
