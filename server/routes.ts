/**
 * Dashboard Server - Route Handlers
 *
 * Implements all 7 HTTP endpoints:
 *
 * Plugin API (internal):
 *   POST   /api/plugin/register   - Plugin registers with { projectPath, projectName }
 *   POST   /api/plugin/event      - Plugin pushes an event { pluginId, event, data }
 *   POST   /api/plugin/heartbeat  - Plugin sends { pluginId }
 *   DELETE /api/plugin/:id        - Plugin deregisters on shutdown
 *
 * Dashboard API (public):
 *   GET    /api/state             - Full board state as JSON
 *   GET    /api/events            - SSE stream for real-time updates
 *   GET    /api/health            - Server health check
 */

import { StateManager } from "./state";

// --- State Management ---

/** Central state manager — processes events and persists to disk */
export const stateManager = new StateManager();

// --- Plugin Registry ---

interface PluginRecord {
  pluginId: string;
  projectPath: string;
  projectName: string;
  registeredAt: number;
  lastHeartbeat: number;
}

/** Registered plugins, keyed by pluginId */
const plugins = new Map<string, PluginRecord>();

/** Connected SSE clients */
const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

/** Server start time for uptime calculation */
const startTime = Date.now();

/** SSE message ID counter for reconnection support */
let sseMessageId = 0;

const encoder = new TextEncoder();

// --- Helpers ---

