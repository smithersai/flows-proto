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
  `chrome-sign-in` button in the chrome bar (`tabs/ChromeBar.tsx`), rendered
  only while the session is not signed in.
- The chain runtime (`createChainRuntime`) is not bound in the local app;
  `createAgentSeat(createLocalAgent())` is the whole seat.
- Electrobun 2.x: the SDK lives in `.hutch/devkit` (projected by
  `electrobun prepare`, implicitly by `dev`/`build`); `tsconfig.json`
  extends its `tsconfig.json`, `vite.config.ts` uses `electrobunViteAliases`,
  `hutch.config.ts` selects pnpm. `.hutch/` and `.cottontail-tmp/` are
  ignored. `scripts/ensure-devkit.mjs` projects the devkit when it is missing
  or its version differs from the installed `electrobun`: it runs as
  `postinstall` (soft: warns without failing `pnpm install`) and ahead of
  `typecheck`, `check`, `start`, `build`, the T1 web server and the T2
  launcher, so `pnpm install && pnpm --filter smithers-ui typecheck`
  works in a fresh clone. The first projection on a machine downloads Hutch
  and the Electrobun release into `~/.hutch` (network required); `pnpm run
  devkit` runs it by hand.

## HTTP and WebSocket API

All bodies and responses are JSON unless noted. Errors:
`{ "error": { "code": string, "message": string } }` with a 4xx/5xx status.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/api/health` | | `{ ok, version, pid, home: string, node: { path, version } \| null, sandbox: { platform, enforced } }` |
| POST | `/api/chat/turn` | `StartAgentTurnRequest` (`apps/shared/src/NativeAgent.ts`) | NDJSON stream of `AgentTurnFrame` |
| POST | `/api/chat/cancel` | `{ runId }` | `{ ok }` |
| GET | `/api/harnesses` | | `{ harnesses: Harness[] }` |
| POST | `/api/repo/open` | `{ path }` | `{ repo: Repo }` |
| GET | `/api/repos` | | `{ repos: Repo[] }` |
| POST | `/api/repo/close` | `{ repoId }` | `{ ok }` |
| POST | `/api/targets/query` | `{ repoId }` | `{ targets: Target[], warnings: string[], durationMs }` |
| POST | `/api/targets/run` | `{ repoId, label, workspace? }` (`workspace` defaults to `"."`, the root) | `{ runId }` then frames on WS topic `target-run:<runId>` |
| POST | `/api/targets/cancel` | `{ runId }` | `{ ok }` |
| POST | `/api/pty` | `{ kind: "terminal" \| "harness", cwd, cols, rows, harnessId? }` (`cwd: "~"` means `$HOME`; the server expands it) | `{ sessionId }` |
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
  warnings: string[]             // manifest problems at open; empty when clean
  plugin?: RepoPlugin            // parsed .smithers/UI.json; absent when none or invalid
  smithers: {
    detected: boolean            // iff workspaces is nonempty
    workspaceFile: string | null // the ROOT's ".smithers/WORKSPACE.ts" | "WORKSPACE.ts"
    declarationFiles: string[]   // relative paths of files that import smthrs
    reason: string               // human-readable detection verdict
    workspaces: { path: string; title: string }[] // "." first; path relative root, title last segment
  }
}

type Target = {
  label: string                  // "//src:lint"
  target: string                 // "Shell.Test", "Agent.Lint", ...
  kinds: string[]                // "build" | "test" | "lint" | "run" | "docs"
  package: string                // "//src"
  name: string                   // "lint"
  workspace: string              // the detected workspace the loader ran in ("." for root)
}

type PtySession = { sessionId: string; kind: "terminal" | "harness"; harnessId?: string; cwd: string; pid: number; alive: boolean }
```

WebSocket `/ws` (JSON text frames):

```
client -> server
  { type: "subscribe",   topic: string }          // "pty:<sessionId>" | "target-run:<runId>"
  { type: "unsubscribe", topic: string }
  { type: "pty.input",   sessionId, data: string } // UTF-8 text typed by the user
  { type: "target-run.attach", runId }             // a subscriber is listening: the child starts now (else after 1s)
server -> client
  { type: "pty.output",  sessionId, data: string } // UTF-8 chunk
  { type: "pty.exit",    sessionId, code: number | null }
  { type: "target-run",  runId, frame: { type: "stdout" | "stderr", data } | { type: "exit", code } | { type: "error", message } }
```

