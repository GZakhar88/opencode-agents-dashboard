/**
 * Board state reducer from SSE events.
 *
 * Manages the full DashboardState (projects → pipelines → beads hierarchy)
 * using React's useReducer pattern. Each SSE event dispatched to this hook
 * produces an immutable state update.
 *
 * The state uses nested Maps for efficient lookup:
 *   DashboardState.projects: Map<projectPath, ProjectState>
 *     ProjectState.pipelines: Map<pipelineId, Pipeline>
 *       Pipeline.beads: Map<beadId, BeadState>
 *
 * @see shared/types.ts for canonical type definitions
 * @see useEventSource.ts for the SSE connection hook that feeds events here
 */

import { useReducer, useCallback } from "react";
import type {
  DashboardState,
  ProjectState,
  Pipeline,
  BeadState,
  BeadRecord,
  Stage,
  PipelineStatus,
  SSEEventType,
  SSEStateFullPayload,
  SSEProjectConnectedPayload,
  SSEProjectDisconnectedPayload,
  BeadDiscoveredPayload,
  BeadClaimedPayload,
  BeadStagePayload,
  BeadDonePayload,
  BeadErrorPayload,
  BeadChangedPayload,
  BeadRemovedPayload,
  AgentActivePayload,
  AgentIdlePayload,
  PipelineStartedPayload,
  PipelineDonePayload,
  ColumnConfig,
  ColumnsUpdatePayload,
} from "@shared/types";
import type { SSEEvent } from "./useEventSource";

// ============================================================
// Reducer Action Types
// ============================================================

/**
 * The server enriches event payloads with `pipelineId` before broadcasting.
 * This intersection type adds the optional field to any payload.
 */
type WithPipelineId<T> = T & { pipelineId?: string };

/**
 * Discriminated union of all actions the board state reducer handles.
 * Each action maps to an SSE event type.
 */
type BoardAction =
  | { type: "STATE_FULL"; payload: SSEStateFullPayload }
  | { type: "PROJECT_CONNECTED"; payload: SSEProjectConnectedPayload }
  | { type: "BEAD_DISCOVERED"; payload: WithPipelineId<BeadDiscoveredPayload> }
  | { type: "BEAD_CLAIMED"; payload: WithPipelineId<BeadClaimedPayload> }
  | { type: "BEAD_STAGE"; payload: WithPipelineId<BeadStagePayload> }
  | { type: "BEAD_DONE"; payload: WithPipelineId<BeadDonePayload> }
  | { type: "BEAD_ERROR"; payload: WithPipelineId<BeadErrorPayload> }
  | { type: "BEAD_CHANGED"; payload: WithPipelineId<BeadChangedPayload> }
  | { type: "BEAD_REMOVED"; payload: WithPipelineId<BeadRemovedPayload> }
  | { type: "PIPELINE_STARTED"; payload: PipelineStartedPayload }
  | { type: "PIPELINE_DONE"; payload: PipelineDonePayload }
  | { type: "PROJECT_DISCONNECTED"; payload: SSEProjectDisconnectedPayload }
  | { type: "AGENT_ACTIVE"; payload: WithPipelineId<AgentActivePayload> }
  | { type: "AGENT_IDLE"; payload: WithPipelineId<AgentIdlePayload> }
  | { type: "COLUMNS_UPDATE"; payload: ColumnsUpdatePayload };

// ============================================================
// Initial State
// ============================================================

const initialState: DashboardState = {
  projects: new Map(),
};

/** Default title for auto-created pipelines. */
const DEFAULT_PIPELINE_TITLE = "Pipeline";

// ============================================================
// Helpers
// ============================================================

/**
 * Clone a Map shallowly — creates a new Map reference for React to detect
 * state changes, while preserving the entries.
 */
function cloneMap<K, V>(map: Map<K, V>): Map<K, V> {
  return new Map(map);
}

/**
 * Get or create a project entry in the projects Map.
 * Returns both the (possibly new) project and a new projects Map.
 */
