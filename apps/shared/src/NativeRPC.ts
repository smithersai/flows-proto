import type { ElectrobunRPCSchema } from "electrobun"
import type { PickLocalRepositoryResult, RepositoryAccess } from "./NativeRepository"

/*
 * The two native doors the local app keeps on Electrobun RPC (LOCAL-APP.md,
 * "Runtime topology"). Chat rides the local HTTP origin (/api/chat/*), so the
 * agent requests and the agentFrame message are gone; both doors here have
 * HTTP fallbacks so the SPA runs unchanged in Playwright chromium.
 */
export interface SmithersNativeRPC extends ElectrobunRPCSchema {
  readonly bun: {
    readonly requests: {
      readonly pickLocalRepository: {
        readonly params: { readonly access: RepositoryAccess }
        readonly response: PickLocalRepositoryResult
      }
      /**
       * Open a URL in the SYSTEM browser (never the webview). The native
       * sign-in handoff runs GitHub OAuth there because an embedded webview
       * has no platform authenticator; passkeys only work outside.
       */
      readonly openExternal: {
        readonly params: { readonly url: string }
        readonly response: { readonly opened: boolean }
      }
    }
    readonly messages: Record<never, never>
  }
  readonly webview: {
    readonly requests: Record<never, never>
    readonly messages: Record<never, never>
  }
}
