/**
 * Dashboard Bridge Plugin — Phase 1 & 2: Context Injection, Server Bridge,
 * Bead State Tracking, and Pipeline Stage Detection
 *
 * Phase 1: Injects `bd prime` context and pipeline guidance into orchestrator
 * sessions on startup and after compaction.
 *
 * Phase 2: Auto-starts the dashboard server if needed, registers with it,
 * and maintains a periodic heartbeat. Tracks bead state by running
 * `bd list --json` and diffing snapshots. Pushes structured events to
 * the dashboard server. Degrades gracefully if the server is unavailable
 * (context injection continues to work independently).
 *
 * Pipeline stage detection via OpenCode event hooks:
 * - `tool.execute.before`: Detects Task tool invocations to identify pipeline
 *   stage transitions (builder, refactor, reviewer, committer).
 * - `tool.execute.after`: Refreshes bead state after any tool execution,
 *   detects bead claims (in_progress) and completions (closed).
 * - `session.created`: Maps child sessions to agent types.
 * - `session.idle`: Detects when agents finish work, refreshes bead state.
 *
 * Install: place in ~/.config/opencode/plugins/dashboard-bridge.ts
 * Coexists with dashboard-spike.ts
 */

import type { Plugin } from "@opencode-ai/plugin";

// ─── Bead state types ──────────────────────────────────────────

/**
 * Raw bead record from `bd list --json`.
 * Matches the actual output format of the bd CLI.
 */
interface BeadRecord {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  issue_type: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
  dependencies?: Array<{
    issue_id: string;
    depends_on_id: string;
    type: string;
    created_at?: string;
    created_by?: string;
    metadata?: string;
  }>;
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
}

/**
 * A single diff entry between two bead snapshots.
 *
 * - `discovered`: bead exists in `next` but not `prev` (new bead appeared)
 * - `changed`: bead exists in both but status/fields differ
 * - `removed`: bead exists in `prev` but not `next` (bead deleted)
 * - `error`: bead transitioned to an error state (e.g., blocked)
 */
type BeadDiff =
  | { type: "discovered"; bead: BeadRecord }
  | { type: "changed"; bead: BeadRecord; prevStatus: string }
  | { type: "removed"; beadId: string }
  | { type: "error"; bead: BeadRecord; error: string };

const LOG_PREFIX = "[dashboard-bridge]";

// ─── Debug-gated logging ───────────────────────────────────────
// All plugin logging is silent by default to avoid corrupting
// OpenCode's TUI. Set DASHBOARD_DEBUG=1 to enable.
const DEBUG = process.env.DASHBOARD_DEBUG === "1";
const log = (...args: unknown[]) => { if (DEBUG) console.error(LOG_PREFIX, ...args); };
const warn = (...args: unknown[]) => { if (DEBUG) console.error(LOG_PREFIX, "[warn]", ...args); };
const logError = (...args: unknown[]) => { if (DEBUG) console.error(LOG_PREFIX, "[error]", ...args); };

// ─── Server configuration ──────────────────────────────────────
const SERVER_URL = "http://localhost:3333";
// Note: server/index.ts is created in Phase 3. Until then, auto-start will
// fail gracefully and the plugin falls back to context-injection-only mode.
const SERVER_PATH = "/Users/gaborzakhar/Dev/opencode-dashboard/server/index.ts";
const HEALTH_ENDPOINT = `${SERVER_URL}/api/health`;
const REGISTER_ENDPOINT = `${SERVER_URL}/api/plugin/register`;
const HEARTBEAT_ENDPOINT = `${SERVER_URL}/api/plugin/heartbeat`;
const EVENT_ENDPOINT = `${SERVER_URL}/api/plugin/event`;
const DEREGISTER_ENDPOINT = `${SERVER_URL}/api/plugin`; // + /:pluginId
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const SPAWN_POLL_INTERVAL_MS = 500;
const SPAWN_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 5_000;

// ─── Module-level state (Phase 2) ─────────────────────────────
let pluginId: string | null = null;
let serverReady = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let cleanupRegistered = false;
let lastBeadSnapshot: BeadRecord[] = [];
// Bun shell reference, stored at module scope so that functions called
// outside the plugin closure (e.g., future periodic bead-refresh timers)
// can access it without threading `$` through every call site.
let shellRef: any = null;
// Project path, stored at module scope so pushEvent can include it in all payloads.
let projectPath: string = "";

// ─── Phase 5.5 Bugfix: Activation & safety state ──────────────
// The plugin loads dormant and only activates when the orchestrator
// is detected or the user runs `/dashboard`.
let activated = false;
let activating = false;
// Re-entrancy guard for refreshAndDiff (Layer 3)
let isRefreshing = false;
// Debounce timer for scheduled refreshes (Layer 4)
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Pipeline stage tracking (Phase 2: hooks) ─────────────────
// Which bead is currently being worked on by the orchestrator.
// Set when a bead transitions to in_progress, cleared on close.
let currentBeadId: string | null = null;
// Map child session IDs to their agent type (builder/refactor/reviewer/committer).
const sessionToAgent = new Map<string, string>();
// Track the most recently detected agent type from Task tool invocations,
// so we can correlate it when session.created fires for the child session.
let pendingAgentType: string | null = null;

