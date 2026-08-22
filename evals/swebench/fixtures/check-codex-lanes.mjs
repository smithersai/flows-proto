/**
 * The codex backfill's lanes: one condition, four artifacts, one table.
 *
 * A lane names a whole measurement — the archive, the ledger, the run index, the
 * evaluator run id, and the network condition its runs are given. Moving only
 * some of them would grade one condition's patches into another condition's run
 * id with nothing on disk saying so, which is the same defect `run-45.sh`'s lane
 * exists to prevent on the flows side.
 *
 * Four things are pinned here, all offline:
 *
 * - **a lane reads its own ledger.** The same population, two lanes, two
 *   different remainders: an instance paid for in one lane is still owed in the
 *   other.
 * - **an unknown lane is refused**, rather than silently writing an archive
 *   nothing in the rig knows how to read.
 * - **the table in the script is the table in the README.** A lane added to one
 *   and not the other is a lane an operator cannot find, or a documented lane
 *   that does not exist.
 * - **no two lanes share a value.** Two lanes with one index, one ledger, one
 *   archive or one evaluator run id would produce artifacts that cannot be told
 *   apart after the fact.
 *
 * The process half — claims, slots, pulls, grading, deletion — is
 * `./codex-backfill-dryrun.sh`, which needs docker.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-lanes-"))

const jsonl = (path, rows) => writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)

const backfill = (fbDirectory, ...argv) =>
  spawnSync(join(root, "codex-backfill.sh"), argv, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FB_DIR: fbDirectory }
  })

// ---------------------------------------------------------------------------
// A lane reads its own ledger.
// ---------------------------------------------------------------------------
const fb = join(temporary, "fullbench")
mkdirSync(fb, { recursive: true })
const IDS = ["a__a-1", "b__b-2", "c__c-3"]
jsonl(
  join(fb, "manifest.jsonl"),
  IDS.flatMap((id) => [
    { kind: "instance", id, state: "graded", at: 1, verdict: "resolved" },
    { kind: "instance", id, state: "cleaned", at: 2 }
  ])
)
jsonl(join(fb, "codex-manifest.jsonl"), [
  { kind: "instance", id: "a__a-1", state: "graded", at: 3, verdict: "resolved" }
])
jsonl(join(fb, "codex-sealed-manifest.jsonl"), [
  { kind: "instance", id: "b__b-2", state: "graded", at: 3, verdict: "unresolved" }
])

const net = backfill(fb, "--list")
assert.equal(net.status, 0, net.stderr)
assert.deepEqual(net.stdout.trim().split("\n"), ["b__b-2", "c__c-3"], "the net lane reads codex-manifest.jsonl")

const sealed = backfill(fb, "--lane", "sealed", "--list")
assert.equal(sealed.status, 0, sealed.stderr)
assert.deepEqual(
  sealed.stdout.trim().split("\n"),
  ["a__a-1", "c__c-3"],
  "the sealed lane reads codex-sealed-manifest.jsonl"
)

const sealedStatus = backfill(fb, "--lane", "sealed", "--status")
assert.match(sealedStatus.stdout, /1 of 3 instances back filled, 2 left/u, "--status reads the lane's own ledger")

const bogus = backfill(fb, "--lane", "bogus", "--status")
assert.equal(bogus.status, 2, "an unknown lane is refused")
assert.match(bogus.stdout + bogus.stderr, /unknown lane/u)

const badJobs = backfill(fb, "--lane", "sealed", "--jobs", "0")
assert.equal(badJobs.status, 2, "--jobs must be a positive integer")

// ---------------------------------------------------------------------------
// The table in the script is the table in the README, and no two lanes share a
// value.
// ---------------------------------------------------------------------------
const script = readFileSync(join(root, "codex-backfill.sh"), "utf8")
const readme = readFileSync(join(root, "README.md"), "utf8")

const declared = [...script.matchAll(
  /^ {2}(?<lane>[a-z-]+)\)\n\s*FBC="\$FB\/(?<archive>[A-Za-z0-9_.-]+)"\n\s*CODEX_MANIFEST="\$FB\/(?<ledger>[A-Za-z0-9_.-]+)"\n\s*LANE_INDEX="(?<index>[A-Za-z0-9]+)"; LANE_RUN_ID="(?<runId>[A-Za-z0-9-]+)"; LANE_NETWORK="(?<network>[a-z]+)" ;;$/gmu
)].map((match) => match.groups)

assert.ok(declared.length >= 2, `the script declares at least two lanes, read ${declared.length}`)
assert.deepEqual(
  declared.map((lane) => lane.lane).sort(),
  ["net", "sealed"],
  "the lanes are net and sealed"
)

for (const key of ["archive", "ledger", "index", "runId", "network"]) {
  const values = declared.map((lane) => lane[key])
  assert.equal(new Set(values).size, values.length, `two lanes share a ${key}`)
}

for (const lane of declared) {
  const row = readme
    .split("\n")
    .find((line) => line.startsWith(`| \`${lane.lane}\``) && line.includes(lane.index))
  assert.ok(row !== undefined, `README documents the ${lane.lane} lane's index ${lane.index}`)
  for (const value of [lane.ledger, lane.runId, lane.network]) {
    assert.ok(row.includes(value), `the README row for ${lane.lane} names ${value}`)
  }
  assert.ok(
    row.includes(`fullbench/${lane.archive}/`),
    `the README row for ${lane.lane} names fullbench/${lane.archive}/`
  )
}

// The sealed lane's condition is the one `run-instance-codex.sh` implements.
const runner = readFileSync(join(root, "run-instance-codex.sh"), "utf8")
for (const condition of declared.map((lane) => lane.network)) {
  assert.match(
    runner,
    new RegExp(`^\\s{2}${condition}\\)$`, "mu"),
    `run-instance-codex.sh implements the '${condition}' network condition`
  )
}
assert.ok(
  runner.includes("shell_environment_policy.set.${PROXY_VAR}") && runner.includes("HTTPS_PROXY"),
  "the sealed condition poisons every child command's HTTP proxy"
)
assert.ok(runner.includes("--sandbox workspace-write"), "the off condition uses codex's own sandbox")
// The seal has two surfaces, and the second one is the one that was got wrong:
// `tools.web_search=false` is ignored by codex-cli 0.149.0 and the model went on
// searching the web through the first r90s lane. `web_search=disabled` is the
// key that works, and the wrong one must not come back.
assert.ok(runner.includes("web_search=disabled"), "the sealed condition disables codex's own web-search tool")
assert.ok(
  !runner.split("\n").some((line) => !line.trimStart().startsWith("#") && line.includes("tools.web_search")),
  "tools.web_search is a key this build ignores; it must not be what the seal relies on"
)
assert.ok(
  runner.includes('"$NETWORK"') && runner.includes('"network": "%s"'),
  "the condition a run was given is stamped into its timings"
)

rmSync(temporary, { recursive: true, force: true })
console.log(
  "check-codex-lanes: a lane reads its own ledger, an unknown lane is refused, no two lanes share a value,"
    + " and the script's table is the README's."
)
