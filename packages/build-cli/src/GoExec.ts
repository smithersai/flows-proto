/**
 * Go-specific planning kept out of the package executor's dispatch switch.
 *
 * @since 0.1.0
 */
/* eslint-disable jsdoc/require-description, jsdoc/no-restricted-syntax */
import type * as Go from "@smthrs/targets/Go"
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as NodeChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as PackageTree from "./PackageTree.ts"
import * as StampExec from "./StampExec.ts"

/** */
export interface Context {
  readonly root: string
  readonly packagePath: string
  readonly workspace: WorkspaceDeclaration.WorkspaceDeclaration
}

/** */
export interface Planned {
  readonly argv?: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly outDirs: ReadonlyArray<string>
  readonly writeSet: ReadonlyArray<string>
  readonly closureIdentity?: unknown
}

const toolchain = (workspace: WorkspaceDeclaration.WorkspaceDeclaration): Go.ToolchainDeclaration | undefined =>
  workspace.toolchains?.find((entry): entry is Go.ToolchainDeclaration => entry._tag === "GoToolchain")

const moduleDirectory = (context: Context): string => {
  const declaration = toolchain(context.workspace)
  if (declaration === undefined) return context.root
  const mod = Input.resolvePath("", declaration.mod.path)
  return NodePath.join(context.root, NodePath.dirname(mod))
}

const execFile = (file: string, args: ReadonlyArray<string>, cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(file, [...args], { cwd, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`${file} ${args.join(" ")} failed: ${stderr || error.message}`))
      else resolve(stdout)
    })
  })

/** */
export const resolveGo = async (context: Context): Promise<
  | { readonly ok: true; readonly path: string; readonly identity: unknown }
  | { readonly ok: false; readonly refusal: string; readonly identity: unknown }
> => {
  const path = PackageTree.findOnPath("go")
  if (path === undefined) {
    return { ok: false, refusal: "host binary \"go\" is not present on PATH", identity: { tag: "GoBin", absent: true } }
  }
  const cwd = moduleDirectory(context)
  const probe = await PackageTree.probeVersion(path, cwd)
  const declaration = toolchain(context.workspace)
  const authorities: Array<unknown> = []
  if (declaration !== undefined) {
    for (const input of [declaration.mod, declaration.sum]) {
      const relative = Input.resolvePath("", input.path)
      authorities.push({
        path: relative,
        digest: await Input.digestFile(NodePath.join(context.root, relative), { workspaceRoot: context.root })
      })
    }
    const versions = declaration.versions as unknown as { readonly flake?: Input.File; readonly lock?: Input.File }
    for (const input of [versions.flake, versions.lock]) {
      if (input === undefined) continue
      const relative = Input.resolvePath("", input.path)
      authorities.push({
        path: relative,
        digest: await Input.digestFile(NodePath.join(context.root, relative), { workspaceRoot: context.root })
      })
    }
  }
  return {
    ok: true,
    path,
    identity: { tag: "GoBin", path, cwd: NodePath.relative(context.root, cwd), probe, authorities }
  }
}

/** */
export const resolveNix = async (name: string, context: Context): Promise<
  | { readonly ok: true; readonly path: string; readonly identity: unknown }
  | { readonly ok: false; readonly refusal: string; readonly identity: unknown }
> => {
  const nix = PackageTree.findOnPath("nix")
  const declaration = context.workspace.toolchains?.find((entry) => entry._tag === "NixDevShell") as
    | { readonly flake: Input.File; readonly lock: Input.File }
    | undefined
  const authority: Array<unknown> = []
  for (const input of [declaration?.flake, declaration?.lock]) {
    if (input === undefined) continue
    const relative = Input.resolvePath("", input.path)
    authority.push({
      path: relative,
      digest: await Input.digestFile(NodePath.join(context.root, relative), { workspaceRoot: context.root })
    })
  }
  if (nix === undefined) {
    return {
      ok: false,
      refusal: `host binary "nix" is not present on PATH (required by S.Nix.bin(${JSON.stringify(name)}))`,
      identity: { tag: "NixBin", name, absent: true, authority }
    }
  }
  try {
    const path = (await execFile(nix, ["develop", "--command", "which", name], context.root)).trim()
    if (path === "") throw new Error("which returned no path")
    return { ok: true, path, identity: { tag: "NixBin", name, nix, path, authority } }
  } catch (cause) {
    return {
      ok: false,
      refusal: `Nix dev shell does not provide ${JSON.stringify(name)}: ${String(cause)}`,
      identity: { tag: "NixBin", name, nix, authority }
    }
  }
}

const anchor = (pattern: string, packagePath: string): string => {
  if (pattern.startsWith("//")) return `./${pattern.slice(2)}`
  if (!pattern.startsWith("./") || packagePath === "") return pattern
  return `./${[packagePath, pattern.slice(2)].filter(Boolean).join("/")}`
}