// ─── Pipeline guidance injected into sessions ──────────────────
const PIPELINE_GUIDANCE = `<pipeline-guidance>
## Beads CLI Usage

Use the \`bash\` tool for all beads operations. Always use \`--json\` flag:
- \`bd ready --json\` - List ready tasks
- \`bd show <id> --json\` - Show task details
- \`bd update <id> --status in_progress --json\` - Claim a bead
- \`bd close <id> --reason "message" --json\` - Complete a bead
- \`bd list --status open --json\` - List all open issues

## Pipeline Workflow

When working on beads:
1. Run \`bd ready --json\` to find work
2. Claim with \`bd update <id> --status in_progress --json\`
3. Run pipeline stages in order:
   - pipeline-builder (implement the feature)
   - pipeline-refactor (improve code quality - optional)
   - pipeline-reviewer (review and fix issues)
   - pipeline-committer (create git commit)
4. Close with \`bd close <id> --reason "message" --json\`

Include the bead ID in Task descriptions (e.g., "Build: [bd-a1b2] Add auth middleware").
</pipeline-guidance>`;

// ─── Track which sessions have been injected ───────────────────
const injectedSessions = new Set<string>();

/**
 * Run `bd prime` and return its output, or null if unavailable.
 */
async function getBdPrimeOutput(
  $: any
): Promise<string | null> {
  try {
    const result = await $`bd prime`.text();
    const trimmed = result.trim();
    if (!trimmed) return null;
    return trimmed;
  } catch {
    // bd not installed, not in a bd repo, or command failed
    return null;
  }
}

/**
 * Build the full context message to inject into a session.
 */
function buildContextMessage(bdPrime: string | null): string {
  const parts: string[] = [];

  if (bdPrime) {
    parts.push(`<beads-context>\n${bdPrime}\n</beads-context>`);
  }

  parts.push(PIPELINE_GUIDANCE);

  return parts.join("\n\n");
}

/**
 * Inject context into a session via a synthetic noReply message.
 *
 * IMPORTANT (Phase 5.5 bugfix): `injectedSessions.add(sessionID)` is called
 * BEFORE `await client.session.prompt()` to close the race window where
 * `session.prompt()` triggers `chat.message` for the same session while
 * the await is pending. On failure, the guard is rolled back so injection
 * can be retried.
 */
async function injectContext(
  client: any,
  sessionID: string,
  model: { providerID: string; modelID: string } | undefined,
  agent: string | undefined,
  $: any
): Promise<void> {
  // Skip if already injected
  if (injectedSessions.has(sessionID)) {
    log(`Session ${sessionID} already injected, skipping`);
    return;
  }

  // Layer 2: Mark BEFORE the await to prevent re-entrancy via chat.message
  injectedSessions.add(sessionID);

  const bdPrime = await getBdPrimeOutput($);
  const contextMessage = buildContextMessage(bdPrime);

  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
        parts: [
          {
            type: "text" as const,
            text: contextMessage,
            synthetic: true,
          },
        ],
      },
    });

    log(
      `Injected context into session ${sessionID}` +
        (bdPrime ? " (with bd prime)" : " (pipeline guidance only)")
    );
  } catch (err) {
    // Rollback guard so injection can be retried on next message
    injectedSessions.delete(sessionID);
    logError(`Failed to inject context into session ${sessionID}:`, err);
  }
}

/**
 * Check if a session is a child session (sub-agent).
 * Only orchestrator (root) sessions should receive injections.
 */
async function isChildSession(
  client: any,
  sessionID: string
): Promise<boolean> {
  try {
    const result = await client.session.get({ path: { id: sessionID } });
    const session = result?.data;
    return !!session?.parentID;
  } catch {
    // If we can't determine, assume it's not a child (inject anyway)
    return false;
  }
}

/**
 * Get model/agent context from recent messages in a session.
 * Used after compaction when we don't have the original context.
 */
async function getSessionContext(
  client: any,
  sessionID: string
): Promise<{
  model?: { providerID: string; modelID: string };
  agent?: string;
}> {
  try {
    const result = await client.session.messages({
      path: { id: sessionID },
      query: { limit: 50 },
    });

    const messages = result?.data;
    if (!messages || !Array.isArray(messages)) return {};

    // Walk messages in reverse to find the most recent model/agent info
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]?.info;
      if (msg?.role === "user" && msg?.model) {
        return {
          model: msg.model,
          agent: msg.agent,
        };
      }
    }

    return {};
  } catch {
    return {};
  }
}

/**
 * Check if context was already injected by scanning recent messages.
 * Handles plugin reload / reconnection scenarios.
 */
