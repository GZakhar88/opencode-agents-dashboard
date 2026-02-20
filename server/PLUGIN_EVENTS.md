# Plugin Event Reference

This document describes every event that the `dashboard-bridge.ts` plugin pushes to the dashboard server via `POST /api/plugin/event`.

## Protocol

All events are sent as:
```json
POST /api/plugin/event
{
  "pluginId": "<uuid>",
  "event": "<event-type>",
  "data": { ... }
}
```

The server enriches events with additional fields (e.g., `pipelineId`) before broadcasting to SSE clients. The plugin automatically includes `projectPath` and `timestamp` in every event payload via the `pushEvent()` enrichment layer.

---

## Event Types

### Required Events (from DASHBOARD_PLAN.md)

| # | Event | Status |
|---|-------|--------|
| 1 | `bead:discovered` | Implemented |
| 2 | `bead:claimed` | Implemented |
| 3 | `bead:stage` | Implemented |
| 4 | `bead:done` | Implemented |
| 5 | `bead:error` | Implemented |
| 6 | `agent:active` | Implemented |
| 7 | `agent:idle` | Implemented |
| 8 | `beads:refreshed` | Implemented |

### Additional Events (not in plan, but useful)

| Event | Purpose |
|-------|---------|
| `bead:changed` | Bead status changed (normal transition, not error/done) |
| `bead:removed` | Bead disappeared from `bd list --json` output |

---

## Detailed Event Reference

### `bead:discovered`

A new bead was found in `bd list --json` output that wasn't in the previous snapshot.

**When triggered:**
- On plugin startup (initial bead snapshot — all existing beads pushed as discovered)
- On any `tool.execute.after` hook (via `refreshAndDiff()`)
- On `session.idle` event (via `refreshAndDiff()`)

**Source function:** `refreshAndDiff()` (line ~659), `startupSequence()` (line ~751)

**Payload:**
```json
{
  "bead": {
    "id": "opencode-dashboard-abc",
    "title": "Add auth middleware",
    "description": "...",
    "status": "open",
    "priority": 1,
    "issue_type": "task",
    "created_at": "2026-02-20T09:00:00Z",
    "updated_at": "2026-02-20T09:00:00Z"
  },
  "projectPath": "/Users/.../project-a",
  "timestamp": 1740045600000
}
```

**Notes:**
- On startup, ALL beads are pushed as discovered (establishes baseline for server)
- Beads discovered in blocked/failed-closed state also emit a follow-up `bead:error`

---

### `bead:claimed`

A bead's status changed from any state to `in_progress`, indicating the orchestrator claimed it.

**When triggered:**
- In `tool.execute.after` hook, when `refreshAndDiff()` detects a bead transitioning to `in_progress`

**Source function:** `tool.execute.after` handler (line ~935)

**Payload:**
```json
{
  "beadId": "opencode-dashboard-abc",
  "bead": { "...full BeadRecord..." },
  "stage": "orchestrator",
  "projectPath": "/Users/.../project-a",
  "timestamp": 1740045600000
}
```

**Notes:**
- Sets `currentBeadId` in the plugin for pipeline stage correlation
- If a previous bead was still `in_progress` when a new one is claimed, the previous bead gets a `bead:error` with "abandoned" message

---

### `bead:stage`

A bead is moving to a new pipeline stage (builder, refactor, reviewer, committer).

**When triggered:**
- In `tool.execute.before` hook, when the orchestrator invokes the Task tool with a recognized pipeline agent

**Source function:** `tool.execute.before` handler (line ~882)

**Detection logic:**
1. Hook fires for any tool execution
2. Checks if tool is `task`, `subtask`, or `developer`
3. Extracts agent name from `args.agent`, `args.subagent_type`, or `args.agentName`
4. Maps agent name to stage via `mapSubagentTypeToStage()`
5. Extracts bead ID from task description (e.g., `[bd-a1b2]`) or falls back to `currentBeadId`

**Payload:**
```json
{
  "beadId": "opencode-dashboard-abc",
  "stage": "builder",
  "agentSessionId": "<orchestrator-session-id>",
  "projectPath": "/Users/.../project-a",
  "timestamp": 1740045600000
}
```

**Stage values:** `builder`, `refactor`, `reviewer`, `committer`, `designer`

**Notes:**
- The `agentSessionId` is the orchestrator's session ID at the time of invocation. The actual child agent session ID is reported later in `agent:active`.

---

### `bead:done`

A bead has been closed (status changed to `closed` with a non-failure reason).

