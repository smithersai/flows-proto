/**
 * The codex arm twice over one population: with the network, and sealed.
 *
 *   node compare-codex-lanes.mjs [--net f] [--sealed f] [--manifest f] \
 *     [--logs dir] [--out dir] [--json]
 *
 * `compare-arms.mjs` answers "does flows resolve a superset of what codex
 * resolves", which is a question about two harnesses. This answers a different
 * one about a single harness: **how much of the codex column came from the
 * network.** The `net` lane ran with egress and used it — four
 * `curl https://api.github.com/…` calls read the merged pull request on
 * `matplotlib__matplotlib-24970` — so a column measured against it inherits a
 * caveat that no arithmetic removes. The sealed lane is the same instances, the
 * same model, the same per-instance budget and the same grading rig, with the
 * child commands' HTTP proxy pointed at a closed port.
 *
 * Three rules, each the same one the rest of the rig already obeys:
 *
 * - **A verdict that is not a grading is not a verdict.** `eval error` means the
 *   evaluator never ran the patch. Those rows are named and left out of the
 *   movement sets rather than counted as a loss on either side. `empty patch`
 *   still counts: the agent finished and changed nothing, which is a fact about
 *   the agent.
 * - **Both denominators, always.** `lib/excluded.mjs` names the instances whose
 *   verdicts are statements about the grading environment, and every count here
 *   is printed scored and raw in the same sentence.
 * - **A claimed seal is read back off the traces.** The seal is an environment
 *   one — the proxy variables every child command inherits — not a kernel-level
 *   one, so the report counts, per instance, the egress commands the transcript
 *   contains and the proxy refusals they produced. An instance that attempted
 *   egress is listed by name whatever the outcome, because the reader of a
 *   sealed number is entitled to know where the seal was pushed on.
 *
 * It reads two codex ledgers, the flows ledger and the sealed lane's own
 * transcripts. No evaluator report, no journal, no clock, no network. Running it
 * twice over the same files produces the same bytes.
 *
 * @since 0.1.0
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { attempted, population } from "./lib/codex-backfill-queue.mjs"
import { denominators, isExcluded, renderExclusions } from "./lib/excluded.mjs"

const rigRoot = import.meta.dirname

/** Verdicts that say the evaluator never produced a judgement of the patch. */
export const NOT_A_GRADING = new Set(["eval error", ""])

/**
 * Reads a verdict into one of three states.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readVerdict = (verdict) => {
  if (verdict === undefined || NOT_A_GRADING.has(verdict)) {
    return { graded: false, resolved: false, verdict: verdict ?? "not run" }
  }
  return { graded: true, resolved: verdict === "resolved", verdict }
}

/**
 * The commands a transcript contains that would have left the machine, and the
 * refusals the seal produced.
 *
 * The patterns are the shapes the `net` lane actually used plus the obvious
 * neighbours. A count of zero is the evidence a sealed run never reached for the
 * network; a count above zero is a transcript to **read**, not a finding on its
 * own — a match can be prose the agent quoted out of a docstring, which is what
 * `psf__requests-1766` turned out to be in the `net` lane. The instance is named
 * either way, because the reader of a sealed number is entitled to the list.
 *
 * @category conversions
 * @since 0.1.0
 */