/** Add CORS headers for localhost origins */
function corsHeaders(origin?: string | null): Record<string, string> {
  // Allow any localhost origin for development
  const allowedOrigin =
    origin && /^https?:\/\/localhost(:\d+)?$/.test(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/** Create a JSON response with CORS headers */
function json(
  data: unknown,
  status: number = 200,
  origin?: string | null
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

/** Parse JSON body safely, returning null on failure */
async function parseBody(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** Generate a UUID v4 */
function generateId(): string {
  return crypto.randomUUID();
}

/** Broadcast an SSE event to all connected clients */
function broadcast(event: string, data: unknown): void {
  sseMessageId++;
  const msg = `id: ${sseMessageId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const encoded = encoder.encode(msg);

  for (const client of sseClients) {
    try {
      client.enqueue(encoded);
    } catch {
      sseClients.delete(client);
    }
  }
}

// --- Route Handlers ---

/**
 * POST /api/plugin/register
 *
 * Plugin registers with { projectPath, projectName }.
 * Returns { pluginId }.
 */
async function handleRegister(
  req: Request,
  origin?: string | null
): Promise<Response> {
  const body = await parseBody(req);

  if (!body || typeof body !== "object") {
    return json({ error: "Invalid JSON body" }, 400, origin);
  }

  const { projectPath, projectName } = body as Record<string, unknown>;

  if (!projectPath || typeof projectPath !== "string") {
    return json(
      { error: "Missing or invalid 'projectPath' (must be a non-empty string)" },
      400,
      origin
    );
  }

  if (!projectName || typeof projectName !== "string") {
    return json(
      { error: "Missing or invalid 'projectName' (must be a non-empty string)" },
      400,
      origin
    );
  }

  const pluginId = generateId();
  const now = Date.now();

  plugins.set(pluginId, {
    pluginId,
    projectPath,
    projectName,
    registeredAt: now,
    lastHeartbeat: now,
  });

  // Register in state manager (creates or re-activates project)
  stateManager.registerPlugin(pluginId, projectPath, projectName);

  console.log(
    `[server] Plugin registered: ${pluginId} (${projectName} @ ${projectPath})`
  );

  // Broadcast connection to SSE clients
  broadcast("project:connected", {
    projectPath,
    projectName,
    pluginId,
  });

  return json({ pluginId }, 200, origin);
}

/**
 * POST /api/plugin/event
 *
 * Plugin pushes an event { pluginId, event, data }.
 * Server updates state + broadcasts to SSE.
 */
async function handleEvent(
  req: Request,
  origin?: string | null
): Promise<Response> {
  const body = await parseBody(req);

  if (!body || typeof body !== "object") {
    return json({ error: "Invalid JSON body" }, 400, origin);
  }

  const { pluginId, event, data } = body as Record<string, unknown>;

  if (!pluginId || typeof pluginId !== "string") {
    return json(
      { error: "Missing or invalid 'pluginId' (must be a non-empty string)" },
      400,
      origin
    );
  }

  if (!event || typeof event !== "string") {
    return json(
      { error: "Missing or invalid 'event' (must be a non-empty string)" },
      400,
      origin
    );
  }

  // Verify plugin is registered
  const plugin = plugins.get(pluginId);
  if (!plugin) {
    return json({ error: `Unknown pluginId: ${pluginId}` }, 404, origin);
  }

  // Update heartbeat on any event
  plugin.lastHeartbeat = Date.now();

  // Process event through state manager (updates canonical state)
  const isPlainObject =
    data != null && typeof data === "object" && !Array.isArray(data);
  const eventData = isPlainObject
    ? (data as Record<string, unknown>)
    : { data };

  const processed = stateManager.processEvent(pluginId, event, eventData);

  // Broadcast to all SSE clients — use state-enriched data if available
  if (processed) {
    broadcast(processed.event, {
      ...processed.data,
      _serverTimestamp: Date.now(),
    });
  } else {
    // Fallback: enrich and broadcast directly (unknown plugin in state)
    const enrichedData = {
      ...eventData,
      projectPath: plugin.projectPath,
      _serverTimestamp: Date.now(),
    };
    broadcast(event, enrichedData);
  }

  console.log(`[server] Event from ${pluginId}: ${event}`);

  return json({ ok: true }, 200, origin);
}

/**
 * POST /api/plugin/heartbeat
 *
 * Plugin sends { pluginId }. Server updates lastHeartbeat.
 */
async function handleHeartbeat(
  req: Request,
  origin?: string | null
): Promise<Response> {
  const body = await parseBody(req);

  if (!body || typeof body !== "object") {
    return json({ error: "Invalid JSON body" }, 400, origin);
  }

  const { pluginId } = body as Record<string, unknown>;

  if (!pluginId || typeof pluginId !== "string") {
    return json(
      { error: "Missing or invalid 'pluginId' (must be a non-empty string)" },
      400,
      origin
    );
  }

  const plugin = plugins.get(pluginId);
  if (!plugin) {
    return json({ error: `Unknown pluginId: ${pluginId}` }, 404, origin);
  }

  plugin.lastHeartbeat = Date.now();
  stateManager.updateHeartbeat(pluginId);

  return json({ ok: true }, 200, origin);
}

/**
 * DELETE /api/plugin/:id
 *
 * Plugin deregisters on shutdown. Removes from state.
 */
function handleDeregister(
  pluginId: string,
  origin?: string | null
): Response {
  const plugin = plugins.get(pluginId);
  if (!plugin) {
    return json({ error: `Unknown pluginId: ${pluginId}` }, 404, origin);
  }

  plugins.delete(pluginId);

  // Mark project as disconnected in state (retains last-known state)
  stateManager.deregisterPlugin(pluginId);

  console.log(
    `[server] Plugin deregistered: ${pluginId} (${plugin.projectName})`
  );

  // Broadcast disconnection to SSE clients
  broadcast("project:disconnected", {
    projectPath: plugin.projectPath,
    pluginId,
  });

  return json({ ok: true }, 200, origin);
}

/**
 * GET /api/state
 *
 * Returns full board state as JSON (all projects, all pipelines, all beads).
 */
function handleState(origin?: string | null): Response {
  return json(stateManager.toJSON(), 200, origin);
}

/**
 * GET /api/events
 *
 * SSE stream for real-time updates.
 * Sends a "connected" event immediately, then streams events.
 */
function handleEvents(origin?: string | null): Response {
  let clientController: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      clientController = controller;
      sseClients.add(controller);

      // Set reconnect interval
      controller.enqueue(encoder.encode("retry: 3000\n\n"));

      // Send connection confirmation with current state
      sseMessageId++;
      const connectMsg = encoder.encode(
        `id: ${sseMessageId}\nevent: connected\ndata: ${JSON.stringify({
          message: "SSE connected",
          timestamp: Date.now(),
          plugins: Array.from(plugins.values()).map((p) => ({
            pluginId: p.pluginId,
            projectPath: p.projectPath,
            projectName: p.projectName,
          })),
        })}\n\n`
      );
      controller.enqueue(connectMsg);

      // Send full state snapshot for reconnection support
      sseMessageId++;
      const stateMsg = encoder.encode(
        `id: ${sseMessageId}\nevent: state:full\ndata: ${JSON.stringify(stateManager.toJSON())}\n\n`
      );
      controller.enqueue(stateMsg);
    },
    cancel() {
      if (clientController) {
        sseClients.delete(clientController);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(origin),
    },
  });
}

/**
 * GET /api/health
 *
 * Server health check.
 */
function handleHealth(origin?: string | null): Response {
  return json(
    {
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      plugins: plugins.size,
      sseClients: sseClients.size,
    },
    200,
    origin
  );
}

// --- Router ---

/**
 * Extract pluginId from a DELETE /api/plugin/:id path.
 * Returns the id portion or null if the path doesn't match.
 */
function extractPluginId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/plugin\/([^/]+)$/);
  return match ? match[1] : null;
}

/**
 * Main request router.
 *
 * Routes incoming requests to the appropriate handler based on
 * method and pathname. Returns a 404 for unmatched routes.
 */
export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;
  const origin = req.headers.get("Origin");

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin),
    });
  }

  // --- Plugin API ---

  if (pathname === "/api/plugin/register" && method === "POST") {
    return handleRegister(req, origin);
  }

  if (pathname === "/api/plugin/event" && method === "POST") {
    return handleEvent(req, origin);
  }

  if (pathname === "/api/plugin/heartbeat" && method === "POST") {
    return handleHeartbeat(req, origin);
  }

  // DELETE /api/plugin/:id — must come after the specific plugin sub-routes
  if (method === "DELETE") {
    const pluginId = extractPluginId(pathname);
    if (pluginId) {
      return handleDeregister(pluginId, origin);
    }
  }

  // --- Dashboard API ---

  if (pathname === "/api/state" && method === "GET") {
    return handleState(origin);
  }

  if (pathname === "/api/events" && method === "GET") {
    return handleEvents(origin);
  }

  if (pathname === "/api/health" && method === "GET") {
    return handleHealth(origin);
  }

  // --- Not Found ---

  return json({ error: "Not found", path: pathname }, 404, origin);
}

// --- Exports for testing / external access ---

export { plugins, sseClients, broadcast };

// --- SSE Heartbeat ---

/**
 * Periodic SSE heartbeat to detect and clean up stale clients.
 * SSE comment lines (starting with ':') are ignored by EventSource.
 */
const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

const sseHeartbeatInterval = setInterval(() => {
  const heartbeat = encoder.encode(`: heartbeat ${Date.now()}\n\n`);
  for (const client of sseClients) {
    try {
      client.enqueue(heartbeat);
    } catch {
      sseClients.delete(client);
    }
  }
}, SSE_HEARTBEAT_INTERVAL_MS);

// Don't prevent the process from exiting when this is the only pending timer
// (important for test runners that import this module)
sseHeartbeatInterval.unref();

/**
 * Gracefully close all SSE connections and clean up resources.
 * Called during server shutdown.
 */
export function closeAllSSEClients(): void {
  clearInterval(sseHeartbeatInterval);
  for (const client of sseClients) {
    try {
      client.close();
    } catch {
      // already closed
    }
  }
  sseClients.clear();
}
