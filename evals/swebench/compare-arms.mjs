/**
 * The two harnesses on one population: who resolved what, and who is missing.
 *
 *   node compare-arms.mjs [--manifest f] [--codex-manifest f] [--out dir] [--json]
 *
 * `analysis/PROGRAM.md` section 4 states the standing goal in one line: **flows
 * must resolve a superset of what codex resolves on the same instances.** That
 * claim is a four-cell table — both, flows-only, codex-only, neither — and this
 * is the only place it is computed, so nobody has to count by hand again.
 *
 * Two rules make the table honest, and both are the reason it is a script rather
 * than a paragraph.
 *
 * **A verdict that is not a grading is not a verdict.** `eval error` says the
 * evaluator never ran the patch; `empty patch` says the agent produced nothing
 * and no container was ever started. Neither is evidence about a harness's
 * ability, and neither may be counted as a loss. So the four-cell table is
 * computed over the **graded intersection** — the instances where *both* arms
 * have a real verdict — and every instance outside it is listed by name and by
 * reason. A superset claim over a population where one arm is missing rows is
 * provisional in both directions, and the report says so in those words.
 *
 * `empty patch` is the one non-grading verdict that still counts. The agent
 * finished and changed nothing; that is a fact about the agent, and it counts as
 * not resolved.
 *
 * **Coverage is stated before the rate.** "23 of 27 (85 %)" and "23 of 45
 * (51 %)" are the same numerator, and quoting the first without the denominator
 * that produced it is how an incomplete arm reads as a better one.
 *
 * Reads two ledgers and nothing else: no evaluator report, no journal, no clock,
 * no network. Running it twice over the same files produces the same bytes.
 *
 * @since 0.1.0
 */
import { existsSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { attempted, population } from "./lib/codex-backfill-queue.mjs"

const rigRoot = import.meta.dirname

/** Verdicts that say the evaluator never produced a judgement of the patch. */
export const NOT_A_GRADING = new Set(["eval error", ""])

/**
 * Reads a verdict into one of three states.
 *
 * `empty patch` is graded: the agent finished and changed nothing.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readVerdict = (verdict) => {
  if (verdict === undefined || NOT_A_GRADING.has(verdict)) return { graded: false, resolved: false, verdict: verdict ?? "not run" }
  return { graded: true, resolved: verdict === "resolved", verdict }
}

/**
 * The two arms over the flows population.
 *
 * @category conversions
 * @since 0.1.0
 */
export const compareArms = ({ manifestPath, codexManifestPath }) => {
  const flows = population(manifestPath)
  const codex = attempted(codexManifestPath)

  const rows = flows.map(({ id, flowsVerdict }) => ({
    id,
    flows: readVerdict(flowsVerdict),
    codex: readVerdict(codex.get(id)?.verdict)
  }))

  const graded = rows.filter((row) => row.flows.graded && row.codex.graded)
  const cell = (f, c) => graded.filter((row) => row.flows.resolved === f && row.codex.resolved === c).map((row) => row.id)
  const agreement = {
    both: cell(true, true),
    flowsOnly: cell(true, false),
    codexOnly: cell(false, true),
    neither: cell(false, false)
  }

  const ungraded = {
    flows: rows.filter((row) => !row.flows.graded).map((row) => ({ id: row.id, verdict: row.flows.verdict })),
    codex: rows.filter((row) => !row.codex.graded).map((row) => ({ id: row.id, verdict: row.codex.verdict }))
  }

  return {
    manifestPath,
    codexManifestPath,
    population: rows.length,
    gradedBoth: graded.length,
    coverage: {
      flows: rows.filter((row) => row.flows.graded).length,
      codex: rows.filter((row) => row.codex.graded).length
    },
    resolvedOverPopulation: {
      flows: rows.filter((row) => row.flows.resolved).length,
      codex: rows.filter((row) => row.codex.resolved).length
    },
    resolvedOverGradedBoth: {
      flows: graded.filter((row) => row.flows.resolved).length,
      codex: graded.filter((row) => row.codex.resolved).length
    },
    agreement,
    // The standing goal: flows resolves everything codex does, and possibly more.
    superset: { met: agreement.codexOnly.length === 0, provisional: ungraded.codex.length > 0 || ungraded.flows.length > 0 },
    ungraded,
    rows
  }
}

const percent = (part, whole) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(0)} %`)

const list = (ids) => (ids.length === 0 ? "—" : ids.join(", "))

/**
 * Renders the scoreboard as markdown.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (summary) => {
  const { agreement, coverage, resolvedOverGradedBoth, resolvedOverPopulation } = summary
  const lines = []
  lines.push("# flows vs codex on the full-benchmark population")
  lines.push("")
  lines.push(`Population: ${summary.population} instances (every instance the full benchmark graded).`)
  lines.push(
    `Graded by both arms: ${summary.gradedBoth}.`
      + ` flows has a grading on ${coverage.flows}, codex on ${coverage.codex}.`
  )
  lines.push("")
  lines.push("## Agreement over the instances both arms graded")
  lines.push("")
  lines.push("| | count | instances |")
  lines.push("| --- | ---: | --- |")
  lines.push(`| both resolved | ${agreement.both.length} | ${list(agreement.both)} |`)
  lines.push(`| **flows only** | ${agreement.flowsOnly.length} | ${list(agreement.flowsOnly)} |`)
  lines.push(`| **codex only** | ${agreement.codexOnly.length} | ${list(agreement.codexOnly)} |`)
  lines.push(`| neither | ${agreement.neither.length} | ${list(agreement.neither)} |`)
  lines.push("")
  lines.push(
    `On that graded-${summary.gradedBoth} subset: flows ${resolvedOverGradedBoth.flows}`
      + ` (${percent(resolvedOverGradedBoth.flows, summary.gradedBoth)}),`
      + ` codex ${resolvedOverGradedBoth.codex} (${percent(resolvedOverGradedBoth.codex, summary.gradedBoth)}).`
  )
  lines.push(
    `Over the whole ${summary.population}: flows ${resolvedOverPopulation.flows}`
      + ` (${percent(resolvedOverPopulation.flows, summary.population)}),`
      + ` codex ${resolvedOverPopulation.codex} (${percent(resolvedOverPopulation.codex, summary.population)}).`
  )
  lines.push("")
  lines.push("## The superset goal")
  lines.push("")
  if (summary.superset.met) {
    lines.push(`**Holds on the graded subset**: codex-only is empty, flows-only is ${agreement.flowsOnly.length}.`)
  } else {
    lines.push(
      `**Fails on the graded subset**: codex-only is ${agreement.codexOnly.length}`
        + ` (${list(agreement.codexOnly)}), flows-only is ${agreement.flowsOnly.length}.`
    )
  }
  if (summary.superset.provisional) {
    lines.push("")
    lines.push(
      "The claim is **provisional in both directions**: one or both arms are missing"
        + " gradings, and a missing grading can move either cell."
    )
  }
  if (summary.ungraded.flows.length > 0 || summary.ungraded.codex.length > 0) {
    lines.push("")
    lines.push("## Instances outside the graded intersection")
    lines.push("")
    lines.push("| instance | arm | why it is not a grading |")
    lines.push("| --- | --- | --- |")
    for (const row of summary.ungraded.flows) lines.push(`| ${row.id} | flows | ${row.verdict} |`)
    for (const row of summary.ungraded.codex) lines.push(`| ${row.id} | codex | ${row.verdict} |`)
  }
  lines.push("")
  lines.push("## Per instance")
  lines.push("")
  lines.push("| instance | flows | codex |")
  lines.push("| --- | --- | --- |")
  for (const row of summary.rows) lines.push(`| ${row.id} | ${row.flows.verdict} | ${row.codex.verdict} |`)
  lines.push("")
  return `${lines.join("\n")}\n`
}

const optionValue = (argv, flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}

const main = () => {
  const argv = process.argv.slice(2)
  const manifestPath = optionValue(argv, "--manifest", join(rigRoot, "fullbench", "manifest.jsonl"))
  const codexManifestPath = optionValue(argv, "--codex-manifest", join(rigRoot, "fullbench", "codex-manifest.jsonl"))
  if (!existsSync(manifestPath)) {
    console.error(`compare-arms.mjs: no flows ledger at ${manifestPath}`)
    process.exit(1)
  }
  const summary = compareArms({ manifestPath, codexManifestPath })
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`)
    return
  }
  const out = optionValue(argv, "--out", dirname(manifestPath))
  writeFileSync(join(out, "arms.json"), `${JSON.stringify(summary, undefined, 2)}\n`)
  writeFileSync(join(out, "arms.md"), render(summary))
  process.stdout.write(
    `compare-arms.mjs: ${summary.gradedBoth}/${summary.population} graded by both — `
      + `both ${summary.agreement.both.length}, flows-only ${summary.agreement.flowsOnly.length}, `
      + `codex-only ${summary.agreement.codexOnly.length}, neither ${summary.agreement.neither.length}\n`
  )
  process.stdout.write(`  wrote ${join(out, "arms.md")}\n`)
}

if (import.meta.filename === process.argv[1]) main()
