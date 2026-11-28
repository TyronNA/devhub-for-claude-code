# Changelog

## 0.29.79 — Codex is back

- **Codex chats return**, undoing the 0.29.72 removal: **Dev Hub: New Codex Chat**, the Codex
  provider (`codex exec --json` per turn, compaction over `codex app-server`, model catalog from
  `codex debug models`), its history in the sidebar, the phone page and the seven
  `devHub.codex.*` settings. Codex stays optional; without the CLI nothing changes for Claude.
- Old Codex rows in `sessions.json` are no longer filtered on load. Rows the 0.29.72 filter already
  dropped come back from `~/.codex` on the next history scan.
- The Codex icon is an original mark, not the OpenAI logo; every restored comment and string is English.
- The Codex model-picker test now points `CODEX_HOME` at an empty folder; it used to read the
  machine's own `~/.codex/models_cache.json`.
- Proven: `tsc` clean; 487/487 unit tests incl. the restored Codex suites (transport, parsers,
  catalog, parity). Against a real `codex-cli 0.172.0`, `CodexProvider` ran a start turn, a resume
  on the same thread and a transcript reload: assistant text, usage, quota and `turn_done` all
  parsed. **Not opened in a real window**; compaction, images and sub-agents were not exercised live.

## 0.29.78 — Marketplace publisher

- **Publisher is now `tyronna`**, so the extension id becomes `tyronna.dev-hub-claude-codex`, ready for
  the VS Code Marketplace and Open VSX. VS Code treats it as a new extension: uninstall
  `local-devhub.dev-hub-claude-codex` first. Its registered projects and chat list live under the old id's
  storage and do not carry over; chat transcripts in `~/.claude` are untouched and show up
  again once the projects are re-added.
- The `.vsix` ships only `dist/src`; the compiled tests no longer ride along when `vsce` packages it.
- New manual `Publish` workflow: Marketplace via Trusted Publishing (no token), Open VSX via the
  `OVSX_PAT` secret. Not run yet.

## 0.29.77 — first-run setup, English UI

- **A fresh install now says what to do next.** The top row of the sidebar walks through
  *Install Claude Code…* → *Log in to Claude Code…* → *Add your first project…*, all through the new
  **Dev Hub: Get Started** command. Before, a machine without the CLI only found out on the first
  send, as `claude executable not found`.
- Installing types the official command into a terminal and waits for Enter; it never runs an
  installer by itself. Signing in runs `claude auth login` and polls `claude auth status --json`.
- With the default `devHub.claude.executable`, Dev Hub also finds a CLI in `~/.local/bin`,
  `/opt/homebrew/bin`, `/usr/local/bin` or `~/.claude/local` when VS Code's `PATH` predates the install.
- A signed-out turn no longer says "Please run /login", which does nothing over stream-json; it
  points at **Dev Hub: Get Started** and offers a **Log in** button.
- Every UI string, comment and doc is English; a test fails on Vietnamese text anywhere in the tree.
- Marketplace-ready metadata: icon, categories, keywords.
- Proven: unit tests for the probe (fake CLIs signed in, signed out, too old for `auth status`), the
  executable lookup and the tree row. Checked in a clean VS Code profile with the CLI pointed at a
  missing path: the row appeared, the installer picker opened, and the command was typed into the
  terminal without running. The install and the browser sign-in were **not** run end to end.

## 0.29.76 — first public release

- Published from the private development repo as a single squashed commit; the earlier history
  is not carried over.
- Shipped icons are original; the Anthropic brand marks the private build borrowed are gone.
- `devHub.planner.endpoint` now defaults to empty, so a fresh install polls no loopback daemon
  until an agent with `kind: "http"` is configured.
- Covered by the unit test suite only; this exact build has not been opened in a real window yet.
