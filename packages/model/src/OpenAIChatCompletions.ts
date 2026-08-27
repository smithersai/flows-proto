/**
 * OpenAI Chat Completions request lowering and SSE chunk handling.
 *
 * This is the surface most OpenAI-compatible deployments actually serve.
 * Google's `generativelanguage.googleapis.com/v1beta/openai`, Moonshot,
 * Cerebras, Fireworks, Groq, and Ollama all implement
 * `POST /v1/chat/completions` and none of them implement `/v1/responses`, so
 * this protocol is what a compatible route needs to reach them.
 *
 * The encoded body stays on the portable subset: `max_tokens` rather than
 * `max_completion_tokens`, one string per message rather than a content-part
 * array, and no deferred-tool extension. Every field here was confirmed
 * against the live Gemini deployment on 2026-08-26.
 *
 * @since 0.1.0
 */
import { Effect, Option, Result, Schema } from "effect"
import { isContextOverflow, ModelError, type ModelErrorCode } from "./ModelError.ts"
import { ModelEvent, type Usage } from "./ModelEvent.ts"
import {
  JsonObject,
  type Message,
  type ModelRequest,
  ReasoningEffort,
  type StopReason,
  type ToolDefinition
} from "./ModelRequest.ts"
import { make as makeProtocol, type Protocol } from "./Protocol.ts"
import * as ToolStream from "./ToolStream.ts"

const ID = "openai-chat-completions"

// =============================================================================
// Request Body Schema
// =============================================================================

const FunctionTool = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    parameters: JsonObject
  })
})

const WireToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String
  })
})

const ChatMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
  Schema.Struct({ role: Schema.Literal("user"), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.optional(Schema.String),
    tool_calls: Schema.optional(Schema.Array(WireToolCall))
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    tool_call_id: Schema.String,
    content: Schema.String
  })
])

/**
 * JSON schema for a `POST /v1/chat/completions` body.
 *
 * `max_tokens` is deprecated on api.openai.com in favour of
 * `max_completion_tokens`, and is still the only budget field the compatible
 * deployments accept, so it is what this encoder sends.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Body = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(ChatMessage),
  tools: Schema.optional(Schema.Array(FunctionTool)),
  max_tokens: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  top_p: Schema.optional(Schema.Finite),
  stop: Schema.optional(Schema.Array(Schema.String)),
  reasoning_effort: Schema.optional(ReasoningEffort),
  stream: Schema.Literal(true),
  // Without this, api.openai.com reports no token counts at all on a streamed
  // call. Gemini reports them either way and ignores the field.
  stream_options: Schema.Struct({ include_usage: Schema.Literal(true) })
})

/**
 * The decoded form of the Chat Completions request body.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Body = typeof Body.Type

type WireMessage = typeof ChatMessage.Type
type WireToolCall = typeof WireToolCall.Type
type FunctionTool = typeof FunctionTool.Type

// =============================================================================
// Streaming Chunk Schema
// =============================================================================

const ToolCallChunk = Schema.Struct({
  index: Schema.optional(Schema.NullOr(Schema.Number)),
  id: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.optional(Schema.NullOr(Schema.String)),
  function: Schema.optional(Schema.NullOr(Schema.Struct({
    name: Schema.optional(Schema.NullOr(Schema.String)),
    arguments: Schema.optional(Schema.NullOr(Schema.String))
  })))
})

const Delta = Schema.Struct({
  role: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  // `reasoning_content` is DeepSeek's spelling, adopted by Moonshot and
  // Fireworks; `reasoning` is OpenRouter's. Neither is signed, so neither can
  // be replayed, and both are surfaced as unsigned thinking parts.
  reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
  reasoning: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.NullOr(Schema.Array(ToolCallChunk)))
})

const Choice = Schema.Struct({
  index: Schema.optional(Schema.NullOr(Schema.Number)),
  delta: Schema.optional(Schema.NullOr(Delta)),
  finish_reason: Schema.optional(Schema.NullOr(Schema.String))
})

const ChunkUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  completion_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  total_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  prompt_tokens_details: Schema.optional(Schema.NullOr(Schema.Struct({
    cached_tokens: Schema.optional(Schema.NullOr(Schema.Number))
  }))),
  completion_tokens_details: Schema.optional(Schema.NullOr(Schema.Struct({
    reasoning_tokens: Schema.optional(Schema.NullOr(Schema.Number))
  })))
})

const ProviderError = Schema.Struct({
  message: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  code: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number])))
})

const Chunk = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  object: Schema.optional(Schema.NullOr(Schema.String)),
  choices: Schema.optional(Schema.NullOr(Schema.Array(Choice))),
  usage: Schema.optional(Schema.NullOr(ChunkUsage)),
  // Groq and OpenRouter report a mid-stream failure as an ordinary SSE data
  // frame carrying an error envelope instead of closing the connection.
  error: Schema.optional(Schema.NullOr(ProviderError))
})

type Chunk = typeof Chunk.Type
type ChunkUsage = typeof ChunkUsage.Type
type ToolCallChunk = typeof ToolCallChunk.Type

// Google answers a failed request with `[{"error": {...}}]` rather than
// api.openai.com's `{"error": {...}}`, so the envelope is decoded as either.
const ErrorBody = Schema.Union([
  Schema.Struct({ error: Schema.optional(Schema.NullOr(ProviderError)) }),
  Schema.Array(Schema.Struct({ error: Schema.optional(Schema.NullOr(ProviderError)) }))
])

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))

// =============================================================================
// Parser State
// =============================================================================

/**
 * What the adapter carries between chunks of one Chat Completions stream: the
 * parts it has opened, the partially assembled tool calls, and the counters
 * and stop reason it reports when the stream ends.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface State {
  readonly texts: ReadonlyArray<string>
  readonly thinking: ReadonlyArray<string>
  readonly tools: ToolStream.State
  /**
   * The tool call each `choice:tool_call` slot is currently filling. A
   * provider that omits `index` reuses one slot for every call it makes, so a
   * slot rebinds whenever a chunk names a different call id.
   */
  readonly slots: Readonly<Record<string, string>>
  readonly usage: Usage | undefined
  readonly stopReason: StopReason | undefined
  readonly sawToolCall: boolean
  readonly responseId: string | undefined
}

