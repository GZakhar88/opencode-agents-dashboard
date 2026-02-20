# OpenCode Agent Dashboard - Project Plan

## Overview

A real-time browser-based dashboard that visualizes the multi-agent pipeline workflow as a Kanban board. It shows beads (tasks) moving through agent stages in real-time, without manual browser refresh. Supports multiple concurrent OpenCode instances across different projects.

---

## Motivation & Current Workflow

### Spec-Driven Development with Beads

The current workflow uses [Beads](https://github.com/steveyegge/beads) (`bd` CLI) for task tracking in a spec-driven development approach:

1. **Planning phase**: A feature or plan is described, then an agent creates beads for each development step
2. **Execution phase**: The orchestrator agent is told "work on the next beads"
3. **Pipeline processing**: The orchestrator picks up beads one-by-one (via `bd ready`, `bd update --claim`) and distributes work to sub-agents (builder, refactor, reviewer, committer)
4. **Sequential processing**: One bead goes through all stages before the next is picked up

### The Problem

There is no visibility into what agent is working on what bead at any given time. The only way to check is to look at the terminal output. The goal is a browser dashboard that provides a live, visual overview of the entire pipeline.

---

## Current OpenCode Configuration

### Agents

| Agent | File | Mode | Model | Role |
|-------|------|------|-------|------|
| **orchestrator** | `agents/orchestrator.md` | `all` | `claude-sonnet-4.5` | Top-level coordinator, has `bd *` permissions, dispatches to sub-agents |
| **pipeline-builder** | `agents/pipeline-builder.md` | `subagent` (hidden) | `claude-opus-4.6` | Implements features, writes code |
| **pipeline-refactor** | `agents/pipeline-refactor.md` | `subagent` (hidden) | `claude-opus-4.6` | Improves code quality on changed files |
| **pipeline-reviewer** | `agents/pipeline-reviewer.md` | `subagent` (hidden) | `claude-opus-4.6` | Reviews, finds bugs, writes tests, fixes issues |
| **pipeline-committer** | `agents/pipeline-committer.md` | `subagent` (hidden) | `claude-haiku-4.5` | Creates git commit with conventional message |
| **designer** | `agents/designer.md` | `all` | (default) | UI/UX design agent with Figma integration |

> **Note**: The `pipeline-orchestrator.md` (subagent version) is NOT used for bead-driven work. It lacks `bd *` permissions. Only the top-level `orchestrator.md` agent is relevant for this dashboard.

### Pipeline Flow

```
Orchestrator (bd ready -> bd claim -> dispatches stages -> bd done)
  |
  +--> [designer]          (OPTIONAL - only for UI/UX tasks)
  +--> pipeline-builder    (REQUIRED - implements the feature)
  +--> pipeline-refactor   (OPTIONAL - improves code quality)
  +--> pipeline-reviewer   (REQUIRED - reviews and fixes issues)
  +--> pipeline-committer  (REQUIRED - creates git commit)
```

### Orchestrator Bash Permissions

```yaml
permission:
  bash:
    "*": deny
    "git diff*": allow
    "git status*": allow
    "bd *": allow
```

### Other Config

- **MCP Servers**: Context7 (remote, for library documentation)
- **Custom Tools**: `figma` tool (connects to local Figma fetcher service)
- **Skills**: `figma-designer` skill
- **Commands**: `/pipeline` command (uses the subagent orchestrator, not relevant here)
- **Plugin SDK**: `@opencode-ai/plugin` v1.1.60 installed

---

## OpenCode Capabilities (Research Summary)

### Server API (`opencode serve`)

- Full HTTP API with OpenAPI 3.1 spec at `/doc`
- SSE real-time events at `GET /event` (first event is `server.connected`, then all bus events)
- CORS support via `--cors` flag
- Authentication via `OPENCODE_SERVER_PASSWORD`
- Key endpoints:
  - `GET /session` - list all sessions
  - `GET /session/:id` - get session details
  - `GET /session/:id/children` - list child sessions (sub-agent sessions)
  - `GET /session/:id/message` - list messages in a session
  - `GET /session/:id/todo` - get todo list for a session
  - `GET /session/status` - get status for all sessions
  - `GET /agent` - list all available agents
  - `GET /event` - SSE stream for real-time events

### Plugin System

Plugins are JS/TS modules placed in `~/.config/opencode/plugins/`. They hook into events:

**Relevant events for the dashboard:**
- `chat.message` - first message in a session (used for context injection)
- `tool.execute.before` / `tool.execute.after` - intercept tool calls (bash, task, etc.)
- `session.created` - new session (including child sessions from sub-agents)
- `session.compacted` - session context was compacted (re-inject context)
- `session.status` - agent status changes (active, idle, etc.)
- `session.idle` - agent finished work
- `session.updated` - session metadata changed
- `todo.updated` - todo list changes

**Plugin context provides:**
- `project` - current project info
- `client` - OpenCode SDK client (`@opencode-ai/sdk`)
- `$` - Bun shell API (can run `bd` commands directly)
- `directory` - current working directory
- `worktree` - git worktree path

### SDK (`@opencode-ai/sdk`)

- Type-safe JS/TS client for the OpenCode server
- `createOpencodeClient({ baseUrl })` to connect to running server
- `client.event.subscribe()` for streaming events
- `client.session.*` for session management
- `client.app.agents()` to list agents

### OpenCode Web UI

- `opencode web` starts a browser-based interface
- Supports `--cors`, `--port`, `--hostname` flags
- Can attach TUI to running web server with `opencode attach`

---

## Reference: opencode-beads Plugin

We studied the [opencode-beads](https://github.com/joshuadavidthomas/opencode-beads) plugin (v0.5.1) as a reference implementation. We are **not using it as a dependency** — only borrowing proven patterns.

### Patterns We Borrow

| Pattern | What It Does | How We Use It |
|---------|-------------|---------------|
| `bd prime` context injection | Runs `bd prime` on session start, injects output as a synthetic `noReply` message | Same — ensures orchestrator always has fresh bead context |
| `--json` enforcement | Injects guidance telling agents to always use `--json` flag with `bd` commands | Same — makes `bd` output machine-parseable for our plugin to query |
| Re-injection after compaction | Hooks `session.compacted` to re-inject beads context | Same — long-running orchestrator sessions don't lose bead awareness |
| Bun shell `$` for `bd` commands | Plugin runs `bd` directly (e.g., `await $\`bd prime\`.text()`) | Extended — we actively poll `bd list --json` for bead ground truth |
| `client.session.prompt()` injection | Uses `noReply: true` + `synthetic: true` to inject without triggering LLM response | Same technique for our pipeline-specific guidance injection |
| Deduplication via `Set<string>` | Tracks which sessions already received context injection | Same — avoid double-injection on plugin reload |

### What We Do Differently

| opencode-beads | Our Plugin |
|---|---|
| Passive — injects context, then hands off to LLM | Active — injects context AND tracks state in real-time |
| Delegates complex work to `beads-task-agent` (single agent) | Directs orchestrator to multi-stage pipeline (builder -> refactor -> reviewer -> committer) |
| Only hooks: `chat.message`, `event`, `config` | Also hooks: `tool.execute.before/after`, all `session.*` events |
| No HTTP server | POSTs events to a separate dashboard server process |
| No state tracking | Tracks bead lifecycle + pipeline stage, pushes to central server |
| Single OpenCode instance | Multi-project: multiple OpenCode instances push to same server |

### Beads Data Model (from reference)

Each bead in `bd` has:
```
id:          string    (e.g., "prefix-abc" or "prefix-abc.1" for children)
title:       string
description: string
notes:       string
status:      "open" | "in_progress" | "blocked" | "closed"
priority:    0-4       (0=critical, 1=high, 2=medium, 3=low, 4=backlog)
issue_type:  "bug" | "feature" | "task" | "epic" | "chore" | "decision"
dependencies: [{ type: "parent-child" | "blocks" | "discovered-from" }]
created_at, updated_at, closed_at, close_reason
```

Important: `bd` statuses (`open`, `in_progress`, `closed`) are **lifecycle states**, not pipeline stages. The plugin must independently track which pipeline stage (builder/refactor/reviewer/committer) a bead is in.

---

## Architecture

### Three-Component Design

The system is split into three independent components:

1. **Plugin** (`dashboard-bridge.ts`) — lightweight event bridge running inside each OpenCode instance. Handles context injection, event tracking, `bd` querying, and POSTs structured events to the server. Does NOT serve HTTP or manage global state.
2. **Dashboard Server** (standalone Bun process) — long-running process that aggregates state from all connected plugins, owns the canonical state model, persists to disk, and serves the dashboard API + SSE stream.
3. **Dashboard App** (React SPA) — browser-based Kanban board that connects to the server via SSE.

Multiple OpenCode instances (different projects, different terminal tabs) each load their own plugin, and all push to the same server. The dashboard shows all projects simultaneously.

### Design Principle: Active Querying Over Passive Eavesdropping

The original plan relied on intercepting and parsing the orchestrator's `bd` bash command output. This is fragile because LLM behavior is unpredictable.

The revised approach uses a **hybrid strategy**:
1. **Bead state** comes from the plugin actively running `bd list --json` itself (ground truth)
2. **Pipeline stage** comes from watching OpenCode events (Task tool invocations, session lifecycle)
3. **Events are triggers, not data** — when the plugin detects any relevant OpenCode event, it re-queries `bd` for the latest state rather than trying to parse intercepted output

This makes the system resilient to unpredictable LLM behavior.

### System Diagram

```
+--------------------------------------------------------------------+
| Dashboard Server (standalone Bun process, long-running)             |
| Location: opencode-dashboard/server/                                |
| Port: 3333 (configurable via DASHBOARD_PORT env var)                |
|                                                                     |
|  State Store (in-memory, persisted to disk)                         |
|    projects: Map<projectPath, ProjectState>                         |
|                                                                     |
|  Plugin API (internal):                                             |
|    POST /api/plugin/register    - plugin connects, sends project    |
|    POST /api/plugin/event       - plugin pushes bead/pipeline events|
|    POST /api/plugin/heartbeat   - keep-alive                        |
|    DELETE /api/plugin/:id       - plugin disconnects                |
|                                                                     |
|  Dashboard API (public):                                            |
|    GET /api/state               - full state, all projects          |
|    GET /api/events              - SSE stream, all projects          |
|    GET /api/health              - health check                      |
+-----------------------+--------------------------------------------+
                        |
      +-----------------+------------------+
      |                                    |
+-----v--------------+      +-------------v--------+
| OpenCode (proj A)  |      | OpenCode (proj B)    |
| ~/Dev/project-a    |      | ~/Dev/project-b      |
|                    |      |                      |
| Plugin: bridge.ts  |      | Plugin: bridge.ts    |
| - context inject   |      | - context inject     |
| - event hooks      |      | - event hooks        |
| - bd list --json   |      | - bd list --json     |
| - POST to :3333    |      | - POST to :3333      |
| - auto-start server|      | - detects server up  |
+--------------------+      +----------------------+

+--------------------+
| Browser Dashboard  |
| localhost:5173     |
| EventSource(:3333) |
| Shows ALL projects |
+--------------------+
```

### Plugin-to-Server Protocol

**Registration (on plugin startup):**
```
POST /api/plugin/register
Body: { "projectPath": "/Users/.../project-a", "projectName": "project-a" }
Response: { "pluginId": "uuid" }
```

**Event push (on every state change):**
```
POST /api/plugin/event
Body: { "pluginId": "uuid", "event": "bead:claimed", "data": { ... } }
```

**Heartbeat (periodic, e.g., every 30s):**
```
POST /api/plugin/heartbeat
Body: { "pluginId": "uuid" }
```

**Deregistration (on plugin shutdown):**
```
DELETE /api/plugin/:pluginId
```

The server marks a plugin as disconnected if no heartbeat is received within 45 seconds. Disconnected projects show a "DISCONNECTED" badge in the dashboard but retain their last-known state.

### Auto-Start Logic

The first plugin to load auto-starts the server if it's not already running:

```
Plugin loads:
  1. Try GET http://localhost:3333/api/health
  2. If responds -> server is running, proceed to register
  3. If connection refused ->
     a. Resolve server path: opencode-dashboard/server/index.ts
     b. Spawn: Bun.spawn(["bun", "run", serverPath], { detached: true, stdio: "ignore" })
     c. Wait up to 5 seconds, polling /api/health every 500ms
     d. If server comes up -> register
     e. If not -> log warning, plugin degrades gracefully
        (context injection still works, tracking/dashboard disabled)
```

The server process is detached — it survives the OpenCode instance that started it. It stays running until manually killed or the machine restarts.

### Data Flow

1. User tells orchestrator: "work on the next beads"
2. Plugin has already injected `bd prime` context + pipeline guidance into the session
3. Orchestrator runs `bd ready --json` -> `tool.execute.after` fires -> Plugin runs its own `bd list --json` to refresh bead state -> POSTs `bead:discovered` to server for any new beads
4. Orchestrator runs `bd update <id> --claim` -> `tool.execute.after` fires -> Plugin re-queries `bd list --json`, sees status changed to `in_progress` -> Bead moves to `orchestrator` stage -> POSTs `bead:claimed` to server
5. Orchestrator invokes Task tool with `pipeline-builder` -> `tool.execute.before` fires -> Plugin detects `subagent_type`, moves bead from `orchestrator` stage to `builder` stage -> POSTs `bead:stage` to server
6. Builder child session created -> `session.created` fires -> Plugin maps child session to builder agent
7. Builder finishes -> `session.idle` fires -> Plugin re-queries `bd list --json` for any status changes
8. Orchestrator invokes `pipeline-refactor` -> Plugin moves bead to "refactor" stage -> POSTs `bead:stage` to server
9. ...and so on through reviewer and committer
10. Orchestrator runs `bd update <id> --done` / `bd close <id>` -> Plugin re-queries, sees `closed` status -> POSTs `bead:done` to server
11. Server broadcasts each received event to all connected SSE clients
12. Dashboard animates the bead card to its new column on each SSE event

### Correlation Strategy

The plugin tracks **two independent dimensions**:

**Dimension 1: Bead lifecycle (from `bd` directly)**
- Plugin runs `bd list --json` on every event trigger
- Compares new state to previous state to detect transitions
- Statuses: `open` -> `in_progress` -> `closed` (or `blocked`)

**Dimension 2: Pipeline stage (from OpenCode events)**
- When orchestrator invokes Task with a `subagent_type` like `pipeline-builder`, the plugin moves the bead from the `orchestrator` stage to the corresponding agent stage (e.g., `builder`)
- Since beads are processed **sequentially** (one at a time per orchestrator session), the plugin tracks `currentBeadId` per orchestrator session
- When a `bd update --claim` / `bd update --status in_progress` is detected (via bd list refresh), that bead becomes the `currentBeadId` and enters the `orchestrator` stage
- When `bd close` is detected, `currentBeadId` is cleared

For **multiple concurrent pipelines**, each orchestrator session is tracked independently by its session ID. For **multiple projects**, each plugin instance tracks its own orchestrator sessions and pushes events to the server tagged with `projectPath`.

### Context Injection (Plugin Handles Everything)

Instead of modifying the orchestrator prompt file, the plugin injects all necessary guidance at runtime:

**On session start (`chat.message` hook):**
1. Run `bd prime` -> inject beads context (borrowed pattern)
2. Inject pipeline-specific guidance:
   - Always use `--json` flag with `bd` commands
   - Always claim (`bd update <id> --status in_progress`) before starting pipeline stages
   - Always close (`bd close <id>`) after committer finishes
   - Include bead ID in Task tool descriptions (e.g., `"Build: [bd-a1b2] Add auth middleware"`)

**On compaction (`session.compacted` event):**
- Re-inject both beads context and pipeline guidance

This means **no agent prompt files need to be modified**. The plugin handles everything.

---

## Implementation Plan

### Phase 0: Spike - Plugin-to-Server Communication (Proof of Concept)

**Goal:** Verify that a plugin can auto-start a separate Bun server process, POST events to it, and that the server can broadcast SSE to a browser.

**Files:**
- `~/.config/opencode/plugins/dashboard-spike.ts` (plugin)
- `/Users/gaborzakhar/Dev/opencode-dashboard/server/spike.ts` (server)

**What to test:**
1. Can a plugin spawn a detached Bun process that outlives the plugin?
2. Can the plugin detect if the server is already running (port check)?
3. Can the plugin POST events to the server?
4. Can the server broadcast those events as SSE to a browser?
5. Can a second plugin instance (simulated) connect to the same server?

**Minimal server implementation:**
```typescript
// opencode-dashboard/server/spike.ts
const clients = new Set<ReadableStreamController>();

Bun.serve({
  port: 3333,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      const stream = new ReadableStream({
        start(controller) {
          clients.add(controller);
          controller.enqueue("data: connected\n\n");
        },
        cancel(controller) {
          clients.delete(controller);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/api/plugin/event" && req.method === "POST") {
      const body = await req.json();
      const msg = `event: ${body.event}\ndata: ${JSON.stringify(body.data)}\n\n`;
      for (const client of clients) {
        try { client.enqueue(msg); } catch { clients.delete(client); }
      }
      return Response.json({ ok: true });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});
```

**Minimal plugin implementation:**
```typescript
import type { Plugin } from "@opencode-ai/plugin";

export const DashboardSpike: Plugin = async ({ directory }) => {
  const SERVER_URL = "http://localhost:3333";

  // Check if server is running, auto-start if not
  let serverReady = false;
  try {
    const res = await fetch(`${SERVER_URL}/api/health`);
    serverReady = res.ok;
  } catch {
    // Server not running, start it
    const serverPath = "/Users/gaborzakhar/Dev/opencode-dashboard/server/spike.ts";
    Bun.spawn(["bun", "run", serverPath], { detached: true, stdio: "ignore" });
    // Poll for readiness
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(500);
      try {
        const res = await fetch(`${SERVER_URL}/api/health`);
        if (res.ok) { serverReady = true; break; }
      } catch {}
    }
  }

  if (!serverReady) {
    console.warn("[dashboard-spike] Server failed to start");
    return {};
  }

  // Push events to server
  async function pushEvent(event: string, data: unknown) {
    try {
      await fetch(`${SERVER_URL}/api/plugin/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, data: { ...data, projectPath: directory } }),
      });
    } catch {}
  }

  return {
    event: async ({ event }) => {
      await pushEvent("opencode:event", {
        type: event.type,
        properties: event.properties,
      });
    },
  };
};
```

**Success criteria:**
- Plugin starts, detects no server, spawns the server process
- Open `http://localhost:3333/api/events` in browser, see SSE events flowing
- Events appear when interacting with OpenCode (sessions, tool calls, etc.)
- Server survives OpenCode exit (kill OpenCode, server still responds)
- Start a second OpenCode instance — its plugin detects server is already running, connects without spawning a second server
- No crashes or port conflicts

