# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An unofficial VS Code extension (`dev-hub-claude-codex`, publisher `local-devhub`, distributed as a
`.vsix` from GitHub releases) that runs **Claude Code** CLI sessions across many repos from one
window, without adding those repos as workspace folders. Registered projects are paths only; each
chat spawns a CLI with the project as `cwd`.

`docs/DESIGN.md` is the design document (`README.md` is the short user-facing page). It records
*why* each behaviour is the way it is (permission timeouts, image transport, queue semantics). Read
the relevant section before changing behaviour in that area; most of the odd-looking code there is
load-bearing and the reason is written down.

## Commands

```bash
npm run compile                                  # tsc -p tsconfig.json → dist/
npm test                                         # compile, then node --test dist/test/devhub/*.test.js
node --test dist/test/devhub/sessionManager.test.js   # one test file (compile first)
node --test --test-name-pattern='queue' dist/test/devhub/*.test.js   # one test by name
npm run package                                  # compile + scripts/package-vsix.js → *.vsix at repo root
npm run clean

node scripts/measure-webview.js HEAD <old-rev>   # webview layout/heap in real Chrome via CDP
node --expose-gc scripts/measure-host.js         # extension-host CPU/heap over real ~/.claude
node scripts/audit-sessions.js --days 1          # audit past agent sessions from the CLIs' own transcripts
node scripts/demo.js                             # sample data on :7801 (mobile, passcode 0000) / :7802 (panel) for screenshots
```

Install after packaging: `code --install-extension dev-hub-claude-codex-*.vsix --force`, then
**Developer: Reload Window**. A tunnel host is a *separate* install target
(`~/.vscode-server/extensions`) — see the Remote section of `docs/DESIGN.md`.

## Toolchain constraints

- **No runtime dependencies and no `devDependencies`.** `node_modules/` holds only `typescript`.
  Nothing may be added to `package.json` deps; use `node:` builtins via `require`.
- **No `@types/vscode`.** The API is reached as `const vscode:any=require('vscode')`, and
  `src/shims.d.ts` declares `require`/`process`/`__dirname`/`Buffer` by hand. `strict:false`.
- Tests are plain `node --test` over compiled JS. `vscode` is stubbed by patching `Module._load`
  (see `test/devhub/chatTabs.test.ts`); provider tests drive fake CLI scripts that speak the real
  stream-json protocol. Tests must stay hermetic — no live CLI, no network, no VS Code.

## Architecture

Wiring lives in `src/extension.ts`: it constructs the stores, the two providers (`claude`,
`planner`), the `SessionManager`, the tree, the chat panel and (lazily) the mobile server,
then hooks them together with callbacks rather than a DI container. Read it first.

```
storage/      atomic JSON stores under context.globalStorageUri (workspaces.json, sessions.json,
              queues.json — prompts typed but never sent, handed back as text, never re-queued)
workspace/    logical workspace → project resolution (paths, never workspace folders)
providers/    claude/: spawn, stream parsing, history discovery, transcript loading;
              planner/ speaks HTTP to a daemon instead of spawning anything
sessions/     SessionManager (turn lifecycle), event cache, history reconciler, restore selection
views/        tree provider, chat webview panel, status bar, webview message protocol
web/          mobileServer.ts — the chat as a real HTTP page (SSE down, POST up); binds the LAN
              or loopback per `devHub.mobile.lan`, and `devHub.mobile.passcode` is the only guard
              on either — a keypad on `/` trades it for the cookie every other route demands
agents/       long-running terminal bots: `make status` + read-only SQLite thread reading,
              or task rows over a `kind:"http"` bot's own loopback API
ports/        lsof-based listening-port scan grouped by owning project, else by owning agent
media/        webview/chat.{js,css} and mobile/{bridge.js,mobile.css} — plain files, inlined by the host
```

Load-bearing invariants:

- **`AgentProvider`** (`providers/provider.ts`) is the seam: `isAvailable / start / resume /
  discoverHistory / loadTranscript`, each turn returning a `ProviderTurnHandle` whose `events` is an
  `AsyncIterable<DevHubEvent>`. Everything above the providers speaks `DevHubEvent` (`types.ts`)
  only — a new CLI means a new provider, not changes in the manager or the webview.
- **Session id ownership differs per provider.** Dev Hub mints Claude's and passes `--session-id`;
  when a turn's handle reveals a different id mid-stream, `SessionManager.consume` **rekeys** the
  store, the event cache and the open tab from a `pending:` placeholder. Planner's id *is* the daemon's
  `conversation_id` (`task:<KEY>` or a fixed chat id), which is why the session also carries
  `plannerEndpoint`: the store key is provider + id, and the same key on two daemons is two
  different things.
- **Concurrency is a claim, not a counter.** `reserveSlot()` reserves before the awaits in
  `start`/`resume`; `claim()` locks per session. Ask **`SessionManager.isBusy()`**, never a session's
  status — `cancel()` writes `cancelled` immediately while `consume` only clears `active` in its
  `finally`.
- **Two front-ends, one renderer.** The webview panel and the mobile HTTP page load the same
  `media/webview/chat.js` and speak the same host protocol over different pipes. A behaviour change
  in one usually needs the other; `web/mobileProtocol.ts` only *adds* messages on top of
  `views/webviewProtocol.ts` — never loosen the shared validator there.
- **The webview builds DOM with `createElement` only; no `innerHTML` anywhere**, CSP is
  `default-src 'none'`, and `localResourceRoots` opens the attachment dir plus `~`/tmp for agent-named media
  (the mobile `/api/file` gates those by media extension after `realpath`). Keep it that
  way — agent output is untrusted markup.
- `media/webview/chat.js` runs in the *viewer's* browser, so no syntax newer than old WebKit
  (`webviewScript.test.ts` greps the shipped script for RegExp lookbehind for this reason).
- A Claude permission request is **always** answered — deny on tab close, panel dispose, turn end or
  timeout — because the CLI blocks on it. The mobile server is offered the request before the panel.

## Conventions

- **Code style is deliberately dense**: multiple statements per line, minimal whitespace, one file
  per concept. Match it; do not reformat or "clean up" surrounding lines.
- **English only** — comments, UI strings, test names and assertion messages, docs. Comments explain
  only the non-obvious *why* (the trap, the constraint), tersely. `manifest.test.ts` fails on
  Vietnamese text anywhere in the tree.
- Every contributed command needs a `Dev Hub: ` title prefix, a short `shortTitle`, and an icon if
  it appears in a menu — `test/devhub/manifest.test.ts` enforces all three against `package.json`.
- Model *lists* live in settings (vendors ship models faster than this rebuilds); effort levels stay
  in code because they are fixed, per-CLI flag values.
- Releases: bump `version` in `package.json`, add a `CHANGELOG.md` section that says what broke and
  how it was proven, and commit as `vX.Y.Z: <lowercase sentence about the actual change>`; the
  `release` skill (`.claude/skills/release/`) has the full tag → package → GitHub release steps. Measured
  performance numbers belong in `docs/PERFORMANCE.md` with the script that produced them.
- Say when something is only covered by tests and not exercised in a real window — the changelog
  does this consistently, and none of the mobile/iOS behaviour is device-verified.
