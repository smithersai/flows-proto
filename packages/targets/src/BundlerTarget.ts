/**
 * PACKAGE.ts bundler surface: `S.Bundler.Rspack(...)`.
 *
 * The `Rspack` call constructs no target. It returns an object with
 * `.resolve(opts)` and `.build(opts)` methods; each method call constructs
 * one target that carries the bundler config file plus the call's own
 * options. `resolve` targets expose `.files` for the file algebra.
 *
 * Phase W1 is construct-only; both methods install
 * {@link Target.notImplemented} implementations.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import { attachFiles, type TargetFiles } from "./Compose.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/**
 * Attrs for a bundler resolve target.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ResolveAttrs = Schema.Struct({
  config: Input.File,
  entries: Schema.Array(Schema.NonEmptyString),
  universe: Attr.Data
})

/**
 * Attrs for a bundler build target.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BuildAttrs = Schema.Struct({
  config: Input.File,
  environment: Schema.NonEmptyString,
  mode: Schema.NonEmptyString,
  env: Schema.optional(Attr.Env),
  graph: Target.Target,
  outDirs: Schema.Array(Schema.NonEmptyString)
})

const resolveDefinition = Target.make("Bundler.Rspack.resolve", {
  attrs: ResolveAttrs,
  kinds: ["build"],
  implementation: () => Target.notImplemented("Bundler.Rspack.resolve")
})

const buildDefinition = Target.make("Bundler.Rspack.build", {
  attrs: BuildAttrs,
  kinds: ["build"],
  implementation: () => Target.notImplemented("Bundler.Rspack.build")
})

/**
 * One configured Rspack bundler: a factory for resolve and build targets.
 *
 * @category models
 * @since 0.1.0
 */
export interface RspackBundler {
  readonly resolve: (options: {
    readonly entries: ReadonlyArray<string>
    readonly universe: (typeof ResolveAttrs)["~type.make.in"]["universe"]
  }) => Target.AnyTarget & { readonly files: TargetFiles }
  readonly build: (options: {
    readonly environment: string
    readonly mode: string
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly graph: Target.AnyTarget
    readonly outDirs: ReadonlyArray<string>
  }) => Target.AnyTarget
}

const isFile = Schema.is(Input.File)

/**
 * The methods rebuild their attrs from named keys, so a misspelled option
 * would vanish before the schema sees it. Rejecting unknown keys here keeps
 * the no-silent-drop rule that `Target.make` enforces for direct attrs.
 */
const rejectUnknownOptions = (id: string, options: object, known: ReadonlyArray<string>): void => {
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) {
      throw new TypeError(`${id} received unknown option ${JSON.stringify(key)}`)
    }
  }
}

/**
 * Configures Rspack against its own config file. The call itself constructs
 * nothing; the returned methods construct targets keyed on the config plus
 * their own options.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Rspack = (options: { readonly config: Input.File }): RspackBundler => {
  if (typeof options !== "object" || options === null || !isFile(options.config)) {
    throw new TypeError("Bundler.Rspack requires a declared config file")
  }
  rejectUnknownOptions("Bundler.Rspack", options, ["config"])
  const config = options.config
  const bundler: RspackBundler = {
    resolve: (resolveOptions) => {
      if (typeof resolveOptions !== "object" || resolveOptions === null) {
        throw new TypeError("Bundler.Rspack resolve options must be an object")
      }
      rejectUnknownOptions("Bundler.Rspack.resolve", resolveOptions, ["entries", "universe"])
      return attachFiles(
        resolveDefinition({
          config,
          entries: resolveOptions.entries,
          universe: resolveOptions.universe
        }) as unknown as Target.AnyTarget
      )
    },
    build: (buildOptions) => {
      if (typeof buildOptions !== "object" || buildOptions === null) {
        throw new TypeError("Bundler.Rspack build options must be an object")
      }
      rejectUnknownOptions("Bundler.Rspack.build", buildOptions, [
        "environment",
        "mode",
        "env",
        "graph",
        "outDirs"
      ])
      return buildDefinition({
        config,
        environment: buildOptions.environment,
        mode: buildOptions.mode,
        ...(buildOptions.env === undefined ? {} : { env: buildOptions.env }),
        graph: buildOptions.graph,
        outDirs: buildOptions.outDirs
      })
    }
  }
  return Object.freeze(bundler)
}