const initial = (): State => ({
  texts: [],
  thinking: [],
  tools: ToolStream.initial(),
  slots: {},
  usage: undefined,
  stopReason: undefined,
  sawToolCall: false,
  responseId: undefined
})

// =============================================================================
// Request Body Construction
// =============================================================================

const lowerTool = (tool: ToolDefinition): FunctionTool => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }
})

const textOf = (parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>): string =>
  parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("")

const lowerAssistant = (
  message: Extract<Message, { readonly role: "assistant" }>
): WireMessage | undefined => {
  // docs/specs/Research/Pi Reference Findings 2026-07-27.md §7: an interrupted
  // historical turn cannot be replayed as a completed one, so it is omitted
  // whole, exactly as the Responses and Messages encoders omit it.
  if (message.stopReason === "aborted" || message.stopReason === "error") return undefined
  const content = textOf(message.content)
  // Chat Completions has no field that replays a reasoning block, signed or
  // otherwise, so thinking parts are dropped rather than lowered.
  const toolCalls: Array<WireToolCall> = message.content
    .filter((part) => part.type === "tool-call")
    .map((part) => ({
      id: part.id,
      type: "function",
      function: { name: part.name, arguments: part.arguments }
    }))
  if (content === "" && toolCalls.length === 0) return undefined
  return {
    role: "assistant",
    ...(content === "" ? {} : { content }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls })
  }
}

const lowerMessages = (request: ModelRequest): ReadonlyArray<WireMessage> => {
  const messages: Array<WireMessage> = []
  const system = request.system.map((part) => part.text).join("\n")
  if (system !== "") messages.push({ role: "system", content: system })
  for (const message of request.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: textOf(message.content) })
      continue
    }
    if (message.role === "assistant") {
      const lowered = lowerAssistant(message)
      if (lowered !== undefined) messages.push(lowered)
      continue
    }
    for (const result of message.content) {
      messages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content })
    }
  }
  return messages
}

