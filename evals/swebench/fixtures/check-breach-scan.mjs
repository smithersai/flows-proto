/**
 * The one-lane seal scan, over recorded rows rather than a live daemon.
 *
 * `compare-codex-lanes.mjs` asserts the seal as one column of a two-lane
 * comparison, which is a codex-shaped question. `breach-scan.mjs` asks it of a
 * single lane of **either** arm, because from 2026-08-24 both arms run their
 * testbed on `--network none` and a claim made for one is worth nothing unless
 * the same evidence is produced for the other.
 *
 * What this pins:
 *
 * - **the assertion reads the observation, never the request.** A lane that
 *   asked for `none` and ran on `bridge` fails. A lane with no observation at
 *   all fails the same way, because an unmeasured container is not a sealed one.
 * - **the flows arm's trace is its journal.** A codex run's commands are in its
 *   transcript; a flows run's are in `flows_journal_events.payload_json`, and a
 *   scan that read only the driver's log would clear every flows lane by
 *   looking in the wrong file.
 * - **an untraced instance is a failure, not a pass.** Scanning a missing file
 *   as the empty string is how a lane clears itself by losing its evidence.
 * - **a lane that claims nothing is reported, not graded.** The three lanes
 *   that ran before the field existed render their counts and say outright that
 *   the verdict is not asserted, so an unrecorded lane can never print the word
 *   the sealed lanes earn.
 *
 * The half that needs a real daemon — `docker exec` against a `--network none`
 * container, the inspect readback — is `./network-dryrun.sh`.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { foldLedger, render, scan } from "../breach-scan.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-breach-"))

const jsonl = (path, rows) => {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return path
}

/** A flows journal holding exactly the payloads a scan has to see. */
const journal = (directory, payloads) => {
  mkdirSync(directory, { recursive: true })
  const db = new DatabaseSync(join(directory, "engine.db"))
  db.exec("create table flows_journal_events (payload_json text, meta_json text)")
  const insert = db.prepare("insert into flows_journal_events values (?, ?)")
  for (const payload of payloads) insert.run(payload, "null")
  db.close()
}

