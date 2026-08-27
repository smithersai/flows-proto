/** Foundry workspace toolchain and forge target declarations. */
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Input from "./Input.ts"
import * as Mise from "./Mise.ts"
import * as Reference from "./Reference.ts"
import * as Shell from "./Shell.ts"
import * as Target from "./Target.ts"

/** Workspace layer binding a foundry config to an optional version authority. */
export const ToolchainDeclaration = Schema.TaggedStruct("FoundryToolchain", {
  config: Input.File,
  versions: Schema.optional(Mise.Declaration)
})

/** Workspace layer binding a foundry config to an optional version authority. */
export type ToolchainDeclaration = typeof ToolchainDeclaration.Type

/** Checks whether a value is a Foundry toolchain declaration. */
export const isToolchainDeclaration: (value: unknown) => value is ToolchainDeclaration = Schema.is(
  ToolchainDeclaration
)

/** Declares the workspace's Foundry configuration and version authority. */
export const Toolchain = (options: {
  readonly config: Input.File
  readonly versions?: Mise.Declaration | undefined
}): ToolchainDeclaration => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Foundry.Toolchain options must be an object")
  }
  for (const key of Object.getOwnPropertyNames(options)) {
    if (key !== "config" && key !== "versions") {
      throw new TypeError(`Foundry.Toolchain received unknown option ${JSON.stringify(key)}`)
    }
  }
  if (options.config?._tag !== "File") throw new TypeError("Foundry.Toolchain config must be an S.file declaration")
  if (options.versions !== undefined && !Mise.isDeclaration(options.versions)) {
    throw new TypeError("Foundry.Toolchain versions must be an S.Mise declaration")
  }
  return Object.freeze(ToolchainDeclaration.make({
    config: options.config,
    ...(options.versions === undefined ? {} : { versions: options.versions })
  }))
}

const shared = {
  config: Schema.optional(Input.File),
  profile: Schema.optional(Schema.NonEmptyString),
  data: Schema.optional(Attr.Data),
  sandbox: Schema.optional(Attr.Sandbox)
} as const

/** Attrs for `S.Foundry.Build`. */
export const BuildAttrs = Schema.Struct({
  ...shared,
  skip: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  outDirs: Schema.Array(Schema.NonEmptyString)
})

/** Attrs for `S.Foundry.Test`. */
export const TestAttrs = Schema.Struct({
  ...shared,
  ffi: Schema.optional(Schema.Array(Target.Target)),
  gates: Schema.optional(Attr.Gates),
  services: Schema.optional(Attr.Services)
})

/** Attrs for `S.Foundry.Fmt`. */
export const FmtAttrs = Schema.Struct({
  config: Schema.optional(Input.File),
  data: Schema.optional(Attr.Data),
  changes: Schema.Array(Schema.NonEmptyString),
  sandbox: Schema.optional(Attr.Sandbox)
})

const forge = Reference.hostBin("forge")

const buildDefinition = Target.make("Foundry.Build", {
  attrs: BuildAttrs,
  kinds: ["build"],
  cache: true,
  outputs: (attrs) => ({ cwd: ".", paths: attrs.outDirs }),
  implementation: (attrs) => Target.runTool(Shell.execPayload({ bin: forge, args: ["build", ...(attrs.skip ?? [])] }))
})

const testDefinition = Target.make("Foundry.Test", {
  attrs: TestAttrs,
  kinds: ["test"],
  cache: true,
  implementation: () => Target.runTool(Shell.execPayload({ bin: forge, args: ["test"] }))
})

const fmtDefinition = Target.make("Foundry.Fmt", {
  attrs: FmtAttrs,
  kinds: ["lint", "run"],
  cache: (attrs) => attrs.changes.length > 0,
  implementation: () => Target.runTool(Shell.execPayload({ bin: forge, args: ["fmt", "--check"] }))
})

/** Compiles Solidity sources with forge and captures the declared output directories. */
export const Build = (attrs: (typeof BuildAttrs)["~type.make.in"]): Target.AnyTarget =>
  buildDefinition(attrs) as unknown as Target.AnyTarget

/** Runs forge tests under the declared profile and service/data edges. */
export const Test = (attrs: (typeof TestAttrs)["~type.make.in"]): Target.AnyTarget =>
  testDefinition(attrs) as unknown as Target.AnyTarget

/** Checks or writes forge formatting inside the declared write set. */
export const Fmt = (attrs: (typeof FmtAttrs)["~type.make.in"]): Target.AnyTarget =>
  fmtDefinition(attrs) as unknown as Target.AnyTarget
