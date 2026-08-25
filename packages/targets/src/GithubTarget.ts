/**
 * PACKAGE.ts GitHub target flavors: `S.Github.Setup`, `S.Github.Workflow`,
 * `S.Github.CiGen`, and `S.Github.Pr`.
 *
 * `S.Github.Workflow` names GitHub's own artifact and is exempt from the
 * naming rule that bans "workflow" for flows concepts.
 *
 * Phase W1 is construct-only; constructors validate attrs by schema and
 * install {@link Target.notImplemented} implementations.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"

/**
 * Attrs for {@link Setup}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SetupAttrs = Schema.Struct({
  cacheUrl: Schema.optional(Secret.Declaration),
  cacheToken: Schema.optional(Secret.Declaration)
})

const setupDefinition = Target.make("Github.Setup", {
  attrs: SetupAttrs,
  kinds: ["run", "lint"],
  implementation: () => Target.notImplemented("Github.Setup")
})

/**
 * The generated shared setup action every generated job starts with.
 *
 * @category targets
 * @since 0.1.0
 */
export const Setup = (attrs: (typeof SetupAttrs)["~type.make.in"]): Target.AnyTarget => setupDefinition(attrs)

/**
 * Schema for a generated workflow's trigger table.
 *
 * @category schemas
 * @since 0.1.0
 */
export const On = Schema.Struct({
  pullRequest: Schema.optional(Schema.Boolean),
  push: Schema.optional(Schema.Struct({ branches: Schema.Array(Schema.NonEmptyString) })),
  workflowDispatch: Schema.optional(Schema.Boolean)
})

/**
 * Schema for a generated workflow's concurrency policy.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Concurrency = Schema.Struct({
  group: Schema.NonEmptyString,
  cancelInProgress: Schema.Union([Schema.Boolean, Schema.NonEmptyString])
})

/**
 * Attrs for {@link Workflow}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WorkflowAttrs = Schema.Struct({
  name: Schema.NonEmptyString,
  on: On,
  concurrency: Schema.optional(Concurrency),
  setup: Schema.optional(Target.Target),
  affected: Schema.optional(Schema.Boolean),
  run: Schema.Array(Target.Target)
})

const workflowDefinition = Target.make("Github.Workflow", {
  attrs: WorkflowAttrs,
  kinds: ["run", "lint"],
  implementation: () => Target.notImplemented("Github.Workflow")
})

/**
 * One generated GitHub Actions workflow running the named targets.
 *
 * @category targets
 * @since 0.1.0
 */
export const Workflow = (attrs: (typeof WorkflowAttrs)["~type.make.in"]): Target.AnyTarget => workflowDefinition(attrs)

/**
 * Attrs for {@link CiGen}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CiGenAttrs = Schema.Struct({
  workflows: Schema.Array(Target.Target),
  preserve: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  changes: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

const ciGenDefinition = Target.make("Github.CiGen", {
  attrs: CiGenAttrs,
  kinds: ["run", "lint"],
  implementation: () => Target.notImplemented("Github.CiGen")
})

/**
 * The drift-checked renderer for the declared workflows; hand-written files
 * in `preserve` are kept verbatim.
 *
 * @category targets
 * @since 0.1.0
 */
export const CiGen = (attrs: (typeof CiGenAttrs)["~type.make.in"]): Target.AnyTarget => ciGenDefinition(attrs)

/**
 * Attrs for {@link Pr}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PrAttrs = Schema.Struct({
  gates: Attr.Gates,
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox)
})

const prDefinition = Target.make("Github.Pr", {
  attrs: PrAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Github.Pr")
})

/**
 * Opens a pull request after fresh gates; outward, so it runs only when
 * named explicitly.
 *
 * @category targets
 * @since 0.1.0
 */
export const Pr = (attrs: (typeof PrAttrs)["~type.make.in"]): Target.AnyTarget => prDefinition(attrs)
