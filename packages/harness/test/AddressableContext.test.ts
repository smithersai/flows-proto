/**
 * The addressable-context cases: PROGRAM changes 1, 5 and 8.
 *
 * Everything here answers one measured failure class of the r90 SWE-bench wave:
 * a run that already paid for bytes and could not get them back. The three
 * mechanics are `CallLedger` recall by ordinal, the `StateManifest` a frame
 * opens with, and the boundary parse that answers an unparseable cell inside
 * its own frame instead of ending it.
 */
import { Capability } from "@smthrs/kernel"
import { ModelEvent, ModelRequest } from "@smthrs/model"
import { Descriptor } from "@smthrs/registry"
import { Effect, type Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as CallLedger from "../src/CallLedger.ts"
import * as Cell from "../src/Cell.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as CellValidation from "../src/CellValidation.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as Sandbox from "../src/Sandbox.ts"
import * as StateManifest from "../src/StateManifest.ts"
import * as Steering from "../src/Steering.ts"
import * as ScriptedEngine from "./fixtures/scriptedEngine.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const descriptor = (name: string, capabilities: ReadonlyArray<string> = []): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name,
    description: `The ${name} flow.`,
    body: new Descriptor.BodyRefModule({ path: `/flows/${name}/flow.ts` }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: Option.none(),
    flows: [],
    capabilities,
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    modelInvocable: true,
    path: `/flows/${name}`,
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

const lister = descriptor("fs/list", ["fs:read:**"])

const emits = (cell: string): ScriptedModel.Step => ({
  events: [
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
    ModelEvent.ModelEvent.TextDelta({
      type: "text-delta",
      id: "cell",
      text: "Here is the next step.\n\n```cell\n" + cell + "\n```"
    }),
    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
    ModelEvent.ModelEvent.Usage({ inputTokens: 8, outputTokens: 4 }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
  ]
})

const prose = (text: string): ScriptedModel.Step => ({
  events: [
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "prose" }),
    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "prose", text }),
    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "prose" }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
  ]
})

const window = (): ContextWindow.ContextWindow =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
      { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
    ]
  })

const state = (
  overrides: { readonly maxFrames?: number; readonly revalidations?: number } = {}
): CellTurn.State =>
  CellTurn.make({
    session: "session-1",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: ["layer-a"],
    capabilityEnvelope: [new Capability.CapabilityPattern({ action: "fs:read", resource: "**" })],
    placement: Option.none(),
    contextWindow: window(),
    maxFrames: overrides.maxFrames ?? 4,
    ...(overrides.revalidations === undefined ? {} : { revalidations: overrides.revalidations })
  })

const run = async (options: {
  readonly script: ScriptedModel.Script
  readonly calls?: ReadonlyArray<ScriptedEngine.CallStep> | undefined
  readonly state?: CellTurn.State | undefined
}) => {
  const model = ScriptedModel.make(options.script)
  const engine = ScriptedEngine.make(model.model, [], options.calls ?? [])
  const events: Array<AgentEvent.AgentEvent> = []
  const layers: Layer.Layer<EngineLike.EngineLike> = engine.layer
  await CellTurn.run({ state: options.state ?? state(), flows: [lister] }).pipe(
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
    Effect.provide(layers),
    Effect.provide(Sandbox.layerRestricted),
    Effect.provide(Steering.layerNoop()),
    Effect.result,
    Effect.runPromise
  )
  return { events, model, engine }
}

/** The trailing frame block: the one user message appended after the transcript. */
const frameBlock = (model: ScriptedModel.Fixture, index: number): string =>
  model.recorder.requests[index]?.messages.at(-1)?.content
    .flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? ""

const settlement = (
  flow: string,
  input: Schema.Json,
  value: Schema.Json,
  ok = true,
  message?: string
): CallLedger.Settlement => ({ flow, input, ok, value, ...(message === undefined ? {} : { message }) })

