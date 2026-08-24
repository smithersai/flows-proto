/**
 * The deterministic script sandbox port.
 *
 * A cell is arbitrary agent-authored JavaScript, so it never runs in the host
 * realm. It runs behind this port, which grants exactly one effectful
 * primitive — flow invocation against the capability-narrowed catalog the frame
 * was given — and returns a serializable {@link Cell.Outcome}.
 *
 * Two bindings ship: {@link layerRestricted}, a dependency-free deterministic
 * binding used by tests and by hosts that only need identifier-level denial,
 * and `QuickJSSandbox`, the QuickJS-WASM binding that isolates a real separate
 * realm in both Node and browsers.
 *
 * Cancellation is fiber interruption and teardown is scope finalization; a
 * sandbox never installs a host abort signal.
 *
 * @since 0.1.0
 */
import { Context, Effect, Exit, Layer, Schema, type Scope } from "effect"
import * as Cell from "./Cell.ts"
import * as CellValidation from "./CellValidation.ts"
import type { HarnessError } from "./HarnessError.ts"
import type * as VariablesPanel from "./VariablesPanel.ts"

/**
 * Stable failures raised by a sandbox binding itself, as opposed to failures
 * of the cell it was asked to run.
 *
 * A cell that throws is a {@link Cell.Raised} outcome, not a sandbox error.
 * These codes describe the sandbox being unable to do its job at all.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const SandboxErrorCode = Schema.Literals([
  "unavailable",
  "unsupported",
  "runtime_failed"
])

/**
 * Stable failures raised by a sandbox binding itself.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SandboxErrorCode = typeof SandboxErrorCode.Type

/**
 * A failure of the sandbox binding.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class SandboxError extends Schema.TaggedError<SandboxError>()("flows/harness/SandboxError", {
  code: SandboxErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * One flow invocation requested from inside a running cell.
 *
 * `ordinal` is the zero-based execution order of the call within the cell. It
 * is the replay anchor: re-executing the same source reaches the same ordinal
 * with the same declaration, which is what lets a settled boundary replay
 * instead of re-running.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Invocation {
  readonly ordinal: number
  readonly flow: string
  readonly input: Schema.Json
  /**
   * Whatever the cell passed as the call's `at` option, undecoded.
   *
   * It arrives as the raw JSON the cell wrote rather than as an id because the
   * boundary, not the realm, decides whether it is a checkpoint: a cell that
   * passes a string, a failure envelope, or last frame's result gets an
   * ordinary catchable `invalid_input` naming what `at` takes, instead of a
   * throw from inside the sandbox that would lose the calls the cell had
   * already paid for.
   */
  readonly at?: Schema.Json | undefined
}

/**
 * One request to pin the workspace, issued from inside a running cell.
 *
 * It carries only its ordinal because that is the whole of its identity: the
 * cell source and the frame are the boundary's, and the ordinal is what makes
 * the pin land where the cell wrote it. See {@link Minter}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Mint {
  readonly ordinal: number
}

/**
 * Pins the workspace on behalf of a running cell.
 *
 * A mint travels the same queue as a flow call and is settled by the same drive
 * loop, in issue order, one at a time. That ordering is the whole contract:
 * `ctx.checkpoint()` promises the tree as it stands *at the line it is written
 * on*, and the only way a cell can move the tree is by issuing a call, so a
 * queue that settles in issue order pins exactly the tree the cell was looking
 * at. A mint that runs on its own schedule — a side channel, a host callback,
 * anything the queue does not order — would pin whichever tree happened to be
 * there when it got round to it.
 *
 * The result is a {@link Cell.CallResult} like any other, so a host with no
 * store, a run past its checkpoint bound, and a store that failed are all
 * catchable refusals rather than teardown.
 *
 * @category models
 * @since 0.1.0
 */
export type Minter = (mint: Mint) => Effect.Effect<Cell.CallResult, HarnessError>

/**
 * The refusal a binding answers `ctx.checkpoint()` with when the caller wired
 * no minter.
 *
 * @category constructors
 * @since 0.1.0
 */
export const mintUnavailable: Minter = () =>
  Effect.succeed(
    new Cell.CallResult({
      outcome: "failure",
      value: null,
      code: "checkpoint_unavailable",
      message: "This run pins no checkpoints."
    })
  )

