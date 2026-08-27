/** Inert mise version-authority declarations and tool references. */
import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"

/** A mise config participating in the workspace toolchain layer list. */
export const Declaration = Schema.TaggedStruct("Mise", {
  config: Input.File
})

/** A mise config participating in the workspace toolchain layer list. */
export type Declaration = typeof Declaration.Type

/** Checks whether a value is an `S.Mise` declaration. */
export const isDeclaration: (value: unknown) => value is Declaration = Schema.is(Declaration)

const make = (options: { readonly config: Input.File }): Declaration => {
  if (typeof options !== "object" || options === null) throw new TypeError("Mise options must be an object")
  for (const key of Object.getOwnPropertyNames(options)) {
    if (key !== "config") throw new TypeError(`Mise received unknown option ${JSON.stringify(key)}`)
  }
  if (options.config?._tag !== "File") throw new TypeError("Mise config must be an S.file declaration")
  return Object.freeze(Declaration.make({ config: options.config }))
}

/** `S.Mise({ config })`, with `S.Mise.bin(name)` for config-pinned tools. */
export const Mise: typeof make & { readonly bin: (name: string) => Reference.MiseBin } = Object.assign(make, {
  bin: Reference.miseBin
})
