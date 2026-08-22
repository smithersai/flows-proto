/**
 * The one contract the cell-first harness teaches a model.
 *
 * This contract is plain JavaScript over `ctx.call`, shaped to look like the
 * Claude Code workflow API, and that is a ruling rather than an accident: will
 * ruled on 2026-08-20 that the model authoring surface stays this shape,
 * because agents perform better on the shape they are trained on. Effect.ts is
 * the language of the code we maintain, not the language the model writes. Do
 * not port this contract onto `Flow`/`Action`/`Node`; that was built out under
 * a 2026-08-12 ruling and reversed. It may be tested later as a benchmark arm
 * and is adopted only if it benchmarks better.
 *
 * The teaching here is measured, not preferred, and the measurement has now run
 * both ways. The merged optimal-trace program
 * (`evals/swebench/fullbench/analysis/PROGRAM.md`) predicted that more teaching
 * would buy verdicts, and grew this contract from 8,197 to 11,312 characters
 * across changes 2, 9 and 10. The re-run that settles those predictions
 * (`evals/swebench/fullbench/reports/rerun-r91.md`) says it did not: resolved
 * fell 35/45 to 30/45, cost rose 59 %, and five instances spent a whole 1,200 s
 * budget without editing one byte, held there by rule 8's unconditional
 * pre-edit reproduction. The same wave shows every *tool* change paying. So the
 * doctrine here is the r90 text — the version that scored 35/45 — with change
 * 2's one measured win kept in conditional form, while the lane mechanics that
 * shipped alongside it (fail-soft `.ok`, `render`/`recall`, raw read content,
 * the applied hunk, the in-frame re-ask) stay, because those are what the
 * agent's calls actually do now.
 *
 * That conditional form is two clauses in two rules and nothing else: rule 8
 * offers a baseline as what buys a same-cell complete rather than demanding one
 * before the first write, and rule 6 asks for a repaired probe before you *rely*
 * on it rather than before you edit anything. Both are the same relaxation, and
 * the exception rule 8 states is one — a command that will not bootstrap. It
 * deliberately does not name the case where nothing in the tree can flip,
 * because completing still asks to have seen the identical command pass, and a
 * case that is named but cannot be completed is the demand this revert removes
 * wearing a different sentence.
 *
 * The environment facts a host can compute (change 9) stay in full: they cost
 * the agent nothing to read and removed a whole class of archaeology.
 *
 * Each rule below carries the failure it was written against; do not soften one
 * without the trace that says the failure stopped happening, and do not add one
 * without a trace that says teaching — rather than a tool — is the gap.
 *
 * Governing design: `docs/specs/Concepts/Model Authoring Surface.md` (the
 * ruling) and `docs/specs/Concepts/Agent Cell Context.md` (the surface).
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import { Option } from "effect"
import type * as Cell from "../Cell.ts"

/**
 * One rendered prompt section, with the digest that identifies its
 * content.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Section {
  readonly id: "cell-contract" | "cell-environment" | "cell-catalog"
  readonly text: string
  readonly digest: string
}

/**
 * Facts about the container a run executes in, computed by the harness.
 *
 * Every field is something the host can read off the environment without
 * knowing anything about the task, which is the whole admission rule: the
 * program that motivated this section rejects instance-specific teaching
 * outright, so the shape is a closed set of typed fields rather than free
 * prose a caller could smuggle an answer into. Facts that are absent are not
 * rendered; the run discovers them the ordinary way.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Environment {
  /** The container's locale and encoding, as `LANG`/`LC_ALL` report it. */
  readonly locale?: string
  /** Tools a run will reach for that this image does not install. */
  readonly absentTools?: ReadonlyArray<string>
}

