/**
 * The call ledger: what this run has already asked, rendered every frame.
 *
 * A cell's results are durable, but they are invisible to the next model turn
 * unless the cell that made them happened to copy them into `context`. A cell
 * is authored blind — the model writes the whole program before it sees any of
 * its results — so copying is a guess made before the answer exists, and the
 * rational response is to split one logical step across two frames: one frame
 * to fetch, one to look. Thirty-one percent of the frames in one graded wave
 * made no flow call at all, and the justifications they volunteered name the
 * cause outright: "loaded the durable investigation results so the next frame
 * can edit without repeating repository reads".
 *
 * This ledger removes the guess. Every settled call of the run contributes one
 * line the harness derives on its own — ordinal, flow, what the call was about,
 * whether it settled ok, and a structural digest of what came back — so a model
 * can see what it has already asked without asking again. It carries no
 * payloads: a line says `stdout=4096b`, never the four kilobytes.
 *
 * A call that *writes* gets two things more, because a repeated write is a
 * different failure from a repeated read. The line says so and says how many
 * bytes the call carried, and a write whose flow and input a earlier write
 * already settled names that earlier one. The r95repl lane is why:
 * `sympy__sympy-13878` applied one 4,965-byte patch five times across five
 * frames, reverting the file between each, and nothing in the run's own record
 * of itself said that the second application was the first one again. It spent
 * 649 seconds and $1.20, the slowest instance in an arm whose median was 121 s.
 * This is visibility and not a gate: re-applying is sometimes exactly right —
 * the run had genuinely reverted the tree — and the exact-match refusal the
 * truncated-write guard already carries is what stands between a run and a
 * destructive repeat.
 *
 * It is a sibling of `NarrowedCheck` and `TruncatedOutput`: run-scoped
 * controller state, bounded, journal-derivable, and interpreting nothing about
 * any flow, tool, or repository.
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import { Effect, Schema } from "effect"
import * as elide from "./internal/elide.ts"
import * as NarrowedCheck from "./NarrowedCheck.ts"

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * How many settled calls the rendered ledger carries, newest last.
 *
 * Thirty is above the whole call count of every round this harness has ever
 * completed at or near par — the five golfed instances settle 7 to 25 calls —
 * and it is a third of the call count of the worst recorded round, so a run
 * that has genuinely lost the thread is shown its recent history rather than
 * its whole one. Each line is bounded, so the section is bounded.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const bound = 30

/**
 * How much of one call's subject or result digest a line may quote.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const width = 120

/**
 * How many members of a result object the digest may name.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const members = 6

/**
 * The largest single result, in bytes of canonical JSON, kept for recall.
 *
 * A result over this is named by size and never stored: the point of recall is
 * to stop a run re-buying a region it already has, and a value this large is a
 * value a cell should have narrowed at the call.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const recallEntryBytes = 16 * 1024

/**
 * The total bytes of settled results one run carries for recall.
 *
 * This is durable controller state, rewritten every frame, so it is bounded by
 * total size rather than by count: the newest results are kept while the sum
 * stays under the bound and everything older keeps its line without its bytes.
 * Thirty-two kilobytes is four of the largest single results allowed above, and
 * two of the five golfed instances of the r90 wave would have needed one.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const recallBytes = 32 * 1024

/**
 * The largest one recalled result may occupy in a frame's prompt.
 *
 * A retained result over this is rendered from both ends with the elision
 * stated between them, which is the same bound and the same honesty the state
 * projection uses.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const recallProjection = 4096

const clip = (text: string, limit: number): string => elide.head(text, limit, "clipped")

/**
 * One settled call, as one line of the run's history.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Entry extends Schema.Class<Entry>("flows/harness/CallLedger/Entry")({
  /** The call's one-based position in the run's whole settled sequence. */
  ordinal: NonNegativeSafeInt,
  /** The flow the call named. */
  flow: Schema.String,
  /** What the call was about; see {@link subject}. */
  subject: Schema.String,
  /** Whether the call settled successfully. This is not the exit status. */
  ok: Schema.Boolean,
  /** The structural digest of what came back; see {@link digest}. */
  digest: Schema.String,
  /**
   * The whole of what came back, in bytes of canonical JSON.
   *
   * Stated on every line, retained or not, because it is what makes the ledger
   * honest about its own bounds: a line that cannot be recalled says how big
   * the thing it is not showing was.
   */
  bytes: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Whether this call reached the engine declaring that it changes the tree.
   *
   * A mutation is the one kind of call whose repetition is never compliance.
   * Re-issuing a read costs bytes; re-issuing the check that failed is what rule
   * 7 asks for; re-applying a hunk means the run either lost its own edit or
   * undid it, and either way it is about to make a change it has already made.
   * So the line says which calls wrote, and {@link render} points a repeated
   * write back at the write it repeats.
   */
  mutates: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  /**
   * The bytes this call carried into the tree, for a call that declares a write.
   *
   * It is the longest string in the call's input — a `write`'s content, an
   * `edit`'s replacement, a patch — measured the same flow-agnostic way
   * `TruncatedOutput` measures a payload, and it is **not** a measured delta of
   * the workspace. The harness has no per-call delta to report: its one honest
   * measurement is `EngineLike.observe`, which covers a whole frame and counts
   * paths rather than bytes. Stating the payload says what the call was, which
   * is what makes two applications of one 4,965-byte patch legible as the same
   * act; claiming a delta would say what the tree did, which this number does
   * not know.
   */
  payloadBytes: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * The digest of this call's flow and input together.
   *
   * Held rather than rendered: it is what lets a later identical write name the
   * earlier one, and it is a digest so the ledger stays small enough to live in
   * journaled controller state.
   */
  signature: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("")),
    Schema.withDecodingDefaultKey(Effect.succeed(""))
  ),
  /**
   * What came back, verbatim, while the run can still afford to carry it.
   *
   * Absent means the bytes are gone from controller state — the result was over
   * {@link recallEntryBytes} when it settled, or newer results have pushed it
   * past {@link recallBytes}. The line survives either way, and a recall of an
   * absent result is answered by name rather than by silence.
   */
  retained: Schema.optional(Schema.String)
}) {}

