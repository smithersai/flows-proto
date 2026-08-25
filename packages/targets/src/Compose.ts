/**
 * PACKAGE.ts composition flavors: `S.Generate`, `S.Suite`, `S.Alias`,
 * `S.Test`, `S.Materialize`, `S.ImportClosure`, `S.Clean`, and the
 * `S.Files` algebra.
 *
 * Phase W1 is construct-only: constructors validate attrs by schema, record
 * dependency edges and declared inputs through {@link Target.make}'s attr
 * walk, and install {@link Target.notImplemented} implementations.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Target from "./Target.ts"

/**
 * Schema for a reference to the file rows a resolver-style target produces,
 * `importGraph.files`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TargetFiles = Schema.TaggedStruct("TargetFiles", {
  target: Target.Target
})

/**
 * A reference to the file rows a target produces.
 *
 * @category models
 * @since 0.1.0
 */
export type TargetFiles = typeof TargetFiles.Type

/**
 * Schema for one operand of the file algebra: a file-producing target or a
 * `.files` reference to one.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FileSet = Schema.Union([Target.Target, TargetFiles])

/**
 * One operand of the file algebra.
 *
 * @category models
 * @since 0.1.0
 */
export type FileSet = typeof FileSet.Type

/**
 * Schema for `S.Files.difference(left, right)`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FilesDifference = Schema.TaggedStruct("FilesDifference", {
  left: FileSet,
  right: FileSet
})

/**
 * A declared file-set difference.
 *
 * @category models
 * @since 0.1.0
 */
export type FilesDifference = typeof FilesDifference.Type

const isFileSet = (value: unknown): value is FileSet =>
  Target.isTarget(value) ||
  (typeof value === "object" && value !== null &&
    (value as { readonly _tag?: unknown })._tag === "TargetFiles" &&
    Target.isTarget((value as { readonly target?: unknown }).target))

/**
 * The declared file-set algebra, `S.Files`.
 *
 * `difference(left, right)` is an inert declaration: the sets subtract when
 * the consuming target executes, and the operand targets become ordinary
 * dependency edges through the attr walk.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Files = Object.freeze({
  difference: (left: FileSet, right: FileSet): FilesDifference => {
    if (!isFileSet(left) || !isFileSet(right)) {
      throw new TypeError("Files.difference operands must be targets or target .files references")
    }
    return Object.freeze({ _tag: "FilesDifference", left, right })
  }
})

/**
 * Attaches the non-enumerable `.files` reference resolver-style targets
 * expose, so `graphTarget.files` is an inert declaration naming the target's
 * file rows.
 *
 * @category constructors
 * @since 0.1.0
 */
export const attachFiles = <T extends Target.AnyTarget>(target: T): T & { readonly files: TargetFiles } => {
  Object.defineProperty(target, "files", {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ _tag: "TargetFiles", target }),
    writable: false
  })
  return target as T & { readonly files: TargetFiles }
}

/**
 * Attrs for {@link Generate}. Three observed forms share the schema: a
 * literal `emit` map, a `script` writing inside `changes`, and a `bin`
 * printing to `stdout` — exactly one of the three selectors is present.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GenerateAttrs = Schema.Struct({
  emit: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Reference.Symlink]))),
  script: Schema.optional(Input.File),
  bin: Schema.optional(Reference.Tool),
  args: Schema.optional(Attr.Args),
  stdout: Schema.optional(Schema.Literal("file")),
  data: Schema.optional(Attr.Data),
  changes: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

const generateDefinition = Target.make("Generate", {
  attrs: GenerateAttrs,
  kinds: ["run", "lint"],
  implementation: () => Target.notImplemented("Generate")
})

/**
 * A generated-output target: check by default, `--write` applies.
 *
 * @category targets
 * @since 0.1.0
 */
export const Generate = (attrs: (typeof GenerateAttrs)["~type.make.in"]): Target.AnyTarget => {
  if (typeof attrs !== "object" || attrs === null) throw new TypeError("Generate attrs must be an object")
  Attr.requireOneExecutable("Generate", attrs, ["emit", "script", "bin"])
  return generateDefinition(attrs)
}

