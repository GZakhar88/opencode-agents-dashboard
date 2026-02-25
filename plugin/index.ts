/**
 * OpenCode Dashboard Plugin — Distributable Entry Point
 *
 * This is the main plugin file loaded by OpenCode when installed from npm:
 *   opencode.json → "plugin": ["opencode-dashboard"]
 *
 * Provides:
 * - Custom tools: dashboard_start, dashboard_stop, dashboard_status, dashboard_open
 * - Context injection: bd prime + pipeline guidance (conditional on agent detection)
 * - Agent discovery: reads agent configs from opencode.json, .opencode/agents/, ~/.config/opencode/agents/
 * - Dynamic columns: generates column config from discovered agents
 * - Bead tracking: bead state diffs, stage detection, agent lifecycle
 * - Server bridge: auto-start, registration, heartbeat, event pushing
 *
 * The plugin loads dormant. The server only starts when the LLM calls
 * dashboard_start (or the user runs `npx opencode-dashboard start`).
 * Context injection works independently of the server.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { BeadRecord, BeadDiff, ColumnConfig } from "../shared/types";
import { isServerRunning, readPid, writePid, removePid } from "../server/pid";
import { join, resolve } from "path";
import { readdir, readFile, copyFile, mkdir, stat } from "fs/promises";

// ─── Constants ─────────────────────────────────────────────────

const LOG_PREFIX = "[dashboard]";
const DEFAULT_PORT = 3333;

// Debug-gated logging — all output goes to stderr to avoid TUI corruption
const DEBUG = process.env.DASHBOARD_DEBUG === "1";
const log = (...args: unknown[]) => {
  if (DEBUG) console.error(LOG_PREFIX, ...args);
};
const warn = (...args: unknown[]) => {
  if (DEBUG) console.error(LOG_PREFIX, "[warn]", ...args);
};
const logError = (...args: unknown[]) => {
  if (DEBUG) console.error(LOG_PREFIX, "[error]", ...args);
};

// Server paths (resolved relative to this file)
const SERVER_ENTRY = join(import.meta.dir, "../server/index.ts");

// Network
const HEARTBEAT_INTERVAL_MS = 30_000;
const SPAWN_POLL_INTERVAL_MS = 500;
const SPAWN_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 5_000;

// ─── Module-level state ────────────────────────────────────────

let pluginId: string | null = null;
let serverReady = false;
let serverPort = DEFAULT_PORT;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let cleanupRegistered = false;
let lastBeadSnapshot: BeadRecord[] = [];
let shellRef: any = null;
let projectPath = "";

// Activation state
let activated = false;
let activating = false;

// Bead state refresh guards
let isRefreshing = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// Pipeline tracking
let currentBeadId: string | null = null;
let sessionToAgent = new Map<string, string>();
let pendingAgentType: string | null = null;
let currentAgentName: string | null = null; // tracks the agent handling the current chat.message
let activePrimarySession: string | null = null; // tracks primary session with active agent:active event

// Agent discovery results
let discoveredAgents: DiscoveredAgent[] = [];
let hasPipelineAgents = false;

// ─── Agent Discovery Types ────────────────────────────────────

interface DiscoveredAgent {
  name: string; // filename without .md extension
  description: string;
  mode: string; // "primary", "subagent", "all"
  color: string | null; // hex color from frontmatter
  hidden: boolean;
  source: "project" | "global" | "json";
}

// ─── Pipeline Guidance (conditionally injected when pipeline agents detected) ───

function buildPipelineGuidance(): string | null {
  if (!hasPipelineAgents) return null;
  return `<pipeline-guidance>
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
}

const injectedSessions = new Set<string>();

// ─── URL helpers ───────────────────────────────────────────────

function serverUrl(path: string): string {
  return `http://localhost:${serverPort}${path}`;
}

// ─── Context Injection ─────────────────────────────────────────

async function getBdPrimeOutput($: any): Promise<string | null> {
  try {
    const result = await $`bd prime`.text();
    const trimmed = result.trim();
    if (!trimmed) return null;
    return trimmed;
  } catch {
    return null;
  }
}

function buildContextMessage(bdPrime: string | null): string {
  const parts: string[] = [];
  if (bdPrime) {
    parts.push(`<beads-context>\n${bdPrime}\n</beads-context>`);
  }
  const guidance = buildPipelineGuidance();
  if (guidance) {
    parts.push(guidance);
  }
  return parts.join("\n\n");
}

async function injectContext(
  client: any,
  sessionID: string,
  model: { providerID: string; modelID: string } | undefined,
  agent: string | undefined,
  $: any,
): Promise<void> {
  if (injectedSessions.has(sessionID)) {
    log(`Session ${sessionID} already injected, skipping`);
    return;
  }

  // Mark BEFORE the await to prevent re-entrancy via chat.message
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
        (bdPrime ? " (with bd prime)" : " (pipeline guidance only)"),
    );
  } catch (err) {
    injectedSessions.delete(sessionID);
    logError(`Failed to inject context into session ${sessionID}:`, err);
  }
}

async function isChildSession(client: any, sessionID: string): Promise<boolean> {
  try {
    const result = await client.session.get({ path: { id: sessionID } });
    return !!result?.data?.parentID;
  } catch {
    return false;
  }
}

async function getSessionContext(
  client: any,
  sessionID: string,
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
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]?.info;
      if (msg?.role === "user" && msg?.model) {
        return { model: msg.model, agent: msg.agent };
      }
    }
    return {};
  } catch {
    return {};
  }
}

async function hasExistingContext(client: any, sessionID: string): Promise<boolean> {
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

// ─── Agent Discovery ───────────────────────────────────────────

/**
 * Parse YAML-like frontmatter from a markdown agent file.
 * Extracts top-level scalar keys only (description, mode, color, hidden).
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (kv) {
      frontmatter[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return frontmatter;
}

/**
 * Discover agents from markdown files in a directory.
 */
