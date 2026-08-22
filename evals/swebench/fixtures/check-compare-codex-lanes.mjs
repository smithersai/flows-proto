/**
 * Replays the two-codex-lane scoreboard over synthesised ledgers and traces.
 *
 * The question that report answers — how much of the codex column came from the
 * network — has three ways to be answered dishonestly, and all three are pinned
 * here:
 *
 * - **a verdict that is not a grading is not a loss.** An `eval error` in either
 *   lane leaves the movement sets and is named instead. Counting one would
 *   manufacture a "lost with the seal" out of a docker fault, which is the
 *   headline the report exists to state.
 * - **both denominators, always.** `lib/excluded.mjs` keeps two `psf/requests`
 *   rows out of every rate; the scored count and the raw count are printed in
 *   one sentence, and an excluded row is in neither movement set.
 * - **a claimed seal is read back off the traces.** A run that never reached for
 *   the network and a run that reached and was refused are different findings,
 *   so the transcripts are counted rather than assumed, and an instance that
 *   attempted egress is named whatever its verdict.
 *
 * The report is also asserted to be a pure function of its inputs: the same
 * ledgers twice produce the same bytes.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { compareLanes, egress, readVerdict, render } from "../compare-codex-lanes.mjs"
import { EXCLUDED } from "../lib/excluded.mjs"

const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-lanes-report-"))
const excludedId = [...EXCLUDED.keys()][0]

const jsonl = (path, rows) => {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return path
}

const flowsRows = (id, verdict) => [
  { kind: "instance", id, state: "pulled", at: 1 },
  { kind: "instance", id, state: "graded", at: 2, verdict },
  { kind: "instance", id, state: "cleaned", at: 3 }
]

const codexRow = (id, verdict, extra = {}) => ({ kind: "instance", id, state: "graded", at: 2, verdict, ...extra })

try {
  // What each verdict means, stated once.
  assert.equal(readVerdict("resolved").resolved, true)
  assert.equal(readVerdict("empty patch").graded, true)
  assert.equal(readVerdict("eval error").graded, false)
  assert.equal(readVerdict(undefined).verdict, "not run")

  // What a transcript is read for.
  assert.deepEqual(egress("nothing here").attempts, 0)
  const reached = egress("$ curl -sS https://api.github.com/repos/x/y\ncurl: (7) Failed to connect to 127.0.0.1 port 1")
  assert.equal(reached.attempts, 1)
  assert.equal(reached.refusals, 1)
  assert.equal(reached.breaches.length, 0)

  // A fetch on the far side of a `docker exec` is the one way out the proxy
  // seal does not reach, so it is counted apart from an attempt the proxy
  // refused. Proving both halves: a host fetch is never a breach, and a
  // container fetch is one even when it is also counted as an attempt.
  const breached = egress(
    "/bin/zsh -lc \"docker exec box bash -lc 'curl -fsSL https://github.com/o/r/pull/1.patch'\" in /tmp/w"
  )
  assert.equal(breached.attempts, 1)
  assert.equal(breached.breaches.length, 1)
  assert.match(breached.breaches[0], /^docker exec box/u)
  // `docker exec` on its own is how both arms run the project's tests, so it is
  // a breach only when it carries a fetch.
  assert.equal(egress("/bin/zsh -lc \"docker exec box bash -lc 'pytest -q'\" in /tmp/w").breaches.length, 0)

  const manifest = join(temporary, "manifest.jsonl")
  const net = join(temporary, "codex-manifest.jsonl")
  const sealed = join(temporary, "codex-sealed-manifest.jsonl")
  const logs = join(temporary, "logs")
  mkdirSync(logs, { recursive: true })

  jsonl(manifest, [
    ...flowsRows("a__a-1", "resolved"),
    ...flowsRows("b__b-2", "unresolved"),
    ...flowsRows("c__c-3", "resolved"),
    ...flowsRows("d__d-4", "resolved"),
    ...flowsRows(excludedId, "resolved")
  ])
  jsonl(net, [
    codexRow("a__a-1", "resolved", { wallSeconds: 10, tokens: 100 }),
    codexRow("b__b-2", "resolved"),
    codexRow("c__c-3", "unresolved"),
    codexRow("d__d-4", "eval error"),
    codexRow(excludedId, "resolved")
  ])
  jsonl(sealed, [
    codexRow("a__a-1", "resolved", { wallSeconds: 12, tokens: 120 }),
    codexRow("b__b-2", "unresolved"),
    codexRow("c__c-3", "resolved"),
    codexRow("d__d-4", "resolved"),
    codexRow(excludedId, "unresolved")
  ])
  writeFileSync(join(logs, "a__a-1.run.log"), "docker exec box bash -lc 'pytest -q'\n")
  writeFileSync(
    join(logs, "b__b-2.run.log"),
    "curl -sS https://api.github.com/repos/x/y/pulls/1\ncurl: (7) Failed to connect to 127.0.0.1 port 1 after 0 ms\n"
  )
  // The run that got out anyway: the fetch is on the far side of a `docker
  // exec`, so the proxy the seal set never applied to it.
  writeFileSync(
    join(logs, "c__c-3.run.log"),
    "/bin/zsh -lc \"docker exec box bash -lc 'curl -fsSL https://github.com/x/y/pull/3.patch'\" in /tmp/w\n"
  )

  const result = compareLanes({ manifestPath: manifest, netPath: net, sealedPath: sealed, logsDirectory: logs })

  // An eval error in either lane is outside the movement sets, and named.
  assert.ok(!result.movement.lostWithTheSeal.includes("d__d-4"))
  assert.ok(!result.movement.gainedWithTheSeal.includes("d__d-4"))
  assert.deepEqual(result.notComparable.map((row) => row.id), ["d__d-4"])

  // The seal moved exactly one row each way, over the scored, comparable rows.
  assert.deepEqual(result.movement.lostWithTheSeal, ["b__b-2"])
  assert.deepEqual(result.movement.gainedWithTheSeal, ["c__c-3"])
  assert.equal(result.totals.comparable, 3)

  // An excluded instance is in no movement set and in both denominators.
  for (const set of Object.values(result.movement)) assert.ok(!set.includes(excludedId))
  assert.equal(result.totals.raw, 5)
  assert.equal(result.totals.scored, 4)
  assert.equal(result.totals.netResolvedRaw, result.totals.netResolvedScored + 1, "the excluded row is in the raw count")

  // The traces are counted rather than assumed.
  assert.equal(result.seal.transcriptsRead, 3)
  assert.deepEqual(result.seal.instancesWithAttempts.map((row) => row.id), ["b__b-2", "c__c-3"])
  assert.equal(result.seal.instancesWithAttempts[0].refusals, 1)

  // A refused attempt is the seal working; a container fetch is the seal not
  // holding, and only the second one may void a verdict. They are separate
  // columns because they are separate findings.
  assert.equal(result.seal.instancesWithAttempts[0].breaches, 0)
  assert.deepEqual(result.seal.instancesWithBreaches.map((row) => row.id), ["c__c-3"])
  assert.equal(result.seal.instancesWithBreaches[0].sealed, "resolved", "a breach carries the verdict it casts doubt on")

  const markdown = render(result)
  assert.match(markdown, /4 scored of 5 run/u, "both denominators are stated before any rate")
  assert.match(markdown, /lost with the seal\*\* \(1\): b__b-2/u)
  assert.match(markdown, /gained with the seal\*\* \(1\): c__c-3/u)
  assert.match(markdown, /d__d-4` — network: eval error/u, "a row one lane never graded is named")
  assert.match(markdown, /Excluded from the scoreboard, by name/u)
  assert.match(markdown, /Where the seal did not hold/u)
  assert.match(markdown, /A verdict on this list is not a sealed verdict/u, "a breach is stated, not left to be inferred")
  assert.match(markdown, /\| `c__c-3` \| resolved \| 1 \|/u)
  assert.equal(markdown, render(compareLanes({
    manifestPath: manifest,
    netPath: net,
    sealedPath: sealed,
    logsDirectory: logs
  })), "the same ledgers twice produce the same bytes")

  console.log(
    "check-compare-codex-lanes: an eval error is never a loss, an exclusion is in no movement set and in both"
      + " denominators, the seal's evidence is counted off the traces, and the report is deterministic."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
