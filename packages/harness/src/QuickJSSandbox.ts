/**
 * The QuickJS-WASM sandbox binding.
 *
 * This is the production `Sandbox`: the cell runs inside a QuickJS interpreter
 * compiled to WebAssembly, which is a genuinely separate JavaScript realm with
 * no reference to the host's globals, prototypes, or module loader. The same
 * single-file variant runs unmodified on Node and in a browser, so a browser
 * host provides this layer and calls the identical harness.
 *
 * What the cell can reach is exactly `ctx`: `ctx.call` bridges to the host's
 * durable flow boundary, `ctx.flows` is a frozen catalog projection. The
 * prelude removes `Date` and `Math.random` from the realm, because a replayed
 * cell must reach the same calls in the same order. There is no filesystem, no
 * network, no process, and no module loader to reach in the first place.
 *
 * Teardown is scope finalization and cancellation is fiber interruption: an
 * interrupted frame disposes the runtime, which is the only thing holding the
 * cell alive.
 *
 * @since 0.1.0
 */
import variant from "@jitl/quickjs-singlefile-browser-release-sync"
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect"
import type { QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten-core"
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core"
import * as Cell from "./Cell.ts"
import type { HarnessError } from "./HarnessError.ts"
import * as elide from "./internal/elide.ts"
import * as Sandbox from "./Sandbox.ts"
import * as VariablesPanel from "./VariablesPanel.ts"

/**
 * The prelude evaluated before every cell.
 *
 * It installs the one binding a cell has and removes the two sources of
 * nondeterminism QuickJS ships with. The raw host bridge is captured in a
 * closure and then deleted from the global object, so a cell cannot reach the
 * unwrapped boundary and hand it unencoded values.
 */
/**
 * The realm-side helpers both preludes install.
 *
 * `encode` carries the label of what it is encoding so one validator serves
 * `ctx.call`, `ctx.done`, `ctx.park` and `ctx.justify` without any of them
 * having to describe its own refusal.
 */
const preludeHelpers = `  var freeze = function (value) {
    if (value !== null && typeof value === "object") {
      Object.keys(value).forEach(function (key) { freeze(value[key]) })
      Object.freeze(value)
    }
    return value
  }
  var encode = function (label, input) {
    var seen = []
    var visit = function (value) {
      if (value === null || typeof value === "string" || typeof value === "boolean") return
      if (typeof value === "number" && Number.isFinite(value)) return
      if (typeof value !== "object") throw new TypeError(label + " must be JSON-serializable")
      if (seen.indexOf(value) >= 0) throw new TypeError(label + " must be JSON-serializable")
      var prototype = Object.getPrototypeOf(value)
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(label + " must be JSON-serializable")
      }
      seen.push(value)
      Object.keys(value).forEach(function (key) { visit(value[key]) })
      seen.pop()
    }
    visit(input)
    return JSON.stringify(input)
  }`

/** The `ctx.call` member, identical in both modes. */
const preludeCall = `    call: function (flow, input) {
      if (typeof flow !== "string") return Promise.reject(new TypeError("ctx.call expects a flow name as its first argument"))
      return bridge(flow, encode("ctx.call input", input === undefined ? null : input)).then(function (settled) {
        // A failed call RESOLVES with the failure envelope; only teardown
        // throws. See Cell.callFailure for why.
        if (settled.ok) return settled.value
        if (settled.aborted) throw new Error(settled.failure.error.message)
        return settled.failure
      })
    },`

const prelude = (catalog: string, state: string): string =>
  `(function () {
  var bridge = globalThis.__call
${preludeHelpers}
  delete globalThis.__call
  delete globalThis.Date
  delete Math.random
  globalThis.ctx = Object.freeze({
${preludeCall}
    flows: freeze(${catalog}),
    state: freeze(JSON.parse(${state}))
  })
})()`

/**
 * The prelude a persistent realm is opened with.
 *
 * It differs from the per-cell prelude in exactly the two ways the REPL mode
 * differs: `ctx.state` is gone, because the realm is the memory, and three new
 * members plus `console` are installed, because a script cannot `return`.
 *
 * `console.log` renders each argument on the host side — a string as itself,
 * anything else as canonical JSON — so a structured value reaches the next model
 * turn as the value it is rather than as `[object Object]`.
 */
const replPrelude = (catalog: string): string =>
  `(function () {
  var bridge = globalThis.__call
  var print = globalThis.__print
  var intent = globalThis.__intent
${preludeHelpers}
  delete globalThis.__call
  delete globalThis.__print
  delete globalThis.__intent
  delete globalThis.Date
  delete Math.random
  var show = function (values) {
    var parts = []
    for (var index = 0; index < values.length; index++) {
      var value = values[index]
      if (typeof value === "string") parts.push({ text: value })
      else if (value === undefined) parts.push({ text: "undefined" })
      else {
        try { parts.push({ json: JSON.parse(JSON.stringify(value)) }) }
        catch (error) { parts.push({ text: String(value) }) }
      }
    }
    print(JSON.stringify(parts))
  }
  var line = function () { show(Array.prototype.slice.call(arguments)) }
  globalThis.console = Object.freeze({ log: line, info: line, warn: line, error: line })
  globalThis.ctx = Object.freeze({
${preludeCall}
    flows: freeze(${catalog}),
    done: function (output) { intent("done", encode("ctx.done output", output === undefined ? null : output)) },
    park: function (reason, message) {
      intent("park", encode("ctx.park message", { reason: reason === undefined ? null : reason, message: message === undefined ? "" : message }))
    },
    justify: function (text) { intent("justify", encode("ctx.justify text", text === undefined ? "" : text)) }
  })
})()`

const wrap = (text: string): string =>
  `globalThis.__cell = (async () => {\n${text}\n})().then(function (value) {
  return JSON.stringify(value === undefined ? null : value)
})`

const catalogOf = (flows: Readonly<Record<string, Cell.FlowProjection>>): string => {
  const entries: Record<string, unknown> = {}
  for (const [name, projection] of Object.entries(flows)) {
    entries[name] = {
      name: projection.name,
      description: projection.description,
      capabilities: [...projection.capabilities],
      tier: projection.tier,
      // The contract tells a cell to read `ctx.flows` before reissuing a
      // rejected call, so the projection has to answer the question the
      // rejection asked: what shape does this flow take?
      ...(Option.isSome(projection.input) ? { input: projection.input.value } : {})
    }
  }
  return JSON.stringify(entries)
}

const raisedFrom = (dumped: unknown): Cell.Raised => {
  if (typeof dumped === "object" && dumped !== null) {
    const record = dumped as { readonly name?: unknown; readonly message?: unknown }
    return new Cell.Raised({
      name: typeof record.name === "string" ? record.name : "Error",
      // Never `String(object)`: a cell that threw a structured value is told
      // what it threw. See `Sandbox` `describe`.
      message: typeof record.message === "string" ? record.message : Sandbox.raisedOutcome(dumped).message
    })
  }
  return new Cell.Raised({ name: "Error", message: String(dumped) })
}

/**
 * Builds one owned QuickJS handle from the already-validated JSON result.
 *
 * Materializing the value directly also avoids parsing a multi-megabyte JSON
 * string inside a promise job, which leaves QuickJS 0.32's runtime heap in an
 * uncollectable state during disposal.
 */
const handleFromJson = (
  context: QuickJSContext,
  defineDataProperty: QuickJSHandle,
  value: Schema.Json
): QuickJSHandle => {
  if (value === null) return context.null
  switch (typeof value) {
    case "boolean":
      return value ? context.true : context.false
    case "number":
      return context.newNumber(value)
    case "string":
      return context.newString(value)
  }

  const container = Array.isArray(value) ? context.newArray() : context.newObject()
  try {
    for (const [key, item] of Object.entries(value)) {
      const child = handleFromJson(context, defineDataProperty, item)
      try {
        const property = context.newString(key)
        try {
          context.unwrapResult(
            context.callFunction(defineDataProperty, context.undefined, container, property, child)
          ).dispose()
        } finally {
          property.dispose()
        }
      } finally {
        child.dispose()
      }
    }
    return container
  } catch (error) {
    container.dispose()
    throw error
  }
}

/**
 * Caches only a successful asynchronous load; a rejection may be retried.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cacheSuccessful = <A>(load: () => Promise<A>): () => Promise<A> => {
  let loaded: Promise<A> | undefined
  return () => {
    if (loaded === undefined) {
      const pending = load()
      loaded = pending
      void pending.catch(() => {
        loaded = undefined
      })
    }
    return loaded
  }
}

const wasmModule = cacheSuccessful(() => newQuickJSWASMModuleFromVariant(variant))

/**
 * Synchronous monotonic-enough clock required by QuickJS's interrupt callback.
 *
 * @category models
 * @since 0.1.0
 */
export interface ComputeClockService {
  readonly now: () => number
}

/**
 * Synchronous monotonic-enough clock required by QuickJS's interrupt callback.
 *
 * @category services
 * @since 0.1.0
 */
export class ComputeClock extends Context.Service<ComputeClock, ComputeClockService>()(
  "flows/harness/QuickJSSandbox/ComputeClock"
) {}

/**
 * Provides the browser-safe host clock behind the QuickJS clock seam.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerClockLive: Layer.Layer<ComputeClock> = Layer.succeed(ComputeClock)({ now: () => Date.now() })

const capabilities: Sandbox.Capabilities = {
  calls: true,
  memoryBytes: true,
  steps: true,
  timeMs: true
}

const timeLimitExceeded = (timeMs: number): Cell.Rejected =>
  new Cell.Rejected({
    code: "limit_exceeded",
    message: `This cell exceeded its wall-clock limit of ${timeMs} milliseconds`
  })

/**
 * The whole-evaluation ceiling for one call.
 *
 * `Sandbox.make` runs `Sandbox.withDefaults` over the caller's limits before it
 * reaches this binding, and `totalMs` is filled whenever the `timeMs`
 * capability is declared, which this binding declares.
 */
const totalMsOf = (evaluation: Sandbox.Evaluation): number => {
  /* v8 ignore next -- see above: the ceiling always arrives filled, so neither the optional chain nor the coalesce takes its fallback; both only discharge optional types */
  return evaluation.limits?.totalMs ?? Sandbox.defaultLimits.totalMs
}

const evaluate = (
  module: QuickJSWASMModule,
  evaluation: Sandbox.Evaluation,
  clock: ComputeClockService
): Effect.Effect<Cell.Outcome, Sandbox.SandboxError | HarnessError> =>
  Effect.gen(function*() {
    const compiled = Sandbox.compile(evaluation.cell)
    if (compiled instanceof Cell.Rejected) return compiled

    const limits = Sandbox.withDefaults(capabilities, evaluation.limits)
    /* v8 ignore next -- `withDefaults` fills `timeMs` from `defaultLimits` whenever the `timeMs` capability is declared, and this binding declares it, so the coalesce never reaches its fallback; it only discharges the optional type on `Sandbox.Limits` */
    const timeMs = limits.timeMs ?? Sandbox.defaultLimits.timeMs
    // The compute clock's baseline. Host calls shift it forward by their own
    // duration when they settle, so `timeMs` charges the cell for its
    // JavaScript alone: a cell that awaits a ten-minute test run resumes with
    // the budget it suspended with. Without the shift, the first interrupt
    // check after a long `ctx.call` read the whole call as elapsed compute
    // and rejected the frame — which taught agents that verifying their work
    // was fatal.
    let clockBase = clock.now()
    let exhausted: Cell.Rejected | undefined

    const acquired = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const runtime: QuickJSRuntime = module.newRuntime()
        /* v8 ignore else -- `withDefaults` fills `memoryBytes` from `defaultLimits` whenever the `memoryBytes` capability is declared, and this binding declares it, so the heap ceiling is always set */
        if (limits.memoryBytes !== undefined) {
          runtime.setMemoryLimit(limits.memoryBytes)
        }
        const stepBudget = limits.steps
        let steps = 0
        runtime.setInterruptHandler(() => {
          if (clock.now() - clockBase >= timeMs) {
            exhausted = exhausted ?? timeLimitExceeded(timeMs)
            return true
          }
          if (stepBudget !== undefined && ++steps > stepBudget) {
            exhausted = exhausted ?? new Cell.Rejected({
              code: "limit_exceeded",
              message: `This cell exceeded its limit of ${stepBudget} interpreter steps`
            })
            return true
          }
          return false
        })
        const context: QuickJSContext = runtime.newContext()
        try {
          // Capture the pristine intrinsic before cell code can replace it.
          // Assignment can invoke a hostile inherited setter, while
          // QuickJSContext.defineProp cannot create a writable data property.
          const defineDataProperty = context.unwrapResult(context.evalCode(
            `(function (defineProperty) {
  return function (object, key, value) {
    defineProperty(object, key, {
      value: value,
      writable: true,
      enumerable: true,
      configurable: true
    })
  }
})(Object.defineProperty)`
          ))
          return { runtime, context, defineDataProperty }
        } catch (error) {
          context.dispose()
          runtime.dispose()
          throw error
        }
      }),
      ({ context, defineDataProperty, runtime }) =>
        Effect.sync(() => {
          defineDataProperty.dispose()
          context.dispose()
          runtime.dispose()
        })
    )
    const { context, defineDataProperty, runtime } = acquired

    const pending: Array<Sandbox.PendingCall> = []
    let ordinal = 0
    let settled: Cell.Outcome | undefined

    const bridge = context.newFunction("__call", (flowHandle, inputHandle) => {
      const flow = context.getString(flowHandle)
      const encoded = context.getString(inputHandle)
      const deferred = context.newPromise()
      const reply = (payload: Schema.Json): void => {
        const handle = handleFromJson(context, defineDataProperty, payload)
        try {
          deferred.resolve(handle)
        } finally {
          handle.dispose()
          deferred.dispose()
        }
      }
      pending.push({
        ordinal: ordinal++,
        flow,
        input: Schema.decodeUnknownSync(Schema.Json)(JSON.parse(encoded)),
        settle: (result) =>
          reply(
            result.outcome === "success"
              ? { ok: true, value: result.value ?? null }
              : { ok: false, aborted: false, failure: Cell.callFailure(result) }
          ),
        abort: (message) =>
          reply({
            ok: false,
            aborted: true,
            failure: Cell.callFailure(new Cell.CallResult({ outcome: "failure", value: null, message }))
          })
      })
      return deferred.handle
    })
    context.setProp(context.global, "__call", bridge)
    bridge.dispose()

    const install = context.evalCode(
      // The state rides as a doubly-encoded JSON string literal so hostile
      // content can never escape into the prelude's source.
      prelude(catalogOf(evaluation.flows), JSON.stringify(JSON.stringify(evaluation.state ?? null)))
    )
    if (install.error !== undefined) {
      const failure = context.dump(install.error)
      install.error.dispose()
      if (exhausted !== undefined) return exhausted
      return yield* new Sandbox.SandboxError({
        code: "runtime_failed",
        message: "The sandbox prelude failed to install",
        cause: failure
      })
    }
    install.value.dispose()

    const started = context.evalCode(wrap(compiled))
    if (started.error !== undefined) {
      const failure = context.dump(started.error)
      started.error.dispose()
      /* v8 ignore next -- the boundary parse refuses every program TypeScript cannot parse, so reaching a realm compile failure at all needs the two parsers to disagree, and reaching one while the interrupt budget is also spent needs that disagreement to be reported by a handler that never ran: nothing evaluates before this point */
      if (exhausted !== undefined) return exhausted
      return new Cell.Rejected({
        code: "compile_failed",
        /* v8 ignore next -- QuickJS reports a compile failure as an Error object, so the `message` arm is what a parser disagreement takes; `String(failure)` only discharges the `unknown` `context.dump` is typed as */
        message: `The cell did not compile: ${
          typeof failure === "object" && failure !== null && "message" in failure
            ? String((failure as { readonly message: unknown }).message)
            : String(failure)
        }`
      })
    }
    started.value.dispose()

    const cellHandle = context.getProp(context.global, "__cell")
    yield* Effect.addFinalizer(() => Effect.sync(() => cellHandle.dispose()))

    /** Runs every queued VM job, then reads the cell promise. */
    const poll = (): void => {
      runtime.executePendingJobs()
      if (exhausted !== undefined) {
        // An interrupted job leaves the promise pending, so the ceiling ends
        // the evaluation rather than waiting for a settlement that cannot run.
        settled = exhausted
        return
      }
      const state = context.getPromiseState(cellHandle)
      if (state.type === "pending") return
      if (state.type === "fulfilled") {
        const value = context.dump(state.value)
        state.value.dispose()
        settled = typeof value === "string"
          ? Cell.transition(JSON.parse(value))
          : new Cell.Rejected({
            code: "invalid_transition",
            message: "The cell returned a value that is not JSON-serializable."
          })
        return
      }
      const error = context.dump(state.error)
      state.error.dispose()
      settled = raisedFrom(error)
    }

    return yield* Sandbox.driveCell({
      pending,
      flush: () => poll(),
      finished: () => {
        poll()
        if (settled !== undefined) return settled
        if (pending.length > 0) return undefined
        // Nothing is queued and no job can advance the cell: it awaited
        // something the realm can never settle.
        return new Cell.Rejected({
          code: "stalled",
          message:
            "The cell awaited something that never settles. Inside a cell the only thing worth awaiting is ctx.call."
        })
      },
      wait: Effect.void,
      abort: () => {
        for (const call of pending.splice(0)) call.abort("The cell was interrupted")
      },
      // Timed so the host call's duration is refunded to the compute clock.
      handler: (call) =>
        Effect.suspend(() => {
          const pausedAt = clock.now()
          return evaluation.call(call).pipe(
            Effect.onExit(() =>
              Effect.sync(() => {
                clockBase += clock.now() - pausedAt
              })
            )
          )
        }),
      limits
    })
  }).pipe(
    Effect.scoped,
    // The whole-evaluation backstop, host calls included. `timeMs` is
    // enforced by the interrupt handler above; this ceiling only exists so a
    // host call that never settles cannot hold the frame forever.
    Effect.timeoutOrElse({
      duration: totalMsOf(evaluation),
      orElse: () => Effect.succeed(timeLimitExceeded(totalMsOf(evaluation)))
    })
  )