/**
 * Resolves one invocation on behalf of a running cell.
 *
 * A {@link Cell.CallResult} of `failure` is returned to the cell as a catchable
 * exception. Anything the cell must not observe — a permission park, an abort,
 * an engine failure — travels in the error channel and tears the cell down.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Handler = (
  invocation: Invocation
) => Effect.Effect<Cell.CallResult, HarnessError>

/**
 * Execution limits for one cell evaluation.
 *
 * Bindings fill every ceiling they can enforce from {@link defaultLimits} when
 * the caller omits it. A binding that cannot honour an explicitly requested
 * limit fails with `unsupported` rather than silently ignoring it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Limits {
  /** Maximum number of flow calls one cell may make; a non-negative safe integer. */
  readonly calls?: number | undefined
  /** Maximum sandbox heap, in bytes; at least {@link minimumMemoryBytes}. */
  readonly memoryBytes?: number | undefined
  /**
   * Maximum interpreter steps before the cell is stopped.
   *
   * A step is one interrupt check, not one bytecode operation: an interpreter
   * polls its budget periodically, so this bounds work rather than counting
   * individual operations. The limit is a non-negative safe integer.
   */
  readonly steps?: number | undefined
  /**
   * Maximum cell-compute time in milliseconds; a non-negative safe integer.
   *
   * This bounds the cell's own JavaScript execution. Time spent suspended in
   * an outstanding `ctx.call` does not count: a host call's duration belongs
   * to the flow that runs it, and charging it here rejected every cell that
   * awaited a real test run — 57 of the 62 rejected frames in the first
   * SWE-bench benchmark were legitimate long `bash` calls hitting this clock.
   */
  readonly timeMs?: number | undefined
  /**
   * Maximum whole-evaluation time in milliseconds, host calls included; a
   * non-negative safe integer.
   *
   * The backstop for a host call that never settles. Generous on purpose: a
   * cell awaiting a ten-minute test suite is working, not stuck.
   */
  readonly totalMs?: number | undefined
  /**
   * Maximum wall-clock time one flow call may take, in milliseconds; a
   * non-negative safe integer.
   *
   * The per-call budget {@link totalMs} cannot supply. `totalMs` is the frame's
   * last resort, and a call that overruns it takes the whole frame down with a
   * `limit_exceeded` rejection the model never sees as an answer: on the
   * SWE-bench django instance one broad `grep` held its cell for the entire
   * 900,000 ms ceiling, 75% of a 1,204-second run. This ceiling settles that
   * same call as an ordinary catchable failure instead, so the cell observes a
   * timeout it can narrow and retry inside the frame it is already in.
   */
  readonly callMs?: number | undefined
}

/**
 * Which limits a binding can actually enforce.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Capabilities {
  readonly calls: boolean
  readonly memoryBytes: boolean
  readonly steps: boolean
  readonly timeMs: boolean
}

/**
 * The execution ceilings a cell runs under when the caller declares none.
 *
 * Agent-authored source must never acquire an unbounded frame merely because a
 * host omitted configuration. These values are deliberately generous for a
 * cell, whose work is choosing flow calls and shaping JSON between them. There
 * is no spelling for "no ceiling": a host that needs more raises the relevant
 * finite value explicitly.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultLimits = Object.freeze({
  calls: 64,
  memoryBytes: 128 * 1024 * 1024,
  steps: 1000,
  timeMs: 30_000,
  totalMs: 900_000,
  callMs: 120_000
})

/**
 * Smallest heap ceiling the QuickJS binding can initialize and tear down
 * safely.
 *
 * QuickJS needs space for its runtime and context before cell source runs.
 * Lower ceilings can leave a partially initialized context that aborts during
 * disposal, so they are refused at the sandbox boundary.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const minimumMemoryBytes = 1024 * 1024

/**
 * How much of one frame's whole print buffer reaches the next model turn.
 *
 * This is the only ceiling on the channel. A frame's statements *share* it:
 * each is middle-elided to the share it is apportioned, and a statement short
 * of its share hands the remainder back to the statements that are over theirs.
 *
 * They used to cap independently at 4 KiB each, head-first, and the r95repl
 * lane priced that: 197 of its 357 printing frames had a statement cut, 191 of
 * them while this frame budget sat mostly unspent, and 3.06 MB went to
 * per-statement caps against 6 frames that ever reached this one. The
 * `sympy__sympy-13878` run fused one `console.log` of 38,928 bytes; it was
 * shown the first 4,096 and lost the tail, which held the result of a
 * three-minute test suite the frame had already paid for. It ran that suite
 * again four frames later. Sharing the budget shows that frame 16 KiB from both
 * ends instead of 4 KiB from the head, and moves no ceiling: 16 KiB was the
 * most a frame could ever deliver before, and it is the most now.
 *
 * Every elision is from the middle with the dropped byte count stated, because
 * the head and the tail of a log are where it identifies itself, and the notices
 * are reserved out of this budget before any of it is apportioned — so the
 * assembled buffer is bounded outright and nothing has to shorten it a second
 * time. Sized against the `recall` budget it replaces, and delivered once rather
 * than re-rendered every frame.
 *
 * @category constants
 * @since 0.1.0
 */
export const printFrameBytes = 16 * 1024

