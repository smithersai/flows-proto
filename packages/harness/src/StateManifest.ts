/**
 * The state manifest: what a run is holding, stated every frame.
 *
 * `ctx.state` is the cell's own memory and the harness never interprets it, but
 * the *model* only ever sees what the prompt says about it. For most of a run
 * that was a key roster with byte sizes, and only once the state grew past the
 * printable bound — so a run's first frames were told nothing at all about the
 * shape of their own memory, and the frames after that were told names and
 * sizes with no way to tell a key written eight frames ago from one written
 * last frame. Both gaps were paid for in re-reads: `pydata__xarray-7229` spent
 * $0.76 buying regions it was already holding, `sphinx-doc__sphinx-8721` $0.36
 * re-extracting an error it had rendered once, `django__django-11490` $0.36 on
 * state archaeology that included a hand-written state traverser.
 *
 * So the manifest is unconditional and it carries four facts per key: the type,
 * the size, the frame that last wrote it, and how long ago that was. Freshness
 * is the fact that could not be recovered any other way — a run comparing a
 * check it stored against a tree it has since changed needs to know which came
 * first, and nothing else in the prompt says.
 *
 * Its sibling is `CallLedger`, which does the same for the half of a run's
 * knowledge that never reached `state`.
 *
 * @since 0.1.0
 */
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import { Effect, Schema } from "effect"
import * as elide from "./internal/elide.ts"

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * The largest state, in bytes of canonical JSON, printed whole as well as
 * rostered.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const printableState = 2048

/**
 * The largest projection, in bytes, one key named by `render` may occupy.
 *
 * A key over the bound renders its first and last half with the elision stated
 * between them, because the two ends of a file excerpt, a diff, or a test log
 * are where the identifying bytes are and the middle is where the repetition
 * is.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const projectionBytes = 4096

/**
 * How many keys one transition may project.
 *
 * The bound exists because the model chooses the list and the section has to
 * stay bounded whatever it chooses. Eight keys at {@link projectionBytes} each
 * is 32 KB, which is under a fifth of the smallest context window this harness
 * runs against; keys named past the eighth keep their manifest line and are
 * told why.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const projectionKeys = 8

/**
 * How many keys the manifest names before it starts counting instead.
 *
 * The manifest is one line per key and the model writes the keys, so it is
 * bounded like everything else here. A state with more keys than this is a
 * state whose shape the model has lost track of, and the overflow is stated as
 * a count rather than dropped.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const manifestKeys = 40

/**
 * When one durable-state key was last written.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Stamp extends Schema.Class<Stamp>("flows/harness/StateManifest/Stamp")({
  /** The top-level key of `ctx.state` this stamp is about. */
  key: Schema.String,
  /** The frame whose transition last changed the key's value. */
  frame: NonNegativeSafeInt,
  /** The canonical digest of that value, which is how a change is detected. */
  digest: Schema.String
}) {}

/**
 * Every top-level state key this run holds, with the frame that wrote it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Ledger = Schema.Array(Stamp).pipe(
  Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Stamp>>([])),
  Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<Stamp>>([]))
)

/**
 * Every top-level state key this run holds, with the frame that wrote it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Ledger = typeof Ledger.Type

/** The top-level members of a state value, or none when it is not an object. */
const members = (state: Schema.Json): ReadonlyArray<readonly [string, Schema.Json]> =>
  state !== null && typeof state === "object" && !Array.isArray(state)
    ? Object.entries(state)
    : []

/**
 * Names a value's JSON type as a model reads it.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const typeOf = (value: Schema.Json): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/**
 * Re-stamps a run's state keys against the state a transition just returned.
 *
 * A key whose canonical value is byte-identical to the stamped one keeps its
 * frame, so freshness measures when the value last *changed* rather than when
 * the cell last happened to copy `...ctx.state` forward — which every cell
 * does, and which would otherwise make every key read as new every frame.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const stamp = (known: Ledger, state: Schema.Json, frame: number): Ledger => {
  const previous = new Map(known.map((entry) => [entry.key, entry] as const))
  return members(state).map(([key, value]) => {
    const digest = CanonicalJson.stringify(value)
    const before = previous.get(key)
    return before !== undefined && before.digest === digest
      ? before
      : new Stamp({ key, frame, digest })
  })
}

const freshness = (stamped: number, frame: number): string => {
  const age = frame - stamped
  return age <= 0
    ? `written this frame`
    : `written at frame ${stamped}, ${age} frame${age === 1 ? "" : "s"} ago`
}

/**
 * Renders one over-bound value with its elision and the way to see the rest.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const projection = (key: string, value: Schema.Json): string =>
  elide.middle(
    CanonicalJson.stringify(value),
    projectionBytes,
    `the whole value is ctx.state.${key} inside your cell; nothing here can print more than ${projectionBytes} bytes of one key`
  )

/**
 * Renders the state section of one frame's prompt.
 *
 * The manifest is always present. The whole JSON is added while the state is
 * small enough to be worth printing, and the keys the last transition named in
 * `render` are added in full whether it is or not — that is what stops a run
 * spending a model turn copying its own memory into `context`.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const render = (options: {
  readonly state: Schema.Json
  readonly stamps: Ledger
  readonly frame: number
  readonly keys: ReadonlyArray<string>
}): string => {
  const rendered = CanonicalJson.stringify(options.state)
  const held = new Map(members(options.state))
  const stamped = new Map(options.stamps.map((entry) => [entry.key, entry] as const))
  // De-duplicated first, because the list is model-written and a repeated name
  // would otherwise spend a slot of the projection budget on rendering one
  // value twice — `render: ["a", "a", "a"]` printed the same key three times
  // and left five slots for the seven keys the frame actually needed.
  const asked = [...new Set(options.keys)]
  const named = asked.filter((key) => held.has(key))
  const shown = named.slice(0, projectionKeys)
  const overflow = named.slice(projectionKeys)
  const missing = asked.filter((key) => !held.has(key))

  const headline = held.size === 0
    ? `Durable state for this frame (ctx.state) is ${rendered.length} bytes and holds no named keys.`
    : `Durable state for this frame (ctx.state) is ${rendered.length} bytes across ${held.size} key${
      held.size === 1 ? "" : "s"
    }:`
  const listed = [...held].slice(0, manifestKeys)
  const uncounted = held.size - listed.length
  const manifest = listed.map(([key, value]) => {
    const entry = stamped.get(key)
    return `- ${key} (${typeOf(value)}, ${CanonicalJson.stringify(value).length}b) — ${
      entry === undefined ? "written before this run's stamps began" : freshness(entry.frame, options.frame)
    }`
  })

  return [
    headline,
    ...manifest,
    ...(uncounted > 0 ? [`- … and ${uncounted} more key${uncounted === 1 ? "" : "s"} not listed here.`] : []),
    ...(rendered.length <= printableState
      ? [`The whole of it, as JSON:\n${rendered}`]
      : [
        `Read what you need from ctx.state inside your cell; name a key in \`render\` to have it printed here instead of spending a frame echoing it into \`context\`.`
      ]),
    ...(shown.length === 0 ? [] : [
      "Rendered in full because your last transition named them in `render`:",
      ...shown.map((key) => `## ${key}\n${projection(key, held.get(key)!)}`)
    ]),
    ...(overflow.length === 0 ? [] : [
      `Only the first ${projectionKeys} keys you named are rendered in full; ${
        overflow.join(", ")
      } kept their manifest line. Name fewer keys to see them.`
    ]),
    ...(missing.length === 0 ? [] : [`No such key in state: ${missing.join(", ")}.`])
  ].join("\n")
}
