/**
 * Inert, late-bound build stamp references.
 *
 * @since 0.1.0
 */
/* eslint-disable jsdoc/require-description, jsdoc/no-restricted-syntax */
import * as Schema from "effect/Schema"

/** */
export const Value = Schema.TaggedStruct("Stamp", {
  name: Schema.Literals(["version", "commit", "commitDate", "buildTime", "versionMeta"])
})
/** */
export type Value = typeof Value.Type

const value = (name: Value["name"]): Value => Object.freeze(Value.make({ name }))

/** */
export const version = value("version")
/** */
export const commit = value("commit")
/** */
export const commitDate = value("commitDate")
/** */
export const buildTime = value("buildTime")
/** */
export const versionMeta = value("versionMeta")
