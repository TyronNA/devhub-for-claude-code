# Dev Hub — design notes

The user-facing overview is the [README](../README.md). This file records *why* each behaviour is
the way it is; read the section a change touches before changing it.


A VS Code sidebar that runs **Claude Code** sessions across every repo you own,
without loading those repos into the active VS Code workspace — and, through the same tabs, talks
to a **task agent**: a daemon that plans tickets on its own and waits for your approval
(*[Task agents](#task-agents--plan-approve-execute)*).

Each CLI chat spawns its process with the selected project as `cwd`, so `CLAUDE.md`,
skills and project memory work exactly as they do in a terminal; a task agent spawns nothing —
that provider only speaks HTTP to a daemon already running. Registered projects are
**paths only** — Dev Hub never adds them as workspace folders, so VS Code does not index or
file-watch them.

> Unofficial, community-built. Not affiliated with or endorsed by Anthropic; "Claude" and
> "Claude Code" are Anthropic's trademarks. Install from a release `.vsix` (see [Install](#install)).

## Why

One VS Code window, several agents running across unrelated workspaces, all visible at once.
A window per workspace costs roughly **1 GB** ([measured](PERFORMANCE.md#one-window-per-workspace));
Dev Hub keeps 30+ projects reachable from one.

## Sidebar

```
Work                          ● 2
  order-service               ● 1
    ⏳ fix the dispatch race
    …3 shown, More… (3/31)
Game
Side projects
Recent                        8 · 781MB
Ports                               9
  Pinned                            1
      :8003              main · order-service
  order-service                     3
      :5003                       main
  web-ui                            1
  System                            4
Agents                              3
  ● my-bot                     running (pid=…)
      Hey — what do you need?
      ⋯ More… (3)
  ● my-planner                 running (pid=…)
      ABC-1              WAITING_APPROVAL · v2 · 0.81
      ABC-2              ANALYZING
      ABC-3              APPROVED · v1
  ○ review-bot                 not running
Ask my-planner…
New chat…
Open on phone…
```

- Logical workspaces → projects → sessions, independent of the VS Code workspace.
- Sessions page **3 at a time**, then `More…` adds 5. Same for agent threads.
- **Recent** — 8 newest sessions across every workspace, running first, each row labelled with
  the session's name only; the repo is in the tooltip. The `repo · ` prefix ate most of a narrow
  sidebar, so rows are told apart by naming them instead: **double-click** a session row (or
  right-click → Rename Chat) to give it a name. VS Code trees have no double-click event, so it is
  two `devhub.openChat` calls on the same row within 500 ms — the first click still opens the chat.
  The name is its own field (`name`), not `title`; the store keeps it across every `upsert`,
  because a running turn writes back a session object captured before the rename. Empty name
  reverts to the first prompt.
- **The MB next to Recent is every live CLI process, not just the visible ones.** A finished
  Claude chat keeps its `claude` process until `devHub.claude.sessionIdleMinutes`, so the tree can
  show one ⏳ while three processes sit on ~780MB; the row icons are turn *status* and say nothing
  about that. It sums the process tree, not the CLI alone — the MCP servers a chat spawns are the
  fat part — and it deliberately counts sessions with no row on screen (project collapsed, past
  the first page, outside Recent's eight), because those are exactly the ones you cannot see.
  Planner never appears in it: it is HTTP. One `ps -Ao`
  (~16ms, measured) behind a 5s cache that `refresh()` must not clear — `refresh()` runs on every
  session status change, which would put a `ps` behind every delta of a running turn.
- **Ports** — TCP ports listening under your user (`lsof`, no root), grouped by the project
  owning each process's `cwd`; an unregistered repo still gets a group from its folder name and
  a process with no usable `cwd` falls into `System`. Groups are keyed by project, not by label,
  so two repos that happen to share a folder name stay two groups; a repo nested inside another
  repo owns its own `cwd`, because the *longest* matching root wins rather than whichever was
  registered first. Click to open `http://localhost:<port>`;
  rescanned at most every 5s. **Pin** moves a port to a `Pinned` group, keyed by port number not
  pid so it survives a server restart. **Kill Process on Port** sends `SIGTERM` behind a modal
  confirm, then offers `SIGKILL` only if the process is still alive 1.2s later.
  A port opened from a bot's repo takes the **agent's** name from `devHub.agents` rather than the
  folder basename, so the same process is not called two different things by two sections of the
  tree; a registered project still wins over both.
- **Agents** — long-running terminal bots. An entry with `"kind":"http"` lists **tasks** from its
  own loopback API instead of threads — see *Task agents* below. Every other entry reads threads.
  Status comes from `make status`; threads are read
  **read-only** from each bot's SQLite — the entry's `db` if it names one, otherwise the first
  `*.db` in `cwd` — whatever its schema, carrying the Slack channel and asker where the schema
  records them (`devHub.agentNames` maps raw ids to names).
- Every session row keeps its vendor logo, whatever its status — a `TreeItem` has exactly one
  `iconPath` and recognising the CLI at a glance beat everything competing for it. Status is an
  **emoji in the label** instead (❓ waiting on you, ⏳ running, ✅ done, 🔴 failed, ⚫ cancelled,
  🟡 unavailable), because neither label nor description renders a codicon; `imported` gets none,
  and that blank is what separates “found on disk” from “ran and finished”. The three abnormal
  statuses also spell themselves out in `description`, since a colour says something is wrong
  without saying what. Workspaces
  get a stable accent colour derived from their name; **Recent**, **Ports** and **Agents** get
  fixed ones, so their position is what the eye learns.
- Native Claude history on disk is imported when a transcript's `cwd` maps to a project.

## Chat

- One tab per session, all pinned to a single editor group, titled by project with the
  provider's brand mark as the tab icon.
- Opening Dev Hub restores a chat: the session in `globalState`, else the most recently
  updated session that is still available.
- **The header carries the project's git state**: branch with `↑ahead ↓behind` against its
  upstream, and a GitHub-shaped `files +added −removed` chip with a five-square bar. The chip
  measures the **dirty working tree** (everything since `HEAD`), not the branch's diff against a
  base — the point is that it moves while an agent edits files. Untracked files count towards
  *files* but not towards *lines*: `git diff HEAD` cannot see a file that was never added, and
  counting its lines costs one more `git` per file; the tooltip says so. Clicking the chip opens
  a QuickPick of the changed files, each with its own `+/−`. Two `git` commands
  (`status --porcelain=v2 -b -z`, `diff --numstat --no-renames -z HEAD`) behind one cache shared
  by the panel and the mobile server: single-flight per repo, re-read every 5s while a turn runs
  and every 30s otherwise, and **not at all when no tab showing that repo is visible**. Below
  560px both chips are hidden — that header row has about 3px to spare on a phone, and a number
  is the one thing there that can be dropped without losing a button.
- Tabs survive **Reload Window** via a `WebviewPanelSerializer`. Hiding a tab keeps its DOM
  (`retainContextWhenHidden:true`), but composer text and pending attachments still go to
  `setState` — that is what survives a window reload, which no amount of retaining does. A tab
  that has not sent anything yet has no session to look up, so its `setState` carries the
  workspace, project and provider instead; without that the serializer had nothing to resolve
  and threw the tab away with the draft still in it.
- **Approval prompts** render Allow/Deny inline, and a pending card is re-posted after every
  re-render, because `sessionSelected` wipes the DOM and the CLI would then sit blocked on an
  invisible question. A card dies with its turn: a turn cannot finish while the CLI waits on
  `can_use_tool`, so anything still pending once the session leaves `running` is dead — denied,
  card locked with the reason. `AskUserQuestion` and anything else flagged
  `requires_user_interaction` gets an hour instead of a tool approval's five minutes, and is
  labelled: the CLI can refuse a one-tap Allow for those, its own card being the answer surface.
- Markdown: headings, lists (nested, task lists), tables, fenced code, blockquotes, rules,
  bold/italic/strike, inline code, links, bare URLs — built with `createElement` only, **no
  `innerHTML` anywhere**, so agent output can never inject markup. It renders **while the answer
  streams**: blocks above the last blank line are drawn once and only the block being typed is
  re-rendered, and an unclosed fence is appended to verbatim instead of re-parsed. `turn_done`
  re-renders from the raw text, so the final DOM equals reopening the transcript.
- Tool calls collapse to one line; output folds behind a `+N lines` summary.
- An **`ID` chip** in the header copies the session id — the name of the CLI's transcript file,
  so it is what makes a session traceable outside Dev Hub. It is hidden
  until a session exists (a draft has no id) and its tooltip carries the id, so the common case
  needs no click. The mobile page copies it **in the viewer's browser**, not through the host:
  routing it through `vscode.env.clipboard` would put the id on the clipboard of the machine
  running VS Code and leave the phone in your hand with nothing. LAN is plain http, so
  `navigator.clipboard` may be absent and a `prompt()` is the fallback.
- **The run indicator does not vanish when the turn ends — it becomes the turn's footer.** While
  the turn runs it is the spinning provider logo, a verb that changes every ~4s and the redacted
  thinking-token count (the only thing that moves in the 1.5–2.5s gaps around a tool result). When
  the session leaves `running` the same row stops spinning and reads `Done · N calls (Bash 5,
  Read 4, …) · 21.2k tok · $0.12`, with `Stopped`/`Failed` for a cancelled or failed turn. It is
  computed **in the webview from the transcript it already has** — back to the last `user_message`,
  one call per `callKey` so `*_started` + `*_completed` is not counted twice — so no new event was
  added and reopening an old tab rebuilds the same footer. Only measured parts are printed: a
  transcript imported from a CLI with no usable timestamps drops the duration instead of printing a
  wrong one, and `costUsd` is whatever the CLI reported at the end of the turn, not a sum Dev Hub
  computed. The top three tool names fit the row; the full tally and the token breakdown are in the
  tooltip.
  The running clock is keyed to the session and anchored to that same last `user_message`, not to
  the moment the tab was drawn: switching tabs mid-run used to keep the previous session's timer
  and its thinking-token count alive (the row simply re-rendered while the old interval kept
  ticking), and reopening a tab that had been running for minutes restarted it at `0s`.
- Every block — bubble, assistant text, tool row, permission card — starts on the same 23px
  left edge (`main` 12px + border + padding). User messages get a background slightly lighter than code blocks
  and a 3px left bar, so they stay traceable even for viewers who can't tell provider hues apart.
- The transcript sticks to the bottom while streaming unless you scrolled up to read; your own
  message always scrolls into view. Stickiness comes from your `scroll` events and the scroll is
  coalesced to one per frame, so streaming costs no layout per event.
- **Sending while a turn runs queues instead of dropping.** The host owns a per-tab FIFO,
  shows it above the composer, and sends one item per finished turn; `×` removes one, and a
  resume that fails puts the message back at the head rather than losing what you typed. A
  message typed before the first turn exists is queued too, and a `start()` that fails keeps the
  order you typed — the next send takes the head of the queue, not itself.
  **A non-empty queue is never itself a reason to queue.** Only a running turn or `isBusy()` is.
  The flush rides on `sessionUpdated`, and a send that fails emits no such event — so treating
  leftovers as "busy" left the tab write-only, every later message piling up behind one failure
  with nothing able to drain it. An idle session with a queue sends the head immediately.
- A queue is host memory, so a window reload loses it. What Dev Hub keeps is the **text**: the
  pending items are written to `globalStorage`, and the next window that opens that session
  prints them back as a warning. They are deliberately **not** re-queued — a queue from a window
  closed days ago firing on its own is a turn nobody asked for.
- **Whether a session can take a turn is `SessionManager.isBusy()`, never its status.** `cancel()`
  writes `cancelled` at once, but `consume` only drops the session from `active` in its `finally`
  — a window where the status says idle and `claim()` still refuses. Both the send path and the
  queue flush ask `isBusy()` and queue instead of walking into that refusal.
- **Stop kills the turn, not the queue.** It cancels the running turn and the session lands in
  `cancelled`, which is not `failed`; whatever you typed while it ran stays in the queue and the
  `sessionUpdated` that ends the turn flushes it like any other finished turn. Stop-then-type is
  how you redirect a turn, so throwing the redirection away was the wrong half to drop — it used
  to empty the queue and print the text back as a warning. Removing an item you no longer want is
  `×` on the chip. Both frontends share the session's queue, so this is one behaviour, not two.
- `+` starts another chat in the project already on screen; the breadcrumb chip changes project.
- 🕘 lists the **earlier sessions of the project on screen** and reopens one — a rescan of
  `~/.claude` runs first, because a session started in a terminal only enters the
  store on a refresh. The sidebar tree is still the way to reach another project's history; on a
  tab with no project (a planner row) the list falls back to every session. The phone builds the
  same list as a sheet, but from the store alone — it has no rescan.
- Paste an image — or tap 📎 on a touch-only panel, because iOS never fires `paste` with a
  file. A thumbnail chip appears and the image rides along with the next prompt: Claude gets the
  path in the prompt because its stream-json input has no image flag. Click the chip to open it (`vscode.open`, not `showTextDocument` — that renders
  a PNG as garbage). PNG, JPEG, GIF and WebP only, 9 MiB each, pruned after 48h; anything else
  is refused out loud rather than dropped by the protocol validator in silence. Each image
  carries a `requestId`, so a reply lands on its own chip, the typed draft survives until
  saving finishes, and a failed read or save removes its chip and says why. An attachment with
  no typed text is a message in its own right. Attachment paths must sit inside Dev Hub's own
  attachment folder; the shared protocol validator only knows "absolute path", so the root is
  enforced by the host that knows where that folder is, and anything else is refused out loud. Sent images show in the bubble that sent them;
  after a reload the buffer is gone and the transcript comes from the CLI's own history, so the
  panel lifts leading attachment paths back out of a Claude prompt to redraw them.
- **Media the agent names by absolute path shows in its reply.** `![alt](/abs/x.gif)`, a link to
  one, or a code span holding nothing but one (`` `/tmp/demo.mp4` ``) renders as `<img>`/`<video>`
  for PNG/JPEG/GIF/WebP/MP4/M4V/MOV/WebM. Nothing is sent to the model: the host hands the webview
  a URI base on `ready` (`asWebviewUri('/')` in the panel, `/api/file?f=` on the phone) and the
  webview joins the path onto it; what may be read is still the host's call. The streaming tail
  never builds media — it is redrawn on every delta, so a video there would restart forever. A
  file that fails to load (gone, outside the roots, or a codec VS Code's Electron lacks — H.264 in
  `.mp4` is the suspect, not verified) falls back to a button that opens it. Videos are not muted: they never autoplay (the only reason to mute), and an agent hands over audio as an `.mp4` because the chat has no audio player. Images a Claude tool
  returns inline (a Playwright screenshot, `Read` on a PNG) arrive as base64 inside `tool_result`;
  the parser writes each one to `$TMPDIR/devhub-tool-images/<sha1>.<ext>` and the event carries
  that path, so it travels like any other media path. As data URIs they rode inside the single
  `sessionSelected` message re-sent on every tab open and SSE reconnect, megabytes for a session
  full of screenshots. Same content = same file, so re-reading a transcript writes
  nothing; a failed write falls back to the data URI. `/api/file` caches these as `immutable`.
- **Model and thinking effort belong to the session, not to the tab.** Picking one writes it into
  `sessions.json` right away — before any turn is sent — so closing the tab and reopening the
  session comes back on what you picked, instead of silently falling back to
  `devHub.<provider>.model`/`.effort`. The phone does the same thing through the same store, so a
  chat switched to `sonnet low` on the desktop is still on it when opened over the LAN.
- **Click the context ring to compact** — progress and
  result are reported, including why it refused. Claude uses its own `/compact`; a planner
  session has nothing to compact and says so.
- The `/` chip lists the CLI's own slash commands, remembered across window reloads, hidden for
  providers that publish none.
- **The composer bar is the only status strip.** It used to be doubled by a row under the header
  carrying model, effort and the same three percentages; the row is gone. Model and effort sit in
  the bar in the provider's accent colour, and the token breakdown that was that row's tooltip is
  now the context ring's.
- **Every ring measures what is *left*, never what is spent.** The three rings look identical, so
  they must read identically: a full arc is a full tank and it drains as you consume, with amber
  under 30% left and red under 10% on all of them. That cost the quota rings their old meaning —
  the arc used to be the time remaining until the window resets (`(resetsAt - now) / 5h`), which
  put a *time* arc beside a *tokens* arc filling the opposite way, and no one could say which ring
  meant what. The reset moment now lives in the tooltip only (`46% left · 54% used · resets … (in
  2h 10m)`), which also carries the used-percentage so a reading can still be lined up against the
  CLI's own `/status`. The status bar and its tooltip say `5h 46% left` for the same reason.
  That tooltip is a hover card built in the page, not a native `title`: the OS tooltip waited
  about a second and looked like a system caption. The card shows almost at once (60ms, so a
  mouse passing over does not flash it), sits on the composer row's right edge rather than the
  ring so a narrow panel cannot push it off the left, and opens on tap where there is no hover.
  The full sentence moved to `aria-label`. The context ring has the same card (token breakdown,
  cost, "Click to compact"), hidden on touch because a tap there *is* the compact.
- **Prompt cache chip, right of the effort chip** (`cache 50m`, then `cold`). Same arithmetic as
  the official extension: the anchor is the last main-conversation request that read or wrote the
  cache (`message_start`, the earliest signal we see), plus the TTL read from
  `cache_creation.ephemeral_1h/5m`. A read-only turn does not say which TTL, so the key is left
  out and the merge keeps the last one — never send it as `undefined`, the webview merges with
  `Object.assign` and would wipe it. Sub-agent requests have their own cache and are skipped; a
  successful compact sets the anchor to `0` (cold: the prefix changed). No TTL known yet (a
  resumed session that only read) → the chip hides rather than guesses.
- **Where the usage went.** After a turn's `result` the live process is sent the CLI's
  `get_usage` control request (the SDK calls it `usage_EXPERIMENTAL_…`; it hits the server, ~1.5s,
  runs no model). Its `behaviors` are what the official extension prints as "N% of your usage
  was while 4+ sessions ran in parallel": the 5h card shows the 24h window, the 7d card the
  week. The percentages overlap (one request can be >150k context *and* parallel), so the card
  says "not a breakdown". It is account-wide, so one 5-minute throttle is shared by every tab.
  The answer arrives out of turn, which is why `ingestOutOfTurn` must not read a lone `usage`
  event as the start of a CLI-opened turn — it used to flip the session to `running` for good.
- **Two quota rings, left of the context ring.** The number beside each is the quota left, prefixed
  `~` when the reading is older than 15 minutes. `usage` events only arrive once a turn, so a 60s
  timer — alive only while a ring is on screen — refreshes that `~` and the tooltip's countdown.
- **On a phone the bar fits one row, and what gives way is the context percentage.** Below 560px
  the bar stops wrapping and the *words* go — but the two that survive are the quota numbers, not
  the context one: a quota is the thing with no other readout on a phone (no status bar, no
  `/status`), while the context ring is still legible as an arc and is a button you tap to compact.
  So each quota ring drops its `5h` / `7d` label and keeps `46%` (label and number are separate
  spans for exactly this), and the context ring drops both `95%` and `· 48.7k/1m` — all of it is
  still in the tooltips. Measured in real Chrome at 390×844 with touch emulation, the row comes to
  `scrollWidth == clientWidth == 360` with ~52px of slack in the spacer. The placeholder drops its
  `⏎ send · ⇧⏎ newline` hint whenever there is no real pointer (`(hover:none)`), because that hint
  alone wrapped the textarea to two lines on an iPhone and neither key exists there.

## Usage and limits

- A session is `running`, `done`, `failed`, `cancelled`, `imported` (found on disk, never run
  from here) or `unavailable` (its transcript is gone — restore skips these). Two turns cannot
  share a session and `devHub.maxConcurrentTurns` caps how many run at once; both are enforced
  by a claim taken before the process spawns, so a double Enter cannot start two.
- Tokens, cost and context come from the turn's `result` message.
- A Claude process that dies mid-turn is reported as **failed**, not done. A session still
  marked `running` when the window died is re-read on the next start, but only the part of the
  transcript **after its last user message** counts: scanning the whole file let an interrupted
  turn inherit the previous turn's `turn_done` and land as `done`. No marker there means
  `imported`. Recovery skips current active turns and holds a session claim while reading
  old transcripts, so it cannot overwrite a resumed turn.
- Long transcripts are read from the **tail** of the JSONL file, so the newest messages are the
  ones kept.
- **Rate limits arrive natively** in `rate_limit_event.unifiedWindows` — no scraping. Each event
  is the account's *whole* state: a window it omits is cleared (`null`), not kept, or a session
  that switched accounts shows the old account's 7d forever (a team plan has no 7d window at all).
- Context % comes from `usage.iterations`, the *last* API round of a turn: summing rounds
  overshoots the window (it once read 283%).

## Requirements

```bash
claude --version   # https://claude.com/claude-code
```

It must be on VS Code's `PATH` and already logged in.

### The CLI does not tell you it is out of date in here

A CLI installed with `npm install -g` cannot update itself when npm's global prefix is not writable
by the user, and the "update available" banner the CLI prints never reaches Dev Hub anyway: the
transport is `--output-format stream-json`, not a terminal, so anything the CLI writes for a human
is discarded. The result is a binary that silently stays on an old version for months.

So `devHub.cliUpdateCheck` (on by default) reads the installed version from `<cli> --version` and
asks `registry.npmjs.org` for the published one, at most once every six hours, cached in
`globalState`. When they differ, a status bar item appears — `$(arrow-up) claude 2.1.261 → 2.1.266`
— and clicking it runs **Dev Hub: Update Claude CLI**, which shows the exact
`npm install -g …@latest` line and only runs it in a terminal after you say so. Nothing is
installed behind your back, and a session already running keeps the old binary until it ends.

This is the **only outbound request the extension makes** — everything else is loopback or LAN —
which is why it is a setting rather than a fact of life. Turn it off and Dev Hub is fully offline
again. Every failure mode is silent by design: an unparseable `--version`, a binary that is not
installed, a registry that times out (3s) or answers with something unexpected all mean *no
warning*, because a false "you are out of date" is worse than none. Version comparison is numeric,
so `2.1.9` is correctly older than `2.1.10`.

## Install

```bash
npm run package
code --install-extension dev-hub-claude-codex-*.vsix --force
```

Then **Developer: Reload Window**: VS Code reads a manifest once per window, so a CLI install
does nothing until a reload.

## Remote — a host that never sleeps

The point of running Dev Hub anywhere but your laptop is that closing the lid must not end the
work. That rules out every arrangement where the extension host belongs to a *client*: the
extension has no `browser` entry point, so it needs a **Node extension host on the machine that
owns the CLIs, the project paths and the ports** — and that host has to exist with nobody looking
at it.

**What works: a real desktop VS Code on a headless box.** Not a tunnel, not `serve-web` — the
Linux `.deb`, running against a virtual display, as a system service. Since 0.29.17 activation
serves the mobile page by itself when `devHub.mobile.enabled` is on, so the box needs no click
after a restart: the service comes up, `onStartupFinished` wakes the extension, the page opens
its port, and a Cloudflare tunnel publishes that one port under one hostname. Verified on an
Ubuntu 24.04 mini PC: `hub.<domain>` answers `200` with the keypad and `/api/sessions` answers
`401` without the cookie, with no browser attached anywhere.

Four traps, each of which cost an hour:

- **`/usr/bin/code` is a launcher, not the app.** It starts Electron and exits `0`, so a
  `Type=simple` unit sees the service die and restarts it forever (29 times before anyone
  noticed). Point `ExecStart` at `/usr/share/code/code`.
- **A service has no session bus, no keyring and no user namespace.** Wrap it in
  `dbus-run-session`, pass `--no-sandbox --password-store=basic`, and set `DISPLAY` plus
  `XDG_RUNTIME_DIR=/run/user/<uid>` (which needs `loginctl enable-linger`).
- **The desktop install target is the ordinary one**: `~/.vscode/extensions` for the `.vsix`,
  `~/.config/Code/User/settings.json` for the settings — all three `devHub.mobile.*` are
  machine-scope, so user settings there are read. The passcode is read *per login attempt*, not
  at `start()`, so editing that file swaps it live (old code `401`, new code `204`).
- **Microsoft's CDN can be unreachable from a home link while your laptop downloads at 30MB/s.**
  A stalled server download is what a spinning *Downloading VS Code Server…* means; fetch the
  `.deb` (or server tarball) on the laptop and push it over the LAN instead of debugging the box.

Keep `devHub.mobile.lan` on if you also want the LAN door — the tunnel reaches `127.0.0.1`
either way — and remember what the passcode is worth: four digits with a lockout is protection
against the neighbour, not against the internet. A hostname pointed at this page is a hostname
pointed at a shell, so use the long form of `devHub.mobile.passcode` there, and put an identity
proxy (Cloudflare Access or equivalent) in front of it before treating the URL as private. The
lockout is keyed on the socket's remote address, which behind a tunnel is `127.0.0.1` for
*everybody* — one bucket, so a stranger guessing wrong can lock the owner out too.

**Two arrangements that do not work, so you can stop early.** `code tunnel` (vscode.dev) needs a
browser client: the extension host starts when a tab attaches and dies once it goes, taking the
page's port with it — the hostname went from `200` to `502` with nothing else changed. `code
serve-web` is worse: the `.vsix` installs, the server scans it (it appears in
`extensions.user.cache`) and the workbench HTML serves, but the extension never activates — no
`globalStorage` directory is ever created and the port never opens. Both are still fine for
*editing* on an iPad; neither can host an unattended page.

### If you do use a tunnel anyway

A tunnel is a **separate install target**. `code --install-extension` writes to
`~/.vscode/extensions`, which the tunnel server never reads; it has its own
`~/.vscode-server/extensions`, and Marketplace search cannot help because this extension is not
published. Install with the server's own CLI, and repeat it on every version bump — with an
**absolute** path to the `.vsix`: unlike `code`, `code-server` does not resolve a relative one
against the shell's working directory (it looked for the file under an unrelated folder and died
with `Failed Installing Extensions` / `code: 'Extract'`).

```bash
COMMIT=$(code --version | sed -n 2p)
~/.vscode/cli/servers/Stable-$COMMIT/server/bin/code-server \
  --install-extension "$PWD"/dev-hub-claude-codex-*.vsix --force
```

Then reload `https://vscode.dev/tunnel/<tunnel-name>`.

Storage is separate too — `context.globalStorageUri` resolves under
`~/.vscode-server/data/User/globalStorage/` — so a fresh tunnel install has no workspaces. Copy
`workspaces.json` across once and Recent rebuilds itself, because `discoverHistory()` re-reads
`~/.claude` on the same machine; Ports and Agents are discovered at runtime, and
pinned ports live in `globalState` per install. Do not symlink `sessions.json`: both stores cache
it in memory and rewrite it whole with no reload on external change, so two extension hosts
would clobber each other.

**On a phone.** Dev Hub does no layout thing for you — hide the sidebar yourself for a full-width
chat, and use **Zen Mode** for the activity bar, tab bar and status bar, which belong to the workbench. The panel
uses `100dvh` behind `@supports` and sizes itself from `visualViewport` when the keyboard is up,
since iOS does not shrink the layout viewport, and switches to touch-sized targets on
`hover:none`. That same signal is published as `body[data-keyboard="open"]`, which the mobile page
uses to drop the composer's `safe-area-inset-bottom`: with the keyboard up the visual viewport ends
above it, so there is no home indicator down there to avoid and the inset is pure dead space.

None of the mobile behaviour is verified on a real device. A blank panel on iOS is very likely
not Dev Hub at all: VS Code Web loads webview content into a cross-origin iframe on
`*.vscode-cdn.net` and registers a service worker inside it, which is exactly what WebKit is
restrictive about. It renders on iPad and not on iPhone, and *Request Desktop Site* on the phone
does not change that — so the mobile user agent is not the difference. Before chasing a Dev Hub
bug, open any other webview (an extension's detail page, *Markdown: Open Preview*): if those are
blank too, the webview host is what is not running there.

## Mobile web app — a page, not a webview

`devHub.mobile.enabled` turns on a **third** way in, and the only one that is not a VS Code
surface at all: the extension host serves the chat as an ordinary web page over HTTP on the
local network, and **Dev Hub: Open Mobile Web App** (`devhub.openMobileApp`) hands back
`http://<this machine's LAN IP>:<port>/` — a URL Safari on a phone sharing the Wi-Fi
opens directly, with no tunnel, no forwarding and no account anywhere.
Nothing about it is a webview, so the cross-origin iframe and the service worker WebKit will not
run on iPhone are simply not in the picture.

Once the setting is on, **activation serves the page again by itself** — the modal consent was
asked when it was turned on, so a window reload, a crash or a machine reboot must not be a silent
way for a saved phone bookmark to stop answering. The command is how you *enable* it and how you
get the URL; it is no longer the only thing that opens the port. This is what makes a headless
host usable at all: on a tunnel server nobody is sitting in front of the workbench to run a
command after every extension-host restart, which is also why `onStartupFinished` is in
`activationEvents` — without it the extension only wakes when its view or chat is opened, and on
a machine with no window that never happens. Turning the setting **off** still closes the port
immediately.

It is the same renderer, not a second one: the page loads the panel's own `chat.js` and
`chat.css` and speaks the same host protocol, only over a different pipe — **SSE** downstream,
`POST /api/msg` upstream. So transcripts, tool rows, the context donut, queued prompts,
approval cards and pasted images all behave as they do in the panel. One difference is in the
transcript itself: **the phone only gets the last 200 events**, and a *Load earlier* button at the
top asks for 200 more (`loadOlder`, mobile-only). This matters because iOS kills the SSE stream
whenever the tab goes to the background. Coming back means a new client, and that client used to
get the whole buffer again: up to 1500 events, uncompressed, rendered from scratch. The panel
never sends `older`, so it never shows the button. Two things are
mobile-only and live in `media/mobile/bridge.js`: the `pick*` messages that open a Quick Pick in
the panel open a bottom sheet instead (there is no workbench on a phone), and **Enter inserts a
newline instead of sending**, because on a phone that key is a return key and the send button is
right there. That one is a *subtraction* from the shared renderer, not an addition: `chat.js`
binds Enter-to-send on the textarea and the panel must keep it, so `bridge.js` takes a `keydown`
listener on `document` in the capture phase and calls `stopImmediatePropagation()` for `#input` —
the shared handler never runs, and because nothing calls `preventDefault()`, WebKit still types
the newline itself. Enter appears exactly once in `chat.js`; no menu or list navigation depends
on it. **History is not one of
those sheets** — 🕓 and a drag from the left edge open the same **left drawer**, because reaching
back into an earlier session is the thing done most on a phone and a sheet costs a stretch to the
top of the header first. The drawer lists **every** session, not the open project's: on a phone
there is no tree to the left, so this is the only way across repos, and each row already names its
project. The header's old `‹` button — touch-only, and a second door onto the same list — is gone
with it, along with the `back` message; the header at 390px gets that chip's width back. The drag only takes over once the finger is moving more horizontally than vertically
(chat contains code blocks that scroll sideways, and vertical scrolling must never be touched),
follows the finger, and settles on release: a **flick** faster than 250px/s goes the way the
finger went, and a finger that has stopped goes by the distance dragged — past 35% of the
drawer's width, in either direction. It is the distance *dragged*, not the drawer's position, so
closing costs the same nudge as opening; measuring position meant a shut needed a 60% drag back. In a **Safari tab** the left-edge gesture is the browser's own *back* and wins, so 🕓
stays the way in that always works — an installed home-screen app is where the drag is reliable. A sheet of 8 rows or more grows a **filter box**,
each keyword matched independently against the row's label *and* its description (so `chat admin`
finds `order-chatbot-admin-system`, and a workspace name finds every repo in it) — note WebKit
[279904](https://bugs.webkit.org/show_bug.cgi?id=279904) again: in an installed home-screen app
tapping that input may never raise the keyboard, so the filter is a convenience for a Safari tab
and scrolling stays the path that always works. Project rows are **one line** (the workspace name
is a note, right-aligned and the first thing to be ellipsized); only the session sheet stacks two
lines, because there its description is longer than its label. `media/mobile/mobile.css` supplies the
`--vscode-*` palette the workbench would normally inject.

Multiple phones and tabs can connect at once; each connection is its own tab with its own
selected session, and all of them drive the same `SessionManager` the panel and the tree see.
Queued prompts belong to the **session**, not to the connection, so a phone that loses Wi-Fi
mid-queue finds them again when it comes back — they used to live on the SSE client and die with
it, silently, after `/api/msg` had already answered `200`. An approval answered on one device
closes the card on the others.

A dropped connection reconnects and re-attaches the last session by itself — and *waits* for
the server to confirm that before flushing anything it queued while offline, because two POSTs
are two requests and a prompt that lands before the re-attach is a prompt with no session to run
in. Each message carries an id so a retry after a connection dropped mid-request runs once, not
twice, and the server handles one message per connection at a time rather than interleaving them.

### The passcode, and why the URL stopped carrying a token

`devHub.mobile.passcode` — **exactly 4 digits, or 8-128 non-space characters** — is the only thing
guarding the page, and it is **required**: with none set the command refuses to serve rather than
putting an unguarded shell on the Wi-Fi. Those two forms are two pages, chosen by the server from
the passcode itself. The 4-digit form is a keypad with **no submit button**, which sends as soon as
the code reaches that length; that is why the digit branch stays pinned to one length rather than a
range — a 5-digit code could never be typed in. `PASSCODE_RE` is exported and `mobileServer.test.ts`
runs the real keypad script to assert it fires at exactly that length, which is what keeps the two
from drifting apart again.

The long form exists because four digits is 10,000 tries and a page on a public hostname deserves
more than that; it draws a **text field and an Unlock button** instead, because the server must not
reveal the length by auto-submitting. The cost is the reason the keypad had no `<input>` in the
first place: in an iOS home-screen web app a text field does not focus and no keyboard appears, so
that branch leans on `autofocus` in the parsed HTML plus one `focus()` **inside the Unlock tap
handler**, and empty-plus-Unlock is deliberately a focus rather than a login attempt. **That path
is not verified on a real iPhone.** The way out needs no reinstall: set 4 digits again and the
keypad returns on the next load. An unauthenticated `GET /` answers a **keypad**, `POST /api/login` trades the right code
for the `devhub_mobile` cookie, and every other path still answers a bare `401` — the gate is on
one route, not on the API.

This replaced a token in the query string (`/?t=…`, swapped for a cookie by a `303`), which was
wrong for the way the page is actually used. The token was minted fresh on each activation and the
port defaulted to `0`, so **every Reload Window killed the saved link**; worse, Add to Home Screen
keeps the URL *after* the redirect, so an installed web app had no token at all and no way to get
one. The cookie is what a home-screen app can keep, so the page now only needs a way to hand one
out. The token still exists as the cookie's value, but it lives in `<globalStorage>/mobile-token`
(mode `600`) and survives restarts — **Dev Hub: Sign All Phones Out Of The Mobile Web App**
(`devhub.rotateMobileToken`) rewrites it, which is how a lost phone is revoked. The port stopped
moving for the same reason: `devHub.mobile.port` defaults to **39642**, so the whole URL — host,
port, no query — is a constant a home-screen app can keep. A pinned port can clash, and that is
the honest failure: a second window serving the page gets `EADDRINUSE` and a notification naming
the port, rather than quietly taking another one and breaking the link already on the phone.
Auto-start on activation retries `EADDRINUSE` for ~30 s before giving up: on **Reload Window** the
new extension host activates while the old one still holds the port, and a single attempt left the
page dead until the next reload (a real second window still fails, just 30 s later).
`0` restores the old drift, and the command says so when it is `0`.

The keypad is drawn with `<button>`s and contains **no `<input>` at all**. That is deliberate: in a
web app installed to the iOS home screen, tapping a text field does not focus it and never raises
the keyboard, while buttons work — so a login form built the obvious way is a login form that
cannot be used on the one client this page exists for.

Four digits is 10,000 tries, so **the lockout is the defence, not the code**: past five wrong
attempts a caller waits 30s, doubling to a 15-minute cap, counted per remote address, and the
comparison is `timingSafeEqual` over equal-length buffers (unequal lengths *throw* rather than
return false, so the length is checked first). It is protection against someone else on your
Wi-Fi, not against someone capturing packets — the code and the cookie cross plain HTTP like
everything else here.

**Treat the URL as a shell.** The page can start and steer Claude on this machine, and
continue a task-agent session (which can approve a plan),
which is why the command asks once, in a modal, before it enables anything. With
`devHub.mobile.lan` on — the default, because a phone is the point — the socket binds `0.0.0.0`,
so everyone on the same Wi-Fi can reach it and the passcode, travelling over plain HTTP, is the
only thing in the way: do not turn it on from a cafe or an office network, and turn the setting
**off** to bind `127.0.0.1` instead. Off is also the honest answer for a tunnelled window, where the
forwarder is what should reach the port. The LAN address comes from `lanAddress()`, which returns
a **private** range or nothing at all — never a public or VPN address, which an earlier fallback
would happily have put in the URL it copies to your clipboard — and the notification says which of
the two you got. Every request needs the `devhub_mobile` cookie, and the keypad above is the
only place that hands one out; the URL itself carries no secret, so nothing sensitive is left in
the address bar, the history or an outgoing referrer.
`/api/file` serves media files only — PNG/JPEG/GIF/WebP/MP4/MOV/WebM, by extension, checked both
before and after `realpath` (so an `x.png` symlink to `~/.ssh/id_rsa` dies) — from the attachment
folder, `~` and the temp dirs; anything else is refused. It answers `Range`
with 206, because iOS Safari will not play a `<video>` from a server that doesn't. `devHub.mobile.port` pins the port so the phone's bookmark keeps
working, and defaults to `39642`; `0` takes a free one each activation and breaks any saved URL.

Verified by tests that drive a real server over real HTTP, including one that calls in on the
machine's own LAN address rather than loopback and one that proves the LAN address is refused
when the setting is off. **Not** verified on a real iPhone. macOS asks
once whether to allow incoming connections for Code — say yes, or nothing outside answers.

**Add to Home Screen** is a supported way to open it, and the page carries what iOS needs for
that: a `manifest.webmanifest` with `display:standalone` (iOS 17.4+ reads the manifest;
`apple-mobile-web-app-capable` alone is the legacy path), and
`apple-mobile-web-app-status-bar-style: black-translucent` — without that meta the status bar is
painted white *and* `env(safe-area-inset-top)` reports `0`, which quietly turns the header's
safe-area padding into nothing. The manifest link needs `crossorigin="use-credentials"`: a
manifest is fetched with credentials omitted by default, and this page answers `401` to anything
without the token cookie, so a bare `rel="manifest"` is a manifest iOS silently drops.
`html` gets its own background because `chat.css` only paints `body`, and the status-bar strip in
standalone is `html`'s. Two `theme-color` metas cover light and dark since a manifest cannot
media-query; `background_color` (splash only) is therefore a single dark value.
The installed app's on-screen keyboard failing to appear on tap is
[WebKit 279904](https://bugs.webkit.org/show_bug.cgi?id=279904) — the input takes focus and
UIKit never presents the keyboard — and there is nothing on the page that fixes it.
Covered by a test that fetches the manifest and greps the metas; **not** verified on a real
iPhone.

*Open on phone…* at the bottom of the tree runs the same command, so the URL is one tap away.

An earlier fallback lived in the workbench chat view as `@devhub`. It is gone: the chat view
exposes no conversation id, so it could hold exactly one session at a time, with no per-turn
model picker and no images — limits that were not fixable from inside it. The web app replaces
it and has none of them. `git log` still has the code if the tunnel ever turns out to be the
harder path.

## Task agents — plan, approve, execute

Planner session identities include the daemon endpoint internally; HTTP still receives the original
conversation ID. Stored planner rows are normalized on load. Old tab IDs restore only when they
identify one daemon unambiguously. Session status refreshes preserve the tree ports/tasks caches;
explicit refresh still invalidates them.

An agent entry with `"kind":"http"` is a daemon that runs on its own — it scans a tracker, plans
work, and parks each plan waiting for a human. Dev Hub is its cockpit, not its runner: `start` /
`stop` / `logs` are still the entry's `make` targets, and everything else goes over the API named
by `endpoint` (or `devHub.planner.endpoint`).

```json
"devHub.agents": [
  { "name": "my-planner", "cwd": "~/code/my-planner", "kind": "http",
    "endpoint": "http://127.0.0.1:7341" }
]
```

- **Rows come from `GET /tasks`**, sorted by what needs a person: waiting for approval, then
  running, then broken, then the rest. The daemon's own status string is shown verbatim
  (`WAITING_APPROVAL`, `IMPLEMENTING`, `STALE`, …) — it is *not* mapped onto Dev Hub's five session
  statuses, because only two of them mean the same thing.
- **Clicking a task opens a chat tab** whose transcript is that task's state history plus its
  current plan, and whose conversation id is `task:<KEY>`. So each ticket keeps its own thread on
  the daemon side: ask why it picked a service, and it answers with that ticket's context.
  `Ask <name>…` sits at the **root** of the tree, not inside the agent — asking "what's on my
  plate?" is the most common thing you do, so it is never behind an expand. It is one fixed
  conversation id, so the daemon keeps its prompt cache, and `Dev Hub: Ask Task Agent` opens the
  same conversation from the command palette.
- **Everything is chat; the buttons are a shortcut.** The daemon gives its own chat agent the
  `planner_*` tools, so "ok do ABC-1" in a task tab approves it and a turn ending refreshes the
  tree by itself. The tree commands exist for the one thing chat cannot promise: they re-read the
  task and send the exact `plan_version` they just read, with no model between you and that number
  — the API refuses an approval aimed at any other version, and that is the point: an approval must
  name the plan a human actually read. Approve and
  Execute are behind modal confirms that name the version and the repos.
- A `409` from the daemon (approval against a stale version, a preflight that refuses because Jira
  or the repo moved) is surfaced as-is. It is an answer, not a failure to talk.
- **Task state is polled, not pushed.** The daemon logs state transitions to its own store but does
  not publish them on its event stream, so Dev Hub re-reads `/tasks` at most every 5s and refreshes
  every 15s while the rows are on screen — the daemon scans behind your back, so an inbox that looks
  idle is exactly the one that changes without you. The timer is re-armed only when the tree asks
  for those rows, so a hidden view or a collapsed agent stops polling on its own. A change you make
  *through the chat* needs no timer at all: the turn ending already refreshes the tree.
- The task session is written to the session store **only when you open it**, so an inbox of 40
  tickets does not become 40 rows under some project.
- **An empty inbox is a row, not silence** (`inbox empty`, with the endpoint next to it). It is the
  state a working daemon is in most of the time, and returning nothing made it look exactly like a
  daemon that had died or a tree still reading — which has its own row, `daemon unreachable`.
- **Planner streams by replacing, not by appending** (`assistant_view`). A `view` frame is one
  message the daemon edits in place — every ~1.5s it re-sends the *whole* partial plus a changing
  footer (`⏳ processing… 2s`, `🛠️ 2.8s · 18k/0k tok`) — so frame *n+1* contains frame *n* and
  `assistant_delta`, which only ever appends, printed the answer three times. Hence a second text
  event whose contract is *replace the open bubble*: the provider strips that footer (it is a
  progress indicator, and the panel already has a spinner), the webview redraws the streaming
  bubble from the frame instead of concatenating, and the event cache keeps only the newest of a
  run of them. `POST /chat`'s final reply is sent as one more `assistant_view` so it overwrites the
  bubble rather than duplicating it — the same reason Claude skips its final `assistant_message`
  once it has streamed deltas. A turn where no frame arrives (a daemon that never flushes
  `/stream`, or the 2s open timeout) still ends in a plain `assistant_message`, so the answer
  cannot be lost. Only Dev Hub changed for this; the daemon was already publishing the frames, and
  `view` is in its own `REPLACEABLE_KINDS`, which is the same statement from the other side.
  The stream is also still read for a `permission` frame, which nothing here can answer and is
  reported as a warning rather than left to time out into a denial nobody saw.
- **The transcript is state, not a log — so it is re-read every time you open the tab.** A planner
  transcript is `GET /conversations/{id}/messages` (the daemon's persisted turns) plus, for a task,
  its state history and current plan. All of that changes while no tab is open, and the panel's
  event cache only ever loaded a transcript *once*: a row opened while the ticket was still
  `ANALYZING` kept showing `no plan stored for KRP-… yet` until the extension host restarted, and
  the tree's ↻ (which only asks the daemon to re-read Jira) did not clear it. Opening a planner tab
  now reloads from the daemon and splices the fresh history in front of whatever was typed in that
  tab since — the live tail is kept because the daemon cannot replay it, and the reload is skipped
  while a turn is in flight, when the buffer is the only copy of the live events.
- **The daemon can speak first, and this is the only path where it does.** `providers/planner/
  plannerWatcher.ts` holds one SSE per `http` agent endpoint for the whole session and reconnects
  with backoff, because a scheduled wake-up (the daemon's own reminder loop) fires with no turn in
  flight and the provider's `/stream` is open only *during* a turn. It reads exactly one frame kind,
  `reminder_fired`, whose payload carries the finished reply — a `view` frame belongs to a turn's
  own stream (replaced in the bubble above, and there is no bubble to replace when no tab asked for
  a turn) and `message` is only the `⏳` placeholder. The reply is injected into the open tab
  (and the phone page) and announced through `devHub.notify`; with no tab open nothing is written to
  the cache, because the daemon still has the turn and the next open will read it back. The
  reconnect never gives up, so a daemon that is simply off would print a refused line every 30s
  forever — it logs the *transitions* instead: one line when the endpoint goes down, one when it
  comes back.
- **A task session remembers which daemon it came from** (`plannerEndpoint`). The session store is
  keyed by provider and native id, and `task:ABC-1` means something different on two daemons — so
  without it a resume went wherever `devHub.planner.endpoint` pointed, quietly. Two daemons holding
  the same key still share one store row; run one, or expect the titles to overwrite each other.
- **Stop marks a run blocked; it does not stop the worker.** `/runs/{id}/stop` writes
  `status='blocked'` and the executor does not re-read it between fix loops, so commits can still
  land after the row changes colour. Dev Hub says exactly that instead of "stopped". Cancelling a
  planner *chat* turn is the same shape of lie and gets the same treatment: a warning in the
  transcript, because `POST /chat` has no abort and the daemon has no cancel.
- **Execute has no client-side deadline.** `POST /tasks/{key}/execute` awaits the entire
  implementation — up to five fix loops, each a brain turn with a 1200s ceiling — so the old 120s
  timeout reported a failure while the daemon was still writing code, and invited a retry on top of
  a run that never stopped.
- The API has no auth because it is loopback-only. Two consequences: keep it that way, and be aware
  that a task session opened here is reachable from the **mobile web app** like any other session —
  which means anyone holding that URL can talk to the daemon, and the daemon's chat agent holds the
  `planner_*` tools, so that includes approving a plan. New planner chats cannot be *started* from
  the phone (there is no project to start one in), but an open one can be continued: the mobile
  protocol accepts `planner` for `openSession` and only for that.

## Permissions — read this

Claude runs with `--permission-prompt-tool stdio`, so approval prompts appear **in the panel**.
But the CLI still consults your global config first: if `~/.claude/settings.json` sets
`permissions.defaultMode: "auto"` or allow-lists `Bash`/`Edit`/`Write`, those tools run
**without ever asking**.

| `devHub.claude.permissionMode` | Effect |
|---|---|
| `""` (default) | inherit your global Claude config |
| `"plan"` | read-only analysis |
| `"manual"` | anything not allow-listed asks in the panel instead of running silently |
| `"bypassPermissions"` | no checks at all — sandbox only |

A pending prompt is **always** answered, because the CLI blocks until it hears back: closing the
tab, disposing the panel, the turn ending, or a timeout all send an explicit deny. The timeout
is five minutes for a tool approval and an hour for a question a human has to answer — the
difference between "nobody is at the keyboard" and "this is a conversation". A request arriving
with no tab open is denied at once and leaves a warning, because a silent deny is
indistinguishable from a tool that never ran.

Prompts travel over **stdin**, never `argv`, so they never appear in `ps` and are not capped by
`ARG_MAX`.

## How each CLI is driven

| | Claude |
|---|---|
| Transport | one long-lived process, `--print --input-format stream-json --output-format stream-json --verbose` (see note) |
| Streaming | `--include-partial-messages` (token deltas) |
| Prompt | stdin JSON, echoed back by `--replay-user-messages` |
| Session id | Dev Hub mints it, passed as `--session-id` |
| Images | path in the prompt |
| Resume | `--resume <id>` |
| Model / effort | `--model` / `--effort` |
| System prompt | `--append-system-prompt` |
| Permissions | `--permission-prompt-tool stdio` |
| Rate limits | `rate_limit_event` |
| Model list | settings |
| Slash commands | `system init`, cached in `globalState` |

Dev Hub mints Claude's session id up front and passes it as `--session-id`. The manager can
still **rekey** the store, the event buffer and the open tab from a `pending:` placeholder when a
turn's handle reveals a different id mid-stream.

`--print` is in that argv for the record, not as a fix. The CLI's help says the stream-json flags
"only work with `--print`", but `-p` is only one way into non-interactive mode — its own help adds
"or when stdout is not a TTY, e.g. piped", which a spawned process always is. Measured against
`claude 2.1.268`, both argvs behave identically: same duplex stream-json event sequence, two turns
on one process, exit 0, and `cache_read_input_tokens` in the 30k range on the second turn either
way. So do not read `--print` as the thing that makes stream-json or vendor prompt caching work —
dropping it changes nothing, and neither does adding it.

The spawner sets `utf8` on the child's stdout and stderr before splitting lines; without it a
multi-byte character landing across two chunks decodes as two broken halves.

Keeping one Claude process alive removes ~1.2 s of start-up per turn and is what makes approval
prompts possible at all. Idle sessions are closed after `devHub.claude.sessionIdleMinutes`
because each holds a live `claude` process — see [docs/PERFORMANCE.md](PERFORMANCE.md) for
what that costs.

Tearing that process down is **not** the same event as the user pressing stop, and until v0.29.53
both set one `closing` flag. A stop is a finished turn: the manager writes `cancelled` and the
webview already shows why. A reclaim — the idle timeout, or the extension shutting down — can land
on a turn that is still running, and resolving it cleanly made the manager write `done` with no
error event and therefore not one line on screen explaining it. The flag now carries the intent
(`'interrupt' | 'reclaim'`), and a reclaim over a live turn fails it with a stated reason.

A stop also has to reach what the CLI spawned. `child.kill()` signals the `claude` process and
nothing else, and the CLI runs every `Bash` in a process group of its own, so `kill(-pgid)` misses
it too — a backgrounded command kept running long after the turn that started it was stopped, and
each session's MCP servers leaked the same way. `ProcessRunner.cancel` now snapshots the descendant
pids by `ppid` **before** signalling the parent (once the parent dies they are re-parented and there
is no way back to them), then SIGTERMs that list and SIGKILLs whatever is still alive 800 ms later.

That per-chat process also means a per-chat **MCP tree**: the CLI loads its own MCP configuration,
Dev Hub passes nothing about it, and each `claude` process starts its own copy of every server
configured — a stdio server such as `@playwright/mcp` is two extra Node processes per open chat.
`devHub.claude.mcp: "none"` passes `--strict-mcp-config` with no `--mcp-config` alongside it,
which is the CLI's way of loading no servers at all; `"inherit"` (the default) passes nothing and
a chat behaves like a terminal session. It is read at activation, like the other spawn settings,
so open chats keep what they were spawned with until a **Developer: Reload Window**.

### Claude sub-agents stream on the same pipe, and their result arrives late

A Claude `Agent` call is **backgrounded by default**. Three things follow, and all three were
rendering wrong before v0.29.51:

1. The child's whole stream comes out of the *same* stdout, tagged only by `parent_tool_use_id`.
   Merged into the main flow, the child's prose reads as the parent's, and — worse — every tool
   row the child emits lands between two `text_delta`s of the parent. `chat.js` appends a delta
   only when the streaming bubble is still `lastElementChild`, so each interruption closes that
   bubble and opens a new one: one answer arrives as five bubbles split **mid-word**
   (`… the drift is in the de` / `sign.`). `ClaudeEventParser` now drops every event carrying
   `parent_tool_use_id`.
2. The `tool_result` for the `Agent` call returns in the first second with internal metadata
   (`Async agent launched successfully…`), not an answer. Closing the row on it showed a
   multi-minute review as finished-and-empty. That result is suppressed for any call seen in
   `task_started`.
3. The real output only ever arrives on `system` events the parser ignored entirely:
   `task_started` → `task_progress` (`last_tool_name`, `tool_uses`, `duration_ms`) →
   `task_notification` (`status`, `summary`, `output_file`). They all carry the parent's
   `tool_use_id`, so they update that one `Agent` row in place — progress while it runs, the
   child's summary when it lands.

Recorded from real stdout of `claude --print --output-format stream-json --verbose
--include-partial-messages`; `task_started` is emitted *before* the placeholder `tool_result`,
which is what makes suppression by id possible.

Two follow-ons, both fixed in v0.29.52. A `task_notification` can arrive for a `tool_use_id` this
process never issued — the CLI replays one on resume for a task the *previous* process left
running — so `task_*` is accepted only for an id already seen here; otherwise it builds a fresh row
mid-stream, which is the same split this section is about. And not every `type:"user"` row in a
transcript is something the user typed: the CLI writes its own user turns to talk to the model
(`<task-notification>…`, `Continue from where you left off.`). They carry `origin.kind` ≠ `human`
or `isMeta`, and `loadClaudeTranscript` skips them. Rows from older CLI builds carry **no**
`origin` at all, so absence must not be read as injected — across all of `~/.claude/projects` the
only kinds observed are `human`, `task-notification` and `peer`.

Skipping the user half leaves the *reply* to it, which v0.29.53 removes. "Continue from where you
left off." is answered by an assistant row whose model is `<synthetic>` and whose text is "No
response requested." — drawn as prose it reads like the message you just sent being refused. It
cannot be filtered on the model, because every genuine API failure is `<synthetic>` too (rate
limit, 402, 403, 529, a dropped connection, an oversized image) and all of those must stay
visible. The flag that separates them is `isApiErrorMessage`: across `~/.claude/projects`, of 135
synthetic rows the 116 without it were all this one sentence, and all 19 other shapes carried it.
The flag alone is not enough on stdout, though: a local command (`/context`, `/usage`) answers in
stream-json as a `<synthetic>` row without the flag, and the transcript never records it — so the
filter matches the exact sentence, or `/context` ends in a blank turn.

That injected pair is written to the transcript only. Measured against the real CLI 2.1.272 on a
resumed session with a cut turn: the continuation turn never reaches stdout and emits no `result`
of its own, so it cannot end the turn in flight — it is a rendering question when a tab is
re-opened, nothing more.

### A background command reports back after the turn is over

A `Bash` with `run_in_background` ends the turn immediately; its `tool_result` is a receipt
(`Command running in background with ID: …`), not output. What the model says next — "I'll report
once it's done" — is a promise **the CLI keeps by itself**, and until v0.29.54 Dev Hub threw the
answer away.

Recorded from real stdout of the exact argv above, with a `sleep 12` backgrounded and the turn
allowed to end:

```
[ 7.0s] result/success                   <- turn over
[17.6s] system/background_tasks_changed  tasks: []
[17.6s] system/task_updated              status: completed
[17.6s] system/task_notification         tool_use_id, output_file
[17.6s] system/init                      <- the CLI opens a turn of its own
[21.7s] assistant                        "Background task completed (exit code 0)…"
[21.8s] result/success
```

Nobody typed anything. The CLI enqueues a `<task-notification>` into its own queue and runs a
reporting turn off it — the same mechanism the TUI shows as `queue-operation enqueue` / `remove`.

Dev Hub received all of it and dropped it. `pump()` keeps reading stdout between turns, but the
sink it wrote to belonged to a `ProviderTurnHandle` whose async generator had already returned at
`result`, and `SessionManager.consume` had already written `done`. So the row for the background
command stayed open forever, the report never rendered, and asking the chat about it got "I already
reported" — from the model's side of the transcript, it had.

`ClaudeSession` now tracks whether a turn is in flight and routes anything outside one to a
session-level `idleSink`; `SessionManager.ingestOutOfTurn` publishes those on the same `event`
emitter every other event uses, so the panel, the mobile page and the event cache need no change.
It flips the session to `running` for the duration and back to `done`, which is also what lets a
queued prompt flush afterwards. Two consequences worth knowing: **a turn no longer ends for good at
`result`**, so `isBusy()` counts these (otherwise a prompt sent during one collides with it), and
they take no concurrency slot because Dev Hub did not start them and cannot refuse them.

Stop had to learn it too, and until v0.29.56 it silently did nothing on one of these turns.
`SessionManager.cancel` looked the session up in `active`, which only holds turns Dev Hub itself
started; an out-of-turn one is not in there, so the call returned, the CLI kept working and the tab
kept spinning with no way to stop it short of killing the process by hand. It now falls back to
`AgentProvider.interruptOutOfTurn` — optional, Claude-only for now — which reaches the
`ClaudeSession` still holding the process, and then writes `cancelled` on the same serialized queue
`ingestOutOfTurn` writes on, or the last `running` event lands on top of it.

The idle timer had to learn the same thing. `devHub.claude.sessionIdleMinutes` starts counting when
a turn ends, so a background job longer than it — a render, an image batch — had its process
reclaimed before the report could arrive. While `background_tasks_changed` reports a non-empty
list, the timer re-arms instead of closing the session.

That was only half of it. The list empties the moment the task finishes, which is exactly when the
CLI opens its reporting turn — and that turn is not in the provider's `busy` set, so the timer
closed the process in the middle of it. Real transcripts show it: reporting turns killed exactly
1800 s and 3600 s after the last user turn, the running `Bash` recorded as `Exit code 137` (the CLI
SIGKILLs its children on the way out), and the tab spinning forever, because no event ever closed
the turn and `SessionManager` kept it in `outOfTurn` — `isBusy()` true, the queue never flushed.
`ClaudeSession.selfTurn` now mirrors `ingestOutOfTurn`'s own definition (an out-of-turn event opens,
`turn_done`/`error` closes); the timer re-arms while it is set, and a process that dies with it set
emits an `error` so the session lands on `failed` instead of `running`. A stop is the exception:
`cancelOutOfTurn` already writes `cancelled`.

### A sub-agent row is labelled by what it was asked to do

Claude's own sub-agent arrives as an ordinary tool call named `Agent` (formerly `Task`), so it
needs no parser branch — but its input carries only `description`/`subagent_type`/`prompt`, none of
the fields the tool label falls back on, so every spawn used to render as `Agent (Agent)`. The
label is now the description plus the agent type.

### Artifacts are off until this extension asks for them

The CLI decides whether the `Artifact` tool exists from *how it was started*. Driven the way Dev
Hub drives it — `--input-format stream-json`, a host answering permission prompts — it classifies
itself as an SDK session and withholds the tool, which is why the same `claude` binary publishes a
page from your terminal and quietly writes a local HTML file here instead. The CLI reads
`CLAUDE_CODE_ARTIFACT` before that default: truthy opts back in, falsy turns artifacts off
everywhere. `devHub.claude.artifacts` (default `true`) sets it to `1` on every Claude chat this
extension spawns; turning the setting off passes **no** variable at all, leaving the CLI's own
default in place rather than forcing artifacts off. Publishing still goes through the normal
permission request, so a chat cannot upload a page without the usual approval.

## First run

A fresh install has nothing to show, and the people most likely to stall are the ones who have never
installed a CLI. On activation Dev Hub runs `claude --version` and `claude auth status --json` (JSON,
exit 1 when signed out) and puts one row at the top of the tree: **Install Claude Code…**, **Log in to
Claude Code…** or **Add your first project…**. Every row runs `devhub.getStarted`, which moves to the
next missing step:

- **Install** offers the commands from the official setup page (installer script, Homebrew/WinGet,
  npm) and types the chosen one into a terminal **without pressing Enter**: an installer piped from
  the internet runs only after the user has read it. Dev Hub then polls every 4 s for 15 minutes.
- VS Code captures `PATH` at launch, so a CLI the installer just put in `~/.local/bin` is invisible to
  it. With the default `devHub.claude.executable` (`claude`), Dev Hub also looks in `~/.local/bin`,
  `/opt/homebrew/bin`, `/usr/local/bin` and `~/.claude/local`. A configured path or wrapper is never
  second-guessed. A CLI found only after activation needs **Reload Window**, which Dev Hub offers,
  because the provider keeps the executable it was built with.
- **Log in** runs `claude auth login` (browser sign-in) and polls until `auth status` says signed in.
  The free claude.ai plan does not include Claude Code, and the prompt says so.
- **Add project** creates a workspace named `Projects` when there is none, then opens the folder
  picker.

A turn that fails with the CLI's "Not logged in · Please run /login" is rewritten in the chat: `/login`
does not work over stream-json, so the message points at **Dev Hub: Get Started** instead, and a
notification offers **Log in** (at most once a minute).

## Commands

| Command | Title | Key |
|---|---|---|
| `devhub.getStarted` | Get Started |  |
| `devhub.searchProject` | Search Project & Start Chat | `cmd+alt+j` |
| `devhub.addWorkspace` | Add Workspace |  |
| `devhub.renameWorkspace` | Rename Workspace |  |
| `devhub.addProject` | Add Project |  |
| `devhub.removeProject` | Remove Project |  |
| `devhub.switchClaudeAccount` | Switch Claude Account (project right-click, status bar; on the phone: Project sheet → ⇄ Claude account…) |  |
| `devhub.newClaudeChat` | New Claude Chat |  |
| `devhub.openChat` | Open Chat |  |
| `devhub.refreshHistory` | Refresh History |  |
| `devhub.stopSession` | Stop Running Session |  |
| `devhub.revealProject` | Reveal Project in Finder/Explorer |  |
| `devhub.renameSession` | Rename Chat (session right-click, or double-click the row) |  |
| `devhub.copySessionId` | Copy Native Session ID |  |
| `devhub.showMoreSessions` | Show More Sessions |  |
| `devhub.openPort` | Open Port in Browser |  |
| `devhub.copyPort` | Copy Port |  |
| `devhub.pinPort` | Pin Port |  |
| `devhub.unpinPort` | Unpin Port |  |
| `devhub.killPort` | Kill Process on Port |  |
| `devhub.startAgent` | Start Agent |  |
| `devhub.stopAgent` | Stop Agent |  |
| `devhub.restartAgent` | Restart Agent |  |
| `devhub.openAgentLogs` | Open Agent Logs |  |
| `devhub.revealAgent` | Reveal Agent Folder |  |
| `devhub.nextRunning` | Next Running Session | `cmd+shift+]` |
| `devhub.previousRunning` | Previous Running Session | `cmd+shift+[` |
| `devhub.focusView` | Focus Sidebar | `cmd+k cmd+a` |
| `devhub.showMoreAgentThreads` | Show More Agent Threads |  |
| `devhub.copyAgentThreadId` | Copy Agent Thread ID |  |
| `devhub.askAgent` | Ask Task Agent |  |
| `devhub.openPlannerSession` | Open Planner Session |  |
| `devhub.plannerApprove` | Approve Plan |  |
| `devhub.plannerReject` | Reject Plan |  |
| `devhub.plannerExecute` | Execute Approved Plan |  |
| `devhub.plannerDismiss` | Dismiss Task |  |
| `devhub.plannerRevive` | Watch Again |  |
| `devhub.plannerRefreshTask` | Refresh Task From Tracker |  |
| `devhub.plannerStopRun` | Stop Task Run |  |
| `devhub.copyJiraKey` | Copy Task Key |  |
| `devhub.openMobileApp` | Open Mobile Web App |  |
| `devhub.updateCli` | Update Claude CLI |  |

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `devHub.claude.executable` | `"claude"` | Binary name or absolute path; must be on VS Code's `PATH` |
| `devHub.claude.altAccountFile` | `""` | Roots (one path per line) that run on a second Claude account. Dev Hub only edits the file; the wrapper in `claude.executable` reads it against `pwd -P` and picks the token. Switching marks the project's live processes, which respawn with `--resume` on their next turn — same path as a model change |
| `devHub.claude.altAccountName` / `devHub.claude.defaultAccountName` | `"Alt"` / `"Default"` | Labels on the status bar account button |
| `devHub.maxConcurrentTurns` | `4` | Ceiling on turns running at once across every session |
| `devHub.history.maxFilesPerProvider` | `1500` | Bound on the native history scan, per provider |
| `devHub.claude.permissionMode` | `""` | Passed to `claude --permission-mode` |
| `devHub.claude.model` | `"opus"` | Default Claude model for new chats |
| `devHub.claude.effort` | `"medium"` | Default Claude effort for new chats |
| `devHub.claude.models` | `["opus", "sonnet", "haiku", "fa…` | Choices offered in the Claude model picker |
| `devHub.claude.appendSystemPrompt` | one-line preamble request | Appended to Claude's system prompt (`--append-system-prompt`); empty leaves it untouched |
| `devHub.claude.sessionIdleMinutes` | `30` | Close an idle Claude session's process after this many minutes |
| `devHub.claude.promptCacheTtl` | `""` | Optional vendor prompt-cache TTL (`5m` or `1h`); empty inherits Claude Code's default and is separate from the process idle timeout |
| `devHub.agents` | `[]` | Long-running terminal bots shown under **Agents** |
| `devHub.planner.endpoint` | `"http://127.0.0.1:7341"` | Loopback API used for an `http` agent's chat turns; a per-agent `endpoint` overrides it |
| `devHub.claude.autoCompact` | `"auto"` | Passed to `claude --autocompact` |
| `devHub.claude.mcp` | `"inherit"` | `none` starts a Claude chat with no MCP servers (`--strict-mcp-config`) |
| `devHub.claude.artifacts` | `true` | Spawn the CLI with `CLAUDE_CODE_ARTIFACT=1` so a chat here can publish artifacts |
| `devHub.notify` | `"background"` | Notify when a turn finishes or a tool needs approval |
| `devHub.agentNames` | `{}` | Friendly names for the raw Slack ids an agent thread reports, e |
| `devHub.cliUpdateCheck` | `true` | Warn in the status bar when the installed `claude` is behind npm |

`devHub.agents` and `devHub.claude.executable` are **machine-scoped**: they name commands this
machine runs, so a repo's `.vscode/settings.json` cannot supply them. Dev Hub also declares no
support for untrusted workspaces — it spawns CLIs, so there is nothing useful it could do there.

Model lists live in settings because new models ship faster than this extension
gets rebuilt. Neither applies to a task agent: the daemon picks its own model and Dev Hub sends it
no options at all. Effort levels stay in code — they are fixed CLI flags: Claude takes
`low|medium|high|xhigh|max`.

## System prompts

Dev Hub does **not** own the agent's system prompt, and never replaces one:

- **Claude** — only `--append-system-prompt`, and only when `devHub.claude.appendSystemPrompt`
  is set. It ships with a default: one line saying what Claude is about to do before a group of
  tool calls, because the thinking text that would otherwise fill that silence is redacted by
  the API. From Opus 5.5 that line comes back as a `thinking` block *with* text rather than a
  `text` block (real reasoning stays empty), so the parser renders a non-empty `thinking` block
  as an assistant row — skip it and the turn is silent again. `--system-prompt`, which would *replace* the built-in prompt, is never passed. Per `claude --help` the prompt snapshot is on by default, so a conversation
  records its prompt once and reuses it verbatim on every resume until compaction: **resuming an
  old chat after a CLI upgrade keeps the prompt it started with** — start a new chat for a newer
  one. `--append-system-prompt` would turn that snapshot off, so Dev Hub passes
  `--system-prompt-snapshot on` alongside it: a new chat records a snapshot that already
  contains the appended text, and an existing chat keeps the prompt it was born with — the
  appended text reaches it only after a compaction.

## Development

```bash
npm run compile
npm test                                        # node --test dist/test/devhub/*.test.js
npm run package
node scripts/measure-webview.js HEAD <old-rev>  # webview layout/heap in real Chrome via CDP
node --expose-gc scripts/measure-host.js        # extension-host CPU/heap on real history
node scripts/audit-sessions.js --days 1         # audit past agent sessions from the CLIs' own transcripts
node scripts/audit-sessions.js --since <ISO>    # ...from a fixed baseline instead of a rolling window
```

`audit-sessions.js` answers "did the agents actually do the job" without opening every tab. It
reads the CLIs' own transcripts, never `sessions.json` — that store holds metadata and not one
character of content. Per session it reports turns, aborted turns, commands and how many failed,
files touched, tokens, and every sub-agent with whether it ever reported finishing. A `!` marks a
session worth a second look. The id it prints is the one the chat header's `ID` chip copies, so
`--id <that>` goes straight from a suspicious chat to its numbers. Use `--since` rather than
`--days` after changing anything that affects what is being measured: a rolling window silently
mixes the old behaviour's sessions into the verdict.

Rows marked `↳sub` are a sub-agent's own thread. A forked child rollout replays its parent's whole
history — `task_started` and every command with it — and the replayed records land within a
millisecond or two of the fork, so there is no clean cut between the two. Those rows therefore show
only what is unambiguous (cut turns, errors, tokens) rather than a turn count that would silently
be the parent's as well.

**A sub-agent with no completion is the signal to read first.** On Codex it means the child was
killed when its turn's process exited; on Claude it means the turn was cut before the agent
reported back.


The webview's CSS and JS live in `media/webview/chat.css` and `chat.js` as ordinary files. The
host reads and inlines them at `html()` time: the CSP is `default-src 'none'`, and
`localResourceRoots` opens the attachment folder and — for media the agent
names in its reply — `~` and the temp dirs. Events carry paths, turned into `asWebviewUri` at post
time, so the host's cache keeps short paths rather than bytes. Everything else the webview needs is inlined.
Paths resolve from `__dirname`, which lands on the extension root both from the repo and inside
the `.vsix`.

Tests are hermetic — no live CLI, network or VS Code. `vscode` is stubbed through `Module._load`;
provider tests drive fake CLI scripts that speak the real stream-json protocol.
`webviewRuntime.test.ts` **executes the webview script** against a fake DOM and drives every
message type, key press and control.

Two traps worth knowing. Where the fake DOM diverges from a real one, whole paths stop being
tested **with nothing failing**: `classList` as a `Set` separate from `className` made every
streaming test exercise "open a new bubble" instead of "append to the open one". And the script
really runs in the **viewer's** browser, not Node — a RegExp lookbehind parses here and is a
`SyntaxError` on WebKit before Safari 16.4, killing the whole panel script, so
`webviewScript.test.ts` greps the shipped script for `(?<`.

Numbers — webview layout counts, extension-host CPU and heap, what the child CLIs actually hold
— live in [docs/PERFORMANCE.md](PERFORMANCE.md).

## Layout

```
src/devhub/
  agents/                     terminal-bot status, thread reading, task rows
  providers/claude/           spawn, stream parsing, history discovery
  providers/planner/          an HTTP daemon as a provider: no process, just its API
  sessions/                   session manager, event cache, history reconciler
  storage/                    atomic JSON stores (workspaces, sessions, unsent queues)
  views/                      tree provider, chat webview, status bar
  workspace/                  project resolution
```

History files are cached by `mtime`+`size`: a warm rescan of ~2,000 transcripts reads **0 bytes**
instead of ~122 MB. Tree lookups are indexed rather than filtered, and chat state and DOM are
capped at 1,500 events.

## Attribution

The icons in `media/` are original to this project; no Anthropic brand assets are shipped.

## License

MIT — see [LICENSE](../LICENSE).