function ensureProject(
  projects: Map<string, ProjectState>,
  projectPath: string,
): { project: ProjectState; projects: Map<string, ProjectState> } {
  const newProjects = cloneMap(projects);
  let project = newProjects.get(projectPath);
  if (!project) {
    project = {
      projectPath,
      projectName: projectPath.split("/").pop() || projectPath,
      pluginId: "",
      lastHeartbeat: Date.now(),
      connected: true,
      pipelines: new Map(),
      lastBeadSnapshot: [],
      columns: [],
    };
    newProjects.set(projectPath, project);
  } else {
    // Clone the project for immutability
    project = { ...project, pipelines: cloneMap(project.pipelines) };
    newProjects.set(projectPath, project);
  }
  return { project, projects: newProjects };
}

/**
 * Get or create the default pipeline for a project.
 * If a pipelineId is provided, use that; otherwise use the first existing
 * pipeline or create a "default" pipeline.
 */
function ensurePipeline(project: ProjectState, pipelineId?: string): Pipeline {
  // If a specific pipeline ID was requested, try to find it
  if (pipelineId) {
    const existing = project.pipelines.get(pipelineId);
    if (existing) {
      // Clone for immutability
      const cloned: Pipeline = {
        ...existing,
        beads: cloneMap(existing.beads),
      };
      project.pipelines.set(pipelineId, cloned);
      return cloned;
    }
    // Create new pipeline with the requested ID
    const newPipeline: Pipeline = {
      id: pipelineId,
      title: DEFAULT_PIPELINE_TITLE,
      status: "active",
      currentBeadId: null,
      beads: new Map(),
    };
    project.pipelines.set(pipelineId, newPipeline);
    return newPipeline;
  }

  // No pipelineId specified — use first existing pipeline or create default
  if (project.pipelines.size > 0) {
    const first = project.pipelines.values().next().value!;
    const cloned: Pipeline = {
      ...first,
      beads: cloneMap(first.beads),
    };
    project.pipelines.set(first.id, cloned);
    return cloned;
  }

  const defaultPipeline: Pipeline = {
    id: "default",
    title: DEFAULT_PIPELINE_TITLE,
    status: "active",
    currentBeadId: null,
    beads: new Map(),
  };
  project.pipelines.set("default", defaultPipeline);
  return defaultPipeline;
}

/**
 * Map a bd CLI status string to a pipeline stage.
 * This mirrors the server-side `bdStatusToStage` logic.
 */
function bdStatusToStage(bdStatus: string): Stage {
  switch (bdStatus) {
    case "open":
    case "in_progress":
      return "ready";
    case "closed":
      return "done";
    case "blocked":
      return "error";
    default:
      return "ready";
  }
}

/**
 * Create a BeadState from a BeadRecord (bd list --json format).
 */
function beadRecordToState(record: BeadRecord, stage: Stage): BeadState {
  return {
    id: record.id,
    title: record.title,
    description: record.description || "",
    priority: record.priority ?? 1,
    issueType: record.issue_type || "task",
    bdStatus: record.status,
    stage,
    stageStartedAt: Date.now(),
  };
}

// ============================================================
// STATE_FULL Deserialization
// ============================================================

/**
 * Deserialize the state:full SSE payload into DashboardState with nested Maps.
 *
 * The server sends state in two possible formats:
 * 1. Tuple format (SSEStateFullPayload): projects as Array<[key, value]>
 * 2. Object format (from stateManager.toJSON()): projects as Array<object>
 *
 * This function handles both formats defensively.
 */
