/**
 * PID File Management for the Dashboard Server
 *
 * Enables both the plugin tools and CLI to discover, control,
 * and check the status of a running dashboard server.
 *
 * PID file location: ~/.cache/opencode/opencode-dashboard.pid
 * Contents: JSON { pid, port, startedAt }
 */

import { existsSync, mkdirSync, openSync, readFileSync, statSync, truncateSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

// --- Types ---

export interface PidFileData {
  pid: number;
  port: number;
  startedAt: string; // ISO timestamp
  buildHash?: string; // 12-char hex hash of source files (optional for backward compat)
}

// --- PID file path ---

const PID_DIR = join(homedir(), ".cache", "opencode");
const PID_FILE = join(PID_DIR, "opencode-dashboard.pid");
const LOG_FILE = join(PID_DIR, "opencode-dashboard.log");

const MAX_LOG_SIZE_BYTES = 1_048_576; // 1 MB

/** Get the PID file path (exposed for testing) */
export function getPidFilePath(): string {
  return PID_FILE;
}

/** Get the server log file path */
export function getLogFilePath(): string {
  return LOG_FILE;
}

/**
 * Prepare the server log file for writing.
 * Ensures the directory exists and truncates the file if it exceeds 1 MB.
 * Returns a file descriptor opened in append mode, suitable for Bun.spawn stdio.
 */
export function openLogFile(): number {
  if (!existsSync(PID_DIR)) {
    mkdirSync(PID_DIR, { recursive: true });
  }

  // Simple size management: truncate if over 1 MB
  try {
    const st = statSync(LOG_FILE);
    if (st.size > MAX_LOG_SIZE_BYTES) {
      truncateSync(LOG_FILE, 0);
    }
  } catch {
    // File doesn't exist yet — that's fine
  }

  // Open in append mode, create if not exists
  return openSync(LOG_FILE, "a");
}

// --- Write ---

/**
 * Write PID file when the server starts.
 * Creates the directory if it doesn't exist.
 */
export function writePid(pid: number, port: number, buildHash?: string): void {
  if (!existsSync(PID_DIR)) {
    mkdirSync(PID_DIR, { recursive: true });
  }
  const data: PidFileData = {
    pid,
    port,
    startedAt: new Date().toISOString(),
    ...(buildHash ? { buildHash } : {}),
  };
  writeFileSync(PID_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// --- Read ---

/**
 * Read PID file. Returns null if the file doesn't exist or is malformed.
 */
export function readPid(): PidFileData | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const raw = readFileSync(PID_FILE, "utf-8");
    const parsed = JSON.parse(raw) as PidFileData;
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// --- Remove ---

/**
 * Remove PID file on graceful shutdown or after stopping the server.
 *
 * When `ownPid` is provided, the file is only deleted if it still belongs
 * to that process. This prevents a shutting-down server from accidentally
 * removing a *new* server's PID file written during a restart race.
 */
export function removePid(ownPid?: number): void {
  try {
    if (!existsSync(PID_FILE)) return;
    if (ownPid !== undefined) {
      const current = readPid();
      if (current && current.pid !== ownPid) return; // PID file belongs to a newer server
    }
    unlinkSync(PID_FILE);
  } catch {
    // Ignore errors (file may already be gone)
  }
}

// --- Status check ---

/**
 * Check if a process with the given PID is still running.
 * Uses `kill(pid, 0)` which checks for existence without sending a signal.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the dashboard server is running.
 *
 * Performs a two-step check:
 * 1. PID file exists and process is alive (fast, no network)
 * 2. Optionally hits the health endpoint for confirmation
 *
 * Returns the PID file data if the server is running, null otherwise.
 * Automatically cleans up stale PID files.
 */
export async function isServerRunning(
  checkHealth = false,
): Promise<PidFileData | null> {
  const pidData = readPid();
  if (!pidData) return null;

  // Check if the process is still alive
  if (!isProcessAlive(pidData.pid)) {
    // Stale PID file — process is dead, clean up
    removePid();
    return null;
  }

  // Optional: verify via health endpoint
  if (checkHealth) {
    try {
      const res = await fetch(
        `http://localhost:${pidData.port}/api/health`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (!res.ok) {
        return null;
      }
    } catch {
      // Health check failed but process is alive — might be starting up
      // Return the PID data anyway; caller can retry
    }
  }

  return pidData;
}
