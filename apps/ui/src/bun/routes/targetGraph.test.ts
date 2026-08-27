import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TargetGraphResponseSchema } from "smithers-shared/TargetGraph"
import { startLocalServer } from "../server"
import type { LocalServer } from "../server"

let root = ""
let repo = ""
let server: LocalServer

const post = (path: string, body: unknown): Promise<Response> => fetch(`${server.origin}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
})

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "smithers-target-graph-"))
  repo = await realpath(await mkdtemp(join(tmpdir(), "smithers-target-graph-repo-")))
  await mkdir(join(repo, ".smithers"))
  await writeFile(join(repo, ".smithers", "WORKSPACE.ts"), 'import "@smthrs/targets"\n')
  await writeFile(join(root, "index.html"), "<!doctype html>")
  const cli = join(root, "cli.js")
  await writeFile(cli, [
    "const args = process.argv.slice(2)",
    "if (args[0] === 'graph') console.log(JSON.stringify({ graph: '//src:lint\\n  -data-> //src:srcs', targets: [{ label: '//src:lint', target: 'Shell.Test' }, { label: '//src:srcs', target: 'Filegroup' }] }))",
    "else if (args[0] === 'query') console.log(JSON.stringify({ targets: [{ label: '//src:lint', target: 'Shell.Test', kinds: ['lint'] }, { label: '//src:srcs', target: 'Filegroup', kinds: [] }] }))",
    "else console.log(JSON.stringify({ targets: [{ label: '//src:lint', mode: 'execute', cacheable: true, key: 'abc', argv: ['eslint'] }] }))"
  ].join("\n"))
  server = await startLocalServer({ port: 0, distDir: root, chatStub: true, node: { path: process.execPath, version: "v22.19.0" }, buildCli: cli, log: () => {} })
})

afterAll(async () => {
  server.stop()
  await rm(root, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

describe("POST /api/targets/graph", () => {
  test("returns the typed graph and optional plan", async () => {
    const opened = await post("/api/repo/open", { path: repo })
    const repoId = ((await opened.json()) as { repo: { id: string } }).repo.id
    const response = await post("/api/targets/graph", { repoId, plan: true, labels: ["//src:lint"] })
    expect(response.status).toBe(200)
    const graph = TargetGraphResponseSchema.parse(await response.json())
    expect(graph.nodes).toHaveLength(2)
    expect(graph.edges).toEqual([{ from: "//src:lint", to: "//src:srcs", kind: "data" }])
    expect(graph.nodes[0]?.plan).toMatchObject({ mode: "execute", key: "abc" })
    expect((await post("/api/targets/graph", { repoId: "missing" })).status).toBe(404)
  })
})
