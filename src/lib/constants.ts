/**
 * Column definitions and constants for the Kanban board.
 *
 * Columns are now dynamic (driven by agent discovery in the plugin).
 * This file provides default/fallback columns (status bookends only)
 * and shared UI constants.
 */

import type { ColumnConfig } from "@shared/types";

/**
 * Default columns shown when no agent-driven column config has been received.
 * Only the status bookends: ready, done, error.
 */
export const DEFAULT_COLUMNS: ColumnConfig[] = [
  { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
  { id: "done", label: "Done", type: "status", color: "#22c55e", order: 1 },
  { id: "error", label: "Error", type: "status", color: "#ef4444", order: 2 },
];

/** Priority color classes (Tailwind) */
export const PRIORITY_COLORS: Record<number, string> = {
  0: "bg-red-500 text-white",       // P0 - Critical
  1: "bg-orange-500 text-white",    // P1 - High
  2: "bg-blue-500 text-white",      // P2 - Medium
  3: "bg-gray-500 text-white",      // P3 - Low
  4: "bg-gray-400 text-white",      // P4 - Lowest
};

/** Connection status types */
export type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

/** Pipeline status types */
export type PipelineStatus = "active" | "idle" | "done";

/** Dashboard server URL — empty for relative URLs (server serves the frontend in production) */
export const SERVER_URL = "";

/** SSE reconnect interval (ms) — matches server retry directive */
export const SSE_RECONNECT_INTERVAL = 3000;
