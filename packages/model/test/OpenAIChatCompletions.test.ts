/**
 * The Chat Completions protocol over recorded provider transcripts.
 *
 * The `fixtures/openai-chat/*.sse` files are verbatim streams from
 * `generativelanguage.googleapis.com/v1beta/openai/chat/completions` running
 * `gemini-3-flash-preview`, recorded on 2026-08-26. The only edit is that each
 * `thought_signature` value is replaced with `<signature>`: the signatures are
 * kilobytes of opaque provider state this protocol does not read, and leaving
 * them in would make the fixtures unreadable.
 *
 * Chunk shapes that Gemini does not produce — fragmented tool arguments keyed
 * by `index`, a trailing usage-only chunk, reasoning deltas, inline error
 * envelopes — are written inline, from the shapes api.openai.com, OpenRouter,
 * and Groq document.
 */
import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ModelError } from "../src/ModelError.ts"
import * as Events from "../src/ModelEvent.ts"
import * as Request from "../src/ModelRequest.ts"
import * as OpenAIChatCompletions from "../src/OpenAIChatCompletions.ts"

const streamRequest = Request.ModelRequest.make({
  modelId: "gemini-3-flash-preview",
  system: [],
  messages: [],
  tools: [],
  params: Request.GenerationParams.make()
})

