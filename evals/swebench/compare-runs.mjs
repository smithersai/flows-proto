/**
 * The baseline against the re-run: what changed, per instance and in total.
 *
 *   node compare-runs.mjs [--baseline f] [--rerun f] [--out dir] [--json]
 *
 * `analysis/PROGRAM.md` ends in numbers a re-run either hits or misses —
 * resolved >= 33/45, cost <= $15, wall <= 120 minutes, no instance over $1.00 or
 * over 20 frames. This is what settles them. It reads two ledgers and nothing
 * else: no evaluator report, no journal, no clock, no network. Running it twice
 * over the same two files produces the same bytes.
 *
 * Three things it is careful about.
 *
 * **A partial re-run is readable rather than merely incomplete.** Aggregates are
 * reported over the *compared* set — the instances both ledgers finished — and
 * the baseline's own totals over that same subset are printed beside them, so a
 * re-run 20 instances in is compared against the baseline's same 20 and never
 * against the baseline's 45. The full-population totals are printed too, and
 * labelled as such.
 *
 * **Money is every attempt, not the surviving one.** The fold keeps one row per
 * instance, but an attempt a crash replaced still burned tokens. Cost therefore
 * sums the ledger's rows and the fold answers everything else, which is the same
 * split `fullbench-report.mjs` makes and for the same reason.
 *
 * **Wall clock comes in two numbers, both labelled.** `wallSeconds` is the whole
 * instance — pull, extract, agent, capture — and `agentSeconds` is the journal's
 * own span across the agent's frames. The program's $37.84 / 17,106 s baseline
 * is the first; the "90 % of wall is model latency" claim is about the second.
 * Neither is the wall clock of the run as a whole, which depends on how many
 * instances were in flight and is not a property of a harness.
 *
 * A verdict that moved is the headline. `gained` is baseline-not-resolved to
 * re-run-resolved, `lost` is the reverse, and a `lost` instance is a regression
 * the re-run has to answer for however good its totals look.
 *
 * @since 0.1.0
 */
import { existsSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { isDone, read } from "./lib/fullbench-manifest.mjs"

const rigRoot = import.meta.dirname

/** The program's own success criteria, from `analysis/PROGRAM.md` section 3. */
export const CRITERIA = {
  resolved: 33,
  totalUsd: 15,
  wallMinutes: 120,
  instanceUsd: 1,
  instanceFrames: 20
}

const money = (usd) => `$${usd.toFixed(2)}`

// A delta always carries its sign, including `+0.00`: a column where "0.00" and
// "+0.00" both appear invites the first to be read as missing data.
const signed = (value, digits = 2) => `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(digits)}`

const signedInt = (value) => `${value < 0 ? "-" : "+"}${Math.abs(value)}`

/**
 * One instance's facts, from one ledger's fold.
 *
 * @category conversions
 * @since 0.1.0
 */
export const factsOf = (state) => {
  if (state === undefined || !isDone(state)) return undefined
  return {
    verdict: state.verdict ?? "unknown",
    resolved: state.verdict === "resolved",
    usd: state.cost?.usd ?? 0,
    frames: state.cost?.frames ?? 0,
    wallSeconds: state.wallSeconds ?? 0,
    agentSeconds: Math.round((state.cost?.spanMillis ?? 0) / 1000),
    regrade: typeof state.regrade === "string" ? state.regrade : undefined
  }
}

/**
 * Every attempt's dollars in a ledger, keyed by instance — including the
 * attempts a crash replaced, which the fold drops and the invoice does not.
 *
 * @category conversions
 * @since 0.1.0
 */
export const spendByInstance = (ledger) => {
  const spend = new Map()
  for (const row of ledger.rows) {
    if (row.kind !== "instance" || typeof row.id !== "string") continue
    if (typeof row.cost?.usd !== "number") continue
    spend.set(row.id, (spend.get(row.id) ?? 0) + row.cost.usd)
  }
  return spend
}

const zeroTotals = () => ({ instances: 0, resolved: 0, usd: 0, frames: 0, wallSeconds: 0, agentSeconds: 0 })

const addTo = (totals, facts, usd) => {
  totals.instances += 1
  if (facts.resolved) totals.resolved += 1
  totals.usd += usd
  totals.frames += facts.frames
  totals.wallSeconds += facts.wallSeconds
  totals.agentSeconds += facts.agentSeconds
}

/**
 * Compares two ledgers.
 *
 * @category conversions
 * @since 0.1.0
 */
export const compare = ({ baselinePath, rerunPath }) => {
  const baseline = read(baselinePath)
  const rerun = read(rerunPath)
  const baselineSpend = spendByInstance(baseline)
  const rerunSpend = spendByInstance(rerun)

  const population = []
  for (const [id, state] of baseline.states) {
    if (isDone(state)) population.push(id)
  }
  population.sort()

  const instances = []
  const compared = { baseline: zeroTotals(), rerun: zeroTotals() }
  const wholeBaseline = zeroTotals()
  let pending = 0

  for (const id of population) {
    const before = factsOf(baseline.states.get(id))
    if (before === undefined) continue
    addTo(wholeBaseline, before, baselineSpend.get(id) ?? 0)
    const after = factsOf(rerun.states.get(id))
    if (after === undefined) {
      pending += 1
      instances.push({ id, before, after: undefined, pending: true })
      continue
    }
    const beforeUsd = baselineSpend.get(id) ?? 0
    const afterUsd = rerunSpend.get(id) ?? 0
    addTo(compared.baseline, before, beforeUsd)
    addTo(compared.rerun, after, afterUsd)
    instances.push({
      id,
      before: { ...before, usd: beforeUsd },
      after: { ...after, usd: afterUsd },
      pending: false,
      delta: {
        usd: afterUsd - beforeUsd,
        frames: after.frames - before.frames,
        wallSeconds: after.wallSeconds - before.wallSeconds,
        agentSeconds: after.agentSeconds - before.agentSeconds
      },
      moved: before.resolved === after.resolved ? "same" : after.resolved ? "gained" : "lost"
    })
  }

  const done = instances.filter((row) => !row.pending)
  const gained = done.filter((row) => row.moved === "gained").map((row) => row.id)
  const lost = done.filter((row) => row.moved === "lost").map((row) => row.id)

  // The criteria are about the whole 45, so they are only answerable when the
  // re-run has run all of them. A partial re-run reports them as pending rather
  // than as met by a subset.
  const complete = pending === 0
  const overBudgetUsd = done.filter((row) => row.after.usd > CRITERIA.instanceUsd).map((row) => row.id)
  const overFrames = done.filter((row) => row.after.frames > CRITERIA.instanceFrames).map((row) => row.id)
  const criteria = {
    complete,
    resolved: {
      target: CRITERIA.resolved,
      actual: compared.rerun.resolved,
      met: complete ? compared.rerun.resolved >= CRITERIA.resolved : undefined
    },
    totalUsd: {
      target: CRITERIA.totalUsd,
      actual: compared.rerun.usd,
      met: complete ? compared.rerun.usd <= CRITERIA.totalUsd : undefined
    },
    wallMinutes: {
      target: CRITERIA.wallMinutes,
      actual: compared.rerun.wallSeconds / 60,
      met: complete ? compared.rerun.wallSeconds / 60 <= CRITERIA.wallMinutes : undefined
    },
    perInstanceUsd: { target: CRITERIA.instanceUsd, over: overBudgetUsd, met: overBudgetUsd.length === 0 },
    perInstanceFrames: { target: CRITERIA.instanceFrames, over: overFrames, met: overFrames.length === 0 },
    // The superset rule: the re-run must not lose an instance the baseline had.
    noRegression: { lost, met: lost.length === 0 }
  }

  return {
    baselinePath,
    rerunPath,
    population: population.length,
    comparedCount: done.length,
    pending,
    totals: { compared, wholeBaseline },
    gained,
    lost,
    criteria,
    instances
  }
}

const verdictCell = (facts) => (facts === undefined ? "—" : facts.resolved ? "resolved" : facts.verdict)

/**
 * Renders the comparison as markdown.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (summary) => {
  const { compared, wholeBaseline } = summary.totals
  const lines = []
  lines.push("# Baseline vs re-run")
  lines.push("")
  lines.push(`Baseline: \`${summary.baselinePath}\``)
  lines.push(`Re-run:   \`${summary.rerunPath}\``)
  lines.push("")
  lines.push(
    `${summary.comparedCount} of ${summary.population} instances compared`
      + (summary.pending > 0 ? `; ${summary.pending} not re-run yet` : "")
  )
  lines.push("")
  lines.push("## Totals over the compared instances")
  lines.push("")
  lines.push("| | baseline | re-run | delta |")
  lines.push("| --- | ---: | ---: | ---: |")
  lines.push(
    `| resolved | ${compared.baseline.resolved}/${compared.baseline.instances}`
      + ` | ${compared.rerun.resolved}/${compared.rerun.instances}`
      + ` | ${signedInt(compared.rerun.resolved - compared.baseline.resolved)} |`
  )
  lines.push(
    `| total cost | ${money(compared.baseline.usd)} | ${money(compared.rerun.usd)}`
      + ` | ${signed(compared.rerun.usd - compared.baseline.usd)} |`
  )
  lines.push(
    `| instance wall | ${compared.baseline.wallSeconds} s | ${compared.rerun.wallSeconds} s`
      + ` | ${signedInt(compared.rerun.wallSeconds - compared.baseline.wallSeconds)} s |`
  )
  lines.push(
    `| agent wall | ${compared.baseline.agentSeconds} s | ${compared.rerun.agentSeconds} s`
      + ` | ${signedInt(compared.rerun.agentSeconds - compared.baseline.agentSeconds)} s |`
  )
  lines.push(
    `| frames | ${compared.baseline.frames} | ${compared.rerun.frames}`
      + ` | ${signedInt(compared.rerun.frames - compared.baseline.frames)} |`
  )
  lines.push("")
  lines.push(
    `The whole baseline, for reference: ${wholeBaseline.resolved}/${wholeBaseline.instances} resolved,`
      + ` ${money(wholeBaseline.usd)}, ${wholeBaseline.wallSeconds} s instance wall,`
      + ` ${wholeBaseline.agentSeconds} s agent wall, ${wholeBaseline.frames} frames.`
  )
  lines.push("")
  lines.push("## Verdicts that moved")
  lines.push("")
  lines.push(`- gained (${summary.gained.length}): ${summary.gained.join(", ") || "—"}`)
  lines.push(`- lost (${summary.lost.length}): ${summary.lost.join(", ") || "—"}`)
  lines.push("")
  lines.push("## The program's success criteria")
  lines.push("")
  lines.push("| criterion | target | actual | met |")
  lines.push("| --- | ---: | ---: | :---: |")
  const mark = (met) => (met === undefined ? "pending" : met ? "yes" : "NO")
  lines.push(
    `| resolved | >= ${summary.criteria.resolved.target}`
      + ` | ${summary.criteria.resolved.actual} | ${mark(summary.criteria.resolved.met)} |`
  )
  lines.push(
    `| total cost | <= ${money(summary.criteria.totalUsd.target)}`
      + ` | ${money(summary.criteria.totalUsd.actual)} | ${mark(summary.criteria.totalUsd.met)} |`
  )
  lines.push(
    `| instance wall | <= ${summary.criteria.wallMinutes.target} min`
      + ` | ${summary.criteria.wallMinutes.actual.toFixed(1)} min | ${mark(summary.criteria.wallMinutes.met)} |`
  )
  lines.push(
    `| no instance over ${money(summary.criteria.perInstanceUsd.target)}`
      + ` | 0 | ${summary.criteria.perInstanceUsd.over.length} | ${mark(summary.criteria.perInstanceUsd.met)} |`
  )
  lines.push(
    `| no instance over ${summary.criteria.perInstanceFrames.target} frames`
      + ` | 0 | ${summary.criteria.perInstanceFrames.over.length} | ${mark(summary.criteria.perInstanceFrames.met)} |`
  )
  lines.push(
    `| no verdict lost | 0 | ${summary.criteria.noRegression.lost.length}`
      + ` | ${mark(summary.criteria.noRegression.met)} |`
  )
  if (summary.criteria.perInstanceUsd.over.length > 0) {
    lines.push("")
    lines.push(`Over ${money(CRITERIA.instanceUsd)}: ${summary.criteria.perInstanceUsd.over.join(", ")}.`)
  }
  if (summary.criteria.perInstanceFrames.over.length > 0) {
    lines.push("")
    lines.push(`Over ${CRITERIA.instanceFrames} frames: ${summary.criteria.perInstanceFrames.over.join(", ")}.`)
  }
  lines.push("")
  lines.push("## Per instance")
  lines.push("")
  lines.push("| instance | baseline | re-run | $ before | $ after | Δ$ | frames | Δframes | agent s | Δagent s |")
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
  for (const row of summary.instances) {
    if (row.pending) {
      lines.push(
        `| ${row.id} | ${verdictCell(row.before)} | not re-run`
          + ` | ${money(row.before.usd)} | — | — | ${row.before.frames} | — | ${row.before.agentSeconds} | — |`
      )
      continue
    }
    const flag = row.moved === "gained" ? " **+**" : row.moved === "lost" ? " **-**" : ""
    lines.push(
      `| ${row.id}${flag} | ${verdictCell(row.before)} | ${verdictCell(row.after)}`
        + ` | ${money(row.before.usd)} | ${money(row.after.usd)} | ${signed(row.delta.usd)}`
        + ` | ${row.after.frames} | ${signedInt(row.delta.frames)}`
        + ` | ${row.after.agentSeconds} | ${signedInt(row.delta.agentSeconds)} |`
    )
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}

const optionValue = (argv, flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}

const main = () => {
  const argv = process.argv.slice(2)
  const baselinePath = optionValue(argv, "--baseline", join(rigRoot, "fullbench", "manifest.jsonl"))
  const rerunPath = optionValue(argv, "--rerun", join(rigRoot, "fullbench", "rerun-r91", "manifest.jsonl"))
  if (!existsSync(baselinePath)) {
    console.error(`compare-runs.mjs: no baseline ledger at ${baselinePath}`)
    process.exit(1)
  }
  const summary = compare({ baselinePath, rerunPath })
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`)
    return
  }
  const out = optionValue(argv, "--out", dirname(rerunPath))
  writeFileSync(join(out, "compare.json"), `${JSON.stringify(summary, undefined, 2)}\n`)
  writeFileSync(join(out, "compare.md"), render(summary))
  process.stdout.write(
    `compare-runs.mjs: ${summary.comparedCount}/${summary.population} compared, `
      + `resolved ${summary.totals.compared.baseline.resolved} -> ${summary.totals.compared.rerun.resolved}, `
      + `cost ${money(summary.totals.compared.baseline.usd)} -> ${money(summary.totals.compared.rerun.usd)}, `
      + `agent wall ${summary.totals.compared.baseline.agentSeconds} s -> ${summary.totals.compared.rerun.agentSeconds} s\n`
  )
  process.stdout.write(`  wrote ${join(out, "compare.md")}\n`)
}

if (import.meta.filename === process.argv[1]) main()