/**
 * Attrs for {@link Suite}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SuiteAttrs = Schema.Struct({
  tests: Schema.Array(Target.Target)
})

const suiteDefinition = Target.make("Suite", {
  attrs: SuiteAttrs,
  kinds: ["test"],
  implementation: () => Target.notImplemented("Suite")
})

/**
 * A named group of check-capable targets that run together.
 *
 * @category targets
 * @since 0.1.0
 */
export const Suite = (attrs: (typeof SuiteAttrs)["~type.make.in"]): Target.AnyTarget => suiteDefinition(attrs)

/**
 * Attrs for {@link Alias}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AliasAttrs = Schema.Struct({
  target: Target.Target
})

/**
 * A second name for one target: a distinct target node whose kinds mirror
 * the aliased target and whose only dependency is it.
 *
 * A distinct node is what keeps the one-value-one-label law intact: the
 * alias has its own label, and the aliased target keeps its own.
 *
 * @category targets
 * @since 0.1.0
 */
export const Alias = (target: Target.AnyTarget): Target.AnyTarget => {
  if (!Target.isTarget(target)) throw new TypeError("Alias requires a target")
  const kinds = Target.metadata(target).kinds
  const definition = Target.make("Alias", {
    attrs: AliasAttrs,
    kinds,
    implementation: () => Target.notImplemented("Alias")
  })
  return definition({ target })
}

/**
 * Attrs for {@link Test}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestAttrs = Schema.Struct({
  expect: FilesDifference,
  toBe: Schema.Literal("empty")
})

const testDefinition = Target.make("Test", {
  attrs: TestAttrs,
  kinds: ["test"],
  implementation: () => Target.notImplemented("Test")
})

/**
 * A declarative assertion over the file algebra.
 *
 * @category targets
 * @since 0.1.0
 */
export const Test = (attrs: (typeof TestAttrs)["~type.make.in"]): Target.AnyTarget => testDefinition(attrs)

/**
 * Attrs for {@link Materialize}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const MaterializeAttrs = Schema.Struct({
  target: Target.Target
})

const materializeDefinition = Target.make("Materialize", {
  attrs: MaterializeAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Materialize")
})

/**
 * Places a build target's cached output tree into the working tree.
 *
 * @category targets
 * @since 0.1.0
 */
export const Materialize = (target: Target.AnyTarget): Target.AnyTarget => {
  if (!Target.isTarget(target)) throw new TypeError("Materialize requires a target")
  return materializeDefinition({ target })
}

/**
 * Attrs for {@link ImportClosure}. `entries` is a file-producing target or a
 * declared glob list.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ImportClosureAttrs = Schema.Struct({
  entries: Schema.Union([Target.Target, Input.Glob, Schema.Array(Schema.Union([Input.Glob, Target.Target]))])
})

const importClosureDefinition = Target.make("ImportClosure", {
  attrs: ImportClosureAttrs,
  kinds: ["build"],
  implementation: () => Target.notImplemented("ImportClosure")
})

/**
 * The transitive import closure of the entry files, as per-file rows.
 *
 * The constructed target exposes `.files` like a bundler resolve target.
 *
 * @category targets
 * @since 0.1.0
 */
export const ImportClosure = (
  attrs: (typeof ImportClosureAttrs)["~type.make.in"]
): Target.AnyTarget & { readonly files: TargetFiles } =>
  attachFiles(importClosureDefinition(attrs) as unknown as Target.AnyTarget)

/**
 * Attrs for {@link Clean}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CleanAttrs = Schema.Struct({
  targets: Schema.optional(Schema.Array(Target.Target)),
  paths: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

const cleanDefinition = Target.make("Clean", {
  attrs: CleanAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Clean")
})

/**
 * Removes the declared targets' outputs and the named scratch paths, and
 * nothing else.
 *
 * @category targets
 * @since 0.1.0
 */
export const Clean = (attrs: (typeof CleanAttrs)["~type.make.in"]): Target.AnyTarget => cleanDefinition(attrs)
