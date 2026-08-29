/**
 * Generated compile-time file-path registries for `Smithers.file`.
 *
 * A registry is opt-in: only a workspace whose TypeScript program includes
 * the generated declaration narrows `Smithers.file`. Discovery delegates to
 * {@link Input.discoverFiles}, keeping its ignore, confinement, state-path,
 * and resource-limit rules as the single workspace scan implementation.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as NodePath from "node:path"
import * as GeneratedFile from "./GeneratedFile.ts"
import * as Input from "./Input.ts"

/**
 * Default generated declaration path.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultOutput = "known-files.d.ts"

/**
 * Maximum number of union literals emitted in comprehensive mode.
 *
 * Above this ceiling the registry retains every workspace-absolute spelling
 * and package-local relative spellings, avoiding the package-count multiplier
 * caused by `../` paths in very large workspaces.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumKnownFileLiterals = 100_000

/**
 * How relative spellings were selected for one generated declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type Mode = "comprehensive" | "bounded"

/**
 * The deterministic result of a known-file workspace scan.
 *
 * @category models
 * @since 0.1.0
 */
export interface Discovery {
  readonly files: ReadonlyArray<string>
  readonly packageDirectories: ReadonlyArray<string>
  readonly literals: ReadonlyArray<string>
  readonly mode: Mode
}

/** Reports whether a workspace file is a BUILD.ts or PACKAGE.ts marker. */
const isPackageMarker = (path: string): boolean =>
  path === "BUILD.ts" || path === "PACKAGE.ts" || path.endsWith("/BUILD.ts") || path.endsWith("/PACKAGE.ts")

/** Returns the normalized directory holding a package marker. */
const markerDirectory = (path: string): string => {
  const directory = NodePath.posix.dirname(path)
  return directory === "." ? "" : directory
}

const localTo = (directory: string, path: string): string => directory === "" ? path : path.slice(directory.length + 1)

const packageLocalLiterals = (
  literals: Set<string>,
  files: ReadonlyArray<string>,
  packageDirectories: ReadonlyArray<string>
): void => {
  for (const directory of packageDirectories) {
    for (const path of files) {
      if (directory === "" || path.startsWith(`${directory}/`)) literals.add(localTo(directory, path))
    }
  }
}

/**
 * Computes accepted literals from an already-discovered workspace file list.
 *
 * Comprehensive mode emits each `//` path and its relative spelling from
 * every package directory. If that would cross `maximumLiterals`, bounded
 * mode emits every `//` path and relative paths only for files below the
 * declaring package directory.
 *
 * @category generation
 * @since 0.1.0
 */
export const knownFileDiscovery = (
  discovered: ReadonlyArray<string>,
  options: {
    readonly output?: string | undefined
    readonly maximumLiterals?: number | undefined
  } = {}
): Discovery => {
  const maximumLiterals = options.maximumLiterals ?? maximumKnownFileLiterals
  if (!Number.isSafeInteger(maximumLiterals) || maximumLiterals < 1) {
    throw new TypeError("known-file maximumLiterals must be a positive safe integer")
  }
  const files = [...new Set([...discovered, GeneratedFile.resolveOutputPath(options.output ?? defaultOutput)])].sort()
  const packageDirectories = [...new Set(files.filter(isPackageMarker).map(markerDirectory))].sort()
  const literals = new Set(files.map((path) => `//${path}`))
  let mode: Mode = literals.size > maximumLiterals ? "bounded" : "comprehensive"
  if (mode === "comprehensive") {
    comprehensive: for (const directory of packageDirectories) {
      for (const path of files) {
        literals.add(NodePath.posix.relative(directory, path))
        if (literals.size > maximumLiterals) {
          mode = "bounded"
          break comprehensive
        }
      }
    }
  }
  if (mode === "bounded") {
    literals.clear()
    for (const path of files) literals.add(`//${path}`)
    packageLocalLiterals(literals, files, packageDirectories)
    if (literals.size > maximumLiterals) {
      throw new Error(
        `known-file registry needs ${literals.size} absolute and package-local literals, exceeding the ` +
          `${maximumLiterals} literal limit`
      )
    }
  }
  return {
    files,
    packageDirectories,
    literals: [...literals].sort(),
    mode
  }
}