**Estimated effort:** ~1 hour

### Phase 1: Plugin - Context Injection & Bead Awareness

**File:** `~/.config/opencode/plugins/dashboard-bridge.ts`

> This phase is purely plugin-side. No server interaction yet — context injection works independently of the dashboard server.

**Responsibilities:**
- Inject `bd prime` context + pipeline guidance on session start
- Re-inject after compaction
- Enforce `--json` flag usage via injected guidance
- Direct orchestrator to use the multi-stage pipeline (not `beads-task-agent`)

**Guidance injected into sessions:**
```
<pipeline-guidance>
## Beads CLI Usage

Use the `bash` tool for all beads operations. Always use `--json` flag:
- `bd ready --json` - List ready tasks
- `bd show <id> --json` - Show task details
- `bd update <id> --status in_progress --json` - Claim a bead
- `bd close <id> --reason "message" --json` - Complete a bead
- `bd list --status open --json` - List all open issues

## Pipeline Workflow

When working on beads:
1. Run `bd ready --json` to find work
2. Claim with `bd update <id> --status in_progress --json`
3. Run pipeline stages in order:
   - pipeline-builder (implement the feature)
   - pipeline-refactor (improve code quality - optional)
   - pipeline-reviewer (review and fix issues)
   - pipeline-committer (create git commit)
4. Close with `bd close <id> --reason "message" --json`

Include the bead ID in Task descriptions (e.g., "Build: [bd-a1b2] Add auth middleware").
</pipeline-guidance>
```

