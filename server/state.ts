/**
 * Dashboard Server - State Management
 *
 * Manages the canonical aggregated state across all connected projects.
 * Processes plugin events into state mutations and persists to disk.
 *
 * State hierarchy:
 *   DashboardState
 *     └─ projects: Map<projectPath, ProjectState>
 *          └─ pipelines: Map<pipelineId, Pipeline>
 *               └─ beads: Map<beadId, BeadState>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type {
  BeadRecord,
  BeadState,
  Pipeline,
  ProjectState,
  DashboardState,
  PipelineStatus,
  Stage,
  ColumnConfig,
} from "../shared/types";

// Re-export types so existing consumers (routes.ts, tests) continue to work
export type { BeadRecord, BeadState, Pipeline, ProjectState, DashboardState };

// --- Serialization types (for JSON persistence) ---

interface SerializedBeadState extends Omit<BeadState, never> {}

interface SerializedPipeline {
  id: string;
  title: string;
  status: PipelineStatus;
  currentBeadId: string | null;
  beads: [string, SerializedBeadState][];
}

interface SerializedProjectState {
  projectPath: string;
  projectName: string;
  pluginId: string;
  lastHeartbeat: number;
  connected: boolean;
  pipelines: [string, SerializedPipeline][];
  lastBeadSnapshot: BeadRecord[];
  columns: ColumnConfig[];
}

interface SerializedDashboardState {
  version: 1;
  savedAt: number;
  projects: [string, SerializedProjectState][];
}

// --- Constants for dynamic column creation & visibility ---

/** Stages that are bookends and should never get dynamic columns */
const BOOKEND_STAGES = new Set(["ready", "done", "error"]);

/** Bookend column IDs that are always visible */
const ALWAYS_VISIBLE_COLUMNS = BOOKEND_STAGES;

/** Pipeline stage IDs — all pipeline agent columns including orchestrator */
const PIPELINE_STAGE_IDS = new Set([
  "orchestrator",
  "pipeline-builder",
  "pipeline-refactor",
  "pipeline-reviewer",
  "pipeline-committer",
]);

/** Grace period in milliseconds before hiding pipeline columns */
const PIPELINE_HIDE_GRACE_MS = 30_000;

/** Pipeline agent IDs with their fixed order */
const PIPELINE_AGENT_ORDER: Record<string, number> = {
  orchestrator: 1,
  "pipeline-builder": 2,
  "pipeline-refactor": 3,
  "pipeline-reviewer": 4,
  "pipeline-committer": 5,
};

/** Default color palette for dynamically created agent columns */
const DEFAULT_COLUMN_COLORS = [
  "#8b5cf6", // violet
  "#3b82f6", // blue
  "#06b6d4", // cyan
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ec4899", // pink
  "#f97316", // orange
  "#6366f1", // indigo
];

/**
 * Format agent name into a human-readable label.
 * Strips 'pipeline-' prefix and capitalizes the first letter.
 *
 * Examples:
 *   'pipeline-builder' → 'Builder'
 *   'build' → 'Build'
 *   'my-custom-agent' → 'My-custom-agent'
 */
export function formatAgentLabel(name: string): string {
  const display = name.startsWith("pipeline-")
    ? name.slice("pipeline-".length)
    : name;
  return display.charAt(0).toUpperCase() + display.slice(1);
}

/**
 * Check if a column with the given ID already exists in a project's columns.
 */
export function hasColumn(project: ProjectState, stageId: string): boolean {
  return project.columns.some((col) => col.id === stageId);
}

/**
 * Pick a color from the default palette, avoiding colors already used
 * by existing columns.
 */
export function pickColor(project: ProjectState, _stageId: string): string {
  const usedColors = new Set(project.columns.map((col) => col.color));
  for (const color of DEFAULT_COLUMN_COLORS) {
    if (!usedColors.has(color)) {
      return color;
    }
  }
  // All colors used — cycle through palette based on column count
  return DEFAULT_COLUMN_COLORS[
    project.columns.length % DEFAULT_COLUMN_COLORS.length
  ];
}

/**
 * Compute the correct order for a new column, then re-normalize all
 * order values to clean sequential integers.
 *
 * Pipeline agents get their fixed order (1-5).
 * Standalone agents insert before "done".
 * After insertion, all columns are re-ordered to sequential integers.
 */
export function computeOrder(project: ProjectState, stageId: string): number {
  // If it's a pipeline agent, assign its fixed order
  if (stageId in PIPELINE_AGENT_ORDER) {
    return PIPELINE_AGENT_ORDER[stageId];
  }

  // Standalone: insert before "done"
  const doneCol = project.columns.find((c) => c.id === "done");
  if (doneCol) {
    return doneCol.order;
  }

  // No "done" column yet — put it at the end
  return project.columns.length;
}

/**
 * Re-normalize all column order values to clean sequential integers
 * based on the defined ordering rules:
 *   0: ready
 *   1-5: pipeline agents (orchestrator, builder, refactor, reviewer, committer)
 *   6+: standalone agents (alphabetical)
 *   second-to-last: done
 *   last: error
 */