const targetOf = (value: unknown): Target.AnyTarget | undefined => {
  if (Target.isTarget(value)) return value
  if (typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === "TargetFiles") {
    const candidate = (value as { readonly target?: unknown }).target
    return Target.isTarget(candidate) ? candidate : undefined
  }
  return undefined
}

const patternsOf = (value: unknown, context: Context): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.map((entry) => anchor(String(entry), context.packagePath))
  const target = targetOf(value)
  if (target !== undefined && Target.metadata(target).target === "Go.Packages") {
    const source = Target.metadata(target).sourceFile
    const ownPath = source === undefined
      ? context.packagePath
      : NodePath.relative(context.root, NodePath.dirname(source)).split(NodePath.sep).join("/")
    return (Target.metadata(target).attrs as { readonly pkgs: ReadonlyArray<string> }).pkgs.map((entry) =>
      anchor(entry, ownPath)
    )
  }
  return []
}

interface GoListRow {
  readonly ImportPath?: string
  readonly Dir?: string
  readonly GoFiles?: ReadonlyArray<string>
  readonly CgoFiles?: ReadonlyArray<string>
  readonly TestGoFiles?: ReadonlyArray<string>
  readonly XTestGoFiles?: ReadonlyArray<string>
  readonly EmbedFiles?: ReadonlyArray<string>
  readonly TestEmbedFiles?: ReadonlyArray<string>
  readonly XTestEmbedFiles?: ReadonlyArray<string>
}

const jsonRows = (text: string): ReadonlyArray<GoListRow> => {
  const rows: Array<GoListRow> = []
  let start = -1, depth = 0, string = false, escape = false
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!
    if (string) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === "\"") string = false
      continue
    }
    if (ch === "\"") string = true
    else if (ch === "{") { if (depth++ === 0) start = index }
    else if (ch === "}" && --depth === 0 && start >= 0) {
      rows.push(JSON.parse(text.slice(start, index + 1)))
      start = -1
    }
  }
  return rows
}

const listed = async (
  goPath: string,
  cwd: string,
  patterns: ReadonlyArray<string>,
  deps: boolean
): Promise<ReadonlyArray<GoListRow>> =>
  jsonRows(await execFile(goPath, ["list", ...(deps ? ["-deps"] : []), "-json", ...patterns], cwd))

const selectedPackages = async (
  selection: unknown,
  context: Context,
  goPath: string
): Promise<ReadonlyArray<string>> => {
  if (
    typeof selection === "object" && selection !== null &&
    (selection as { readonly _tag?: unknown })._tag === "FilesDifference"
  ) {
    const difference = selection as { readonly left: unknown; readonly right: unknown }
    const left = await listed(goPath, moduleDirectory(context), patternsOf(difference.left, context), false)
    const right = new Set(
      (await listed(goPath, moduleDirectory(context), patternsOf(difference.right, context), false)).map((row) =>
        row.ImportPath
      )
    )
    return left.flatMap((row) => row.ImportPath !== undefined && !right.has(row.ImportPath) ? [row.ImportPath] : [])
  }
  const patterns = patternsOf(selection, context)
  const rows = await listed(goPath, moduleDirectory(context), patterns, false)
  return rows.flatMap((row) => row.ImportPath === undefined ? [] : [row.ImportPath])
}

const closure = async (packages: ReadonlyArray<string>, context: Context, goPath: string): Promise<unknown> => {
  const rows = await listed(goPath, moduleDirectory(context), packages, true)
  const files = new Set<string>()
  for (const row of rows) {
    if (row.Dir === undefined) continue
    for (
      const name of [
        ...(row.GoFiles ?? []),
        ...(row.CgoFiles ?? []),
        ...(row.TestGoFiles ?? []),
        ...(row.XTestGoFiles ?? []),
        ...(row.EmbedFiles ?? []),
        ...(row.TestEmbedFiles ?? []),
        ...(row.XTestEmbedFiles ?? [])
      ]
    ) {
      const absolute = NodePath.join(row.Dir, name)
      const relative = NodePath.relative(context.root, absolute).split(NodePath.sep).join("/")
      if (!relative.startsWith("../") && relative !== "") files.add(relative)
    }
  }
  const digests: Array<readonly [string, string]> = []
  for (const file of [...files].sort()) {
    const bytes = await Fs.readFile(NodePath.join(context.root, file))
    digests.push([file, createHash("sha256").update(bytes).digest("hex")])
  }
  return { packages: [...packages].sort(), files: digests }
}

const environment = (context: Context, attrs: Record<string, unknown>): Record<string, string> => {
  const declaration = toolchain(context.workspace)
  const env = { ...((attrs["env"] as Record<string, string> | undefined) ?? {}) }
  const cgo = attrs["cgo"] ?? declaration?.cgo
  if (typeof cgo === "boolean") env["CGO_ENABLED"] = cgo ? "1" : "0"
  if ((declaration?.experiments.length ?? 0) > 0) env["GOEXPERIMENT"] = declaration!.experiments.join(",")
  if (attrs["goos"] !== undefined) env["GOOS"] = String(attrs["goos"])
  if (attrs["goarch"] !== undefined) env["GOARCH"] = String(attrs["goarch"])
  if (attrs["offline"] === true) {
    env["GOPROXY"] = "off"
    env["GOFLAGS"] = "-mod=readonly"
  }
  return env
}

