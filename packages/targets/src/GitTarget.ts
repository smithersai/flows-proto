/**
 * PACKAGE.ts git target flavors: `S.Git.Commit`.
 *
 * Phase W1 is construct-only; the constructor validates attrs by schema and
 * installs a {@link Target.notImplemented} implementation.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Reference from "./Reference.ts"
import * as Target from "./Target.ts"

/**
 * Attrs for {@link Commit}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CommitAttrs = Schema.Struct({
  gates: Attr.Gates,
  message: Schema.Union([Schema.NonEmptyString, Reference.AgentRef])
})

const commitDefinition = Target.make("Git.Commit", {
  attrs: CommitAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Git.Commit")
})

/**
 * A gated commit whose message is fixed text or agent-written; outward, so
 * it runs only when named explicitly.
 *
 * @category targets
 * @since 0.1.0
 */
export const Commit = (attrs: (typeof CommitAttrs)["~type.make.in"]): Target.AnyTarget => commitDefinition(attrs)

/**
 * The validated attrs of one `Git.Commit` target.
 *
 * `message` is either the fixed commit text or the {@link Reference.AgentRef}
 * naming the workspace agent that writes it at execution time.
 *
 * @category accessors
 * @since 0.1.0
 */
export const commitAttrsOf = (target: Target.AnyTarget): (typeof CommitAttrs)["Type"] => {
  const metadata = Target.metadata(target)
  if (metadata.target !== "Git.Commit") {
    throw new TypeError(`expected a Git.Commit target, received ${metadata.target}`)
  }
  return metadata.attrs as (typeof CommitAttrs)["Type"]
}