function renormalizeColumnOrders(project: ProjectState): void {
  const ready: ColumnConfig[] = [];
  const pipeline: ColumnConfig[] = [];
  const standalone: ColumnConfig[] = [];
  const done: ColumnConfig[] = [];
  const error: ColumnConfig[] = [];

  for (const col of project.columns) {
    if (col.id === "ready") {
      ready.push(col);
    } else if (col.id === "done") {
      done.push(col);
    } else if (col.id === "error") {
      error.push(col);
    } else if (col.id in PIPELINE_AGENT_ORDER) {
      pipeline.push(col);
    } else {
      standalone.push(col);
    }
  }

  // Sort pipeline agents by their fixed order
  pipeline.sort(
    (a, b) =>
      (PIPELINE_AGENT_ORDER[a.id] ?? 99) -
      (PIPELINE_AGENT_ORDER[b.id] ?? 99)
  );

  // Sort standalone agents alphabetically
  standalone.sort((a, b) => a.id.localeCompare(b.id));

  // Reassemble and assign sequential order values
  const sorted = [...ready, ...pipeline, ...standalone, ...done, ...error];
  for (let i = 0; i < sorted.length; i++) {
    sorted[i].order = i;
  }
  project.columns = sorted;
}

/**
 * Create a new dynamic ColumnConfig for an unknown stage.
 *
 * Returns the new column, or null if:
 * - The stage is a bookend ("ready", "done", "error")
 * - A column with this ID already exists
 */
export function createDynamicColumn(
  project: ProjectState,
  stageId: string
): ColumnConfig | null {
  // Don't create columns for bookend stages
  if (BOOKEND_STAGES.has(stageId)) {
    return null;
  }

  // Don't create duplicates
  if (hasColumn(project, stageId)) {
    return null;
  }

  const isPipelineAgent = stageId in PIPELINE_AGENT_ORDER;

  const column: ColumnConfig = {
    id: stageId,
    label: formatAgentLabel(stageId),
    type: "agent",
    color: pickColor(project, stageId),
    order: computeOrder(project, stageId),
    group: isPipelineAgent ? "pipeline" : "standalone",
    source: "dynamic",
  };

  project.columns.push(column);
  renormalizeColumnOrders(project);

  return column;
}

// --- StateManager ---

export class StateManager {
  private state: DashboardState;
  private persistPath: string;
  private persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private persistDebounceMs: number;

  /**
   * In-memory active agent tracking per project.
   * Keyed by projectPath. The Set contains agent names that are currently active.
   * Serialized as string[] on ProjectState.activeAgents for JSON output.
   */
  private activeAgents: Map<string, Set<string>> = new Map();

  /**
   * In-memory grace-period timers for pipeline column hiding.
   * When pipeline columns transition from visible → should-hide, a 30s timer
   * is started. If pipeline activity resumes, the timer is cancelled.
   * Keyed by projectPath.
   */
  private pipelineHideTimers: Map<
    string,
    ReturnType<typeof setTimeout>
  > = new Map();

  /**
   * Tracks the last visible column key per project to avoid unnecessary broadcasts.
   * Keyed by projectPath. Value is a joined string of visible column IDs.
   */
  private _lastVisibleColumnsKey: Map<string, string> = new Map();

  /** Listeners called after every state mutation (for SSE broadcasting) */
  private listeners: Array<(event: string, data: unknown) => void> = [];

  constructor(
    persistPath: string = new URL(".dashboard-state.json", import.meta.url)
      .pathname,
    persistDebounceMs: number = 500
  ) {
    this.persistPath = persistPath;
    this.persistDebounceMs = persistDebounceMs;
    this.state = { projects: new Map() };
    this.loadFromDisk();
  }

  // --- Public API ---

