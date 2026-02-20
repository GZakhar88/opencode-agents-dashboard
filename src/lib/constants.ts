/**
 * Column definitions and constants for the Kanban board.
 */

/** Pipeline stages as Kanban columns */
export const COLUMNS = [
  "backlog",
  "orchestrator",
  "builder",
  "refactor",
  "reviewer",
  "committer",
  "error",
  "done",
] as const;

export type ColumnId = (typeof COLUMNS)[number];

/** Display labels for each column */
export const COLUMN_LABELS: Record<ColumnId, string> = {
  backlog: "Backlog",
  orchestrator: "Orchestrator",
  builder: "Builder",
  refactor: "Refactor",
  reviewer: "Reviewer",
  committer: "Committer",
  error: "Error",
  done: "Done",
};

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

/** Dashboard server URL */
export const SERVER_URL = "http://localhost:3333";

/** SSE reconnect interval (ms) — matches server retry directive */
export const SSE_RECONNECT_INTERVAL = 3000;
