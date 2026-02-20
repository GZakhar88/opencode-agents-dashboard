# Phase 0 Spike: Test Plan & Validation

## Overview

This document covers how to test and validate the Phase 0 spike from `DASHBOARD_PLAN.md`. The spike proves that an OpenCode plugin can auto-start a separate Bun server process, POST events to it, and that the server can broadcast SSE to a browser.

## Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **Server** | `server/spike.ts` | Bun HTTP server — health check, event ingestion, SSE broadcast |
| **Plugin** | `~/.config/opencode/plugins/dashboard-spike.ts` | OpenCode plugin — auto-starts server, hooks events, POSTs to server |
| **Validation** | `server/validate-spike.ts` | Automated test script verifying all success criteria |

## Quick Start

### 1. Run automated validation

```bash
# If server is already running:
bun run server/validate-spike.ts

# Auto-start server, run tests, then stop:
bun run server/validate-spike.ts --start
```

### 2. Manual testing (recommended for full validation)

Follow the step-by-step manual test procedures below.

---

## Automated Validation Script

The `server/validate-spike.ts` script tests:

- ✅ Plugin file structure and export convention
- ✅ Server health endpoint
- ✅ CORS headers on all responses
- ✅ Event POST ingestion + SSE broadcast round-trip
- ✅ Multiple plugin instance registration
- ✅ Error handling (invalid JSON, missing fields, 404s)
- ✅ Server resilience after all tests

---

## Manual Test Procedures

### Test 1: Server Starts and Responds

**Goal:** Verify the server starts and exposes all endpoints.

```bash
# Start the server
bun run server/spike.ts

# In another terminal, check health
curl http://localhost:3333/api/health
# Expected: {"status":"ok","uptime":...,"clients":0,"plugins":0,"events":0}

# Check info
curl http://localhost:3333/api/info
# Expected: {"name":"dashboard-spike","port":3333,"uptime":...,"pid":...,"clients":0,"plugins":[],"events":0}
```

### Test 2: SSE Stream Works in Browser

**Goal:** Verify SSE events flow to browser clients.

1. Start the server: `bun run server/spike.ts`
2. Open browser to: `http://localhost:3333/api/events`
3. You should see an initial `connected` event with JSON data
4. In a terminal, send a test event:

```bash
curl -X POST http://localhost:3333/api/plugin/event \
  -H "Content-Type: application/json" \
  -d '{"pluginId":"manual-test","event":"test:hello","data":{"message":"Hello from curl"}}'
```

5. The browser should display a new SSE message:
   ```
   event: test:hello
   data: {"message":"Hello from curl","_serverTimestamp":...,"_eventCount":1}
   ```

### Test 3: Plugin Auto-Starts Server

**Goal:** Verify the plugin detects no server and spawns one.

1. Make sure the server is **not running**:
   ```bash
   # Kill any existing server
   lsof -ti :3333 | xargs kill 2>/dev/null
   # Verify
   curl http://localhost:3333/api/health 2>/dev/null || echo "Server not running (expected)"
   ```

2. Start OpenCode in any project directory. The plugin should auto-start the server.

3. Watch the OpenCode output for these log lines:
   ```
   [dashboard-spike] Plugin loading for <project-name>
   [dashboard-spike] Server not running — spawning at ...
   [dashboard-spike] Waiting for server to start...
   [dashboard-spike] Server started successfully
   ```

4. Verify the server is now running:
   ```bash
   curl http://localhost:3333/api/health
   # Expected: {"status":"ok",...}
   ```

### Test 4: Second Instance Detects Running Server

**Goal:** Verify a second OpenCode instance connects without spawning a duplicate.

1. With the server already running (from Test 3), open a **second terminal**.

2. Start OpenCode in a different project directory.

3. Watch for these log lines:
   ```
   [dashboard-spike] Plugin loading for <different-project>
   [dashboard-spike] Server already running at http://localhost:3333
   ```

4. Verify both plugins registered:
   ```bash
   curl http://localhost:3333/api/info
   # Expected: "plugins" array with 2 entries
   ```