**Estimated effort:** ~1 hour

### Phase 2: Plugin - Bead State Tracking & Event Bridge

**Added to:** `~/.config/opencode/plugins/dashboard-bridge.ts`

> This phase adds the tracking layer to the plugin. The plugin detects state changes and POSTs structured events to the dashboard server. The server (built in Phase 3) receives and stores these events.

**Plugin startup:**
1. Check if dashboard server is reachable at `http://localhost:3333/api/health`
2. If not running, auto-start it (see Auto-Start Logic in Architecture section)
3. Register with server: `POST /api/plugin/register { projectPath, projectName }`
4. Start periodic heartbeat (every 30s): `POST /api/plugin/heartbeat { pluginId }`

**Hooks:**
- `tool.execute.after` -> On ANY tool execution, run `bd list --json` to refresh bead state. Diff against previous state to detect transitions. POST changes to server.
- `tool.execute.before` (task tool) -> Detect `subagent_type` field to know which pipeline stage is starting. Map to `currentBeadId`. POST `bead:stage` to server.
- `session.created` -> Map new child session ID to agent type
- `session.idle` -> Mark agent as idle, re-query bead state, POST changes to server

**State Model:**

The plugin maintains local state for its own project. The server aggregates state across all projects.

```typescript
// === Server-side state (canonical, aggregated across all projects) ===

interface DashboardState {
  projects: Map<string, ProjectState>   // keyed by projectPath
}

interface ProjectState {
  projectPath: string          // e.g., "/Users/gaborzakhar/Dev/project-a"
  projectName: string          // derived from directory basename
  pluginId: string             // unique ID for this plugin connection
  lastHeartbeat: number        // timestamp
  connected: boolean           // is the plugin alive?
  pipelines: Map<string, Pipeline>
  lastBeadSnapshot: BeadRecord[]  // last bd list --json result for this project
}

// === Shared types (used by plugin, server, and dashboard app) ===

interface Pipeline {
  id: string              // orchestrator session ID
  title: string           // derived from first bead or session
  status: 'active' | 'idle' | 'done'
  currentBeadId: string | null
  beads: Map<string, BeadState>
}

interface BeadState {
  id: string              // e.g., "bd-a1b2"
  title: string
  description: string
  priority: number        // 0-4
  issueType: string       // bug, feature, task, etc.
  bdStatus: string        // open, in_progress, blocked, closed
  stage: 'backlog' | 'orchestrator' | 'builder' | 'refactor' | 'reviewer' | 'committer' | 'done' | 'error'
  stageStartedAt: number  // timestamp
  claimedAt?: number      // when orchestrator claimed the bead
  completedAt?: number
  agentSessionId?: string // current child session working on it
  error?: string          // error message if something went wrong
}

// Raw bead record from bd list --json
interface BeadRecord {
  id: string
  title: string
  description: string
  status: string
  priority: number
  issue_type: string
  created_at: string
  updated_at: string
  closed_at?: string
  close_reason?: string
  dependencies?: Array<{
    type: string
    depends_on_id: string
  }>
}

// === Plugin-side state (local to one OpenCode instance) ===

interface PluginLocalState {
  pluginId: string             // assigned by server on registration
  projectPath: string
  projectName: string
  currentBeadId: string | null // per-orchestrator tracking
  lastBeadSnapshot: BeadRecord[]
  sessionToAgent: Map<string, string>  // child session ID -> agent type
}
```

