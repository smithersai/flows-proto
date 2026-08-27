/**
 * Route construction for providers that serve an OpenAI protocol without its
 * native extensions. The shape is deliberately narrower than
 * {@link OpenAIResponses}: only what every compatible deployment implements.
 *
 * @since 0.1.0
 */
import * as Result from "effect/Result"
import * as Auth from "./Auth.ts"
import * as Endpoint from "./Endpoint.ts"
import * as Framing from "./Framing.ts"
import type { ModelError } from "./ModelError.ts"
import * as OpenAIChatCompletions from "./OpenAIChatCompletions.ts"
import * as OpenAIResponses from "./OpenAIResponses.ts"
import * as Route from "./Route.ts"

/**
 * The OpenAI wire protocols a compatible deployment can serve, each mapped to
 * the route type it produces.
 *
 * `chat-completions` is what compatible providers actually implement: Google's
 * OpenAI-compatible endpoint, Moonshot, Cerebras, Fireworks, Groq, and Ollama
 * all serve `/v1/chat/completions`, and none of them serve `/v1/responses`.
 * `responses` stays available for the deployments that do serve it, such as
 * OpenRouter.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Routes {
  readonly "chat-completions": Route.Route<
    OpenAIChatCompletions.Body,
    string,
    Parameters<typeof OpenAIChatCompletions.protocol.stream.step>[1],
    OpenAIChatCompletions.State
  >
  readonly "responses": Route.Route<
    OpenAIResponses.Body,
    string,
    Parameters<typeof OpenAIResponses.protocol.stream.step>[1],
    OpenAIResponses.State
  >
}

/**
 * Which OpenAI wire protocol a compatible deployment serves.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type ProtocolName = keyof Routes

const defaultPath: Readonly<Record<ProtocolName, string>> = {
  "chat-completions": "/v1/chat/completions",
  "responses": "/v1/responses"
}

/**
 * Builds an OpenAI-compatible route without enabling OpenAI-native
 * deferred-tool extensions.
 *
 * `baseUrl` is the origin the deployment serves its OpenAI surface from.
 * `protocol` selects the wire contract and defaults to `chat-completions`, and
 * `path` overrides that protocol's default request path for a deployment that
 * mounts it elsewhere.
 *
 * ```ts
 * const gemini = OpenAICompatible.make({
 *   id: "gemini",
 *   baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
 *   apiKey
 * })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = <P extends ProtocolName = "chat-completions">(input: {
  readonly id: string
  readonly baseUrl: string
  readonly apiKey: Auth.Redacted<string>
  readonly protocol?: P
  readonly path?: string
  readonly headers?: Readonly<Record<string, string>>
}): Result.Result<Routes[P], ModelError> => {
  const name: ProtocolName = input.protocol ?? "chat-completions"
  return Result.map(
    Endpoint.make({ url: input.baseUrl, path: input.path ?? defaultPath[name] }),
    (endpoint) => {
      const deployment = {
        id: input.id,
        endpoint,
        auth: Auth.bearer(input.apiKey),
        framing: Framing.sse,
        ...(input.headers === undefined ? {} : { headers: input.headers })
      }
      // The runtime branch and the type branch are the same branch. A
      // `Protocol` is invariant in its body, event, and state parameters, so
      // the two routes have no common type to return unnarrowed.
      return (name === "responses"
        ? Route.make({
          ...deployment,
          protocol: { ...OpenAIResponses.protocol, supportsDeferred: () => false }
        })
        : Route.make({ ...deployment, protocol: OpenAIChatCompletions.protocol })) as Routes[P]
    }
  )
}
