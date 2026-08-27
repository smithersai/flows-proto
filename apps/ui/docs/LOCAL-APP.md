# Smithers Local App: contracts

Status: binding for every `local-app/*` lane. Owner: will (2026-08-26).
This document fixes the seams between lanes so they can build in parallel.
Read `apps/ui/AGENTS.md` first; its laws still apply. Where this document
names a user-visible surface, will asked for it on 2026-08-26, so NO INVENTION
is satisfied.

## Goal

A local-first Smithers desktop app in `apps/ui`, Electrobun only:

1. Launches as an Electrobun app. The web build path is removed.
2. Usable immediately: chat with the free gpt-oss endpoint, no login, no key.
   Login stays available as an option.
3. Opens a local repository from disk.
4. When the repository declares Smithers targets, the app loads every target
   at once (via the `smthrs` CLI, not a workflow) and Smithers answers with a
   message plus an interactive HTML panel for those targets.
5. Detects locally installed agent harnesses and signed-in accounts
   (Claude Code, Codex, Gemini, Kimi, ...).
6. Tab strip in the upper-left corner. One permanent main tab. New tabs open a
   terminal, a detected harness, or a maximizable card.
7. Every spawned process runs under the sandbox policy below.
8. Playwright tests prove each item end to end.

Demo repository: `/Users/williamcory/artsy/force`.

## Runtime topology

```
Electrobun 2.0.1 (build.mainProcess: "bun", Bun 1.4.0)
  src/bun/index.ts      window bootstrap (Electrobun SDK imports live only here)
  src/bun/server.ts     startLocalServer(opts): Bun.serve on 127.0.0.1 (no Electrobun imports)
  src/bun/serve.ts      CLI entry: starts the server without a window (tests)
  src/bun/Sandbox.ts    wrapSandbox(argv, policy) (see Sandbox)
  src/bun/Node.ts       findNode(): Node >= 22.19 sidecar probe
  src/bun/Harnesses.ts  detectHarnesses()
  src/bun/Pty.ts        PTY sessions (Bun.spawn({ terminal }))
  src/bun/Targets.ts    smthrs query / run through the Node sidecar
  src/bun/CloudAgent.ts existing: gpt-oss over https://chat.smithers.sh/chat
  src/mainview/**       React SPA (Vite build -> dist/)
```

- The window loads `http://127.0.0.1:<port>/`, never `views://` and never a
  Vite dev server. The origin is the only transport between the SPA and the
  main process. Electrobun RPC is used only for `pickLocalRepository` (native
  folder dialog) and `openExternal`; both have HTTP fallbacks so the SPA runs
  unchanged in Playwright chromium.
- Port: `SMITHERS_LOCAL_PORT` (default `0` = random). The server prints one
  line `SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:<port>` on stdout when ready.
- `SMITHERS_LOCAL_HEADLESS=1` (or running `serve.ts`) starts the server without
  a window.
- Chat calls `chat.smithers.sh` with `origin: https://canary.smithers.sh`,
  which the endpoint accepts anonymously (verified 2026-08-26 with curl). The
  in-page chain path over `/api/model/stream` is gated by login and is not
  used by the local app.
- `SMITHERS_CHAT_STUB=1` replaces CloudAgent with a deterministic local stub
  (echoes the last user message, and for the targets prompt returns a valid
  `{message, html}`) so the suite runs offline and in CI.
- Identity: the local origin forwards `/api/auth/*` and `/api/identity/*` to
  `https://canary.smithers.sh` (Origin rewritten, `Domain=` stripped from
  `Set-Cookie`) so the Sign in button's device flow reaches a real seam;
  with the stub on, `/api/auth/session` answers `{ status: "signed-out" }`
  locally and the rest 501. Identity never gates the chat: the signed-out
  refusal in `turns.ts`, the signed-out opening message, the sign-in pill
  and the gated composer placeholder are gone; sign-in is the
  `chrome-sign-in` button in the corner chrome.
- The chain runtime (`createChainRuntime`) is not bound in the local app;
  `createAgentSeat(createLocalAgent())` is the whole seat.
