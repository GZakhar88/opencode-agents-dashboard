/**
 * Dashboard Spike Server
 *
 * Minimal proof-of-concept server that:
 * - Accepts POSTed events from one or more OpenCode plugin instances
 * - Broadcasts those events as SSE to connected browser clients
 * - Exposes a health endpoint for plugin startup detection
 *
 * Run: bun run server/spike.ts
 * Port: 3333 (override with DASHBOARD_PORT env var)
 */

const PORT = Number(process.env.DASHBOARD_PORT) || 3333;

// Track connected SSE clients
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

// TextEncoder for SSE data encoding
const encoder = new TextEncoder();

// Track connected plugins (for observability)
const connectedPlugins = new Map<
  string,
  { projectPath: string; connectedAt: number; lastEventAt: number }
>();

// Event counter for diagnostics
let eventCount = 0;

// SSE message ID for reconnection support
let sseMessageId = 0;

/**
 * Broadcast an SSE message to all connected clients.
 * Automatically cleans up disconnected clients.
 */
function broadcast(event: string, data: unknown): void {
  sseMessageId++;
  const msg = `id: ${sseMessageId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const encoded = encoder.encode(msg);

  for (const client of clients) {
    try {
      client.enqueue(encoded);
    } catch {
      // Client disconnected — remove it
      clients.delete(client);
    }
  }
}

/**
 * Add CORS headers to a response
 */
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/**
 * Create a JSON response with CORS headers
 */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

const server = Bun.serve({
  port: PORT,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // ─── Health Check ──────────────────────────────────────────
    if (url.pathname === "/api/health" && req.method === "GET") {
      return jsonResponse({
        status: "ok",
        uptime: process.uptime(),
        clients: clients.size,
        plugins: connectedPlugins.size,
        events: eventCount,
      });
    }

    // ─── SSE Stream ────────────────────────────────────────────
    if (url.pathname === "/api/events" && req.method === "GET") {
      // Capture controller reference for cleanup in cancel()
      let clientController: ReadableStreamDefaultController<Uint8Array>;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          clientController = controller;
          clients.add(controller);

          // Tell EventSource to reconnect after 3 seconds if connection drops
          controller.enqueue(encoder.encode("retry: 3000\n\n"));

          // Send initial connection confirmation
          const connectMsg = encoder.encode(
            `event: connected\ndata: ${JSON.stringify({
              message: "SSE connected",
              timestamp: Date.now(),
              plugins: Array.from(connectedPlugins.entries()).map(
                ([id, info]) => ({
                  id,
                  projectPath: info.projectPath,
                })
              ),
            })}\n\n`
          );
          controller.enqueue(connectMsg);
        },
        cancel() {
          // Clean up when client disconnects
          if (clientController) {
            clients.delete(clientController);
          }
        },
      });

      // Bun supports returning ReadableStream directly for SSE
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...corsHeaders(),
        },
      });
    }

    // ─── Event Ingestion ───────────────────────────────────────
    if (url.pathname === "/api/plugin/event" && req.method === "POST") {
      try {
        const body = await req.json();
        const { event, data, pluginId } = body;

        if (!event || typeof event !== "string") {
          return jsonResponse({ error: "Missing or invalid 'event' field (must be a non-empty string)" }, 400);
        }

        eventCount++;

        // Track plugin activity
        if (pluginId && data?.projectPath) {
          const existing = connectedPlugins.get(pluginId);
          if (existing) {
            existing.lastEventAt = Date.now();
          } else {
            connectedPlugins.set(pluginId, {
              projectPath: data.projectPath,
              connectedAt: Date.now(),
              lastEventAt: Date.now(),
            });
          }
        }

        // Enrich event data with server-side timestamp
        const enrichedData = {
          ...(data != null && typeof data === "object" ? data : { data }),
          _serverTimestamp: Date.now(),
          _eventCount: eventCount,
        };

        // Broadcast to all SSE clients
        broadcast(event, enrichedData);

        return jsonResponse({
          ok: true,
          eventCount,
          clients: clients.size,
        });
      } catch (err) {
        return jsonResponse(
          { error: "Invalid JSON body", details: String(err) },
          400
        );
      }
    }

    // ─── Server Info (for debugging) ───────────────────────────
    if (url.pathname === "/api/info" && req.method === "GET") {
      return jsonResponse({
        name: "dashboard-spike",
        port: PORT,
        uptime: process.uptime(),
        pid: process.pid,
        clients: clients.size,
        plugins: Array.from(connectedPlugins.entries()).map(([id, info]) => ({
          id,
          ...info,
        })),
        events: eventCount,
      });
    }

    // ─── Not Found ─────────────────────────────────────────────
    return jsonResponse({ error: "not found", path: url.pathname }, 404);
  },
});

console.log(
  `[dashboard-spike] Server running on http://localhost:${server.port}`
);
console.log(`[dashboard-spike] PID: ${process.pid}`);
console.log(
  `[dashboard-spike] SSE endpoint: http://localhost:${server.port}/api/events`
);
console.log(
  `[dashboard-spike] Health check: http://localhost:${server.port}/api/health`
);

// Periodically clean up stale SSE clients by sending a heartbeat comment
// SSE spec: lines starting with ":" are comments and are ignored by EventSource
const heartbeatInterval = setInterval(() => {
  const heartbeat = encoder.encode(`: heartbeat ${Date.now()}\n\n`);
  for (const client of clients) {
    try {
      client.enqueue(heartbeat);
    } catch {
      clients.delete(client);
    }
  }
}, 30_000);

// Graceful shutdown: close all SSE clients and stop the server
function shutdown() {
  console.log(`\n[dashboard-spike] Shutting down...`);
  clearInterval(heartbeatInterval);
  for (const client of clients) {
    try {
      client.close();
    } catch {
      // already closed
    }
  }
  clients.clear();
  connectedPlugins.clear();
  server.stop();
  console.log(`[dashboard-spike] Server stopped.`);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
