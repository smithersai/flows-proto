import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import type { CiMatrixResponse } from "smithers-shared/TargetGraph"
import type { NodeSidecar } from "./Node"
import { resolveBuildCli } from "./Targets"

export type CiWorkflow = CiMatrixResponse["workflows"][number]

const scalar = (value: string): string => value.trim().replace(/^['"]|['"]$/g, "")

export const parseWorkflowYaml = (path: string, yaml: string, source: CiWorkflow["source"] = "on-disk"): CiWorkflow => {
  const lines = yaml.split(/\r?\n/)
  const workflowName = scalar(/^name:\s*(.+)$/.exec(yaml)?.[1] ?? basename(path).replace(/\.ya?ml$/, ""))
  const jobs: Array<CiWorkflow["jobs"][number]> = []
  let inJobs = false
  let current: CiWorkflow["jobs"][number] | undefined
  let inMatrix = false
  let matrixIndent = -1
  let blockAxis: string | undefined
  for (const line of lines) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (indent === 0) {
      inJobs = line.trim() === "jobs:"
      inMatrix = false
      continue
    }
    if (!inJobs) continue
    const job = /^  ([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (job !== null) {
      current = { name: job[1]!, targets: [] }
      jobs.push(current)
      inMatrix = false
      blockAxis = undefined
      continue
    }
    if (current === undefined) continue
    const name = /^\s{4}name:\s*(.+)$/.exec(line)
    if (name !== null) current.name = scalar(name[1]!)
    if (/^\s+matrix:\s*$/.test(line)) { inMatrix = true; matrixIndent = indent; current.matrix = {}; continue }
    if (inMatrix && indent <= matrixIndent && line.trim() !== "matrix:") { inMatrix = false; blockAxis = undefined }
    if (inMatrix && current.matrix !== undefined) {
      const axis = /^\s+([A-Za-z0-9_.-]+):\s*(?:\[(.*)\])?\s*$/.exec(line)
      if (axis !== null && indent > matrixIndent) {
        blockAxis = axis[1]!
        current.matrix[blockAxis] = axis[2] === undefined ? [] : axis[2].split(",").map(scalar).filter(Boolean)
        continue
      }
      const item = /^\s+-\s*(.+)$/.exec(line)
      if (item !== null && blockAxis !== undefined) current.matrix[blockAxis]!.push(scalar(item[1]!))
    }
    for (const match of line.matchAll(/\b(?:smthrs|smithers)\s+(?:(?:run|test|lint|build|ci|docs)\s+)?['"]?(\/\/[^\s'";]+)/g)) {
      if (!current.targets.includes(match[1]!)) current.targets.push(match[1]!)
    }
  }
  return { name: workflowName, path, yaml, source, jobs }
}

const yamlFiles = async (root: string): Promise<Array<string>> => {
  const dir = join(root, ".github", "workflows")
  let names: Array<string>
  try { names = await readdir(dir) } catch { return [] }
  return names.filter((name) => /\.ya?ml$/.test(name)).sort().map((name) => join(dir, name))
}

const readWorkflows = async (root: string, source: CiWorkflow["source"]): Promise<Array<CiWorkflow>> =>
  Promise.all((await yamlFiles(root)).map(async (file) => parseWorkflowYaml(relative(root, file), await readFile(file, "utf8"), source)))

export const renderCiMatrix = async (options: {
  readonly repoId: string
  readonly repo: string
  readonly labels: ReadonlyArray<string>
  readonly declarationFiles: ReadonlyArray<string>
  readonly node: NodeSidecar | null
  readonly cli?: string
}): Promise<CiMatrixResponse> => {
  const started = Date.now()
  if (options.node === null || options.labels.length === 0) {
    return { repoId: options.repoId, workflows: await readWorkflows(options.repo, "on-disk"), durationMs: Date.now() - started }
  }
  const scratch = await mkdtemp(join(tmpdir(), "smithers-ci-preview-"))
  try {
    const files = new Set([...options.declarationFiles, "WORKSPACE.ts", ".smithers/WORKSPACE.ts", "smithers.d.ts", "package.json", "pnpm-workspace.yaml"])
    for (const file of files) {
      const source = join(options.repo, file)
      if (!existsSync(source)) continue
      const destination = join(scratch, file)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
    }
    const nodeModules = join(options.repo, "node_modules")
    if (existsSync(nodeModules)) await symlink(nodeModules, join(scratch, "node_modules"), "dir")
    const cli = options.cli ?? resolveBuildCli()
    for (const label of options.labels) {
      const child = Bun.spawn([options.node.path, cli, label, "--write"], { cwd: scratch, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
      await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    }
    const rendered = await readWorkflows(scratch, "scratch-render")
    if (rendered.length > 0) return { repoId: options.repoId, workflows: rendered, durationMs: Date.now() - started }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return { repoId: options.repoId, workflows: await readWorkflows(options.repo, "on-disk"), durationMs: Date.now() - started }
}
