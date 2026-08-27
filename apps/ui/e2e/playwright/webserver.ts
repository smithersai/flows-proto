/*
 * The Playwright T1 web server: builds the SPA into dist/ (skip with
 * SMITHERS_SKIP_SPA_BUILD=1 when dist/ is already fresh), then runs
 * src/bun/serve.ts in this process so Playwright's shutdown kills the origin.
 */
import { fileURLToPath } from "node:url"

const UI_DIR = fileURLToPath(new URL("../../", import.meta.url))

if (process.env.SMITHERS_SKIP_SPA_BUILD !== "1") {
  console.log("[webserver] vite build")
  const build = Bun.spawn(["pnpm", "exec", "vite", "build", "--configLoader", "runner"], {
    cwd: UI_DIR,
    stdout: "inherit",
    stderr: "inherit"
  })
  const code = await build.exited
  if (code !== 0) {
    console.error(`[webserver] vite build exited ${code}`)
    process.exit(code)
  }
}

await import("../../src/bun/serve.ts")