/**
 * The smallest share of {@link printFrameBytes} one print statement is given.
 *
 * A share below this is all notice and no value — a middle elision of 80 bytes
 * says less than the sentence explaining it — so a frame that printed more
 * statements than the budget can floor drops whole statements from the middle
 * and states how many, rather than cutting every one of them to nothing. That
 * is the same shape the frame bound already had, applied a statement at a time
 * so nothing is cut mid-line.
 *
 * It bounds how many statements are *kept*, but it is not a division of the
 * budget: how many a frame can carry is priced off the statements it actually
 * printed, so a statement at or under this size is shown whole and costs only
 * itself. Two hundred eight-byte lines cost eighteen hundred bytes and all two
 * hundred survive; sixty statements of four times this size do not, and whole
 * ones go from the middle rather than every one of them being cut to a notice.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const printStatementFloor = 512

/**
 * How much of one frame's print buffer the host keeps while the cell still runs.
 *
 * {@link printFrameBytes} bounds what the model is shown; this bounds what the
 * host holds to show it from, and the two are different numbers because they
 * answer different questions. A cell printing in a loop hands the host one
 * payload per statement, and every payload is copied out of the sandbox's heap
 * and decoded before anything can judge it surplus, so the frame budget alone
 * bounds the answer while leaving the work unbounded. Sixteen times the frame
 * budget is far past any honest use and still a fixed ceiling: past it the
 * payload is not read at all, and the count of what went unread is stated in the
 * buffer rather than dropped in silence.
 *
 * A statement is held at no more than {@link printFrameBytes} — the two ends of
 * it, with the size it had — because a whole frame's budget is the most any one
 * statement could ever be shown. So this ceiling holds at least sixteen
 * statements whatever a cell prints, and a cell that prints many small values
 * reaches it only after hundreds of them.
 *
 * @category constants
 * @since 0.1.0
 */
export const printRetainedBytes = 256 * 1024

const invalidLimit = (name: keyof Limits, requirement: string): SandboxError =>
  new SandboxError({
    code: "unsupported",
    message: `The ${name} limit must be ${requirement}`
  })

/** Validates caller-supplied numeric limits before a binding is entered. */
const validateLimits = (limits: Limits | undefined): SandboxError | undefined => {
  if (limits === undefined) return undefined

  for (const name of ["calls", "steps", "timeMs", "totalMs", "callMs"] as const) {
    const value = limits[name]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      return invalidLimit(name, "a non-negative safe integer")
    }
  }

  if (
    limits.memoryBytes !== undefined &&
    (!Number.isSafeInteger(limits.memoryBytes) || limits.memoryBytes < minimumMemoryBytes)
  ) {
    return invalidLimit(
      "memoryBytes",
      `a safe integer of at least ${minimumMemoryBytes} bytes`
    )
  }

  return undefined
}

/**
 * Fills omitted ceilings from {@link defaultLimits} for limits a binding can
 * enforce.
 *
 * Capability gating applies only to defaults. An explicit unsupported limit is
 * passed through so the binding can refuse it instead of silently widening the
 * caller's authority.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const withDefaults = (
  capabilities: Capabilities,
  limits: Limits | undefined
): Limits => ({
  ...limits,
  ...(capabilities.memoryBytes && limits?.memoryBytes === undefined
    ? { memoryBytes: defaultLimits.memoryBytes }
    : {}),
  ...(capabilities.steps && limits?.steps === undefined ? { steps: defaultLimits.steps } : {}),
  ...(capabilities.calls && limits?.calls === undefined ? { calls: defaultLimits.calls } : {}),
  ...(capabilities.timeMs && limits?.timeMs === undefined ? { timeMs: defaultLimits.timeMs } : {}),
  ...(capabilities.timeMs && limits?.totalMs === undefined ? { totalMs: defaultLimits.totalMs } : {}),
  // Gated on `calls` rather than on `timeMs`: the per-call budget is enforced
  // by the shared drive loop, which is exactly the loop a binding that queues
  // flow calls runs, and not by the interpreter clock `timeMs` describes.
  ...(capabilities.calls && limits?.callMs === undefined ? { callMs: defaultLimits.callMs } : {})
})

/**
 * One cell evaluation request.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Evaluation {
  readonly cell: Cell.Source
  readonly flows: Readonly<Record<string, Cell.FlowProjection>>
  readonly call: Handler
  /**
   * The agent-owned durable state, exposed to the cell as the frozen
   * `ctx.state` binding.
   *
   * Prior art is Prime Agent's persistent kernel: the model's working data
   * lives in a binding it can read, and the transcript carries a view. Here
   * the binding is the replay-safe equivalent — the same journaled JSON the
   * previous frame returned, injected as a value instead of prose the model
   * had to re-parse out of its own context.
   */
  readonly state?: Schema.Json | undefined
  /**
   * Settles a `ctx.checkpoint()` issued by this cell.
   *
   * Optional, and absent means the caller pins no trees — which the cell is
   * told, catchably, at the line it asked. It is a separate collaborator from
   * `call` because a checkpoint is not a flow: it is neither in the catalog nor
   * subject to the capability envelope, and the run's own bound on how many
   * trees it may pin is the controller's, not any flow's.
   */
  readonly mint?: Minter | undefined
  readonly limits?: Limits | undefined
}

