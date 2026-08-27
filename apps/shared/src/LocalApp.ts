import { z } from "zod"

/*
 * The local-app wire model (apps/ui/docs/LOCAL-APP.md "HTTP and WebSocket
 * API"): the harness, repository, and PTY session records the local server
 * answers and the SPA stores. Runtime-free zod, like Cards.ts, so the Bun
 * server, the SPA, and the Playwright doubles validate the same shapes.
 */

export const HARNESS_IDS = [
  "claude",
  "codex",
  "gemini",
  "kimi",
  "opencode",
  "crush",
  "amp",
  "cursor-agent",
  "hermes",
  "pi"
] as const

export const HarnessSchema = z.object({
  id: z.enum(HARNESS_IDS),
  displayName: z.string(),
  binary: z.string().nullable(),
  version: z.string().nullable(),
  status: z.enum(["signed-in", "api-key", "binary-only", "unavailable"]),
  account: z.object({ email: z.string().optional(), label: z.string().optional() }).nullable(),
  launch: z.object({ argv: z.array(z.string()) })
})
export type Harness = z.infer<typeof HarnessSchema>

export const RepoSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  git: z.object({ branch: z.string().nullable(), remote: z.string().nullable() }).nullable(),
  smithers: z.object({
    detected: z.boolean(),
    workspaceFile: z.string().nullable(),
    declarationFiles: z.array(z.string()),
    reason: z.string()
  })
})
export type Repo = z.infer<typeof RepoSchema>

export const PtySessionSchema = z.object({
  sessionId: z.string(),
  kind: z.enum(["terminal", "harness"]),
  harnessId: z.enum(HARNESS_IDS).optional(),
  cwd: z.string(),
  pid: z.number(),
  alive: z.boolean()
})
export type PtySession = z.infer<typeof PtySessionSchema>

/** `GET /api/harnesses` */
export const HarnessesResponseSchema = z.object({ harnesses: z.array(HarnessSchema) })
/** `GET /api/repos` */
export const ReposResponseSchema = z.object({ repos: z.array(RepoSchema) })
/** `POST /api/pty` */
export const PtyCreateResponseSchema = z.object({ sessionId: z.string() })
