# Performance — measured, not guessed

Every number here came out of a script in `scripts/`, run against the real `~/.claude` and
`~/.codex` on this machine. They are recorded so a later change can be compared against
something instead of a feeling.

```bash
node scripts/measure-webview.js HEAD <old-rev>  # webview layout/heap in real Chrome via CDP
node --expose-gc scripts/measure-host.js        # extension-host CPU/heap on real history
```

## One window per workspace

One VS Code window, several agents running across unrelated workspaces, all visible at once.
Opening one window per workspace costs roughly **1 GB each** (measured: ~756 MB shared plus
~900–1280 MB per window); Dev Hub keeps 30+ projects reachable from a single window.

## Webview

`scripts/measure-webview.js` drives the real shipped script in headless Chrome over CDP and
reports `Performance.getMetrics`. `LayoutCount` is the number that matters: reading
`scrollHeight` straight after a DOM write forces a synchronous layout, so "N events → N
layouts" is the signature of thrash. Measured at 1500 events (the UI cap):

| path | v0.20.1 | current |
| --- | --- | --- |
| open a transcript | 582 ms, 1501 layouts | 37 ms, 2 layouts |
| stream 1000 events | 490 ms, 1001 layouts | 162 ms, 1 layout |

Heap stays ~1.3 MB either way; the win is layout, not memory. The one memory fix that did
move a number is the bounded stderr queue: 200k stderr lines from a long-lived CLI held
71 MB of heap before, 23 MB after (2 MB over a 21 MB baseline).

### Extension host

`node --expose-gc scripts/measure-host.js` runs what `activate()` actually does against the
real `~/.claude` and `~/.codex`. Measured over 1,150 Claude + 536 Codex sessions:

| step | wall | CPU | heap allocated | heap retained |
| --- | --- | --- | --- | --- |
| `discoverHistory` claude, cold | 409 ms | 559 ms | 34 MB | 2.8 MB |
| `discoverHistory` codex, cold | 118 ms | 164 ms | 41 MB | 1.2 MB |
| both again, `mtime+size` cache warm | 63 ms | 87 ms | 21 MB | 0.3 MB |
| `reconcile` + `buildTreeModel` | 1 ms | 3 ms | 1 MB | 0 MB |
| `loadTranscript`, 2,444 events | 36 ms | 44 ms | 21 MB | 2.6 MB |

CPU above wall on the cold scan is `mapLimit(files, 8, …)` using more than one core. So Dev
Hub costs roughly **0.5 s of CPU once** when the sidebar first opens, ~90 ms per refresh, and
**~4 MB of retained heap** for the whole session index. Read `retained`, not `allocated`:
process RSS reaches ~630 MB in that harness purely because V8 does not return the arena after
churning ~140 MB of short-lived read buffers.

The extension-host process itself measured 124 MB RSS at 0.8% CPU, but that number is shared
with every other installed extension and cannot be attributed to one.

**Memory actually lives in the child CLIs.** Measured live, five `claude` processes spawned by
Dev Hub held 120, 139, 240, 247 and 270 MB — 1,015 MB together — and three of them belonged
to turns that had already finished, still inside `devHub.claude.sessionIdleMinutes`.

**Memory actually lives in the child CLIs.** Measured live, five `claude` processes spawned by
Dev Hub held 120, 139, 240, 247 and 270 MB — 1,015 MB together — and three of them belonged to
turns that had already finished, still inside `devHub.claude.sessionIdleMinutes`. That is why
idle sessions are closed at all.

History files are cached by `mtime`+`size`: a warm rescan of ~2,000 transcripts reads **0
bytes** instead of ~122 MB.