/**
 * The run's settled calls, oldest first and bounded to {@link bound}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Ledger = Schema.Array(Entry).pipe(
  Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Entry>>([])),
  Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<Entry>>([]))
)

/**
 * The run's settled calls, oldest first and bounded to {@link bound}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Ledger = typeof Ledger.Type

/**
 * What one call was about: the first term of its input that names a target.
 *
 * `NarrowedCheck` already owns the lexer and the target/condition split, so a
 * path, a test id, a dotted module name, or the file inside a shell command is
 * picked out without this module knowing what any of those are. `names` is its
 * stricter reading of a target, because a subject nobody can recognize is worse
 * than no subject at all. An input with no such term is quoted whole instead,
 * clipped — a grep that targets only a glob is named by its own pattern and
 * root, which is what makes the line recognizable at all.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const subject = (input: Schema.Json): string => clip(target(input) ?? CanonicalJson.stringify(input), width)

/**
 * The first term of a value that names a target, or nothing.
 *
 * Split out of {@link subject} because a write's target is not always in its
 * input. A patch names its files inside its own text and its input is one opaque
 * blob, so the only place the path appears in a form anything can read is the
 * result — `modified: ["sympy/stats/crv_types.py"]`. A line that named a
 * 4,965-byte patch by its first hundred bytes said nothing a reader could match
 * against the next one.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const target = (value: Schema.Json): string | undefined => NarrowedCheck.lex(value).find(NarrowedCheck.names)

const scalar = (value: unknown): string => {
  if (typeof value === "string") return `${value.length}b`
  if (Array.isArray(value)) return `[${value.length}]`
  if (value !== null && typeof value === "object") return "{…}"
  return String(value)
}

/**
 * The one-line structural digest of what a call returned.
 *
 * Counts and statuses, never payloads: a member that is a string reports its
 * byte length, an array reports its length, a nested object reports that it is
 * one, and a number or boolean — an exit code, a truncation flag — reports
 * itself. Members are named in canonical key order and capped at
 * {@link members}, so the same result always renders the same line and a result
 * with fifty keys cannot take the frame over.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const digest = (value: Schema.Json): string => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return clip(scalar(value), width)
  const record = new Map(Object.entries(value))
  const keys = [...record.keys()].sort()
  const named = keys.slice(0, members).map((key) => `${key}=${scalar(record.get(key))}`)
  const rest = keys.length - named.length
  return clip([...named, ...(rest > 0 ? [`+${rest} more`] : [])].join(" "), width)
}

const encoder = new TextEncoder()

/**
 * The bytes one call carried into the tree: the longest string in its input.
 *
 * Flow-agnostic on purpose, and the same walk `TruncatedOutput` uses to find the
 * payload of a call it has never heard of. A `write` carries its content, an
 * `edit` its replacement, `apply_patch` its patch, and every one of them is the
 * longest string the input holds. A mutating call with no string at all — a
 * revert that names only a path — carries nothing and says zero.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const payload = (input: Schema.Json): number => {
  if (typeof input === "string") return encoder.encode(input).byteLength
  if (Array.isArray(input)) return input.reduce<number>((widest, item) => Math.max(widest, payload(item)), 0)
  if (input === null || typeof input !== "object") return 0
  return Object.values(input).reduce<number>((widest, item) => Math.max(widest, payload(item)), 0)
}

/**
 * One settled call, as the controller observed it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Settlement {
  readonly flow: string
  readonly input: Schema.Json
  readonly ok: boolean
  readonly value: Schema.Json
  readonly message?: string | undefined
  /** Whether the call reached the engine declaring a write; see {@link Entry.mutates}. */
  readonly mutates?: boolean | undefined
}

