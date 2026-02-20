/**
 * Dashboard Spike Plugin
 *
 * Proof-of-concept OpenCode plugin that:
 * 1. Auto-starts the dashboard server if not running
 * 2. Detects an already-running server (avoids port conflicts)
 * 3. Hooks into OpenCode events and POSTs them to the server
 * 4. Server broadcasts events as SSE to browser clients
 *
 * Install: place in ~/.config/opencode/plugins/dashboard-spike.ts
 * Server:  opencode-dashboard/server/spike.ts
 */

import type { Plugin } from "@opencode-ai/plugin";

const SERVER_URL = "http://localhost:3333";
const SERVER_PATH =
  "/Users/gaborzakhar/Dev/opencode-dashboard/server/spike.ts";
const HEALTH_ENDPOINT = `${SERVER_URL}/api/health`;
const EVENT_ENDPOINT = `${SERVER_URL}/api/plugin/event`;

// Unique ID for this plugin instance
const pluginId = `plugin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Check if the dashboard server is reachable
 */
async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_ENDPOINT, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn the dashboard server as a detached process
 */
function spawnServer(): void {
  try {
    const proc = Bun.spawn([process.execPath, "run", SERVER_PATH], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    // Unref so the plugin process doesn't wait for the server
    proc.unref();
    console.log(`[dashboard-spike] Spawned server process (PID: ${proc.pid})`);
  } catch (err) {
    console.error(`[dashboard-spike] Failed to spawn server:`, err);
  }
}

/**
 * Wait for the server to become ready, polling every 500ms
 */
async function waitForServer(
  maxAttempts = 10,
  intervalMs = 500
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await Bun.sleep(intervalMs);
    if (await isServerRunning()) {
      return true;
    }
  }
  return false;
}

/**
 * POST an event to the dashboard server (fire-and-forget)
 */
async function pushEvent(
  event: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    await fetch(EVENT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pluginId,
        event,
        data,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Silently fail — server may be down, but plugin should keep working
  }
}

export const DashboardSpike: Plugin = async ({ directory }) => {
  const projectPath = directory;
  const projectName = projectPath.split("/").pop() || "unknown";

  console.log(`[dashboard-spike] Plugin loading for ${projectName}`);
  console.log(`[dashboard-spike] Project path: ${projectPath}`);
  console.log(`[dashboard-spike] Plugin ID: ${pluginId}`);

  // ─── Server auto-start logic ─────────────────────────────────
  let serverReady = await isServerRunning();

  if (serverReady) {
    console.log(`[dashboard-spike] Server already running at ${SERVER_URL}`);
  } else {
    console.log(
      `[dashboard-spike] Server not running — spawning at ${SERVER_PATH}`
    );
    spawnServer();

    console.log(`[dashboard-spike] Waiting for server to start...`);
    serverReady = await waitForServer();

    if (serverReady) {
      console.log(`[dashboard-spike] Server started successfully`);
    } else {
      console.warn(
        `[dashboard-spike] Server failed to start within timeout. ` +
          `Plugin will continue without dashboard connectivity.`
      );
    }
  }

  // ─── Send initial plugin connection event ────────────────────
  if (serverReady) {
    await pushEvent("plugin:connected", {
      projectPath,
      projectName,
      pluginId,
      timestamp: Date.now(),
    });
  }

  // ─── Return hooks ────────────────────────────────────────────
  return {
    // Hook into ALL OpenCode events and forward to the dashboard server
    event: async ({ event }) => {
      if (!serverReady) return;

      await pushEvent("opencode:event", {
        projectPath,
        projectName,
        pluginId,
        type: event.type,
        properties: event.properties,
        timestamp: Date.now(),
      });
    },

    // Hook into tool execution completions
    "tool.execute.after": async (input, output) => {
      if (!serverReady) return;

      await pushEvent("opencode:tool.after", {
        projectPath,
        projectName,
        pluginId,
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        title: output.title,
        timestamp: Date.now(),
      });
    },

    // Hook into new chat messages (session starts)
    "chat.message": async (input, output) => {
      if (!serverReady) return;

      await pushEvent("opencode:chat.message", {
        projectPath,
        projectName,
        pluginId,
        sessionID: input.sessionID,
        agent: input.agent,
        timestamp: Date.now(),
      });
    },
  };
};