const buildBody = (request: ModelRequest): Body => {
  const params = request.params
  // `toolChoice: "none"` is expressed by sending no tools at all, the same way
  // the Responses and Messages encoders express it: no deployment accepts a
  // tool choice without tools.
  const tools = request.toolChoice === "none" ? [] : request.tools.map(lowerTool)
  return {
    model: request.modelId,
    messages: lowerMessages(request),
    ...(tools.length === 0 ? {} : { tools }),
    ...(params.maxTokens === undefined ? {} : { max_tokens: params.maxTokens }),
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.topP === undefined ? {} : { top_p: params.topP }),
    ...(params.stopSequences === undefined || params.stopSequences.length === 0
      ? {}
      : { stop: params.stopSequences }),
    ...(params.reasoningEffort === undefined ? {} : { reasoning_effort: params.reasoningEffort }),
    stream: true,
    stream_options: { include_usage: true }
  }
}

const fromRequest = Effect.fn("OpenAIChatCompletions.fromRequest")((
  request: ModelRequest
): Effect.Effect<Body, ModelError> => Effect.succeed(buildBody(request)))

// =============================================================================
// Stream Parsing
// =============================================================================

type StepResult = { readonly state: State; readonly events: ReadonlyArray<ModelEvent> }

const text = (value: string | null | undefined): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

const number = (value: number | null | undefined): number | undefined => typeof value === "number" ? value : undefined

const mapStopReason = (reason: string): StopReason => {
  if (reason === "stop" || reason === "end_turn") return "stop"
  if (reason === "length" || reason === "max_tokens") return "length"
  if (reason === "tool_calls" || reason === "function_call") return "tool-calls"
  if (reason === "content_filter") return "content-filter"
  return "unknown"
}

const mapUsage = (usage: ChunkUsage | null | undefined): Usage | undefined => {
  if (usage === null || usage === undefined) return undefined
  const inputTokens = number(usage.prompt_tokens)
  const outputTokens = number(usage.completion_tokens)
  const totalTokens = number(usage.total_tokens)
  const cachedInputTokens = number(usage.prompt_tokens_details?.cached_tokens)
  const reasoningTokens = number(usage.completion_tokens_details?.reasoning_tokens)
  const mapped: Usage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens })
  }
  // A `usage: {}` envelope reports nothing, and a usage event with no counters
  // is indistinguishable from counters of zero.
  return Object.keys(mapped).length === 0 ? undefined : mapped
}

const openPart = (
  open: ReadonlyArray<string>,
  id: string
): ReadonlyArray<string> => open.includes(id) ? open : [...open, id]

const onReasoning = (state: State, id: string, delta: string): StepResult => ({
  state: { ...state, thinking: openPart(state.thinking, id) },
  events: [
    ...(state.thinking.includes(id) ? [] : [ModelEvent.ThinkingStart({ type: "thinking-start", id })]),
    ModelEvent.ThinkingDelta({ type: "thinking-delta", id, text: delta })
  ]
})

const onContent = (state: State, id: string, delta: string): StepResult => ({
  state: { ...state, texts: openPart(state.texts, id) },
  events: [
    ...(state.texts.includes(id) ? [] : [ModelEvent.TextStart({ type: "text-start", id })]),
    ModelEvent.TextDelta({ type: "text-delta", id, text: delta })
  ]
})