/**
 * The reasons `ctx.park` may name, as the transition schema declares them.
 *
 * Checked on the host rather than inside the realm so a wrong one settles the
 * frame exactly as it does in the filing mode — an `invalid_transition` the next
 * frame is asked to fix — instead of as a throw that reads like a bug in the
 * cell's own logic.
 */
const parkReasons = ["waiting-input", "waiting-event", "waiting-quota"] as const

/** What `ctx.done` or `ctx.park` recorded, before the reason is judged. */
type Recorded =
  | { readonly kind: "done"; readonly output: string }
  | { readonly kind: "park"; readonly reason: Schema.Json; readonly message: string }

const parkPayload = Schema.decodeUnknownSync(
  Schema.Struct({ reason: Schema.Json, message: Schema.Json })
)

const printParts = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Union([
      Schema.Struct({ text: Schema.String }),
      Schema.Struct({ json: Schema.Json })
    ])
  )
)

/**
 * Renders one `console.log` call as the single line it contributes.
 */
const printed = (encoded: string): string => {
  const parts = printParts(JSON.parse(encoded))
  return elide.head(
    parts.map((part) => "text" in part ? part.text : Cell.renderText(part.json)).join(" "),
    Sandbox.printStatementBytes,
    "print a narrower slice of this value; it is still bound in the realm"
  )
}

