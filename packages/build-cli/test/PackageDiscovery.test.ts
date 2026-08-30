import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"

const temporaryDirectories: Array<string> = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, ...relative.split("/"))
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const workspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-discovery-")))
  temporaryDirectories.push(root)
  await write(root, "WORKSPACE.ts", "export const Workspace = {}\n")
  await write(root, "PACKAGE.ts", "export const Package = {}\n")
  await write(root, "packages/app/PACKAGE.ts", "export const Package = {}\n")
  return root
}

describe("submodule boundaries", () => {
  it("never walks a path the root .gitmodules names, whatever it contains", async () => {
    const root = await workspace()
    await write(
      root,
      ".gitmodules",
      [
        "[submodule \"vendor/flows\"]",
        "\tpath = vendor/flows",
        "\turl = https://example.invalid/flows.git",
        "[submodule \"vendor/zevm\"]",
        "\tpath = ./vendor/zevm/",
        "\turl = https://example.invalid/zevm.git",
        ""
      ].join("\n")
    )
    // A vendored repository carries its own graph: a root declaration that
    // would otherwise be an undeclared nested workspace, and PACKAGE.ts files
    // that would otherwise join this workspace's inventory.
    await write(root, "vendor/flows/WORKSPACE.ts", "export const Workspace = {}\n")
    await write(root, "vendor/flows/PACKAGE.ts", "export const Package = {}\n")
    await write(root, "vendor/flows/fixtures/nested/PACKAGE.ts", "export const Package = {}\n")
    await write(root, "vendor/zevm/PACKAGE.ts", "export const Package = {}\n")
    // An uninitialized submodule is an empty directory; it prunes the same.
    await Fs.mkdir(NodePath.join(root, "vendor", "empty"), { recursive: true })
    const discovery = await PackageDiscovery.discover(root)
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts", "packages/app/PACKAGE.ts"])
  })

  it("still reports an undeclared nested workspace outside every submodule path", async () => {
    const root = await workspace()
    await write(
      root,
      ".gitmodules",
      "[submodule \"vendor/dep\"]\n\tpath = vendor/dep\n\turl = https://example.invalid/dep.git\n"
    )
    await write(root, "packages/other/WORKSPACE.ts", "export const Workspace = {}\n")
    await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({ code: "nested_workspace_undeclared" })
  })

  it("walks everything when the root has no .gitmodules", async () => {
    const root = await workspace()
    await write(root, "vendor/dep/PACKAGE.ts", "export const Package = {}\n")
    const discovery = await PackageDiscovery.discover(root)
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts", "packages/app/PACKAGE.ts", "vendor/dep/PACKAGE.ts"])
  })
})