/**
 * What a REPL cell asked the controller to do.
 *
 * `return` is a syntax error at the top level of a global script — measured, on
 * the variant this harness ships — so a REPL cell states its intent by calling
 * `ctx.done` or `ctx.park` instead of returning a transition. Both record and
 * let the script run on; the last call wins.
 *
 * @category models
 * @since 0.1.0
 */
export type Intent =
  | { readonly _tag: "Done"; readonly output: string }
  | {
    readonly _tag: "Park"
    readonly reason: "waiting-input" | "waiting-event" | "waiting-quota"
    readonly message: string
  }

/**
 * Builds the durable transition one REPL cell settled.
 *
 * The recorded {@link Cell.Transition} shape is unchanged, so one journal
 * decodes both modes and every projection over it reads both. REPL mode simply
 * never populates `state`, `context`, `render` or `recall`: the realm is the
 * memory and the print buffer is the projection.
 *
 * @category constructors
 * @since 0.1.0
 */
export const replTransition = (
  intent: Intent | undefined,
  justification: string | undefined
): Cell.Transition => {
  if (intent === undefined) {
    return new Cell.Continue({
      state: null,
      context: [],
      render: undefined,
      recall: undefined,
      justification
    })
  }
  return intent._tag === "Done"
    ? new Cell.Complete({ state: null, output: intent.output, reason: undefined })
    : new Cell.Park({ state: null, reason: intent.reason, message: intent.message })
}

/**
 * One cell evaluated inside a realm that outlives it.
 *
 * `frame` names the evaluation for the realm's own stack traces, so a throw
 * reported in frame 7 says which cell threw.
 *
 * @category models
 * @since 0.1.0
 */
export interface RealmEvaluation {
  readonly cell: Cell.Source
  readonly frame: number
  readonly call: Handler
  /** Settles a `ctx.checkpoint()`; see {@link Evaluation.mint}. */
  readonly mint?: Minter | undefined
  readonly limits?: Limits | undefined
}

/**
 * Everything one REPL frame produced.
 *
 * @category models
 * @since 0.1.0
 */
export interface RealmFrame {
  readonly outcome: Cell.Outcome
  /** What the cell printed, already bounded; empty when it printed nothing. */
  readonly prints: string
  /** Every name the realm holds after the cell ran. */
  readonly bindings: ReadonlyArray<VariablesPanel.Binding>
}

/**
 * A JavaScript realm that persists across the cells of one run.
 *
 * Teardown is scope closure, so a realm is acquired by the loop that uses it and
 * cancellation is still fiber interruption.
 *
 * @category services
 * @since 0.1.0
 */
export interface Realm {
  readonly evaluate: (
    evaluation: RealmEvaluation
  ) => Effect.Effect<RealmFrame, SandboxError | HarnessError>
}

/**
 * What a realm is opened with, which is everything that is fixed for the run.
 *
 * @category models
 * @since 0.1.0
 */
export interface RealmOptions {
  readonly flows: Readonly<Record<string, Cell.FlowProjection>>
  /**
   * The ceilings the realm enforces. `memoryBytes` becomes a **run** budget once
   * a realm outlives a cell, judged at each frame's start against what the
   * realm's own names weigh; a frame that opens over it runs nothing and is told
   * which names to free. Every other ceiling stays per-frame, because they are
   * counters the interrupt handler reads rather than properties of the runtime.
   */
  readonly limits?: Limits | undefined
}

/**
 * The deterministic script sandbox.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Sandbox {
  readonly capabilities: Capabilities
  readonly evaluate: (
    evaluation: Evaluation
  ) => Effect.Effect<Cell.Outcome, SandboxError | HarnessError>
  /**
   * Opens a realm that persists across cells, for a run armed in REPL mode.
   *
   * Absent on a binding that has no persistent realm to offer, which is what a
   * host asking for REPL mode against such a binding is told.
   */
  readonly openRealm?: (
    options: RealmOptions
  ) => Effect.Effect<Realm, SandboxError, Scope.Scope>
}

