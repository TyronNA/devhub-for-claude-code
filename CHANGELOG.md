# Changelog

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
