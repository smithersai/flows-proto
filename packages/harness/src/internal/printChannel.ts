/**
 * The print channel: how a REPL frame's `console.log` calls become the bytes
 * its successor reads.
 *
 * Two jobs live here, and both were priced off the `rerun-r95repl` lane rather
 * than chosen.
 *
 * **Sharing the frame budget.** Statements used to cap independently at 4 KiB
 * each, head-first, under a 16 KiB frame bound that almost nobody reached: 197
 * of the lane's 357 printing frames had a statement cut, 191 of those while the
 * frame bound sat mostly unspent, and 3.06 MB went to per-statement caps against
 * 6 frames that ever reached the frame one. Head-first is the part that cost
 * verdicts — `sympy__sympy-13878` fused one `console.log` of 38,928 bytes whose
 * head was a Python deprecation banner, so what it lost was the tail: the result
 * of a three-minute test suite the same frame had just paid for, and the `git
 * diff` that would have shown it the edit was already in the tree. It re-ran
 * that suite four frames later. So the statements of a frame share one budget,
 * each is elided from the middle, and no ceiling moves: 16 KiB was the most a
 * frame could deliver before and it is the most now.
 *
 * **Compacting a printed structure.** A result printed whole is mostly repeated
 * keys — a grep hit names `file`, `line`, `text` once per match — so an array of
 * records whose keys are identical is rendered as a table with the keys named
 * once. It is keyed on the shape and nothing else — this module knows no flow —
 * and at the floor it applies to, three rows and two columns, the table is
 * shorter than the JSON by construction, so the change can only take bytes off
 * the bill.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import type { Schema } from "effect"
import * as Sandbox from "../Sandbox.ts"
import * as elide from "./elide.ts"

/**
 * The fewest records an array needs before it is rendered as a table.
 *
 * Two rows do not repay a header line, and one row is not a table at all.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const tableRows = 3

/**
 * What the model is told when a print was cut: the value is still bound.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const recall = "print a narrower slice of this value; it is still bound in the realm"

/**
 * One `console.log` call, as the host kept it.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Statement {
  /** The head and tail the host kept, in order and possibly the whole thing. */
  readonly text: string
  /** What the statement rendered to before anything was dropped. */
  readonly bytes: number
}

const isRecord = (value: Schema.Json): value is Schema.JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const cell = (value: Schema.Json): string =>
  typeof value === "string" && !value.includes("\n") && !value.includes("|")
    ? value
    : CanonicalJson.stringify(value)

