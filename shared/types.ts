/**
 * Shared TypeScript types for server, plugin, and React dashboard app.
 *
 * These types define the canonical data model used across all three components:
 * - Plugin → Server: event payloads (POST /api/plugin/event)
 * - Server → Dashboard: SSE events + REST API responses
 * - Dashboard: internal state management
 */

// ============================================================
// Core Domain Types
// ============================================================

/** Pipeline stages as Kanban columns */
export type Stage =
  | "backlog"
  | "orchestrator"
  | "builder"
  | "refactor"
  | "reviewer"
  | "committer"
  | "done"
  | "error";

/** Pipeline status */
export type PipelineStatus = "active" | "idle" | "done";

/** Bead status from `bd list --json` */
export type BdStatus = "open" | "in_progress" | "blocked" | "closed";

/** Pipeline agent types detected by the plugin */
export type AgentType =
  | "orchestrator"
  | "builder"
  | "refactor"
  | "reviewer"
  | "committer"
  | "designer";

// ============================================================
// Raw Bead Record (from bd list --json)
// ============================================================

/**
 * Raw bead record as returned by `bd list --json`.
 * Used in plugin event payloads and server state.
 */
export interface BeadRecord {
  id: string;
  title: string;
  description: string;
  status: string; // BdStatus, but left as string for forward compat
  priority: number; // 0 (critical) to 4 (backlog)
  issue_type: string; // bug, feature, task, epic, chore, decision
  created_at: string; // ISO timestamp
  updated_at: string; // ISO timestamp
  closed_at?: string; // ISO timestamp (if closed)
  close_reason?: string;
  dependencies?: Array<{
    type: string;
    depends_on_id: string;
  }>;
  // Extra fields from bd list --json (not in plan, but present)
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
}

// ============================================================
// Bead Diff (used in plugin for snapshot diffing)
// ============================================================

/**
 * A single diff entry between two bead snapshots.
 *
 * - `discovered`: bead exists in `next` but not `prev` (new bead appeared)
 * - `changed`: bead exists in both but status/fields differ
 * - `removed`: bead exists in `prev` but not `next` (bead deleted)
 * - `error`: bead transitioned to an error state (e.g., blocked)
 */
export type BeadDiff =
  | { type: "discovered"; bead: BeadRecord }
  | { type: "changed"; bead: BeadRecord; prevStatus: string }
  | { type: "removed"; beadId: string }
  | { type: "error"; bead: BeadRecord; error: string };

// ============================================================
// Bead State (server-enriched, used in dashboard)
// ============================================================

/**
 * Bead state as tracked by the server, enriched with pipeline stage info.
 * This is the canonical representation used in the dashboard UI.
 */
export interface BeadState {
  id: string;
  title: string;
  description: string;
  priority: number; // 0-4
  issueType: string;
  bdStatus: string; // BdStatus
  stage: Stage;
  stageStartedAt: number; // timestamp (ms)
  claimedAt?: number; // when orchestrator claimed
  completedAt?: number; // when bead was closed
  agentSessionId?: string; // current child session working on it
  error?: string; // error message if in error stage
}

// ============================================================
// Pipeline
// ============================================================

/**
 * A pipeline represents one orchestrator session working through beads.
 * Each project can have multiple pipelines (one per orchestrator session).
 */
export interface Pipeline {
  id: string; // orchestrator session ID
  title: string; // derived from first bead or session
  status: PipelineStatus;
  currentBeadId: string | null;
  beads: Map<string, BeadState>;
}

// ============================================================
// Project State
// ============================================================

/**
 * State for a single connected project (one OpenCode instance).
 * Identified by projectPath (working directory).
 */
export interface ProjectState {
  projectPath: string; // e.g., "/Users/.../project-a"
  projectName: string; // derived from directory basename
  pluginId: string; // unique ID for this plugin connection
  lastHeartbeat: number; // timestamp (ms)
  connected: boolean; // is the plugin alive?
  pipelines: Map<string, Pipeline>;
  lastBeadSnapshot: BeadRecord[];
}

// ============================================================
// Dashboard State (top-level)
// ============================================================

/**
 * Top-level aggregated state across all connected projects.
 * This is the canonical state maintained by the server.
 */
export interface DashboardState {
  projects: Map<string, ProjectState>;
}

// ============================================================
// Plugin Event Types
// ============================================================

/** All plugin event type strings */
export type PluginEventType =
  | "bead:discovered"
  | "bead:claimed"
  | "bead:stage"
  | "bead:done"
  | "bead:error"
  | "bead:changed"
  | "bead:removed"
  | "agent:active"
  | "agent:idle"
  | "beads:refreshed"
  | "pipeline:started"
  | "pipeline:done";

/** SSE event types sent from server to dashboard */
export type SSEEventType =
  | PluginEventType
  | "connected"
  | "state:full"
  | "project:connected"
  | "project:disconnected";

// ============================================================
// Plugin Event Payloads
// ============================================================