/**
 * Scans a workspace with the declared-input walk and computes its registry.
 *
 * @category generation
 * @since 0.1.0
 */
export const discoverKnownFiles = async (
  workspaceRoot: string,
  options: {
    readonly output?: string | undefined
    readonly maximumLiterals?: number | undefined
    readonly cacheDirectory?: string | undefined
    readonly limits?: Partial<Input.ScanLimits> | undefined
    readonly signal?: AbortSignal | undefined
  } = {}
): Promise<Discovery> =>
  knownFileDiscovery(
    await Input.discoverFiles(workspaceRoot, {
      ...(options.cacheDirectory === undefined ? {} : { cacheDirectory: options.cacheDirectory }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }),
    options
  )

/**
 * Renders ambient declarations consumed by plain `tsc`.
 *
 * @category generation
 * @since 0.1.0
 */
export const renderKnownFileDeclaration = (discovery: Discovery): string => {
  const relativeRule = discovery.mode === "comprehensive"
    ? "Relative entries are emitted from every BUILD.ts and PACKAGE.ts directory to every workspace file."
    : "This large workspace emits relative entries only for files below each BUILD.ts and PACKAGE.ts directory."
  return `// Generated by @smthrs/targets KnownFile. Do not edit.\n` +
    `// The ${discovery.files.length} workspace files below follow the same .gitignore and host-state rules as globs.\n` +
    `// // entries are workspace-absolute. ${relativeRule}\n` +
    `declare module "@smthrs/targets/KnownFiles" {\n` +
    `  export type KnownFile =\n` +
    discovery.literals.map((path) => `      | ${JSON.stringify(path)}\n`).join("") +
    `}\n\n` +
    `declare module "@smthrs/targets" {\n` +
    `  export const Smithers: Omit<typeof import("@smthrs/targets/Smithers"), "file"> & {\n` +
    `    readonly file: (path: import("@smthrs/targets/KnownFiles").KnownFile) => ` +
    `import("@smthrs/targets/Input").File\n` +
    `  }\n` +
    `}\n`
}

const payload = async (
  workspaceRoot: string,
  output: string,
  signal?: AbortSignal | undefined
): Promise<GeneratedFile.FilePayload> => ({
  path: output,
  contents: renderKnownFileDeclaration(await discoverKnownFiles(workspaceRoot, { output, signal }))
})

/**
 * Scans and atomically writes one known-file declaration.
 *
 * @category effects
 * @since 0.1.0
 */
export const writeKnownFileDeclaration = (
  workspaceRoot: string,
  output = defaultOutput
): Effect.Effect<void, GeneratedFile.WriteFileError | CauseError> =>
  Effect.flatMap(
    Effect.tryPromise({
      try: (signal) => payload(workspaceRoot, output, signal),
      catch: causeError
    }),
    (generated) => GeneratedFile.writeGeneratedFile(workspaceRoot, generated)
  )

/**
 * Scans and checks one known-file declaration for drift.
 *
 * @category effects
 * @since 0.1.0
 */
export const checkKnownFileDeclaration = (
  workspaceRoot: string,
  output = defaultOutput
): Effect.Effect<void, GeneratedFile.DriftError | CauseError> =>
  Effect.flatMap(
    Effect.tryPromise({
      try: (signal) => payload(workspaceRoot, output, signal),
      catch: causeError
    }),
    (generated) => GeneratedFile.checkGeneratedFile(workspaceRoot, generated)
  )

/**
 * A workspace scan could not produce a known-file declaration.
 *
 * @category errors
 * @since 0.1.0
 */
export class CauseError extends Error {
  readonly _tag = "smithers-build/KnownFileError"
}

const causeError = (cause: unknown): CauseError =>
  new CauseError(`could not generate known-file declaration: ${GeneratedFile.failureMessage(cause)}`, { cause })
