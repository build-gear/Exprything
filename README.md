# Exprything

A canvas that coding agents draw on **once**, and that keeps itself fresh afterwards with no further AI calls.

Claude Code or Codex writes *recipes* (how to get data, how often, how to transform it, how to show it) through MCP or the `exp` CLI.
A local daemon runs those recipes on schedule, records their history, and pushes updates to the canvas in your browser.

See [docs/DESIGN.md](docs/DESIGN.md) for the full design.

## Quick start

Requires Node 22.13+ and pnpm.

```bash
pnpm install
pnpm build          # builds the canvas UI the daemon serves
pnpm exp open       # starts the daemon in the background and opens the canvas
```

Connect an agent (its MCP server starts the daemon when needed):

```bash
pnpm exp connect claude     # Claude Code
```

```bash
pnpm exp connect codex      # Codex
```

This registers Exprything through the agent's own CLI (`claude mcp add-json --scope user`, `codex mcp add`), for every project. Add `--activity` to also see what the agent does (see [Agent activity](#agent-activity)); `pnpm exp connect` alone shows what is connected. The **Agents** button on the canvas does the same. New agent sessions pick up the change.

Then ask, for example: *"Draw a repo pulse canvas for this repo: commits per day, TODO count trend, recent commits."*

Keep the daemon running across reboots (macOS):

```bash
pnpm exp service install
```

## Try the example without an agent

Edit `cwd` in [examples/repo-pulse.json](examples/repo-pulse.json) to point at a git repository, then:

```bash
pnpm exp apply -f examples/repo-pulse.json --dry-run   # run every source once, show samples
pnpm exp apply -f examples/repo-pulse.json
pnpm exp approve commits-daily                        # exec recipes need a one-time approval
pnpm exp open repo-pulse
```

## CLI

| Command | |
|---|---|
| `exp open [canvas]` | open a canvas in the browser |
| `exp apply -f <file> [--dry-run]` | apply sources/nodes (same payload as the MCP `canvas_apply` tool) |
| `exp push <source> [--lines] [--replace]` | pipe data into a push source, e.g. `make 2>&1 \| exp push build --lines` |
| `exp status` | freshness, approvals and errors of every source |
| `exp approve <source>` | allow an exec source to run on schedule |
| `exp refresh <source>` | run a source now |
| `exp selection [canvas]` | what you have selected on an open canvas (by default the one you used last), as agents see it |
| `exp connect [claude\|codex] [--activity\|--no-activity]` | connect Claude Code or Codex (MCP server, and optionally activity hooks); with no agent, show what is connected |
| `exp disconnect <claude\|codex>` | remove Exprything from an agent: its MCP server and activity hooks |
| `exp catalog` | widget catalog and authoring guide |
| `exp daemon start\|stop\|run` | manage the daemon |
| `exp service install\|uninstall` | run the daemon at login (launchd) |
| `exp mcp` | MCP server over stdio |

State lives in `~/.exprything` (override with `EXPRYTHING_HOME`); the daemon listens on `127.0.0.1:7717` (`EXPRYTHING_PORT`).

## Canvas

The canvas is [Excalidraw](https://github.com/excalidraw/excalidraw): people can draw shapes, text and arrows around the live widgets, and drawings are saved to `~/.exprything/drawings/`.
Widgets stay owned by agent recipes: moving or resizing one pins it, deleting one is undone.
Until a widget has a value (a new or changed recipe), the whole widget is drawn as a skeleton of its own layout by [Skullet](https://skullet.lochie.me). It shimmers while the recipe runs and holds still under the banner while it waits for approval.
Agents can read what you select (MCP `canvas_selection`, `exp selection`): widgets by node id, and the shapes, text and arrows you drew, so you can point at something and ask about "this".
Switch canvases from the menu in the top-left corner; the top-right corner shows the canvas's sources and any that await approval or repair.
The Excalidraw renderer is still a spike (see [docs/research/excalidraw.md](docs/research/excalidraw.md), section 10.5).

### Style

Widgets can look like Excalidraw shapes. `style` uses Excalidraw's element properties, on a node or as the canvas default in the apply request:

```jsonc
{ "canvas": "repo-pulse",
  "style": { "roughness": 1, "fontFamily": "hand" },
  "ops": [{ "op": "node.upsert", "node": { "id": "todos", "type": "stat", "source": "todo-count",
    "style": { "strokeColor": "#1971c2", "backgroundColor": "#a5d8ff", "fillStyle": "hachure" } } }] }
```

- Excalidraw draws the frame (`strokeColor`, `backgroundColor`, `fillStyle`, `strokeWidth`, `strokeStyle`, `roughness`, `roundness`, `opacity`) around the widget.
- `fontFamily` (`hand`, `normal`, `code`) and `strokeColor` restyle the widget's content; with `roughness` above 0, bar and line charts are drawn by hand with rough.js.
- People can restyle a widget's frame from Excalidraw's style panel. Fields they change are pinned and agent updates keep them.
- `exp catalog` (MCP `catalog_get`) lists the fields and Excalidraw's palette.

## Agent activity

`exp connect claude --activity` (or **Turn on** in the AI sidebar's settings) adds hooks to Claude Code (`~/.claude/settings.json`) or Codex (`~/.codex/hooks.json`) that report what the agent does: sessions starting and ending, prompts, tool calls and their results, approval requests, and Codex's token counts. The `agent-activity` canvas shows the sessions that are working or waiting for you, the tools they use, and a timeline.

- Only what a monitor needs leaves the hook: a tool's name and what it worked on (a command's first line, a file path, a pattern or URL), whether it succeeded and how long it took, a prompt's length. Prompts, file contents, tool output and transcripts stay with the agent.
- Hooks run in the background, print nothing and always succeed, and never start the daemon. Events from while it was down wait in `~/.exprything/agent-events.spool.jsonl` until it starts. Events are kept 30 days.
- Codex runs new hooks only after you trust them: open `/hooks` in Codex.
- Recipes can read the events too: a source of kind `agent` gives recent events, or one row per session with its state (`"view": "sessions"`).
- `EXPRYTHING_ACTIVITY=off` silences the hooks in one shell; `exp connect claude --no-activity` removes them.

## Layout

```
packages/
  schema/   zod schemas + widget catalog — the shared contract
  daemon/   exprythingd: canvas store, source scheduler, history (SQLite), HTTP + WebSocket API
  client/   HTTP client for the daemon
  mcp/      MCP tools over the client
  cli/      `exp` command (also hosts `exp mcp`)
  ui/       Excalidraw canvas + widgets (ECharts, tables, stats, logs, markdown)
examples/   sample recipes
```

UI development with hot reload: run a daemon (`pnpm exp daemon start`), then `pnpm dev:ui` and open the Vite URL with `#/c/main?token=<~/.exprything/token>`.