async function hasExistingContext(
  client: any,
  sessionID: string
): Promise<boolean> {
  try {
    const result = await client.session.messages({
      path: { id: sessionID },
      query: { limit: 50 },
    });

    const messages = result?.data;
    if (!messages || !Array.isArray(messages)) return false;

    for (const msg of messages) {
      const parts = msg?.parts;
      if (!parts || !Array.isArray(parts)) continue;
      for (const part of parts) {
        if (
          part?.type === "text" &&
          typeof part.text === "string" &&
          part.text.includes("<pipeline-guidance>")
        ) {
          return true;
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

// ─── Server interaction (Phase 2) ──────────────────────────────

/**
 * Check if the dashboard server is reachable.
 */
async function checkServerHealth(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_ENDPOINT, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn the dashboard server as a detached Bun process.
 * Polls /api/health until the server is ready or timeout is reached.
 * Returns true if the server came up successfully.
 */
async function spawnServer(): Promise<boolean> {
  log(`Server not running, attempting to auto-start...`);
  log(`Spawning: bun run ${SERVER_PATH}`);

  try {
    const proc = Bun.spawn([process.execPath, "run", SERVER_PATH], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    // Unref so the plugin process doesn't wait for the server to exit
    proc.unref();
    log(`Spawned server process (PID: ${proc.pid})`);
  } catch (err) {
    logError(`Failed to spawn server process:`, err);
    return false;
  }

  // Poll for readiness
  const maxAttempts = Math.ceil(SPAWN_TIMEOUT_MS / SPAWN_POLL_INTERVAL_MS);
  for (let i = 0; i < maxAttempts; i++) {
    await Bun.sleep(SPAWN_POLL_INTERVAL_MS);
    if (await checkServerHealth()) {
      log(`Server started successfully (attempt ${i + 1}/${maxAttempts})`);
      return true;
    }
  }

  warn(`Server failed to start within ${SPAWN_TIMEOUT_MS}ms`);
  return false;
}

/**
 * Register this plugin instance with the dashboard server.
 * Returns the assigned pluginId, or null on failure.
 */
async function registerWithServer(
  projectPath: string,
  projectName: string
): Promise<string | null> {
  try {
    const res = await fetch(REGISTER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath, projectName }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      logError(`Registration failed: HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { pluginId?: string };
    if (!data.pluginId) {
      logError(`Registration response missing pluginId`);
      return null;
    }

    log(`Registered with server, pluginId: ${data.pluginId}`);
    return data.pluginId;
  } catch (err) {
    logError(`Registration failed:`, err);
    return null;
  }
}

/**
 * Send a heartbeat to the dashboard server.
 * If the heartbeat fails, mark the server as unreachable.
 */
async function sendHeartbeat(): Promise<void> {
  if (!pluginId || !serverReady) return;

  try {
    const res = await fetch(HEARTBEAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pluginId }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      warn(`Heartbeat failed: HTTP ${res.status}`);
    }
  } catch (err) {
    warn(`Heartbeat failed:`, err);
    // Don't set serverReady = false on transient failures;
    // the server may recover. The server-side timeout (90s) handles
    // prolonged disconnections.
  }
}

/**
 * Start the periodic heartbeat timer.
 */
function startHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  log(`Heartbeat started (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop the periodic heartbeat timer.
 */
function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    log(`Heartbeat stopped`);
  }
}

/**
 * Deregister this plugin from the dashboard server.
 * Called on plugin shutdown.
 *
 * Uses `keepalive: true` so the request survives process shutdown — the
 * browser/runtime will finish sending the request even after the page
 * (or Node/Bun process) begins teardown.  This is the primary reliability
 * mechanism; the process-exit hooks in `startupSequence` are a secondary
 * safety net.
 */
async function deregisterFromServer(): Promise<void> {
  if (!pluginId || !serverReady) return;

  // Capture and clear pluginId to prevent duplicate deregistration
  // (e.g., if both a signal handler and beforeExit fire).
  const id = pluginId;
  pluginId = null;

  try {
    await fetch(`${DEREGISTER_ENDPOINT}/${id}`, {
      method: "DELETE",
      keepalive: true,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    log(`Deregistered from server (pluginId: ${id})`);
  } catch (err) {
    warn(`Deregistration failed (server will detect via heartbeat timeout):`, err);
  }
}

// ─── Pipeline stage helpers (Phase 2: hooks) ──────────────────

/**
 * Map a subagent type name to a pipeline stage name.
 * e.g., "pipeline-builder" → "builder", "pipeline-refactor" → "refactor"
 */
function mapSubagentTypeToStage(agentType: string): string | null {
  const mapping: Record<string, string> = {
    "pipeline-builder": "builder",
    "pipeline-refactor": "refactor",
    "pipeline-reviewer": "reviewer",
    "pipeline-committer": "committer",
    // Also support bare names (in case agent names lack the "pipeline-" prefix)
    builder: "builder",
    refactor: "refactor",
    reviewer: "reviewer",
    committer: "committer",
    // Designer is an optional stage
    designer: "designer",
  };
  return mapping[agentType] ?? null;
}

/**
 * Extract a bead ID from a Task description string.
 * Matches patterns like "[bd-a1b2]", "[opencode-dashboard-bom]", etc.
 * Returns the bead ID (without brackets) or null if not found.
 */
function extractBeadId(text: string): string | null {
  // Match [some-id] where ID contains word chars and hyphens
  const match = text.match(/\[([a-zA-Z0-9][\w-]*)\]/);
  return match ? match[1] : null;
}

// ─── Bead state tracking (Phase 2) ────────────────────────────

/**
 * Run `bd list --json` to get the current bead state.
 * Uses the Bun shell `$` provided by the plugin context.
 * Returns an empty array if bd is not installed, not initialized,
 * or the command fails for any reason.
 */
async function refreshBeadState($: any): Promise<BeadRecord[]> {
  try {
    const output = await $`bd list --json`.text();
    const trimmed = output.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      warn(`bd list --json returned non-array:`, typeof parsed);
      return [];
    }
    return parsed as BeadRecord[];
  } catch (err) {
    // bd not installed, not in a bd repo, or command/parse failed
    warn(`Failed to refresh bead state:`, err);
    return [];
  }
}

/**
 * Compare two bead snapshots and return a list of diffs.
 *
 * Detects:
 * - New beads (in `next` but not `prev`) → `discovered`
 * - Status changes (same ID, different status) → `changed` or `error`
 * - Removed beads (in `prev` but not `next`) → `removed`
 * - Error states (status changed to `blocked`) → `error`
 */
function diffBeadState(prev: BeadRecord[], next: BeadRecord[]): BeadDiff[] {
  const diffs: BeadDiff[] = [];

  const prevMap = new Map<string, BeadRecord>();
  for (const bead of prev) {
    prevMap.set(bead.id, bead);
  }

  const nextMap = new Map<string, BeadRecord>();
  for (const bead of next) {
    nextMap.set(bead.id, bead);
  }

  // Check for new and changed beads
  for (const [id, bead] of nextMap) {
    const prevBead = prevMap.get(id);

    if (!prevBead) {
      // New bead discovered — also check if it's already in an error state
      diffs.push({ type: "discovered", bead });

      if (bead.status === "blocked") {
        diffs.push({
          type: "error",
          bead,
          error: `Discovered bead already blocked`,
        });
      } else if (
        bead.status === "closed" &&
        bead.close_reason &&
        /fail|reject|abandon|error|abort/i.test(bead.close_reason)
      ) {
        diffs.push({
          type: "error",
          bead,
          error: `Discovered bead closed with failure: ${bead.close_reason}`,
        });
      }

      continue;
    }

    // Check for status change
    if (prevBead.status !== bead.status) {
      // Detect error conditions
      if (bead.status === "blocked") {
        diffs.push({
          type: "error",
          bead,
          error: `Bead status changed to blocked (was: ${prevBead.status})`,
        });
      } else if (
        bead.status === "closed" &&
        bead.close_reason &&
        /fail|reject|abandon|error|abort/i.test(bead.close_reason)
      ) {
        // Closed with a failure-indicating reason
        diffs.push({
          type: "error",
          bead,
          error: `Bead closed with failure: ${bead.close_reason}`,
        });
      } else {
        // Normal status change
        diffs.push({
          type: "changed",
          bead,
          prevStatus: prevBead.status,
        });
      }
    }
  }

  // Check for removed beads
  for (const [id] of prevMap) {
    if (!nextMap.has(id)) {
      diffs.push({ type: "removed", beadId: id });
    }
  }

  return diffs;
}

/**
 * Push a structured event to the dashboard server.
 * Fire-and-forget: logs warnings on failure but does not throw.
 * Only sends if the server is connected and we have a pluginId.
 *
 * Automatically enriches the payload with `projectPath` and `timestamp`
 * so all events are self-contained and consistent per DASHBOARD_PLAN.md.
 */
async function pushEvent(event: string, data: unknown): Promise<void> {
  if (!pluginId || !serverReady) return;

  // Enrich with projectPath and timestamp — these are authoritative and
  // placed after the spread so callers cannot accidentally override them.
  const enrichedData =
    data != null && typeof data === "object"
      ? {
          ...(data as Record<string, unknown>),
          projectPath,
          timestamp: Date.now(),
        }
      : { data, projectPath, timestamp: Date.now() };

  try {
    const res = await fetch(EVENT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pluginId, event, data: enrichedData }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      warn(`pushEvent(${event}) failed: HTTP ${res.status}`);
    }
  } catch (err) {
    warn(`pushEvent(${event}) failed:`, err);
  }
}

/**
 * Refresh bead state, diff against the previous snapshot, and push
 * any changes as events to the dashboard server.
 *
 * Updates `lastBeadSnapshot` with the new state.
 * Returns the computed diffs (useful for callers that need to inspect changes).
 *
 * Layer 3 (Phase 5.5 bugfix): Re-entrancy guard prevents concurrent
 * executions when multiple hooks fire in rapid succession.
 */
async function refreshAndDiff($: any): Promise<BeadDiff[]> {
  // Layer 3: Skip if already refreshing
  if (isRefreshing) {
    log(`refreshAndDiff skipped (already in progress)`);
    return [];
  }
  isRefreshing = true;

  try {
    const next = await refreshBeadState($);
    const diffs = diffBeadState(lastBeadSnapshot, next);
    lastBeadSnapshot = next;

    if (diffs.length === 0) return diffs;

    log(`Bead state changed: ${diffs.length} diff(s)`);

    // Push each diff as a structured event
    for (const diff of diffs) {
      switch (diff.type) {
        case "discovered":
          await pushEvent("bead:discovered", { bead: diff.bead });
          break;
        case "changed":
          await pushEvent("bead:changed", {
            bead: diff.bead,
            prevStatus: diff.prevStatus,
          });
          break;
        case "removed":
          await pushEvent("bead:removed", { beadId: diff.beadId });
          break;
        case "error":
          await pushEvent("bead:error", {
            beadId: diff.bead.id,
            bead: diff.bead,
            error: diff.error,
          });
          break;
      }
    }

    // Also push a summary refresh event with the authoritative bead ID set
    // so the server can reconcile stale persisted beads.
    await pushEvent("beads:refreshed", {
      beadCount: next.length,
      changed: diffs.length,
      beadIds: next.map((b) => b.id),
    });

    return diffs;
  } finally {
    isRefreshing = false;
  }
}

/**
 * Layer 4 (Phase 5.5 bugfix): Debounced wrapper around `refreshAndDiff`.
 *
 * Replaces direct `refreshAndDiff($)` calls in event hooks. When multiple
 * events fire in rapid succession (which is normal during tool execution),
 * this batches them into a single `bd list --json` call after the delay.
 *
 * Uses trailing-edge debounce: the refresh runs `delayMs` after the LAST
 * call, not the first. This ensures we capture the final state after a
 * burst of events.
 */
function scheduleRefresh($: any, delayMs: number = 500): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      const diffs = await refreshAndDiff($);
      await processDiffs(diffs);
    } catch (err) {
      warn(`Scheduled refresh failed:`, err);
    }
  }, delayMs);
}

/**
 * Process bead diffs to detect bead claims, completions, and errors.
 * Updates `currentBeadId` tracking and pushes high-level events
 * (bead:claimed, bead:done, bead:error) to the dashboard server.
 *
 * Extracted from the original `tool.execute.after` handler so it can
 * be called from both immediate and debounced refresh paths.
 */
async function processDiffs(diffs: BeadDiff[]): Promise<void> {
  for (const diff of diffs) {
    if (diff.type === "changed") {
      // Detect bead claimed (status changed to in_progress)
      if (diff.bead.status === "in_progress" && diff.prevStatus !== "in_progress") {
        const prevBeadId = currentBeadId;
        currentBeadId = diff.bead.id;
        log(
          `Bead claimed: ${diff.bead.id} (was: ${prevBeadId ?? "none"})`
        );

        // If there was a previous bead that wasn't closed, flag it as abandoned
        if (prevBeadId && prevBeadId !== diff.bead.id) {
          const prevBead = lastBeadSnapshot.find(
            (b) => b.id === prevBeadId && b.status === "in_progress"
          );
          if (prevBead) {
            warn(
              `Previous bead ${prevBeadId} may have been abandoned`
            );
            await pushEvent("bead:error", {
              beadId: prevBead.id,
              bead: prevBead,
              error: "Bead abandoned — new bead claimed before this one was closed",
            });
          }
        }

        await pushEvent("bead:claimed", {
          beadId: diff.bead.id,
          bead: diff.bead,
          stage: "orchestrator",
        });
      }

      // Detect bead closed
      if (diff.bead.status === "closed" && diff.prevStatus !== "closed") {
        const wasCurrent = currentBeadId === diff.bead.id;
        if (wasCurrent) {
          currentBeadId = null;
          log(`Current bead closed: ${diff.bead.id}`);
        }

        await pushEvent("bead:done", {
          beadId: diff.bead.id,
          bead: diff.bead,
        });
      }
    }

    // Also detect newly discovered beads that are already in_progress
    // (e.g., plugin restarted while a bead was being worked on)
    if (
      diff.type === "discovered" &&
      diff.bead.status === "in_progress" &&
      !currentBeadId
    ) {
      currentBeadId = diff.bead.id;
      log(
        `Discovered in-progress bead, setting as current: ${diff.bead.id}`
      );
    }

    // Clear currentBeadId when a bead enters an error state
    // (blocked or failure-closed)
    if (
      diff.type === "error" &&
      currentBeadId === diff.bead.id &&
      (diff.bead.status === "blocked" || diff.bead.status === "closed")
    ) {
      currentBeadId = null;
      log(
        `Current bead entered error state: ${diff.bead.id} (${diff.bead.status})`
      );
    }
  }
}

/**
 * Run the full server startup sequence:
 * 1. Check if server is reachable
 * 2. If not, try to auto-start it
 * 3. Register with server
 * 4. Start heartbeat
 * 5. Initial bead state fetch (baseline for future diffs)
 *
 * Sets module-level `serverReady` and `pluginId` state.
 */
async function startupSequence(
  projectPath: string,
  projectName: string,
  $: any
): Promise<void> {
  // Step 1: Check if server is already running
  let isHealthy = await checkServerHealth();

  // Step 2: Auto-start if needed
  if (!isHealthy) {
    isHealthy = await spawnServer();
  }

  if (!isHealthy) {
    warn(
        `Dashboard server unavailable — plugin degrades gracefully. ` +
        `Context injection still works; tracking/dashboard disabled.`
    );
    serverReady = false;
    return;
  }

  log(`Dashboard server is reachable`);

  // Step 3: Register
  const id = await registerWithServer(projectPath, projectName);
  if (!id) {
    warn(
        `Registration failed — plugin degrades gracefully. ` +
        `Context injection still works; tracking/dashboard disabled.`
    );
    serverReady = false;
    return;
  }

  pluginId = id;
  serverReady = true;

  // Step 4: Start heartbeat
  startHeartbeat();

  // Step 5: Initial bead state fetch — establishes baseline for future diffs.
  // We run refreshBeadState (not refreshAndDiff) because there's no previous
  // snapshot to diff against. All beads in the initial snapshot are pushed
  // as "discovered" events to give the server the full initial picture.
  const initialBeads = await refreshBeadState($);
  lastBeadSnapshot = initialBeads;

  if (initialBeads.length > 0) {
    log(`Initial bead snapshot: ${initialBeads.length} bead(s)`);
    // Push each initial bead as discovered so the server gets the full picture.
    // Also flag any beads that are already in an error state.
    for (const bead of initialBeads) {
      await pushEvent("bead:discovered", { bead });

      if (bead.status === "blocked") {
        await pushEvent("bead:error", {
          beadId: bead.id,
          bead,
          error: "Discovered bead already blocked",
        });
      } else if (
        bead.status === "closed" &&
        bead.close_reason &&
        /fail|reject|abandon|error|abort/i.test(bead.close_reason)
      ) {
        await pushEvent("bead:error", {
          beadId: bead.id,
          bead,
          error: `Discovered bead closed with failure: ${bead.close_reason}`,
        });
      }
    }
  } else {
    log(`No beads found (bd not initialized or no issues)`);
  }

  // Always send beads:refreshed — even with 0 beads — so the server can
  // reconcile stale persisted beads that no longer exist in bd.
  // The beadIds array is the authoritative set of current bead IDs.
  await pushEvent("beads:refreshed", {
    beadCount: initialBeads.length,
    changed: initialBeads.length,
    beadIds: initialBeads.map((b) => b.id),
  });

  // Step 6: Register process exit cleanup (once per process lifetime)
  //
  // `keepalive: true` on the fetch in `deregisterFromServer()` is the
  // primary mechanism — it tells the runtime to finish sending the
  // request even during teardown. The hooks below are a secondary
  // safety net:
  //
  // - `beforeExit`: fires when the event loop drains; we can still
  //   await the deregistration here because the loop restarts.
  // - `SIGINT` / `SIGTERM`: the host process handles exit; we just
  //   initiate the keepalive fetch as early as possible.
  if (!cleanupRegistered) {
    cleanupRegistered = true;

    // beforeExit: the event loop is empty but the process hasn't exited
    // yet. We can extend the loop by awaiting the deregistration.
    process.on("beforeExit", async () => {
      stopHeartbeat();
      await deregisterFromServer();
    });

    // SIGINT / SIGTERM: The host process (OpenCode) handles the actual
    // exit. We just initiate deregistration here — keepalive: true on
    // the fetch ensures the DELETE request is flushed by the runtime
    // even if the process begins tearing down immediately after.
    // NOTE: We do NOT call process.exit() here because this is a plugin
    // inside the host process; the host manages its own shutdown.
    const signalCleanup = () => {
      stopHeartbeat();
      // Fire-and-forget — keepalive: true ensures delivery
      deregisterFromServer().catch(() => {});
    };
    process.on("SIGINT", signalCleanup);
    process.on("SIGTERM", signalCleanup);
  }
}

// ─── Plugin export ─────────────────────────────────────────────

export const DashboardBridge: Plugin = async ({ client, directory, $ }) => {
  const projectName = directory.split("/").pop() || "unknown";
  log(`Plugin loaded for ${projectName} (dormant — waiting for orchestrator or /dashboard)`);
  log(`Directory: ${directory}`);

  // Store project path and shell reference for module-level access
  projectPath = directory;
  shellRef = $;

  // Phase 5.5 bugfix (Layer 1): Do NOT call startupSequence() here.
  // The plugin loads dormant. Activation happens only when:
  // 1. chat.message detects input.agent === "orchestrator", OR
  // 2. The user runs /dashboard (intercepted by command.execute.before)

  return {
    // ─── Manual activation via /dashboard command ──────────────
    "command.execute.before": async (input: any, output: any) => {
      try {
        if (input.command === "dashboard") {
          if (!activated && !activating) {
            log(`/dashboard command received — activating plugin`);
            activating = true;
            await startupSequence(directory, projectName, $);
            activated = true;
            activating = false;
            log(`Plugin activated via /dashboard command`);
          } else if (activated) {
            log(`/dashboard command received — plugin already active`);
          } else {
            log(`/dashboard command received — activation already in progress`);
          }
        }
      } catch (err) {
        activating = false;
        logError(`Error in command.execute.before hook:`, err);
      }
    },

    // ─── Inject context on first message in a session ──────────
    "chat.message": async (input: any, output: any) => {
      const sessionID = input.sessionID;
      const model = input.model;
      const agent = input.agent;

      // Layer 1: Auto-detect orchestrator and activate if dormant
      if (!activated && !activating && agent === "orchestrator") {
        log(`Orchestrator detected — activating plugin`);
        activating = true;
        try {
          await startupSequence(directory, projectName, $);
          activated = true;
        } catch (err) {
          logError(`Activation failed:`, err);
        } finally {
          activating = false;
        }
      }

      // Layer 5: Skip non-orchestrator sessions immediately.
      // Mark them in injectedSessions to avoid re-checking on future messages.
      if (agent && agent !== "orchestrator") {
        if (!injectedSessions.has(sessionID)) {
          injectedSessions.add(sessionID);
          log(`Skipping non-orchestrator session ${sessionID} (agent: ${agent})`);
        }
        return;
      }

      // Skip if already injected in this plugin lifetime
      if (injectedSessions.has(sessionID)) return;

      // Skip child sessions (sub-agents)
      if (await isChildSession(client, sessionID)) {
        log(`Skipping child session ${sessionID}`);
        injectedSessions.add(sessionID); // Mark to avoid re-checking
        return;
      }

      // Check if context was already injected (plugin reload scenario)
      if (await hasExistingContext(client, sessionID)) {
        log(`Context already exists in session ${sessionID}, marking as injected`);
        injectedSessions.add(sessionID);
        return;
      }

      await injectContext(client, sessionID, model, agent, $);
    },

    // ─── Detect pipeline stages on Task tool invocation ────────
    "tool.execute.before": async (input: any, output: any) => {
      // Layer 6: Skip if plugin is dormant
      if (!activated) return;

      try {
        // We only care about the Task tool (creates sub-agent sessions)
        // The tool name for Task/subtask invocations varies by implementation;
        // check for common names: "task", "subtask", "developer"
        const toolName = input.tool?.toLowerCase() ?? "";
        const isTaskTool =
          toolName === "task" ||
          toolName === "subtask" ||
          toolName === "developer";

        if (!isTaskTool) return;

        // Extract agent type from the tool args.
        // The Task tool args typically include an `agent` field naming the sub-agent.
        const args = output.args;
        if (!args) return;

        // The agent field may be named "agent", "subagent_type", or similar
        const agentName: string | undefined =
          args.agent ?? args.subagent_type ?? args.agentName;

        if (!agentName || typeof agentName !== "string") return;

        const stage = mapSubagentTypeToStage(agentName);
        if (!stage) {
          log(
        `Task tool invoked with unknown agent type: ${agentName}`
          );
          return;
        }

        log(
        `Task tool detected: agent=${agentName} → stage=${stage}`
        );

        // Store as pending so session.created can pick it up
        pendingAgentType = stage;

        // Try to extract bead ID from the task description/prompt
        const description: string =
          args.description ?? args.prompt ?? args.message ?? "";
        const beadIdFromDesc = extractBeadId(description);
        const beadId = beadIdFromDesc ?? currentBeadId;

        // POST stage transition event
        if (serverReady && beadId) {
          await pushEvent("bead:stage", {
            beadId,
            stage,
            agentSessionId: input.sessionID,
          });
          log(
        `Posted bead:stage event: bead=${beadId} stage=${stage}`
          );
        }
      } catch (err) {
        warn(`Error in tool.execute.before hook:`, err);
      }
    },

    // ─── Refresh bead state after any tool execution ───────────
    "tool.execute.after": async (input: any, output: any) => {
      // Layer 6: Skip if plugin is dormant
      if (!activated) return;

      try {
        // Only refresh bead state if the server is connected
        if (!serverReady) return;

        // Layer 4: Use debounced refresh instead of direct call
        scheduleRefresh($);

        // Special case: if the tool was bash and the command involved bd update/close,
        // do an immediate refresh (these are high-priority state changes)
        if (input.tool === "bash" || input.tool === "shell") {
          const args = input.args;
          const command: string =
            typeof args === "string"
              ? args
              : args?.command ?? args?.cmd ?? "";
          if (
            command.includes("bd update") ||
            command.includes("bd close")
          ) {
            log(
        `Detected bd command in bash tool: ${command.substring(0, 100)}`
            );
            // Cancel the debounced refresh we just scheduled — the immediate
            // refresh below supersedes it. Without this, the debounced timer
            // would fire 500ms later and run a redundant `bd list --json`.
            if (refreshTimer) {
              clearTimeout(refreshTimer);
              refreshTimer = null;
            }
            // For bd commands, do an immediate refresh (bypass debounce)
            // since these are the most important state changes to capture quickly
            const diffs = await refreshAndDiff($);
            await processDiffs(diffs);
            return;
          }
        }
      } catch (err) {
        warn(`Error in tool.execute.after hook:`, err);
      }
    },

    // ─── Handle session lifecycle events ───────────────────────
    event: async ({ event }: any) => {
      // ── session.compacted: re-inject context (works even when dormant) ──
      if (event.type === "session.compacted") {
        const props = event.properties as { sessionID?: string };
        const sessionID = props?.sessionID;
        if (typeof sessionID !== "string" || !sessionID) {
          warn(
        `session.compacted event missing sessionID`
          );
          return;
        }
        log(
        `Session ${sessionID} compacted, re-injecting context`
        );

        // Remove from tracking so we can re-inject
        injectedSessions.delete(sessionID);

        // Skip child sessions
        if (await isChildSession(client, sessionID)) {
          log(
        `Skipping re-injection for child session ${sessionID}`
          );
          return;
        }

        // Get model/agent context from recent messages
        const ctx = await getSessionContext(client, sessionID);
        await injectContext(client, sessionID, ctx.model, ctx.agent, $);
        return;
      }

      // Layer 6: All remaining event types require activation
      if (!activated) return;

      // ── session.created: map child sessions to agent types ──
      if (event.type === "session.created") {
        try {
          const props = event.properties as { info?: { id?: string; parentID?: string; title?: string } };
          const session = props?.info;
          if (!session?.id) return;

          // Only care about child sessions (sub-agent sessions have parentID)
          if (!session.parentID) return;

          log(
        `Child session created: ${session.id} (parent: ${session.parentID})`
          );

          // Try to determine agent type:
          // 1. From pending agent type (set by tool.execute.before for Task tool)
          // 2. From session title (may contain agent name)
          let agentType: string | null = null;

          if (pendingAgentType) {
            agentType = pendingAgentType;
            pendingAgentType = null; // Consume it
            log(
        `Mapped child session ${session.id} → ${agentType} (from pending Task invocation)`
            );
          } else if (session.title) {
            // Try to infer from title: e.g., "pipeline-builder: ..."
            const titleLower = session.title.toLowerCase();
            for (const candidate of [
              "pipeline-builder",
              "pipeline-refactor",
              "pipeline-reviewer",
              "pipeline-committer",
              "builder",
              "refactor",
              "reviewer",
              "committer",
              "designer",
            ]) {
              if (titleLower.includes(candidate)) {
                agentType = mapSubagentTypeToStage(candidate);
                log(
        `Mapped child session ${session.id} → ${agentType} (from title: "${session.title}")`
                );
                break;
              }
            }
          }

          if (agentType) {
            sessionToAgent.set(session.id, agentType);

            if (serverReady) {
              await pushEvent("agent:active", {
                agent: agentType,
                sessionId: session.id,
                parentSessionId: session.parentID,
                beadId: currentBeadId,
              });
            }
          }
        } catch (err) {
          warn(
        `Error in session.created handler:`,
            err
          );
        }
        return;
      }

      // ── session.idle: agent finished work, refresh bead state ──
      if (event.type === "session.idle") {
        try {
          const props = event.properties as { sessionID?: string };
          const sessionID = props?.sessionID;
          if (typeof sessionID !== "string" || !sessionID) return;

          // Check if this is a child session we're tracking
          const agentType = sessionToAgent.get(sessionID);
          if (agentType) {
            log(
        `Agent idle: ${agentType} (session: ${sessionID})`
            );

            if (serverReady) {
              await pushEvent("agent:idle", {
                agent: agentType,
                sessionId: sessionID,
                beadId: currentBeadId,
              });
            }

            // Clean up the session mapping (agent finished)
            sessionToAgent.delete(sessionID);
          }

          // Layer 4: Use debounced refresh instead of direct call
          if (serverReady) {
            scheduleRefresh($);
          }
        } catch (err) {
          warn(
        `Error in session.idle handler:`,
            err
          );
        }
        return;
      }
    },
  };
};
