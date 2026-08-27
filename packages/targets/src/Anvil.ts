/** Anvil fork service target declarations. */
import * as Schema from "effect/Schema"
import * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"

/** Attrs for one forked Anvil JSON-RPC service. */
export const ForkAttrs = Schema.Struct({
  forkUrl: Secret.Declaration,
  forkBlockNumber: Schema.Union([Schema.Number, Schema.Literal("latest")]),
  port: Schema.Number
})

const definition = Target.make("Anvil.Fork", {
  attrs: ForkAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Anvil.Fork")
})

/** Declares a scoped, readiness-gated Anvil fork service. */
export const Fork = (attrs: (typeof ForkAttrs)["~type.make.in"]): Target.AnyTarget =>
  definition(attrs) as unknown as Target.AnyTarget
