/**
 * Replays `three-way.mjs` over three synthesised ledgers.
 *
 * The three-column scoreboard exists because a second re-run has two questions
 * to answer at once, and each has a way of being answered wrongly that would
 * look like data:
 *
 * - **recovered is not gained.** An instance the baseline resolved, the middle
 *   wave dropped and this one holds again is a recovery. An instance no wave
 *   before this one ever resolved is a gain. Counting the first as the second
 *   is how a surgery that merely undid a regression gets reported as progress.
 * - **still lost is not newly lost.** An instance the baseline resolved and
 *   neither re-run does is a regression this wave did not fix; one the middle
 *   wave resolved and this one does not is a regression this wave introduced.
 *   They belong in different rows because they call for different work.
 * - **the middle column is the middle ledger's own fold**, not a re-derivation:
 *   its dollars are every attempt, exactly as `compare-runs.mjs` counts them.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { render, threeWay } from "../three-way.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-three-way-"))

const ledger = (path, rows) => {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return path
}

const instance = (id, state, extra = {}) => ({ kind: "instance", id, state, at: 1, ...extra })

const graded = (id, verdict, { usd, frames, wallSeconds, agentSeconds }) => [
  instance(id, "pulled"),
  instance(id, "ran", { wallSeconds, cost: { usd, frames, spanMillis: agentSeconds * 1000 } }),
  instance(id, "graded", { verdict }),
  instance(id, "cleaned")
]

const cost = (usd) => ({ usd, frames: 4, wallSeconds: 100, agentSeconds: 90 })

try {
  // recovered: resolved, lost, resolved again.
  // stillLost:  resolved, lost, lost.
  // newlyLost:  unresolved, resolved, unresolved.
  // gained:     unresolved, unresolved, resolved.
  // steady:     resolved throughout.
  const baselinePath = ledger(join(temporary, "r90.jsonl"), [
    { kind: "header", at: 0, runId: "fullbench" },
    ...graded("a__recovered-1", "resolved", cost(1)),
    ...graded("b__stilllost-2", "resolved", cost(1)),
    ...graded("c__newlylost-3", "unresolved", cost(1)),
    ...graded("d__gained-4", "unresolved", cost(1)),
    ...graded("e__steady-5", "resolved", cost(1))
  ])
  const firstPath = ledger(join(temporary, "r91.jsonl"), [
    { kind: "header", at: 0, runId: "rerun-r91" },
    ...graded("a__recovered-1", "empty patch", cost(2)),
    ...graded("b__stilllost-2", "unresolved", cost(2)),
    ...graded("c__newlylost-3", "resolved", cost(2)),
    ...graded("d__gained-4", "unresolved", cost(2)),
    ...graded("e__steady-5", "resolved", cost(2))
  ])
  const secondPath = ledger(join(temporary, "r92.jsonl"), [
    { kind: "header", at: 0, runId: "rerun-r92" },
    ...graded("a__recovered-1", "resolved", cost(0.5)),
    ...graded("b__stilllost-2", "unresolved", cost(0.5)),
    ...graded("c__newlylost-3", "unresolved", cost(0.5)),
    ...graded("d__gained-4", "resolved", cost(0.5)),
    ...graded("e__steady-5", "resolved", cost(0.5))
  ])

  const summary = threeWay({ baselinePath, firstPath, secondPath })

  assert.equal(summary.population, 5)
  assert.equal(summary.comparedCount, 5)
  assert.equal(summary.pending, 0)

  // The four movements, each in its own row and none in another's.
  assert.deepEqual(summary.recovered, ["a__recovered-1"])
  assert.deepEqual(summary.stillLost, ["b__stilllost-2"])
  assert.deepEqual(summary.newlyLost, ["c__newlylost-3"])
  // Disjoint by construction: a recovery is an instance the baseline already
  // resolved, so it can never also be a gain over the baseline.
  assert.deepEqual(summary.gainedOverBaseline, ["d__gained-4"])

  // The three columns are three ledgers' own totals.
  assert.equal(summary.totals.baseline.resolved, 3)
  assert.equal(summary.totals.first.resolved, 2)
  assert.equal(summary.totals.second.resolved, 3)
  assert.equal(summary.totals.baseline.usd, 5)
  assert.equal(summary.totals.first.usd, 10)
  assert.equal(summary.totals.second.usd, 2.5)

  // The middle column is a fold of every attempt, like the outer two. A crash
  // that was replaced still burned tokens, and the invoice says so.
  const retriedPath = ledger(join(temporary, "r91-retried.jsonl"), [
    { kind: "header", at: 0, runId: "rerun-r91" },
    ...graded("a__recovered-1", "empty patch", cost(2)),
    instance("b__stilllost-2", "ran", { wallSeconds: 10, cost: { usd: 3, frames: 1, spanMillis: 1000 } }),
    ...graded("b__stilllost-2", "unresolved", cost(2)),
    ...graded("c__newlylost-3", "resolved", cost(2)),
    ...graded("d__gained-4", "unresolved", cost(2)),
    ...graded("e__steady-5", "resolved", cost(2))
  ])
  assert.equal(
    threeWay({ baselinePath, firstPath: retriedPath, secondPath }).totals.first.usd,
    13,
    "the crashed attempt's dollars belong in the middle column"
  )

  // A partial second wave leaves its own rows blank and never borrows the
  // middle wave's verdict for them.
  const partialPath = ledger(join(temporary, "r92-partial.jsonl"), [
    { kind: "header", at: 0, runId: "rerun-r92" },
    ...graded("a__recovered-1", "resolved", cost(0.5))
  ])
  const partial = threeWay({ baselinePath, firstPath, secondPath: partialPath })
  assert.equal(partial.comparedCount, 1)
  assert.equal(partial.pending, 4)
  assert.deepEqual(partial.recovered, ["a__recovered-1"])
  assert.deepEqual(partial.stillLost, [], "an instance this wave has not run is not lost")
  assert.match(render(partial), /not re-run/)

  // -------------------------------------------------------------------------
  // The command line writes both artifacts and names all three ledgers.
  // -------------------------------------------------------------------------
  const out = join(temporary, "out")
  writeFileSync(join(temporary, ".keep"), "")
  spawnSync("mkdir", ["-p", out])
  const run = spawnSync(process.execPath, [
    join(root, "three-way.mjs"),
    "--baseline",
    baselinePath,
    "--first",
    firstPath,
    "--second",
    secondPath,
    "--out",
    out,
    "--baseline-name",
    "r90",
    "--first-name",
    "r91",
    "--second-name",
    "r92"
  ], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /resolved 3 -> 2 -> 3/)
  const markdown = readFileSync(join(out, "three-way.md"), "utf8")
  assert.match(markdown, /\| \| r90 \| r91 \| r92 \|/)
  assert.match(markdown, /recovered \(1\): a__recovered-1/)
  assert.match(markdown, /still lost \(1\): b__stilllost-2/)
  assert.match(markdown, /newly lost \(1\): c__newlylost-3/)
  assert.equal(JSON.parse(readFileSync(join(out, "three-way.json"), "utf8")).comparedCount, 5)

  const missing = spawnSync(process.execPath, [join(root, "three-way.mjs"), "--baseline", baselinePath], {
    encoding: "utf8"
  })
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /--first is required/)

  console.log(
    "check-three-way: a recovery is told from a gain, a regression this wave did not fix from one it"
      + " introduced, and the middle column is the middle ledger's own fold."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