const onToolCall = (
  state: State,
  slot: string,
  entry: ToolCallChunk
): Result.Result<StepResult, ModelError> => {
  const id = text(entry.id)
  const bound = state.slots[slot]
  // A fresh slot, or the same slot naming a different call: Gemini streams
  // parallel calls as separate chunks that all omit `index`, so the call id is
  // what separates them.
  const opening = bound === undefined || (id !== undefined && id !== bound)
  const events: Array<ModelEvent> = []
  let current = state
  let callId = bound
  if (opening) {
    const name = text(entry.function?.name)
    if (name === undefined) {
      return Result.fail(
        new ModelError({
          code: "invalid_provider_output",
          message: "OpenAI Chat Completions opened a tool call without a name"
        })
      )
    }
    // A provider that names a call but never identifies it still has to be
    // addressable, and the slot is the only stable handle the stream offers.
    callId = id ?? `${ID}-${slot}`
    current = {
      ...current,
      tools: ToolStream.start(current.tools, { callId, name }),
      slots: { ...current.slots, [slot]: callId },
      sawToolCall: true
    }
    events.push(ModelEvent.ToolCallStart({ type: "tool-call-start", id: callId, name }))
  }
  const fragment = text(entry.function?.arguments)
  if (callId !== undefined && fragment !== undefined) {
    current = { ...current, tools: ToolStream.delta(current.tools, callId, fragment) }
    events.push(ModelEvent.ToolCallDelta({ type: "tool-call-delta", id: callId, arguments: fragment }))
  }
  return Result.succeed({ state: current, events })
}

const closeParts = (state: State): StepResult => {
  const events: Array<ModelEvent> = [
    ...state.texts.map((id) => ModelEvent.TextEnd({ type: "text-end", id })),
    ...state.thinking.map((id) => ModelEvent.ThinkingEnd({ type: "thinking-end", id }))
  ]
  const flushed = ToolStream.flushAborted(state.tools)
  for (const call of flushed.completed) {
    events.push(ModelEvent.ToolCallEnd({ type: "tool-call-end", id: call.callId, arguments: call.arguments }))
  }
  return {
    state: { ...state, texts: [], thinking: [], tools: flushed.state, slots: {} },
    events
  }
}

const onChoice = (state: State, choice: typeof Choice.Type): Result.Result<StepResult, ModelError> =>
  Result.gen(function*() {
    const index = number(choice.index) ?? 0
    const delta = choice.delta
    const events: Array<ModelEvent> = []
    let current = state

    const reasoning = text(delta?.reasoning_content) ?? text(delta?.reasoning)
    if (reasoning !== undefined) {
      const step = onReasoning(current, `thinking-${index}`, reasoning)
      current = step.state
      events.push(...step.events)
    }
    const content = text(delta?.content)
    if (content !== undefined) {
      const step = onContent(current, `text-${index}`, content)
      current = step.state
      events.push(...step.events)
    }
    for (const [position, entry] of (delta?.tool_calls ?? []).entries()) {
      const step = yield* onToolCall(current, `${index}:${number(entry.index) ?? position}`, entry)
      current = step.state
      events.push(...step.events)
    }

    const finish = text(choice.finish_reason)
    if (finish !== undefined) {
      const closed = closeParts(current)
      const reason = mapStopReason(finish)
      current = {
        ...closed.state,
        // Gemini's compatible surface reports `stop` on a turn that is nothing
        // but function calls, so the calls themselves decide the reason.
        stopReason: reason === "stop" && current.sawToolCall ? "tool-calls" : reason
      }
      events.push(...closed.events)
    }
    return { state: current, events }
  })

const providerReason = (
  status: number | undefined,
  code: string | undefined,
  message: string
): ModelErrorCode => {
  const normalized = `${code ?? ""} ${message}`.toLowerCase()
  if (
    /insufficient[-_]?quota|quota[-_]?exceeded|billing[-_]?hard[-_]?limit|credit[-_]?balance/.test(normalized)
  ) return "quota_exceeded"
  // Google answers a rejected key with HTTP 400 and "Please pass a valid API
  // key", so the status alone does not separate authentication from a bad
  // request. A key that is wrong never repairs itself by being retried.
  if (
    status === 401 || status === 403 ||
    /authentication|unauthenticated|permission[-_]?denied|api[-_ ]?key/.test(normalized)
  ) return "authentication"
  if (status === 429 || /rate[-_]?limit|resource[-_]?exhausted|too many requests/.test(normalized)) {
    return "rate_limited"
  }
  // Providers spell the same refusal `content_filter`, `content-policy`, and
  // "content policy", so the separator is optional and may be a space.
  if (/content[-_\s]?policy|content[-_\s]?filter|safety/.test(normalized)) return "content_policy"
  // Overflow arrives as an ordinary bad request, so it has to be recognized
  // before the bad-request branch claims it.
  if (isContextOverflow(code, message)) return "context_overflow"
  if (
    status === 400 || status === 404 || status === 409 || status === 413 || status === 422 ||
    /invalid[-_]?request|invalid[-_]?argument|not[-_]?found/.test(normalized)
  ) return "invalid_request"
  if (
    (status !== undefined && status >= 500) ||
    /server[-_]?error|internal[-_]?error|unavailable|overloaded/.test(normalized)
  ) return "provider_internal"
  return "unknown"
}

