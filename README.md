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

Connect an agent (the MCP server starts the daemon if needed):

```bash
claude mcp add exprything -- node /absolute/path/to/Exprything/packages/cli/bin/exp.js mcp
```

```bash
codex mcp add exprything -- node /absolute/path/to/Exprything/packages/cli/bin/exp.js mcp
```

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
| `exp catalog` | widget catalog and authoring guide |
| `exp daemon start\|stop\|run` | manage the daemon |
| `exp service install\|uninstall` | run the daemon at login (launchd) |
| `exp mcp` | MCP server over stdio |

State lives in `~/.exprything` (override with `EXPRYTHING_HOME`); the daemon listens on `127.0.0.1:7717` (`EXPRYTHING_PORT`).

## Canvas

The canvas is [Excalidraw](https://github.com/excalidraw/excalidraw): people can draw shapes, text and arrows around the live widgets, and drawings are saved to `~/.exprything/drawings/`.
Widgets stay owned by agent recipes: moving or resizing one pins it, deleting one is undone.
The previous React Flow canvas is still available from the switch in the header while the Excalidraw renderer is a spike (see [docs/research/excalidraw.md](docs/research/excalidraw.md), section 10.5).

## Layout

```
packages/
  schema/   zod schemas + widget catalog — the shared contract
  daemon/   exprythingd: canvas store, source scheduler, history (SQLite), HTTP + WebSocket API
  client/   HTTP client for the daemon
  mcp/      MCP tools over the client
  cli/      `exp` command (also hosts `exp mcp`)
  ui/       Excalidraw canvas (React Flow fallback) + widgets (ECharts, tables, stats, logs, markdown)
examples/   sample recipes
```

UI development with hot reload: run a daemon (`pnpm exp daemon start`), then `pnpm dev:ui` and open the Vite URL with `#/c/main?token=<~/.exprything/token>`.