**When triggered:**
- In `tool.execute.after` hook, when `refreshAndDiff()` detects a bead transitioning to `closed` status without a failure-indicating close reason

**Source function:** `tool.execute.after` handler (line ~951)

**Payload:**
```json
{
  "beadId": "opencode-dashboard-abc",
  "bead": { "...full BeadRecord..." },
  "projectPath": "/Users/.../project-a",
  "timestamp": 1740045600000
}
```

**Notes:**
- Clears `currentBeadId` if the completed bead was the current one
- If close reason contains failure indicators (fail, reject, abandon, error, abort), a `bead:error` is emitted instead (from the diff logic)

---

### `bead:error`

A bead has entered an error state.

**When triggered (4 scenarios):**

| Scenario | Detection | Source |
|----------|-----------|--------|
| Bead status → `blocked` | `diffBeadState()` detects status change | `refreshAndDiff()` |
| Bead closed with failure reason | `diffBeadState()` checks `close_reason` against failure patterns | `refreshAndDiff()` |
| Bead abandoned | New bead claimed while previous still `in_progress` | `tool.execute.after` handler |
| Discovered bead already in error state | Initial snapshot or new bead already blocked/failed-closed | `refreshAndDiff()` / `startupSequence()` |

**Failure reason patterns (case-insensitive regex):** `fail|reject|abandon|error|abort`

**Payload:**
```json
{
  "beadId": "opencode-dashboard-abc",
  "bead": { "...full BeadRecord..." },
  "error": "Bead status changed to blocked (was: in_progress)",
  "projectPath": "/Users/.../project-a",
  "timestamp": 1740045600000
}
```

**Notes:**
- All `bead:error` payloads include both `beadId` (for easy routing) and the full `bead` object (for display)

---

### `agent:active`

A child agent session has been created and mapped to a pipeline stage.

**When triggered:**
- In the `event` handler for `session.created`, when a child session (has `parentID`) is created and can be mapped to a pipeline agent type

**Source function:** `event` handler, `session.created` branch (line ~1081)

**Agent detection logic:**
1. Check `pendingAgentType` (set by `tool.execute.before` when Task tool was invoked)
2. If not set, infer from session title (e.g., title containing "pipeline-builder")

**Payload:**
```json
{
  "agent": "builder",
  "sessionId": "<child-session-id>",
  "parentSessionId": "<orchestrator-session-id>",
  "beadId": "opencode-dashboard-abc",
  "projectPath": "/Users/.../project-a",
  "timestamp": 1740045600000
}
```

**Agent values:** `builder`, `refactor`, `reviewer`, `committer`, `designer`

---

### `agent:idle`

A child agent session has finished work.

**When triggered:**
- In the `event` handler for `session.idle`, when the idle session is a tracked child agent session

**Source function:** `event` handler, `session.idle` branch (line ~1114)

**Payload:**
```json
{
  "agent": "builder",
  "sessionId": "<child-session-id>",
  "beadId": "opencode-dashboard-abc",
  "projectPath": "/Users/.../project-a",
  "timestamp": 1740045600000
}
```

**Notes:**
- After pushing `agent:idle`, the session-to-agent mapping is cleaned up
- A `refreshAndDiff()` is also triggered (may produce additional bead state events)

---

### `beads:refreshed`

Summary event sent after every bead state refresh that detected changes.

**When triggered:**
- After `refreshAndDiff()` completes with at least one diff
- After initial bead snapshot in `startupSequence()`

**Source function:** `refreshAndDiff()` (line ~680), `startupSequence()` (line ~769)

**Payload:**
```json
{
  "beadCount": 5,
  "changed": 2,
  "projectPath": "/Users/.../project-a",
  "timestamp": 1740045600000
}
```

---

### `bead:changed` (additional)

A bead's status changed normally (not to blocked, not closed with failure).

**When triggered:**
- In `refreshAndDiff()` when a bead's status changes (e.g., `open` → `in_progress`)

**Source function:** `refreshAndDiff()` (line ~663)

**Payload:**
```json
{
  "bead": { "...full BeadRecord..." },
  "prevStatus": "open",
  "projectPath": "/Users/.../project-a",
  "timestamp": 1740045600000
}
```

**Notes:**
- This is distinct from `bead:claimed` and `bead:done`. The `tool.execute.after` handler generates `bead:claimed`/`bead:done` after `refreshAndDiff()` returns diffs. Both the generic `bead:changed` AND the specific `bead:claimed`/`bead:done` will fire for the same transition.

---

### `bead:removed` (additional)

A bead that was in the previous snapshot is no longer in `bd list --json` output.