/**
 * The transition a REPL frame settled, or the reason it settled none.
 */
const replOutcome = (recorded: Recorded | undefined, justification: string | undefined): Cell.Outcome => {
  if (recorded !== undefined && recorded.kind === "park") {
    const reason = parkReasons.find((candidate) => candidate === recorded.reason)
    if (reason === undefined) {
      return new Cell.Rejected({
        code: "invalid_transition",
        message: `ctx.park was called with reason ${
          JSON.stringify(recorded.reason)
        }. Call it as ctx.park(reason, message) with reason one of "waiting-input", "waiting-event" or "waiting-quota".`
      })
    }
    return new Cell.Settled({
      transition: Sandbox.replTransition({ _tag: "Park", reason, message: recorded.message }, justification)
    })
  }
  return new Cell.Settled({
    transition: Sandbox.replTransition(
      recorded === undefined ? undefined : { _tag: "Done", output: recorded.output },
      justification
    )
  })
}

/**
 * The in-realm probe that reads the variables panel off the realm.
 *
 * One expression statement over intrinsics, so it declares nothing and adds no
 * name of its own to the set it reports. Every value is measured cheaply — a
 * string's length, an array's length, an object's key count, a function's arity,
 * a number or boolean by value — because a panel that serialized every global
 * would cost the heap every frame, and the whole point of a realm is that the
 * value is still there under the name the panel prints.
 */
