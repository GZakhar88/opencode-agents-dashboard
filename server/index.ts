/**
 * Dashboard Server - Entry Point
 *
 * Standalone Bun server that aggregates state from OpenCode plugins
 * and serves the dashboard API + SSE stream.
 *
 * Run: bun run server/index.ts
 * Port: 3333 (configurable via DASHBOARD_PORT env var)
 */

import { handleRequest, closeAllSSEClients, stateManager } from "./routes";

const PORT = Number(process.env.DASHBOARD_PORT) || 3333;

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`[dashboard-server] Running on http://localhost:${server.port}`);
console.log(`[dashboard-server] PID: ${process.pid}`);
console.log(`[dashboard-server] Endpoints:`);
console.log(`  POST   /api/plugin/register`);
console.log(`  POST   /api/plugin/event`);
console.log(`  POST   /api/plugin/heartbeat`);
console.log(`  DELETE /api/plugin/:id`);
console.log(`  GET    /api/state`);
console.log(`  GET    /api/events`);
console.log(`  GET    /api/health`);

// --- Graceful Shutdown ---

function shutdown() {
  console.log(`\n[dashboard-server] Shutting down...`);
  stateManager.persistNow(); // Flush state to disk before shutdown
  closeAllSSEClients();
  server.stop();
  console.log(`[dashboard-server] Server stopped.`);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