/**
 * Context service for the selected sandbox binding.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const Sandbox: Context.Service<Sandbox, Sandbox> = Context.Service("/harness/Sandbox")

/**
 * Constructs a sandbox from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Sandbox): Sandbox => {
  const openRealm = implementation.openRealm
  return Sandbox.of({
    ...implementation,
    evaluate: (evaluation) => {
      const invalid = validateLimits(evaluation.limits)
      if (invalid !== undefined) return Effect.fail(invalid)
      return implementation.evaluate({
        ...evaluation,
        limits: withDefaults(implementation.capabilities, evaluation.limits)
      })
    },
    ...(openRealm === undefined ? {} : {
      openRealm: (options: RealmOptions) => {
        const invalid = validateLimits(options.limits)
        return invalid !== undefined ? Effect.fail(invalid) : openRealm({
          ...options,
          limits: withDefaults(implementation.capabilities, options.limits)
        })
      }
    })
  })
}

/**
 * Provides a sandbox implementation.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (implementation: Sandbox): Layer.Layer<Sandbox> => Layer.succeed(Sandbox)(make(implementation))

/**
 * Constructs an unavailable sandbox stub, optionally overriding operations.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Sandbox> = {}): Sandbox =>
  Sandbox.of({
    capabilities: { calls: false, memoryBytes: false, steps: false, timeMs: false },
    evaluate: () =>
      Effect.fail(
        new SandboxError({
          code: "unavailable",
          message: "No sandbox implementation is configured"
        })
      ),
    ...overrides
  })

/**
 * Provides an unavailable sandbox stub.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Sandbox> = {}): Layer.Layer<Sandbox> =>
  Layer.succeed(Sandbox)(makeNoop(overrides))

/**
 * Rejects an unsupported limit rather than pretending to honour it.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const unsupportedLimit = (limit: string): SandboxError =>
  new SandboxError({
    code: "unsupported",
    message: `This sandbox cannot enforce the ${limit} limit; remove it or select a binding that can`
  })

/**
 * Refuses REPL mode on a binding that has no persistent realm.
 *
 * Stated rather than silently downgraded: a run armed for one surface and
 * served another would be a benchmark arm measuring the wrong thing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const realmUnsupported: SandboxError = new SandboxError({
  code: "unsupported",
  message:
    "This sandbox has no persistent realm, so it cannot run a cell loop in repl mode; select the QuickJS binding or arm filing mode"
})

/**
 * A queued call awaiting resolution by the driver.
 *
 * @private
 */
interface Pending {
  readonly ordinal: number
  readonly flow: string
  readonly input: Schema.Json
  /** Undecoded `at` option; see {@link Invocation.at}. */
  readonly at?: Schema.Json | undefined
  /**
   * Whether this entry is a flow call or a request to pin the tree.
   *
   * Both ride one queue because both have to be ordered against each other: a
   * mint that overtook an edit, or an edit that overtook a mint, would pin the
   * wrong tree. Absent means `call`, so every binding that queues an ordinary
   * call is unchanged.
   */
  readonly kind?: "call" | "checkpoint" | undefined
  readonly settle: (result: Cell.CallResult) => void
  readonly abort: (message: string) => void
}

const seconds = (milliseconds: number): string => {
  const value = milliseconds / 1_000
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "")
}

/**
 * Settles one overrunning flow call as a catchable failure.
 *
 * The message is written for the model, because the model is who reads it: it
 * names the flow, the budget it spent, and the one action that recovers the
 * frame. A rejection at the whole-evaluation ceiling teaches the model nothing
 * — the frame is already gone by the time it could act.
 *
 * @private
 */
const callTimedOut = (flow: string, callMs: number): Cell.CallResult =>
  new Cell.CallResult({
    outcome: "failure",
    value: null,
    code: "timeout",
    message: `Flow ${flow} timed out after ${seconds(callMs)} seconds.`
  })

/**
 * The state a binding's driver loop observes.
 *
 * Bindings differ only in how a cell is compiled and how its promises are
 * settled; the interleaving of "drain queued calls, then wait" is identical,
 * so it lives here once.
 *
 * @private
 */
interface Pump {
  readonly pending: Array<Pending>
  /** Called after each resolved call so a binding may flush its job queue. */
  readonly flush: () => void
  readonly finished: () => Cell.Outcome | undefined
  readonly wait: Effect.Effect<void>
  readonly abort: (message: string) => void
}

/**
 * Runs the shared drive loop: settle queued calls one at a time, in the order
 * the cell issued them, until the cell settles.
 *
 * One at a time is deliberate. Data-dependent calls are the normal case, and a
 * deterministic execution ordinal is what makes a mid-cell crash replayable.
 *
 * @private
 */
const drive = (
  pump: Pump,
  handler: Handler,
  minter: Minter,
  limits: Limits | undefined
): Effect.Effect<Cell.Outcome, SandboxError | HarnessError> =>
  Effect.gen(function*() {
    let calls = 0
    for (;;) {
      const next = pump.pending.shift()
      if (next !== undefined) {
        if (limits?.calls !== undefined && calls >= limits.calls) {
          const message = `This cell exceeded its limit of ${limits.calls} flow calls`
          next.abort(message)
          pump.abort(message)
          pump.flush()
          return new Cell.Rejected({ code: "limit_exceeded", message })
        }
        calls = calls + 1
        const callMs = limits?.callMs ?? defaultLimits.callMs
        // A mint is settled here rather than on a channel of its own so that it
        // is ordered against the calls around it. See `Minter`.
        const settling = next.kind === "checkpoint"
          ? minter({ ordinal: next.ordinal })
          : handler({
            ordinal: next.ordinal,
            flow: next.flow,
            input: next.input,
            ...(next.at === undefined ? {} : { at: next.at })
          })
        const result = yield* settling.pipe(
          // The per-call ceiling, ahead of the interrupt cleanup below: a call
          // that overruns is answered, not abandoned, so the cell sees a
          // catchable failure and the frame keeps its remaining budget.
          Effect.timeoutOrElse({
            duration: callMs,
            orElse: () => Effect.succeed(callTimedOut(next.flow, callMs))
          }),
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.sync(() => {
                // `next` was shifted out of `pending` before the handler ran.
                // Settle that active bridge as well as calls queued behind it,
                // then flush the VM so a scoped runtime has no live promise
                // handles when a permission park or engine failure unwinds it.
                next.abort("The cell was interrupted")
                pump.abort("The cell was interrupted")
                pump.flush()
              })
          )
        )
        next.settle(result)
        pump.flush()
        continue
      }
      const outcome = pump.finished()
      if (outcome !== undefined) return outcome
      yield* pump.wait
    }
  })