async function discoverAgentsFromDir(
  dir: string,
  source: "project" | "global",
): Promise<DiscoveredAgent[]> {
  const agents: DiscoveredAgent[] = [];
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.replace(/\.md$/, "");
      try {
        const content = await readFile(join(dir, entry), "utf-8");
        const fm = parseFrontmatter(content);
        agents.push({
          name,
          description: fm.description || "",
          mode: fm.mode || "subagent",
          color: fm.color || null,
          hidden: fm.hidden === "true",
          source,
        });
      } catch {
        // Skip files that can't be read
      }
    }
  } catch {
    // Directory doesn't exist — that's fine
  }
  return agents;
}

/**
 * Discover agents from opencode.json "agent" key.
 */
async function discoverAgentsFromJson(projectDir: string): Promise<DiscoveredAgent[]> {
  const agents: DiscoveredAgent[] = [];
  try {
    const content = await readFile(join(projectDir, "opencode.json"), "utf-8");
    const config = JSON.parse(content);
    const agentConfig = config?.agent;
    if (agentConfig && typeof agentConfig === "object") {
      for (const [name, cfg] of Object.entries(agentConfig)) {
        if (!cfg || typeof cfg !== "object") continue;
        const c = cfg as Record<string, unknown>;
        agents.push({
          name,
          description: (c.description as string) || "",
          mode: (c.mode as string) || "subagent",
          color: (c.color as string) || null,
          hidden: c.hidden === true,
          source: "json",
        });
      }
    }
  } catch {
    // opencode.json doesn't exist or invalid — that's fine
  }
  return agents;
}

/**
 * Discover all agents from all sources. Later sources override earlier ones (by name).
 * Order: opencode.json < .opencode/agents/ < ~/.config/opencode/agents/
 */
async function discoverAllAgents(projectDir: string): Promise<DiscoveredAgent[]> {
  const [jsonAgents, projectAgents, globalAgents] = await Promise.all([
    discoverAgentsFromJson(projectDir),
    discoverAgentsFromDir(join(projectDir, ".opencode", "agents"), "project"),
    discoverAgentsFromDir(
      join(process.env.HOME || "~", ".config", "opencode", "agents"),
      "global",
    ),
  ]);

  // Merge: later sources win
  const byName = new Map<string, DiscoveredAgent>();
  for (const agent of [...jsonAgents, ...projectAgents, ...globalAgents]) {
    byName.set(agent.name, agent);
  }
  return Array.from(byName.values());
}

/** Known pipeline agent names for ordering */
const PIPELINE_AGENT_ORDER: Record<string, number> = {
  "pipeline-builder": 1,
  "pipeline-refactor": 2,
  "pipeline-reviewer": 3,
  "pipeline-committer": 4,
};