const panelProbe = (baseline: string): string =>
  `(function (skip) {
  var names = Object.getOwnPropertyNames(globalThis)
  var out = []
  for (var index = 0; index < names.length; index++) {
    var name = names[index]
    if (skip.indexOf(name) >= 0) continue
    try {
      var value = globalThis[name]
      var kind = typeof value
      if (value === null) out.push({ name: name, type: "null", size: "" })
      else if (kind === "undefined") out.push({ name: name, type: "unset", size: "" })
      else if (kind === "string") out.push({ name: name, type: "string", size: value.length + " chars" })
      else if (kind === "function") out.push({ name: name, type: "function", size: "arity " + value.length })
      else if (Array.isArray(value)) out.push({ name: name, type: "array", size: value.length + " items" })
      else if (kind === "object") out.push({ name: name, type: "object", size: Object.keys(value).length + " keys" })
      else out.push({ name: name, type: kind, size: String(value) })
    } catch (error) {
      out.push({ name: name, type: "unset", size: "" })
    }
  }
  return JSON.stringify(out)
})(JSON.parse(${baseline}))`

const decodeBindings = Schema.decodeUnknownSync(Schema.Array(VariablesPanel.Binding))

/**
 * Opens one QuickJS realm that lives for a whole run.
 *
 * The acquire/release is the pair the per-cell binding uses, moved up to the
 * caller's scope: teardown is still scope finalization and cancellation is still
 * fiber interruption, so nothing threads an abort signal. What changes is
 * lifetime — every cell is evaluated against the same context, so a top-level
 * declaration made in frame 3 is still bound in frame 9.
 *
 * Each cell is evaluated as `evalCode(text, "cell-<frame>.js", 128)`:
 * `JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_ASYNC`. That combination, measured on the
 * shipped variant, does three things at once — top-level `await` compiles, the
 * result is a promise the existing drive loop already knows how to poll, and
 * top-level declarations land in the realm rather than in an async wrapper that
 * dies with the frame. The raw numeric flag is passed because
 * `quickjs-emscripten-core`'s options object does not spell the async flag but
 * hands a numeric `options` straight through.
 *
 * The per-frame budgets survive the move unchanged, because they are counters
 * the interrupt handler reads rather than properties of the runtime: `timeMs`
 * and `steps` reset at each frame's start and the compute clock keeps refunding
 * host-call duration. `memoryBytes` becomes what it honestly is once a realm
 * outlives a cell — a run budget — and exhausting it is an ordinary in-cell
 * throw the realm survives.
 */