const makeLatch = (): Latch => {
  let notify: (() => void) | undefined
  return {
    wake: () => {
      const resume = notify
      notify = undefined
      resume?.()
    },
    wait: Effect.callback<void>((resume) => {
      notify = () => resume(Effect.void)
    })
  }
}

/**
 * The bindings every cell may reference, with every nondeterministic and
 * ambient-authority global deliberately absent.
 *
 * `Date` and `Math.random` are omitted because a replayed cell must produce the
 * same calls in the same order. Everything host-shaped — `fetch`,
 * `globalThis`, `process`, `require`, `WebAssembly` — is omitted because the
 * cell's only authority is `ctx.call`.
 *
 * @private
 */
const deterministicMath: Readonly<Record<string, unknown>> = Object.freeze(
  Object.fromEntries(
    Object.getOwnPropertyNames(Math)
      .filter((name) => name !== "random")
      .map((name) => [name, Math[name as keyof Math]])
  )
)

const allowedGlobals: Readonly<Record<string, unknown>> = Object.freeze({
  Array,
  ArrayBuffer,
  BigInt,
  Boolean,
  DataView,
  Error,
  EvalError,
  Infinity,
  JSON,
  Map,
  Math: deterministicMath,
  NaN,
  Number,
  Object,
  Promise,
  RangeError,
  ReferenceError,
  RegExp,
  Set,
  String,
  Symbol,
  SyntaxError,
  TypeError,
  URIError,
  WeakMap,
  WeakSet,
  decodeURI,
  decodeURIComponent,
  encodeURI,
  encodeURIComponent,
  isFinite,
  isNaN,
  parseFloat,
  parseInt,
  undefined
})

/**
 * The receiver a cell body is invoked with, so `this` reaches nothing.
 *
 * @private
 */
const hostless: object = Object.freeze(Object.create(null) as object)

const denied = (name: string): never => {
  throw new ReferenceError(
    `${name} is not available inside a cell. The only binding is ctx; every effect is a flow call through ctx.call.`
  )
}

/**
 * Erases type-only syntax from a cell without evaluating or resolving modules.
 *
 * Only Node's strip-safe TypeScript subset is accepted. Constructs that need
 * JavaScript emit are refused instead of being silently transformed into new
 * runtime behaviour.
 *
 * The parse itself belongs to `CellValidation`, which the controller already
 * runs at the boundary before it commits a frame; this is the same answer, for
 * a binding that only needs the program or the reason there is none.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const compile = (cell: Cell.Source, mode: Cell.Mode = Cell.defaultMode): string | Cell.Rejected => {
  const validation = CellValidation.validate(cell, mode)
  /* v8 ignore next -- `validate` returns exactly one of the two, so the coalesce never reaches its fallback; it only discharges the optional types the interface declares */
  return validation.rejected ?? validation.compiled ?? cell.text
}

/**
 * Builds the frozen `ctx` binding handed to one cell.
 *
 * @private
 */