try {
  // -------------------------------------------------------------------------
  // The fold: several rows per instance, and the testbed fields on any of them.
  // -------------------------------------------------------------------------
  const folded = foldLedger(
    [
      { kind: "instance", id: "a__a-1", state: "started", at: 1 },
      { kind: "instance", id: "a__a-1", state: "ran", at: 2, testbedNetwork: "none", testbedNetworkObserved: "none" },
      { kind: "instance", id: "a__a-1", state: "graded", at: 3, verdict: "resolved" },
      { kind: "checkpoint", at: 4 },
      "not json"
    ].map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n")
  )
  assert.equal(folded.length, 1, "one instance, however many rows it wrote")
  assert.equal(folded[0].observed, "none")
  assert.equal(folded[0].requested, "none")
  assert.equal(folded[0].verdict, "resolved")

  // -------------------------------------------------------------------------
  // A sealed flows lane: the commands live in the journal, and there are none.
  // -------------------------------------------------------------------------
  const sealedDirectory = join(temporary, "sealed")
  mkdirSync(join(sealedDirectory, "logs"), { recursive: true })
  journal(join(sealedDirectory, "journals", "a__a-1"), [
    JSON.stringify({ flow: "bash", input: { command: "python -m pytest tests/test_a.py" } })
  ])
  writeFileSync(join(sealedDirectory, "logs", "a__a-1.run.log"), "[a__a-1-r98] agent start\n")
  const sealedLedger = jsonl(join(sealedDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "none" },
    { kind: "instance", id: "a__a-1", state: "graded", at: 2, verdict: "resolved" }
  ])
  const sealed = scan({
    journals: join(sealedDirectory, "journals"),
    ledger: sealedLedger,
    logs: join(sealedDirectory, "logs"),
    require: "none"
  })
  assert.equal(sealed.claim, "none")
  assert.deepEqual(sealed.failures, [], "a sealed lane passes")
  assert.equal(sealed.totals.attempts, 0)
  assert.equal(sealed.totals.breaches, 0)
  assert.ok(render(sealed, { label: "x", ledger: sealedLedger }).includes("**Verdict: sealed.**"))

  // -------------------------------------------------------------------------
  // The flows arm's trace is the journal. A fetch recorded only there is found.
  // -------------------------------------------------------------------------
  const journalOnly = join(temporary, "journal-only")
  mkdirSync(join(journalOnly, "logs"), { recursive: true })
  journal(join(journalOnly, "journals", "a__a-1"), [
    JSON.stringify({ flow: "bash", input: { command: "docker exec swb curl -sL https://example.com/fix.patch" } })
  ])
  writeFileSync(join(journalOnly, "logs", "a__a-1.run.log"), "[a__a-1-r98] agent start\n")
  const journalLedger = jsonl(join(journalOnly, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "none" }
  ])
  const fetched = scan({
    journals: join(journalOnly, "journals"),
    ledger: journalLedger,
    logs: join(journalOnly, "logs"),
    require: "none"
  })
  assert.equal(fetched.totals.breaches, 1, "a fetch recorded only in the journal is still a breach")
  assert.equal(fetched.breached[0].id, "a__a-1")
  assert.ok(fetched.failures.some((failure) => failure.includes("fetched from inside the testbed")))
  assert.ok(render(fetched, { label: "x", ledger: journalLedger }).includes("Where the seal did not hold"))

  // -------------------------------------------------------------------------
  // The assertion reads the observation, never the request.
  // -------------------------------------------------------------------------
  const liedDirectory = join(temporary, "lied")
  mkdirSync(join(liedDirectory, "logs"), { recursive: true })
  const liedLedger = jsonl(join(liedDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "bridge" }
  ])
  writeFileSync(join(liedDirectory, "logs", "a__a-1.run.log"), "quiet\n")
  const lied = scan({ ledger: liedLedger, logs: join(liedDirectory, "logs"), require: "none" })
  assert.equal(lied.claim, "none", "the claim is what the lane asked for")
  assert.ok(
    lied.failures.some((failure) => failure.includes("not observed `none`")),
    "and the assertion is what the container reported"
  )

  // -------------------------------------------------------------------------
  // An instance with no trace at all fails rather than passing on emptiness.
  // -------------------------------------------------------------------------
  const untracedDirectory = join(temporary, "untraced")
  mkdirSync(join(untracedDirectory, "logs"), { recursive: true })
  const untracedLedger = jsonl(join(untracedDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "none" }
  ])
  const untraced = scan({ ledger: untracedLedger, logs: join(untracedDirectory, "logs"), require: "none" })
  assert.equal(untraced.untraced.length, 1)
  assert.ok(untraced.failures.some((failure) => failure.includes("left no trace")))

  // -------------------------------------------------------------------------
  // A lane that claims nothing is read, not graded.
  // -------------------------------------------------------------------------
  const oldDirectory = join(temporary, "old")
  mkdirSync(join(oldDirectory, "logs"), { recursive: true })
  writeFileSync(join(oldDirectory, "logs", "a__a-1.run.log"), "curl https://example.com/x\n")
  const oldLedger = jsonl(join(oldDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1 }
  ])
  const old = scan({ ledger: oldLedger, logs: join(oldDirectory, "logs") })
  assert.equal(old.claim, "unrecorded")
  assert.equal(old.asserted, false)
  assert.deepEqual(old.failures, [], "an unrecorded lane is not failed for being old")
  assert.equal(old.totals.attempts, 1, "its attempts are still counted and printed")
  const oldReport = render(old, { label: "x", ledger: oldLedger })
  assert.ok(oldReport.includes("**Verdict: not asserted.**"))
  assert.ok(!oldReport.includes("**Verdict: sealed.**"), "an unrecorded lane never prints the sealed verdict")

  // -------------------------------------------------------------------------
  // A lane measured under two conditions is not one measurement.
  // -------------------------------------------------------------------------
  const mixedDirectory = join(temporary, "mixed")
  mkdirSync(join(mixedDirectory, "logs"), { recursive: true })
  for (const id of ["a__a-1", "b__b-2"]) writeFileSync(join(mixedDirectory, "logs", `${id}.run.log`), "quiet\n")
  const mixedLedger = jsonl(join(mixedDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "none" },
    { kind: "instance", id: "b__b-2", state: "ran", at: 2, testbedNetwork: "bridge", testbedNetworkObserved: "bridge" }
  ])
  const mixed = scan({ ledger: mixedLedger, logs: join(mixedDirectory, "logs"), require: "none" })
  assert.equal(mixed.claim, "mixed")
  assert.ok(mixed.failures.length > 0, "a mixed lane fails a none requirement")

  console.log(
    "check-breach-scan: one lane of either arm, asserted off the observation and not the request, with the flows"
      + " arm's commands read out of its journal, an untraced instance failed rather than cleared, and a lane that"
      + " recorded no condition reported rather than graded."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