const openRealm = (
  module: QuickJSWASMModule,
  options: Sandbox.RealmOptions,
  clock: ComputeClockService
): Effect.Effect<Sandbox.Realm, Sandbox.SandboxError, Scope.Scope> =>
  Effect.gen(function*() {
    const limits = Sandbox.withDefaults(capabilities, options.limits)
    /* v8 ignore next -- `withDefaults` fills `timeMs` from `defaultLimits` whenever the `timeMs` capability is declared, and this binding declares it, so the coalesce never reaches its fallback; it only discharges the optional type on `Sandbox.Limits` */
    const timeMs = limits.timeMs ?? Sandbox.defaultLimits.timeMs
    /* v8 ignore next -- `withDefaults` fills `totalMs` alongside `timeMs`, so this coalesce only discharges the same optional type */
    const totalMs = limits.totalMs ?? Sandbox.defaultLimits.totalMs
    const stepBudget = limits.steps

    let clockBase = clock.now()
    let steps = 0
    let exhausted: Cell.Rejected | undefined
    let pending: Array<Sandbox.PendingCall> = []
    let ordinal = 0
    let lines: Array<string> = []
    let recorded: Recorded | undefined
    let justification: string | undefined

    const acquired = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const runtime: QuickJSRuntime = module.newRuntime()
        /* v8 ignore else -- `withDefaults` fills `memoryBytes` whenever the `memoryBytes` capability is declared, and this binding declares it, so the heap ceiling is always set */
        if (limits.memoryBytes !== undefined) {
          runtime.setMemoryLimit(limits.memoryBytes)
        }
        runtime.setInterruptHandler(() => {
          if (clock.now() - clockBase >= timeMs) {
            exhausted = exhausted ?? timeLimitExceeded(timeMs)
            return true
          }
          if (stepBudget !== undefined && ++steps > stepBudget) {
            exhausted = exhausted ?? new Cell.Rejected({
              code: "limit_exceeded",
              message: `This cell exceeded its limit of ${stepBudget} interpreter steps`
            })
            return true
          }
          return false
        })
        const context: QuickJSContext = runtime.newContext()
        try {
          const defineDataProperty = context.unwrapResult(context.evalCode(
            `(function (defineProperty) {
  return function (object, key, value) {
    defineProperty(object, key, {
      value: value,
      writable: true,
      enumerable: true,
      configurable: true
    })
  }
})(Object.defineProperty)`
          ))
          return { runtime, context, defineDataProperty }
        } catch (error) {
          context.dispose()
          runtime.dispose()
          throw error
        }
      }),
      ({ context, defineDataProperty, runtime }) =>
        Effect.sync(() => {
          defineDataProperty.dispose()
          context.dispose()
          runtime.dispose()
        })
    )
    const { context, defineDataProperty, runtime } = acquired

    const install = (name: string, implementation: Parameters<QuickJSContext["newFunction"]>[1]): void => {
      const handle = context.newFunction(name, implementation)
      context.setProp(context.global, name, handle)
      handle.dispose()
    }

    install("__call", (flowHandle, inputHandle) => {
      const flow = context.getString(flowHandle)
      const encoded = context.getString(inputHandle)
      const deferred = context.newPromise()
      const reply = (payload: Schema.Json): void => {
        const handle = handleFromJson(context, defineDataProperty, payload)
        try {
          deferred.resolve(handle)
        } finally {
          handle.dispose()
          deferred.dispose()
        }
      }
      pending.push({
        ordinal: ordinal++,
        flow,
        input: Schema.decodeUnknownSync(Schema.Json)(JSON.parse(encoded)),
        settle: (result) =>
          reply(
            result.outcome === "success"
              ? { ok: true, value: result.value ?? null }
              : { ok: false, aborted: false, failure: Cell.callFailure(result) }
          ),
        abort: (message) =>
          reply({
            ok: false,
            aborted: true,
            failure: Cell.callFailure(new Cell.CallResult({ outcome: "failure", value: null, message }))
          })
      })
      return deferred.handle
    })
    install("__print", (partsHandle) => {
      lines.push(printed(context.getString(partsHandle)))
      return context.undefined
    })
    install("__intent", (kindHandle, payloadHandle) => {
      const kind = context.getString(kindHandle)
      const payload = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(context.getString(payloadHandle)))
      if (kind === "done") recorded = { kind: "done", output: Cell.renderText(payload) }
      else if (kind === "park") {
        const park = parkPayload(payload)
        recorded = { kind: "park", reason: park.reason, message: Cell.renderText(park.message) }
      } else justification = Cell.renderText(payload)
      return context.undefined
    })

    const installed = context.evalCode(replPrelude(catalogOf(options.flows)))
    if (installed.error !== undefined) {
      const failure = context.dump(installed.error)
      installed.error.dispose()
      return yield* new Sandbox.SandboxError({
        code: "runtime_failed",
        message: "The sandbox prelude failed to install",
        cause: failure
      })
    }
    installed.value.dispose()

    // The names a fresh realm already holds, snapshotted after the prelude so
    // `ctx` and `console` are part of the baseline rather than part of the
    // panel. Doubly encoded so no name — `__proto__` included — can reach the
    // probe's source as anything but data.
    const snapshot = context.unwrapResult(
      context.evalCode("JSON.stringify(Object.getOwnPropertyNames(globalThis))")
    )
    const baseline = context.getString(snapshot)
    snapshot.dispose()
    const probe = panelProbe(JSON.stringify(baseline))

    let bindings: ReadonlyArray<VariablesPanel.Binding> = []

    const evaluate = (
      evaluation: Sandbox.RealmEvaluation
    ): Effect.Effect<Sandbox.RealmFrame, Sandbox.SandboxError | HarnessError> =>
      Effect.gen(function*() {
        // Whatever the frame produced, the prints are delivered with it and the
        // panel is read after it, so the answer is assembled in one place.
        const frameOf = (outcome: Cell.Outcome): Sandbox.RealmFrame => ({
          outcome,
          prints: lines.length === 0 ? "" : elide.middle(
            lines.join("\n"),
            Sandbox.printFrameBytes,
            "print less next time, or read the value back from the name it is still bound to"
          ),
          bindings
        })

        const compiled = Sandbox.compile(evaluation.cell, "repl")
        if (compiled instanceof Cell.Rejected) return frameOf(compiled)

        // Per-frame budgets. They are counters, not properties of the runtime,
        // so a realm that outlives one cell still charges each cell its own.
        clockBase = clock.now()
        steps = 0
        exhausted = undefined
        pending = []
        ordinal = 0
        lines = []
        recorded = undefined
        justification = undefined

        const started = context.evalCode(compiled, `cell-${evaluation.frame}.js`, 128)
        if (started.error !== undefined) {
          const failure = context.dump(started.error)
          started.error.dispose()
          return frameOf(
            new Cell.Rejected({
              code: "compile_failed",
              /* v8 ignore next -- QuickJS reports a compile failure as an Error object, so the `message` arm is what a parser disagreement takes; `String(failure)` only discharges the `unknown` `context.dump` is typed as */
              message: `The cell did not compile: ${
                typeof failure === "object" && failure !== null && "message" in failure
                  ? String((failure as { readonly message: unknown }).message)
                  : String(failure)
              }`
            })
          )
        }
        const cellHandle = started.value

        let settled: Cell.Outcome | undefined
        const poll = (): void => {
          runtime.executePendingJobs()
          if (exhausted !== undefined) {
            settled = exhausted
            return
          }
          const state = context.getPromiseState(cellHandle)
          if (state.type === "pending") return
          if (state.type === "fulfilled") {
            // A script's completion value is not a transition and is never read:
            // a REPL cell says what it wants by calling `ctx.done` or `ctx.park`,
            // and saying nothing asks for another frame.
            state.value.dispose()
            settled = replOutcome(recorded, justification)
            return
          }
          const error = context.dump(state.error)
          state.error.dispose()
          settled = raisedFrom(error)
        }

        const outcome = yield* Sandbox.driveCell({
          pending,
          flush: () => poll(),
          finished: () => {
            poll()
            if (settled !== undefined) return settled
            if (pending.length > 0) return undefined
            return new Cell.Rejected({
              code: "stalled",
              message:
                "The cell awaited something that never settles. Inside a cell the only thing worth awaiting is ctx.call."
            })
          },
          wait: Effect.void,
          abort: () => {
            for (const call of pending.splice(0)) call.abort("The cell was interrupted")
          },
          handler: (call) =>
            Effect.suspend(() => {
              const pausedAt = clock.now()
              return evaluation.call(call).pipe(
                Effect.onExit(() =>
                  Effect.sync(() => {
                    clockBase += clock.now() - pausedAt
                  })
                )
              )
            }),
          limits
        }).pipe(
          // A realm that outlives its frame accumulates whatever the frame left
          // live, and disposing one while a bridge promise is still pending
          // aborts inside QuickJS. So every frame closes its own leftovers:
          // queued bridges are settled, the job queue is drained once, and the
          // cell's promise handle is released here rather than at teardown.
          Effect.ensuring(
            Effect.sync(() => {
              /* v8 ignore next -- `driveCell` drains `pending` on every exit it controls, so this loop has work only when the frame is interrupted between two settled calls; no deterministic test can produce that interleaving, and without the guard such a frame would leave a live bridge handle in a realm that outlives it, which aborts inside QuickJS at disposal */
              for (const call of pending.splice(0)) call.abort("The cell was interrupted")
              runtime.executePendingJobs()
              cellHandle.dispose()
            })
          )
        )

        // The panel, read from the realm the cell just ran in. It shares the
        // frame's remaining budget, so a cell that spent all of its own leaves
        // the previous reading standing rather than an empty one — and so does
        // a cell that reassigned the reflection the probe reads through. The
        // panel is never wrong about what it says; it can only stop saying
        // anything new, which is the honest answer for a realm whose own
        // intrinsics a cell has replaced.
        const read = context.evalCode(probe)
        if (read.error === undefined) {
          bindings = decodeBindings(JSON.parse(context.getString(read.value)))
          read.value.dispose()
        } else {
          read.error.dispose()
        }
        return frameOf(outcome)
      }).pipe(
        Effect.timeoutOrElse({
          duration: totalMs,
          orElse: () =>
            Effect.succeed<Sandbox.RealmFrame>({
              outcome: timeLimitExceeded(totalMs),
              prints: "",
              bindings
            })
        })
      )

    return { evaluate }
  })