describe("CallLedger recall", () => {
  it("retains a settled result and prints it back when its ordinal is named", () => {
    const ledger = CallLedger.remember([], [settlement("fs/list", { path: "src" }, { entries: ["a.py"] })])

    expect(CallLedger.recall(ledger, [1])).toBe(
      `Results you asked to see again:\n## recall 1 — fs/list {"path":"src"} (ok, 20b)\n{"entries":["a.py"]}`
    )
  })

  it("keeps the failure message of a call that failed, which is its whole content", () => {
    const ledger = CallLedger.remember(
      [],
      [settlement("edit", { path: "src/a.py" }, null, false, "oldString does not occur")]
    )

    expect(CallLedger.recall(ledger, [1])).toContain(`{"failed":"oldString does not occur"}`)
    expect(CallLedger.recall(ledger, [1])).toContain("FAILED")
  })

  it("answers an ordinal nobody settled by name rather than by silence", () => {
    const one = CallLedger.remember([], [settlement("fs/list", { path: "src" }, null)])

    expect(CallLedger.recall(one, [9])).toContain("No settled call has ordinal 9")
    expect(CallLedger.recall(one, [9])).toContain("has settled 1 call,")
    expect(CallLedger.recall([], [9])).toContain("has settled 0 calls,")
  })

  it("names the size of a result too large to have been retained at all", () => {
    const ledger = CallLedger.remember(
      [],
      [settlement("bash", { command: "run-tests" }, { stdout: "x".repeat(CallLedger.recallEntryBytes) })]
    )

    expect(ledger[0]?.retained).toBeUndefined()
    expect(ledger[0]?.bytes).toBeGreaterThan(CallLedger.recallEntryBytes)
    const recalled = CallLedger.recall(ledger, [1]) ?? ""
    expect(recalled).toContain("bytes are no longer held")
    expect(recalled).toContain("Issue the call again, narrowed")
    // The line survives without its bytes, and says so.
    expect(CallLedger.render(ledger)).not.toContain("recall 1")
  })

  it("drops the oldest retained bytes once the run's recall budget is spent", () => {
    const half = "y".repeat(CallLedger.recallEntryBytes - 16)
    const ledger = CallLedger.remember(
      [],
      Array.from({ length: 4 }, (_, index) => settlement("bash", { command: `c${index}` }, half))
    )

    // Four results of just under 16 KB against a 32 KB budget: the two newest
    // are held whole and the two oldest keep their line without their bytes.
    expect(ledger.map((line) => line.retained !== undefined)).toEqual([false, false, true, true])
    expect(CallLedger.recall(ledger, [1])).toContain("no longer held")
    expect(CallLedger.recall(ledger, [4])).toContain(`recall 4 — bash {"command":"c3"}`)
  })

  it("states the elision when a retained result is over the printable bound", () => {
    const ledger = CallLedger.remember([], [settlement("read", { path: "a.py" }, "e".repeat(6_000))])
    const recalled = CallLedger.recall(ledger, [1]) ?? ""

    expect(recalled).toContain("bytes elided from the middle.")
    expect(recalled).toContain(`recall 1 cannot print more than ${CallLedger.recallProjection} bytes`)
    expect(recalled).not.toContain("e".repeat(CallLedger.recallProjection + 1))
  })

  it("renders one section per distinct ordinal and nothing at all for an empty list", () => {
    const ledger = CallLedger.remember([], [
      settlement("fs/list", { path: "a" }, 1),
      settlement("fs/list", { path: "b" }, 2)
    ])

    expect(CallLedger.recall(ledger, [])).toBeUndefined()
    const both = CallLedger.recall(ledger, [1, 2, 1]) ?? ""
    expect(both.match(/## recall 1/g)).toHaveLength(1)
    expect(both).toContain("## recall 2")
  })
})

describe("StateManifest", () => {
  it("stamps a key with the frame that changed it and carries an unchanged one", () => {
    const first = StateManifest.stamp([], { plan: "read", note: "a" }, 2)
    const second = StateManifest.stamp(first, { plan: "read", note: "b" }, 5)

    expect(second.map((entry) => [entry.key, entry.frame])).toEqual([["plan", 2], ["note", 5]])
  })

  it("reads a non-object state as holding no keys at all", () => {
    expect(StateManifest.stamp([], ["a"], 1)).toEqual([])
    expect(StateManifest.stamp([], null, 1)).toEqual([])
  })

  it("names every JSON type a value can have", () => {
    expect([null, [1], "a", 1, true].map(StateManifest.typeOf)).toEqual([
      "null",
      "array",
      "string",
      "number",
      "boolean"
    ])
  })

  it("says a key was written this frame when the stamp is the frame being rendered", () => {
    const rendered = StateManifest.render({
      state: { plan: "read" },
      stamps: StateManifest.stamp([], { plan: "read" }, 3),
      frame: 3,
      keys: []
    })

    expect(rendered).toContain("- plan (string, 6b) — written this frame")
  })

  it("counts the keys it does not list rather than dropping them", () => {
    const many = Object.fromEntries(
      Array.from({ length: StateManifest.manifestKeys + 3 }, (_, index) => [`k${index}`, index])
    )
    const rendered = StateManifest.render({ state: many, stamps: [], frame: 1, keys: [] })

    expect(rendered).toContain("- … and 3 more keys not listed here.")
    expect(rendered).toContain("written before this run's stamps began")
  })

  it("counts one unlisted key in the singular", () => {
    const many = Object.fromEntries(
      Array.from({ length: StateManifest.manifestKeys + 1 }, (_, index) => [`k${index}`, index])
    )

    expect(StateManifest.render({ state: many, stamps: [], frame: 1, keys: [] }))
      .toContain("- … and 1 more key not listed here.")
  })
})

describe("CellValidation", () => {
  it("names the statements a cell wrote after its own first top-level return", () => {
    const notice = CellValidation.validate(
      Cell.source(`return { intent: "complete", output: "a" }\nconst x = 1\nconst y = 2`)
    ).notice

    expect(notice).toContain("the top-level `return` on line 1")
    expect(notice).toContain("2 top-level statements after it")
    expect(notice).toContain("Blocks in one reply are one program")
  })

  it("counts one dead statement in the singular", () => {
    expect(CellValidation.validate(Cell.source(`return null\nconst x = 1`)).notice)
      .toContain("1 top-level statement after it")
  })

  it("says nothing about a cell whose return is last, or that never returns", () => {
    expect(CellValidation.validate(Cell.source(`const x = 1\nreturn x`)).notice).toBeUndefined()
    expect(CellValidation.validate(Cell.source(`const x = 1`)).notice).toBeUndefined()
    // A return inside a branch is not a top-level return, so nothing after it
    // is dead and nothing is claimed.
    expect(CellValidation.validate(Cell.source(`if (1) { return null }\nconst y = 2`)).notice)
      .toBeUndefined()
  })

  it("reports the offending line of a syntax error, and only when it has one to quote", () => {
    const quoted = CellValidation.validate(Cell.source(`const a = 1\nconst b = (\n`)).rejected
    expect(quoted?.message).toBe("The cell did not compile — line 2, column 12: Expression expected.\n  const b = (")
    // A compiler that points past the last token names a blank line, and a
    // quoted blank line reads like a truncation, so it is left out.
    const blank = CellValidation.validate(Cell.source(`const a = 1\nif (a) {\n  return null\n`)).rejected
    expect(blank?.message).toBe("The cell did not compile — line 4, column 1: '}' expected.")
  })

  it("refuses module syntax and non-erasable TypeScript before anything runs", () => {
    expect(CellValidation.validate(Cell.source(`import "node:fs"\nreturn null`)).rejected?.code)
      .toBe("imports_forbidden")
    expect(CellValidation.validate(Cell.source(`enum E { a }\nreturn null`, "typescript")).rejected?.code)
      .toBe("compile_failed")
  })
})

describe("CellTurn recall directive", () => {
  it("prints a settled result into the next frame when the transition names its ordinal", async () => {
    const { model } = await run({
      script: [
        emits(
          `await ctx.call("fs/list", { path: "src" })
           return { intent: "continue", state: {}, recall: [1], context: [{ role: "user", text: "next" }] }`
        ),
        emits(`return { intent: "complete", output: "done" }`)
      ],
      calls: [{ _tag: "Success", value: { entries: ["models.py", "views.py"] } }]
    })

    const block = frameBlock(model, 1)
    expect(block).toContain("Results you asked to see again:")
    expect(block).toContain(`## recall 1 — fs/list {"path":"src"} (ok, 36b)`)
    expect(block).toContain(`{"entries":["models.py","views.py"]}`)
  })

  it("clears the recall when the next transition names none", async () => {
    const { model } = await run({
      state: state({ maxFrames: 5 }),
      script: [
        emits(
          `await ctx.call("fs/list", { path: "src" })
           return { intent: "continue", state: {}, recall: [1], context: [] }`
        ),
        emits(`return { intent: "continue", state: {}, context: [] }`),
        emits(`return { intent: "complete", output: "done" }`)
      ],
      calls: [{ _tag: "Success", value: { entries: ["models.py"] } }]
    })

    expect(frameBlock(model, 1)).toContain("## recall 1")
    expect(frameBlock(model, 2)).not.toContain("## recall 1")
  })
})

describe("CellTurn in-frame revalidation", () => {
  it("answers a cell that does not parse inside its own frame instead of ending it", async () => {
    const { events, model } = await run({
      script: [
        emits(`const a = 1\nif (a) {\n  return { intent: "complete", output: "unbalanced" }`),
        emits(`return { intent: "complete", output: "recovered" }`)
      ]
    })

    // One frame, two model calls, and the run's own answer at the end of it.
    expect(of(events, "turn-opened")).toHaveLength(1)
    expect(model.recorder.requests).toHaveLength(2)
    const rejected = of(events, "cell-rejected-in-frame")
    expect(rejected.map((event) => [event.attempt, event.code])).toEqual([[1, "compile_failed"]])
    expect(rejected[0]?.message).toContain("line 3")
    expect(of(events, "cell-settled").map((event) => event.outcome._tag)).toEqual(["settled"])
    expect(resolvedText(events)).toBe("recovered")
  })

  it("re-asks against the same prefix and names why the frame is not lost", async () => {
    const { model } = await run({
      script: [
        prose("no cell at all"),
        emits(`return { intent: "complete", output: "recovered" }`)
      ]
    })

    const first = model.recorder.requests[0]?.messages ?? []
    const second = model.recorder.requests[1]?.messages ?? []
    // Everything the first request carried is still the prefix of the second,
    // which is what makes the re-ask cost cached input plus its own output.
    expect(JSON.stringify(second.slice(0, first.length - 1)))
      .toBe(JSON.stringify(first.slice(0, first.length - 1)))
    expect(JSON.stringify(second)).toContain("This reply is not a frame.")
  })

  it("ends the frame once the cap on in-frame answers is spent", async () => {
    const { events, model } = await run({
      script: [
        prose("no cell"),
        prose("still no cell"),
        emits(`return { intent: "complete", output: "recovered" }`)
      ]
    })

    expect(of(events, "cell-rejected-in-frame")).toHaveLength(1)
    expect(of(events, "cell-settled").map((event) => event.outcome._tag)).toEqual(["rejected", "settled"])
    expect(of(events, "turn-opened")).toHaveLength(2)
    expect(model.recorder.requests).toHaveLength(3)
  })

  it("journals what the run was armed with", async () => {
    const { events } = await run({
      script: [emits(`return { intent: "complete", output: "done" }`)]
    })

    expect(of(events, "discipline-armed")[0]?.revalidations).toBe(CellTurn.defaultRevalidations)
  })
})

describe("CellTurn honest observations", () => {
  it("states the elision when a reply is too long to echo back whole", async () => {
    const filler = `const note = "${"z".repeat(12_000)}"\n`
    const { model } = await run({
      script: [
        emits(`${filler}throw new Error("boom")`),
        emits(`return { intent: "complete", output: "done" }`)
      ]
    })

    const conversation = JSON.stringify(model.recorder.requests[1]?.messages ?? [])
    expect(conversation).toContain("bytes elided from the middle.")
    expect(conversation).toContain("the reply is not re-read in full")
    expect(conversation).not.toContain("z".repeat(9_000))
  })

  it("names the state keys a cell threw reading a path that is not there", async () => {
    const { model } = await run({
      state: state({ maxFrames: 3 }),
      script: [
        emits(`return { intent: "continue", state: { probe: "exit 1" }, context: [] }`),
        emits(`return { intent: "complete", output: ctx.state.tests.verification }`),
        emits(`return { intent: "complete", output: "done" }`)
      ]
    })

    const observations = JSON.stringify(model.recorder.requests[2]?.messages ?? [])
    expect(observations).toContain("If `verification` was meant to come from ctx.state")
    expect(observations).toContain("these are the keys it holds: probe")
  })

  it("says so plainly when a cell threw such a path and the state holds nothing", async () => {
    const { model } = await run({
      script: [
        emits(`return { intent: "complete", output: ctx.state.tests.verification }`),
        emits(`return { intent: "complete", output: "done" }`)
      ]
    })

    expect(JSON.stringify(model.recorder.requests[1]?.messages ?? []))
      .toContain("this run's state holds no keys at all yet")
  })

  it("adds nothing to a throw that is not a property read", async () => {
    const { model } = await run({
      script: [
        emits(`throw new RangeError("off by one")`),
        emits(`return { intent: "complete", output: "done" }`)
      ]
    })

    const observations = JSON.stringify(model.recorder.requests[1]?.messages ?? [])
    expect(observations).toContain("off by one")
    expect(observations).not.toContain("meant to come from ctx.state")
  })

  it("tells a continuing frame which of its statements never ran", async () => {
    const { model } = await run({
      script: [
        emits(
          `return { intent: "continue", state: {}, context: [] }\nconst unused = 1\nconst other = 2`
        ),
        emits(`return { intent: "complete", output: "done" }`)
      ]
    })

    expect(JSON.stringify(model.recorder.requests[1]?.messages ?? []))
      .toContain("2 top-level statements after it")
  })
})

const of = <T extends AgentEvent.AgentEvent["_tag"]>(
  events: ReadonlyArray<AgentEvent.AgentEvent>,
  tag: T
): ReadonlyArray<Extract<AgentEvent.AgentEvent, { readonly _tag: T }>> =>
  events.filter((event): event is Extract<AgentEvent.AgentEvent, { readonly _tag: T }> => event._tag === tag)

const resolvedText = (events: ReadonlyArray<AgentEvent.AgentEvent>): string => {
  const part = of(events, "resolved")[0]?.message.content[0]
  return part?.type === "text" ? part.text : ""
}
