import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as CellPrompt from "../src/internal/cellPrompt.ts"
import * as Tokens from "../src/Tokens.ts"

const projection = (
  name: string,
  input: Option.Option<Schema.Json>,
  overrides: {
    readonly capabilities?: ReadonlyArray<string>
    readonly tier?: Cell.FlowProjection["tier"]
    readonly description?: string
  } = {}
): Cell.FlowProjection =>
  new Cell.FlowProjection({
    name,
    description: overrides.description ?? `Call ${name}.`,
    capabilities: overrides.capabilities ?? [],
    tier: overrides.tier ?? "sealed",
    placement: Option.none(),
    input
  })

const sectionOf = (
  id: CellPrompt.Section["id"],
  flows: Readonly<Record<string, Cell.FlowProjection>> = {},
  environment?: CellPrompt.Environment
) =>
  (environment === undefined ? CellPrompt.make(flows) : CellPrompt.make(flows, environment))
    .find((section) => section.id === id)?.text ?? ""

const catalogOf = (flows: Readonly<Record<string, Cell.FlowProjection>>) => sectionOf("cell-catalog", flows)

const contractText = () => sectionOf("cell-contract")

describe("cellPrompt", () => {
  it("renders an inline input document only beneath the projection that carries it", () => {
    const document = { type: "object", required: ["path"] } as const
    const sections = CellPrompt.make({
      documented: projection("documented", Option.some(document)),
      opaque: projection("opaque", Option.none())
    })
    const catalog = sections.find((section) => section.id === "cell-catalog")

    expect(catalog?.text).toBe(
      `Flows callable with ctx.call in this frame:
- documented (sealed): Call documented.
  input: ${JSON.stringify(document)}
- opaque (sealed): Call opaque.`
    )
  })

  it("tells a cell with no callable flows to complete or park", () => {
    expect(catalogOf({})).toBe(
      "No flows are callable in this run. Complete or park; ctx.call has nothing to reach."
    )
  })

  it("renders the single-flow catalog with no separator", () => {
    expect(catalogOf({ only: projection("only", Option.none()) })).toBe(
      `Flows callable with ctx.call in this frame:
- only (sealed): Call only.`
    )
  })

  it("lists capabilities sorted, and omits the clause entirely when a flow declares none", () => {
    expect(
      catalogOf({
        bare: projection("bare", Option.none()),
        guarded: projection("guarded", Option.none(), { capabilities: ["write", "net", "read"] })
      })
    ).toBe(
      `Flows callable with ctx.call in this frame:
- bare (sealed): Call bare.
- guarded (sealed) capabilities=net,read,write: Call guarded.`
    )
  })

  it("renders a single capability without a trailing separator", () => {
    expect(catalogOf({ one: projection("one", Option.none(), { capabilities: ["read"] }) })).toContain(
      "- one (sealed) capabilities=read: Call one."
    )
  })

  it("names each flow's declared tier", () => {
    expect(
      catalogOf({
        a: projection("a", Option.none(), { tier: "sealed" }),
        b: projection("b", Option.none(), { tier: "compensable" }),
        c: projection("c", Option.none(), { tier: "irreversible" })
      })
    ).toBe(
      `Flows callable with ctx.call in this frame:
- a (sealed): Call a.
- b (compensable): Call b.
- c (irreversible): Call c.`
    )
  })

  it("orders the catalog by flow name, not by record insertion order", () => {
    const catalog = catalogOf({
      zebra: projection("zebra", Option.none()),
      alpha: projection("alpha", Option.none())
    })
    expect(catalog.indexOf("- alpha")).toBeLessThan(catalog.indexOf("- zebra"))
  })

  it("keys the catalog on the record, not on the projection's own name", () => {
    // The heading is the record key, which is how the run addresses the call.
    expect(catalogOf({ "fs/list": projection("ignored", Option.none()) })).toContain("- fs/list (sealed)")
  })

  it("renders an empty inline input document as an empty object", () => {
    expect(catalogOf({ any: projection("any", Option.some({})) })).toContain("  input: {}")
  })

  it("renders a non-object inline input document verbatim", () => {
    expect(catalogOf({ any: projection("any", Option.some(null)) })).toContain("  input: null")
  })

  it("orders the sections by how often each one changes", () => {
    // Every section is a prefix segment and a prefix caches only up to its
    // first edit, so the constant contract precedes the per-run environment,
    // which precedes the catalog a frame can change.
    const sections = CellPrompt.make({})
    expect(sections.map((section) => section.id)).toEqual(["cell-contract", "cell-environment", "cell-catalog"])
  })

  it("digests each section over its id and text", () => {
    const sections = CellPrompt.make({ only: projection("only", Option.none()) })
    for (const section of sections) {
      expect(section.digest).toBe(
        Digest.digest(CanonicalJson.stringify({ id: section.id, text: section.text }))
      )
    }
    // No two sections collide on the same digest.
    expect(new Set(sections.map((section) => section.digest)).size).toBe(sections.length)
  })

  it("keeps the contract and the environment byte-identical while the catalog changes", () => {
    const empty = CellPrompt.make({})
    const populated = CellPrompt.make({ only: projection("only", Option.none()) })
    expect(populated[0]).toEqual(empty[0])
    expect(populated[1]).toEqual(empty[1])
    expect(populated[2]?.digest).not.toBe(empty[2]?.digest)
  })

  it("renders the same sections for the same flows", () => {
    const flows = { only: projection("only", Option.some({ type: "object" })) }
    expect(CellPrompt.make(flows)).toEqual(CellPrompt.make(flows))
  })

  it("teaches the cell-block rule and the three transition intents", () => {
    const contract = contractText()
    expect(contract).toContain("fenced block tagged `cell`")
    for (const intent of ["intent: \"continue\"", "intent: \"complete\"", "intent: \"park\""]) {
      expect(contract).toContain(intent)
    }
  })

  it("teaches that several cell blocks are one program and that the first return ends it", () => {
    // The contract has to say this because the harness now runs every block:
    // a model that batches must declare each name once, and a model that
    // returns early must know the blocks after that return do not run.
    const contract = contractText()
    expect(contract).toContain("concatenated in order and run as ONE program in ONE frame")
    expect(contract).toContain("the first `return` ends the frame")
  })

  it("teaches the state projection, the call ledger, and recall by ordinal", () => {
    // All three close the same leak: a model that cannot see what it already
    // knows spends a whole frame moving bytes it already owns.
    const contract = contractText()
    expect(contract).toContain("`render` names `state` keys and `recall` names settled-call ordinals")
    expect(contract).toContain("never spend a frame echoing state into `context` or re-issuing a call")
    expect(contract).toContain("Every call this run has settled is listed for you")
    expect(contract).toContain("`recall N` marker")
  })

  it("teaches the state manifest and that nothing in a frame is cut silently", () => {
    const contract = contractText()
    expect(contract).toContain("each key's type, size and the frame that wrote it")
    expect(contract).toContain("Nothing is ever cut silently")
  })

  it("teaches that a failed call resolves rather than throwing", () => {
    // The fail-stop tax: one call against a path that did not exist destroyed
    // two settled greps and a probe on `psf__requests-2317`, because the
    // recovery the model had already written sat behind the throw.
    const contract = contractText()
    expect(contract).toContain("A failed call does not throw")
    expect(contract).toContain("{ ok: false, error: { code, message, hint } }")
    expect(contract).toContain("test `.ok === false` where you are unsure")
  })

  it("teaches that a cell that does not parse is answered inside its own frame", () => {
    const contract = contractText()
    expect(contract).toContain("If a cell does not PARSE nothing ran at all")
    expect(contract).toContain("asked again inside the SAME frame")
  })

  it("teaches canonical regression evidence and language-aware post-edit diagnostics", () => {
    const contract = contractText()
    expect(contract).toContain("Prove it before you claim it")
    expect(contract).toContain("state.verification")
    expect(contract).toContain("language-aware checker")
    expect(contract).toContain("undefined-name")
  })

  it("never makes the baseline a precondition for writing, and no longer has to relieve one", () => {
    // r91 shipped rule 8's unconditional form — "before the first write, run
    // the one targeted command that reproduces the report" — and five of the
    // 45 instances then spent a whole 1,200 s budget issuing zero mutation
    // calls, holding a correct diagnosis they were not allowed to act on. All
    // five were resolved by the r90 baseline, whose conditional wording relieved
    // the ordering with a sentence.
    //
    // Checkpoints relieve it with a mechanism instead (will, 2026-08-24): the
    // baseline is taken *after* the edit, against `ctx.base`, so there is no
    // ordering left to be conditional about. The escape clause went with it,
    // because a sentence offering relief from a constraint the contract no
    // longer imposes teaches a shape that is not the shape.
    const contract = contractText()
    expect(contract).toContain("A baseline you have watched fail is what buys a same-cell completion")
    expect(contract).toContain("{ at: ctx.base }")
    // The unconditional demand is the thing that must not come back.
    expect(contract).not.toContain("Before the first write")
    expect(contract).not.toContain("It is not a precondition for writing")
    expect(contract).not.toContain("when the command will not bootstrap")
    expect(contract).not.toContain("licence")
  })

  it("states plainly that a run never reverts its own work to re-prove a baseline", () => {
    // The failure this surface exists to kill, named in the teaching that
    // replaces it. `sympy__sympy-13878` in the r95repl lane applied one
    // byte-identical 4,789-character patch five times, four of those preceded by
    // `git checkout -- sympy/stats/crv_types.py`, because a clean fails-before
    // proof required reverting the work it was proving.
    const repl = CellPrompt.make({}, {}, "repl").find((section) => section.id === "cell-contract")?.text ?? ""
    for (const contract of [contractText(), repl]) {
      expect(contract).toContain("NEVER undo your own edit to re-prove a baseline")
      expect(contract).toContain("ctx.checkpoint()")
      expect(contract).toContain("a checkpoint is read-only, so a flow that writes is refused at one")
    }
  })

  it("still ends rule 8 at r90's demand", () => {
    const contract = contractText()
    expect(contract).not.toContain("nothing in this tree can fail before your change and pass after it")
    expect(contract).toContain("Complete only once you have SEEN that identical command pass")
  })

  it("keeps r90's own words wherever no shipped mechanic replaced them", () => {
    // The revert is only surgical if the retained lines are the mechanics. Two
    // r91 trims carried no mechanic at all and are back at r90's text: the park
    // refusal does still say what budget is left (`CellTurn.parkRefusal` counts
    // the frames into its message), and rule 1's heredoc sentence was reworded
    // for nothing.
    const contract = contractText()
    expect(contract).toContain("those refuse it, tell you what budget is left, and hand the question back to you")
    expect(contract).toContain("not about the strings you pass")
    expect(contract).toContain("such as a Python heredoc reading")
  })

  it("carries prior state forward in the worked example, because state is replaced and not merged", () => {
    // `Cell` records `state: returned.state ?? null` — a transition replaces
    // working memory wholesale. r90's example spread `...ctx.state` into every
    // `continue`; r91's rewrite dropped the spread with no mechanic behind it,
    // which teaches a cell to discard what rule 6 has just called its working
    // memory. Models imitate the example, not the prose.
    const contract = contractText()
    // Only the worked example's own transitions: rule 4 names the shape
    // `{ intent: "continue", state, render, context }` without a literal.
    const continues = contract.split("\n").filter((line) => line.includes(`intent: "continue", state: {`))
    expect(continues).toHaveLength(3)
    for (const line of continues) expect(line).toContain("state: { ...ctx.state,")
  })

  it("names only checkers a run can actually reach, never a `diagnostics` flow nothing binds", () => {
    // The contract is read as a catalog by the model that imitates it. Naming a
    // flow no composition offers spends a frame on `{ ok: false, code:
    // "unknown_flow" }` and, when the cell then reads a field off that
    // envelope, the whole frame on a TypeError. `@smthrs/std` declares no
    // `diagnostics` flow and neither `StandardFlows.filesystem` nor
    // `StandardFlows.shell` binds one, so the teaching points at the shell
    // flow and at what the image actually ships.
    const contract = contractText()
    expect(contract).not.toContain("diagnostics")
    expect(contract).toContain("whatever language-aware checker `ctx.flows` and this image actually offer")
    expect(contract).toContain("through the shell flow")
  })

  it("teaches that an edit answers with the hunk it applied", () => {
    // `@smthrs/std`'s `edit` returns `hunk` — the applied region raw, with its
    // real indentation — precisely so a mis-indented edit costs one glance.
    // sphinx-7233 lost its verdict to a hunk nobody could see.
    const contract = contractText()
    expect(contract).toContain("An edit answers with the hunk it applied")
    expect(contract).toContain("costs one glance there")
  })

  it("teaches that a check is evidence only once it has failed for the right reason", () => {
    const contract = contractText()
    expect(contract).toContain("FOR THE RIGHT REASON")
    // Naming the class is the point: a probe that fails because it named
    // something absent reads the same before and after a correct fix.
    expect(contract).toContain("does not exist reproduces nothing")
    expect(contract).toContain("invalidProbe")
    expect(contract).toContain("before you rely on it")
  })

  it("keeps the doctrine at the text the r90 wave measured, and adds none of r91's", () => {
    // The r91 re-run priced the four rules change #2 added — probes and
    // oracles, revisable premises, minimal edits, completion on recorded
    // evidence — against the r90 contract on the same 45 instances. Resolved
    // fell 35 to 30, cost rose 59 %, and the doctrine's own instances are the
    // ones that got dearer. It is reverted, so the tool half of the same
    // program can be measured on its own. Re-adding any of these needs a trace
    // that says teaching, and not a tool, was the gap.
    //
    // Two of them were re-added anyway, and priced again. `rerun-r93.md` ran
    // the minimal-edit rule alone, with `astropy__astropy-14369` as its own
    // built-in A/B, beside a same-shape sweep written for
    // `django__django-13212`. Both failed. `14369` went from 8 frames and
    // $0.67 to 41 frames and $3.06 and stayed unresolved; `13212` still
    // captured one file and stayed unresolved, and across the wave the patches
    // got *less* multi-file, 6 to 3. The two rules are 522 characters and 131
    // estimated tokens, and the wave they produced is three verdicts and $9.47
    // worse than r92's. Both are reverted, and the sweep is pinned out here
    // beside the four so a third re-add has to move this list.
    const contract = contractText()
    for (
      const added of [
        "Assert the observable the issue names",
        "A recorded probe is a premise you may revise",
        "asserting the behaviour the issue explicitly replaces is stale evidence",
        "run the identical command against the unmodified base tree",
        "Fix what the reproduction implicates, and stop",
        "Complete on evidence already in hand",
        "is detected and is not evidence",
        "search the whole repository for that shape"
      ]
    ) {
      expect(contract).not.toContain(added)
    }
    // What r90 said about the recorded check stands, in r90's own words.
    expect(contract).toContain("reuse its exact `flow` and `input` after edits")
    expect(contract).toContain("rather than deriving or broadening another command")
  })

  it("teaches that a file is restored with git, never through captured stdout", () => {
    const contract = contractText()
    expect(contract).toContain("a result flagged truncated is a fragment")
    expect(contract).toContain("git checkout or git restore")
    expect(contract).toContain("never route file content through captured stdout")
    // The refusal is stated, so the first frame that tries it already knows why.
    expect(contract).toContain("a write of bytes a call returned truncated is refused")
  })

  it("drops r91's frame-economics teaching pack with the rest of change #10", () => {
    // The pack told the model what a frame costs and how to write one. Output
    // per frame rose 44 % and mean frames per instance rose 10.0 to 11.7 under
    // it, against a predicted ceiling of 4, and 85 cells were re-asked in-frame
    // for a parse error the longer cells caused. The worked example is the
    // teaching; the prose about it is not.
    const contract = contractText()
    for (
      const added of [
        "Inside a cell the calls are free",
        "billed for the cell you write and the context you carry",
        "Guards are one-line bails naming what was missing",
        "a cell that scripts the next three frames pays output tokens"
      ]
    ) {
      expect(contract).not.toContain(added)
    }
  })

  it("shows the whole round rather than describing it", () => {
    // Models imitate the example, not the prose: graded waves split locate,
    // read, edit and check across four frames each. The example is the whole
    // round in one cell — r90's shape, carrying the mechanics the lanes shipped
    // since (fail-soft envelopes, raw read content, the applied hunk).
    const contract = contractText()
    // Locate, then a read whose window is arithmetic on the search's own hit.
    expect(contract).toContain(`await ctx.call("grep"`)
    expect(contract).toContain("offset: Math.max(1, hit.line - 20)")
    // A one-line guard on the search's own failure envelope, so the fail-soft
    // rule is shown and not only stated.
    expect(contract).toContain("const hit = found.ok === false ? undefined : found.matches[0]")
    // The anchor is a literal line a call returned, never in-cell surgery over
    // bytes the model has not seen.
    expect(contract).toContain("const anchor = hit.text")
    expect(contract).toContain(`const applied = await ctx.call("edit", { path: hit.file, oldString: anchor`)
    expect(contract).toContain("if (applied.ok === false) return {")
    // The baseline comes after the edit and reads the tree the run opened on.
    // That order is the ruling of 2026-08-24, and the example is where a model
    // reads it: the frame proves fails-before without ever giving the edit back.
    expect(contract).toContain("const before = await ctx.call(check.flow, check.input, { at: ctx.base })")
    expect(contract.indexOf(`ctx.call("edit"`)).toBeLessThan(contract.indexOf("const before ="))
    // Two independent readings in the one frame — the identical check on the
    // changed tree says the behaviour moved, the returned hunk says what moved
    // — then the exit.
    expect(contract).toContain("const after = await ctx.call(check.flow, check.input)")
    expect(contract).toContain("the applied hunk is:")
    expect(contract).toContain(`intent: "complete", state: { verification: check }`)
    expect(contract).toContain("One frame: search, read, edit, baseline at ctx.base, re-check, answer.")
    // And the worked example never shows a run undoing its own work. Rule 3
    // still names `git checkout` for the one case it is for — restoring a file
    // somebody wrote a truncated capture over — which is not this.
    const shown = [...contract.matchAll(/```cell\n([\s\S]*?)```/g)].map((match) => match[1]!).join("\n")
    expect(shown).not.toMatch(/git (checkout|restore|stash|reset)/)
  })

  it("states the epoch fact with no environment supplied at all", () => {
    // django-13346 applied its own harness snapshots as an upstream fix and
    // 13821 cited one as evidence. The fact that closes that class is true of
    // every checkout, so it is stated whether or not a host measured anything.
    const environment = sectionOf("cell-environment")
    expect(environment).toContain("Facts this harness computed about the checkout and container")
    expect(environment).toContain("Nothing here is about the task itself")
    expect(environment).toContain("the checkout ends at the commit you were given")
    expect(environment).toContain("no branch, tag, stash or reflog here holds a later fix")
    expect(environment).toContain("costs a frame and returns nothing")
    // The harness's attempt and durability snapshots live in a repository of
    // their own, so a history search cannot surface them at all — which is what
    // makes "returns nothing" literally true rather than nearly true.
    expect(environment).toContain("keeps its own attempt and durability snapshots in a repository of its own")
  })

  it("teaches the archaeology that does pay, reading history backwards", () => {
    const environment = sectionOf("cell-environment")
    expect(environment).toContain("says what an assertion was written for")
    expect(environment).toContain("git log <tag>..HEAD -- <paths>")
  })

  it("states a measured locale and omits the line when the host measured none", () => {
    expect(sectionOf("cell-environment", {}, { locale: "C.UTF-8" })).toContain(
      "- Locale: C.UTF-8. Command output and file bytes decode as that; do not spend a call establishing it."
    )
    expect(sectionOf("cell-environment", {}, {})).not.toContain("- Locale:")
    expect(sectionOf("cell-environment")).not.toContain("- Locale:")
  })

  it("names absent tools once, sorted, and says nothing when none were measured", () => {
    expect(sectionOf("cell-environment", {}, { absentTools: ["ruff", "rg"] })).toContain(
      "- Not installed in this image: rg, ruff. A call that invokes one fails; reach for what `ctx.flows` lists instead of discovering this by hand."
    )
    // An empty measurement is not a claim that every tool is present.
    expect(sectionOf("cell-environment", {}, { absentTools: [] })).not.toContain("- Not installed in this image:")
    expect(sectionOf("cell-environment", {}, {})).not.toContain("- Not installed in this image:")
  })

  it("renders every measured fact together, in a stable order", () => {
    const environment = sectionOf("cell-environment", {}, { locale: "C.UTF-8", absentTools: ["rg"] })
    expect(environment.indexOf("- History:")).toBeLessThan(environment.indexOf("- Locale:"))
    expect(environment.indexOf("- Locale:")).toBeLessThan(environment.indexOf("- Not installed in this image:"))
  })

  it("admits only typed, harness-measurable facts into the environment section", () => {
    // The program that motivated this section rejects instance-specific
    // teaching outright, so the guard is structural: there is no field a
    // caller could put a task answer in. This test fails the moment one is
    // added, which is the point at which somebody has to justify it.
    const keys: ReadonlyArray<keyof CellPrompt.Environment> = ["locale", "absentTools"]
    const populated: CellPrompt.Environment = { locale: "C.UTF-8", absentTools: ["rg"] }
    expect(Object.keys(populated).every((key) => keys.includes(key as keyof CellPrompt.Environment))).toBe(true)
  })

  it("keeps the taught prefix inside its measured token budget", () => {
    // The teaching is a prefix segment, so a run pays it once at full price and
    // then at cache rates — but it is rendered into every frame's request, and
    // teaching that grows without anyone looking is how a contract becomes the
    // largest thing in the window, so the ceiling here is the thing that makes
    // the next addition deliberate.
    //
    // The history it records is one round trip. Measured with
    // `Tokens.estimate`, the r90 contract — the text that resolved 35/45 — is
    // 8,197 characters. The optimal-trace program grew it to 11,312 across
    // changes 2, 9 and 10, and the r91 re-run of the same 45 instances lost
    // five verdicts and $22. The doctrine half is now back at r90's text, and
    // what remains above it is the lane mechanics measured to pay: the failure
    // envelope and its `.ok` test, `render`/`recall` and the state manifest,
    // raw read content, the hunk an `edit` answers with, and the in-frame
    // re-ask for a cell that does not parse. Those are ~1,000 characters, and
    // every one of them replaces a frame a graded wave actually spent.
    //
    // The ceiling is therefore r90's own budget plus that mechanics delta, and
    // not one token of the doctrine that was priced and rejected.
    //
    // It was raised to 2,500 once, for two rules re-added under r92's ranked
    // list, and `rerun-r93.md` priced them: +522 characters, +131 estimated
    // tokens, and against that +115 frames, +$9.47 and −3 verdicts. The number
    // is back at 2,400 with the contract, and the round says what the ceiling
    // is for — 131 estimated tokens of teaching bought a 43 % larger bill.
    expect(Tokens.estimate(contractText())).toBeLessThanOrEqual(2_400)
    expect(Tokens.estimate(sectionOf("cell-environment", {}, { locale: "C.UTF-8", absentTools: ["rg", "ruff"] })))
      .toBeLessThanOrEqual(300)
  })

  it("is byte-for-byte the contract the r92 subject measured", () => {
    // A ceiling bounds the text; it does not identify it. Four waves have now
    // been decided by the contract's exact wording, and two of them — r90's
    // text and r92's revert to it — are the cheapest and highest-scoring on
    // record, so the text itself is a measured artefact and gets a number.
    //
    // This is that number: the SHA-256 of the rendered `cell-contract`
    // section's text. The r92 subject — stamp
    // `sha256:c9e4166913e167ee6cd76ac293d621e02843833c1736d62b5ed770e1a1e7e45c`
    // in `fullbench/rerun-r92/manifest.jsonl`'s header, at `de1de1a82` —
    // renders the text below at 9,193 characters. The r93 subject rendered
    // `sha256:82603dd246056b2265c2b37c1553f26b2dd51c4743ed9a6f6e0694db61bf0948`
    // instead, 9,715 characters, and lost three verdicts and $9.47 for the
    // difference. Changing the contract means changing this line, and
    // changing this line means a wave has to be run for it.
    // It moved on 2026-08-24, on will's checkpoint ruling: the worked example
    // now edits first and takes its baseline against `ctx.base` afterwards, and
    // rule 8 names the surface that makes that possible. Net +162 characters,
    // because the clause the checkpoint made meaningless — "when the command
    // will not bootstrap, edit on the diagnosis you have" — came out with it.
    // Moving these two numbers still means a wave has to be run for them.
    expect(contractText()).toHaveLength(9_355)
    expect(Digest.digest(contractText()))
      .toBe("56e5a8e64a18b4d5d52d70ecc2ffa94a2ade6f808b1fde4d81d05e00c99cd6e6")
  })
})