- Electrobun 2.x: the SDK lives in `.hutch/devkit` (projected by
  `electrobun prepare`, implicitly by `dev`/`build`); `tsconfig.json`
  extends its `tsconfig.json`, `vite.config.ts` uses `electrobunViteAliases`,
  `hutch.config.ts` selects pnpm. `.hutch/` and `.cottontail-tmp/` are
  ignored. `scripts/ensure-devkit.mjs` projects the devkit when it is missing
  or its version differs from the installed `electrobun`: it runs as
  `postinstall` (soft: warns without failing `pnpm install`) and ahead of
  `typecheck`, `check`, `start`, `build`, `build:canary`, the T1 web server
  and the T2 launcher, so `pnpm install && pnpm --filter smithers-ui typecheck`
  works in a fresh clone. The first projection on a machine downloads Hutch
  and the Electrobun release into `~/.hutch` (network required); `pnpm run
  devkit` runs it by hand.

## HTTP and WebSocket API

All bodies and responses are JSON unless noted. Errors:
`{ "error": { "code": string, "message": string } }` with a 4xx/5xx status.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/api/health` | | `{ ok, version, pid, node: { path, version } \| null, sandbox: { platform, enforced } }` |
| POST | `/api/chat/turn` | `StartAgentTurnRequest` (`apps/shared/src/NativeAgent.ts`) | NDJSON stream of `AgentTurnFrame` |
| POST | `/api/chat/cancel` | `{ runId }` | `{ ok }` |
| GET | `/api/harnesses` | | `{ harnesses: Harness[] }` |
| POST | `/api/repo/open` | `{ path }` | `{ repo: Repo }` |
| GET | `/api/repos` | | `{ repos: Repo[] }` |
| POST | `/api/repo/close` | `{ repoId }` | `{ ok }` |
| POST | `/api/targets/query` | `{ repoId }` | `{ targets: Target[], warnings: string[], durationMs }` |
| POST | `/api/targets/run` | `{ repoId, label }` | `{ runId }` then frames on WS topic `target-run:<runId>` |
| POST | `/api/targets/cancel` | `{ runId }` | `{ ok }` |
| POST | `/api/pty` | `{ kind: "terminal" \| "harness", cwd, cols, rows, harnessId? }` | `{ sessionId }` |
| POST | `/api/pty/:id/resize` | `{ cols, rows }` | `{ ok }` |
| DELETE | `/api/pty/:id` | | `{ ok }` |
| GET | `/api/pty` | | `{ sessions: PtySession[] }` |
| POST | `/api/open-external` | `{ url }` | `{ ok }` (fallback for the RPC) |

Types:

```ts
type Harness = {
  id: "claude" | "codex" | "gemini" | "kimi" | "opencode" | "crush" | "amp" | "cursor-agent" | "hermes" | "pi"
  displayName: string            // "Claude Code", "Codex", ...
  binary: string | null          // absolute path
  version: string | null
  status: "signed-in" | "api-key" | "binary-only" | "unavailable"
  account: { email?: string; label?: string } | null
  launch: { argv: string[] }     // interactive command for a harness tab
}

type Repo = {
  id: string                     // stable hash of path
  path: string
  name: string                   // basename, or "owner/name" from the git remote
  git: { branch: string | null; remote: string | null } | null
  smithers: {
    detected: boolean
    workspaceFile: string | null // ".smithers/WORKSPACE.ts" | "WORKSPACE.ts"
    declarationFiles: string[]   // relative paths of files that import smthrs
    reason: string               // human-readable detection verdict
  }
}

type Target = {
  label: string                  // "//src:lint"
  target: string                 // "Shell.Test", "Agent.Lint", ...
  kinds: string[]                // "build" | "test" | "lint" | "run" | "docs"
  package: string                // "//src"
  name: string                   // "lint"
}

type PtySession = { sessionId: string; kind: "terminal" | "harness"; harnessId?: string; cwd: string; pid: number; alive: boolean }
```

WebSocket `/ws` (JSON text frames):

```
client -> server
  { type: "subscribe",   topic: string }          // "pty:<sessionId>" | "target-run:<runId>"
  { type: "unsubscribe", topic: string }
  { type: "pty.input",   sessionId, data: string } // UTF-8 text typed by the user
server -> client
  { type: "pty.output",  sessionId, data: string } // UTF-8 chunk
  { type: "pty.exit",    sessionId, code: number | null }
  { type: "target-run",  runId, frame: { type: "stdout" | "stderr", data } | { type: "exit", code } | { type: "error", message } }
