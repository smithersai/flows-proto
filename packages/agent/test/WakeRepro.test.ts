import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Capability from "@smthrs/capability/Capability"
import { FlowEngine } from "@smthrs/engine"
import { Flow as EngineFlow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Context, Deferred, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Seat from "../src/Seat.ts"
import * as StandardFlows from "../src/StandardFlows.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const recorded = (cells: ReadonlyArray<string>): Model.Model => {
  let index = 0
  return Model.make({
    stream: () =>
      Stream.suspend(() => {
        const source = cells[index++] ?? cells.at(-1) ?? "ctx.done(\"done\")"
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: "```cell\n" + source + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

type Outcome =
  | { readonly _tag: "completed"; readonly value: unknown }
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "suspended" }

const classify = (exit: Exit.Exit<unknown, unknown>): Outcome =>
  Exit.isSuccess(exit)
    ? { _tag: "completed", value: exit.value }
    : Cause.hasInterruptsOnly(exit.cause)
    ? { _tag: "suspended" }
    : { _tag: "failed", error: Cause.squash(exit.cause) }

const driveFlow = EngineFlow.make("agent/test/wake-repro", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

const drive = <A, E>(
  body: Effect.Effect<A, E, Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>
): Promise<Outcome> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.register(driveFlow, () =>
      Effect.onExit(body, (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit))))).pipe(
        Scope.provide(scope)
      )
    yield* engine.execute(driveFlow, { executionId: "exec-1", payload: {}, discard: true })
    return yield* Deferred.await(settled)
  }).pipe(Effect.provide(Layer.merge(FlowEngine.layerMemory, NodeCrypto.layer)), Effect.scoped, Effect.runPromise)

describe("wake repro", () => {
  it("resumes a cell that waited on a durable clock", async () => {
    const outcome = await drive(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const services = yield* Effect.context<Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>()
        // A scripted clock: arming returns immediately and the deferred is
        // completed on a forked fiber, so the awaiting flow parks first.
        const scripted = FlowRuntime.FlowRuntime.of({
          ...engine,
          scheduleClock: (flow, opts) =>
            engine.deferredDone(opts.clock.deferred, {
              flowName: flow._tag,
              executionId: opts.executionId,
              deferredName: opts.clock.deferred.name,
              exit: Exit.void
            })
        })
        const clockServices = Context.add(services, FlowRuntime.FlowRuntime, scripted)
        const collected: Array<AgentEvent.AgentEvent> = []
        const agent = yield* Agent.Agent
        yield* agent.run({
          session: "session-1",
          seat: Seat.make({
            id: "anthropic:test-model",
            model: recorded([
              `const waited = await ctx.call("wait", { seconds: 61 })
ctx.done(String(waited.waitedSeconds))`
            ]),
            route,
            contextWindowTokens: 0
          }),
          prompt: "do the task",
          registry: Registry.makeNoop({
            list: () => Effect.succeed([]),
            visible: () => Effect.succeed([]),
            getOption: () => Effect.succeed(Option.none())
          }),
          capabilityEnvelope: [new Capability.CapabilityPattern({ action: "*", resource: "*" })],
          flows: [StandardFlows.clock(clockServices)],
          maxFrames: 3
        }).pipe(
          Stream.runForEach((event) => Effect.sync(() => collected.push(event))),
          Effect.provide(Agent.layerDefaults)
        )
        return collected
      }).pipe(Effect.provide(Agent.layer))
    )
    expect(outcome._tag).toBe("completed")
    // The wake is proved by the answer, not by the run merely ending: the cell
    // resumed after the durable clock settled and finished on the value the
    // call returned.
    const events = outcome._tag === "completed" ? outcome.value as ReadonlyArray<AgentEvent.AgentEvent> : []
    const completions = events.flatMap((event) =>
      event._tag === "transition-applied" && event.transition._tag === "complete" ? [event.transition] : []
    )
    expect(completions).toHaveLength(1)
    expect(completions[0]?.output).toBe("61")
  }, 30_000)
})