export const egress = (text) => {
  // `curl: (7) …` is the *refusal*, not another attempt, so the command forms
  // are matched with the diagnostic's colon excluded. Counting it would report
  // one blocked fetch as two.
  const commands = text.match(
    /\b(?:curl|wget|git clone|git fetch|git ls-remote|pip install|pip download)(?!:)(?=[\s'"])[^\n'"]{0,120}/gu
  ) ?? []
  const refusals = text.match(/127\.0\.0\.1 port 1\b/gu) ?? []
  const proxied = text.match(/(?:proxy|Proxy)[^\n]{0,60}127\.0\.0\.1:1\b/gu) ?? []
  return {
    commands,
    attempts: commands.length,
    refusals: refusals.length + proxied.length,
    breaches: breaches(text)
  }
}

/**
 * The egress the seal does not reach: a fetch run **inside** the testbed
 * container.
 *
 * The proxy variables are set through `shell_environment_policy.set`, which
 * reaches the commands codex spawns on the host. `docker exec <container> …`
 * is one of those commands and it is allowed — both arms are told to run the
 * project's tests that way — but the process it starts is the daemon's child,
 * not codex's, so it inherits the container's environment and the container
 * keeps the network the `net` lane gave it. A `curl` on the far side of a
 * `docker exec` is therefore a hole in the seal, and it is the *only* one the
 * lane's own runs have been observed to use.
 *
 * It is reported apart from `attempts` because it is a different finding. An
 * attempt that the proxy refused is the seal working. A breach is a run that
 * read the network anyway, and on 2026-08-22 two of the 45 sealed runs did:
 * `sphinx-doc__sphinx-8721` fetched `pull/8721.patch` and
 * `sympy__sympy-19495` fetched `pull/19495.diff` — in both cases the merged
 * upstream fix, which is exactly the hindsight the lane exists to remove. A
 * verdict from a run that appears here is not a sealed verdict.
 *
 * The command's own outcome is not read: `docker exec` reports the exit status
 * of the last stage of whatever pipeline it was handed, so a `curl … | head`
 * that fetched nothing still exits 0 and a fetch that succeeded can be followed
 * by a `grep` that exits 1. The transcript is named for a human to read, which
 * is the same rule `attempts` follows.
 *
 * @category conversions
 * @since 0.1.0
 */
export const breaches = (text) => {
  const lines = text.split("\n")
  const found = []
  for (const line of lines) {
    if (!line.includes("docker exec")) continue
    const after = line.slice(line.indexOf("docker exec"))
    if (!/\b(?:curl|wget|git clone|git fetch|git ls-remote|pip install|pip download)(?!:)(?=[\s'"])/u.test(after)) {
      continue
    }
    found.push(after.slice(0, 160))
  }
  return found
}

const readLog = (logsDirectory, id) => {
  const path = join(logsDirectory, `${id}.run.log`)
  if (!existsSync(path)) return undefined
  return readFileSync(path, "utf8")
}

/**
 * The two codex lanes over the flows population.
 *
 * @category conversions
 * @since 0.1.0
 */
export const compareLanes = ({ manifestPath, netPath, sealedPath, logsDirectory }) => {
  const flows = population(manifestPath)
  const net = attempted(netPath)
  const sealed = attempted(sealedPath)

  const rows = flows.map(({ id, flowsVerdict }) => {
    const text = logsDirectory === undefined ? undefined : readLog(logsDirectory, id)
    return {
      id,
      excluded: isExcluded(id),
      flows: readVerdict(flowsVerdict),
      net: readVerdict(net.get(id)?.verdict),
      sealed: readVerdict(sealed.get(id)?.verdict),
      netWall: net.get(id)?.wallSeconds,
      sealedWall: sealed.get(id)?.wallSeconds,
      netTokens: net.get(id)?.tokens,
      sealedTokens: sealed.get(id)?.tokens,
      egress: text === undefined ? undefined : egress(text)
    }
  })

  const scored = rows.filter((row) => !row.excluded)
  const comparable = scored.filter((row) => row.net.graded && row.sealed.graded)
  const count = (list, predicate) => list.filter(predicate).length
  const denominator = denominators(rows.map((row) => row.id))

  return {
    rows,
    excluded: denominator.excluded,
    totals: {
      raw: rows.length,
      scored: scored.length,
      comparable: comparable.length,
      netResolvedScored: count(scored, (row) => row.net.resolved),
      netResolvedRaw: count(rows, (row) => row.net.resolved),
      sealedResolvedScored: count(scored, (row) => row.sealed.resolved),
      sealedResolvedRaw: count(rows, (row) => row.sealed.resolved),
      flowsResolvedScored: count(scored, (row) => row.flows.resolved),
      flowsResolvedRaw: count(rows, (row) => row.flows.resolved)
    },
    movement: {
      lostWithTheSeal: comparable.filter((row) => row.net.resolved && !row.sealed.resolved).map((row) => row.id),
      gainedWithTheSeal: comparable.filter((row) => !row.net.resolved && row.sealed.resolved).map((row) => row.id),
      unchanged: comparable.filter((row) => row.net.resolved === row.sealed.resolved).map((row) => row.id)
    },
    notComparable: scored
      .filter((row) => !row.net.graded || !row.sealed.graded)
      .map((row) => ({ id: row.id, net: row.net.verdict, sealed: row.sealed.verdict })),
    seal: {
      instancesWithAttempts: rows.filter((row) => (row.egress?.attempts ?? 0) > 0).map((row) => ({
        id: row.id,
        attempts: row.egress.attempts,
        refusals: row.egress.refusals,
        breaches: row.egress.breaches.length,
        commands: row.egress.commands.slice(0, 6)
      })),
      // The runs that reached the network through the one hole the seal does
      // not close. Their verdicts are not sealed verdicts and the report says so
      // rather than leaving them to be read out of a commands column.
      instancesWithBreaches: rows.filter((row) => (row.egress?.breaches.length ?? 0) > 0).map((row) => ({
        id: row.id,
        sealed: row.sealed.verdict,
        breaches: row.egress.breaches.length,
        commands: row.egress.breaches.slice(0, 6)
      })),
      transcriptsRead: rows.filter((row) => row.egress !== undefined).length
    }
  }
}

const verdictCell = (state) => (state.graded ? state.verdict : `_${state.verdict}_`)

/**
 * The report, as markdown.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (result) => {
  const { excluded, movement, notComparable, rows, seal, totals } = result
  const lines = []
  lines.push("# The codex arm, with the network and sealed")
  lines.push("")
  lines.push(
    `Population: **${totals.scored} scored of ${totals.raw} run**. Both arms have a real grading on`
      + ` **${totals.comparable}** of the scored instances, and only those are in the movement sets below.`
  )
  lines.push("")
  lines.push("| arm | resolved (scored) | resolved (raw) |")
  lines.push("| --- | --- | --- |")
  lines.push(`| flows \`r90\` | ${totals.flowsResolvedScored} of ${totals.scored} | ${totals.flowsResolvedRaw} of ${totals.raw} |`)
  lines.push(`| codex \`r90c\` (network) | ${totals.netResolvedScored} of ${totals.scored} | ${totals.netResolvedRaw} of ${totals.raw} |`)
  lines.push(`| codex \`r90s\` (sealed) | ${totals.sealedResolvedScored} of ${totals.scored} | ${totals.sealedResolvedRaw} of ${totals.raw} |`)
  lines.push("")
  lines.push("## What the seal moved")
  lines.push("")
  lines.push(`- **lost with the seal** (${movement.lostWithTheSeal.length}): ${movement.lostWithTheSeal.join(", ") || "none"}`)
  lines.push(`- **gained with the seal** (${movement.gainedWithTheSeal.length}): ${movement.gainedWithTheSeal.join(", ") || "none"}`)
  lines.push(`- **unchanged** (${movement.unchanged.length})`)
  lines.push("")
  if (notComparable.length > 0) {
    lines.push("Rows one arm never graded, left out of the movement sets:")
    lines.push("")
    for (const row of notComparable) lines.push(`- \`${row.id}\` — network: ${row.net}, sealed: ${row.sealed}`)
    lines.push("")
  }
  lines.push("## Was the seal pushed on")
  lines.push("")
  lines.push(
    `${seal.transcriptsRead} sealed transcripts read. The seal is an environment one — the proxy variables every`
      + " child command inherits — so a transcript that never reached for the network is the evidence that nothing"
      + " needed to be refused, and one that did has to be read."
  )
  lines.push("")
  if (seal.instancesWithAttempts.length === 0) {
    lines.push("No sealed run issued an egress command.")
  } else {
    lines.push("| instance | egress commands | proxy refusals | breaches |")
    lines.push("| --- | --- | --- | --- |")
    for (const row of seal.instancesWithAttempts) {
      lines.push(`| \`${row.id}\` | ${row.attempts} | ${row.refusals} | ${row.breaches} |`)
    }
  }
  lines.push("")
  lines.push("### Where the seal did not hold")
  lines.push("")
  if (seal.instancesWithBreaches.length === 0) {
    lines.push(
      "No sealed run fetched from inside the testbed container, which is the one way out the environment seal"
        + " does not reach."
    )
  } else {
    lines.push(
      "These runs fetched from **inside the testbed container**, where the proxy variables do not reach because the"
        + " process is the docker daemon's child rather than codex's. The container keeps the network on purpose, so"
        + " that test behaviour does not change with the condition — which makes this the one hole the seal cannot"
        + " close from outside. **A verdict on this list is not a sealed verdict**, and a rate that counts one is"
        + " quoting the network lane under the sealed lane's name."
    )
    lines.push("")
    lines.push("| instance | sealed verdict | in-container fetches | first command |")
    lines.push("| --- | --- | --- | --- |")
    for (const row of seal.instancesWithBreaches) {
      lines.push(`| \`${row.id}\` | ${row.sealed} | ${row.breaches} | \`${row.commands[0]?.replaceAll("|", "\\|")}\` |`)
    }
  }
  lines.push("")
  lines.push("## Per instance")
  lines.push("")
  lines.push("| instance | flows `r90` | codex `r90c` | codex `r90s` | sealed wall (s) |")
  lines.push("| --- | --- | --- | --- | --- |")
  for (const row of rows) {
    const mark = row.excluded ? " ⟂" : ""
    lines.push(
      `| \`${row.id}\`${mark} | ${verdictCell(row.flows)} | ${verdictCell(row.net)} | ${verdictCell(row.sealed)}`
        + ` | ${row.sealedWall ?? ""} |`
    )
  }
  lines.push("")
  lines.push("⟂ marks an instance `lib/excluded.mjs` keeps out of every rate, for both arms, with the cause on record.")
  lines.push(...renderExclusions(excluded))
  lines.push("")
  return `${lines.join("\n")}\n`
}

const main = () => {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const index = argv.indexOf(name)
    return index === -1 ? fallback : argv[index + 1]
  }
  const manifestPath = resolve(flag("--manifest", join(rigRoot, "fullbench", "manifest.jsonl")))
  const netPath = resolve(flag("--net", join(rigRoot, "fullbench", "codex-manifest.jsonl")))
  const sealedPath = resolve(flag("--sealed", join(rigRoot, "fullbench", "codex-sealed-manifest.jsonl")))
  const logsDirectory = resolve(flag("--logs", join(rigRoot, "fullbench", "codex-sealed", "logs")))
  const out = resolve(flag("--out", join(rigRoot, "fullbench", "codex-sealed")))

  for (const path of [manifestPath, netPath, sealedPath]) {
    if (!existsSync(path)) {
      console.error(`compare-codex-lanes.mjs: no ledger at ${path}`)
      process.exit(1)
    }
  }
  const result = compareLanes({
    manifestPath,
    netPath,
    sealedPath,
    logsDirectory: existsSync(logsDirectory) ? logsDirectory : undefined
  })
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)
    return
  }
  const markdown = render(result)
  writeFileSync(join(out, "lanes.md"), markdown)
  writeFileSync(join(out, "lanes.json"), `${JSON.stringify(result, undefined, 2)}\n`)
  process.stdout.write(markdown)
}

if (import.meta.filename === process.argv[1]) main()