**When triggered:**
- In `refreshAndDiff()` when a bead ID exists in the previous snapshot but not the current one

**Source function:** `refreshAndDiff()` (line ~669)

**Payload:**
```json
{
  "beadId": "opencode-dashboard-abc",
  "projectPath": "/Users/.../project-a",
  "timestamp": 1740045600000
}
```

---

## Event Flow Diagram

```
Plugin Startup
  │
  ├─ checkServerHealth() → spawnServer() if needed
  ├─ registerWithServer() → pluginId assigned
  ├─ startHeartbeat() → periodic POST /api/plugin/heartbeat
  └─ refreshBeadState() → for each bead:
       ├─ pushEvent("bead:discovered", ...)
       ├─ pushEvent("bead:error", ...)          [if blocked/failed]
       └─ pushEvent("beads:refreshed", ...)

OpenCode Events
  │
  ├─ chat.message → context injection only (no dashboard event)
  │
  ├─ tool.execute.before
  │    └─ Task tool with pipeline agent detected?
  │         └─ pushEvent("bead:stage", ...)
  │
  ├─ tool.execute.after
  │    └─ refreshAndDiff()
  │         ├─ pushEvent("bead:discovered", ...)    [new beads]
  │         ├─ pushEvent("bead:changed", ...)       [status changes]
  │         ├─ pushEvent("bead:error", ...)         [blocked/failed]
  │         ├─ pushEvent("bead:removed", ...)       [deleted beads]
  │         └─ pushEvent("beads:refreshed", ...)    [summary]
  │    └─ Inspect diffs for claim/done:
  │         ├─ pushEvent("bead:claimed", ...)       [open → in_progress]
  │         ├─ pushEvent("bead:done", ...)          [→ closed, normal]
  │         └─ pushEvent("bead:error", ...)         [abandoned bead]
  │
  ├─ session.created (child session)
  │    └─ pushEvent("agent:active", ...)
  │
  ├─ session.idle
  │    ├─ pushEvent("agent:idle", ...)
  │    └─ refreshAndDiff() → [same events as above]
  │
  └─ session.compacted → context re-injection only (no dashboard event)
```

## OpenCode Hook → Event Mapping

| OpenCode Hook | Plugin Handler | Dashboard Events Produced |
|---------------|---------------|--------------------------|
| Plugin startup | `startupSequence()` | `bead:discovered` (×N), `bead:error` (if any), `beads:refreshed` |
| `chat.message` | `chat.message` handler | (none — context injection only) |
| `tool.execute.before` | `tool.execute.before` handler | `bead:stage` (if Task tool with pipeline agent) |
| `tool.execute.after` | `tool.execute.after` handler | `bead:discovered`, `bead:changed`, `bead:error`, `bead:removed`, `beads:refreshed`, `bead:claimed`, `bead:done` |
| `session.created` | `event` handler | `agent:active` (if child session mapped to agent) |
| `session.idle` | `event` handler | `agent:idle` (if tracked agent session), then `refreshAndDiff()` events |
| `session.compacted` | `event` handler | (none — context re-injection only) |

## Payload Field Reference

### Common Fields

All events include `projectPath` and `timestamp` in their payload.

| Field | Type | Description |
|-------|------|-------------|
| `projectPath` | `string` | Absolute path to the project directory (e.g., `/Users/.../project-a`) |
| `timestamp` | `number` | Unix timestamp in milliseconds when the event was generated |

### BeadRecord Object

When events include a `bead` field, it contains the full `bd list --json` record:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Bead identifier (e.g., `opencode-dashboard-abc`) |
| `title` | `string` | Bead title |
| `description` | `string` | Bead description |
| `status` | `string` | `open`, `in_progress`, `blocked`, or `closed` |
| `priority` | `number` | 0 (critical) to 4 (backlog) |
| `issue_type` | `string` | `bug`, `feature`, `task`, `epic`, `chore`, `decision` |
| `created_at` | `string` | ISO timestamp |
| `updated_at` | `string` | ISO timestamp |
| `closed_at` | `string?` | ISO timestamp (if closed) |
| `close_reason` | `string?` | Reason for closing |
| `dependencies` | `array?` | Dependency relationships |

## Server-Side Enrichment

The dashboard server (Phase 3) enriches events before broadcasting to SSE clients:

1. Looks up `projectPath` from `pluginId` (in case the plugin didn't include it)
2. Adds `_serverTimestamp` for server-side timing
3. Adds `pipelineId` from its internal pipeline tracking state
4. Broadcasts as named SSE events to all connected dashboard clients