const deepFreeze = (value: unknown): unknown => {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

const makeContext = (
  flows: Readonly<Record<string, Cell.FlowProjection>>,
  enqueue: (flow: string, input: Schema.Json, at: Schema.Json | undefined) => Promise<unknown>,
  mint: () => Promise<unknown>,
  state: Schema.Json | undefined
): Readonly<Record<string, unknown>> => {
  const catalog: Record<string, unknown> = {}
  for (const [name, projection] of Object.entries(flows)) {
    catalog[name] = Object.freeze({
      name: projection.name,
      description: projection.description,
      capabilities: Object.freeze([...projection.capabilities]),
      tier: projection.tier
    })
  }
  const dispatch = (flow: string, input: unknown, at: Schema.Json | undefined): Promise<unknown> => {
    const decoded = Schema.decodeUnknownResult(Schema.Json)(input ?? null)
    return decoded._tag === "Failure"
      ? Promise.reject(new TypeError("ctx.call input must be JSON-serializable"))
      : enqueue(flow, decoded.success, at)
  }
  return Object.freeze({
    call: (flow: unknown, input: unknown, options?: unknown): Promise<unknown> => {
      if (typeof flow !== "string") {
        return Promise.reject(new TypeError("ctx.call expects a flow name as its first argument"))
      }
      const at = options === null || typeof options !== "object"
        ? undefined
        : (options as { readonly at?: unknown }).at
      if (at === undefined) return dispatch(flow, input, undefined)
      // A handle a cell holds without awaiting is a promise, and `ctx.checkpoint()`
      // is deliberately usable that way — the pin lands where the cell wrote it,
      // not where the cell awaits it. Both spellings are therefore accepted, and
      // the boundary judges whatever the promise settles with.
      const settled = typeof (at as { readonly then?: unknown }).then === "function"
        ? Promise.resolve(at as PromiseLike<unknown>)
        : Promise.resolve(at)
      return settled.then((resolved) => {
        const decodedAt = Schema.decodeUnknownResult(Schema.Json)(resolved ?? null)
        return dispatch(
          flow,
          input,
          /* v8 ignore next -- `at` reaches here as whatever the cell wrote, and a value JSON cannot hold is passed on as `null` so the boundary answers it as `invalid_input`; the failure arm exists to discharge the Result type */
          decodedAt._tag === "Failure" ? null : decodedAt.success
        )
      })
    },
    checkpoint: (): Promise<unknown> => mint(),
    base: Object.freeze(Cell.checkpoint(Cell.baseCheckpoint)),
    flows: Object.freeze(catalog),
    // The previous frame's returned state, cloned so a cell can never reach
    // the harness's copy, frozen so the binding reads as memory, not a slot.
    state: deepFreeze(state === undefined ? null : JSON.parse(JSON.stringify(state)))
  })
}

/**
 * The failure a cell threw, projected into stable serializable text.
 *
 * @private
 */
const raised = (error: unknown): Cell.Raised => {
  if (error instanceof Error) {
    return new Cell.Raised({ name: error.name, message: error.message })
  }
  return new Cell.Raised({ name: "Error", message: describe(error) })
}

/**
 * Renders a thrown non-`Error` as the value it is.
 *
 * `String(value)` on an object is `[object Object]`, which is the single
 * defect PROGRAM change 1 names verbatim: a run that threw a structured value
 * was told nothing about it and spent a frame going back for the same value.
 * Anything JSON can hold is rendered as JSON; anything it cannot — a symbol, a
 * function — keeps `String`, which is the only faithful thing left.
 *
 * @private
 */
const describe = (value: unknown): string => {
  const decoded = Schema.decodeUnknownResult(Schema.Json)(value)
  return decoded._tag === "Success" ? Cell.renderText(decoded.success) : String(value)
}

/**
 * Constructs the dependency-free deterministic sandbox.
 *
 * The cell is compiled into an async function whose entire scope is a proxy
 * that resolves only {@link allowedGlobals} and `ctx`; every other identifier
 * throws a `ReferenceError` at the point of use. That denies ambient time,
 * randomness, network, filesystem, process, and module access by identifier,
 * which is exactly what the deterministic contract needs and all a
 * same-realm binding can honestly claim.
 *
 * A `with` block only works in sloppy mode, and a sloppy-mode function called
 * without a receiver binds `this` to the host's `globalThis` — which would hand
 * every cell `this.process` for free, past the scope proxy entirely. The cell
 * body is therefore a plain async function invoked with an explicit
 * null-prototype receiver, so `this` denies the same things every identifier
 * does.
 *
 * It is *not* an isolation boundary: same-realm JavaScript can still reach the
 * host `Function` constructor through a prototype chain. Hosts that execute
 * untrusted cells use the QuickJS binding, which is a separate realm.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeRestricted = (): Sandbox =>
  Sandbox.of({
    capabilities: { calls: true, memoryBytes: false, steps: false, timeMs: false },
    evaluate: (evaluation) =>
      Effect.gen(function*() {
        if (evaluation.limits?.memoryBytes !== undefined) return yield* unsupportedLimit("memory")
        if (evaluation.limits?.steps !== undefined) return yield* unsupportedLimit("step")
        if (evaluation.limits?.timeMs !== undefined) return yield* unsupportedLimit("time")
        if (evaluation.limits?.totalMs !== undefined) return yield* unsupportedLimit("whole-evaluation time")
        const compiled = compile(evaluation.cell)
        if (compiled instanceof Cell.Rejected) return compiled

        const latch = makeLatch()
        const pending: Array<Pending> = []
        let ordinal = 0
        let aborted: string | undefined
        let settled: Cell.Outcome | undefined

        const queue = (
          kind: "call" | "checkpoint",
          flow: string,
          input: Schema.Json,
          at: Schema.Json | undefined
        ): Promise<unknown> => {
          if (aborted !== undefined) return Promise.reject(new Error(aborted))
          return new Promise<unknown>((resolve, reject) => {
            pending.push({
              ordinal: ordinal++,
              flow,
              input,
              kind,
              ...(at === undefined ? {} : { at }),
              // A failed call resolves; it does not throw. See
              // {@link Cell.callFailure}. An *abort* still rejects: that is
              // teardown, not a result, and a cell must unwind rather than
              // branch on it.
              settle: (result) => resolve(result.outcome === "success" ? result.value : Cell.callFailure(result)),
              abort: (message) => reject(new Error(message))
            })
            latch.wake()
          })
        }
        const enqueue = (flow: string, input: Schema.Json, at: Schema.Json | undefined): Promise<unknown> =>
          queue("call", flow, input, at)
        // The pin is queued where the cell wrote the call, so a checkpoint the
        // cell never awaits still names the tree at that line. `checkpoint` is
        // the flow name only so an overrun reads as one; nothing resolves it.
        const mint = (): Promise<unknown> => queue("checkpoint", "checkpoint", null, undefined)

        const context = makeContext(evaluation.flows, enqueue, mint, evaluation.state)
        const scope = new Proxy({}, {
          has: () => true,
          get: (_target, property) => {
            if (property === Symbol.unscopables) return undefined
            /* v8 ignore next -- a `with` binding resolves identifiers, which are strings, and the one symbol it consults is handled above; the guard is what keeps the branch below honest about the type it reads, and the only cell that ever reached it escaped the wrapper, which the boundary parse now refuses */
            if (typeof property !== "string") return undefined
            if (property === "ctx") return context
            if (Object.hasOwn(allowedGlobals, property)) return allowedGlobals[property]
            return denied(property)
          },
          set: (_target, property) => denied(String(property))
        })

        let cell: (scope: object, receiver: object) => Promise<unknown>
        try {
          // The cell is agent source; the scope proxy is the only binding it has.
          cell = new Function(
            "__scope",
            "__this",
            `return (async function () { with (__scope) {\n${compiled}\n} }).call(__this)`
          ) as (scope: object, receiver: object) => Promise<unknown>
        } catch (cause) {
          return new Cell.Rejected({
            code: "compile_failed",
            /* v8 ignore next -- the `Function` constructor rejects unparseable source with a `SyntaxError` and raises nothing else, so `cause` is always an `Error`; the `String` arm only discharges the `unknown` a `catch` binding is typed as */
            message: `The cell did not compile: ${cause instanceof Error ? cause.message : String(cause)}`
          })
        }

        yield* Effect.sync(() => {
          let started: Promise<unknown>
          try {
            started = cell(scope, hostless)
          } catch (cause) {
            // `cell` is an async function, so it settles its rejection
            // through the promise below rather than throwing synchronously;
            // the only way to throw here was a cell that closed the wrapper
            // and ran at the top level, which the boundary parse now refuses
            // as the syntax error it is. Each line carries its own directive:
            // a start/stop range would hide the whole region behind a single
            // allowlist count, which `packages/flows` forbids outright.
            /* v8 ignore next -- unreachable, see above */
            settled = raised(cause)
            /* v8 ignore next -- unreachable, see above */
            latch.wake()
            /* v8 ignore next -- unreachable, see above */
            return
          }
          started.then(
            (value) => {
              settled = Cell.transition(value)
              latch.wake()
            },
            (cause) => {
              settled = raised(cause)
              latch.wake()
            }
          )
        })

        return yield* drive(
          {
            pending,
            flush: () => {},
            finished: () => settled,
            wait: latch.wait,
            abort: (message) => {
              aborted = message
              for (const item of pending.splice(0)) item.abort(message)
            }
          },
          evaluation.call,
          evaluation.mint ?? mintUnavailable,
          evaluation.limits
        )
      })
  })