**Bead state refresh logic (plugin-side, on every event trigger):**
```typescript
async function refreshBeadState($: BunShell): Promise<BeadRecord[]> {
  try {
    const output = await $`bd list --json`.text();
    return JSON.parse(output);
  } catch {
    return []; // bd not initialized or not installed
  }
}

function diffBeadState(prev: BeadRecord[], next: BeadRecord[]): BeadDiff[] {
  // Compare prev vs next, return list of changes:
  // - new beads (discovered)
  // - status changes (open -> in_progress = orchestrator stage, in_progress -> closed = done)
  // - removed beads (deleted)
}

// After computing diffs, plugin POSTs each change as a structured event to the server:
async function pushEvent(pluginId: string, event: string, data: unknown) {
  await fetch("http://localhost:3333/api/plugin/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pluginId, event, data }),
  });
}
```

**Error Detection Logic:**

The plugin detects errors and moves beads to the `error` stage using four methods:

| Error Scenario | Detection Method | Result |
|---|---|---|
| Orchestrator marks bead as `blocked` | `bd list --json` refresh shows `status: "blocked"` | Bead moves to `error` stage with "blocked" message |
| Orchestrator abandons a bead | `bd list --json` shows a new bead claimed while previous still `in_progress` | Previous bead moves to `error` stage with "abandoned" message |
| Orchestrator closes bead with failure | `bd close <id>` detected, close reason text contains failure indicators | Bead moves to `error` stage with the close reason |
| Child agent session fails | `session.idle` fires but orchestrator doesn't proceed to next stage within a configurable timeout (default: 5 min) | Bead moves to `error` stage with "agent timeout" message |

Error detection is applied during every `refreshBeadState` cycle. The diff logic checks:
1. Any bead whose `bd` status changed to `blocked` -> `error` stage
2. Any bead that was `in_progress` but is no longer the `currentBeadId` (a new bead was claimed) and wasn't closed -> `error` stage with "abandoned"
3. Any bead closed with a reason matching failure patterns (e.g., "failed", "rejected", "abandoned") -> `error` stage instead of `done`

The Error column appears between Committer and Done on the Kanban board: **Backlog | Orchestrator | Builder | Refactor | Reviewer | Committer | Error | Done**

**Persistence:** The server persists the aggregated state (all projects) to `opencode-dashboard/server/.dashboard-state.json` on every state change. Loaded on server startup to survive restarts. The plugin does NOT persist state — it re-registers and re-queries `bd` on startup.

**Estimated effort:** ~2.5 hours

### Phase 3: Dashboard Server - HTTP, SSE & State Aggregation

**Location:** `/Users/gaborzakhar/Dev/opencode-dashboard/server/`

> This is a standalone Bun process, NOT part of the plugin. It runs independently and can be auto-started by the plugin or started manually.

**Entry point:** `server/index.ts` (run with `bun run server/index.ts`)