  /** Subscribe to state change events (for SSE broadcasting) */
  onEvent(listener: (event: string, data: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Get full state snapshot (for GET /api/state and SSE state:full) */
  getState(): DashboardState {
    return this.state;
  }

  /** Serialize state for JSON response */
  toJSON(): { projects: unknown[] } {
    const projects: unknown[] = [];
    for (const [, project] of this.state.projects) {
      const pipelines: unknown[] = [];
      for (const [, pipeline] of project.pipelines) {
        const beads: unknown[] = [];
        for (const [, bead] of pipeline.beads) {
          beads.push(bead);
        }
        pipelines.push({
          id: pipeline.id,
          title: pipeline.title,
          status: pipeline.status,
          currentBeadId: pipeline.currentBeadId,
          beads,
        });
      }
      projects.push({
        projectPath: project.projectPath,
        projectName: project.projectName,
        pluginId: project.pluginId,
        lastHeartbeat: project.lastHeartbeat,
        connected: project.connected,
        pipelines,
        lastBeadSnapshot: project.lastBeadSnapshot,
        columns: project.columns,
        visibleColumns: this.computeVisibleColumns(project),
        activeAgents: Array.from(
          this.activeAgents.get(project.projectPath) || []
        ),
      });
    }
    return { projects };
  }

  // --- Plugin Registration ---

  /** Register a new plugin, creating or re-activating a project entry */
  registerPlugin(
    pluginId: string,
    projectPath: string,
    projectName: string
  ): void {
    let project = this.state.projects.get(projectPath);
    if (project) {
      // Re-connecting: update plugin info, mark connected
      project.pluginId = pluginId;
      project.connected = true;
      project.lastHeartbeat = Date.now();
    } else {
      // New project
      project = {
        projectPath,
        projectName,
        pluginId,
        lastHeartbeat: Date.now(),
        connected: true,
        pipelines: new Map(),
        lastBeadSnapshot: [],
        columns: [],
      };
      this.state.projects.set(projectPath, project);
    }
    // Ensure activeAgents Set exists for this project
    if (!this.activeAgents.has(projectPath)) {
      this.activeAgents.set(projectPath, new Set());
    }
    this.schedulePersist();
  }

  /** Deregister a plugin (mark project as disconnected, but retain state) */
  deregisterPlugin(pluginId: string): ProjectState | null {
    for (const [, project] of this.state.projects) {
      if (project.pluginId === pluginId) {
        project.connected = false;
        // Clear active agents for this project
        const agents = this.activeAgents.get(project.projectPath);
        if (agents) {
          agents.clear();
        }
        // No active session — mark active pipelines as idle
        for (const [, pipeline] of project.pipelines) {
          if (pipeline.status === "active") {
            pipeline.status = "idle";
          }
        }
        this.schedulePersist();
        return project;
      }
    }
    return null;
  }

  /** Remove a project entirely from state (by pluginId). Returns the removed project or null. */
  removeProject(pluginId: string): ProjectState | null {
    for (const [projectPath, project] of this.state.projects) {
      if (project.pluginId === pluginId) {
        this.state.projects.delete(projectPath);
        this.activeAgents.delete(projectPath);
        // Clear any pipeline hide timers for this project
        const timer = this.pipelineHideTimers.get(projectPath);
        if (timer) {
          clearTimeout(timer);
          this.pipelineHideTimers.delete(projectPath);
        }
        this._lastVisibleColumnsKey.delete(projectPath);
        this.schedulePersist();
        return project;
      }
    }
    return null;
  }

  /** Update heartbeat for a plugin */
  updateHeartbeat(pluginId: string): boolean {
    for (const [, project] of this.state.projects) {
      if (project.pluginId === pluginId) {
        project.lastHeartbeat = Date.now();
        return true;
      }
    }
    return false;
  }

  /** Find project by pluginId */
  findProjectByPluginId(pluginId: string): ProjectState | null {
    for (const [, project] of this.state.projects) {
      if (project.pluginId === pluginId) {
        return project;
      }
    }
    return null;
  }

  /** Get the active agents Set for a project (by projectPath) */
  getActiveAgents(projectPath: string): Set<string> {
    let agents = this.activeAgents.get(projectPath);
    if (!agents) {
      agents = new Set();
      this.activeAgents.set(projectPath, agents);
    }
    return agents;
  }

  // --- Column Visibility ---

  /**
   * Check if any bead across all pipelines has a stage matching any of
   * the given stage IDs.
   */
  anyBeadInStages(project: ProjectState, stageIds: Set<string>): boolean {
    for (const [, pipeline] of project.pipelines) {
      for (const [, bead] of pipeline.beads) {
        if (stageIds.has(bead.stage)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Determine whether the pipeline group should be visible, considering
   * active agents, bead stages, and grace period timers.
   *
   * This is a pure read — it does NOT start or cancel timers.
   * Timer management is done in broadcastColumnsUpdate.
   */
  private isPipelineVisible(project: ProjectState): boolean {
    const activeAgents = this.getActiveAgents(project.projectPath);
    const orchestratorActive = activeAgents.has("orchestrator");
    const anyBeadInPipeline = this.anyBeadInStages(project, PIPELINE_STAGE_IDS);

    if (orchestratorActive || anyBeadInPipeline) {
      return true;
    }

    // Check if any pipeline columns actually exist in the project
    const hasPipelineColumns = project.columns.some(
      (col) => col.group === "pipeline"
    );
    if (!hasPipelineColumns) {
      return false;
    }

    // Pipeline should hide — but is a grace period timer running?
    return this.pipelineHideTimers.has(project.projectPath);
  }

  /**
   * Compute the set of visible columns for a project based on:
   * 1. Bookend columns (ready, done, error) are always visible
   * 2. Pipeline group: visible when orchestrator is active OR any bead
   *    occupies a pipeline stage OR grace period timer is running.
   *    Show/hide as a unit.
   * 3. Standalone columns: visible when their agent is active OR any bead
   *    occupies that column's stage.
   *
   * This is a pure read with no side effects (does not start timers).
   * Returns columns sorted by order.
   */
  computeVisibleColumns(project: ProjectState): ColumnConfig[] {
    const activeAgents = this.getActiveAgents(project.projectPath);
    const pipelineVisible = this.isPipelineVisible(project);

    const visible: ColumnConfig[] = [];

    for (const col of project.columns) {
      // 1. Always include bookend columns
      if (ALWAYS_VISIBLE_COLUMNS.has(col.id)) {
        visible.push(col);
        continue;
      }

      // 2. Pipeline group columns — show/hide as a unit
      if (col.group === "pipeline") {
        if (pipelineVisible) {
          visible.push(col);
        }
        continue;
      }

      // 3. Standalone columns — show if agent active OR any bead in that stage
      const agentActive = activeAgents.has(col.id);
      const beadInStage = this.anyBeadInStages(
        project,
        new Set([col.id])
      );
      if (agentActive || beadInStage) {
        visible.push(col);
      }
    }

    // Sort by order
    visible.sort((a, b) => a.order - b.order);
    return visible;
  }

  /**
   * Manage grace period timers for pipeline column hiding.
   *
   * Called by broadcastColumnsUpdate when pipeline state changes.
   * - If pipeline is active: cancel any pending hide timer
   * - If pipeline should hide and was previously visible: start grace timer
   * - If pipeline was never visible: no timer needed
   */
  private managePipelineGracePeriod(project: ProjectState): void {
    const activeAgents = this.getActiveAgents(project.projectPath);
    const projectPath = project.projectPath;
    const orchestratorActive = activeAgents.has("orchestrator");
    const anyBeadInPipeline = this.anyBeadInStages(project, PIPELINE_STAGE_IDS);
    const pipelineShouldBeActive = orchestratorActive || anyBeadInPipeline;

    const existingTimer = this.pipelineHideTimers.get(projectPath);

    if (pipelineShouldBeActive) {
      // Pipeline is active — cancel any pending hide timer
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.pipelineHideTimers.delete(projectPath);
      }
      return;
    }

    // Pipeline should hide — do we need a grace period?
    if (existingTimer) {
      // Timer already running — let it continue
      return;
    }

    // Check if pipeline was previously visible (had a key with pipeline cols)
    const lastKey = this._lastVisibleColumnsKey.get(projectPath) || "";
    const wasPipelineVisible = [...PIPELINE_STAGE_IDS].some((id) =>
      lastKey.split(",").includes(id)
    );

    if (wasPipelineVisible) {
      // Transition from visible → should-hide: start grace period
      const timer = setTimeout(() => {
        this.pipelineHideTimers.delete(projectPath);
        // Clear the last key so managePipelineGracePeriod doesn't
        // think pipeline was previously visible and start another timer.
        this._lastVisibleColumnsKey.delete(projectPath);
        // Grace period elapsed — recompute and broadcast
        this.broadcastColumnsUpdate(project);
      }, PIPELINE_HIDE_GRACE_MS);
      // Don't block process exit
      if (timer && typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
      this.pipelineHideTimers.set(projectPath, timer);
    }
  }

  /**
   * Recompute visible columns for a project and track whether they changed.
   * If the visible set changed, updates the tracking key and notifies listeners.
   * Also manages grace period timers for pipeline column hiding.
   *
   * Returns true if the visible columns changed, false otherwise.
   */
  broadcastColumnsUpdate(project: ProjectState): boolean {
    // Manage grace period timers BEFORE computing visible columns,
    // so that computeVisibleColumns sees the correct timer state.
    this.managePipelineGracePeriod(project);

    const visible = this.computeVisibleColumns(project);
    const newKey = visible.map((c) => c.id).join(",");
    const oldKey = this._lastVisibleColumnsKey.get(project.projectPath) || "";

    if (newKey === oldKey) {
      return false;
    }

    this._lastVisibleColumnsKey.set(project.projectPath, newKey);

    // Notify listeners about column visibility change
    for (const listener of this.listeners) {
      listener("columns:visibility", {
        projectPath: project.projectPath,
        visibleColumns: visible,
      });
    }

    return true;
  }

  // --- Event Processing ---

  /**
   * Process a plugin event and update state accordingly.
   * Returns the enriched event data that should be broadcast to SSE clients.
   */
  processEvent(
    pluginId: string,
    event: string,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } | null {
    const project = this.findProjectByPluginId(pluginId);
    if (!project) return null;

    // Update heartbeat on any event
    project.lastHeartbeat = Date.now();

    const projectPath = project.projectPath;

    switch (event) {
      case "bead:discovered":
        return this.handleBeadDiscovered(project, data);

      case "bead:claimed":
        return this.handleBeadClaimed(project, data);

      case "bead:stage":
        return this.handleBeadStage(project, data);

      case "bead:done":
        return this.handleBeadDone(project, data);

      case "bead:error":
        return this.handleBeadError(project, data);

      case "bead:changed":
        return this.handleBeadChanged(project, data);

      case "bead:removed":
        return this.handleBeadRemoved(project, data);

      case "agent:active":
        return this.handleAgentActive(project, data);

      case "agent:idle":
        return this.handleAgentIdle(project, data);

      case "beads:refreshed":
        return this.handleBeadsRefreshed(project, data);

      case "pipeline:started":
        return this.handlePipelineStarted(project, data);

      case "pipeline:done":
        return this.handlePipelineDone(project, data);

      case "columns:update":
        return this.handleColumnsUpdate(project, data);

      default:
        // Unknown event — pass through with projectPath enrichment
        return {
          event,
          data: { ...data, projectPath },
        };
    }
  }

  // --- Event Handlers ---

  private handleBeadDiscovered(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const beadRecord = data.bead as BeadRecord | undefined;
    if (!beadRecord?.id) {
      return {
        event: "bead:discovered",
        data: { ...data, projectPath: project.projectPath },
      };
    }

    // Ensure there's a default pipeline to hold beads
    const pipeline = this.getOrCreateDefaultPipeline(project);

    // Only add if not already tracked
    if (!pipeline.beads.has(beadRecord.id)) {
      const stage = this.bdStatusToStage(beadRecord.status);
      const beadState: BeadState = {
        id: beadRecord.id,
        title: beadRecord.title,
        description: beadRecord.description || "",
        priority: beadRecord.priority ?? 1,
        issueType: beadRecord.issue_type || "task",
        bdStatus: beadRecord.status,
        stage,
        stageStartedAt: Date.now(),
      };
      pipeline.beads.set(beadRecord.id, beadState);
    }

    // Update snapshot
    this.updateBeadInSnapshot(project, beadRecord);
    this.schedulePersist();

    return {
      event: "bead:discovered",
      data: {
        ...data,
        projectPath: project.projectPath,
        pipelineId: pipeline.id,
      },
    };
  }

  private handleBeadClaimed(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const beadId = (data.beadId as string) || (data.bead as BeadRecord)?.id;
    const beadRecord = data.bead as BeadRecord | undefined;
    const stage = (data.stage as string) || "ready";

    const pipeline = this.getOrCreateDefaultPipeline(project);

    if (beadId) {
      let beadState = pipeline.beads.get(beadId);
      if (beadState) {
        beadState.bdStatus = "in_progress";
        beadState.stage = stage;
        beadState.stageStartedAt = Date.now();
        beadState.claimedAt = Date.now();
      } else if (beadRecord) {
        // Discovered + claimed in same cycle — create it
        beadState = {
          id: beadRecord.id,
          title: beadRecord.title,
          description: beadRecord.description || "",
          priority: beadRecord.priority ?? 1,
          issueType: beadRecord.issue_type || "task",
          bdStatus: "in_progress",
          stage,
          stageStartedAt: Date.now(),
          claimedAt: Date.now(),
        };
        pipeline.beads.set(beadId, beadState);
      }
      pipeline.currentBeadId = beadId;
      pipeline.status = "active";

      // Auto-create column for unknown stages
      createDynamicColumn(project, stage);
    }

    if (beadRecord) {
      this.updateBeadInSnapshot(project, beadRecord);
    }
    this.schedulePersist();

    // Recompute column visibility (bead claimed → stage changed)
    this.broadcastColumnsUpdate(project);

    return {
      event: "bead:claimed",
      data: {
        ...data,
        projectPath: project.projectPath,
        pipelineId: pipeline.id,
      },
    };
  }

  private handleBeadStage(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const beadId = data.beadId as string;
    const stage = data.stage as BeadState["stage"];
    const agentSessionId = data.agentSessionId as string | undefined;

    const pipeline = this.getOrCreateDefaultPipeline(project);

    if (beadId && stage) {
      const beadState = pipeline.beads.get(beadId);
      if (beadState) {
        beadState.stage = stage;
        beadState.stageStartedAt = Date.now();
        if (agentSessionId) {
          beadState.agentSessionId = agentSessionId;
        }
      }

      // Auto-create column for unknown stages
      createDynamicColumn(project, stage);
    }
    this.schedulePersist();

    // Recompute column visibility (bead stage changed)
    this.broadcastColumnsUpdate(project);

    return {
      event: "bead:stage",
      data: {
        ...data,
        projectPath: project.projectPath,
        pipelineId: pipeline.id,
      },
    };
  }

  private handleBeadDone(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const beadId = (data.beadId as string) || (data.bead as BeadRecord)?.id;
    const beadRecord = data.bead as BeadRecord | undefined;

    const pipeline = this.getOrCreateDefaultPipeline(project);

    if (beadId) {
      const beadState = pipeline.beads.get(beadId);
      if (beadState) {
        beadState.bdStatus = "closed";
        beadState.stage = "done";
        beadState.stageStartedAt = Date.now();
        beadState.completedAt = Date.now();
        beadState.agentSessionId = undefined;
        beadState.error = undefined;
      }
      if (pipeline.currentBeadId === beadId) {
        pipeline.currentBeadId = null;
      }
    }

    if (beadRecord) {
      this.updateBeadInSnapshot(project, beadRecord);
    }
    this.schedulePersist();

    // Recompute column visibility (bead done → may affect pipeline visibility)
    this.broadcastColumnsUpdate(project);

    return {
      event: "bead:done",
      data: {
        ...data,
        projectPath: project.projectPath,
        pipelineId: pipeline.id,
      },
    };
  }

  private handleBeadError(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const beadId = (data.beadId as string) || (data.bead as BeadRecord)?.id;
    const beadRecord = data.bead as BeadRecord | undefined;
    const error = data.error as string | undefined;

    const pipeline = this.getOrCreateDefaultPipeline(project);

    if (beadId) {
      const beadState = pipeline.beads.get(beadId);
      if (beadState) {
        beadState.stage = "error";
        beadState.stageStartedAt = Date.now();
        beadState.error = error || "Unknown error";
        if (beadRecord?.status) {
          beadState.bdStatus = beadRecord.status;
        }
      } else if (beadRecord) {
        // Create the bead in error state
        const newBead: BeadState = {
          id: beadRecord.id,
          title: beadRecord.title,
          description: beadRecord.description || "",
          priority: beadRecord.priority ?? 1,
          issueType: beadRecord.issue_type || "task",
          bdStatus: beadRecord.status,
          stage: "error",
          stageStartedAt: Date.now(),
          error: error || "Unknown error",
        };
        pipeline.beads.set(beadId, newBead);
      }
      if (pipeline.currentBeadId === beadId) {
        pipeline.currentBeadId = null;
      }
    }

    if (beadRecord) {
      this.updateBeadInSnapshot(project, beadRecord);
    }
    this.schedulePersist();

    // Recompute column visibility (bead error → may affect column visibility)
    this.broadcastColumnsUpdate(project);

    return {
      event: "bead:error",
      data: {
        ...data,
        projectPath: project.projectPath,
        pipelineId: pipeline.id,
      },
    };
  }

  private handleBeadChanged(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const beadRecord = data.bead as BeadRecord | undefined;
    const pipeline = this.getOrCreateDefaultPipeline(project);

    if (beadRecord?.id) {
      const beadState = pipeline.beads.get(beadRecord.id);
      if (beadState) {
        beadState.bdStatus = beadRecord.status;
        // Update title/description if they changed
        beadState.title = beadRecord.title;
        beadState.description = beadRecord.description || "";
        beadState.priority = beadRecord.priority ?? beadState.priority;
        beadState.issueType = beadRecord.issue_type || beadState.issueType;
      }
      this.updateBeadInSnapshot(project, beadRecord);
    }
    this.schedulePersist();

    return {
      event: "bead:changed",
      data: {
        ...data,
        projectPath: project.projectPath,
        pipelineId: pipeline.id,
      },
    };
  }

  /**
   * Handle beads:refreshed — reconcile stale beads.
   *
   * When the payload includes a `beadIds` array, this is treated as the
   * authoritative set of bead IDs that currently exist in bd. Any beads
   * in the server's persisted state that are NOT in this set are removed.
   * This fixes stale beads that linger after issues are closed/deleted in bd.
   *
   * Returns `removedBeadIds` in the event data so the routes layer can
   * broadcast individual `bead:removed` events to connected frontends.
   */
  private handleBeadsRefreshed(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const removedBeadIds: string[] = [];

    // If beadIds is provided, reconcile: remove any beads not in the set.
    if (Array.isArray(data.beadIds)) {
      const currentIds = new Set(data.beadIds as string[]);

      for (const [, pipeline] of project.pipelines) {
        for (const [beadId] of pipeline.beads) {
          if (!currentIds.has(beadId)) {
            pipeline.beads.delete(beadId);
            if (pipeline.currentBeadId === beadId) {
              pipeline.currentBeadId = null;
            }
            removedBeadIds.push(beadId);
          }
        }
      }

      if (removedBeadIds.length > 0) {
        const removedSet = new Set(removedBeadIds);
        project.lastBeadSnapshot = project.lastBeadSnapshot.filter(
          (b) => !removedSet.has(b.id)
        );
        this.schedulePersist();
      }
    }

    return {
      event: "beads:refreshed",
      data: {
        ...data,
        projectPath: project.projectPath,
        removedBeadIds,
      },
    };
  }

  private handleBeadRemoved(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const beadId = data.beadId as string;
    const pipeline = this.getOrCreateDefaultPipeline(project);

    if (beadId) {
      pipeline.beads.delete(beadId);
      if (pipeline.currentBeadId === beadId) {
        pipeline.currentBeadId = null;
      }
      // Remove from snapshot
      project.lastBeadSnapshot = project.lastBeadSnapshot.filter(
        (b) => b.id !== beadId
      );
    }
    this.schedulePersist();

    // Recompute column visibility (bead removed → may affect column visibility)
    this.broadcastColumnsUpdate(project);

    return {
      event: "bead:removed",
      data: {
        ...data,
        projectPath: project.projectPath,
        pipelineId: pipeline.id,
      },
    };
  }

  private handleAgentActive(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const beadId = data.beadId as string;
    const sessionId = data.sessionId as string;
    const agentName = data.agent as string;
    const pipeline = this.getOrCreateDefaultPipeline(project);

    if (beadId && sessionId) {
      const beadState = pipeline.beads.get(beadId);
      if (beadState) {
        beadState.agentSessionId = sessionId;
      }
    }

    // Track active agent
    if (agentName) {
      let agents = this.activeAgents.get(project.projectPath);
      if (!agents) {
        agents = new Set();
        this.activeAgents.set(project.projectPath, agents);
      }
      agents.add(agentName);

      // Create dynamic column if one doesn't exist for this agent.
      // Built-in agents (Build, Plan, Explore, etc.) don't have .md config
      // files, so they won't have columns from the initial column config.
      if (!hasColumn(project, agentName)) {
        createDynamicColumn(project, agentName);
      }
    }

    // Recompute column visibility (agent became active → may show columns)
    this.broadcastColumnsUpdate(project);

    return {
      event: "agent:active",
      data: {
        ...data,
        projectPath: project.projectPath,
        pipelineId: pipeline.id,
      },
    };
  }

  private handleAgentIdle(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const beadId = data.beadId as string;
    const sessionId = data.sessionId as string;
    const agentName = data.agent as string;
    const pipeline = this.getOrCreateDefaultPipeline(project);

    if (beadId) {
      const beadState = pipeline.beads.get(beadId);
      if (beadState && beadState.agentSessionId === sessionId) {
        beadState.agentSessionId = undefined;
      }
    }

    // Remove agent from active set
    if (agentName) {
      const agents = this.activeAgents.get(project.projectPath);
      if (agents) {
        agents.delete(agentName);
      }
    }

    // Recompute column visibility (agent went idle → may hide columns)
    this.broadcastColumnsUpdate(project);

    return {
      event: "agent:idle",
      data: {
        ...data,
        projectPath: project.projectPath,
        pipelineId: pipeline.id,
      },
    };
  }

  private handlePipelineStarted(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const pipelineId = data.pipelineId as string;
    const title = (data.title as string) || "Pipeline";

    if (pipelineId) {
      let pipeline = project.pipelines.get(pipelineId);
      if (!pipeline) {
        pipeline = {
          id: pipelineId,
          title,
          status: "active",
          currentBeadId: null,
          beads: new Map(),
        };
        project.pipelines.set(pipelineId, pipeline);
      } else {
        pipeline.title = title;
        pipeline.status = "active";
      }
    }
    this.schedulePersist();

    return {
      event: "pipeline:started",
      data: {
        ...data,
        projectPath: project.projectPath,
      },
    };
  }

  private handlePipelineDone(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const pipelineId = data.pipelineId as string;

    if (pipelineId) {
      const pipeline = project.pipelines.get(pipelineId);
      if (pipeline) {
        pipeline.status = "done";
        pipeline.currentBeadId = null;
      }
    }
    this.schedulePersist();

    return {
      event: "pipeline:done",
      data: {
        ...data,
        projectPath: project.projectPath,
      },
    };
  }

  private handleColumnsUpdate(
    project: ProjectState,
    data: Record<string, unknown>
  ): { event: string; data: Record<string, unknown> } {
    const columns = data.columns as ColumnConfig[] | undefined;

    if (Array.isArray(columns)) {
      // Merge strategy: keep dynamic columns that aren't in the new set,
      // replace/update discovered columns with the new ones from the plugin.
      // This prevents losing dynamic columns when a plugin reconnects.
      const existingDynamic = project.columns.filter(
        (col) => col.source === "dynamic"
      );

      // Build a set of IDs from the incoming plugin columns
      const incomingIds = new Set(columns.map((c) => c.id));

      // Keep dynamic columns whose IDs are NOT in the incoming set
      // (if the plugin now includes a column that was previously dynamic,
      //  the plugin's version takes precedence)
      const dynamicToKeep = existingDynamic.filter(
        (col) => !incomingIds.has(col.id)
      );

      // Merge: plugin columns + retained dynamic columns
      project.columns = [...columns, ...dynamicToKeep];

      // Re-normalize order values to account for merged columns
      renormalizeColumnOrders(project);

      this.schedulePersist();
    }

    // Recompute column visibility (columns changed)
    this.broadcastColumnsUpdate(project);

    return {
      event: "columns:update",
      data: {
        ...data,
        projectPath: project.projectPath,
        columns: project.columns,
        visibleColumns: this.computeVisibleColumns(project),
      },
    };
  }

  // --- Helpers ---

  /** Get or create the default pipeline for a project */
  private getOrCreateDefaultPipeline(project: ProjectState): Pipeline {
    // Use the first pipeline if one exists, otherwise create "default"
    if (project.pipelines.size > 0) {
      return project.pipelines.values().next().value!;
    }
    const pipeline: Pipeline = {
      id: "default",
      title: "Pipeline",
      status: "active",
      currentBeadId: null,
      beads: new Map(),
    };
    project.pipelines.set("default", pipeline);
    return pipeline;
  }

  /** Map bd status to a default stage */
  private bdStatusToStage(bdStatus: string): BeadState["stage"] {
    switch (bdStatus) {
      case "in_progress":
        return "ready"; // will be moved to agent column via bead:claimed/bead:stage
      case "closed":
        return "done";
      case "blocked":
        return "error";
      default:
        return "ready";
    }
  }

  /** Update or insert a bead record in the project's snapshot */
  private updateBeadInSnapshot(
    project: ProjectState,
    beadRecord: BeadRecord
  ): void {
    const idx = project.lastBeadSnapshot.findIndex(
      (b) => b.id === beadRecord.id
    );
    if (idx >= 0) {
      project.lastBeadSnapshot[idx] = beadRecord;
    } else {
      project.lastBeadSnapshot.push(beadRecord);
    }
  }

  // --- Disk Persistence ---

  /** Schedule a debounced persist to disk */
  private schedulePersist(): void {
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
    }
    this.persistDebounceTimer = setTimeout(() => {
      this.persistToDisk();
      this.persistDebounceTimer = null;
    }, this.persistDebounceMs);
  }

  /** Force an immediate persist (useful for shutdown) */
  persistNow(): void {
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
      this.persistDebounceTimer = null;
    }
    this.persistToDisk();
  }

  /** Serialize and write state to disk */
  private persistToDisk(): void {
    try {
      const serialized = this.serialize();
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.persistPath, JSON.stringify(serialized, null, 2));
    } catch (err) {
      console.error("[state] Failed to persist state:", err);
    }
  }

  /** Load state from disk (called once at construction) */
  private loadFromDisk(): void {
    try {
      if (!existsSync(this.persistPath)) return;
      const raw = readFileSync(this.persistPath, "utf-8");
      const parsed = JSON.parse(raw) as SerializedDashboardState;
      if (parsed.version !== 1) {
        console.warn(
          `[state] Unknown state version ${parsed.version}, starting fresh`
        );
        return;
      }
      this.state = this.deserialize(parsed);
      // Mark all projects as disconnected on load (plugins will re-register)
      for (const [, project] of this.state.projects) {
        project.connected = false;
        // Initialize empty activeAgents Set for each loaded project
        this.activeAgents.set(project.projectPath, new Set());
        // No session running after restart — mark active pipelines as idle
        for (const [, pipeline] of project.pipelines) {
          if (pipeline.status === "active") {
            pipeline.status = "idle";
          }
        }
      }
      console.log(
        `[state] Loaded state from disk: ${this.state.projects.size} project(s)`
      );
    } catch (err) {
      console.error("[state] Failed to load state from disk:", err);
      this.state = { projects: new Map() };
    }
  }

  /** Serialize state for JSON persistence */
  private serialize(): SerializedDashboardState {
    const projects: [string, SerializedProjectState][] = [];
    for (const [key, project] of this.state.projects) {
      const pipelines: [string, SerializedPipeline][] = [];
      for (const [pKey, pipeline] of project.pipelines) {
        const beads: [string, SerializedBeadState][] = [];
        for (const [bKey, bead] of pipeline.beads) {
          beads.push([bKey, { ...bead }]);
        }
        pipelines.push([
          pKey,
          {
            id: pipeline.id,
            title: pipeline.title,
            status: pipeline.status,
            currentBeadId: pipeline.currentBeadId,
            beads,
          },
        ]);
      }
      projects.push([
        key,
        {
          projectPath: project.projectPath,
          projectName: project.projectName,
          pluginId: project.pluginId,
          lastHeartbeat: project.lastHeartbeat,
          connected: project.connected,
          pipelines,
          lastBeadSnapshot: project.lastBeadSnapshot,
          columns: project.columns,
        },
      ]);
    }
    return {
      version: 1,
      savedAt: Date.now(),
      projects,
    };
  }

  /** Deserialize JSON back into Map-based state */
  private deserialize(data: SerializedDashboardState): DashboardState {
    const projects = new Map<string, ProjectState>();
    for (const [key, sp] of data.projects) {
      const pipelines = new Map<string, Pipeline>();
      for (const [pKey, sPipeline] of sp.pipelines) {
        const beads = new Map<string, BeadState>();
        for (const [bKey, sBead] of sPipeline.beads) {
          beads.set(bKey, { ...sBead });
        }
        pipelines.set(pKey, {
          id: sPipeline.id,
          title: sPipeline.title,
          status: sPipeline.status,
          currentBeadId: sPipeline.currentBeadId,
          beads,
        });
      }
      projects.set(key, {
        projectPath: sp.projectPath,
        projectName: sp.projectName,
        pluginId: sp.pluginId,
        lastHeartbeat: sp.lastHeartbeat,
        connected: sp.connected,
        pipelines,
        lastBeadSnapshot: sp.lastBeadSnapshot || [],
        columns: sp.columns || [],
      });
    }
    return { projects };
  }

  // --- Cleanup ---

  /** Destroy the state manager, flushing pending writes */
  destroy(): void {
    this.persistNow();
    this.listeners = [];
    // Clear all pipeline hide timers
    for (const timer of this.pipelineHideTimers.values()) {
      clearTimeout(timer);
    }
    this.pipelineHideTimers.clear();
    this._lastVisibleColumnsKey.clear();
  }

  /** Reset all state (for testing) */
  clear(): void {
    this.state = { projects: new Map() };
    this.activeAgents.clear();
    // Clear all pipeline hide timers
    for (const timer of this.pipelineHideTimers.values()) {
      clearTimeout(timer);
    }
    this.pipelineHideTimers.clear();
    this._lastVisibleColumnsKey.clear();
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
      this.persistDebounceTimer = null;
    }
  }
}
