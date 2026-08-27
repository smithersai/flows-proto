import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { RepoPluginCardBody } from "./RepoPluginCard"
import { TargetsCardBody } from "./TargetCards"

/*
 * The repo-plugin card and the multi-workspace targets card (LOCAL-APP.md
 * "Cards" / "Plugin manifest"): the plugin card renders the manifest's
 * title, summary, group sections and entries with workspace/approval/
 * agentic/kind badges, and every Run dispatches the existing target.run
 * flow with { repoId, workspace, label }. The targets card groups workspace
 * then package and offers the same Run per row.
 */

GlobalRegistrator.register()

afterAll(async () => {
  // React's scheduler drains unmount work on a macrotask that reads `window`,
  // so the globals have to outlive the last teardown by a tick or two.
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const manifest = {
  schemaVersion: 1 as const,
  name: "aomi",
  title: "Aomi",
  summary: "Cross-repo workflows.",
  groups: [
    { id: "checks", title: "Checks", kind: "check" as const },
    { id: "recipes", title: "Recipes", kind: "recipe" as const }
  ],
  entries: [
    {
      id: "check",
      group: "checks",
      workspace: ".",
      label: "//:check",
      title: "Check everything",
      summary: "One gate.",
      approval: false,
      agentic: false
    },
    {
      id: "clippy-fix",
      group: "recipes",
      workspace: "aomi-sdk",
      label: "//:clippyFix",
      title: "Clippy fix",
      summary: "Make clippy green.",
      approval: true,
      agentic: true
    }
  ]
}

const pluginCard = (): Extract<Card, { kind: "repo-plugin" }> => ({
  id: "repo-plugin-r1",
  kind: "repo-plugin",
  title: "Aomi",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repoId: "r1", manifest }
})

const targetsCard = (): Extract<Card, { kind: "targets" }> => ({
  id: "targets-r1",
  kind: "targets",
  title: "aomi targets",
  status: "acted",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repoId: "r1",
    repoName: "aomi",
    status: "done",
    warnings: [],
    targets: [
      { label: "//:check", target: "Shell.Test", kinds: ["test"], package: "//", name: "check", workspace: "." },
      { label: "//:clippyFix", target: "Shell.Test", kinds: ["lint"], package: "//", name: "clippyFix", workspace: "aomi-sdk" }
    ]
  }
})

const render = (node: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(node)
  })
  return host
}

describe("the repo-plugin card", () => {
  test("renders the manifest summary, group sections and entries with the four badges", () => {
    const host = render(<RepoPluginCardBody card={pluginCard()} onRunCommand={() => {}} />)
    expect(host.textContent).toContain("Cross-repo workflows.")
    const checks = host.querySelector("[data-group=\"checks\"]")
    expect(checks?.textContent).toContain("Checks")
    expect(checks?.textContent).toContain("Check everything")
    const entry = host.querySelector("[data-plugin-entry=\"clippy-fix\"]")
    expect(entry?.textContent).toContain("Make clippy green.")
    expect(entry?.querySelector("[data-badge=\"workspace\"]")?.textContent).toContain("aomi-sdk")
    expect(entry?.querySelector("[data-badge=\"kind\"]")?.textContent).toContain("recipe")
    expect(entry?.querySelector("[data-badge=\"approval\"]")).not.toBeNull()
    expect(entry?.querySelector("[data-badge=\"agentic\"]")).not.toBeNull()
  })

  test("Run dispatches target.run with the repo id, workspace and label", () => {
    const ran: Array<string> = []
    const host = render(
      <RepoPluginCardBody card={pluginCard()} onRunCommand={(name, args) => ran.push(`${name} ${args ?? ""}`)} />
    )
    const button = host.querySelector("[data-testid=\"plugin-run-clippy-fix\"]") as HTMLElement | null
    expect(button).not.toBeNull()
    button?.click()
    expect(ran).toEqual(["target.run r1 aomi-sdk //:clippyFix"])
  })
})

describe("the targets card", () => {
  test("groups workspace then package and runs a row with its workspace", () => {
    const ran: Array<string> = []
    const host = render(<TargetsCardBody card={targetsCard()} onRunCommand={(name, args) => ran.push(`${name} ${args ?? ""}`)} />)
    expect(host.querySelector("[data-workspace=\".\"]")).not.toBeNull()
    const sdk = host.querySelector("[data-workspace=\"aomi-sdk\"]")
    expect(sdk?.querySelector("[data-package=\"//\"]")).not.toBeNull()
    expect(sdk?.textContent).toContain("//:clippyFix")
    const button = sdk?.querySelector("[data-testid=\"targets-run-//:clippyFix\"]") as HTMLElement | null
    expect(button).not.toBeNull()
    button?.click()
    expect(ran).toEqual(["target.run r1 aomi-sdk //:clippyFix"])
  })
})