**Server:** `Bun.serve` on port 3333 (configurable via env var `DASHBOARD_PORT`)

**Responsibilities:**
- Accept plugin registrations and track connected projects
- Receive events from plugins, update canonical state
- Broadcast events to dashboard SSE clients
- Persist state to disk, restore on startup
- Track plugin health via heartbeats

**Plugin API Endpoints (internal):**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plugin/register` | POST | Plugin registers with `{ projectPath, projectName }`. Returns `{ pluginId }` |
| `/api/plugin/event` | POST | Plugin pushes an event `{ pluginId, event, data }`. Server updates state + broadcasts to SSE |
| `/api/plugin/heartbeat` | POST | Plugin sends `{ pluginId }`. Server updates `lastHeartbeat` |
| `/api/plugin/:id` | DELETE | Plugin deregisters on shutdown |

**Dashboard API Endpoints (public):**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/state` | GET | Full board state as JSON (all projects, all pipelines, all beads) |
| `/api/events` | GET | SSE stream for real-time updates (all projects) |
| `/api/health` | GET | Server health check |

**CORS:** Allow `localhost:*` origins for development.

**SSE Event Types:**

All events include `projectPath` so the dashboard can route them to the correct project section.

```
event: state:full
data: {full state snapshot for all projects, sent on SSE connect}

event: project:connected
data: {"projectPath":"/Users/.../project-a","projectName":"project-a","pluginId":"uuid"}

event: project:disconnected
data: {"projectPath":"/Users/.../project-a","pluginId":"uuid"}

event: bead:discovered
data: {"projectPath":"/Users/.../project-a","pipelineId":"abc","bead":{"id":"bd-a1b2","title":"Add auth","priority":0}}

event: bead:claimed
data: {"projectPath":"/Users/.../project-a","pipelineId":"abc","beadId":"bd-a1b2","stage":"orchestrator"}

event: bead:stage
data: {"projectPath":"/Users/.../project-a","pipelineId":"abc","beadId":"bd-a1b2","stage":"builder","agentSessionId":"xyz"}

event: bead:done
data: {"projectPath":"/Users/.../project-a","pipelineId":"abc","beadId":"bd-a1b2"}

event: bead:error
data: {"projectPath":"/Users/.../project-a","pipelineId":"abc","beadId":"bd-a1b2","error":"Builder failed"}

event: agent:active
data: {"projectPath":"/Users/.../project-a","pipelineId":"abc","agent":"pipeline-builder","sessionId":"xyz","beadId":"bd-a1b2"}

event: agent:idle
data: {"projectPath":"/Users/.../project-a","pipelineId":"abc","agent":"pipeline-builder","sessionId":"xyz"}

event: pipeline:started
data: {"projectPath":"/Users/.../project-a","pipelineId":"abc","title":"Authentication feature"}

event: pipeline:done
data: {"projectPath":"/Users/.../project-a","pipelineId":"abc"}

event: beads:refreshed
data: {"projectPath":"/Users/.../project-a","beadCount":5,"changed":2}
```

**Estimated effort:** ~2 hours

### Phase 4: Dashboard App Scaffold (Monorepo)

**Location:** `/Users/gaborzakhar/Dev/opencode-dashboard`

> This is a monorepo containing both the dashboard server (Phase 3) and the React dashboard app. The server and app share types via a `shared/` directory.

**Tech Stack:**
- React 19
- Vite
- TailwindCSS
- shadcn/ui (copy-paste component library built on Radix UI + Tailwind)
- Framer Motion (for card animations between columns)
- TypeScript
- Bun (for the server)

**shadcn/ui components used:**
- `Card` — bead cards in columns
- `Badge` — priority (P0-P4), status (CONNECTED/DISCONNECTED), pipeline state (LIVE/IDLE/DONE)
- `Collapsible` — collapsible project sections
- `Tooltip` — error message tooltips on error-state cards
- `Separator` — between project sections
- `ScrollArea` — scrollable columns when many beads
- `Skeleton` — loading states during initial fetch / reconnection

> **Note:** shadcn/ui provides structure and accessibility (via Radix primitives). Framer Motion is still needed separately for layout animations (bead card transitions between columns via `layoutId`).

**Project Structure:**
```
opencode-dashboard/
  server/
    index.ts              # Bun.serve entry point
    state.ts              # State management (all projects, all pipelines)
    sse.ts                # SSE client management + broadcasting
    routes.ts             # HTTP route handlers (plugin API + dashboard API)
  shared/
    types.ts              # Types shared between server, plugin, and React app
  src/                    # React dashboard app
    App.tsx               # Main layout, project sections
    main.tsx              # Entry point
    hooks/
      useEventSource.ts   # SSE connection with auto-reconnect
      useBoardState.ts    # Reducer managing board state from events
    components/
      Board.tsx           # Kanban board container (columns)
      Column.tsx          # Single agent column
      BeadCard.tsx        # Individual bead card
      ProjectSection.tsx  # Collapsible project container with pipelines
      PipelineHeader.tsx  # Pipeline title + status badge
      StatusIndicator.tsx # Connection status (connected/reconnecting)
      ElapsedTime.tsx     # Live elapsed time on cards
    lib/
      api.ts              # HTTP client for /api/state
      constants.ts        # Column definitions, colors, etc.
  index.html
  package.json
  vite.config.ts
  tailwind.config.ts
  tsconfig.json
```

**Estimated effort:** ~1 hour

### Phase 5: Dashboard - Connect & Render

**On load:**
1. `fetch('http://localhost:3333/api/state')` -> populate initial board state
2. `new EventSource('http://localhost:3333/api/events')` -> subscribe to live updates
3. First SSE event is `state:full` with complete snapshot (handles reconnection)

**Board Layout:**

The board is organized by **project** first, then by **pipeline** within each project. Multiple projects from different OpenCode instances appear simultaneously.

