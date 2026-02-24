#!/usr/bin/env bun
/**
 * CLI for the OpenCode Dashboard
 *
 * Usage:
 *   npx opencode-dashboard <command> [options]
 *
 * Commands:
 *   start [--port 3333]   Start the dashboard server
 *   stop                  Stop a running dashboard server
 *   status                Check if the dashboard server is running
 *
 * Options:
 *   --port, -p            Server port (default: 3333, env: DASHBOARD_PORT)
 *   --help, -h            Show help
 *   --version, -v         Show version
 */

import { join } from "path";
import { readPid, removePid, isServerRunning } from "../server/pid";

// ─── Constants ─────────────────────────────────────────────────

const SERVER_ENTRY = join(import.meta.dir, "..", "server", "index.ts");
const DEFAULT_PORT = 3333;
const SPAWN_TIMEOUT_MS = 10_000;
const SPAWN_POLL_INTERVAL_MS = 250;

// ─── Helpers ───────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
opencode-dashboard - Real-time Kanban dashboard for OpenCode agent pipelines

Usage:
  opencode-dashboard <command> [options]

Commands:
  start    Start the dashboard server
  stop     Stop a running dashboard server
  status   Check if the dashboard server is running

Options:
  --port, -p <port>   Server port (default: ${DEFAULT_PORT}, env: DASHBOARD_PORT)
  --help, -h          Show this help message
  --version, -v       Show version
`.trim());
}

function printVersion(): void {
  try {
    const pkg = require("../package.json");
    console.log(pkg.version);
  } catch {
    console.log("unknown");
  }
}

function parsePort(args: string[]): number {
  const portIdx = args.findIndex((a) => a === "--port" || a === "-p");
  if (portIdx !== -1 && args[portIdx + 1]) {
    const port = Number(args[portIdx + 1]);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      console.error(`Error: Invalid port "${args[portIdx + 1]}". Must be 1-65535.`);
      process.exit(1);
    }
    return port;
  }
  return Number(process.env.DASHBOARD_PORT) || DEFAULT_PORT;
}

async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Commands ──────────────────────────────────────────────────

async function cmdStart(args: string[]): Promise<void> {
  const port = parsePort(args);

  // Check if already running
  const existing = await isServerRunning(true);
  if (existing) {
    console.log(`Dashboard server is already running.`);
    console.log(`  URL: http://localhost:${existing.port}`);
    console.log(`  PID: ${existing.pid}`);
    console.log(`  Started: ${existing.startedAt}`);
    return;
  }

  console.log(`Starting dashboard server on port ${port}...`);

  try {
    const proc = Bun.spawn([process.execPath, "run", SERVER_ENTRY], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, DASHBOARD_PORT: String(port) },
    });
    proc.unref();
  } catch (err: any) {
    console.error(`Failed to start server: ${err?.message ?? err}`);
    process.exit(1);
  }

  // Poll for readiness
  const maxAttempts = Math.ceil(SPAWN_TIMEOUT_MS / SPAWN_POLL_INTERVAL_MS);
  for (let i = 0; i < maxAttempts; i++) {
    await Bun.sleep(SPAWN_POLL_INTERVAL_MS);
    if (await checkHealth(port)) {
      console.log(`Dashboard running at http://localhost:${port}`);
      return;
    }
  }

  console.error(`Server failed to start within ${SPAWN_TIMEOUT_MS / 1000}s.`);
  console.error(`Check if port ${port} is already in use.`);
  process.exit(1);
}

async function cmdStop(): Promise<void> {
  const pidData = readPid();
  if (!pidData) {
    console.log("No dashboard server found (no PID file).");
    return;
  }

  try {
    process.kill(pidData.pid, "SIGTERM");
    removePid();
    console.log(`Dashboard server stopped (PID: ${pidData.pid}).`);
  } catch (err: any) {
    if (err?.code === "ESRCH") {
      removePid();
      console.log("Dashboard server was not running (stale PID file cleaned up).");
    } else {
      console.error(`Failed to stop server: ${err?.message ?? err}`);
      process.exit(1);
    }
  }
}

async function cmdStatus(): Promise<void> {
  const pidData = await isServerRunning(false);
  if (!pidData) {
    console.log("Dashboard server is not running.");
    return;
  }

  // Process is alive, try health endpoint for more detail
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
      console.log(`Dashboard server is running.`);
      console.log(`  URL:     http://localhost:${pidData.port}`);
      console.log(`  PID:     ${pidData.pid}`);
      console.log(`  Uptime:  ${health.uptime ?? "?"}s`);
      console.log(`  Plugins: ${health.plugins ?? "?"}`);
      console.log(`  SSE:     ${health.sseClients ?? "?"} clients`);
      console.log(`  Started: ${pidData.startedAt}`);
      return;
    }
    console.log(`Dashboard server process exists (PID: ${pidData.pid}) but health check failed.`);
  } catch {
    console.log(`Dashboard server process exists (PID: ${pidData.pid}) but is not responding.`);
  }
}

// ─── Main ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (args.includes("--help") || args.includes("-h") || !command) {
  printHelp();
  process.exit(command ? 0 : 1);
}

if (args.includes("--version") || args.includes("-v")) {
  printVersion();
  process.exit(0);
}

switch (command) {
  case "start":
    await cmdStart(args.slice(1));
    break;
  case "stop":
    await cmdStop();
    break;
  case "status":
    await cmdStatus();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error(`Run "opencode-dashboard --help" for usage.`);
    process.exit(1);
}