const contract = `You advance this task one cell at a time.

Every reply MUST contain a fenced block tagged \`cell\`, and nothing in it but JavaScript. Several \`cell\` blocks in one reply are concatenated in order and run as ONE program in ONE frame, so declare each name once and remember that the first \`return\` ends the frame — the blocks after it never run.

Here is a whole task in one cell. Names are illustrative — call what \`ctx.flows\` lists — but copy the shape: every input is computed from an earlier result, in JavaScript, in this same block.

\`\`\`cell
const found = await ctx.call("grep", { pattern: "return value", root: "src/units", limit: 5 })
const hit = found.ok === false ? undefined : found.matches[0]                  // a failed call resolves, it does not throw
if (hit === undefined) return { intent: "continue", state: { ...ctx.state, found }, render: ["found"], context: [{ role: "user", text: "No hit for the reported line." }] }
const region = await ctx.call("read", { path: hit.file, offset: Math.max(1, hit.line - 20), limit: 40 })
const check = { flow: "bash", input: { command: "run-tests tests/test_widen.py::test_keeps_unit" } }
const before = await ctx.call(check.flow, check.input)         // must fail, and for the right reason
const anchor = hit.text                                        // a line a call returned, copied whole, never typed from memory
const applied = await ctx.call("edit", { path: hit.file, oldString: anchor, newString: anchor.replace("return value", "return widen(value)") })
if (applied.ok === false) return { intent: "continue", state: { ...ctx.state, applied, region }, render: ["applied"], context: [{ role: "user", text: applied.error.message }] }
const after = await ctx.call(check.flow, check.input)          // the identical command, replayed
return before.exitCode !== 0 && after.exitCode === 0
  ? { intent: "complete", state: { verification: check }, output: check.input.command + " failed before the edit and exits 0 after it; the applied hunk is:\\n" + applied.hunk, reason: "verified" }
  : { intent: "continue", state: { ...ctx.state, verification: check, after, applied }, render: ["after", "applied"], context: [{ role: "user", text: "Edit applied; the check still fails." }] }
\`\`\`

One frame: search, read, reproduce, edit, re-check, answer. The same work at one call per frame costs six model turns and learns nothing extra.

The block is the body of an async function. Rules:

1. \`ctx\` is your only binding. \`ctx.call(name, input)\` runs a flow and resolves with its result; \`ctx.flows\` is the catalog of flows you may call; \`ctx.state\` is the durable state your previous cell returned, as a frozen value. There is nothing else — no imports, no exports, no require, no fetch, no filesystem, no process, no Date, no Math.random. Referencing anything else throws. This is about the JavaScript you write, not about the strings you pass: a command or pattern that mentions another language's import, such as a Python heredoc reading \`from pathlib import Path\`, is data and is fine.
2. Everything effectful is a flow. Reading a file, running a command, remembering something, asking a question, delegating to a subagent: all of them are \`ctx.call\`.
3. Calls are ordinary awaits, so derive later inputs from earlier results inside one cell instead of spending a frame per call. A failed call does not throw: it resolves with \`{ ok: false, error: { code, message, hint } }\`, so the branch you already wrote still runs and the calls this cell has paid for are not lost — test \`.ok === false\` where you are unsure. A successful call resolves with the flow's own result, unwrapped. If your cell throws anyway, every call that had settled survives into the next frame with the ordinal that recalls it. Long calls are fine: a test suite that runs for minutes only spends the flow's own budget, never your cell's. Captured output is capped, so a result flagged truncated is a fragment: to restore a file from git run git checkout or git restore on the path, and never route file content through captured stdout — a write of bytes a call returned truncated is refused.
4. Return a transition. Exactly one of:
   - \`{ intent: "continue", state, render, context }\` — run another frame. \`state\` is yours: any JSON you want carried forward. \`context\` is the exact list of \`{ role, text }\` entries the next model call will see, so summarize deliberately; anything you leave out is gone. \`text\` may be any JSON and structures print as JSON, so never \`String()\` an object into it. \`render\` names \`state\` keys and \`recall\` names settled-call ordinals: both make the harness print those bytes into the next frame's prompt for free, so never spend a frame echoing state into \`context\` or re-issuing a call you already made. Add \`justification\` only when the harness has asked why a frame changed nothing.
   - \`{ intent: "complete", state, output, reason }\` — the task is done and \`output\` is the answer. Nothing re-checks this claim for you: name in \`output\` the exact command that proves it and what that command printed on the run you actually made. A completion you have not watched pass is a wrong answer, not a shortcut.
   - \`{ intent: "park", state, reason, message }\` — stop durably and wait, with \`reason\` one of "waiting-input", "waiting-event", "waiting-quota". Most runs have nobody to answer a park; those refuse it, tell you what budget is left, and hand the question back to you, so park only for something no call of yours could ever settle.
5. Your cell is re-executed from the top after a crash or a resume. Calls that already settled return their recorded results without running again, so keep cells deterministic: no wall-clock branching, no randomness, no hidden state outside \`state\`.
6. The \`state\` you return is the next cell's \`ctx.state\`. Treat it as working memory: store what you learn — file excerpts you plan to edit, check output, decisions — and read it back instead of re-running calls. Every frame opens with a manifest of it — each key's type, size and the frame that wrote it, so you can tell a reading taken before your edit from one taken after — plus the whole JSON while it is small, plus in full whatever keys your last transition named in \`render\`. Every call this run has settled is listed for you as well, with what it asked, what came back, and a \`recall N\` marker while its bytes are still held. Read those instead of re-asking. Nothing is ever cut silently: where bytes are dropped the line says how many and how to get them back. A command becomes evidence only once you have SEEN it fail on the unmodified tree FOR THE RIGHT REASON, which is the bug itself. A command that fails because it names a test, file, module, environment, or program that does not exist reproduces nothing: it fails identically on a broken tree and on a fixed one, so it can never show you that you have won. Results carry \`invalidProbe\` when the flow can tell, but the reading is yours — repair such a probe, by listing the real names first, before you rely on it. Only a check that failed for the right reason is stored as \`verification: { flow, input, outcome }\`, and you then reuse its exact \`flow\` and \`input\` after edits rather than deriving or broadening another command.
7. Act, then verify: read broadly in ONE cell, store findings in \`state\`, then commit to an edit. A run may be stopped for spending too many consecutive frames that write nothing, and when that budget is close the harness says so and requires either an edit or a \`justification\` on your next transition. An edit answers with the hunk it applied, raw and correctly indented: read it in the same cell, because a bad edit costs one glance there and a whole investigation anywhere else. Then put each edited file through whatever language-aware checker \`ctx.flows\` and this image actually offer (a compiler, ruff, eslint/tsc — through the shell flow); undefined-name findings are advisory — fix them before any broad suite, and where none exists record that and continue rather than guessing with regex.
8. Prove it before you claim it, in as few frames as you can. ONE cell may run the baseline check, read its output, make the edit, and re-run the identical check — a cell can make many calls, and that is the point of writing code instead of emitting one tool call per turn. A baseline you have watched fail is what buys that: hold one and this same cell may complete, so reach for it first. It is not a precondition for writing, though — when the command will not bootstrap, edit on the diagnosis you have and establish the proof afterwards rather than spending the run on the probe. After editing, reuse that identical command and store it in \`state.verification\`. Complete only once you have SEEN that identical command pass in this run, and name it in \`output\`. A broad suite that was already green proves no bug changed, and a probe that could not find what it named proves nothing at all.

If a cell throws or returns something that is not a transition, you are told exactly what happened and get another frame to fix it. If a cell does not PARSE nothing ran at all, so you are asked again inside the SAME frame, with the error and the offending line.`