```
+------------------------------------------------------------------------------------------------------+
| Project: project-a (/Users/.../Dev/project-a)                                           [CONNECTED]  |
|                                                                                                      |
|   Pipeline: "Add authentication" (session abc)                                               [LIVE]  |
|   +-----------+--------------+---------+----------+----------+-----------+---------+--------------+   |
|   | Backlog   | Orchestrator | Builder | Refactor | Reviewer | Committer |  Error  |     Done     |   |
|   |           |              |         |          |          |           |         |              |   |
|   | +-------+ | +----------+ | +-----+ |          |          |           |         | +-------+    |   |
|   | | bd-c3 | | | bd-b2    | | |bd-a1| |          |          |           |         | | bd-f7 |    |   |
|   | | P0    | | | P1       | | |P0   | |          |          |           |         | | P1    |    |   |
|   | | Auth  | | | Add user | | |Setup| |          |          |           |         | | Init  |    |   |
|   | | midlw | | | roles    | | |route| |          |          |           |         | | proj  |    |   |
|   | +-------+ | +----------+ | +-----+ |          |          |           |         | +-------+    |   |
|   | +-------+ |              |         |          |          |           |         |              |   |
|   | | bd-d4 | |              |         |          |          |           |         |              |   |
|   | | P1    | |              |         |          |          |           |         |              |   |
|   | +-------+ |              |         |          |          |           |         |              |   |
|   +-----------+--------------+---------+----------+----------+-----------+---------+--------------+   |
+------------------------------------------------------------------------------------------------------+

+------------------------------------------------------------------------------------------------------+
| Project: project-b (/Users/.../Dev/project-b)                                           [CONNECTED]  |
|                                                                                                      |
|   Pipeline: "Refactor DB layer" (session def)                                                [LIVE]  |
|   +-----------+--------------+---------+----------+----------+-----------+---------+--------------+   |
|   | Backlog   | Orchestrator | Builder | Refactor | ...                                          |   |
|   +-----------+--------------+---------+----------+----------------------------------------------+   |
+------------------------------------------------------------------------------------------------------+

+------------------------------------------------------------------------------------------------------+
| Project: project-c (/Users/.../Dev/project-c)                                        [DISCONNECTED]  |
|   (last seen 5 minutes ago — showing last known state)                                               |
|   ...                                                                                                |
+------------------------------------------------------------------------------------------------------+
```

**Responsive Strategy: Desktop-First**

The dashboard is designed for desktop and laptop screens. On smaller screens (tablets, narrow browser windows), the board columns scroll horizontally. No dedicated phone-optimized layout is provided in the initial release.

- Board uses `overflow-x: auto` with shadcn `ScrollArea` for horizontal scrolling
- Project sections stack vertically and remain usable at any width
- Minimum comfortable width: ~1024px (columns visible without scrolling)
- Below that: horizontal scroll, all functionality preserved

**Card Features (shadcn `Card` + Framer Motion):**
- Bead ID badge (shadcn `Badge`)
- Title (truncated)
- Priority color coding: P0 = red, P1 = orange, P2 = blue, P3 = gray (shadcn `Badge` variants)
- Elapsed time in current stage (live updating)
- Subtle glow/pulse animation when actively being worked on
- Smooth slide animation when moving between columns (Framer Motion `layoutId`)
- Error state: red border/background with error message tooltip (shadcn `Tooltip`) when in Error column

**Project Features (shadcn `Collapsible`):**
- Multiple project sections stacked vertically
- Each project shows its directory path and connection status badge: CONNECTED (green) / DISCONNECTED (red, with "last seen" time) (shadcn `Badge`)
- Disconnected projects retain last-known state and show a dimmed appearance
- Projects are collapsible

**Pipeline Features:**
- Multiple pipeline sections within each project
- Each shows its own Kanban board
- Status badge: LIVE (green) / IDLE (gray) / DONE (blue) (shadcn `Badge`)
- Auto-collapse done pipelines

**Estimated effort:** ~3 hours

### Phase 5.5: Critical Bugfix — Plugin Stability

> **BLOCKER:** The plugin in its current form has two critical bugs that must be fixed before any further dashboard frontend work. When installed, the plugin **breaks OpenCode entirely** (session spam at ~3/sec) and **crashes the machine** due to runaway resource consumption. The plugin is currently NOT installed in `~/.config/opencode/plugins/` to avoid triggering these bugs.

#### Bug 1: Plugin Activates Unconditionally at Load Time

**Problem:** The plugin factory function calls `await startupSequence(...)` immediately when OpenCode loads the plugin. Since plugins in `~/.config/opencode/plugins/` are loaded automatically at startup, this means: server spawns, registration happens, heartbeat starts, and all beads are fetched — every time OpenCode starts, regardless of whether the user intends to use the orchestrator pipeline.

**Root cause:** `dashboard-bridge.ts` line 825 — `startupSequence()` runs inside the plugin factory with no gating condition.

**Fix — Lazy activation with dual trigger:**

The plugin loads in a "dormant" state. Activation happens only when:
1. **Auto-detect:** The `chat.message` hook sees `input.agent === "orchestrator"` for the first time, OR
2. **Manual:** The user runs a `/dashboard` command (intercepted via `command.execute.before`).

Implementation:
- Add module-level `let activated = false` and `let activating = false` flags
- Remove `await startupSequence(...)` from the factory function body
- In `chat.message`: check `input.agent === "orchestrator"` — if true and `!activated`, run `startupSequence()` once
- Add `command.execute.before` hook: intercept `/dashboard` command to manually trigger activation
- All other hooks (`tool.execute.before`, `tool.execute.after`, `event`) early-return with `if (!activated) return;`
- Context injection in `chat.message` only proceeds for orchestrator sessions

#### Bug 2: Session Spam / Feedback Loop (~3 sessions/sec)

**Problem:** When the plugin is active, OpenCode starts creating sessions at ~3/sec, completely blocking the application and crashing the computer.

**Root cause analysis — multiple contributing factors:**

**Factor A: Race condition in `injectContext` (primary suspect)**

The `injectedSessions.add(sessionID)` guard is set AFTER `await client.session.prompt()` (line 209), not before. If `client.session.prompt()` with `noReply: true` triggers the `chat.message` hook while the await is pending, the guard hasn't been set yet and the hook re-enters:

```
chat.message(session X)
  → injectedSessions.has(X)? NO
  → await client.session.prompt(X, { noReply: true })
     ↑ fires chat.message(X) while awaiting (before line 209)
       → injectedSessions.has(X)? STILL NO — not added yet!
       → await client.session.prompt(X, ...) — another message
          ↑ fires chat.message(X) again...
             → INFINITE CASCADE
```

Each iteration adds a synthetic message, which triggers another event, flooding the system.

**Factor B: No re-entrancy protection on `refreshAndDiff`**

`refreshAndDiff($)` is called from both `tool.execute.after` (every tool execution) and `session.idle` (every idle event). If concurrent calls stack up (which they will during rapid event processing), multiple `bd list --json` executions and HTTP POST batches run simultaneously, amplifying the resource consumption.

**Factor C: No debouncing on event-triggered refreshes**

Every single `tool.execute.after` fires `refreshAndDiff($)`, which runs `bd list --json` + computes diffs + POSTs events. During normal operation, tools fire rapidly (multiple per second). Without debouncing, this creates a flood of shell commands and HTTP requests.

**Factor D: `chat.message` fires for ALL sessions**

The hook runs for every session (builder, reviewer, committer, designer, etc.), not just the orchestrator. Each non-orchestrator session triggers `isChildSession()` and `hasExistingContext()` API calls before being skipped — unnecessary overhead that adds to the event cascade.

