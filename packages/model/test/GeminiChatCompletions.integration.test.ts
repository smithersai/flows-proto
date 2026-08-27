/**
 * The Chat Completions protocol against a live provider.
 *
 * Google's OpenAI-compatible deployment is the reference implementation for
 * this protocol: it serves `/v1/chat/completions` and nothing else, so a route
 * that works here is a route that works for the rest of the compatible
 * providers. The recorded fixtures in `OpenAIChatCompletions.test.ts` come from
 * this same endpoint; this suite is what keeps them honest.
 *
 * It runs only when `GEMINI_API_KEY` is set, and never prints the key: the
 * credential is applied by `Auth` as the request leaves and does not enter the
 * prepared request.
 */
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { describe, expect, it } from "vitest"
import * as ModelEvent from "../src/ModelEvent.ts"
import * as ModelRequest from "../src/ModelRequest.ts"
import * as OpenAICompatible from "../src/OpenAICompatible.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const apiKey = process.env["GEMINI_API_KEY"]
const MODEL_ID = "gemini-3-flash-preview"

const executorLayer = Layer.provide(RequestExecutor.layer, FetchHttpClient.layer)

// Google mounts the compatible surface under `/v1beta/openai`, so the request
// path is `/chat/completions` rather than the protocol's `/v1/chat/completions`
// default.
const route = () =>
  OpenAICompatible.make({
    id: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    path: "/chat/completions",
    apiKey: Redacted.make(apiKey ?? "")
  })

const collect = (request: ModelRequest.ModelRequest): Promise<ReadonlyArray<ModelEvent.ModelEvent>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const model = yield* Route.toModel(yield* Effect.fromResult(route()))
      return yield* Stream.runCollect(model.stream(request))
    }).pipe(Effect.provide(executorLayer))
  )

describe.skipIf(apiKey === undefined || apiKey === "")("OpenAIChatCompletions over Gemini", () => {
  it("targets the compatible chat-completions path", () => {
    const configured = Result.getOrThrow(route())

    expect(configured.protocol.id).toBe("openai-chat-completions")
    expect(configured.endpoint.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")
  })

  it("streams a short completion", async () => {
    const events = await collect(ModelRequest.ModelRequest.make({
      modelId: MODEL_ID,
      system: [ModelRequest.SystemPart.make({ text: "Answer with one lowercase word and no punctuation." })],
      messages: [ModelRequest.Message.user("What colour is a clear midday sky? Answer with one word.")],
      tools: [],
      params: ModelRequest.GenerationParams.make({ maxTokens: 4096, temperature: 0 })
    }))

    const { message, usage } = ModelEvent.ModelEvent.settledMessage(events)
    expect(message.stopReason).toBe("stop")
    expect(message.content.some((part) => part.type === "text" && part.text.trim() !== "")).toBe(true)
    expect(usage.inputTokens).toBeGreaterThan(0)
    expect(usage.outputTokens).toBeGreaterThan(0)
    expect(events.filter((event) => event.type === "settle")).toHaveLength(1)
  })

  it("streams a tool call with reassembled arguments", async () => {
    const events = await collect(ModelRequest.ModelRequest.make({
      modelId: MODEL_ID,
      system: [],
      messages: [ModelRequest.Message.user("What is the weather in Paris? Use the tool.")],
      tools: [
        ModelRequest.ToolDefinition.make({
          name: "get_weather",
          description: "Get the current weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"]
          }
        })
      ],
      params: ModelRequest.GenerationParams.make({ maxTokens: 4096, temperature: 0 })
    }))

    const { message } = ModelEvent.ModelEvent.settledMessage(events)
    // Gemini reports `finish_reason: "stop"` on a function-call turn, so this
    // also pins the protocol's rule that a streamed call decides the reason.
    expect(message.stopReason).toBe("tool-calls")
    const call = message.content.find((part) => part.type === "tool-call")
    expect(call?.name).toBe("get_weather")
    expect(JSON.parse(call?.arguments ?? "{}")).toMatchObject({ city: "Paris" })
  })
})