/**
 * Records one settled call.
 *
 * A call that failed carries what the flow said about the failure, because that
 * text — an anchor near-miss, a missing path — is the whole content of the
 * result and is otherwise seen only by a cell that thought to catch it.
 *
 * Every one of the four rendered fields is bounded, the flow name included. A
 * name that matches no descriptor still settles — as a failure saying so — and
 * the name is whatever the cell passed to `ctx.call`, which is a value the model
 * writes. `ctx.call("Z".repeat(50000), {})` is one short line of JavaScript, and
 * without this bound it put fifty kilobytes into durable controller state and
 * into every remaining frame's prompt, thirty times over at the ledger's bound.
 * A real flow name is far under {@link width}, so the clip is invisible to every
 * call that names something callable.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const entry = (ordinal: number, call: Settlement, retainResult = true): Entry => {
  // A failure's whole content is its message, so that is what recall stores for
  // it: an anchor near-miss reads identically whether the flow returned it as a
  // value or as prose, and a cell that wants the exact text of one should not
  // have to have caught it at the time.
  // `?? null` because a host can settle a call with no value at all: the
  // contract says `Json`, an implementation that returns nothing says
  // `undefined`, and canonical JSON refuses it. The ledger reports what the
  // cell saw, which for such a call is `null`.
  const whole = CanonicalJson.stringify(call.ok ? call.value ?? null : { failed: call.message ?? "failed" })
  const mutates = call.mutates === true
  return new Entry({
    ordinal,
    flow: clip(call.flow, width),
    // A write whose input names nothing is named by what came back, because a
    // patch carries its paths in its own text and hands them back as a list.
    subject: mutates && target(call.input) === undefined && target(call.value) !== undefined
      ? clip(target(call.value)!, width)
      : subject(call.input),
    ok: call.ok,
    digest: call.ok ? digest(call.value) : clip(call.message ?? "failed", width),
    bytes: whole.length,
    mutates,
    payloadBytes: mutates ? payload(call.input) : 0,
    signature: mutates ? Digest.digest(CanonicalJson.stringify([call.flow, call.input])) : "",
    retained: retainResult && whole.length <= recallEntryBytes ? whole : undefined
  })
}

/**
 * How many calls this run has settled, given a ledger some of whose lines have
 * aged out.
 *
 * The ledger holds at most {@link bound} lines, so its length stops being the
 * run's call count as soon as it fills. The newest entry's ordinal is the count
 * and does not, which is why ordinals are stored rather than rendered from an
 * index.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const settled = (ledger: Ledger): number => ledger.length === 0 ? 0 : ledger[ledger.length - 1]!.ordinal

/**
 * Folds one frame's settled calls into the run's ledger, newest last.
 *
 * Ordinals continue the run's own sequence, so the numbers a model reads stay
 * the numbers the journal would give the same calls after older lines have aged
 * out of the bound.
 *
 * `retainResults` is what the REPL mode turns off. There the payload of a call
 * is already bound to a name in the realm, so 32 KiB of stored result bytes in
 * durable controller state buys nothing that the variable does not already give
 * — and a line that cannot be recalled must not be printed as one that can. The
 * index half of the ledger, which is what the golf report credits with deleting
 * a frame class, is unchanged.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const remember = (known: Ledger, made: ReadonlyArray<Settlement>, retainResults = true): Ledger => {
  const before = settled(known)
  const all = [...known, ...made.map((call, index) => entry(before + index + 1, call, retainResults))]
  return retain(all.length <= bound ? all : all.slice(all.length - bound))
}

/**
 * Drops the retained bytes of every result past the run's recall budget.
 *
 * Newest first, because the results a run wants back are the ones it has just
 * bought. A dropped payload leaves its line — ordinal, subject, structural
 * digest and size — so the ledger never stops being able to say what the run
 * asked; it only stops being able to say it again in full.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const retain = (ledger: Ledger): Ledger => {
  let spent = 0
  const kept: Array<Entry> = []
  for (let index = ledger.length - 1; index >= 0; index--) {
    const line = ledger[index]!
    if (line.retained === undefined) {
      kept.push(line)
      continue
    }
    const next = spent + line.retained.length
    if (next > recallBytes) {
      kept.push(new Entry({ ...line, retained: undefined }))
      continue
    }
    spent = next
    kept.push(line)
  }
  return kept.reverse()
}

/**
 * Renders the ledger for the state section, or nothing when the run has settled
 * no call yet.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const render = (ledger: Ledger, recallable = true): string | undefined => {
  if (ledger.length === 0) return undefined
  const total = settled(ledger)
  const elided = total - ledger.length
  const heading = elided === 0
    ? `Calls this run has settled (${total}), oldest first. You have already asked these — read them here instead of asking again:`
    : `Calls this run has settled (${total}), oldest first; the ${elided} oldest are not listed. You have already asked these — read them here instead of asking again:`
  // Where each write's signature was first settled, so a repeat can name it.
  // First rather than most recent: the run wants the call it has already made,
  // and the earliest one is the one every later copy repeats.
  const first = new Map<string, Entry>()
  for (const line of ledger) {
    if (line.mutates && !first.has(line.signature)) first.set(line.signature, line)
  }
  const lines = ledger.map((line) => {
    const repeated = line.mutates ? first.get(line.signature) : undefined
    const again = repeated === undefined || repeated.ordinal === line.ordinal
      ? ""
      : ` — the same write as ${repeated.ordinal}, which ${repeated.ok ? "succeeded" : "failed"}`
    const wrote = line.mutates ? `WROTE ${line.payloadBytes}b, ` : ""
    return `${line.ordinal}. ${line.flow} ${line.subject} — ${wrote}${
      line.ok ? "ok" : "FAILED"
    }${again}: ${line.digest} (${line.bytes}b${line.retained === undefined ? "" : `, recall ${line.ordinal}`})`
  })
  // Only where the run has actually written something: teaching about a marker
  // nothing on the page carries costs a frame's worth of reading for nothing.
  const writes = first.size === 0
    ? ""
    : "\nA line marked `WROTE` changed the tree, with the bytes it carried. One that names an earlier write made a change this run had already made: read what happened after the first one before making it a third time."
  // The recall trailer is teaching about a mechanic, so it is printed only
  // where the mechanic exists. A REPL run holds its results under the names its
  // own cells gave them, and telling it to ask for bytes nobody kept would cost
  // it a frame finding that out.
  const trailer = recallable
    ? "\nA line marked `recall N` still holds its whole result: put N in the `recall` array of your next transition and the harness prints it in the next prompt. That is free; issuing the call again is not."
    : "\nThese are an index, not the results: what each call returned is still under the name your cell bound it to. Read the name; do not issue the call again."
  return `${heading}\n${lines.join("\n")}${trailer}${writes}`
}

/**
 * Renders the results a transition asked to see again.
 *
 * The mechanic is exactly the one `render` uses for state keys: the harness
 * satisfies the request while it assembles the next frame's prompt, so a run
 * that needs a result back pays for the bytes and nothing else. Every way the
 * request can miss is answered in the same block — an ordinal nobody settled, a
 * result whose bytes are past the recall budget, a value too long to print
 * whole — because a request that is silently dropped is the defect this exists
 * to close.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const recall = (ledger: Ledger, ordinals: ReadonlyArray<number>): string | undefined => {
  const asked = [...new Set(ordinals)]
  if (asked.length === 0) return undefined
  const total = settled(ledger)
  const sections = asked.map((ordinal) => {
    const line = ledger.find((candidate) => candidate.ordinal === ordinal)
    if (line === undefined) {
      return `## recall ${ordinal}\nNo settled call has ordinal ${ordinal}. This run has settled ${total} call${
        total === 1 ? "" : "s"
      }, and only the lines listed above are still held.`
    }
    if (line.retained === undefined) {
      return `## recall ${ordinal} — ${line.flow} ${line.subject}\nIts ${line.bytes} bytes are no longer held: a result over ${recallEntryBytes} bytes is never retained, and older results are dropped once the run's ${recallBytes}-byte recall budget is spent. Issue the call again, narrowed, if you still need it.`
    }
    return `## recall ${ordinal} — ${line.flow} ${line.subject} (${line.ok ? "ok" : "FAILED"}, ${line.bytes}b)\n${
      elide.middle(
        line.retained,
        recallProjection,
        `recall ${ordinal} cannot print more than ${recallProjection} bytes`
      )
    }`
  })
  return `Results you asked to see again:\n${sections.join("\n")}`
}