**Fix — Defense in depth (6 layers):**

| Layer | Change | What it prevents |
|-------|--------|-----------------|
| 1. Lazy activation | All hooks dormant until orchestrator detected | Server spawn, heartbeats, bead fetch don't run until needed |
| 2. Race condition fix | Move `injectedSessions.add()` BEFORE `await client.session.prompt()`, rollback on failure | `chat.message` → `session.prompt()` → `chat.message` re-entrancy |
| 3. Re-entrancy guard | `let isRefreshing = false` flag in `refreshAndDiff`, skip if already running | `refreshAndDiff` calling itself via cascading events |
| 4. Debouncing | Replace direct `refreshAndDiff` calls in hooks with `scheduleRefresh($, 500)` using trailing debounce | Rapid-fire events batched into single `bd list --json` call |
| 5. Orchestrator-only filter | `chat.message` checks `input.agent` — non-orchestrator sessions marked in `injectedSessions` immediately and skipped | Unnecessary API calls and injection attempts for sub-agent sessions |
| 6. `!activated` early-return | Every hook except `chat.message` (which handles activation) returns early if `!activated` | All tracking disabled when plugin is dormant |

**Specific code changes in `dashboard-bridge.ts`:**

**New module-level state:**
```typescript
let activated = false;
let activating = false;
let isRefreshing = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
```

**`injectContext` — fix race condition:**
```typescript
async function injectContext(client, sessionID, model, agent, $) {
  if (injectedSessions.has(sessionID)) return;
  injectedSessions.add(sessionID);          // Mark FIRST — closes race window
  try {
    const bdPrime = await getBdPrimeOutput($);
    const contextMessage = buildContextMessage(bdPrime);
    await client.session.prompt({ ... });
  } catch (err) {
    injectedSessions.delete(sessionID);     // Rollback on failure
    console.error(...);
  }
}
```

**`refreshAndDiff` — add re-entrancy guard:**
```typescript
async function refreshAndDiff($) {
  if (isRefreshing) return [];
  isRefreshing = true;
  try { /* existing logic */ }
  finally { isRefreshing = false; }
}
```

**New `scheduleRefresh` — debounced wrapper:**
```typescript
function scheduleRefresh($, delayMs = 500) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    await refreshAndDiff($);
  }, delayMs);
}
```

**`chat.message` — orchestrator-only + lazy activation:**
```typescript
"chat.message": async (input, output) => {
  if (!activated && !activating && input.agent === "orchestrator") {
    activating = true;
    await startupSequence(directory, projectName, $);
    activated = true; activating = false;
  }
  if (input.agent && input.agent !== "orchestrator") {
    injectedSessions.add(input.sessionID);
    return;
  }
  // ... existing injection logic (with race-fix applied)
}
```

**All other hooks — activation guard:**
```typescript
"tool.execute.before": async (...) => { if (!activated) return; ... },
"tool.execute.after":  async (...) => { if (!activated) return; scheduleRefresh($); ... },
event: async (...) => { if (!activated) return; ... },
```

**`command.execute.before` — manual activation:**
```typescript
"command.execute.before": async (input, output) => {
  if (input.command === "dashboard") {
    if (!activated && !activating) {
      activating = true;
      await startupSequence(directory, projectName, $);
      activated = true; activating = false;
    }
  }
}
```

**Estimated effort:** ~2 hours

---

### Phase 6: Polish & Reliability

> **Note:** All features across Phases 4-6 are in scope for the first usable version. Nothing is deferred to a "post-MVP" iteration. The features listed below (animations, multi-project, multi-pipeline, timers, priority colors, error column, auto-collapse) are all required for the initial release.

- Auto-reconnect SSE with exponential backoff (dashboard -> server)
- Handle server restart (dashboard shows "reconnecting..." state, recovers on reconnect with `state:full` event)
- Handle plugin disconnect (server marks project as disconnected after heartbeat timeout, dashboard shows DISCONNECTED badge with last-seen time)
- Handle plugin reconnect (plugin re-registers, server merges fresh state, dashboard shows CONNECTED again)
- Server state persistence and recovery from `.dashboard-state.json`
- Plugin re-registration on OpenCode restart (re-queries `bd list --json`, POSTs full refresh to server)
- Graceful handling of edge cases:
  - Orchestrator skips refactor stage -> bead jumps from builder to reviewer
  - Orchestrator retries a stage -> bead moves back
  - Bead gets stuck (agent errors) -> `bead:error` event, card shows error state
  - `bd` not installed or not initialized -> plugin degrades gracefully (context injection still works)
  - Server not reachable -> plugin degrades gracefully (context injection still works, tracking disabled)
  - Multiple OpenCode instances for the same project path -> server merges into single project entry
- Dark theme by default (matches terminal workflow aesthetic)
- ~~Debounced `bd list --json` calls (if multiple events fire in rapid succession, batch into one query)~~ *Moved to Phase 5.5 as part of the bugfix*
- ~~Debounced event POSTs to server (batch rapid-fire events into fewer HTTP calls)~~ *Moved to Phase 5.5 as part of the bugfix*

**Estimated effort:** ~2 hours (reduced — debouncing moved to Phase 5.5)

---

## Files Modified vs. Created

| File | Action | Location |
|------|--------|----------|
| `dashboard-bridge.ts` | **CREATE** | `~/.config/opencode/plugins/` |
| `package.json` | **MODIFY** (add `@opencode-ai/plugin` + `@opencode-ai/sdk` if not present) | `~/.config/opencode/` |
| `opencode-dashboard/` | **CREATE** (monorepo: `server/` + `src/` + `shared/`) | `/Users/gaborzakhar/Dev/` |
| `.gitignore` | **CREATE** (inside `opencode-dashboard/`) | `/Users/gaborzakhar/Dev/opencode-dashboard/` |

> **Note:** No agent prompt files are modified. The plugin handles all context injection at runtime.

### Version Control

- **Dashboard monorepo** (`opencode-dashboard/`): Git initialized (`git init`) with a `.gitignore` (ignoring `node_modules/`, `dist/`, `.dashboard-state.json`, etc.)
- **Plugin** (`dashboard-bridge.ts`): Lives in `~/.config/opencode/plugins/`, managed as part of the user's OpenCode config. Not tracked in the dashboard repo — it is a separate single file.

---

## Effort Estimates

