import { describe, expect, test } from "bun:test"
import {
  harnessPolicy,
  loaderPolicy,
  renderProfile,
  SANDBOX_EXEC,
  sandboxEnforced,
  terminalPolicy,
  wrapSandbox
} from "./Sandbox"
import type { SandboxHost } from "./Sandbox"

const paths = { repo: "/work/force", home: "/Users/u", tmpdir: "/var/folders/xx/T" }

const host = (overrides: Partial<SandboxHost> = {}): SandboxHost & { readonly lines: Array<string> } => {
  const lines: Array<string> = []
  return { platform: "darwin", disabled: false, log: (line) => lines.push(line), lines, ...overrides }
}

describe("sandbox policies are data", () => {
  test("the loader denies the network and writes only .flows and scratch", () => {
    const policy = loaderPolicy(paths)
    expect(policy.network).toBe("deny")
    expect(policy.writableDirs).toEqual(["/work/force/.flows", "/var/folders/xx/T", "/private/tmp"])
    expect(policy.writableFiles).toEqual([])
  })

  test("a harness keeps the network and writes the repo, its config dirs and scratch", () => {
    const policy = harnessPolicy(paths)
    expect(policy.network).toBe("allow")
    expect(policy.writableDirs).toEqual([
      "/work/force",
      "/Users/u/.claude",
      "/Users/u/.codex",
      "/Users/u/.gemini",
      "/Users/u/.kimi",
      "/Users/u/.config",
      "/Users/u/.cache",
      "/Users/u/.local",
      "/var/folders/xx/T",
      "/private/tmp"
    ])
    expect(policy.writableFiles).toEqual(["/Users/u/.claude.json"])
  })

  test("a terminal is confined like a harness", () => {
    expect(terminalPolicy(paths)).toEqual({ ...harnessPolicy(paths), id: "terminal" })
  })
})

describe("the seatbelt profile", () => {
  test("starts with (version 1), denies writes, then re-allows the policy's paths", () => {
    const profile = renderProfile(loaderPolicy(paths))
    const lines = profile.trim().split("\n")
    expect(lines[0]).toBe("(version 1)")
    expect(lines).toContain("(allow default)")
    expect(lines).toContain("(deny network*)")
    expect(lines).toContain("(deny file-write*)")
    expect(lines).toContain("(allow file-write* (subpath \"/work/force/.flows\"))")
    expect(lines).toContain("(allow file-write* (subpath \"/private/tmp\"))")
    // Order matters: later rules win, so the deny precedes every allow.
    expect(lines.indexOf("(deny file-write*)")).toBeLessThan(
      lines.indexOf("(allow file-write* (subpath \"/work/force/.flows\"))")
    )
  })

  test("a network-allow policy emits no network rule and lists literal files", () => {
    const profile = renderProfile(harnessPolicy(paths))
    expect(profile).not.toContain("(deny network*)")
    expect(profile).toContain("(allow file-write* (literal \"/Users/u/.claude.json\"))")
  })

  test("quotes in paths are escaped", () => {
    const profile = renderProfile(loaderPolicy({ ...paths, repo: "/work/a\"b" }))
    expect(profile).toContain("(subpath \"/work/a\\\"b/.flows\")")
  })
})

describe("wrapSandbox", () => {
  test("on macOS wraps with sandbox-exec -p <profile>", () => {
    const h = host()
    const wrapped = wrapSandbox(["node", "cli.js", "query"], loaderPolicy(paths), h)
    expect(wrapped.enforced).toBe(true)
    expect(wrapped.argv.slice(0, 2)).toEqual([SANDBOX_EXEC, "-p"])
    expect(wrapped.argv[2]).toBe(renderProfile(loaderPolicy(paths)))
    expect(wrapped.argv.slice(3)).toEqual(["node", "cli.js", "query"])
    expect(h.lines).toEqual([])
    expect(sandboxEnforced(h)).toBe(true)
  })

  test("elsewhere returns argv unchanged with one log line", () => {
    const h = host({ platform: "linux" })
    const argv = ["bash"]
    const wrapped = wrapSandbox(argv, terminalPolicy(paths), h)
    expect(wrapped).toEqual({ argv, enforced: false })
    expect(h.lines).toEqual(["sandbox: unenforced on this platform"])
    expect(sandboxEnforced(h)).toBe(false)
  })

  test("SMITHERS_SANDBOX=off disables wrapping everywhere, logged", () => {
    const h = host({ disabled: true })
    const wrapped = wrapSandbox(["claude"], harnessPolicy(paths), h)
    expect(wrapped).toEqual({ argv: ["claude"], enforced: false })
    expect(h.lines).toEqual(["sandbox: disabled by SMITHERS_SANDBOX=off (harness)"])
    expect(sandboxEnforced(h)).toBe(false)
  })
})
