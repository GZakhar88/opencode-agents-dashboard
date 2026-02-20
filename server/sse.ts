/**
 * Dashboard Server - SSE Client Management & Broadcasting
 *
 * Manages Server-Sent Events connections to dashboard browser clients.
 * Handles:
 * - Client connection/disconnection tracking
 * - Event broadcasting to all connected clients
 * - SSE heartbeat for stale client detection
 * - state:full snapshot delivery on connect
 * - Graceful shutdown
 */

// --- Types ---

export interface SSEClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  connectedAt: number;
}

// --- SSE Manager ---

/** SSE message ID counter for reconnection support */
let messageId = 0;

/** Connected SSE clients */
const clients = new Set<SSEClient>();

const encoder = new TextEncoder();

/**
 * Get the current number of connected SSE clients.
 */
export function clientCount(): number {
  return clients.size;
}

/**
 * Get the current SSE message ID (for testing/debugging).
 */
export function currentMessageId(): number {
  return messageId;
}

/**
 * Broadcast a named SSE event to all connected clients.
 *
 * Format:
 *   id: <messageId>
 *   event: <eventName>
 *   data: <JSON string>
 *
 * Clients that fail to receive the message are automatically removed.
 */
export function broadcast(eventName: string, data: unknown): void {
  messageId++;
  const msg = `id: ${messageId}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  const encoded = encoder.encode(msg);

  for (const client of clients) {
    try {
      client.controller.enqueue(encoded);
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * Create an SSE Response for a new client connection.
 *
 * Sends:
 * 1. `retry: 3000` directive (reconnect interval)
 * 2. `connected` event with metadata
 * 3. `state:full` event with complete state snapshot
 *
 * @param getPlugins - Function returning current plugin list (avoids circular deps)
 * @param getState - Function returning serialized state snapshot
 * @param origin - Request Origin header for CORS
 * @param corsHeaders - Function to generate CORS headers
 */
export function createSSEResponse(
  getPlugins: () => Array<{
    pluginId: string;
    projectPath: string;
    projectName: string;
  }>,
  getState: () => unknown,
  origin: string | null | undefined,
  corsHeadersFn: (origin?: string | null) => Record<string, string>
): Response {
  let sseClient: SSEClient;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseClient = {
        controller,
        connectedAt: Date.now(),
      };
      clients.add(sseClient);

      // Set reconnect interval
      controller.enqueue(encoder.encode("retry: 3000\n\n"));

      // Send connection confirmation with current plugin list
      messageId++;
      const connectMsg = encoder.encode(
        `id: ${messageId}\nevent: connected\ndata: ${JSON.stringify({
          message: "SSE connected",
          timestamp: Date.now(),
          plugins: getPlugins(),
        })}\n\n`
      );
      controller.enqueue(connectMsg);

      // Send full state snapshot for initial load / reconnection
      messageId++;
      const stateMsg = encoder.encode(
        `id: ${messageId}\nevent: state:full\ndata: ${JSON.stringify(getState())}\n\n`
      );
      controller.enqueue(stateMsg);
    },
    cancel() {
      if (sseClient) {
        clients.delete(sseClient);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeadersFn(origin),
    },
  });
}

// --- SSE Heartbeat ---

/**
 * Periodic SSE heartbeat to detect and clean up stale clients.
 * SSE comment lines (starting with ':') are ignored by EventSource
 * but keep the connection alive and detect disconnects.
 */
const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

const sseHeartbeatInterval = setInterval(() => {
  const heartbeat = encoder.encode(`: heartbeat ${Date.now()}\n\n`);
  for (const client of clients) {
    try {
      client.controller.enqueue(heartbeat);
    } catch {
      clients.delete(client);
    }
  }
}, SSE_HEARTBEAT_INTERVAL_MS);

// Don't prevent the process from exiting when this is the only pending timer
sseHeartbeatInterval.unref();

/**
 * Gracefully close all SSE connections and clean up resources.
 * Called during server shutdown.
 */
export function closeAllClients(): void {
  clearInterval(sseHeartbeatInterval);
  for (const client of clients) {
    try {
      client.controller.close();
    } catch {
      // already closed
    }
  }
  clients.clear();
}

/**
 * Reset SSE state for testing.
 * Removes all clients and resets the message ID counter.
 */
export function reset(): void {
  for (const client of clients) {
    try {
      client.controller.close();
    } catch {
      // already closed
    }
  }
  clients.clear();
  messageId = 0;
}

// --- Exports for testing ---

export { clients };
