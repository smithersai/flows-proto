/**
 * PACKAGE.ts shell target flavors: `S.Shell.Build`, `S.Shell.Test`,
 * `S.Shell.Run`, `S.Shell.Serve`, and `S.Shell.Diff`.
 *
 * Phase W1 is construct-only: every constructor validates its attrs by
 * schema, records dependency edges and declared inputs through
 * {@link Target.make}'s attr walk, and installs
 * {@link Target.notImplemented} as its implementation, so executing one
 * fails with the typed `NotImplemented` error rather than reporting fake
 * success.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Reference from "./Reference.ts"
import * as Target from "./Target.ts"

/** The attr fields every Shell flavor shares. */
const sharedFields = {
  bin: Schema.optional(Reference.Tool),
  bun: Schema.optional(Schema.NonEmptyString),
  command: Schema.optional(Schema.NonEmptyString),
  using: Schema.optional(Attr.Using),
  args: Schema.optional(Attr.Args),
  runtimeArgs: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Attr.Env),
  data: Schema.optional(Attr.Data),
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox)
} as const

/**
 * Attrs for {@link Build}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BuildAttrs = Schema.Struct({
  ...sharedFields,
  outDirs: Schema.Array(Schema.NonEmptyString)
})

/**
 * Attrs for {@link Test}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestAttrs = Schema.Struct({
  ...sharedFields,
  services: Schema.optional(Attr.Services),
  gates: Schema.optional(Attr.Gates)
})

/**
 * Attrs for {@link Run}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RunAttrs = Schema.Struct({
  ...sharedFields,
  approval: Schema.optional(Attr.Approval),
  services: Schema.optional(Attr.Services),
  gates: Schema.optional(Attr.Gates)
})

/**
 * Attrs for {@link Serve}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ServeAttrs = Schema.Struct({
  ...sharedFields,
  readiness: Schema.optional(Attr.Readiness),
  health: Schema.optional(Attr.Health),
  stop: Schema.optional(Attr.Stop)
})

/**
 * Attrs for {@link Diff}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DiffAttrs = Schema.Struct({
  ...sharedFields,
  changes: Schema.Array(Schema.NonEmptyString)
})

const buildDefinition = Target.make("Shell.Build", {
  attrs: BuildAttrs,
  kinds: ["build"],
  implementation: () => Target.notImplemented("Shell.Build")
})

const testDefinition = Target.make("Shell.Test", {
  attrs: TestAttrs,
  kinds: ["test"],
  implementation: () => Target.notImplemented("Shell.Test")
})

const runDefinition = Target.make("Shell.Run", {
  attrs: RunAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Shell.Run")
})

const serveDefinition = Target.make("Shell.Serve", {
  attrs: ServeAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Shell.Serve")
})

const diffDefinition = Target.make("Shell.Diff", {
  attrs: DiffAttrs,
  kinds: ["run", "lint"],
  implementation: () => Target.notImplemented("Shell.Diff")
})

const withOneExecutable = <A>(id: string, attrs: unknown, construct: () => A): A => {
  if (typeof attrs !== "object" || attrs === null) {
    throw new TypeError(`${id} attrs must be an object`)
  }
  Attr.requireOneExecutable(id, attrs as Record<string, unknown>, ["bin", "bun", "command"])
  return construct()
}

/**
 * A tool run producing the declared output directories.
 *
 * @category targets
 * @since 0.1.0
 */
export const Build = (attrs: (typeof BuildAttrs)["~type.make.in"]): Target.AnyTarget =>
  withOneExecutable("Shell.Build", attrs, () => buildDefinition(attrs) as unknown as Target.AnyTarget)

/**
 * A tool run whose exit status is the test verdict.
 *
 * @category targets
 * @since 0.1.0
 */
export const Test = (attrs: (typeof TestAttrs)["~type.make.in"]): Target.AnyTarget =>
  withOneExecutable("Shell.Test", attrs, () => testDefinition(attrs) as unknown as Target.AnyTarget)

/**
 * A tool run executed only when named explicitly.
 *
 * @category targets
 * @since 0.1.0
 */
export const Run = (attrs: (typeof RunAttrs)["~type.make.in"]): Target.AnyTarget =>
  withOneExecutable("Shell.Run", attrs, () => runDefinition(attrs) as unknown as Target.AnyTarget)

/**
 * A scoped long-running service with the readiness/health/stop probe
 * contract.
 *
 * @category targets
 * @since 0.1.0
 */
export const Serve = (attrs: (typeof ServeAttrs)["~type.make.in"]): Target.AnyTarget =>
  withOneExecutable("Shell.Serve", attrs, () => serveDefinition(attrs) as unknown as Target.AnyTarget)

/**
 * A tool run whose writes are mechanically confined to the declared
 * `changes` write-set; check mode diffs, write mode applies.
 *
 * @category targets
 * @since 0.1.0
 */
export const Diff = (attrs: (typeof DiffAttrs)["~type.make.in"]): Target.AnyTarget =>
  withOneExecutable("Shell.Diff", attrs, () => diffDefinition(attrs) as unknown as Target.AnyTarget)