/**
 * Provides the dependency-free deterministic sandbox.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerRestricted: Layer.Layer<Sandbox> = Layer.sync(Sandbox)(() => makeRestricted())

/**
 * A queued call awaiting resolution by a binding's driver.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type PendingCall = Pending

/**
 * A wake-up latch shared between a binding's driver loop and its cell.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Latch {
  readonly wake: () => void
  readonly wait: Effect.Effect<void>
}

/**
 * Creates the wake-up latch a binding's driver waits on.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const latch = (): Latch => makeLatch()

/**
 * Drives one externally compiled cell to settlement.
 *
 * Exposed so a separate-realm binding reuses the exact interleaving the
 * restricted binding uses — settle queued calls one at a time, in issue order,
 * until the cell settles — instead of reimplementing it.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const driveCell = (options: {
  readonly pending: Array<Pending>
  readonly flush: () => void
  readonly finished: () => Cell.Outcome | undefined
  readonly wait: Effect.Effect<void>
  readonly abort: (message: string) => void
  readonly handler: Handler
  /** Settles a `ctx.checkpoint()`; omitted means the run pins none. */
  readonly mint?: Minter | undefined
  readonly limits?: Limits | undefined
}): Effect.Effect<Cell.Outcome, SandboxError | HarnessError> =>
  drive(
    {
      pending: options.pending,
      flush: options.flush,
      finished: options.finished,
      wait: options.wait,
      abort: options.abort
    },
    options.handler,
    options.mint ?? mintUnavailable,
    options.limits
  )

/**
 * Projects a thrown value into a stable serializable cell outcome.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const raisedOutcome = (error: unknown): Cell.Raised => raised(error)
