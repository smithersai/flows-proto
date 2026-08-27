/**
 * The engine journals a failed action's error as JSON, through the codec
 * `Schema.toCodecJson` derives from the action's declared error schema. A
 * harness failure whose `cause` is a live `Error` or a raw object carrying
 * non-JSON members has to survive that encode, because when it does not the
 * encode failure replaces the real error and the provider 429 or fetch failure
 * that actually happened never reaches the journal, the test output, or a
 * host's error frame.
 *
 * Every harness error that can reach the journal is pinned here against both
 * shapes.
 */
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { HarnessError } from "../src/HarnessError.ts"
import { SandboxError } from "../src/Sandbox.ts"
import { TranscriptError } from "../src/Transcript.ts"

/** The cause shapes an adapter hands the harness in practice. */
const causes = {
  error: () => new Error("provider returned 429"),
  raw: () => ({ status: 429, retryAfter: 30n, retry: () => undefined })
}

const roundTrip = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Effect.runSync(
    Effect.gen(function*() {
      const json = Schema.toCodecJson(schema)
      const encoded = yield* Schema.encodeEffect(json)(value)
      // The journal writes the encoded form, so anything that survives the
      // encode has to survive a real JSON serialization too.
      const decoded = yield* Schema.decodeEffect(json)(JSON.parse(JSON.stringify(encoded)))
      return { encoded, decoded }
    })
  )

describe("a harness failure carrying a non-JSON cause", () => {
  it("encodes and decodes with its code and message intact when the cause is an Error", () => {
    const { decoded, encoded } = roundTrip(
      HarnessError,
      new HarnessError({ code: "model_failed", message: "the model call failed", cause: causes.error() })
    )
    expect(decoded.code).toBe("model_failed")
    expect(decoded.message).toBe("the model call failed")
    expect(JSON.stringify(encoded)).toContain("provider returned 429")
  })

  it("encodes and decodes with its code and message intact when the cause holds a bigint and a function", () => {
    const { decoded, encoded } = roundTrip(
      HarnessError,
      new HarnessError({ code: "adapter_quota_exhausted", message: "the quota is spent", cause: causes.raw() })
    )
    expect(decoded.code).toBe("adapter_quota_exhausted")
    expect(decoded.message).toBe("the quota is spent")
    expect(JSON.stringify(encoded)).toContain("429")
  })

  it("keeps the cause value itself in process", () => {
    const cause = causes.error()
    const error = new HarnessError({ code: "model_failed", message: "the model call failed", cause })
    expect(error.cause).toBe(cause)
  })

  it("encodes a sandbox failure whose cause is an Error", () => {
    const { decoded } = roundTrip(
      SandboxError,
      new SandboxError({ code: "runtime_failed", message: "the realm died", cause: causes.error() })
    )
    expect(decoded.code).toBe("runtime_failed")
    expect(decoded.message).toBe("the realm died")
  })

  it("encodes a transcript failure whose cause holds a bigint and a function", () => {
    const { decoded } = roundTrip(
      TranscriptError,
      new TranscriptError({ code: "projection_failed", message: "the projection failed", cause: causes.raw() })
    )
    expect(decoded.code).toBe("projection_failed")
    expect(decoded.message).toBe("the projection failed")
  })
})