/** Default color palette for agent columns */
const DEFAULT_AGENT_COLORS = [
  "#8b5cf6", // violet
  "#3b82f6", // blue
  "#06b6d4", // cyan
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ec4899", // pink
  "#f97316", // orange
  "#6366f1", // indigo
];

/**
 * Generate column config from discovered agents.
 *
 * Layout:
 * - "ready" always first
 * - orchestrator before pipeline agents
 * - pipeline agents in known order
 * - other agents alphabetically
 * - "done" and "error" always last
 */
function generateColumnConfig(agents: DiscoveredAgent[]): ColumnConfig[] {
  const columns: ColumnConfig[] = [];
  let order = 0;

  // Fixed bookend: ready
  columns.push({
    id: "ready",
    label: "Ready",
    type: "status",
    color: "#64748b",
    order: order++,
  });

  // Separate agents into categories
  const orchestratorAgent = agents.find((a) => a.name === "orchestrator");
  const pipelineAgents = agents
    .filter((a) => a.name in PIPELINE_AGENT_ORDER)
    .sort((a, b) => (PIPELINE_AGENT_ORDER[a.name] ?? 99) - (PIPELINE_AGENT_ORDER[b.name] ?? 99));
  const otherAgents = agents
    .filter(
      (a) =>
        a.name !== "orchestrator" && !(a.name in PIPELINE_AGENT_ORDER),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  let colorIndex = 0;
  const nextColor = (agent: DiscoveredAgent): string => {
    if (agent.color) return agent.color;
    return DEFAULT_AGENT_COLORS[colorIndex++ % DEFAULT_AGENT_COLORS.length];
  };

  // Orchestrator first (if present)
  if (orchestratorAgent) {
    columns.push({
      id: orchestratorAgent.name,
      label: formatAgentLabel(orchestratorAgent.name),
      type: "agent",
      color: nextColor(orchestratorAgent),
      order: order++,
      group: "pipeline",
    });
  }

  // Pipeline agents in sequence
  for (const agent of pipelineAgents) {
    columns.push({
      id: agent.name,
      label: formatAgentLabel(agent.name),
      type: "agent",
      color: nextColor(agent),
      order: order++,
      group: "pipeline",
    });
  }

  // Other agents alphabetically
  for (const agent of otherAgents) {
    columns.push({
      id: agent.name,
      label: formatAgentLabel(agent.name),
      type: "agent",
      color: nextColor(agent),
      order: order++,
      group: "standalone",
    });
  }

  // Fixed bookends: done and error
  columns.push({
    id: "done",
    label: "Done",
    type: "status",
    color: "#22c55e",
    order: order++,
  });
  columns.push({
    id: "error",
    label: "Error",
    type: "status",
    color: "#ef4444",
    order: order++,
  });

  return columns;
}

/**
 * Format agent name into a human-readable label.
 * "pipeline-builder" → "Builder", "orchestrator" → "Orchestrator"
 */
function formatAgentLabel(name: string): string {
  // Strip "pipeline-" prefix for cleaner labels
  const display = name.startsWith("pipeline-") ? name.slice("pipeline-".length) : name;
  return display.charAt(0).toUpperCase() + display.slice(1);
}

/**
 * Check if specific files are installed in a target directory.
 */
async function checkAgentsInstalled(
  targetDir: string,
  requiredFiles: string[] = ["orchestrator.md", "pipeline-builder.md"],
): Promise<boolean> {
  try {
    const entries = await readdir(targetDir);
    return requiredFiles.every((f) => entries.includes(f));
  } catch {
    return false;
  }
}

/**
 * Copy shipped agent files to a target directory. Skips files that already exist.
 */
async function installAgents(targetDir: string): Promise<string[]> {
  const shippedDir = join(import.meta.dir, "../agents");
  const installed: string[] = [];
  try {
    await mkdir(targetDir, { recursive: true });
    const entries = await readdir(shippedDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const destPath = join(targetDir, entry);
      // Skip if file already exists (don't overwrite user customizations)
      try {
        await stat(destPath);
        log(`Agent file already exists, skipping: ${destPath}`);
        continue;
      } catch {
        // File doesn't exist — proceed with copy
      }
      await copyFile(join(shippedDir, entry), destPath);
      installed.push(entry);
    }
  } catch (err) {
    logError(`Failed to install agents to ${targetDir}:`, err);
  }
  return installed;
}

// ─── Server Lifecycle ──────────────────────────────────────────

async function checkServerHealth(): Promise<boolean> {
  try {
    const res = await fetch(serverUrl("/api/health"), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function spawnServer(port: number): Promise<boolean> {
  // Resolve the bun executable path. We cannot use process.execPath because
  // when running inside OpenCode, that points to the OpenCode Go binary,
  // not bun. Bun.which("bun") finds it on $PATH reliably.
  const bunPath = Bun.which("bun");
  if (!bunPath) {
    logError("Could not find 'bun' on PATH — cannot start dashboard server");
    return false;
  }

  log(`Server not running, starting on port ${port}...`);
  log(`Spawning: ${bunPath} run ${SERVER_ENTRY}`);

  try {
    const proc = Bun.spawn([bunPath, "run", SERVER_ENTRY], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, DASHBOARD_PORT: String(port) },
    });
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

async function registerWithServer(
  pPath: string,
  projectName: string,
): Promise<string | null> {
  try {
    const res = await fetch(serverUrl("/api/plugin/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: pPath, projectName }),
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

async function sendHeartbeat(): Promise<void> {
  if (!pluginId || !serverReady) return;
  try {
    const res = await fetch(serverUrl("/api/plugin/heartbeat"), {
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
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  log(`Heartbeat started (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    log(`Heartbeat stopped`);
  }
}

async function deregisterFromServer(): Promise<void> {
  if (!pluginId || !serverReady) return;
  const id = pluginId;
  pluginId = null;
  try {
    await fetch(`${serverUrl("/api/plugin")}/${id}`, {
      method: "DELETE",
      keepalive: true,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    log(`Deregistered from server (pluginId: ${id})`);
  } catch (err) {
    warn(`Deregistration failed:`, err);
  }
}

// ─── Event Pushing ─────────────────────────────────────────────

async function pushEvent(event: string, data: unknown): Promise<void> {
  if (!pluginId || !serverReady) return;

  const enrichedData =
    data != null && typeof data === "object"
      ? { ...(data as Record<string, unknown>), projectPath, timestamp: Date.now() }
      : { data, projectPath, timestamp: Date.now() };

  try {
    const res = await fetch(serverUrl("/api/plugin/event"), {
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

// ─── Bead State Management ─────────────────────────────────────

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
    warn(`Failed to refresh bead state:`, err);
    return [];
  }
}

function diffBeadState(prev: BeadRecord[], next: BeadRecord[]): BeadDiff[] {
  const diffs: BeadDiff[] = [];
  const prevMap = new Map<string, BeadRecord>();
  for (const bead of prev) prevMap.set(bead.id, bead);
  const nextMap = new Map<string, BeadRecord>();
  for (const bead of next) nextMap.set(bead.id, bead);

  for (const [id, bead] of nextMap) {
    const prevBead = prevMap.get(id);
    if (!prevBead) {
      diffs.push({ type: "discovered", bead });
      if (bead.status === "blocked") {
        diffs.push({ type: "error", bead, error: "Discovered bead already blocked" });
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
    if (prevBead.status !== bead.status) {
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
        diffs.push({
          type: "error",
          bead,
          error: `Bead closed with failure: ${bead.close_reason}`,
        });
      } else {
        diffs.push({ type: "changed", bead, prevStatus: prevBead.status });
      }
    }
  }

  for (const [id] of prevMap) {
    if (!nextMap.has(id)) {
      diffs.push({ type: "removed", beadId: id });
    }
  }

  return diffs;
}

async function refreshAndDiff($: any): Promise<BeadDiff[]> {
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

    for (const diff of diffs) {
      switch (diff.type) {
        case "discovered":
          await pushEvent("bead:discovered", { bead: diff.bead });
          break;
        case "changed":
          await pushEvent("bead:changed", { bead: diff.bead, prevStatus: diff.prevStatus });
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

async function processDiffs(diffs: BeadDiff[]): Promise<void> {
  for (const diff of diffs) {
    if (diff.type === "changed") {
      if (diff.bead.status === "in_progress" && diff.prevStatus !== "in_progress") {
        const prevBeadId = currentBeadId;
        currentBeadId = diff.bead.id;
        log(`Bead claimed: ${diff.bead.id} (was: ${prevBeadId ?? "none"})`);

        if (prevBeadId && prevBeadId !== diff.bead.id) {
          const prevBead = lastBeadSnapshot.find(
            (b) => b.id === prevBeadId && b.status === "in_progress",
          );
          if (prevBead) {
            warn(`Previous bead ${prevBeadId} may have been abandoned`);
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
          stage: currentAgentName || "ready",
        });
      }

      if (diff.bead.status === "closed" && diff.prevStatus !== "closed") {
        if (currentBeadId === diff.bead.id) {
          currentBeadId = null;
          log(`Current bead closed: ${diff.bead.id}`);
        }
        await pushEvent("bead:done", { beadId: diff.bead.id, bead: diff.bead });
      }
    }

    if (diff.type === "discovered" && diff.bead.status === "in_progress" && !currentBeadId) {
      currentBeadId = diff.bead.id;
      log(`Discovered in-progress bead, setting as current: ${diff.bead.id}`);
    }

    if (
      diff.type === "error" &&
      currentBeadId === diff.bead.id &&
      (diff.bead.status === "blocked" || diff.bead.status === "closed")
    ) {
      currentBeadId = null;
      log(`Current bead entered error state: ${diff.bead.id} (${diff.bead.status})`);
    }
  }
}

// ─── Agent Stage Helpers ───────────────────────────────────────

/**
 * Check if an agent name corresponds to a known agent column.
 * Returns the agent name as the column/stage ID directly.
 */
function agentNameToStage(agentName: string): string | null {
  // Check if this agent is one we discovered
  const known = discoveredAgents.find((a) => a.name === agentName);
  if (known) return agentName;
  // Also accept short names that match pipeline- prefix
  const withPrefix = `pipeline-${agentName}`;
  const prefixed = discoveredAgents.find((a) => a.name === withPrefix);
  if (prefixed) return prefixed.name;
  // Accept any agent name — the dashboard will handle unknown columns gracefully
  return agentName;
}

function extractBeadId(text: string): string | null {
  const match = text.match(/\[([a-zA-Z0-9][\w-]*)\]/);
  return match ? match[1] : null;
}

// ─── Startup Sequence ──────────────────────────────────────────

async function startupSequence(
  pPath: string,
  projectName: string,
  $: any,
  port: number,
): Promise<string> {
  serverPort = port;

  // Discover agents (needed for column config and pipeline guidance decision)
  discoveredAgents = await discoverAllAgents(pPath);
  hasPipelineAgents = discoveredAgents.some((a) => a.name in PIPELINE_AGENT_ORDER);
  log(
    `Discovered ${discoveredAgents.length} agent(s)` +
      (hasPipelineAgents ? " (pipeline agents present)" : " (no pipeline agents)"),
  );

  // Check if already running (via PID file)
  const existing = await isServerRunning(true);
  if (existing) {
    serverPort = existing.port;
    log(`Server already running (PID: ${existing.pid}, port: ${existing.port})`);
  } else {
    // Check health on requested port (server may be running without PID file)
    let isHealthy = await checkServerHealth();
    if (!isHealthy) {
      isHealthy = await spawnServer(port);
    }
    if (!isHealthy) {
      serverReady = false;
      return `Dashboard server failed to start on port ${port}. Context injection still works.`;
    }
  }

  log(`Dashboard server is reachable on port ${serverPort}`);

  // Register
  const id = await registerWithServer(pPath, projectName);
  if (!id) {
    serverReady = false;
    return `Dashboard server is running but registration failed. Context injection still works.`;
  }

  pluginId = id;
  serverReady = true;

  // Generate and send column config
  const columns = generateColumnConfig(discoveredAgents);
  await pushEvent("columns:update", { columns });
  log(`Sent column config: ${columns.length} columns`);

  // Start heartbeat
  startHeartbeat();

  // Initial bead state fetch
  const initialBeads = await refreshBeadState($);
  lastBeadSnapshot = initialBeads;

  if (initialBeads.length > 0) {
    log(`Initial bead snapshot: ${initialBeads.length} bead(s)`);
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
  }

  await pushEvent("beads:refreshed", {
    beadCount: initialBeads.length,
    changed: initialBeads.length,
    beadIds: initialBeads.map((b) => b.id),
  });

  // Register process exit cleanup (once per lifetime)
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on("beforeExit", async () => {
      stopHeartbeat();
      await deregisterFromServer();
    });
    const signalCleanup = () => {
      stopHeartbeat();
      deregisterFromServer().catch(() => {});
    };
    process.on("SIGINT", signalCleanup);
    process.on("SIGTERM", signalCleanup);
  }

  return `Dashboard running at http://localhost:${serverPort}`;
}

// ─── Stop Server ───────────────────────────────────────────────

async function stopServer(): Promise<string> {
  // Deregister first
  stopHeartbeat();
  await deregisterFromServer();
  serverReady = false;
  activated = false;

  // Find and kill the server process via PID file
  const pidData = readPid();
  if (!pidData) {
    return "No dashboard server found (no PID file).";
  }

  try {
    process.kill(pidData.pid, "SIGTERM");
    removePid();
    return `Dashboard server stopped (PID: ${pidData.pid}).`;
  } catch (err: any) {
    if (err?.code === "ESRCH") {
      removePid();
      return `Dashboard server was not running (stale PID file cleaned up).`;
    }
    return `Failed to stop dashboard server: ${err?.message ?? err}`;
  }
}

// ─── Status Check ──────────────────────────────────────────────

async function getServerStatus(): Promise<string> {
  const pidData = await isServerRunning(true);
  if (!pidData) {
    return "Dashboard server is not running.";
  }

  try {
    const res = await fetch(`http://localhost:${pidData.port}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const health = (await res.json()) as {
        uptime?: number;
        plugins?: number;
        sseClients?: number;
      };
      return (
        `Dashboard server is running.\n` +
        `  URL: http://localhost:${pidData.port}\n` +
        `  PID: ${pidData.pid}\n` +
        `  Uptime: ${health.uptime ?? "?"}s\n` +
        `  Connected plugins: ${health.plugins ?? "?"}\n` +
        `  SSE clients: ${health.sseClients ?? "?"}\n` +
        `  Started: ${pidData.startedAt}`
      );
    }
    return `Dashboard server process exists (PID: ${pidData.pid}) but health check failed.`;
  } catch {
    return `Dashboard server process exists (PID: ${pidData.pid}) but is not responding.`;
  }
}

// ─── Plugin Export ─────────────────────────────────────────────

export const DashboardPlugin: Plugin = async ({ client, directory, $ }) => {
  const projectName = directory.split("/").pop() || "unknown";
  log(`Plugin loaded for ${projectName} (dormant — waiting for /dashboard-start)`);
  log(`Directory: ${directory}`);

  projectPath = directory;
  shellRef = $;

  // Helper to show toast notifications (fire-and-forget)
  const toast = (
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
    title?: string,
  ) => {
    client.tui
      .showToast({
        body: { message, variant, ...(title ? { title } : {}), duration: 4000 },
      })
      .catch(() => {});
  };

  // Check if setup has been run (look for commands in either location)
  const projectCommandsDir = join(directory, ".opencode", "commands");
  const globalCommandsDir = join(
    process.env.HOME ?? process.env.USERPROFILE ?? "",
    ".config",
    "opencode",
    "commands",
  );
  const hasProjectCommands = await checkAgentsInstalled(projectCommandsDir, [
    "dashboard-start.md",
  ]);
  const hasGlobalCommands = await checkAgentsInstalled(globalCommandsDir, [
    "dashboard-start.md",
  ]);
  if (!hasProjectCommands && !hasGlobalCommands) {
    toast(
      "Run: npx opencode-dashboard setup",
      "warning",
      "Dashboard setup required",
    );
    log("Setup not detected — commands not installed in either location");
  }

  return {
    // ─── Custom Tools (LLM-callable) ──────────────────────────

    tool: {
      dashboard_start: tool({
        description:
          "Start the OpenCode dashboard server. Opens a Kanban board at http://localhost:{port} " +
          "that shows real-time pipeline progress. Call this when the user wants to see the dashboard.",
        args: {
          port: tool.schema
            .number()
            .optional()
            .describe("Server port (default: 3333, env: DASHBOARD_PORT)"),
        },
        async execute(args) {
          const port =
            args.port ?? (Number(process.env.DASHBOARD_PORT) || DEFAULT_PORT);

          // Check if already running
          const existing = await isServerRunning(true);
          if (existing) {
            serverPort = existing.port;
            if (!activated) {
              // Server is running but plugin isn't connected — connect now
              const result = await startupSequence(directory, projectName, $, existing.port);
              activated = true;
              toast(result, "success", "Dashboard");
              return result;
            }
            const msg = `Dashboard already running at http://localhost:${existing.port}`;
            toast(msg, "info", "Dashboard");
            return msg;
          }

          // Start fresh
          activating = true;
          try {
            const result = await startupSequence(directory, projectName, $, port);
            activated = true;
            const isSuccess = serverReady;
            toast(result, isSuccess ? "success" : "warning", "Dashboard");
            return result;
          } finally {
            activating = false;
          }
        },
      }),

      dashboard_stop: tool({
        description:
          "Stop the running OpenCode dashboard server. " +
          "Call this when the user wants to shut down the dashboard.",
        args: {},
        async execute() {
          const result = await stopServer();
          toast(result, "info", "Dashboard");
          return result;
        },
      }),

      dashboard_status: tool({
        description:
          "Check if the OpenCode dashboard server is running and show its status. " +
          "Returns URL, PID, uptime, and connection info.",
        args: {},
        async execute() {
          return getServerStatus();
        },
      }),

      dashboard_open: tool({
        description:
          "Open the OpenCode dashboard in the default browser. " +
          "Starts the server first if it's not already running.",
        args: {
          port: tool.schema
            .number()
            .optional()
            .describe("Server port (default: 3333)"),
        },
        async execute(args) {
          const port =
            args.port ?? (Number(process.env.DASHBOARD_PORT) || DEFAULT_PORT);

          // Ensure server is running
          let running = await isServerRunning(true);
          if (!running) {
            activating = true;
            try {
              await startupSequence(directory, projectName, $, port);
              activated = true;
            } finally {
              activating = false;
            }
            running = await isServerRunning(false);
          }

          const url = `http://localhost:${running?.port ?? port}`;

          // Open in default browser
          try {
            const openCmd =
              process.platform === "darwin"
                ? "open"
                : process.platform === "win32"
                  ? "start"
                  : "xdg-open";
            Bun.spawn([openCmd, url], {
              detached: true,
              stdio: ["ignore", "ignore", "ignore"],
            }).unref();
            toast(`Opened ${url} in browser`, "success", "Dashboard");
            return `Opened dashboard at ${url} in your default browser.`;
          } catch (err: any) {
            return `Dashboard running at ${url} but failed to open browser: ${err?.message ?? err}`;
          }
        },
      }),
    },

    // ─── Context Injection on First Message ─────────────────────

    "chat.message": async (input: any, _output: any) => {
      const sessionID = input.sessionID;
      const model = input.model;
      const agent = input.agent;

      // Track current agent for bead:claimed stage tracking
      if (agent) {
        currentAgentName = agent;
      }

      // Send agent:active for primary agents (not subagents tracked in sessionToAgent)
      // Only send if not already active for this session to avoid duplicates
      if (agent && serverReady && !sessionToAgent.has(sessionID) && activePrimarySession !== sessionID) {
        activePrimarySession = sessionID;
        await pushEvent("agent:active", {
          agent: agent,
          sessionId: sessionID,
          beadId: currentBeadId,
        });
      }

      if (injectedSessions.has(sessionID)) return;

      if (await isChildSession(client, sessionID)) {
        log(`Skipping child session ${sessionID}`);
        injectedSessions.add(sessionID);
        return;
      }

      if (await hasExistingContext(client, sessionID)) {
        log(`Context already exists in session ${sessionID}, marking as injected`);
        injectedSessions.add(sessionID);
        return;
      }

      await injectContext(client, sessionID, model, agent, $);
    },

    // ─── Pipeline Stage Detection ───────────────────────────────

    "tool.execute.before": async (input: any, output: any) => {
      if (!activated) return;

      try {
        const toolName = input.tool?.toLowerCase() ?? "";
        const isTaskTool =
          toolName === "task" || toolName === "subtask" || toolName === "developer";
        if (!isTaskTool) return;

        const args = output.args;
        if (!args) return;

        const agentName: string | undefined =
          args.agent ?? args.subagent_type ?? args.agentName;
        if (!agentName || typeof agentName !== "string") return;

        const stage = agentNameToStage(agentName);
        if (!stage) {
          log(`Task tool invoked with unknown agent type: ${agentName}`);
          return;
        }

        log(`Task tool detected: agent=${agentName} → stage=${stage}`);
        pendingAgentType = stage;

        const description: string = args.description ?? args.prompt ?? args.message ?? "";
        const beadIdFromDesc = extractBeadId(description);
        const beadId = beadIdFromDesc ?? currentBeadId;

        if (serverReady && beadId) {
          await pushEvent("bead:stage", {
            beadId,
            stage,
            agentSessionId: input.sessionID,
          });
          log(`Posted bead:stage event: bead=${beadId} stage=${stage}`);
        }
      } catch (err) {
        warn(`Error in tool.execute.before hook:`, err);
      }
    },

    // ─── Refresh Bead State After Tool Execution ────────────────

    "tool.execute.after": async (input: any, _output: any) => {
      if (!activated) return;

      try {
        if (!serverReady) return;

        scheduleRefresh($);

        if (input.tool === "bash" || input.tool === "shell") {
          const args = input.args;
          const command: string =
            typeof args === "string" ? args : args?.command ?? args?.cmd ?? "";
          if (command.includes("bd update") || command.includes("bd close")) {
            log(`Detected bd command in bash tool: ${command.substring(0, 100)}`);
            if (refreshTimer) {
              clearTimeout(refreshTimer);
              refreshTimer = null;
            }
            const diffs = await refreshAndDiff($);
            await processDiffs(diffs);
            return;
          }
        }
      } catch (err) {
        warn(`Error in tool.execute.after hook:`, err);
      }
    },

    // ─── Session Lifecycle Events ───────────────────────────────

    event: async ({ event }: any) => {
      // session.compacted: re-inject context (works even when dormant)
      if (event.type === "session.compacted") {
        const props = event.properties as { sessionID?: string };
        const sessionID = props?.sessionID;
        if (typeof sessionID !== "string" || !sessionID) {
          warn(`session.compacted event missing sessionID`);
          return;
        }
        log(`Session ${sessionID} compacted, re-injecting context`);
        injectedSessions.delete(sessionID);

        if (await isChildSession(client, sessionID)) {
          log(`Skipping re-injection for child session ${sessionID}`);
          return;
        }

        const ctx = await getSessionContext(client, sessionID);
        await injectContext(client, sessionID, ctx.model, ctx.agent, $);
        return;
      }

      if (!activated) return;

      // session.created: map child sessions to agent types
      if (event.type === "session.created") {
        try {
          const props = event.properties as {
            info?: { id?: string; parentID?: string; title?: string };
          };
          const session = props?.info;
          if (!session?.id || !session.parentID) return;

          log(`Child session created: ${session.id} (parent: ${session.parentID})`);

          let agentType: string | null = null;

          if (pendingAgentType) {
            agentType = pendingAgentType;
            pendingAgentType = null;
            log(`Mapped child session ${session.id} → ${agentType} (from pending Task invocation)`);
          } else if (session.title) {
            const titleLower = session.title.toLowerCase();
            // Match against all discovered agent names
            for (const agent of discoveredAgents) {
              if (titleLower.includes(agent.name)) {
                agentType = agent.name;
                log(`Mapped child session ${session.id} → ${agentType} (from title)`);
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
          warn(`Error in session.created handler:`, err);
        }
        return;
      }

      // session.idle: agent finished work
      if (event.type === "session.idle") {
        try {
          const props = event.properties as { sessionID?: string };
          const sessionID = props?.sessionID;
          if (typeof sessionID !== "string" || !sessionID) return;

          // Handle subagent idle (existing behavior)
          const agentType = sessionToAgent.get(sessionID);
          if (agentType) {
            log(`Agent idle: ${agentType} (session: ${sessionID})`);
            if (serverReady) {
              await pushEvent("agent:idle", {
                agent: agentType,
                sessionId: sessionID,
                beadId: currentBeadId,
              });
            }
            sessionToAgent.delete(sessionID);
          }

          // Handle primary agent idle (not a subagent, but a built-in agent like Build, Plan, etc.)
          if (!sessionToAgent.has(sessionID) && currentAgentName && activePrimarySession === sessionID) {
            log(`Primary agent idle: ${currentAgentName} (session: ${sessionID})`);
            activePrimarySession = null;
            if (serverReady) {
              await pushEvent("agent:idle", {
                agent: currentAgentName,
                sessionId: sessionID,
                beadId: currentBeadId,
              });
            }
          }

          if (serverReady) {
            scheduleRefresh($);
          }
        } catch (err) {
          warn(`Error in session.idle handler:`, err);
        }
        return;
      }
    },
  };
};