```

## Repository detection

A directory is a Smithers workspace when both hold:

1. `WORKSPACE.ts` or `.smithers/WORKSPACE.ts` exists at the root.
2. At least one of `WORKSPACE.ts`, `.smithers/WORKSPACE.ts`, `BUILD.ts`, or any
   `PACKAGE.ts` (walk skipping `node_modules`, `.git`, `.flows`, `dist`,
   `build`) contains `from "@smthrs/` or `from "smthrs` (single or double
   quotes).

`declarationFiles` lists every matching file. `reason` explains a negative
verdict ("no WORKSPACE.ts", "WORKSPACE.ts does not import smthrs").

## Targets: load and run

- Loader = the existing CLI `packages/build-cli/src/main.js`, resolved from
  the flows checkout relative to `apps/ui` (`SMITHERS_BUILD_CLI` overrides).
- Query: `node <cli> query '//...' --format json` with `cwd` = repo root. The
  output `targets[]` maps 1:1 onto `Target` (split `label` into `package` and
  `name`). Loader errors become `warnings[]` and an empty list, never a 500.
- Run: `node <cli> '<label>'` with `cwd` = repo root, streamed to the WS topic.
- Node sidecar: `findNode()` returns the first Node >= 22.19.0 among
  `SMITHERS_NODE`, `PATH`, `~/.nvm/versions/node/*/bin/node` (highest version),
  `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `~/.volta/bin/node`,
  `~/.local/share/fnm/**/bin/node`. Finder launches get the launchd PATH, so
  the probe cannot rely on `PATH` alone. `/api/health` reports the choice.

## Auto-load flow (after `/api/repo/open` with `smithers.detected = true`)

1. The SPA dispatches a `targets` card (pending) and calls `/api/targets/query`.
2. The card fills with the target list.
3. The SPA calls `/api/chat/turn` with a system instruction that includes the
   target JSON and the bridge contract below, and asks for a final answer of
   exactly `{ "message": string, "html": string }` (no tools).
4. The reply is parsed. If it is not valid JSON with a non-empty `html`, the
   SPA renders the built-in `renderTargetsPanel(targets)` template instead
   and keeps the model's text (or a default sentence) as the message.
5. The SPA appends the message bubble and an `html` card.

HTML bridge (inside the iframe): `window.parent.postMessage({ smithers: "run", label }, "*")`
and `{ smithers: "open", label }`. The card listens, dispatches
`/api/targets/run`, and appends a `target-run` card. The iframe is
`<iframe sandbox="allow-scripts" srcdoc=...>`, never same-origin.

Ruling: this overrides `apps/DESIGN.md` section 14 ("no generative HTML in
v1"); will asked for agent-authored HTML on 2026-08-26.

## Cards (`apps/shared/src/Cards.ts` additions)

```ts
{ kind: "targets",    repoId, repoName, status: "pending" | "done" | "failed", targets: Target[], warnings: string[] }
{ kind: "html",       title, html, source: "agent" | "template", repoId }
{ kind: "target-run", runId, repoId, label, status: "running" | "done" | "failed", exitCode: number | null, output: string }
{ kind: "repo",       repo: Repo }
```

Every card keeps the existing maximize affordance. Maximized cards gain
"Open in tab" (user-triggered, EMBED LAW compliant), which creates a `card`
tab that renders the same card component from the same store record.

## Tabs (`apps/ui/src/mainview/tabs/`)

```ts
type Tab =
  | { id: "main"; kind: "main"; title: "Smithers" }
  | { id: string; kind: "terminal"; title: string; sessionId: string; cwd: string }
  | { id: string; kind: "harness"; title: string; sessionId: string; harnessId: Harness["id"]; cwd: string }
  | { id: string; kind: "card"; title: string; cardId: string }