const streamError = (error: typeof ProviderError.Type): ModelError => {
  const code = text(error.status) ?? text(error.type) ?? text(typeof error.code === "string" ? error.code : undefined)
  const message = text(error.message) ?? "OpenAI Chat Completions stream failed"
  return new ModelError({
    code: providerReason(undefined, code, message),
    message,
    ...(code === undefined ? {} : { providerCode: code })
  })
}

const stepChunk = (state: State, chunk: Chunk): Result.Result<StepResult, ModelError> =>
  Result.gen(function*() {
    if (chunk.error !== null && chunk.error !== undefined) return yield* Result.fail(streamError(chunk.error))
    const events: Array<ModelEvent> = []
    let current: State = {
      ...state,
      usage: mapUsage(chunk.usage) ?? state.usage,
      responseId: text(chunk.id) ?? state.responseId
    }
    for (const choice of chunk.choices ?? []) {
      const step = yield* onChoice(current, choice)
      current = step.state
      events.push(...step.events)
    }
    return { state: current, events }
  })

const step = Effect.fn("OpenAIChatCompletions.step")((
  state: State,
  chunk: Chunk
): Effect.Effect<readonly [State, ReadonlyArray<ModelEvent>], ModelError> =>
  Effect.map(Effect.fromResult(stepChunk(state, chunk)), (result) => [result.state, result.events] as const)
)

/**
 * Chat Completions has no terminal frame inside the JSON stream: `[DONE]` is a
 * framing sentinel this layer discards, and api.openai.com reports usage in a
 * chunk that arrives *after* the one carrying `finish_reason`. Settlement is
 * therefore the end of the stream rather than any one chunk. A stream that
 * ends without a `finish_reason` was interrupted, and emits no settle event at
 * all, which is how the other protocols report the same thing.
 */
const finalize = (state: State): ReadonlyArray<ModelEvent> => {
  const closed = closeParts(state)
  return [
    ...closed.events,
    ...(state.usage === undefined ? [] : [ModelEvent.Usage(state.usage)]),
    ...(state.stopReason === undefined
      ? []
      : [
        ModelEvent.Settle({
          type: "settle",
          stopReason: state.stopReason,
          ...(state.responseId === undefined ? {} : { responseId: state.responseId })
        })
      ])
  ]
}

const classifyError = (status: number, body: string): ModelError => {
  const decoded = decodeErrorBody(body)
  const envelope = Option.isSome(decoded)
    ? (Array.isArray(decoded.value) ? decoded.value[0] : decoded.value)
    : undefined
  const error = envelope?.error
  const code = text(error?.status) ?? text(error?.type) ??
    text(typeof error?.code === "string" ? error.code : undefined)
  const message = text(error?.message) ?? `OpenAI Chat Completions request failed with HTTP ${status}`
  return new ModelError({
    code: providerReason(status, code, message),
    message,
    httpStatus: status,
    ...(code === undefined ? {} : { providerCode: code })
  })
}

// =============================================================================
// Protocol Value
// =============================================================================

/**
 * The OpenAI Chat Completions protocol.
 *
 * Deferred tool loading has no representation on this surface, so every
 * declared tool is sent immediately.
 *
 * @category protocols
 * @since 0.1.0
 * @slop
 */
export const protocol: Protocol<Body, string, Chunk, State> = makeProtocol({
  id: ID,
  supportsDeferred: () => false,
  body: {
    schema: Body,
    from: fromRequest
  },
  stream: {
    event: Schema.fromJsonString(Chunk),
    initial,
    step,
    onHalt: finalize
  },
  classifyError
})