## Repository detection

A directory is a Smithers workspace when it contains `WORKSPACE.ts` or
`.smithers/WORKSPACE.ts`. `detectSmithers(root)` discovers the root and its
child workspaces up to two levels deep, skipping `node_modules`, `.git`,
`.flows`, `dist`, `build` and `target` (and `.smithers` itself, which is a
manifest dir, never a workspace). `workspaces` lists them root-first:
`path` relative to the root with `"."` for the root itself, `title` the
last path segment (the repo name for the root). `detected` holds iff the
list is nonempty.

`declarationFiles` stays informational: the root declaration files and every
`PACKAGE.ts` below the root (same walk, same skips) that contain
`from "@smthrs/` or `from "smthrs` (single or double quotes). It no longer
gates detection. `reason` explains a negative verdict ("no WORKSPACE.ts")
or counts the workspaces found.

## Plugin manifest

A repository may declare its first-class plugin surface in
`.smithers/UI.json` (read by `src/bun/RepoPlugin.ts`). The exact schema
(`RepoPluginSchema` in `apps/shared/src/LocalApp.ts`, strict at every level
— additional root, group or entry keys reject the file):

```ts
type RepoPlugin = {
  schemaVersion: 1
  name: string
  title: string
  summary: string
  groups: { id: string; title: string; kind: "recipe" | "lint" | "workflow" | "check" }[]
  entries: {
    id: string
    group: string              // must be one of groups[].id
    workspace: string          // must be one of the detected workspaces
    label: string              // "//pkg:name"
    title: string
    summary: string
    approval: boolean          // optional in the file, defaults to false
    agentic: boolean           // optional in the file, defaults to false
  }[]
}
```

An absent file is no plugin and no warning. Anything invalid — bad JSON,
a strict-shape failure, an undeclared group reference, a non-`//pkg:name`
label, or an entry naming an undetected workspace — becomes entries in
`Repo.warnings[]` with `plugin` undefined, never a 500. `POST
/api/repo/open` and `GET /api/repos` carry `Repo.plugin` when it parsed.

## Targets: load and run

- Loader = the existing CLI `packages/build-cli/src/main.js`, resolved from
  the flows checkout relative to `apps/ui` (`SMITHERS_BUILD_CLI` overrides).
- Query: `node <cli> query '//...' --format json` once per detected
  workspace, each with `cwd` = `join(repo, workspace.path)` and its own
  120s budget. Every row maps 1:1 onto `Target` (split `label` into
  `package` and `name`) tagged with its `workspace`. One workspace's loader
  error becomes a prefixed `warnings[]` entry and never blocks the others.
- Run: `node <cli> '<label>'` with `cwd` = `join(repo, workspace)`, streamed
  to the WS topic. `workspace` is validated against the detected set; an
  undeclared one is a 400 `{ code: "invalid_workspace" }` naming it.
