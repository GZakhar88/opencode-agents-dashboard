/**
 * Dashboard Server - Entry Point
 *
 * Standalone Bun server that aggregates state from OpenCode plugins
 * and serves the dashboard API + SSE stream + pre-built frontend.
 *
 * Run: bun run server/index.ts
 * Port: 3333 (configurable via DASHBOARD_PORT env var)
 */

import {
  handleRequest,
  closeAllSSEClients,
  stateManager,
  stopHealthMonitoring,
  configureIdleShutdown,
  checkAndStartIdleTimer,
} from "./routes";
import { writePid, removePid } from "./pid";
import { computeBuildHash } from "../shared/version";

const PORT = Number(process.env.DASHBOARD_PORT) || 3333;
const buildHash = computeBuildHash();

const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 5 minutes
const rawIdleTimeout = process.env.DASHBOARD_IDLE_TIMEOUT_MS;
const parsedIdleTimeout = rawIdleTimeout ? parseInt(rawIdleTimeout, 10) : NaN;
const IDLE_TIMEOUT_MS =
  Number.isFinite(parsedIdleTimeout) && parsedIdleTimeout >= 0
    ? parsedIdleTimeout
    : DEFAULT_IDLE_TIMEOUT_MS;

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
  idleTimeout: 255, // seconds (max) — SSE connections are long-lived
});

// Write PID file so plugin tools and CLI can find this server
writePid(process.pid, server.port ?? PORT, buildHash);

console.log(`[dashboard-server] Running on http://localhost:${server.port}`);
console.log(`[dashboard-server] PID: ${process.pid}`);
console.log(
  `[dashboard-server] Idle auto-shutdown timeout: ${IDLE_TIMEOUT_MS === 0 ? "disabled" : `${IDLE_TIMEOUT_MS}ms`}`,
);
console.log(`[dashboard-server] Build hash: ${buildHash}`);
console.log(`[dashboard-server] Endpoints:`);
console.log(`  POST   /api/plugin/register`);
console.log(`  POST   /api/plugin/event`);
console.log(`  POST   /api/plugin/heartbeat`);
console.log(`  DELETE /api/plugin/:id`);
console.log(`  GET    /api/state`);
console.log(`  GET    /api/events`);
console.log(`  GET    /api/health`);

// --- Idle Auto-Shutdown ---
configureIdleShutdown(IDLE_TIMEOUT_MS);
checkAndStartIdleTimer();

// --- Graceful Shutdown ---

export function shutdown() {
  console.log(`\n[dashboard-server] Shutting down...`);
  stateManager.persistNow(); // Flush state to disk before shutdown
  stopHealthMonitoring();
  closeAllSSEClients();
  removePid(process.pid); // Clean up PID file (only if it still belongs to us)
  server.stop();
  console.log(`[dashboard-server] Server stopped.`);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
