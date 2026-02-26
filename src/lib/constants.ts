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

/** Priority color classes (Tailwind) — used for pill badges (e.g. ActiveBeadLabel) */
export const PRIORITY_COLORS: Record<number, string> = {
  0: "bg-status-error text-white",       // P0 - Critical
  1: "bg-status-warning text-white",     // P1 - High
  2: "bg-status-done text-white",        // P2 - Medium
  3: "bg-status-idle text-white",        // P3 - Low
  4: "bg-status-idle/70 text-white",     // P4 - Lowest
};

/** Priority border colors (CSS values) — used for left-border card treatment */
export const PRIORITY_BORDER_COLORS: Record<number, string> = {
  0: "#ef4444",  // P0 - Critical (red-500)
  1: "#f97316",  // P1 - High (orange-500)
  2: "#3b82f6",  // P2 - Medium (blue-500)
  3: "#6b7280",  // P3 - Low (gray-500)
  4: "#9ca3af",  // P4 - Lowest (gray-400)
};

/** Priority label mapping */
export const PRIORITY_LABELS: Record<number, string> = {
  0: "P0",
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
};

/**
 * Issue type display labels — human-readable labels for issue types.
 */
export const ISSUE_TYPE_LABELS: Record<string, string> = {
  bug: "Bug",
  feature: "Feature",
  task: "Task",
  epic: "Epic",
  chore: "Chore",
  decision: "Decision",
};

/**
 * Issue type color classes — Tailwind classes for issue type icon tinting.
 * Provides quick visual differentiation between issue categories.
 */
export const ISSUE_TYPE_COLORS: Record<string, string> = {
  bug: "text-status-error",
  feature: "text-violet-400",
  task: "text-status-done",
  epic: "text-status-warning",
  chore: "text-status-idle",
  decision: "text-teal-400",
};

/** Connection status types */
export type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

/** Pipeline status types */
export type PipelineStatus = "active" | "idle" | "done";

/** Dashboard server URL — empty for relative URLs (server serves the frontend in production) */
export const SERVER_URL = "";

/** SSE reconnect interval (ms) — matches server retry directive */
export const SSE_RECONNECT_INTERVAL = 3000;