function deserializeStateFull(payload: unknown): DashboardState {
  if (!payload || typeof payload !== "object") {
    return { projects: new Map() };
  }

  const data = payload as Record<string, unknown>;
  const rawProjects = data.projects;

  if (!Array.isArray(rawProjects)) {
    return { projects: new Map() };
  }

  const projects = new Map<string, ProjectState>();

  for (const entry of rawProjects) {
    // Handle tuple format: [key, projectData]
    // Handle object format: { projectPath, ... }
    let key: string;
    let projectData: Record<string, unknown>;

    if (Array.isArray(entry) && entry.length === 2) {
      // Tuple format: [projectPath, projectState]
      key = entry[0] as string;
      projectData = entry[1] as Record<string, unknown>;
    } else if (entry && typeof entry === "object" && "projectPath" in entry) {
      // Object format: { projectPath, ... }
      projectData = entry as Record<string, unknown>;
      key = projectData.projectPath as string;
    } else {
      continue;
    }

    const pipelines = new Map<string, Pipeline>();
    const rawPipelines = projectData.pipelines;

    if (Array.isArray(rawPipelines)) {
      for (const pEntry of rawPipelines) {
        let pipelineData: Record<string, unknown>;
        let pKey: string;

        if (Array.isArray(pEntry) && pEntry.length === 2) {
          // Tuple format: [pipelineId, pipelineState]
          pKey = pEntry[0] as string;
          pipelineData = pEntry[1] as Record<string, unknown>;
        } else if (pEntry && typeof pEntry === "object" && "id" in pEntry) {
          // Object format: { id, ... }
          pipelineData = pEntry as Record<string, unknown>;
          pKey = pipelineData.id as string;
        } else {
          continue;
        }

        const beads = new Map<string, BeadState>();
        const rawBeads = pipelineData.beads;

        if (Array.isArray(rawBeads)) {
          for (const bEntry of rawBeads) {
            let beadData: BeadState;
            let bKey: string;

            if (Array.isArray(bEntry) && bEntry.length === 2) {
              // Tuple format: [beadId, beadState]
              bKey = bEntry[0] as string;
              beadData = bEntry[1] as BeadState;
            } else if (bEntry && typeof bEntry === "object" && "id" in bEntry) {
              // Object format: { id, ... }
              beadData = bEntry as BeadState;
              bKey = beadData.id;
            } else {
              continue;
            }

            beads.set(bKey, { ...beadData });
          }
        }

        pipelines.set(pKey, {
          id: pipelineData.id as string,
          title: (pipelineData.title as string) || DEFAULT_PIPELINE_TITLE,
          status: (pipelineData.status as PipelineStatus) || "active",
          currentBeadId: (pipelineData.currentBeadId as string | null) ?? null,
          beads,
        });
      }
    }

    projects.set(key, {
      projectPath: (projectData.projectPath as string) || key,
      projectName:
        (projectData.projectName as string) || key.split("/").pop() || key,
      pluginId: (projectData.pluginId as string) || "",
      lastHeartbeat: (projectData.lastHeartbeat as number) || Date.now(),
      connected: projectData.connected !== false, // default to true
      pipelines,
      lastBeadSnapshot: (projectData.lastBeadSnapshot as BeadRecord[]) || [],
      columns: (projectData.columns as ColumnConfig[]) || [],
    });
  }

  return { projects };
}

// ============================================================
// Reducer
// ============================================================

/**
 * Pure reducer function for board state management.
 *
 * Each case handles one SSE event type by producing a new immutable state.
 * Map updates always create new Map references so React detects changes.
 */
