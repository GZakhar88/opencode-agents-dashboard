# OpenCode Dashboard

A real-time browser-based Kanban board that visualizes agent activity in [OpenCode](https://opencode.ai). Watch beads (tasks) move through agent stages -- from ready to done -- as AI agents work on them. Columns are generated dynamically based on your configured agents.

## Installation

1. Add the plugin to your OpenCode config:

```json
// opencode.json
{
  "plugin": ["opencode-dashboard"]
}
```

OpenCode will install the plugin automatically on next launch.

2. Run the setup command to install slash commands and (optionally) agent definitions:

```bash
npx opencode-dashboard setup
```

This will prompt you to choose between global (`~/.config/opencode/`) or per-project (`.opencode/`) installation. It copies the `/dashboard-start`, `/dashboard-stop`, and `/dashboard-status` commands, plus the shipped agent definitions. Existing files are never overwritten.

## Usage

### Start the Dashboard

Use the slash command in OpenCode:

```
/dashboard-start
```

Or use the CLI directly:

```bash
npx opencode-dashboard start
```

The dashboard will be available at `http://localhost:3333`.

### Check Status

```
/dashboard-status
```

Or via CLI:

```bash
npx opencode-dashboard status
```

### Stop the Dashboard

```
/dashboard-stop
```

Or via CLI:

```bash
npx opencode-dashboard stop
```

### Custom Port

```bash
npx opencode-dashboard start --port 4000
```

Or set the `DASHBOARD_PORT` environment variable.

## How It Works

The dashboard has three components:

```
OpenCode Plugin (plugin/index.ts)
       |
       |  POST /api/plugin/event
       v
  Bun Server (server/index.ts)
       |
       |  SSE /api/events
       v
  React Dashboard (dist/)
```

1. **Plugin** -- An OpenCode plugin that hooks into agent lifecycle events, discovers configured agents, tracks bead state via `bd list --json`, and pushes structured events to the server. Registers custom tools (`dashboard_start`, `dashboard_stop`, `dashboard_status`, `dashboard_open`) for controlling the dashboard from within OpenCode.
2. **Server** -- A Bun HTTP server that aggregates state from connected plugins, persists it to disk, serves the dashboard frontend, and broadcasts updates to browser clients via Server-Sent Events (SSE).
3. **Dashboard** -- A React SPA that renders a dynamic Kanban board with real-time updates, animated card transitions, and connection resilience.

### Kanban Columns

Columns are generated dynamically based on your configured agents. Three fixed columns are always present:

| Column | Description |
|--------|-------------|
| Ready | Open beads not yet claimed by an agent |
| Done | Bead closed successfully |
| Error | Bead blocked, failed, or abandoned |

Agent columns appear between Ready and Done, one per discovered agent. For example, if you have `orchestrator`, `pipeline-builder`, `pipeline-reviewer`, and `pipeline-committer` agents configured, the board will show columns for each of them. Column colors are pulled from the agent's frontmatter `color` field when available.

## Development

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Node.js](https://nodejs.org) >= 18 (for Vite dev server)
- [OpenCode](https://opencode.ai) with plugin support
- A project using [bd (beads)](https://github.com/anomalyco/beads) for issue tracking

### Setup

```bash
git clone https://github.com/gaborzakhar/opencode-dashboard.git
cd opencode-dashboard
bun install
```

### Running Locally

Start the server and frontend dev server in separate terminals:

```bash
# Terminal 1: Start the Bun server
bun run server

# Terminal 2: Start the Vite dev server
bun run dev
```

Open `http://localhost:5173` in your browser. The Vite dev server proxies `/api/*` to the Bun server at `localhost:3333`.

### Testing Locally (before npm publish)

To test the plugin with OpenCode before publishing to npm, symlink the project into OpenCode's plugin cache:

```bash
# 1. Build the frontend
bun run build

# 2. Symlink into OpenCode's plugin cache
ln -sf "$(pwd)" ~/.cache/opencode/node_modules/opencode-dashboard

# 3. Add to your OpenCode config
# opencode.json
{
  "plugin": ["opencode-dashboard"]
}
```

OpenCode will resolve `opencode-dashboard` from the symlinked local directory on next launch. To remove later:

```bash
rm ~/.cache/opencode/node_modules/opencode-dashboard
```

### Testing

```bash
bun test
```

| File | What it tests |
|------|---------------|
| `src/hooks/useBoardState.test.ts` | Board state reducer -- all 13 SSE event handlers |
| `src/hooks/useEventSource.test.ts` | SSE connection, backoff, retry logic |
| `src/lib/format.test.ts` | Formatting utilities (elapsed time, priority labels) |
| `server/state.test.ts` | Server state manager (event processing, persistence) |
| `server/routes.test.ts` | HTTP route handlers (register, event, heartbeat) |
| `server/sse.test.ts` | SSE client management and broadcasting |
| `server/diffBeadState.test.ts` | Bead snapshot diffing algorithm |

### Building

```bash
bun run build        # Build the frontend (outputs to dist/)
bun run build:check  # Run TypeScript type checking
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3333` | Port for the dashboard server |
| `DASHBOARD_DEBUG` | (unset) | Set to `1` to enable verbose plugin logging to stderr |

## Project Structure

```
opencode-dashboard/
├── agents/                     # Shipped agent definitions (optional install)
│   ├── orchestrator.md
│   ├── pipeline-builder.md
│   ├── pipeline-refactor.md
│   ├── pipeline-reviewer.md
│   └── pipeline-committer.md
├── commands/                   # Slash commands (installed via setup)
│   ├── dashboard-start.md
│   ├── dashboard-stop.md
│   └── dashboard-status.md
├── plugin/
│   └── index.ts                # Main plugin entry (npm distribution)
├── server/
│   ├── index.ts                # Server entry point (Bun.serve)
│   ├── routes.ts               # HTTP route handlers (7 endpoints)
│   ├── sse.ts                  # SSE client management & broadcasting
│   ├── state.ts                # State manager (events -> state, persistence)
│   ├── pid.ts                  # PID file management
│   └── PLUGIN_EVENTS.md        # Event reference documentation
├── shared/
│   └── types.ts                # Shared TypeScript types
├── bin/
│   └── cli.ts                  # CLI entry (npx opencode-dashboard)
├── src/                        # React frontend source
│   ├── main.tsx
│   ├── App.tsx
│   ├── hooks/                  # SSE connection, board state reducer
│   ├── components/             # Kanban board, cards, columns
│   └── lib/                    # Utilities, constants, API client
├── plugins/
│   └── dashboard-bridge.ts     # Local dev plugin (not published)
└── dist/                       # Built frontend (generated by vite build)
```

## API Reference

### Plugin API (used by the OpenCode plugin)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/plugin/register` | Register a plugin instance |
| `POST` | `/api/plugin/event` | Push an event |
| `POST` | `/api/plugin/heartbeat` | Send heartbeat |
| `DELETE` | `/api/plugin/:id` | Deregister a plugin |

### Dashboard API (used by the frontend)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/state` | Full board state as JSON |
| `GET` | `/api/events` | SSE stream for real-time updates |
| `GET` | `/api/health` | Server health check |

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **Frontend:** [React 19](https://react.dev), [TypeScript](https://www.typescriptlang.org) 5.7
- **Build:** [Vite](https://vite.dev) 6
- **Styling:** [Tailwind CSS](https://tailwindcss.com) 3.4, [shadcn/ui](https://ui.shadcn.com)
- **Animation:** [Framer Motion](https://www.framer.com/motion/) 11.15
- **State:** React `useReducer` with SSE-driven updates
- **Transport:** Server-Sent Events (SSE) with exponential backoff

## Troubleshooting

### Dashboard shows "No projects connected"

- Verify OpenCode is running with the plugin installed.
- Check that agents are configured (in `opencode.json`, `.opencode/agents/`, or `~/.config/opencode/agents/`). Enable debug logging: `DASHBOARD_DEBUG=1 opencode`.
- Confirm the server is reachable: `curl http://localhost:3333/api/health`.

### Beads not showing on the board

- Ensure the project uses `bd` for issue tracking (`bd list` should return issues).
- The plugin runs `bd list --json` to discover beads. If `bd` is not installed or not initialized in the project, no beads will appear.

### Server state persists across restarts

The server saves state to `server/.dashboard-state.json`. Delete this file to start fresh:

```bash
rm server/.dashboard-state.json
```

## License

[MIT](LICENSE)