```

- Store: a TanStack DB collection `tabs` plus `activeTabId`; mutations go
  through the shared transition dispatcher.
- Strip sits in the upper-left of the chrome bar. Main tab first, not
  closable. Then tabs in creation order. Then the `+` button.
- `+` opens a menu: `Terminal`, then one row per harness with
  `status !== "unavailable"` showing `displayName` and `account.email` (or
  `label`), then disabled rows for unavailable harnesses with their status.
- cwd for new terminal and harness tabs = the active repo path, else `$HOME`.
- Every tab body stays mounted; inactive tabs are `hidden` (no unmount) so
  terminal scrollback survives switching.
- Closing a terminal or harness tab with a live process asks for
  confirmation, then `DELETE /api/pty/:id`. Closing a card tab keeps the card.
- Keyboard: Cmd+T new terminal, Cmd+W close active non-main tab,
  Cmd+1..9 select tab by position.
- Terminal component: `@xterm/xterm` + `@xterm/addon-fit`, attached to
  `pty:<sessionId>` over `/ws`.

`data-testid` contract (Playwright depends on these):

```
tab-strip, tab-main, tab-<tabId>, tab-close-<tabId>, tab-add, tab-add-menu,
tab-add-terminal, tab-add-harness-<harnessId>, tab-body-<tabId>,
terminal-<sessionId>, chrome-open-repo, chrome-sign-in, repo-chip,
composer-input, composer-send, transcript, card-<cardId>, card-kind-<kind>,
card-maximize-<cardId>, card-open-in-tab-<cardId>, html-card-frame-<cardId>
```

## Sandbox (`src/bun/Sandbox.ts`)

`wrapSandbox(argv: string[], policy: SandboxPolicy): { argv: string[]; enforced: boolean }`
on macOS wraps with `/usr/bin/sandbox-exec -p <profile>`; elsewhere returns
`argv` unchanged with `enforced: false` and one log line
`sandbox: unenforced on this platform`. `SMITHERS_SANDBOX=off` disables
wrapping everywhere (logged). Profiles are seatbelt `(version 1)` text.

| Spawn | Policy id | Network | File write |
| --- | --- | --- | --- |
| Target run (`smthrs <label>`) | handled by build-cli | deny (existing `wrapSandbox` in `PackageExec.ts`) | existing |
| Loader (`smthrs query`) | `loader` | deny | `<repo>/.flows`, `$TMPDIR`, `/private/tmp` |
| Harness tab | `harness` | allow | `<repo>`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.gemini`, `~/.kimi`, `~/.config`, `~/.cache`, `~/.local`, `$TMPDIR`, `/private/tmp` |
| Terminal tab | `terminal` | allow | `<repo>`, `$HOME` dotfiles above, `$TMPDIR`, `/private/tmp` |

Rationale: seatbelt cannot filter egress by hostname, and claude/codex need
the network and their config dirs, so harness and terminal spawns confine
file writes rather than the network. `wrapSandbox` reads only its arguments;
policies are data so tests can assert the generated profile.

## Harness detection (`src/bun/Harnesses.ts`)

Port the DETECTORS table from `~/smithers/apps/cli/src/agent-detection.js`
and the identity readers from `agent-commands/accountIdentity.js` into a
dependency-free Bun module. Binaries are probed at explicit candidates, not
only `PATH`: `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`,
`/usr/local/bin`, `~/.nvm/versions/node/*/bin`, `~/.cargo/bin`, then `PATH`.

| id | binary | signed-in signal | account |
| --- | --- | --- | --- |
| claude | `claude` | `~/.claude.json` `.oauthAccount` present, or `~/.claude/.credentials.json` | `oauthAccount.emailAddress`, `organizationName` |
| codex | `codex` | `~/.codex/auth.json` with `tokens.id_token` or `OPENAI_API_KEY` | email claim of the `id_token` JWT |
| gemini | `gemini` | `~/.gemini/oauth_creds.json` | `~/.gemini/google_accounts.json` `.active` |
| kimi | `kimi` | `~/.kimi/credentials/kimi-code.json` | label `kimi-code` |
| opencode | `opencode` | `~/.local/share/opencode/auth.json` non-empty | provider ids |
| crush, amp, cursor-agent, hermes, pi | binary | env key or config file | label |

`launch.argv` is the interactive command (`["claude"]`, `["codex"]`, ...).
Never append `--dangerously-skip-permissions` or `--yolo`.

## Test tiers

- Unit: `bun test src` (existing) plus new tests for `Sandbox.ts`, `Node.ts`,
  `server.ts`, `Harnesses.ts`, repo detection, target JSON mapping.
- T1 (gates every milestone): `@playwright/test` in
  `apps/ui/e2e/playwright/*.spec.ts`, `apps/ui/playwright.config.ts`,
  `webServer` = `bun e2e/playwright/webserver.ts` (a `vite build`, skipped
  with `SMITHERS_SKIP_SPA_BUILD=1`, then `src/bun/serve.ts`) with
  `SMITHERS_LOCAL_PORT=47311`, `SMITHERS_CHAT_STUB=1` by default
  (`SMITHERS_CHAT_STUB=0` hits the real endpoint and enables
  `chat.real.spec.ts`), chromium headless. Script:
  `pnpm --filter smithers-ui test:e2e`.
