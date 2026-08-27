import type { NodeSidecar } from "../Node"
import type { RepoStore } from "../Repos"
import { json, jsonError, readJson } from "../routes"
import type { LocalServer } from "../server"
import { queryTargetGraph } from "../TargetGraph"

export interface TargetGraphRoutesOptions {
  readonly repos: RepoStore
  readonly node: Promise<NodeSidecar | null>
  readonly cli?: string
}

const field = (body: unknown, name: string): unknown =>
  typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined

const stringField = (body: unknown, name: string): string | undefined => {
  const value = field(body, name)
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

export const registerTargetGraphRoutes = (
  server: Pick<LocalServer, "router">,
  options: TargetGraphRoutesOptions
): { readonly stop: () => void } => {
  server.router.add("POST", "/api/targets/graph", async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    if (repoId === undefined) return jsonError(400, "invalid_request", "Body must be { repoId, plan?, labels? }.")
    const repo = options.repos.get(repoId)
    if (repo === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    const rawLabels = field(parsed.body, "labels")
    if (rawLabels !== undefined && (!Array.isArray(rawLabels) || rawLabels.some((label) => typeof label !== "string"))) {
      return jsonError(400, "invalid_request", "labels must be an array of strings.")
    }
    const result = await queryTargetGraph({
      repoId,
      repo: repo.path,
      node: await options.node,
      plan: field(parsed.body, "plan") === true,
      ...(rawLabels === undefined ? {} : { labels: rawLabels as Array<string> }),
      ...(options.cli === undefined ? {} : { cli: options.cli })
    })
    return json(result)
  })

  return { stop: () => {} }
}