/** */
export const toolchainEnvironment = (context: Context): Readonly<Record<string, string>> => environment(context, {})

/** */
export const planRule = async (
  rule: string,
  attrs: Record<string, unknown>,
  context: Context,
  goPath: string
): Promise<Planned> => {
  const env = environment(context, attrs)
  if (rule === "Go.Packages") {
    const packages = await selectedPackages(attrs["pkgs"], context, goPath)
    return { env, outDirs: [], writeSet: [], closureIdentity: await closure(packages, context, goPath) }
  }
  if (rule === "Go.ModDownload") {
    const outDirs = (attrs["outDirs"] as ReadonlyArray<string>).map((path) =>
      Input.resolvePath(context.packagePath, path)
    )
    return {
      argv: [goPath, "mod", "download"],
      env: { ...env, GOMODCACHE: NodePath.join(context.root, outDirs[0] ?? ".gomodcache") },
      outDirs,
      writeSet: []
    }
  }
  if (rule === "Go.Binary") {
    const pkg = anchor(String(attrs["pkg"]), context.packagePath)
    const out = Input.resolvePath(context.packagePath, String(attrs["out"]))
    const flags = [...((attrs["ldflags"] as ReadonlyArray<string> | undefined) ?? [])]
    for (const [name, value] of Object.entries((attrs["stamp"] as Record<string, unknown> | undefined) ?? {})) {
      flags.push("-X", `${name}=${StampExec.token(name, value)}`)
    }
    const argv = [goPath, "build", "-o", out, ...(flags.length === 0 ? [] : ["-ldflags", flags.join(" ")]), pkg]
    const packages = await selectedPackages([pkg], { ...context, packagePath: "" }, goPath)
    return {
      argv,
      env,
      outDirs: [NodePath.dirname(out)],
      writeSet: [],
      closureIdentity: await closure(packages, context, goPath)
    }
  }
  if (rule === "Go.Test") {
    const packages = await selectedPackages(attrs["pkgs"], context, goPath)
    const runner = attrs["runner"] === "gotestsum" && PackageTree.findOnPath("gotestsum") !== undefined
      ? PackageTree.findOnPath("gotestsum")!
      : goPath
    const argv = runner === goPath
      ? [goPath, "test", ...(attrs["timeout"] === undefined ? [] : ["-timeout", String(attrs["timeout"])]), ...packages]
      : [runner, "--", ...(attrs["timeout"] === undefined ? [] : ["-timeout", String(attrs["timeout"])]), ...packages]
    return { argv, env, outDirs: [], writeSet: [], closureIdentity: await closure(packages, context, goPath) }
  }
  if (rule === "Go.Lint") {
    const pkgs = (attrs["pkgs"] as ReadonlyArray<string>).map((entry) => anchor(entry, context.packagePath))
    const config = Input.resolvePath(context.packagePath, (attrs["config"] as Input.File).path)
    const changes = ((attrs["changes"] as ReadonlyArray<string> | undefined) ?? []).map((entry) =>
      Input.resolvePath(context.packagePath, entry)
    )
    return {
      argv: [
        goPath,
        "run",
        `github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${String(attrs["version"])}`,
        "run",
        "--config",
        config,
        ...(changes.length > 0 ? ["--fix"] : []),
        ...pkgs
      ],
      env,
      outDirs: [],
      writeSet: changes
    }
  }
  if (rule === "Go.Generate") {
    const packages = await selectedPackages(attrs["pkgs"], context, goPath)
    return {
      argv: [goPath, "generate", ...packages],
      env,
      outDirs: [],
      writeSet: ((attrs["changes"] as ReadonlyArray<string>) ?? []).map((entry) =>
        Input.resolvePath(context.packagePath, entry)
      ),
      closureIdentity: await closure(packages, context, goPath)
    }
  }
  if (rule === "Go.Fuzz") {
    const pkg = anchor(String(attrs["pkg"]), context.packagePath)
    const packages = await selectedPackages([pkg], { ...context, packagePath: "" }, goPath)
    return {
      argv: [
        goPath,
        "test",
        pkg,
        "-run=^$",
        `-fuzz=${String(attrs["fuzz"])}`,
        `-fuzztime=${String(attrs["time"])}`,
        ...(attrs["parallel"] === undefined ? [] : [`-parallel=${String(attrs["parallel"])}`])
      ],
      env,
      outDirs: [],
      writeSet: [],
      closureIdentity: await closure(packages, context, goPath)
    }
  }
  return { env, outDirs: [], writeSet: [] }
}