/** Common fields present in all plugin event payloads */
interface BaseEventPayload {
  projectPath: string;
  timestamp: number;
}

/** bead:discovered — new bead found in bd list --json */
export interface BeadDiscoveredPayload extends BaseEventPayload {
  bead: BeadRecord;
}

/** bead:claimed — bead status changed to in_progress */
export interface BeadClaimedPayload extends BaseEventPayload {
  beadId: string;
  bead: BeadRecord;
  stage: "orchestrator";
}

/** bead:stage — bead moving to a new pipeline stage */
export interface BeadStagePayload extends BaseEventPayload {
  beadId: string;
  stage: AgentType;
  agentSessionId?: string;
}

/** bead:done — bead closed successfully */
export interface BeadDonePayload extends BaseEventPayload {
  beadId: string;
  bead: BeadRecord;
}

/** bead:error — bead entered error state */
export interface BeadErrorPayload extends BaseEventPayload {
  beadId: string;
  bead?: BeadRecord;
  error: string;
}

/** bead:changed — bead status changed (not claimed/done/error) */
export interface BeadChangedPayload extends BaseEventPayload {
  bead: BeadRecord;
  prevStatus: string;
}

/** bead:removed — bead disappeared from bd list --json */
export interface BeadRemovedPayload extends BaseEventPayload {
  beadId: string;
}

/** agent:active — child agent session created and mapped to pipeline stage */
export interface AgentActivePayload extends BaseEventPayload {
  agent: AgentType;
  sessionId: string;
  parentSessionId: string;
  beadId: string;
}

/** agent:idle — child agent session finished work */
export interface AgentIdlePayload extends BaseEventPayload {
  agent: AgentType;
  sessionId: string;
  beadId: string;
}

/** beads:refreshed — summary after bead state refresh */
export interface BeadsRefreshedPayload extends BaseEventPayload {
  beadCount: number;
  changed: number;
}

/** pipeline:started — new pipeline session detected */
export interface PipelineStartedPayload extends BaseEventPayload {
  pipelineId: string;
  title?: string;
}

/** pipeline:done — all beads in pipeline completed */
export interface PipelineDonePayload extends BaseEventPayload {
  pipelineId: string;
}

/** Map of event type to its payload type */
export interface PluginEventPayloadMap {
  "bead:discovered": BeadDiscoveredPayload;
  "bead:claimed": BeadClaimedPayload;
  "bead:stage": BeadStagePayload;
  "bead:done": BeadDonePayload;
  "bead:error": BeadErrorPayload;
  "bead:changed": BeadChangedPayload;
  "bead:removed": BeadRemovedPayload;
  "agent:active": AgentActivePayload;
  "agent:idle": AgentIdlePayload;
  "beads:refreshed": BeadsRefreshedPayload;
  "pipeline:started": PipelineStartedPayload;
  "pipeline:done": PipelineDonePayload;
}

// ============================================================
// API Types (REST + SSE)
// ============================================================

/** POST /api/plugin/register request body */
export interface RegisterPluginRequest {
  projectPath: string;
  projectName: string;
}

/** POST /api/plugin/register response */
export interface RegisterPluginResponse {
  pluginId: string;
}

/** POST /api/plugin/event request body */
export interface PluginEventRequest {
  pluginId: string;
  event: PluginEventType;
  data?: Record<string, unknown>;
}

/** POST /api/plugin/heartbeat request body */
export interface HeartbeatRequest {
  pluginId: string;
}

// ============================================================
// SSE Event Payloads (server → dashboard)
// ============================================================

/** SSE connected event payload */
export interface SSEConnectedPayload {
  message: string;
  timestamp: number;
  plugins: Array<{
    pluginId: string;
    projectPath: string;
    projectName: string;
  }>;
}

/** SSE state:full event payload — serialized state snapshot */
export interface SSEStateFullPayload {
  version: number;
  savedAt: number;
  projects: Array<
    [
      string,
      {
        projectPath: string;
        projectName: string;
        pluginId: string;
        lastHeartbeat: number;
        connected: boolean;
        pipelines: Array<
          [
            string,
            {
              id: string;
              title: string;
              status: PipelineStatus;
              currentBeadId: string | null;
              beads: Array<[string, BeadState]>;
            },
          ]
        >;
        lastBeadSnapshot: BeadRecord[];
      },
    ]
  >;
}

/** SSE project:connected event payload */
export interface SSEProjectConnectedPayload {
  pluginId: string;
  projectPath: string;
  projectName: string;
}

/** SSE project:disconnected event payload */
export interface SSEProjectDisconnectedPayload {
  pluginId: string;
  projectPath: string;
  projectName: string;
  reason: string;
}

// ============================================================
// Dashboard UI Types
// ============================================================

/** Connection status for the dashboard's SSE connection */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

/** Priority display configuration */
export interface PriorityConfig {
  label: string;
  colorClass: string; // Tailwind class
}

/** Column configuration for the Kanban board */
export interface ColumnConfig {
  id: Stage;
  label: string;
}