| Phase | Description | Estimated Effort | Status |
|-------|-------------|-----------------|--------|
| 0 | Spike: plugin-to-server communication (proof of concept) | ~1 hour | Done |
| 1 | Plugin: context injection & bead awareness | ~1 hour | Done |
| 2 | Plugin: bead state tracking & event bridge | ~2.5 hours | Done |
| 3 | Dashboard server: HTTP, SSE & state aggregation | ~2 hours | Done |
| 4 | Dashboard: scaffold monorepo project | ~1 hour | Done |
| 5 | Dashboard: connect, render, animate | ~3 hours | In progress |
| **5.5** | **Critical bugfix: plugin stability (lazy activation, feedback loop prevention)** | **~2 hours** | **Blocked (must do before Phase 5 continues)** |
| 6 | Polish & reliability | ~2 hours | Pending |
| **Total** | | **~14.5 hours** |

---

## Alternative Approaches Considered

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **Plugin + separate server + active querying** (chosen) | Multi-project support; server survives OpenCode restarts; clean separation of concerns; resilient to LLM unpredictability | Three components to coordinate; auto-start adds complexity | Best balance of reliability, multi-project support, and autonomy |
| **Single plugin with Bun.serve** (original revised plan) | Simpler — single component; no IPC needed | Only sees one OpenCode instance; port conflicts with multiple instances; server dies with OpenCode | Insufficient for multi-project |
| **Use opencode-beads + separate dashboard plugin** | Leverage existing tested plugin; separation of concerns | beads-task-agent conflicts with multi-stage pipeline; two plugins to manage; extra dependency | Conflict with pipeline model |
| **Fork/extend opencode-beads** | Single starting point with proven patterns | Diverges from upstream; maintenance burden; includes unneeded features | Too much baggage |
| **Passive eavesdropping only** (original plan) | Simpler plugin logic | Fragile — depends on LLM using --json, predictable commands | Too fragile |
| **Direct SSE from OpenCode server** | No plugin needed, use `GET /event` | Raw events lack bead context; no bd data; single instance only | Insufficient data |
| **Polling `bd list --json` on timer** | Very simple | Not real-time for agent stage tracking; wastes resources when idle | Misses agent dimension |
| **WebSocket instead of SSE** | Bidirectional | Dashboard is read-only; SSE is simpler | SSE sufficient |
| **First-instance-wins hub** | No separate server process | If first instance dies, hub dies; complex failover | Less robust than separate server |
| **Shared state file only** | Simple, no IPC | Not real-time for cross-project; file locking issues | Too slow |

---

## Future Enhancements (Post-MVP)

- **Interactive mode**: Click cards to abort, re-prioritize, or manually reassign
- **Agent session viewer**: Click a card to see the agent's conversation/messages (via `GET /session/:id/message`)
- **Dependency graph view**: Visualize bead dependencies as a DAG
- **History/timeline**: See completed pipeline runs with timing stats
- **Notifications**: Browser notifications when a bead completes or errors
- **Full mobile layout**: Dedicated phone-optimized layout with swipeable columns or vertical stack (initial release supports tablets/laptops via horizontal scroll)
- **Bead creation from dashboard**: Create new beads directly from the UI

---

## Key Technical Decisions

1. **Three-component architecture (plugin + server + app)**: The plugin is a lightweight event bridge. The server is a standalone long-running Bun process that aggregates state from all plugins and serves the dashboard. This enables multi-project support — multiple OpenCode instances push to the same server.
2. **Active querying over passive eavesdropping**: The plugin runs `bd list --json` itself on every event trigger, rather than trying to parse the orchestrator's bash output. This makes the system resilient to unpredictable LLM behavior.
3. **Plugin handles all context injection**: No agent prompt files are modified. The plugin injects `bd prime` context and pipeline guidance via `client.session.prompt()` with `noReply: true` + `synthetic: true`. This keeps configuration centralized.
4. **Event triggers, not timers**: Instead of polling on a fixed interval, the plugin re-queries `bd` whenever an OpenCode event fires (tool execution, session change, etc.). This is both responsive and efficient.
5. **SSE over WebSocket**: Dashboard is read-only, SSE is simpler and natively supported by browsers via `EventSource`.
6. **Two-dimensional tracking**: Bead lifecycle state (from `bd`) and pipeline stage (from OpenCode events) are tracked independently and correlated via the sequential-bead-per-session assumption.
7. **Server owns canonical state**: The server aggregates state from all plugins, persists to disk, and serves as the single source of truth. Plugins are stateless across restarts — they re-register and re-query on startup.
8. **Auto-start server from plugin**: The first plugin to load spawns the server as a detached process if it's not already running. No manual server management needed.
9. **Project identity via directory path**: Each OpenCode instance is identified by its working directory path. Simple, unique, and available in the plugin context.
10. **Framer Motion for animations**: `layoutId` prop makes card transitions between columns smooth with minimal code.
11. **Spike-first approach**: Phase 0 validates the plugin-to-server communication pattern before building the full system. Reduces risk of discovering a blocker late.
12. **Monorepo structure**: Server and React app live in the same repository (`opencode-dashboard/`), sharing types via a `shared/` directory. Simplifies development and deployment.
13. **shadcn/ui for components**: Copy-paste component library built on Radix UI + Tailwind. Provides accessible, well-styled primitives (Card, Badge, Collapsible, Tooltip, ScrollArea, Skeleton) without adding a heavy dependency. Framer Motion handles layout animations separately.
14. **Desktop-first responsive**: The 8-column Kanban board is inherently wide. Rather than building a fundamentally different mobile layout, the initial release uses horizontal scroll on smaller screens. A dedicated phone layout is deferred to post-MVP.
15. **Lazy plugin activation (Phase 5.5 bugfix)**: The plugin must NOT run `startupSequence()` at load time. OpenCode auto-loads all plugins on startup — an eagerly-activating plugin that spawns servers, starts heartbeats, and hooks into every event creates a catastrophic feedback loop. The plugin loads dormant and activates only on orchestrator activity or explicit `/dashboard` command.
16. **Defense-in-depth against feedback loops (Phase 5.5 bugfix)**: Six independent safeguards prevent event cascades: lazy activation, race-condition-free session guarding (`injectedSessions.add()` before `await`), re-entrancy guard on `refreshAndDiff`, debounced refresh scheduling, orchestrator-only `chat.message` filtering, and `!activated` early-returns in all hooks. Any single layer should be sufficient; all six together make the system robust against unknown OpenCode event model behaviors.

---

## References

- [OpenCode Docs](https://opencode.ai/docs)
- [OpenCode Plugins](https://opencode.ai/docs/plugins/)
- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [OpenCode Server API](https://opencode.ai/docs/server/)
- [OpenCode Agents](https://opencode.ai/docs/agents/)
- [OpenCode Custom Tools](https://opencode.ai/docs/custom-tools/)
- [OpenCode Web UI](https://opencode.ai/docs/web/)
- [Beads (bd)](https://github.com/steveyegge/beads)
- [opencode-beads plugin](https://github.com/joshuadavidthomas/opencode-beads) (reference implementation, not used as dependency)