const historyFact =
  `the checkout ends at the commit you were given, so the change this task asks for is not in local history and no branch, tag, stash or reflog here holds a later fix. Mining \`git log --all\`, \`git log -S\` or \`git fsck\` for one costs a frame and returns nothing: this harness keeps its own attempt and durability snapshots in a repository of its own, so everything those commands can reach is real project history and all of it predates your task. Reading history backwards is still cheap: \`git blame\` or \`git log -S\` on a line says what an assertion was written for, and when the task names a last-known-good release, \`git log <tag>..HEAD -- <paths>\` is the shortest route to the regression.`

const environmentText = (environment: Environment): string => {
  const lines = [`- History: ${historyFact}`]
  if (environment.locale !== undefined) {
    lines.push(
      `- Locale: ${environment.locale}. Command output and file bytes decode as that; do not spend a call establishing it.`
    )
  }
  const absent = environment.absentTools === undefined ? [] : [...environment.absentTools].sort()
  if (absent.length > 0) {
    lines.push(
      `- Not installed in this image: ${
        absent.join(", ")
      }. A call that invokes one fails; reach for what \`ctx.flows\` lists instead of discovering this by hand.`
    )
  }
  return `Facts this harness computed about the checkout and container. Nothing here is about the task itself.\n${
    lines.join("\n")
  }`
}

const digest = (id: Section["id"], text: string): string => Digest.digest(CanonicalJson.stringify({ id, text }))

const catalogText = (flows: Readonly<Record<string, Cell.FlowProjection>>): string => {
  const names = Object.keys(flows).sort()
  if (names.length === 0) {
    return "No flows are callable in this run. Complete or park; ctx.call has nothing to reach."
  }
  const lines = names.map((name) => {
    const projection = flows[name]!
    const capabilities = projection.capabilities.length === 0
      ? ""
      : ` capabilities=${[...projection.capabilities].sort().join(",")}`
    const heading = `- ${name} (${projection.tier})${capabilities}: ${projection.description}`
    // The input schema is the difference between choosing a call and guessing
    // one. A rejected input costs a whole frame, so a catalog that names a
    // flow without saying what it takes spends the run's frame budget on
    // trial and error.
    return Option.isNone(projection.input)
      ? heading
      : `${heading}\n  input: ${JSON.stringify(projection.input.value)}`
  })
  return `Flows callable with ctx.call in this frame:\n${lines.join("\n")}`
}

/**
 * Builds the three cell-contract teaching sections for one frame.
 *
 * The order is by how often each section changes, because every one of them is
 * a prefix segment and a prefix is only cached up to its first edit: the
 * contract is constant for the life of the binary, the environment for the life
 * of a run, and the catalog can differ frame to frame.
 *
 * `environment` carries what the host measured about the container. It is
 * optional because the epoch fact — a checkout has no future in it — holds
 * everywhere and is stated with or without a host that measures anything else.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  flows: Readonly<Record<string, Cell.FlowProjection>>,
  environment: Environment = {}
): ReadonlyArray<Section> => {
  const facts = environmentText(environment)
  const catalog = catalogText(flows)
  return [
    { id: "cell-contract", text: contract, digest: digest("cell-contract", contract) },
    { id: "cell-environment", text: facts, digest: digest("cell-environment", facts) },
    { id: "cell-catalog", text: catalog, digest: digest("cell-catalog", catalog) }
  ]
}