function boardReducer(
  state: DashboardState,
  action: BoardAction,
): DashboardState {
  switch (action.type) {
    // ----- Full state replacement (reconnect / initial load) -----
    case "STATE_FULL": {
      return deserializeStateFull(action.payload);
    }

    // ----- Project connected — mark project as online -----
    case "PROJECT_CONNECTED": {
      const { projectPath, projectName, pluginId } = action.payload;
      if (!projectPath) return state;

      const newProjects = cloneMap(state.projects);
      const existing = newProjects.get(projectPath);

      if (existing) {
        // Re-activate existing project
        newProjects.set(projectPath, {
          ...existing,
          pipelines: cloneMap(existing.pipelines),
          connected: true,
          lastHeartbeat: Date.now(),
          pluginId,
        });
      } else {
        // First time seeing this project
        newProjects.set(projectPath, {
          projectPath,
          projectName: projectName || projectPath.split("/").pop() || projectPath,
          pluginId,
          lastHeartbeat: Date.now(),
          connected: true,
          pipelines: new Map(),
          lastBeadSnapshot: [],
          columns: [],
        });
      }

      return { projects: newProjects };
    }

    // ----- Bead discovered — add to ready -----
    case "BEAD_DISCOVERED": {
      const { projectPath, bead: beadRecord, pipelineId } = action.payload;
      if (!beadRecord?.id) return state;

      const { project, projects } = ensureProject(state.projects, projectPath);
      const pipeline = ensurePipeline(project, pipelineId);

      // Only add if not already tracked
      if (!pipeline.beads.has(beadRecord.id)) {
        const stage = bdStatusToStage(beadRecord.status);
        pipeline.beads.set(beadRecord.id, beadRecordToState(beadRecord, stage));
      }

      return { projects };
    }

    // ----- Bead claimed — move to agent stage from payload -----
    case "BEAD_CLAIMED": {
      const {
        projectPath,
        beadId,
        bead: beadRecord,
        stage: claimedStage,
        pipelineId,
      } = action.payload;
      const resolvedBeadId = beadId || beadRecord?.id;
      if (!resolvedBeadId) return state;

      const { project, projects } = ensureProject(state.projects, projectPath);
      const pipeline = ensurePipeline(project, pipelineId);

      const targetStage = claimedStage || "ready";
      const now = Date.now();
      const existingBead = pipeline.beads.get(resolvedBeadId);

      if (existingBead) {
        // Update existing bead
        pipeline.beads.set(resolvedBeadId, {
          ...existingBead,
          bdStatus: "in_progress",
          stage: targetStage,
          stageStartedAt: now,
          claimedAt: now,
        });
      } else if (beadRecord) {
        // Discovered + claimed in same cycle — create it
        pipeline.beads.set(resolvedBeadId, {
          ...beadRecordToState(beadRecord, targetStage),
          bdStatus: "in_progress",
          claimedAt: now,
        });
      }

      // Update pipeline tracking
      pipeline.currentBeadId = resolvedBeadId;
      pipeline.status = "active";

      return { projects };
    }

    // ----- Bead stage transition (agent column change) -----
    case "BEAD_STAGE": {
      const { projectPath, beadId, stage, agentSessionId, pipelineId } =
        action.payload;
      if (!beadId || !stage) return state;

      const { project, projects } = ensureProject(state.projects, projectPath);
      const pipeline = ensurePipeline(project, pipelineId);

      const beadState = pipeline.beads.get(beadId);
      if (beadState) {
        pipeline.beads.set(beadId, {
          ...beadState,
          stage,
          stageStartedAt: Date.now(),
          ...(agentSessionId ? { agentSessionId } : {}),
        });
      }

      return { projects };
    }

    // ----- Bead done — move to done stage -----
    case "BEAD_DONE": {
      const {
        projectPath,
        beadId,
        bead: beadRecord,
        pipelineId,
      } = action.payload;
      const resolvedBeadId = beadId || beadRecord?.id;
      if (!resolvedBeadId) return state;

      const { project, projects } = ensureProject(state.projects, projectPath);
      const pipeline = ensurePipeline(project, pipelineId);

      const beadState = pipeline.beads.get(resolvedBeadId);
      if (beadState) {
        const now = Date.now();
        pipeline.beads.set(resolvedBeadId, {
          ...beadState,
          bdStatus: "closed",
          stage: "done",
          stageStartedAt: now,
          completedAt: now,
          agentSessionId: undefined,
          error: undefined,
        });
      }

      // Clear current bead if it was this one
      if (pipeline.currentBeadId === resolvedBeadId) {
        pipeline.currentBeadId = null;
      }

      return { projects };
    }

    // ----- Bead error — move to error stage -----
    case "BEAD_ERROR": {
      const {
        projectPath,
        beadId,
        error,
        bead: beadRecord,
        pipelineId,
      } = action.payload;
      const resolvedBeadId = beadId || beadRecord?.id;
      if (!resolvedBeadId) return state;

      const { project, projects } = ensureProject(state.projects, projectPath);
      const pipeline = ensurePipeline(project, pipelineId);

      const beadState = pipeline.beads.get(resolvedBeadId);
      if (beadState) {
        pipeline.beads.set(resolvedBeadId, {
          ...beadState,
          stage: "error",
          stageStartedAt: Date.now(),
          error: error || "Unknown error",
          ...(beadRecord?.status ? { bdStatus: beadRecord.status } : {}),
        });
      } else if (beadRecord) {
        // Create the bead in error state
        pipeline.beads.set(resolvedBeadId, {
          ...beadRecordToState(beadRecord, "error"),
          error: error || "Unknown error",
        });
      }

      // Clear current bead if it was this one
      if (pipeline.currentBeadId === resolvedBeadId) {
        pipeline.currentBeadId = null;
      }

      return { projects };
    }

    // ----- Bead changed — update metadata -----
    case "BEAD_CHANGED": {
      const { projectPath, bead: beadRecord, pipelineId } = action.payload;
      if (!beadRecord?.id) return state;

      const { project, projects } = ensureProject(state.projects, projectPath);
      const pipeline = ensurePipeline(project, pipelineId);

      const beadState = pipeline.beads.get(beadRecord.id);
      if (beadState) {
        pipeline.beads.set(beadRecord.id, {
          ...beadState,
          bdStatus: beadRecord.status,
          title: beadRecord.title,
          description: beadRecord.description || "",
          priority: beadRecord.priority ?? beadState.priority,
          issueType: beadRecord.issue_type || beadState.issueType,
        });
      }

      return { projects };
    }

    // ----- Bead removed — delete from pipeline -----
    case "BEAD_REMOVED": {
      const { projectPath, beadId, pipelineId } = action.payload;
      if (!beadId) return state;

      const { project, projects } = ensureProject(state.projects, projectPath);
      const pipeline = ensurePipeline(project, pipelineId);

      pipeline.beads.delete(beadId);
      if (pipeline.currentBeadId === beadId) {
        pipeline.currentBeadId = null;
      }

      return { projects };
    }

    // ----- Pipeline started — create or activate pipeline -----
    case "PIPELINE_STARTED": {
      const { projectPath, pipelineId, title } = action.payload;
      if (!pipelineId) return state;

      const { project, projects } = ensureProject(state.projects, projectPath);

      const existing = project.pipelines.get(pipelineId);
      if (existing) {
        project.pipelines.set(pipelineId, {
          ...existing,
          beads: cloneMap(existing.beads),
          title: title || existing.title,
          status: "active",
        });
      } else {
        project.pipelines.set(pipelineId, {
          id: pipelineId,
          title: title || DEFAULT_PIPELINE_TITLE,
          status: "active",
          currentBeadId: null,
          beads: new Map(),
        });
      }

      return { projects };
    }

    // ----- Pipeline done — mark pipeline as completed -----
    case "PIPELINE_DONE": {
      const { projectPath, pipelineId } = action.payload;
      if (!pipelineId) return state;

      const { project, projects } = ensureProject(state.projects, projectPath);

      const existing = project.pipelines.get(pipelineId);
      if (existing) {
        project.pipelines.set(pipelineId, {
          ...existing,
          beads: cloneMap(existing.beads),
          status: "done",
          currentBeadId: null,
        });
      }

      return { projects };
    }

    // ----- Project disconnected — mark project as offline -----
    case "PROJECT_DISCONNECTED": {
      const { projectPath } = action.payload;
      if (!projectPath) return state;

      const existing = state.projects.get(projectPath);
      if (!existing) return state;

      // Clone pipelines and mark active ones as idle
      const newPipelines = cloneMap(existing.pipelines);
      for (const [key, pipeline] of newPipelines) {
        if (pipeline.status === "active") {
          newPipelines.set(key, { ...pipeline, status: "idle" });
        }
      }

      const newProjects = cloneMap(state.projects);
      newProjects.set(projectPath, {
        ...existing,
        pipelines: newPipelines,
        connected: false,
      });

      return { projects: newProjects };
    }

    // ----- Agent active — track which agent is working on a bead -----
    case "AGENT_ACTIVE": {
      const { projectPath, beadId, sessionId, pipelineId } = action.payload;
      if (!beadId || !sessionId) return state;

      const { project, projects } = ensureProject(state.projects, projectPath);
      const pipeline = ensurePipeline(project, pipelineId);

      const beadState = pipeline.beads.get(beadId);
      if (beadState) {
        pipeline.beads.set(beadId, {
          ...beadState,
          agentSessionId: sessionId,
        });
      }

      return { projects };
    }

    // ----- Agent idle — clear agent activity on a bead -----
    case "AGENT_IDLE": {
      const { projectPath, beadId, sessionId, pipelineId } = action.payload;
      if (!beadId) return state;

      const { project, projects } = ensureProject(state.projects, projectPath);
      const pipeline = ensurePipeline(project, pipelineId);

      const beadState = pipeline.beads.get(beadId);
      if (beadState && beadState.agentSessionId === sessionId) {
        pipeline.beads.set(beadId, {
          ...beadState,
          agentSessionId: undefined,
        });
      }

      return { projects };
    }

    // ----- Columns update — store dynamic column config for a project -----
    case "COLUMNS_UPDATE": {
      const { projectPath, columns } = action.payload;
      if (!projectPath || !Array.isArray(columns)) return state;

      const { project, projects } = ensureProject(state.projects, projectPath);
      project.columns = columns;

      return { projects };
    }

    default:
      return state;
  }
}

