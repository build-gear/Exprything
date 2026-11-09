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

## Desktop app (macOS)

```bash
pnpm desktop:dist    # packages/desktop/release/: Exprything-<version>-arm64.dmg, and the .app in mac-arm64/
```

The app shows your canvases in its own window and opens on the one you had open last. It attaches to a running daemon, or starts one in the background with your login shell's `PATH`, so exec recipes find the same commands as your terminal. Quitting the app leaves the daemon running and recipes keep refreshing; stop it with `exp daemon stop`.

It carries its own daemon, CLI and MCP server, so it needs no Node install. The first time it finds Claude Code or Codex it connects it, so the agents you run yourself can draw on your canvases too; activity reporting stays off. **Help > Connect an Agent…** opens the AI sidebar's settings, and **Disconnect** there sticks. Agents run Exprything through `~/.exprything/bin/exp`, which the app points at itself whenever it starts, so moving the app does not break them. By hand:

```bash
claude mcp add --scope user exprything -- ~/.exprything/bin/exp mcp
```

The build is not notarized, so on another Mac the first launch needs right-click > Open. macOS also asks before Exprything's recipes or AI sidebar read your Desktop, Documents or Downloads folder; until you allow it (System Settings > Privacy & Security > Files and Folders), commands there hang until they time out.

macOS ties that answer to the app's signature. The build is ad-hoc signed by default, and an ad-hoc signature changes with every build, so macOS asks again after each install. To keep your answer across updates, add a signing identity once:

```bash
pnpm desktop:signing-identity
```

It puts a self-signed certificate in your login keychain, and `pnpm desktop:dist` signs with it from then on. The first build asks whether `codesign` may use the key: enter your login password and choose Always Allow, or macOS asks again for every file. macOS asks about the folders once more after the switch, then keeps your answer.

`pnpm desktop` runs it from source; with `EXPRYTHING_DESKTOP_URL=http://localhost:5173` it loads the Vite dev server for hot reload.

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
Switch, create and delete canvases from the menu in the top-left corner; the top-right corner shows the canvas's sources and any that await approval or repair. Deleting a canvas also deletes its drawing, its conversations and any sources no other canvas reads, and cannot be undone.
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

The canvas and the desktop app's menus follow your browser's or Mac's language: Korean, or English otherwise. Hangul in the UI is set in [Poor Story](https://fonts.google.com/specimen/Poor+Story) by YoonDesign (SIL Open Font License 1.1).

## AI sidebar

**AI** at the top right of the canvas, or ⌘J, opens Claude Code or Codex beside the canvas. Pick the agent and talk to it there; it reads and draws on the canvas you have open with Exprything's tools, which it gets for that conversation without `exp connect`.

- Conversations start in `~/.exprything/workspace`, and there is no folder to pick. To work on a project, tell the agent where it is: its own permission rules apply, and macOS asks about your Desktop, Documents and Downloads folders as usual.
- Select widgets or shapes and say "this": what you selected goes along with your message (take it off with ×), and the agent works from that, even if you select something else after sending.
- It is your own CLI, with your login, settings and permission rules. When those say to ask, the request shows in the sidebar with **Allow** and **Deny**. Exprything's own canvas tools never ask.
- The daemon runs the agent, so a conversation keeps going when you close the window, and each canvas keeps its conversations (`~/.exprything/chats/`). They are the agent's own sessions too: `claude --resume` in that folder and Codex's history list them.
- **■** stops the current turn. An agent left idle for 10 minutes stops and picks the session up again with your next message.
- The sidebar needs no setup. Its settings (the sliders icon) are for the agents' own sessions, such as in your terminal: they do what `exp connect` does and turn on activity reporting.

## Agents on the canvas

While Claude Code or Codex works on a canvas you have open, you see its cursor there, with its name, and you cannot touch what it is changing.

- The cursor shows up when the agent reads the canvas or your selection, goes to what it is changing, and leaves about 10 seconds after its last call. When that is out of view, the cursor waits at the edge of the canvas.
- A dry run reserves what it touches: the widgets it writes or removes, the widgets reading a source it writes, and the places new widgets will land. They stay reserved until the agent applies for real and you have seen the change land, or for 20 seconds if it never does.
- Clicks, drags, right-clicks and widget buttons on what is reserved do nothing, and it leaves your selection; the selection comes back afterwards unless you selected something else. Panning and zooming still work, and a drag you already started is yours to finish.
- Agents can change what is drawn, not only widgets: they create, edit and delete shapes, text and arrows (`drawing.upsert` and `drawing.delete` in `canvas_apply`). Labels and arrows stay with what they belong to, and with the canvas open, ⌘Z takes back an agent's change.
- It works for agents on MCP and for `exp` run from an agent's shell. `exp` in your own terminal shows no cursor. Nothing about it is saved.

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

## License

[MIT](LICENSE). Dependencies keep their own licenses; Poor Story, the Hangul UI font, is under the SIL Open Font License 1.1.
