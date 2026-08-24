/**
 * Running one cell call against a pinned tree instead of the live one.
 *
 * `@smthrs/harness` decides *whether* a call may name a checkpoint: it mints
 * the handle, bounds how many a run may hold, refuses a mutating flow at one,
 * and folds the checkpoint into the call's key so a reading of the pinned tree
 * can never replay as a reading of the live one. Nothing in it knows what a
 * tree is. This is the other half — the decorator that takes a call carrying an
 * `at`, asks the store for that tree as a directory, points the call at it, and
 * gives the directory back when the call ends.
 *
 * It is a {@link FlowEngineLike.CallRunner} decorator rather than an option on
 * the runner, for the reason {@link FlowEngineLike.sandboxed} is one: it
 * composes with whatever else the host has wrapped its calls in, and a host
 * that pins nothing simply does not wrap.
 *
 * The live tree is never touched. That is not a property of the flows being
 * careful — it is a property of where they run: the call is pointed at a
 * detached worktree, so even a shell command that writes without declaring it
 * writes into the scratch checkout, which is removed when the call ends. The
 * declared-write refusal in the controller is the honest half of the same rule
 * stated where the model can read it.
 *
 * Governing design: `docs/specs/Concepts/Checkpoints.md`.
 *
 * @since 0.1.0
 */
import * as Cell from "@smthrs/harness/Cell"
import type { HarnessError } from "@smthrs/harness/HarnessError"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import { Effect, Option } from "effect"
import type * as FlowEngineLike from "./FlowEngineLike.ts"

/** A refusal the cell observes as an ordinary catchable failure. */
const refused = (code: Cell.CallFailureCode, message: string): Cell.CallResult =>
  new Cell.CallResult({ outcome: "failure", value: null, code, message })

/**
 * The refusal a flow that cannot be pointed at a tree answers with.
 *
 * It names the two flows that can, because a code without a next action costs
 * the run a frame working out what to do instead.
 *
 * @category constructors
 * @since 0.1.0
 */
export const unsupported = (flow: string): Cell.CallResult =>
  refused(
    "checkpoint_unsupported",
    `Flow ${flow} names what it touches rather than where it runs, so it cannot be pointed at a checkpoint. Nothing ran. Take the reading with a shell call at the same checkpoint, or drop at and read the live tree.`
  )

/**
 * The refusal an absolute path answers with.
 *
 * @category constructors
 * @since 0.1.0
 */
export const absolute = (flow: string, path: string): Cell.CallResult =>
  refused(
    "checkpoint_unsupported",
    `Flow ${flow} was given the absolute path ${path}, and a checkpoint is a tree rather than a place on this machine, so there is nothing to resolve it against. Nothing ran. Name the path relative to the repository root and call it again.`
  )

/**
 * Runs one cell call against the checkpoint it names, or against the live tree
 * when it names none.
 *
 * @category constructors
 * @since 0.1.0
 */
export const checkpointed = (
  store: Checkpoints.Checkpoints,
  runner: FlowEngineLike.CallRunner
): FlowEngineLike.CallRunner => ({
  ...(runner.authorize === undefined ? {} : { authorize: runner.authorize }),
  run: (call: Cell.Call): Effect.Effect<Cell.CallResult, HarnessError> => {
    const at = call.at
    if (at === undefined) return runner.run(call)
    return store.materialize(at, (materialized) => {
      const relocated = Checkpoints.relocate(call.flowName, call.input, materialized)
      if (relocated._tag === "UnsupportedFlow") return Effect.succeed(unsupported(call.flowName))
      if (relocated._tag === "AbsolutePath") return Effect.succeed(absolute(call.flowName, relocated.path))
      // The journaled call keeps the input the cell wrote and the `at` that
      // says which tree; only the input handed to the flow is rewritten. A
      // reader of the journal sees the question, not the scratch path this
      // process happened to check it out at.
      return runner.run(
        new Cell.Call({
          flowName: call.flowName,
          input: relocated.input,
          capabilities: call.capabilities,
          effects: call.effects,
          placement: call.placement,
          identity: call.identity,
          at
        })
      )
    }).pipe(
      // A store that cannot hand the tree back is a refusal the cell can act
      // on, not a failed run: the reading it wanted is still available on the
      // live tree, and every other call this cell has paid for survives.
      Effect.catchTag("flows/std/StdError", (error) =>
        Effect.succeed(
          refused(
            "checkpoint_unavailable",
            `Checkpoint ${at} could not be checked out, so nothing ran: ${error.message}`
          )
        ))
    )
  }
})

/**
 * Wraps a runner with checkpoint materialization when the composition has a
 * store, and leaves it alone when it does not.
 *
 * @category constructors
 * @since 0.1.0
 */
export const decorate = (
  runner: FlowEngineLike.CallRunner
): Effect.Effect<FlowEngineLike.CallRunner> =>
  Effect.map(
    Effect.serviceOption(Checkpoints.Checkpoints),
    Option.match({
      onNone: () => runner,
      onSome: (store) => checkpointed(store, runner)
    })
  )