describe("the repl contract", () => {
  const replText = () => CellPrompt.make({}, {}, "repl").find((section) => section.id === "cell-contract")?.text ?? ""

  it("is the shorter of the two arms, and by a stated amount", () => {
    // The arm exists to be measured against the filing one, and a teaching
    // change is the most expensive kind this harness has: r91 grew the filing
    // contract from 8,197 to 11,312 characters and lost five verdicts for it.
    // So the REPL text gets the same treatment the filing text gets — a pinned
    // length and a pinned digest, so that changing it is a decision somebody
    // made rather than something that happened.
    //
    // It moved once, 7,711 → 8,312, on will's ruling of 2026-08-23: the
    // completion rule was rewritten from see-then-attest to the guarded shape,
    // after `sympy__sympy-13878` claimed in `output` that a suite exited 0 one
    // frame after its own guarded `ctx.done` had declined to fire because that
    // suite exited 1. Moving these two numbers means a wave has to be run.
    // It moved again on 2026-08-24, 8,312 → 8,517, on will's checkpoint ruling,
    // for the same reason and by the same edit as the filing text.
    expect(replText()).toHaveLength(8_517)
    expect(Digest.digest(replText()))
      .toBe("70d5375b63f722d12bcad4698b892e2e5041ded5a94ad269f8958ea640c4855e")
    expect(replText().length).toBeLessThan(contractText().length)
  })

  it("encourages the guard shape and leaves the unguarded completion legal", () => {
    // The whole of the ruling, read off the rendered text: the shape is shown
    // in code, the mechanism that makes it safe is stated, and the bare call is
    // named as a claim rather than refused.
    const text = replText()
    expect(text).toContain("if (after.exitCode === 0) ctx.done(...)")
    expect(text).toContain(`{ ok: false, error: { code: "run_completed" } }`)
    expect(text).toContain("A bare `ctx.done` is allowed")
    expect(text).toContain("a claim nobody checked")
    // The rule that died. A contract that still asked for it would be asking
    // for a memory of a result in the same breath as offering the check.
    expect(text).not.toContain("Complete only once you have SEEN")
  })

  it("shows the guard in the worked example rather than only describing it", () => {
    const blocks = [...replText().matchAll(/```cell\n([\s\S]*?)```/g)].map((match) => match[1]!)
    expect(blocks).toHaveLength(2)
    // One cell, in order: the probe that must fail, the edit, the identical
    // probe replayed, and the completion behind a check of both exit codes.
    const fix = blocks[1]!
    // The order is the ruling. The edit lands first and the baseline is taken
    // after it against `ctx.base`, because a checkpoint is a tree the run keeps
    // rather than a tree the run goes back to — which is what stops a proof
    // from costing the work it is proving.
    expect(fix.indexOf(`ctx.call("edit"`)).toBeLessThan(fix.indexOf("const before"))
    expect(fix.indexOf("const before")).toBeLessThan(fix.indexOf("const after"))
    expect(fix.indexOf("const after")).toBeLessThan(fix.indexOf("ctx.done("))
    expect(fix).toContain("{ at: ctx.base }")
    expect(fix).toContain("if (before.exitCode !== 0 && after.exitCode === 0) ctx.done(")
  })

  it("teaches none of the filing mode's mechanics", () => {
    // The REPL has no returned transition, no store to file into, and no
    // `render`/`recall` pair, so a contract that still named any of them would
    // be teaching a mechanism the realm does not have. This is the assertion
    // that keeps the two texts from converging by accident.
    for (
      const absent of [
        /\bctx\.state\b/,
        /\bstate\b/i,
        /\brender\b/i,
        /\brecall\b/i,
        /\bmanifest\b/i,
        /\bintent\b/i,
        /\btransition\b/i,
        /async function/i
      ]
    ) {
      expect(replText()).not.toMatch(absent)
    }
  })

  it("teaches the three calls that replace the returned transition", () => {
    for (const named of ["ctx.done(output)", "ctx.park(reason, message)", "ctx.justify(", "console.log"]) {
      expect(replText()).toContain(named)
    }
  })
})
