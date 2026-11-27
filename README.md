# Dev Hub for Claude Code

**Run Claude Code across all your repos from one VS Code window, and keep the conversation going from your phone.**

[![CI](https://github.com/TyronNA/devhub-for-claude-code/actions/workflows/ci.yml/badge.svg)](https://github.com/TyronNA/devhub-for-claude-code/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/TyronNA/devhub-for-claude-code)](https://github.com/TyronNA/devhub-for-claude-code/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Dev Hub in VS Code: projects grouped by workspace in the sidebar, a Claude Code chat open on the right](https://raw.githubusercontent.com/TyronNA/devhub-for-claude-code/main/docs/images/vscode.png)

> Unofficial and community-built. Not affiliated with or endorsed by Anthropic. "Claude" and
> "Claude Code" are trademarks of Anthropic. Dev Hub drives the `claude` CLI you already have
> installed and logged in. It has no account or API key of its own.

## Why

One VS Code window per project costs about **1 GB of RAM each**
([measured](docs/PERFORMANCE.md#one-window-per-workspace)). Dev Hub keeps 30+ projects reachable
from **one** window. You register repos by path, so VS Code never indexes them or watches their
files. Each chat starts the CLI with the repo as its working directory, so your `CLAUDE.md`, skills
and memory work exactly as they do in a terminal.

## Features

- **Every repo in one sidebar.** Group projects into workspaces such as "Work" or "Side projects".
  Start a chat in any project without opening it.
- **Several agents at once.** Turns run in parallel up to a cap you set. Running sessions
  show a live status, and you can jump between them from the keyboard.
- **Your existing history.** Sessions you started in a terminal are found in `~/.claude` and can
  be resumed from the sidebar.
- **Approvals in the panel.** Tool permission requests appear as Allow / Deny cards. Every
  request gets an answer (deny on timeout or when the tab closes), so the CLI never hangs.
- **Usage you can see.** Context window, 5-hour and 7-day limits, and token cost for each turn,
  read from the CLI's own events.
- **Queue, images, slash commands.** Type the next prompt while a turn is running, paste
  screenshots, and pick the model and effort for each session.
- **Phone web app.** An optional page served on your local network shows the same chats,
  approval cards and history on your phone. No app store, no cloud relay.
- **Ports panel.** See which project owns each listening port. Open it, pin it or kill it.

| On your phone | Session history |
|---|---|
| <img src="https://raw.githubusercontent.com/TyronNA/devhub-for-claude-code/main/docs/images/mobile-chat.png" width="300" alt="Mobile web app showing the same chat and approval card"> | <img src="https://raw.githubusercontent.com/TyronNA/devhub-for-claude-code/main/docs/images/mobile-history.png" width="300" alt="Mobile web app history drawer listing sessions across projects"> |

## Requirements

- VS Code **1.95** or newer
- [Claude Code](https://claude.com/claude-code) CLI on your `PATH`, already logged in. Check with `claude --version`.
- macOS or Linux. Windows has not been tested; the ports panel uses `lsof`.

## Install

1. Download the latest `dev-hub-claude-codex-*.vsix` from
   [Releases](https://github.com/TyronNA/devhub-for-claude-code/releases).
2. Install it:
   ```bash
   code --install-extension dev-hub-claude-codex-*.vsix
   ```
   Or use **Extensions → … → Install from VSIX…**
3. Run **Developer: Reload Window**, then open the **Dev Hub** icon in the activity bar.

## Quick start

1. **Dev Hub: Add Workspace**, then give it a name such as `Work`.
2. **Dev Hub: Add Project**, then pick a repo folder. The repo is stored as a path only.
3. Click **New Claude Chat** on the project row and type a prompt.

**Dev Hub: Search Project & Start Chat** jumps straight to a chat in any registered project.

### Use it from your phone

1. Set a passcode in `devHub.mobile.passcode`: exactly 4 digits, or 8–128 characters.
2. Run **Dev Hub: Open Mobile Web App** and agree to the prompt. It shows a URL such as
   `http://192.168.1.20:39642/`.
3. Open that URL on a phone on the same Wi-Fi, enter the passcode, and optionally *Add to Home
   Screen*.

> ⚠️ The passcode is the **only** thing guarding the page, and anyone who gets past it can
> drive an agent on your machine. Use a long passcode, and set `devHub.mobile.lan: false` with a
> tunnel you trust (for example Tailscale) on networks you don't control.
> **Dev Hub: Sign All Phones Out Of The Mobile Web App** revokes every phone that is signed in.

## Permissions: read this

Dev Hub inherits your global Claude config. If `~/.claude/settings.json` auto-approves tools,
they run **without asking**, here as well as in a terminal. To make every unlisted tool ask in the
panel, set `devHub.claude.permissionMode` to `"manual"`. See
[Permissions](docs/DESIGN.md#permissions--read-this) for all modes.

## Settings you'll likely touch

| Setting | Default | What it does |
|---|---|---|
| `devHub.claude.executable` | `claude` | Path to the CLI if it is not on `PATH` |
| `devHub.claude.permissionMode` | `""` | `""` inherit, `manual`, `plan`, or `bypassPermissions` |
| `devHub.maxConcurrentTurns` | `4` | How many turns may run at once |
| `devHub.mobile.enabled` | `false` | Serve the phone web app |
| `devHub.mobile.passcode` | `""` | Passcode for the phone web app |
| `devHub.mobile.lan` | `true` | `false` serves on loopback only |

Every setting and command is documented in [docs/DESIGN.md](docs/DESIGN.md#settings).

## Build from source

No runtime dependencies. The only build tool is TypeScript.

```bash
git clone https://github.com/TyronNA/devhub-for-claude-code && cd devhub-for-claude-code
npm install --no-save typescript@5.9
npm test            # compile + 400+ hermetic tests (no CLI, no network)
npm run package     # → dev-hub-claude-codex-<version>.vsix
```

`node scripts/demo.js` serves the chat panel and the phone page with sample data; the phone
screenshots above were taken from it.

## How it works

[docs/DESIGN.md](docs/DESIGN.md) records **why** each behaviour is the way it is: how the CLI is
driven over `stream-json`, session id ownership, the turn lifecycle, and how the phone page reuses
the panel's renderer. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) maps the code, and
[docs/PERFORMANCE.md](docs/PERFORMANCE.md) has measured numbers with the scripts that produced
them.

## Contributing

Issues and PRs are welcome. Please report security problems privately; see [SECURITY.md](SECURITY.md). Please run `npm test` before opening a PR, and read the section of
`docs/DESIGN.md` that covers the area you change: much of the odd-looking code is there on purpose.

## License

[MIT](LICENSE). The icons in `media/` are original to this project; no Anthropic brand assets are shipped.
