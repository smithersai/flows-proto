/**
 * PACKAGE.ts agent target flavors and the workspace agent declarations:
 * `S.Agent.Lint`, `S.Agent.Diff`, `S.Agent.Pr`, `S.Agent.ClaudeCode`,
 * `S.Agent.Codex`, `S.Agent.Pool`, and the `S.Agents` reference surface.
 *
 * Phase W1 is construct-only: the target constructors validate attrs by
 * schema and install {@link Target.notImplemented} implementations. Agent
 * references (`S.Agents.<name>`) are inert records validated against the
 * workspace `S.Agents({ ... })` declaration when the package index loads.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Target from "./Target.ts"

/**
 * Attrs for {@link Lint}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LintAttrs = Schema.Struct({
  agent: Schema.optional(Reference.AgentRef),
  prompt: Input.File,
  data: Attr.Data,
  fixes: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

const lintDefinition = Target.make("Agent.Lint", {
  attrs: LintAttrs,
  kinds: ["lint"],
  implementation: () => Target.notImplemented("Agent.Lint")
})

/**
 * An agent-judged lint over the declared data; an empty expanded diff is
 * vacuously green with zero agent spawns.
 *
 * @category targets
 * @since 0.1.0
 */
export const Lint = (attrs: (typeof LintAttrs)["~type.make.in"]): Target.AnyTarget => lintDefinition(attrs)

/**
 * Attrs for {@link Diff}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DiffAttrs = Schema.Struct({
  agent: Schema.optional(Reference.AgentRef),
  prompt: Input.File,
  payload: Schema.optional(Schema.Record(Schema.String, Reference.InputSpec)),
  mcp: Schema.optional(Schema.Array(Reference.McpHttp)),
  data: Attr.Data,
  changes: Schema.Array(Schema.NonEmptyString),
  gates: Attr.Gates,
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  approval: Schema.optional(Attr.Approval),
  maxRounds: Schema.Number
})

const diffDefinition = Target.make("Agent.Diff", {
  attrs: DiffAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Agent.Diff")
})

/**
 * An agent producing a bounded, gate-checked candidate diff inside the
 * declared write-set.
 *
 * @category targets
 * @since 0.1.0
 */
export const Diff = (attrs: (typeof DiffAttrs)["~type.make.in"]): Target.AnyTarget => diffDefinition(attrs)

/**
 * Attrs for {@link Pr}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PrAttrs = Schema.Struct({
  agent: Schema.optional(Reference.AgentRef),
  prompt: Input.File,
  data: Attr.Data,
  changes: Schema.Array(Schema.NonEmptyString),
  gates: Attr.Gates,
  approval: Schema.optional(Attr.Approval),
  maxRounds: Schema.optional(Schema.Number)
})

const prDefinition = Target.make("Agent.Pr", {
  attrs: PrAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Agent.Pr")
})

/**
 * An agent whose accepted candidate becomes a pull request; outward, so it
 * runs only when named explicitly.
 *
 * @category targets
 * @since 0.1.0
 */
export const Pr = (attrs: (typeof PrAttrs)["~type.make.in"]): Target.AnyTarget => prDefinition(attrs)

/**
 * Schema for a Claude Code agent declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ClaudeCodeAgent = Schema.TaggedStruct("AgentClaudeCode", {
  model: Schema.NonEmptyString
})

/**
 * A Claude Code agent declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type ClaudeCodeAgent = typeof ClaudeCodeAgent.Type

/**
 * Schema for a Codex agent declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CodexAgent = Schema.TaggedStruct("AgentCodex", {
  model: Schema.NonEmptyString
})

/**
 * A Codex agent declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type CodexAgent = typeof CodexAgent.Type

/**
 * Schema for an agent pool declaration naming sibling agents.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PoolAgent = Schema.TaggedStruct("AgentPool", {
  agents: Schema.Array(Schema.NonEmptyString)
})

/**
 * An agent pool declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type PoolAgent = typeof PoolAgent.Type

/**
 * Schema for one workspace agent declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AgentDeclaration = Schema.Union([ClaudeCodeAgent, CodexAgent, PoolAgent])

/**
 * One workspace agent declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type AgentDeclaration = typeof AgentDeclaration.Type

/**
 * Checks whether a value is one workspace agent declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isAgentDeclaration: (value: unknown) => value is AgentDeclaration = Schema.is(AgentDeclaration)

/**
 * Declares a Claude Code agent.
 *
 * @category constructors
 * @since 0.1.0
 */