// `Framing.sse` discards the `[DONE]` sentinel before protocol decoding, so a
// transcript replayed here discards it too.
const fixture = (name: string): ReadonlyArray<string> =>
  readFileSync(new URL(`./fixtures/openai-chat/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n\n")
    .flatMap((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
      return data === undefined || data === "" || data === "[DONE]" ? [] : [data]
    })

const step = (state: OpenAIChatCompletions.State, data: string) => {
  const chunk = Schema.decodeUnknownSync(OpenAIChatCompletions.protocol.stream.event)(data)
  return Effect.runSync(OpenAIChatCompletions.protocol.stream.step(state, chunk))
}

const replayData = (
  data: ReadonlyArray<string>,
  finalize = true
): ReadonlyArray<Events.ModelEvent> => {
  let state = OpenAIChatCompletions.protocol.stream.initial(streamRequest)
  const events: Array<Events.ModelEvent> = []
  for (const datum of data) {
    const [next, emitted] = step(state, datum)
    state = next
    events.push(...emitted)
  }
  if (finalize) events.push(...(OpenAIChatCompletions.protocol.stream.onHalt?.(state) ?? []))
  return events
}

const replay = (name: string): ReadonlyArray<Events.ModelEvent> => replayData(fixture(name))

const replayError = (data: ReadonlyArray<string>): ModelError => {
  let state = OpenAIChatCompletions.protocol.stream.initial(streamRequest)
  for (const datum of data.slice(0, -1)) {
    const [next] = step(state, datum)
    state = next
  }
  const chunk = Schema.decodeUnknownSync(OpenAIChatCompletions.protocol.stream.event)(data[data.length - 1] ?? "")
  return Effect.runSync(Effect.flip(OpenAIChatCompletions.protocol.stream.step(state, chunk)))
}

const chunk = (value: unknown): string => JSON.stringify(value)

const body = (modelRequest: Request.ModelRequest): OpenAIChatCompletions.Body =>
  Effect.runSync(OpenAIChatCompletions.protocol.body.from(modelRequest, { native: true }))

describe("OpenAIChatCompletions stream", () => {
  it("replays a recorded text completion and settles once", () => {
    expect(replay("text.sse")).toEqual([
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", text: "ok" },
      { type: "text-end", id: "text-0" },
      { type: "usage", inputTokens: 6, outputTokens: 1, totalTokens: 77 },
      { type: "settle", stopReason: "stop", responseId: "YLGPaoe0GcCm1MkPxerGiQg" }
    ])
  })

  it("replays a recorded tool call and settles on tool-calls despite a stop finish reason", () => {
    // Gemini's compatible surface reports `finish_reason: "stop"` on a turn
    // that is nothing but a function call; the call is what decides the reason.
    expect(replay("tool-call.sse")).toEqual([
      { type: "tool-call-start", id: "call_457349", name: "get_weather" },
      { type: "tool-call-delta", id: "call_457349", arguments: "{\"city\":\"Paris\"}" },
      { type: "tool-call-end", id: "call_457349", arguments: "{\"city\":\"Paris\"}" },
      { type: "usage", inputTokens: 54, outputTokens: 16, totalTokens: 128 },
      { type: "settle", stopReason: "tool-calls", responseId: "YbGPao_THuGw1MkPgpuuqAg" }
    ])
  })

  it("separates parallel tool calls that share a slot because the provider omits index", () => {
    expect(replay("parallel-tool-calls.sse")).toEqual([
      { type: "tool-call-start", id: "call_365409", name: "get_weather" },
      { type: "tool-call-delta", id: "call_365409", arguments: "{\"city\":\"Paris\"}" },
      { type: "tool-call-start", id: "call_365410", name: "get_weather" },
      { type: "tool-call-delta", id: "call_365410", arguments: "{\"city\":\"Tokyo\"}" },
      { type: "tool-call-end", id: "call_365409", arguments: "{\"city\":\"Paris\"}" },
      { type: "tool-call-end", id: "call_365410", arguments: "{\"city\":\"Tokyo\"}" },
      { type: "usage", inputTokens: 64, outputTokens: 32, totalTokens: 154 },
      { type: "settle", stopReason: "tool-calls", responseId: "YrGPavuGIbah9MoP5_XUmAg" }
    ])
  })

  it("assembles indexed argument fragments and reports usage from the trailing chunk", () => {
    expect(replayData([
      chunk({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
      }),
      chunk({
        id: "chatcmpl-1",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: "" } }]
          }
        }]
      }),
      chunk({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"query\":" } }] } }]
      }),
      chunk({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"flows\"}" } }] } }]
      }),
      chunk({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      // api.openai.com reports the counters after the finish reason, in a
      // chunk that carries no choices at all.
      chunk({
        id: "chatcmpl-1",
        choices: [],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 7,
          total_tokens: 27,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 3 }
        }
      })
    ])).toEqual([
      { type: "tool-call-start", id: "call_a", name: "lookup" },
      { type: "tool-call-delta", id: "call_a", arguments: "{\"query\":" },
      { type: "tool-call-delta", id: "call_a", arguments: "\"flows\"}" },
      { type: "tool-call-end", id: "call_a", arguments: "{\"query\":\"flows\"}" },
      {
        type: "usage",
        inputTokens: 20,
        outputTokens: 7,
        reasoningTokens: 3,
        cachedInputTokens: 4,
        totalTokens: 27
      },
      { type: "settle", stopReason: "tool-calls", responseId: "chatcmpl-1" }
    ])
  })

  it("surfaces both reasoning spellings as unsigned thinking parts", () => {
    expect(replayData([
      chunk({ id: "r1", choices: [{ index: 0, delta: { reasoning_content: "counting" } }] }),
      chunk({ id: "r1", choices: [{ index: 0, delta: { reasoning: " twice" } }] }),
      chunk({ id: "r1", choices: [{ index: 0, delta: { content: "two" }, finish_reason: "stop" }] })
    ])).toEqual([
      { type: "thinking-start", id: "thinking-0" },
      { type: "thinking-delta", id: "thinking-0", text: "counting" },
      { type: "thinking-delta", id: "thinking-0", text: " twice" },
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", text: "two" },
      { type: "text-end", id: "text-0" },
      { type: "thinking-end", id: "thinking-0" },
      { type: "settle", stopReason: "stop", responseId: "r1" }
    ])
  })

  it("maps the remaining finish reasons and ignores empty content", () => {
    const settle = (finish: string | null) =>
      replayData([
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: finish }] })
      ])
    expect(settle("length")).toEqual([{ type: "settle", stopReason: "length" }])
    expect(settle("max_tokens")).toEqual([{ type: "settle", stopReason: "length" }])
    expect(settle("content_filter")).toEqual([{ type: "settle", stopReason: "content-filter" }])
    expect(settle("end_turn")).toEqual([{ type: "settle", stopReason: "stop" }])
    expect(settle("function_call")).toEqual([{ type: "settle", stopReason: "tool-calls" }])
    expect(settle("something_new")).toEqual([{ type: "settle", stopReason: "unknown" }])
    // No finish reason yet, and nothing was opened, so nothing is reported.
    expect(settle(null)).toEqual([])
  })

  it("closes open parts without settling when the stream is interrupted", () => {
    expect(replayData([
      chunk({ id: "cut", choices: [{ index: 0, delta: { content: "half" } }], usage: { prompt_tokens: 3 } }),
      chunk({
        id: "cut",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_cut", function: { name: "run", arguments: "{\"a\":" } }] }
        }]
      })
    ])).toEqual([
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", text: "half" },
      { type: "tool-call-start", id: "call_cut", name: "run" },
      { type: "tool-call-delta", id: "call_cut", arguments: "{\"a\":" },
      { type: "text-end", id: "text-0" },
      // Partial argument text is settled as `{}` so the turn stays resumable.
      { type: "tool-call-end", id: "call_cut", arguments: "{}" },
      { type: "usage", inputTokens: 3 }
      // No settle event: an interrupted stream folds to an aborted message.
    ])
  })

  it("keeps a second choice on its own part ids", () => {
    expect(replayData([
      chunk({
        id: "multi",
        choices: [
          { index: 0, delta: { content: "first" } },
          { index: 1, delta: { content: "second" }, finish_reason: "stop" }
        ]
      })
    ], false)).toEqual([
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", text: "first" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "second" },
      { type: "text-end", id: "text-0" },
      { type: "text-end", id: "text-1" }
    ])
  })

  it("addresses a named tool call the provider never identified", () => {
    expect(replayData([
      chunk({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ function: { name: "ping", arguments: "{}" } }] },
          finish_reason: "tool_calls"
        }]
      })
    ])).toEqual([
      { type: "tool-call-start", id: "openai-chat-completions-0:0", name: "ping" },
      { type: "tool-call-delta", id: "openai-chat-completions-0:0", arguments: "{}" },
      { type: "tool-call-end", id: "openai-chat-completions-0:0", arguments: "{}" },
      { type: "settle", stopReason: "tool-calls" }
    ])
  })

  it("rejects a tool call opened without a name", () => {
    expect(replayError([
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] })
    ])).toMatchObject({
      code: "invalid_provider_output",
      message: "OpenAI Chat Completions opened a tool call without a name"
    })
  })

  it("fails on an inline error envelope", () => {
    expect(replayError([
      chunk({ error: { message: "upstream is overloaded", type: "server_error" } })
    ])).toMatchObject({
      code: "provider_internal",
      message: "upstream is overloaded",
      providerCode: "server_error"
    })
    expect(replayError([chunk({ error: {} })])).toMatchObject({
      code: "unknown",
      message: "OpenAI Chat Completions stream failed"
    })
  })

  it("declares its identity and refuses deferred tool loading", () => {
    expect(OpenAIChatCompletions.protocol.id).toBe("openai-chat-completions")
    expect(OpenAIChatCompletions.protocol.supportsDeferred("gpt-5.4")).toBe(false)
  })
})

describe("OpenAIChatCompletions body", () => {
  it("lowers a full transcript onto the portable chat surface", () => {
    expect(body(Request.ModelRequest.make({
      modelId: "gemini-3-flash-preview",
      system: [Request.SystemPart.make({ text: "Be exact." }), Request.SystemPart.make({ text: "Be terse." })],
      messages: [
        Request.Message.user("What is the weather in Paris?"),
        Request.Message.assistant([
          Request.ThinkingPart.make({ text: "unsigned reasoning", signature: "sig" }),
          Request.TextPart.make({ text: "Checking." }),
          Request.ToolCallPart.make({ id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" })
        ], { stopReason: "tool-calls" }),
        Request.Message.tool(
          Request.ToolResultPart.make({ toolCallId: "call_1", content: "18C and sunny" })
        )
      ],
      tools: [
        Request.ToolDefinition.make({
          name: "get_weather",
          description: "Get weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        })
      ],
      params: Request.GenerationParams.make({
        maxTokens: 256,
        temperature: 0,
        topP: 1,
        stopSequences: ["STOP"],
        reasoningEffort: "low"
      })
    }))).toEqual({
      model: "gemini-3-flash-preview",
      messages: [
        // The system parts join with a newline; a cache breakpoint between them
        // has no representation on this surface.
        { role: "system", content: "Be exact.\nBe terse." },
        { role: "user", content: "What is the weather in Paris?" },
        // The thinking part is dropped: no field on this surface replays one.
        {
          role: "assistant",
          content: "Checking.",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" }
          }]
        },
        { role: "tool", tool_call_id: "call_1", content: "18C and sunny" }
      ],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        }
      }],
      max_tokens: 256,
      temperature: 0,
      top_p: 1,
      stop: ["STOP"],
      reasoning_effort: "low",
      stream: true,
      stream_options: { include_usage: true }
    })
  })

  it("omits every optional field a request leaves unset", () => {
    expect(body(Request.ModelRequest.make({
      modelId: "kimi-k2",
      system: [],
      messages: [Request.Message.user("hello")],
      tools: [],
      params: Request.GenerationParams.make({ stopSequences: [] })
    }))).toEqual({
      model: "kimi-k2",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true }
    })
  })

  it("expresses a `none` tool choice by sending no tools", () => {
    const declared = {
      modelId: "kimi-k2",
      system: [],
      messages: [Request.Message.user("hello")],
      tools: [Request.ToolDefinition.make({ name: "run", description: "run it", parameters: {} })],
      params: Request.GenerationParams.make()
    }
    expect(body(Request.ModelRequest.make(declared)).tools).toHaveLength(1)
    expect(body(Request.ModelRequest.make({ ...declared, toolChoice: "none" })).tools).toBeUndefined()
  })

  it("omits assistant turns that cannot be replayed as completed ones", () => {
    const messages = (stopReason: Request.StopReason) =>
      body(Request.ModelRequest.make({
        modelId: "kimi-k2",
        system: [],
        messages: [
          Request.Message.user("go"),
          Request.Message.assistant("partial", { stopReason }),
          // An assistant turn that carried only reasoning has nothing left to
          // send once the reasoning is dropped.
          Request.Message.assistant([Request.ThinkingPart.make({ text: "just thinking" })], {
            stopReason: "stop"
          })
        ],
        tools: [],
        params: Request.GenerationParams.make()
      })).messages

    expect(messages("aborted")).toEqual([{ role: "user", content: "go" }])
    expect(messages("error")).toEqual([{ role: "user", content: "go" }])
    expect(messages("stop")).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "partial" }
    ])
  })
})

describe("OpenAIChatCompletions error classification", () => {
  const classify = (status: number, value: unknown): ModelError =>
    OpenAIChatCompletions.protocol.classifyError(status, JSON.stringify(value))

  it("reads Google's array envelope and treats a rejected key as authentication", () => {
    // Google answers a bad key with HTTP 400, not 401, so the message is what
    // separates a wrong credential from a wrong request.
    expect(
      classify(400, [{ error: { code: 400, message: "Please pass a valid API key", status: "INVALID_ARGUMENT" } }])
    )
      .toMatchObject({
        code: "authentication",
        message: "Please pass a valid API key",
        providerCode: "INVALID_ARGUMENT",
        httpStatus: 400
      })
    expect(classify(400, [{ error: { code: 400, message: "Please pass a valid API key" } }]).retryable).toBe(false)
  })

  it("classifies the rest of the provider vocabulary", () => {
    expect(classify(404, [{ error: { message: "model not found", status: "NOT_FOUND" } }]).code)
      .toBe("invalid_request")
    expect(classify(429, { error: { message: "Rate limit reached", type: "rate_limit_error" } }).code)
      .toBe("rate_limited")
    expect(classify(429, { error: { message: "billing", code: "insufficient_quota" } }).code)
      .toBe("quota_exceeded")
    expect(classify(400, { error: { message: "This model's maximum context length is 128000 tokens" } }).code)
      .toBe("context_overflow")
    expect(classify(400, { error: { message: "blocked by the content policy" } }).code)
      .toBe("content_policy")
    expect(classify(503, { error: { message: "service unavailable" } }).code)
      .toBe("provider_internal")
    expect(classify(418, { error: { message: "teapot" } }).code).toBe("unknown")
  })

  it("falls back to the status when the body is not an error envelope", () => {
    expect(OpenAIChatCompletions.protocol.classifyError(500, "<html>gateway</html>")).toMatchObject({
      code: "provider_internal",
      message: "OpenAI Chat Completions request failed with HTTP 500",
      httpStatus: 500
    })
    expect(classify(400, {}).message).toBe("OpenAI Chat Completions request failed with HTTP 400")
  })
})
