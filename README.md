# OpenCode Dashboard

A real-time browser-based Kanban board that visualizes multi-agent pipeline workflows in [OpenCode](https://opencode.ai). Watch beads (tasks) move through agent stages — from backlog to done — as AI agents work on them.

## Architecture

The dashboard has three components:

```
OpenCode Plugin (dashboard-bridge.ts)
       │
       │  POST /api/plugin/event
       ▼
  Bun Server (server/index.ts)
       │
       │  SSE /api/events
       ▼
  React Dashboard (src/)
```

1. **Plugin** — An OpenCode plugin that hooks into agent lifecycle events, tracks bead state via `bd list --json`, and pushes structured events to the server.
2. **Server** — A Bun HTTP server that aggregates state from connected plugins, persists it to disk, and broadcasts updates to browser clients via Server-Sent Events (SSE).
3. **Dashboard** — A React SPA that renders an 8-column Kanban board with real-time updates, animated card transitions, and connection resilience.

### Kanban Columns

| Column | Description |
|--------|-------------|
| Backlog | Open beads not yet claimed |
| Orchestrator | Bead claimed, orchestrator planning |
| Builder | `pipeline-builder` agent implementing |
| Refactor | `pipeline-refactor` agent improving code |
| Reviewer | `pipeline-reviewer` agent reviewing |
| Committer | `pipeline-committer` agent committing |
| Done | Bead closed successfully |
| Error | Bead blocked, failed, or abandoned |

## Prerequisites

- [Bun](https://bun.sh) >= 1.0 (runtime for the server and tests)
- [Node.js](https://nodejs.org) >= 18 (for Vite dev server and build)
- [OpenCode](https://opencode.ai) with plugin support (for the bridge plugin)
- A project using [bd (beads)](https://github.com/anomalyco/beads) for issue tracking

## Setup

### 1. Install Dependencies

```bash
bun install
```

This installs all dependencies for the server, client, and shared types. The project uses a single `package.json` — no separate install steps needed.

### 2. Install the OpenCode Plugin

Copy the bridge plugin to your OpenCode plugins directory:

```bash
cp plugins/dashboard-bridge.ts ~/.config/opencode/plugins/
```

> **Note:** The plugin contains a hardcoded `SERVER_PATH` pointing to the server entry point. If you cloned this repository to a different location, update the `SERVER_PATH` constant in the plugin file to match your path:
>
> ```typescript
> const SERVER_PATH = "/path/to/opencode-dashboard/server/index.ts";
> ```

The plugin activates lazily — it stays dormant until it detects an orchestrator agent or the user runs `/dashboard` in OpenCode.

### 3. Configure the Server Port (Optional)

The server defaults to port `3333`. To use a different port, set the `DASHBOARD_PORT` environment variable:

```bash
DASHBOARD_PORT=4000 bun run server
```

If you change the port, also update:
- `SERVER_URL` in `plugins/dashboard-bridge.ts`
- The proxy target in `vite.config.ts` (under `server.proxy["/api"].target`)

## Running

You need two processes running: the server and the frontend dev server.

### Start the Server

```bash
bun run server
```

This starts the Bun server on `http://localhost:3333`. You should see:

```
[dashboard-server] Running on http://localhost:3333
[dashboard-server] PID: 12345
[dashboard-server] Endpoints:
  POST   /api/plugin/register
  POST   /api/plugin/event
  POST   /api/plugin/heartbeat
  DELETE /api/plugin/:id
  GET    /api/state
  GET    /api/events
  GET    /api/health
```

### Start the Frontend Dev Server

In a separate terminal:

```bash
bun run dev
```

This starts the Vite dev server on `http://localhost:5173`. The Vite config proxies `/api/*` requests to the Bun server at `localhost:3333`, so the dashboard and server work together seamlessly.

Open `http://localhost:5173` in your browser to view the dashboard.

### Start OpenCode

In a separate terminal, start an OpenCode session in a project that uses `bd` for issue tracking. The bridge plugin will auto-start the dashboard server if it's not already running, register with it, and begin streaming events.

```bash
opencode
```

If the plugin doesn't auto-activate, you can manually trigger it by typing `/dashboard` in the OpenCode prompt.

## Production Build

To build the React dashboard for production:

```bash
bun run build
```

This runs TypeScript type checking (`tsc -b`) followed by `vite build`. Output goes to the `dist/` directory.

To preview the production build:

```bash
bun run preview
```

## Testing

All tests use Bun's built-in test runner.

### Run All Tests

```bash
bun test
```

### Test Files

| File | What it tests |
|------|---------------|
| `src/hooks/useBoardState.test.ts` | Board state reducer — all 13 SSE event handlers |
| `src/hooks/useEventSource.test.ts` | SSE connection, backoff, retry logic |
| `src/lib/format.test.ts` | Formatting utilities (elapsed time, priority labels) |
| `server/state.test.ts` | Server state manager (event processing, persistence) |
| `server/routes.test.ts` | HTTP route handlers (register, event, heartbeat) |
| `server/sse.test.ts` | SSE client management and broadcasting |
| `server/diffBeadState.test.ts` | Bead snapshot diffing algorithm |

### Verifying Everything Works

Run this sequence to confirm the full stack is operational:

```bash
# 1. Run all tests
bun test

# 2. Check TypeScript compilation
npx tsc --noEmit

# 3. Run the production build
bun run build

# 4. Start the server and check the health endpoint
bun run server &
curl http://localhost:3333/api/health
# Expected: {"status":"ok","uptime":0,"plugins":0,"sseClients":0}

# 5. Check the SSE endpoint is streaming
curl -N http://localhost:3333/api/events
# Expected: SSE stream with "connected" and "state:full" events

# 6. Start the dev server and open the dashboard
bun run dev
# Open http://localhost:5173 — you should see "No projects connected"
```

Once OpenCode is running with the bridge plugin, beads will appear on the board and move between columns as agents process them.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3333` | Port for the Bun server |
| `DASHBOARD_DEBUG` | (unset) | Set to `1` to enable verbose plugin logging to stderr |

## Project Structure

```
opencode-dashboard/
├── index.html                  # Entry HTML (dark mode by default)
├── package.json                # Scripts, dependencies
├── vite.config.ts              # Vite config (proxy, aliases)
├── tailwind.config.ts          # Tailwind CSS config (shadcn/ui theme)
├── tsconfig.json               # TypeScript config (app)
├── tsconfig.node.json          # TypeScript config (Vite/Node)
│
├── shared/
│   └── types.ts                # Shared TypeScript types (server + client)
│
├── server/
│   ├── index.ts                # Server entry point (Bun.serve)
│   ├── routes.ts               # HTTP route handlers (7 endpoints)
│   ├── sse.ts                  # SSE client management & broadcasting
│   ├── state.ts                # State manager (events → state, persistence)
│   ├── *.test.ts               # Server tests
│   └── PLUGIN_EVENTS.md        # Event reference documentation
│
├── src/
│   ├── main.tsx                # React entry point
│   ├── App.tsx                 # Main layout (ErrorBoundary, SSE wiring)
│   ├── globals.css             # Global styles, CSS variables, animations
│   ├── hooks/
│   │   ├── useBoardState.ts    # State reducer (13 SSE event handlers)
│   │   ├── useBoardState.test.ts
│   │   ├── useEventSource.ts   # SSE connection with auto-reconnect
│   │   └── useEventSource.test.ts
│   ├── components/
│   │   ├── Board.tsx           # 8-column Kanban board (LayoutGroup)
│   │   ├── Column.tsx          # Single column with ScrollArea
│   │   ├── BeadCard.tsx        # Animated bead card (Framer Motion)
│   │   ├── ProjectSection.tsx  # Collapsible project container
│   │   ├── PipelineHeader.tsx  # Pipeline title + status badge
│   │   ├── StatusIndicator.tsx # Connection status dot
│   │   ├── ElapsedTime.tsx     # Live elapsed timer
│   │   ├── LoadingSkeleton.tsx # Loading placeholder
│   │   ├── ErrorBoundary.tsx   # React error boundary
│   │   ├── ReconnectBanner.tsx # Reconnection status banner
│   │   └── ui/                 # shadcn/ui primitives
│   └── lib/
│       ├── constants.ts        # Column configs, priority colors
│       ├── format.ts           # Formatting utilities
│       ├── format.test.ts
│       ├── styles.ts           # Shared style constants (FOCUS_RING)
│       ├── utils.ts            # cn() utility (clsx + tailwind-merge)
│       └── api.ts              # API client helpers
│
├── plugins/
│   ├── dashboard-bridge.ts     # OpenCode plugin (production)
│   └── dashboard-spike.ts      # Proof-of-concept plugin (development)
│
└── .beads/                     # Bead issue tracking data
```

## Tech Stack

- **Runtime:** [Bun](https://bun.sh) (server, tests, package management)
- **Frontend:** [React 19](https://react.dev), [TypeScript](https://www.typescriptlang.org) 5.7
- **Build:** [Vite](https://vite.dev) 6
- **Styling:** [Tailwind CSS](https://tailwindcss.com) 3.4, [shadcn/ui](https://ui.shadcn.com)
- **Animation:** [Framer Motion](https://www.framer.com/motion/) 11.15
- **Icons:** [Lucide React](https://lucide.dev)
- **State:** React `useReducer` with Map-based state
- **Transport:** Server-Sent Events (SSE) with exponential backoff reconnection

## API Reference

### Plugin API (internal, used by the OpenCode plugin)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/plugin/register` | Register a plugin instance `{ projectPath, projectName }` |
| `POST` | `/api/plugin/event` | Push an event `{ pluginId, event, data }` |
| `POST` | `/api/plugin/heartbeat` | Send heartbeat `{ pluginId }` |
| `DELETE` | `/api/plugin/:id` | Deregister a plugin |

### Dashboard API (used by the React frontend)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/state` | Full board state as JSON |
| `GET` | `/api/events` | SSE stream for real-time updates |
| `GET` | `/api/health` | Server health check |

## Troubleshooting

### Dashboard shows "No projects connected"

- Verify OpenCode is running with the bridge plugin installed.
- Check that the plugin detected the orchestrator. Enable debug logging: `DASHBOARD_DEBUG=1 opencode`.
- Confirm the server is reachable: `curl http://localhost:3333/api/health`.

### Dashboard shows "Unable to connect to server"

- Ensure the server is running: `bun run server`.
- Check the port matches between `vite.config.ts` proxy and the server.
- Look for port conflicts: `lsof -i :3333`.

### Plugin not activating

The plugin stays dormant until it detects either:
1. An orchestrator agent (`input.agent === "orchestrator"` in `chat.message` hook)
2. A manual `/dashboard` command in OpenCode

If neither triggers, the plugin won't connect to the server and no events will flow.

### Beads not showing on the board

- Ensure the project uses `bd` for issue tracking (`bd list` should return issues).
- The plugin runs `bd list --json` to discover beads. If `bd` is not installed or not initialized in the project, no beads will appear.

### Server state persists across restarts

The server saves state to `server/.dashboard-state.json`. On restart, it loads this file and marks all projects as disconnected (plugins must re-register). Delete this file to start fresh:

```bash
rm server/.dashboard-state.json
```

## License

Private project.