- Node sidecar: `findNode()` returns the first Node >= 22.19.0 among
  `SMITHERS_NODE`, `PATH`, `~/.nvm/versions/node/*/bin/node` (highest version),
  `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `~/.volta/bin/node`,
  `~/.local/share/fnm/**/bin/node`. Finder launches get the launchd PATH, so
  the probe cannot rely on `PATH` alone. `/api/health` reports the choice.

## Auto-load flow (after `/api/repo/open` with `smithers.detected = true`)

1. When the repo carries a valid plugin manifest, the SPA upserts the
   `repo-plugin` card FIRST — ahead of the targets card — and the panel
   turn below is skipped entirely: the generative panel (and its template
   fallback) exists only absent a manifest.
2. The SPA dispatches a `targets` card (pending) and calls `/api/targets/query`.
3. The card fills with the target list, grouped workspace then package; every
   row's Run button dispatches `target.run` with `{ repoId, workspace, label }`.
4. Absent a manifest, the SPA calls `/api/chat/turn` with a system instruction
   that includes the target JSON and the bridge contract below, and asks for
   a final answer of exactly `{ "message": string, "html": string }` (no tools).
5. The reply is parsed. If it is not valid JSON with a non-empty `html`, the
   SPA renders the built-in `renderTargetsPanel(targets)` template instead
   and keeps the model's text (or a default sentence) as the message.
6. The SPA appends the message bubble and an `html` card.

HTML bridge (inside the iframe): `window.parent.postMessage({ smithers: "run", label }, "*")`
and `{ smithers: "open", label }`. The card listens, dispatches
`/api/targets/run`, and appends a `target-run` card. The iframe is
`<iframe sandbox="allow-scripts" srcdoc=...>`, never same-origin.

L3 implementation notes (2026-08-26): the prompt builder, its parser (the
stub reads the target list back out of the instructions), the reply parser
and `renderTargetsPanel` live in `apps/shared/src/TargetsPanel.ts`. The
window `message` listener is installed by the controller
(`state/controller/targets.ts`), matches `event.source` to the frame carrying
`data-html-card="<cardId>"`, and runs the hidden user-only flows
`target.run <repoId> <label>` / `target.open <repoId> <label>`; `open` sets
`targets.payload.highlighted` and scrolls the `[data-target-row]` into view.
The panel turn is a plain `POST /api/chat/turn` (no transcript turn, no
deadline). `SMITHERS_BUILD_CLI` overrides the loader path for the server
(`startLocalServer({ buildCli })` in tests).

Ruling: this overrides `apps/DESIGN.md` section 14 ("no generative HTML in
v1"); will asked for agent-authored HTML on 2026-08-26.

## Cards (`apps/shared/src/Cards.ts` additions)

```ts
{ kind: "targets",    repoId, repoName, status: "pending" | "done" | "failed", targets: Target[], warnings: string[], highlighted?: string }
{ kind: "html",       title, html, source: "agent" | "template", repoId }
{ kind: "target-run", runId, repoId, label, status: "running" | "done" | "failed", exitCode: number | null, output: string }
{ kind: "repo",       repo: Repo }
{ kind: "repo-plugin", repoId, manifest: RepoPlugin }
```

The `repo-plugin` card renders the manifest's title, summary, group
sections and entries with workspace / approval / agentic / kind badges
(`@smthrs/ui` `StatusPill`; `EmptyState` for a group without entries); each
entry's Run dispatches the existing `target.run` flow with
`{ repoId, workspace, label }`, and the run lands as a `target-run` card
like any other. `target.run` takes `<repoId> [workspace] <label>`; the
html panel's bridge keeps sending only `<repoId> <label>` and runs at the
root.

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
- cwd for new terminal and harness tabs = the active repo path, else `"~"`,
  which the server expands to `$HOME` (`/api/health` reports `home`).
- Every tab body stays mounted; inactive tabs are `hidden` (no unmount) so
  terminal scrollback survives switching.
- Closing a terminal or harness tab with a live process asks for
  confirmation, then `DELETE /api/pty/:id`. Closing a card tab keeps the card.
- Keyboard: Cmd+T new terminal, Cmd+W close active non-main tab,
  Cmd+1..9 select tab by position.
- Terminal component: `@smthrs/ui/adapters/terminal` (the shipped xterm
  adapter: `@xterm/xterm` + `@xterm/addon-fit`, which owns the mount and the
  fit addon), not a hand-rolled mount. `tabs/TerminalView.tsx` hands it the
  output stream, the keystrokes, and the geometry; it attaches to
  `pty:<sessionId>` over `/ws` through `state/PtyClient.ts`.

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
| Read-only probes (`git -C` repo facts, `<bin> --version`) | `probe` | deny | `$TMPDIR` (realpathed) + its `/private` twin, `/private/tmp` |

Rationale: seatbelt cannot filter egress by hostname, and claude/codex need
the network and their config dirs, so harness and terminal spawns confine
file writes rather than the network. `wrapSandbox` reads only its arguments;
policies are data so tests can assert the generated profile.

Probe ruling (wave-2 integration, 2026-08-26): the two read-only spawns the
verifiers flagged — the `git -C` branch/remote probe in `src/bun/Repos.ts`
and the `<bin> --version` probes in `src/bun/Harnesses.ts` — run under
`probePolicy` (network deny, file writes confined to the realpathed
`$TMPDIR`, its `/private` twin and `/private/tmp`). Verified on this
machine: git facts populate for `artsy/force` and claude/codex versions
still resolve under the profile.

Documented exception: `amp --version` fails under the probe profile (its
CLI writes under `~/.cache` — beyond `~/.cache/amp` — on every invocation
and aborts with "Unexpected error inside Amp CLI." when the profile's
`(deny file-write*)` blocks it; re-allowing `(subpath "~/.cache/amp")`
alone is not enough, only `(subpath "~/.cache")` is). The amp probe runs
unwrapped (`PROBE_SANDBOX_EXCEPTIONS` in `Harnesses.ts`) rather than
letting the probe policy write into `$HOME`.

Reality check (L4, 2026-08-26, macOS 15 arm64, `claude` 2.1.247, `codex`
0.149.1, `/bin/zsh -il` with oh-my-zsh): all three start and reach their
prompt under the policies above with the signed-in account (Claude Max via
the Keychain, Codex via `~/.codex/auth.json`). Three rules had to be added
because seatbelt refused writes the programs make on their normal path;
everything else in `$HOME` stays read-only:

| Rule | Policies | Why |
| --- | --- | --- |
| `(subpath "/private<tmpdir>")` next to `(subpath "<tmpdir>")` | all | `$TMPDIR` is `/var/folders/.../T`, a symlink into `/private/var`; seatbelt matches the resolved path, so the `/var` rule alone denied every temp file. `privateAliases` adds the twin for any dir under `/var`, `/tmp`, `/etc`. |
| `(regex #"^<home>/\.claude\.json")` | harness, terminal | Claude Code saves `~/.claude.json` atomically through `~/.claude.json.tmp.<pid>.<random>` + rename; the literal rule for the file alone made the save fail. |
| `(regex #"^<home>/\.zsh_history")`, `(regex #"^<home>/\.zcompdump")` | terminal | zsh writes `$HISTFILE`, its `.new` and `.LOCK` siblings, and one `.zcompdump-<host>-<version>` per shell version. Without them the shell runs but loses history and rebuilds completion every start. |

The policy records these as `writablePrefixes`; `Sandbox.test.ts` pins every
allow/deny clause of the three profiles. Verified with `sandbox-exec -p` on the
rendered profile: `$TMPDIR`, `~/.claude.json.tmp.x`, `~/.zsh_history.new` and
`~/.zcompdump-x` write; `~/.zshrc-x` and `~/Desktop/x` are denied.

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

Implementation notes (L4): `~/.opencode/bin` is a candidate dir too (the
opencode installer's default). A binary that is absent is `unavailable`
whatever the credentials say; with a binary, the sign-in signal decides
`signed-in` > `api-key` > `binary-only`. Labels for the config-file
harnesses are the file in tilde form (`~/.hermes/auth.json`). Versions come
from `<bin> --version` probed in parallel with a 3s `Bun.spawn` timeout
(`hermes --version` takes 6s on this machine and reports `null`) and are
cached per binary path for the process lifetime; sign-in state is re-read on
every call. The route answers in about 1.5s cold and in file-read time warm.

PTY sessions (`src/bun/Pty.ts`): `Bun.spawn({ terminal: { cols, rows, name:
"xterm-256color", data } })` (Bun 1.4). Terminal tabs run `[$SHELL, "-il"]`
(default `/bin/zsh`); harness tabs run the detected absolute binary plus
`launch.argv.slice(1)`. `cwd` expands `~` and `~/x` against the server's
home and must be a directory (400 `bad_cwd`). The child environment is an
allowlist (`ENV_ALLOWLIST`: HOME, USER, SHELL, TMPDIR, LANG/LC_*, TZ,
SSH_AUTH_SOCK, XDG_*, EDITOR/VISUAL/PAGER, the harness config-dir
overrides, the provider API keys) plus `TERM=xterm-256color`,
`COLORTERM=truecolor`, `LANG` (default `en_US.UTF-8`), and a `PATH` that
starts with the Node sidecar's dir and the harness candidate dirs ahead of
the app's own PATH, so `codex` (a `#!/usr/bin/env node` script) resolves from
a Finder launch. Output frames are UTF-8 chunks from a streaming decoder;
`pty.exit` follows the last output (the PTY's EOF or a 300ms grace after the
process exit). Exited sessions stay listed with `alive: false` until
`DELETE`, so the SPA always deletes on tab close. `DELETE` sends SIGHUP, then
SIGKILL after 2s, and drops the record; `stop()` kills every session.

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
  `harness.spec.ts`; the repo plugin `repo-plugin.spec.ts` (fixture
  `e2e/fixtures/repo-plugin`, secondary `/Users/williamcory/aomi` when
  present).

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

## Integration log

Wave 1 (2026-08-26), on `local-app/base`:

- `b601f14ba` merge of `local-app/targets`.
- `1abcae998` merge of `local-app/foundation` (clean).
- `24f337536` merge of `local-app/tabs-ui`. Conflicts: `apps/ui/package.json`
  (foundation's scripts; `checklist` and `build:canary` dropped with the web
  era, root `checklist` forwarder removed), `playwright.config.ts`
  (foundation's, one `testDir` for `boot`, `chat`, `chat.real`, `tabs`),
  `FlowStamp.ts` (`composeRefs` + `stampTestIds`), `App.tsx` (both test-id
  hints; the corner Sign in button removed because the chrome bar renders
  `chrome-sign-in`), `ControllerBoot.client.ts` (`loadRepos` kept, `bindChain`
  stays out), `e2e/README.md` (replaced by a pointer to the Playwright tiers),
  `.github/workflows/apps-deploy.yml` (UI gate is `test:e2e`). `pnpm-lock.yaml`
  is foundation's; `pnpm install` changed nothing.
- Repair after `58d7e99d7`: the root scripts pin in
  `packages/flows/test/vitestCoverageIsolation.test.ts` follows the web-script
  removal (`checklist` gone, `dev` forwards to `start`), so the root `test`
  fan-out is green again; `apps/server` drops its `dev` and `serve:local`
  forwarders to the removed `smithers-ui` `web` script; `apps/README.md`
  describes `pnpm dev` as the Electrobun launch. The `apps/server`
  BuildStamp source-text pin (red since the `1544cc39b` reformat dropped
  semicolons from `vite.config.ts`, before the wave-1 base) matches the
  no-semicolon constants, so `bun test src scripts` in `apps/server` is green.

Acceptance on `24f337536`:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && git status --short` | `Already up to date`, clean tree |
| `pnpm --filter smithers-ui typecheck` | exit 0 |
| `bun test src` (apps/ui) | 815 pass, 0 fail, 92 files |
| `pnpm --filter smithers-ui test:e2e` | 10 passed, 1 skipped (`chat.real.spec.ts`, stub on); `tabs.spec.ts` green under the real webServer |
| `pnpm --filter smithers-ui test:e2e:native` | 1 passed (CEF window over CDP, origin `http://127.0.0.1:47313`) |
| `smthrs query '//...' --format json` on `/Users/williamcory/artsy/force` | `targets: 82` |

Open for wave 2: `/api/health.home` and the `cwd: "~"` expansion are contract
only until `local-app/harness-terminal` lands `/api/pty`; `tabs.spec.ts`
mocks both.

Lane L4 (`local-app/harness-terminal`, 2026-08-26):

- `src/bun/Harnesses.ts` + `Harnesses.test.ts`, `src/bun/Pty.ts` +
  `Pty.test.ts`, `src/bun/routes/harnesses.ts`, `src/bun/routes/pty.ts`;
  `server.ts` registers both and reports `home` on `/api/health`;
  `LocalServerOptions` gained `home`, `harnesses` and `pty` so tests inject a
  fake table and a sandbox-off `/bin/sh` manager.
- `Sandbox.ts` adds `writablePrefixes` and `privateAliases` (see "Sandbox");
  `Sandbox.test.ts` pins the clauses.
- SPA: `ControllerBoot.client.ts` loads the harness table at boot (the `+`
  menu re-loads on open); `controller/tabs.ts` always `DELETE`s a closed
  process tab's session. L2's frames matched the server's; no protocol
  change.
- `e2e/playwright/terminal.spec.ts` and `harness.spec.ts` run against the
  real origin (T1). `harness.spec.ts` skips its signed-in assertions with a
  reason when `~/.claude.json` has no `oauthAccount`.
- Real window (the dev `.app` launched with `ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT`,
  driven over CDP, 2026-08-26): the `+` menu's Terminal row opens a zsh tab,
  a click in the emulator takes keyboard focus and `echo hi-from-cef` renders
  its output; Cmd+T opens a second terminal tab and activates it; the first
  fit posts the real geometry (`145x49` at 1180x800) to `/api/pty/:id/resize`;
  the Claude Code row reads `Claude Code will@codeplane.app`, its tab shows
  the banner under the harness sandbox and typed text lands in Claude Code's
  composer; Cmd+W asks, confirms, and `GET /api/pty` empties. A native window
  resize could not be driven from the harness (CDP's `Browser.getWindowForTarget`
  answers "Browser window not found" for the embedded CEF view, and
  `osascript` lacks Accessibility access), so the ResizeObserver refit is
  proven by the mount-time fit only; the adapter posts every changed
  geometry from the same path.

Wave 2 (2026-08-26), on `local-app/base`:

- `3e6af1806` merge of `local-app/repo-targets` (clean).
- `2265ab8f2` merge of `local-app/harness-terminal`. Conflicts: `server.ts`
  (both lanes' `LocalServerOptions` kept — `buildCli` next to `home`,
  `harnesses`, `pty`; every lane placeholder dropped because both lanes
  register real routes), `server.test.ts` (the placeholder test became an
  empty-state check for `GET /api/repos`), `AppStore.ts` (both lanes fixed
  the `harnesses.loaded`/`repos.loaded` reducers the same way for TanStack
  DB's delete-insert refusal; L3's update-in-place implementation kept, both
  lanes' tests green). `LOCAL-APP.md` lane notes unioned by the auto-merge.
  `pnpm-lock.yaml` untouched by either lane.
- `8ce440d9e` fallout: the unused `notImplemented` import dropped from
  `server.ts`.
- `14bcbc36d` probe ruling (see "Sandbox"): the `git -C` branch/remote probe
  (`Repos.ts`) and the `<bin> --version` probes (`Harnesses.ts`) run under
  the new `probePolicy` (network deny, writes confined to scratch); `amp`
  is the one documented exception and stays unwrapped.

Acceptance on `14bcbc36d`:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && git status --short` | `Already up to date`, clean tree |
| `pnpm --filter smithers-ui typecheck`, `pnpm --filter smithers-shared typecheck` | exit 0 |
| `bun test src` (apps/ui) | 865 pass, 0 fail, 98 files |
| `bun test src` (apps/shared) | 44 pass, 0 fail, 4 files |
| `pnpm --filter smithers-ui test:e2e` | 17 passed, 1 skipped (`chat.real.spec.ts`, stub on): boot, chat, tabs, repo-targets, terminal, harness |
| `pnpm --filter smithers-ui test:e2e:native` | 1 passed |
| `smthrs query '//...' --format json` on `/Users/williamcory/artsy/force` | `targets: 82` |

Cross-lane smoke (headless server on `47396`, chat stub on): `/api/health`
reports `home`, `node` and `sandbox.enforced: true`; `/api/harnesses` lists
`claude` 2.1.247 signed-in with its account email; `POST /api/repo/open` on
`artsy/force` answers `detected: true` with the origin remote (branch null:
the checkout sits on a detached HEAD); `POST /api/targets/query` answers 82
targets with no warnings; `POST /api/pty` (`terminal`, `cwd: "~"`) opens a
session listed `alive: true` at `$HOME` and `DELETE` empties the list.
