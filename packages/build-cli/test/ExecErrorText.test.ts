import { describe, expect, it } from "vitest"
import { execErrorText } from "../src/PackageExec.ts"

const failed = (
  stdout: string,
  stderr: string
) => ({ _tag: "ExecError", argv: ["nx", "run-many"], exitCode: 1, stdout, stderr } as never)

describe("execErrorText", () => {
  it("keeps both streams when a runner summarizes on stderr and reports on stdout", () => {
    const text = execErrorText(failed("FAIL src/a.spec.ts > expected 1 to be 2\n", "Failed tasks:\n- @scope/a:test\n"))
    expect(text).toBe(
      "command failed (exit 1): nx run-many\nFailed tasks:\n- @scope/a:test\n--- stdout ---\nFAIL src/a.spec.ts > expected 1 to be 2"
    )
  })

  it("keeps the single non-empty stream as before", () => {
    expect(execErrorText(failed("", "boom\n"))).toBe("command failed (exit 1): nx run-many\nboom")
    expect(execErrorText(failed("out\n", ""))).toBe("command failed (exit 1): nx run-many\nout")
    expect(execErrorText(failed("", ""))).toBe("command failed (exit 1): nx run-many")
  })

  it("bounds each stream to its most recent lines", () => {
    const long = Array.from({ length: 6_000 }, (_, index) => `line ${index}`).join("\n")
    const text = execErrorText(failed(long, ""))
    expect(text).not.toContain("line 999\n")
    expect(text).toContain("line 1000\n")
    expect(text.endsWith("line 5999")).toBe(true)
  })
})