// ============================================================
// SSE Event → Reducer Action Mapping
// ============================================================

/**
 * Map from SSE event type string to reducer action type string.
 * Only events that affect board state are included.
 */
const SSE_TO_ACTION: Partial<Record<SSEEventType, BoardAction["type"]>> = {
  "state:full": "STATE_FULL",
  "project:connected": "PROJECT_CONNECTED",
  "bead:discovered": "BEAD_DISCOVERED",
  "bead:claimed": "BEAD_CLAIMED",
  "bead:stage": "BEAD_STAGE",
  "bead:done": "BEAD_DONE",
  "bead:error": "BEAD_ERROR",
  "bead:changed": "BEAD_CHANGED",
  "bead:removed": "BEAD_REMOVED",
  "pipeline:started": "PIPELINE_STARTED",
  "pipeline:done": "PIPELINE_DONE",
  "project:disconnected": "PROJECT_DISCONNECTED",
  "agent:active": "AGENT_ACTIVE",
  "agent:idle": "AGENT_IDLE",
  "columns:update": "COLUMNS_UPDATE",
};

// ============================================================
// Hook
// ============================================================

/** Return type of the useBoardState hook */
export interface UseBoardStateReturn {
  /** Current dashboard state with all projects, pipelines, and beads */
  state: DashboardState;
  /** Dispatch an SSE event to update board state */
  dispatch: (event: SSEEvent) => void;
}