/**
 * Renders an array of identically-keyed records as a table, or nothing.
 *
 * The key set has to be identical across every element, because a table with a
 * column some rows do not have is a table that says a row held `null` when it
 * held nothing at all. Cells are the string itself where that is unambiguous —
 * no newline, no column separator — and canonical JSON everywhere else, so a
 * row can always be read back to the value it came from.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const table = (value: Schema.Json): string | undefined => {
  if (!Array.isArray(value) || value.length < tableRows) return undefined
  const first = value[0]
  if (!isRecord(first)) return undefined
  const columns = Object.keys(first)
  if (columns.length < 2) return undefined
  const rows: Array<string> = []
  for (const element of value) {
    if (!isRecord(element)) return undefined
    const keys = Object.keys(element)
    if (keys.length !== columns.length || columns.some((column, index) => keys[index] !== column)) return undefined
    // Every column is a key of this element: the key sets were compared above,
    // and JSON has no notation for a member that is present and undefined.
    rows.push(columns.map((column) => cell(element[column]!)).join(" | "))
  }
  return `${columns.join(" | ")}\n${rows.join("\n")}`
}

/**
 * Renders one printed JSON value the shortest honest way.
 *
 * A bare array of records becomes a table. An object with exactly one such
 * member becomes that object's other members as JSON, then the member's name,
 * count and table — which is the shape a search result printed whole takes, and
 * the one this exists for. Everything else is canonical JSON as before.
 *
 * The table is shorter than the JSON by construction rather than by comparison,
 * which is why nothing here measures both and picks. A row replaces `{"k":v,…}`
 * with `v | …`: per cell it drops a quoted key, its colon and its comma — at
 * least `len(key) + 3` bytes — and pays three for the column boundary, and it
 * drops the element's two braces outright. What it pays once is the header. At
 * this module's floor, three rows of two one-character keys, that is 24 saved
 * against 4 paid, and every additional row, column or character of key name
 * widens the gap. The envelope form pays fourteen bytes for its `name (count):`
 * line and gets back the quoted key, its comma and the array's brackets, so it
 * is ahead by the table's own saving less three.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const render = (value: Schema.Json): string => {
  // A string is itself, which is what `Cell.renderText` promises everywhere
  // else the harness renders a projected value. The prelude sends a primitive
  // string down the `text` side, so this arm answers only for a boxed one.
  if (typeof value === "string") return value
  const flat = table(value)
  if (flat !== undefined) return flat
  if (!isRecord(value)) return CanonicalJson.stringify(value)
  const tabled = Object.entries(value).flatMap(([key, member]) => {
    const rendered = table(member)
    return rendered === undefined ? [] : [[key, member as ReadonlyArray<unknown>, rendered] as const]
  })
  if (tabled.length !== 1) return CanonicalJson.stringify(value)
  const [key, member, rendered] = tabled[0]!
  const rest = Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
  return `${CanonicalJson.stringify(rest)}\n${key} (${member.length}):\n${rendered}`
}

/**
 * Apportions one budget across statements of the given sizes.
 *
 * Short statements take what they need and hand the remainder back, so a frame
 * that printed one long value and three short ones spends the budget on the long
 * one. Allocation runs shortest first, which is what makes the hand-back
 * possible, and the result is in the order the sizes were given.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const shares = (sizes: ReadonlyArray<number>, budget: number): ReadonlyArray<number> => {
  const order = sizes.map((size, index) => ({ size, index })).sort((left, right) =>
    left.size === right.size ? left.index - right.index : left.size - right.size
  )
  const allotted = new Array<number>(sizes.length).fill(0)
  let remaining = budget
  let left = sizes.length
  for (const { index, size } of order) {
    const fair = Math.floor(remaining / left)
    const given = Math.min(size, fair)
    allotted[index] = given
    remaining = remaining - given
    left = left - 1
  }
  return allotted
}

/**
 * How many statements one frame's budget can floor.
 */
const capacity = Math.max(1, Math.floor(Sandbox.printFrameBytes / Sandbox.printStatementFloor))

/**
 * Assembles what a frame printed, bounded by {@link Sandbox.printFrameBytes}.
 *
 * `unread` is the count of statements the host stopped copying out of the realm
 * because the frame had already handed over more than it holds. It is stated
 * rather than dropped, because a buffer that simply stopped reads as a cell that
 * simply stopped printing.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const buffer = (statements: ReadonlyArray<Statement>, unread: number): string => {
  if (statements.length === 0 && unread === 0) return ""
  // More statements than the budget can floor: whole statements go from the
  // middle, counted, rather than every one of them being cut to a notice.
  const head = Math.ceil(capacity / 2)
  const kept = statements.length <= capacity
    ? statements
    : [...statements.slice(0, head), ...statements.slice(statements.length - Math.floor(capacity / 2))]
  const dropped = statements.length - kept.length
  const notices = [
    ...(dropped === 0
      ? []
      : [
        `… ${dropped} print statements elided from the middle of this frame; the values are still bound in the realm.`
      ]),
    ...(unread === 0
      ? []
      : [`… ${unread} further print statements were not kept: this frame printed more than the harness holds.`])
  ]
  // What the budget cannot spend on values: the elision notices, the lines that
  // count what went missing, and the newline between every pair. Reserved before
  // anything is apportioned, so the assembled buffer is bounded by the frame
  // budget outright and nothing has to shorten it a second time — a second pass
  // would cut a notice in half, which is the one thing a bound may not do.
  const reserve = kept.reduce((sum, statement) => sum + elide.noticeCost(statement.bytes, recall), 0) +
    notices.reduce((sum, line) => sum + line.length, 0) +
    Math.max(0, kept.length + notices.length - 1)
  const allotted = shares(
    kept.map((statement) => statement.bytes),
    Math.max(0, Sandbox.printFrameBytes - reserve)
  )
  const lines = kept.map((statement, index) =>
    elide.middleFrom(statement.text, statement.bytes, allotted[index]!, recall)
  )
  return [
    ...lines.slice(0, dropped === 0 ? lines.length : head),
    ...(dropped === 0 ? [] : [notices[0]!, ...lines.slice(head)]),
    ...(unread === 0 ? [] : [notices[notices.length - 1]!])
  ].join("\n")
}
