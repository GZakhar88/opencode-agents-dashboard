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
    }

    if (beadRecord) {
      this.updateBeadInSnapshot(project, beadRecord);
    }
    this.schedulePersist();

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
    }
    this.schedulePersist();

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
    }

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
      project.columns = columns;
      this.schedulePersist();
    }

    return {
      event: "columns:update",
      data: {
        ...data,
        projectPath: project.projectPath,
        columns: project.columns,
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
  }

  /** Reset all state (for testing) */
  clear(): void {
    this.state = { projects: new Map() };
    this.activeAgents.clear();
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
      this.persistDebounceTimer = null;
    }
  }
}