- T2 (smoke on the real window): `apps/ui/e2e/playwright/native/*.native.spec.ts`,
  script `test:e2e:native` (`e2e/playwright/native/run.ts`): `vite build`,
  `electrobun build --env=dev` (`bundleCEF: true`, `defaultRenderer: "cef"`
  on mac), then launches `build/dev-macos-<arch>/Smithers-dev.app/Contents/MacOS/launcher`
  directly with `ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT=9333`,
  `SMITHERS_LOCAL_PORT=47313`, `SMITHERS_CHAT_STUB=1`, waits for
  `/api/health` and `http://127.0.0.1:9333/json/version`, and runs
  `playwright.native.config.ts` with `SMITHERS_NATIVE_CDP` /
  `SMITHERS_NATIVE_ORIGIN` in the env; the spec attaches with
  `chromium.connectOverCDP`, asserts the page URL is the local origin, the
  title, and `composer-input`. Verified 2026-08-26 on macOS arm64: the CEF
  archive downloads on the first build (cached under `~/.hutch`), the dev
  build logs `[CEF] Remote debugging enabled on 127.0.0.1:9333`, and the
  spec passes. `SMITHERS_SKIP_NATIVE_BUILD=1` reuses `build/` and `dist/`.
  Without `SMITHERS_NATIVE_CDP` the spec skips with the reason, so a bare
  `playwright test --config playwright.native.config.ts` never fails for
  lack of a window. The old `e2e/native/native-launch.ts` fallback is
  removed; `e2e/native/MainProcess.ts` (driven by `src/bun/Main.test.ts`)
  still asserts the main process without a window.
- Specs by milestone: M0 `boot.spec.ts`, `chat.spec.ts`; M1
  `repo-targets.spec.ts`; M2 `tabs.spec.ts`, `terminal.spec.ts`,
  `harness.spec.ts`.

## Branches and worktrees

- Integration branch `local-app/base` at `/Users/williamcory/flows-local-app/base`.
- Lane branches `local-app/<lane>` at `/Users/williamcory/flows-local-app/<lane>`.
- `pnpm install` in each worktree (global store, fast). Never run `pnpm install`
  in `/Users/williamcory/flows/flows` from a lane.
- Lanes commit on their branch only. Commit messages: gitmoji + conventional
  scope, matching the repo history.
- Milestones merge `local-app/base` into the branch checked out in
  `/Users/williamcory/flows/flows` for will's manual test.

## Lanes

| Lane | Branch | Scope | Acceptance |
| --- | --- | --- | --- |
| L0 Foundation | `local-app/foundation` | Electrobun 2.0.1 upgrade (`mainProcess: "bun"`), `server.ts`/`serve.ts`, `/api/health`, `/api/chat/*`, `/ws` skeleton, `Sandbox.ts`, `Node.ts`, remove web scripts and TanStack Start config, Playwright T1 harness with `boot.spec.ts` and `chat.spec.ts`, T2 CDP spike | `pnpm --filter smithers-ui start` opens the app and chat answers with no login; `test:e2e` green; `bun test src` green |
| L1 Targets API | `local-app/targets` | `packages/targets`: add `S.Fetch` and every other surface `/Users/williamcory/artsy/force` uses that flows lacks, so `smthrs query '//...' --format json` returns all targets on live force | vitest green; CLI on force returns >= 82 targets, zero refusals at load |
| L2 Tabs UI | `local-app/tabs-ui` | `tabs/` store and components, strip, `+` menu, terminal component over a mock WS, `card` tabs, keyboard, `data-testid` contract | `tabs.spec.ts` green against a mock `/api/harnesses` and mock `/ws` (Playwright route interception) |
| L3 Repo -> Targets -> HTML | `local-app/repo-targets` | `/api/repo/*`, detection, `Targets.ts`, `targets`/`html`/`target-run`/`repo` cards, auto-load flow, run streaming | `repo-targets.spec.ts`: open force, >= 82 targets, html card visible, run `//:detectSecrets` shows output |
| L4 Harness + Terminal | `local-app/harness-terminal` | `Harnesses.ts`, `/api/harnesses`, `Pty.ts`, `/api/pty*`, WS pty topics, wire L2's components to the real server | `terminal.spec.ts` (`echo hi` echoes), `harness.spec.ts` (menu lists Claude Code with the signed-in email; opening the tab shows the CLI prompt) |