/**
 * React hook that manages the full dashboard board state.
 *
 * Uses `useReducer` internally to process SSE events into immutable state
 * updates. The returned `dispatch` function accepts raw SSE events (as
 * received from `useEventSource`) and maps them to typed reducer actions.
 *
 * Events that don't affect board state (e.g., "connected", "beads:refreshed")
 * are silently ignored.
 *
 * @example
 * ```tsx
 * const { state, dispatch } = useBoardState();
 *
 * const { status } = useEventSource({
 *   onEvent: dispatch,
 * });
 *
 * // state.projects is a Map<string, ProjectState>
 * for (const [path, project] of state.projects) {
 *   // render project sections...
 * }
 * ```
 */
export function useBoardState(): UseBoardStateReturn {
  const [state, rawDispatch] = useReducer(boardReducer, initialState);

  const dispatch = useCallback((event: SSEEvent) => {
    const actionType = SSE_TO_ACTION[event.type];
    if (!actionType) {
      // Event type doesn't affect board state — ignore
      return;
    }

    // Construct the typed action. The payload is the raw event data
    // which matches the expected payload types from the server.
    rawDispatch({
      type: actionType,
      payload: event.data,
    } as BoardAction);
  }, []);

  return { state, dispatch };
}

// ============================================================
// Exports for Testing
// ============================================================

/** @internal Exported for unit testing only. */
export { boardReducer as _boardReducer, initialState as _initialState };
export type { BoardAction as _BoardAction };
