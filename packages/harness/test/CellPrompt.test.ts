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
    expect(contract).toContain("Before the first write")
    expect(contract).toContain("state.verification")
    expect(contract).toContain("language-aware per-file diagnostics")
    expect(contract).toContain("undefined-name")
  })

  it("teaches that a check is evidence only once it has failed for the right reason", () => {
    const contract = contractText()
    expect(contract).toContain("FOR THE RIGHT REASON")
    // Naming the class is the point: a probe that fails because it named
    // something absent reads the same before and after a correct fix.
    expect(contract).toContain("does not exist reproduces nothing")
    expect(contract).toContain("invalidProbe")
    expect(contract).toContain("before you edit anything")
  })

  it("teaches what to do when no probe can flip, instead of inventing one that can", () => {
    // django-13821 raised a SQLite floor the container already satisfied, so no
    // command could fail before the edit and pass after it. Under a mandatory
    // fail-to-pass baseline the run invented a probe that could flip — an
    // attribute nothing in that Django reads — and then had to keep the inert
    // attribute and revert the real gate to satisfy it. That is the escape this
    // sentence gives, and it is worth a verdict.
    const contract = contractText()
    expect(contract).toContain("When no command can fail before your change and pass after it")
    expect(contract).toContain("do not invent one that can flip")
    expect(contract).toContain("never add code to the tree to make a probe pass")
  })

  it("teaches that an oracle asserts the issue's observable, never a guessed aggregate", () => {
    // matplotlib-22865 froze `len(bounds) + 1 == 11` in frame 1, guessed from
    // no printed output. The correct fix landed in frame 2 and failed that
    // number 33 times, at $2.42, until the run hit the frame cap without
    // completing. An expected value is read out of output, never invented.
    const contract = contractText()
    expect(contract).toContain("Assert the observable the issue names")
    expect(contract).toContain("take every expected value from output you have actually printed and read")
    expect(contract).toContain("an aggregate you guessed")
    expect(contract).toContain("is a wrong oracle")
  })

  it("teaches that a recorded probe is a revisable premise, not a completion demand", () => {
    // django-13821 held the resolving gate change, then reverted it because the
    // recorded probe asserted an attribute that never existed. The probe is the
    // thing that gives when evidence contradicts it; the tree is not.
    const contract = contractText()
    expect(contract).toContain("A recorded probe is a premise you may revise, not a promise you must keep")
    expect(contract).toContain("re-derive the oracle")
    expect(contract).toContain("Never edit the tree to satisfy a probe you no longer believe")
  })

  it("teaches that an in-tree test asserting replaced behavior is stale evidence", () => {
    // sympy-19495 walked a correct patch back to appease an assertion that
    // encodes the reported bug; codex ruled the same test stale and resolved.
    // The archaeology that settles it is one call.
    const contract = contractText()
    expect(contract).toContain("asserting the behaviour the issue explicitly replaces is stale evidence")
    expect(contract).toContain("leave that test unmodified")
    expect(contract).toContain("`git log -S`")
  })

  it("teaches baselining against the unmodified tree before self-attribution", () => {
    // sphinx-8721 spent $1.10 over fourteen frames on a failure that predated
    // its edit. Failure-set equality against the base answers that in one call.
    const contract = contractText()
    expect(contract).toContain("run the identical command against the unmodified base tree")
    expect(contract).toContain("equal failure sets mean the failure predates you")
  })

  it("teaches minimal edits and the consumers-of-the-changed-symbol lookup", () => {
    const contract = contractText()
    expect(contract).toContain("Fix what the reproduction implicates, and stop")
    expect(contract).toContain("your probe covers every site the edit touches")
    expect(contract).toContain("one lookup of the changed symbol's consumers")
  })

  it("teaches completion on recorded evidence rather than replay ceremony", () => {
    // django-16899 spent $1.35 replaying an outcome the run already held.
    // Sufficiency states the failing-before/passing-after pair once; the
    // contract points at that record instead of asking for it again.
    const contract = contractText()
    expect(contract).toContain("Complete on evidence already in hand")
    expect(contract).toContain("failed before your change and passed after it")
    expect(contract).toContain("Replaying a settled outcome over an unchanged tree proves nothing")
    expect(contract).toContain("a completion you have not watched pass is a wrong answer")
  })

  it("teaches that narrowing or broadening the recorded check is not evidence", () => {
    const contract = contractText()
    expect(contract).toContain("reuse that exact `flow` and `input`")
    expect(contract).toContain("`-k` filter")
    expect(contract).toContain("is detected and is not evidence")
  })

  it("teaches that a file is restored with git, never through captured stdout", () => {
    const contract = contractText()
    expect(contract).toContain("a result flagged truncated is a fragment")
    expect(contract).toContain("git checkout or git restore")
    expect(contract).toContain("never route file content through captured stdout")
    // The refusal is stated, so the first frame that tries it already knows why.
    expect(contract).toContain("a write of bytes a call returned truncated is refused")
  })

  it("prices the frame: calls are free, output is the bill, a read-only first frame is a wasted turn", () => {
    // The measured constant across 45 graded instances: output tokens are
    // 60-80% of every bill, and the mean run spent 10 frames where 1-2 were
    // enough. The contract states the economics rather than leaving the model
    // to infer them from a frame budget.
    const contract = contractText()
    expect(contract).toContain("Inside a cell the calls are free")
    expect(contract).toContain("billed for the cell you write and the context you carry")
    expect(contract).toContain("a first frame that only searches, or only reads, spends a turn and buys nothing")
  })

  it("teaches one-line guard bails and forbids pre-scripting later frames", () => {
    const contract = contractText()
    expect(contract).toContain("Guards are one-line bails naming what was missing")
    expect(contract).toContain("they never restate the task")
    expect(contract).toContain("a cell that scripts the next three frames pays output tokens")
  })

  it("shows the transactional round rather than describing it", () => {
    // Rule 7 has described the fused cell in prose since the contract existed,
    // and models imitate the example, not the prose: graded waves split
    // locate, read, edit and check across four frames each. The example is the
    // whole round, and every step of it is here.
    const contract = contractText()
    // Locate, then a read whose window is arithmetic on the search's own hit.
    expect(contract).toContain(`await ctx.call("grep"`)
    expect(contract).toContain("offset: Math.max(1, hit.line - 20)")
    // A one-line guard on what the read actually returned.
    expect(contract).toContain(`if (!region.content.includes("def widen")) return {`)
    // The probe read for its reason, not its exit code alone.
    expect(contract).toContain("const before = await ctx.call(probe.flow, probe.input)")
    expect(contract).toContain(`!before.stdout.includes("UnitsError")`)
    // The anchor is a literal line a call returned, never in-cell surgery over
    // bytes the model has not seen.
    expect(contract).toContain("const anchor = hit.text")
    expect(contract).toContain(`await ctx.call("edit", { path: hit.file, oldString: anchor`)
    // Two independent checks in the one frame, then the conditional exit.
    expect(contract).toContain("const after = await ctx.call(probe.flow, probe.input)")
    expect(contract).toContain(`const lint = await ctx.call("diagnostics", { path: hit.file })`)
    expect(contract).toContain(`intent: "complete", state: { verification: probe }`)
    expect(contract).toContain("One frame: locate, read, probe, edit, verify, answer.")
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
    // largest thing in the window. Measured with `Tokens.estimate`: the
    // contract went from 8,197 bytes / 2,105 tokens to 10,204 / 2,610 when the
    // verification doctrine, the frame economics and the transactional example
    // were rewritten, and the environment section adds 774 bytes / 198 tokens
    // bare, 1,018 / 260 with a locale and two absent tools. That is +703 taught
    // tokens per frame, about $0.32 across a 45-instance graded run once the
    // uncached first frame and the cached rest are both counted — bought
    // against a measured $32.4 waste gap. These are the ceilings that make the
    // next such addition deliberate.
    // Change 1 (addressable context) and change 8 (fail-soft calls) then added
    // ~140 more: the recall directive, the state manifest, the never-silently-
    // clipped rule, the failure envelope, and the in-frame re-ask. Every one of
    // them replaces a frame the r90 wave actually spent, so the ceiling moved
    // to 2,850 rather than the teaching being trimmed to fit.
    expect(Tokens.estimate(contractText())).toBeLessThanOrEqual(2850)
    expect(Tokens.estimate(sectionOf("cell-environment", {}, { locale: "C.UTF-8", absentTools: ["rg", "ruff"] })))
      .toBeLessThanOrEqual(300)
  })
})