export const ClaudeCode = (options: { readonly model: string }): ClaudeCodeAgent =>
  Object.freeze(ClaudeCodeAgent.make({ model: options.model }))

/**
 * Declares a Codex agent.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Codex = (options: { readonly model: string }): CodexAgent =>
  Object.freeze(CodexAgent.make({ model: options.model }))

/**
 * Declares a pool over sibling agent names.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Pool = (agents: ReadonlyArray<string>): PoolAgent => {
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new TypeError("Agent.Pool requires a non-empty array of agent names")
  }
  return Object.freeze(PoolAgent.make({ agents: [...agents] }))
}

/**
 * Runtime marker for the workspace agents declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const AgentsTypeId: unique symbol = Symbol.for("smithers-build/Agents") as never

/**
 * The workspace agents declaration: a validated name-to-agent record.
 *
 * @category models
 * @since 0.1.0
 */
export interface AgentsDeclaration {
  readonly [AgentsTypeId]: typeof AgentsTypeId
  readonly agents: Readonly<Record<string, AgentDeclaration>>
}

/**
 * Checks whether a value is the workspace agents declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isAgentsDeclaration = (value: unknown): value is AgentsDeclaration => {
  if (typeof value !== "object" || value === null) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, AgentsTypeId)
  return descriptor !== undefined && "value" in descriptor && descriptor.value === AgentsTypeId
}

const agentName = /^[A-Za-z_][A-Za-z0-9_-]*$/

const makeAgents = (agents: Readonly<Record<string, AgentDeclaration>>): AgentsDeclaration => {
  if (typeof agents !== "object" || agents === null) {
    throw new TypeError("Agents requires a name-to-agent record")
  }
  const validated: Record<string, AgentDeclaration> = {}
  const names = Object.getOwnPropertyNames(agents)
  for (const name of names) {
    if (!agentName.test(name)) throw new Error(`Agents name is not a legal reference name: ${JSON.stringify(name)}`)
    const declaration = agents[name]
    if (!isAgentDeclaration(declaration)) {
      throw new TypeError(`Agents entry ${JSON.stringify(name)} is not an agent declaration`)
    }
    validated[name] = declaration
  }
  for (const name of names) {
    const declaration = validated[name]!
    if (declaration._tag !== "AgentPool") continue
    for (const member of declaration.agents) {
      if (!Object.prototype.hasOwnProperty.call(validated, member)) {
        throw new Error(`Agent.Pool member ${JSON.stringify(member)} is not a declared agent name`)
      }
    }
  }
  const value = Object.create(null) as { agents: Readonly<Record<string, AgentDeclaration>> }
  Object.defineProperty(value, AgentsTypeId, {
    configurable: false,
    enumerable: false,
    value: AgentsTypeId,
    writable: false
  })
  value.agents = Object.freeze(validated)
  return Object.freeze(value) as unknown as AgentsDeclaration
}

/**
 * The `S.Agents` surface: callable as the workspace declaration constructor
 * (`S.Agents({ default: ..., luna: ... })` in `.smithers/agents.ts`) and a
 * property-access reference surface (`S.Agents.luna` in a PACKAGE.ts).
 *
 * Property access mints a fresh inert {@link Reference.AgentRef}; the name
 * is validated against the workspace declaration at index time, so an
 * unknown agent name is a graph-load error, never a silent miss.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Agents: typeof makeAgents & Record<string, Reference.AgentRef> = Reference.callableReferences(
  makeAgents,
  (name) => Object.freeze({ _tag: "AgentRef", name }) as Reference.AgentRef
)