/**
 * Loads a QuickJS module through the sandbox's typed failure boundary.
 *
 * @category constructors
 * @since 0.1.0
 */
export const loadModule = (
  loader: () => Promise<QuickJSWASMModule>
): Effect.Effect<QuickJSWASMModule, Sandbox.SandboxError> =>
  Effect.tryPromise({
    try: loader,
    catch: (cause) =>
      new Sandbox.SandboxError({
        code: "runtime_failed",
        message: "QuickJS WebAssembly module could not be loaded",
        cause
      })
  })

/**
 * Constructs the QuickJS sandbox, compiling the WebAssembly module once.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeWithClock: Effect.Effect<Sandbox.Sandbox, Sandbox.SandboxError, ComputeClock> = Effect.gen(
  function*() {
    const clock = yield* ComputeClock
    const module = yield* loadModule(wasmModule)
    return Sandbox.make({
      capabilities,
      evaluate: (evaluation) => evaluate(module, evaluation, clock),
      openRealm: (options) => openRealm(module, options, clock)
    })
  }
)

/**
 * Constructs the QuickJS sandbox with the live clock layer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Sandbox.Sandbox, Sandbox.SandboxError> = makeWithClock.pipe(
  Effect.provide(layerClockLive)
)

/**
 * Provides the QuickJS sandbox.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<Sandbox.Sandbox, Sandbox.SandboxError> = Layer.effect(Sandbox.Sandbox)(make)
