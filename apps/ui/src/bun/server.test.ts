import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isAgentTurnFrame } from "smithers-shared/NativeAgent"
import type { AgentTurnFrame } from "smithers-shared/NativeAgent"
import { TARGETS_PANEL_MARKER } from "./ChatStub"
import { defaultDistDir, startLocalServer } from "./server"
import type { LocalServer } from "./server"

let dist = ""
let server: LocalServer
const logs: Array<string> = []
const opened: Array<string> = []

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-dist-"))
  await mkdir(join(dist, "assets"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title><div id=\"root\"></div>")
  await writeFile(join(dist, "assets", "app.js"), "console.log('hi')")
  server = await startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    node: { path: "/fake/node", version: "v22.19.0" },
    log: (line) => logs.push(line),
    openExternal: async (url) => {
      opened.push(url)
      return true
    }
  })
})

afterAll(async () => {
  server.stop()
  await rm(dist, { recursive: true, force: true })
})

const readFrames = async (response: Response): Promise<Array<AgentTurnFrame>> => {
  const text = await response.text()
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const parsed: unknown = JSON.parse(line)
    if (!isAgentTurnFrame(parsed)) throw new Error(`not a frame: ${line}`)
    return parsed
  })
}

describe("the local origin", () => {
  test("prints SMITHERS_LOCAL_ORIGIN when listening and binds 127.0.0.1", () => {
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`)
    expect(logs).toContain(`SMITHERS_LOCAL_ORIGIN=${server.origin}`)
  })

  test("GET /api/health reports node and sandbox", async () => {
    const response = await fetch(`${server.origin}/api/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.pid).toBe(process.pid)
    expect(body.node).toEqual({ path: "/fake/node", version: "v22.19.0" })
    expect(body.sandbox).toEqual({
      platform: process.platform,
      enforced: process.platform === "darwin" && Bun.env.SMITHERS_SANDBOX !== "off"
    })
  })

  test("serves the SPA with an index.html fallback and hashed assets", async () => {
    const root = await fetch(`${server.origin}/`)
    expect(root.status).toBe(200)
    expect(await root.text()).toContain("<div id=\"root\">")
    const deep = await fetch(`${server.origin}/some/client/route`)
    expect(deep.status).toBe(200)
    expect(deep.headers.get("content-type")).toContain("text/html")
    const asset = await fetch(`${server.origin}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get("cache-control")).toContain("immutable")
    expect(await asset.text()).toBe("console.log('hi')")
  })

  test("refuses path traversal out of dist", async () => {
    const response = await fetch(`${server.origin}/assets/..%2F..%2F..%2Fetc%2Fpasswd`)
    // Either the fallback document or nothing: never a file outside dist.
    expect(await response.text()).not.toContain("root:")
  })

  test("unknown /api paths answer a JSON 404, method mismatches a 405", async () => {
    const missing = await fetch(`${server.origin}/api/nope`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "No route for GET /api/nope." } })
    const wrongMethod = await fetch(`${server.origin}/api/health`, { method: "POST" })
    expect(wrongMethod.status).toBe(405)
  })

  test("lane placeholders: harnesses and repos are empty lists, the rest 501", async () => {
    expect(await (await fetch(`${server.origin}/api/harnesses`)).json()).toEqual({ harnesses: [] })
    expect(await (await fetch(`${server.origin}/api/repos`)).json()).toEqual({ repos: [] })
    for (const [method, path] of [
      ["POST", "/api/repo/open"],
      ["POST", "/api/repo/close"],
      ["POST", "/api/targets/query"],
      ["POST", "/api/targets/run"],
      ["POST", "/api/targets/cancel"],
      ["GET", "/api/pty"],
      ["POST", "/api/pty"],
      ["POST", "/api/pty/abc/resize"],
      ["DELETE", "/api/pty/abc"]
    ] as const) {
      const response = await fetch(`${server.origin}${path}`, { method })
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 501 })
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe("not_implemented")
    }
  })

  test("a lane replaces a placeholder by registering the same route", async () => {
    server.router.add("GET", "/api/harnesses", () => Response.json({ harnesses: [{ id: "claude" }] }))
    expect(await (await fetch(`${server.origin}/api/harnesses`)).json()).toEqual({ harnesses: [{ id: "claude" }] })
    server.router.add("GET", "/api/harnesses", () => Response.json({ harnesses: [] }))
  })

  test("the stub identity seam answers signed-out and nothing else", async () => {
    const session = await fetch(`${server.origin}/api/auth/session`)
    expect(await session.json()).toEqual({ status: "signed-out" })
    expect((await fetch(`${server.origin}/api/auth/native/start`, { method: "POST" })).status).toBe(501)
  })
})

describe("POST /api/chat/turn", () => {
  test("streams the stub's frames as NDJSON and ends on done", async () => {
    const response = await fetch(`${server.origin}/api/chat/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-1",
        messages: [{ role: "user", content: "say ok" }],
        instructions: "Be brief."
      })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    expect(await readFrames(response)).toEqual([
      { runId: "run-1", type: "delta", kind: "reasoning", text: "stub: thinking" },
      { runId: "run-1", type: "delta", kind: "text", text: "stub: say ok" },
      { runId: "run-1", type: "done", reason: "stop" }
    ])
  })

  test("the targets marker yields valid { message, html } JSON", async () => {
    const response = await fetch(`${server.origin}/api/chat/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-2",
        messages: [{ role: "user", content: "load targets" }],
        instructions: `Answer as JSON. ${TARGETS_PANEL_MARKER}`
      })
    })
    const frames = await readFrames(response)
    const text = frames.find((frame) => frame.type === "delta" && frame.kind === "text")
    expect(text).toBeDefined()
    const parsed = JSON.parse(text !== undefined && text.type === "delta" ? text.text : "{}") as { message: string; html: string }
    expect(parsed.message.length).toBeGreaterThan(0)
    expect(parsed.html).toContain("data-testid=\"stub-panel\"")
  })

  test("a malformed body answers 400 with the error envelope", async () => {
    const response = await fetch(`${server.origin}/api/chat/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "", messages: "no" })
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_request")
  })

  test("cancel answers ok and closes a live stream", async () => {
    const response = await fetch(`${server.origin}/api/chat/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-3", messages: [{ role: "user", content: "x" }], instructions: "" })
    })
    const cancel = await fetch(`${server.origin}/api/chat/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-3" })
    })
    expect(cancel.status).toBe(200)
    expect(((await cancel.json()) as { ok: boolean }).ok).toBe(true)
    // The stream ends (possibly with no done frame) instead of hanging.
    const frames = await readFrames(response)
    expect(frames.every((frame) => frame.runId === "run-3")).toBe(true)
    const late = await fetch(`${server.origin}/api/chat/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-3" })
    })
    expect(await late.json()).toEqual({ ok: true, status: "not-found" })
  })
})

describe("POST /api/open-external", () => {
  test("opens http(s) only", async () => {
    const ok = await fetch(`${server.origin}/api/open-external`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://smithers.sh/sign-in" })
    })
    expect(await ok.json()).toEqual({ ok: true })
    expect(opened).toEqual(["https://smithers.sh/sign-in"])
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url", ""]) {
      const refused = await fetch(`${server.origin}/api/open-external`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url })
      })
      expect(refused.status).toBe(400)
    }
    expect(opened).toHaveLength(1)
  })
})

describe("/ws", () => {
  const connect = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(`${server.origin.replace("http", "ws")}/ws`)
      socket.onopen = () => resolve(socket)
      socket.onerror = () => reject(new Error("ws failed"))
    })

  const nextMessage = (socket: WebSocket): Promise<unknown> =>
    new Promise((resolve) => {
      socket.onmessage = (event) => resolve(JSON.parse(String(event.data)))
    })

  test("subscribe receives published frames; unsubscribe stops them", async () => {
    const socket = await connect()
    const ack = nextMessage(socket)
    socket.send(JSON.stringify({ type: "subscribe", topic: "pty:abc" }))
    expect(await ack).toEqual({ type: "subscribed", topic: "pty:abc" })
    const frame = nextMessage(socket)
    server.publish("pty:abc", { type: "pty.output", sessionId: "abc", data: "hi" })
    expect(await frame).toEqual({ type: "pty.output", sessionId: "abc", data: "hi" })
    const unack = nextMessage(socket)
    socket.send(JSON.stringify({ type: "unsubscribe", topic: "pty:abc" }))
    expect(await unack).toEqual({ type: "unsubscribed", topic: "pty:abc" })
    socket.close()
  })

  test("a registered message handler receives client frames by type", async () => {
    const received: Array<unknown> = []
    const off = server.onMessage("pty.input", (message, socket) => {
      received.push(message)
      socket.send(JSON.stringify({ type: "echo", data: message.data }))
    })
    const socket = await connect()
    const reply = nextMessage(socket)
    socket.send(JSON.stringify({ type: "pty.input", sessionId: "abc", data: "ls\n" }))
    expect(await reply).toEqual({ type: "echo", data: "ls\n" })
    expect(received).toEqual([{ type: "pty.input", sessionId: "abc", data: "ls\n" }])
    off()
    const error = nextMessage(socket)
    socket.send(JSON.stringify({ type: "pty.input", sessionId: "abc", data: "x" }))
    expect(await error).toEqual({ type: "error", message: "No handler for pty.input." })
    socket.close()
  })
})

describe("defaultDistDir", () => {
  test("SMITHERS_DIST_DIR wins, then the bundled views, then apps/ui/dist", async () => {
    expect(defaultDistDir("/x/bun", { SMITHERS_DIST_DIR: "/explicit" })).toBe("/explicit")
    const app = await mkdtemp(join(tmpdir(), "smithers-app-"))
    await mkdir(join(app, "views", "mainview"), { recursive: true })
    await writeFile(join(app, "views", "mainview", "index.html"), "<html>")
    expect(defaultDistDir(join(app, "bun"), {})).toBe(join(app, "views", "mainview"))
    expect(defaultDistDir("/nowhere/src/bun", {})).toBe("/nowhere/dist")
    await rm(app, { recursive: true, force: true })
  })
})