5. Verify no port conflicts — only one server process:
   ```bash
   lsof -i :3333
   # Expected: exactly one bun process
   ```

### Test 5: Server Survives OpenCode Exit

**Goal:** Verify the server keeps running after its parent OpenCode exits.

1. Server should be running (from Test 3 or 4).
2. Note the server PID:
   ```bash
   curl -s http://localhost:3333/api/info | grep -o '"pid":[0-9]*'
   ```
3. Kill/exit OpenCode (Ctrl+C or close the terminal).
4. Verify the server is still running:
   ```bash
   curl http://localhost:3333/api/health
   # Expected: {"status":"ok",...} — server still responds
   ```

### Test 6: Events Flow During OpenCode Interaction

**Goal:** Verify that interacting with OpenCode produces events visible in SSE.

1. Server should be running with at least one OpenCode instance connected.
2. Open browser to: `http://localhost:3333/api/events`
3. In OpenCode, perform any action (send a message, use a tool, etc.).
4. Watch the browser — events should appear:
   - `opencode:event` — general OpenCode events
   - `opencode:tool.after` — after tool executions
   - `opencode:chat.message` — when sending messages
5. Each event includes `projectPath`, `projectName`, `pluginId`, and `timestamp`.

### Test 7: Graceful Degradation

**Goal:** Verify the plugin works even if the server can't start.

1. Kill the server and block port 3333:
   ```bash
   lsof -ti :3333 | xargs kill 2>/dev/null
   # Optionally: start something else on 3333 to simulate port conflict
   python3 -c "import http.server; http.server.HTTPServer(('',3333), http.server.SimpleHTTPRequestHandler).serve_forever()" &
   ```

2. Start OpenCode. Watch for:
   ```
   [dashboard-spike] Server not running — spawning at ...
   [dashboard-spike] Waiting for server to start...
   [dashboard-spike] Server failed to start within timeout. Plugin will continue without dashboard connectivity.
   ```

3. OpenCode should continue to work normally — the plugin degrades gracefully.

4. Clean up:
   ```bash
   kill %1  # kill the python server
   ```

---

## Success Criteria Checklist

From `DASHBOARD_PLAN.md` Phase 0:

| # | Criterion | Test |
|---|-----------|------|
| 1 | Plugin starts, detects no server, spawns the server process | Test 3 |
| 2 | Open `http://localhost:3333/api/events` in browser, see SSE events flowing | Test 2, Test 6 |
| 3 | Events appear when interacting with OpenCode (sessions, tool calls, etc.) | Test 6 |
| 4 | Server survives OpenCode exit (kill OpenCode, server still responds) | Test 5 |
| 5 | Start a second OpenCode instance — its plugin detects server is already running, connects without spawning a second server | Test 4 |
| 6 | No crashes or port conflicts | All tests |

## Plugin Architecture Notes

### Export Convention
The plugin exports a named `Plugin` type function:
```typescript
export const DashboardSpike: Plugin = async ({ directory }) => { ... }
```
This matches the `@opencode-ai/plugin` SDK convention (see `example.d.ts`).

### Hooks Implemented
| Hook | Purpose |
|------|---------|
| `event` | Forwards all OpenCode events to the server |
| `tool.execute.after` | Reports tool execution completions |
| `chat.message` | Reports new chat messages / session starts |

### Known Limitations (Acceptable for Spike)
- `serverReady` is set once at startup and never updated. If the server goes down mid-session, events silently fail (fire-and-forget). This is fine for a spike; the full plugin (Phase 2) will add reconnection logic.
- The plugin uses Bun-specific APIs (`Bun.spawn`, `Bun.sleep`). OpenCode runs on Bun, so this is expected.
- Server path is hardcoded to the developer's machine. The full plugin will resolve this dynamically.

## Cleanup

To stop the server after testing:
```bash
# Find and kill the server process
lsof -ti :3333 | xargs kill

# Verify
curl http://localhost:3333/api/health 2>/dev/null || echo "Server stopped"
```

To remove the spike plugin:
```bash
rm ~/.config/opencode/plugins/dashboard-spike.ts
```
