import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"

const temporaryDirectories: Array<string> = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const write = async (root: string, relative: string, text: string, mode = 0o644): Promise<void> => {
  const path = NodePath.join(root, ...relative.split("/"))
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, { encoding: "utf8", mode })
}

const workspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-script-interpreter-")))
  temporaryDirectories.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("scripts", {
  repository: "git+https://example.invalid/scripts.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [S.Rust.Toolchain({ channel: "1.91" })]
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const bashScript = S.Shell.Test({ script: S.file("//scripts/needs-bash.sh"), args: ["fast"] })
const plainScript = S.Shell.Test({ script: S.file("//scripts/plain.sh") })
export const Package = S.Package({ targets: { bashScript, plainScript } })
`
  )
  await write(root, "scripts/needs-bash.sh", "#!/usr/bin/env bash\nset -euo pipefail\n[[ -n \"$1\" ]]\n", 0o755)
  await write(root, "scripts/plain.sh", "echo plain\n", 0o755)
  return root
}

const plan = async (root: string, label: string): Promise<ReadonlyArray<string> | undefined> => {
  let output = ""
  await makeCli({}).serve([...normalizeArgv([label, "--plan", "--format", "json"]), "--workspace", root], {
    exit: () => undefined,
    stdout: (text) => {
      output += text
    }
  })
  const parsed = JSON.parse(output) as {
    readonly targets: ReadonlyArray<{ readonly label: string; readonly argv?: ReadonlyArray<string> }>
  }
  return parsed.targets.find((row) => row.label === label)?.argv
}

describe("declared shell scripts run under their shebang interpreter", () => {
  it("resolves `#!/usr/bin/env bash` to the bash on PATH", async () => {
    const root = await workspace()
    const argv = await plan(root, "//:bashScript")
    expect(argv?.[0]).toMatch(/\/bash$/)
    expect(argv?.slice(1)).toEqual(["scripts/needs-bash.sh", "fast"])
  })

  it("keeps a script without a shebang under /bin/sh", async () => {
    const root = await workspace()
    const argv = await plan(root, "//:plainScript")
    expect(argv).toEqual(["/bin/sh", "scripts/plain.sh"])
  })
})
