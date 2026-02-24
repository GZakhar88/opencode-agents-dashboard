/**
 * Tests for src/hooks/useBoardState.ts — boardReducer
 *
 * Tests the pure reducer function directly (no React required).
 * Covers all 13 SSE event types, edge cases, and immutability.
 *
 * Run: bun test src/hooks/useBoardState.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  _boardReducer as boardReducer,
  _initialState as initialState,
} from "./useBoardState";
import type { _BoardAction as BoardAction } from "./useBoardState";
import type {
  DashboardState,
  BeadRecord,
  BeadState,
  Pipeline,
  ProjectState,
} from "../../shared/types";

// ============================================================
// Test Helpers
// ============================================================

function makeBeadRecord(overrides: Partial<BeadRecord> = {}): BeadRecord {
  return {
    id: "bead-1",
    title: "Test Bead",
    description: "A test bead",
    status: "open",
    priority: 2,
    issue_type: "task",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeStateWithBead(
  beadId: string = "bead-1",
  beadOverrides: Partial<BeadState> = {},
  pipelineId: string = "pipe-1",
  projectPath: string = "/test/project",
): DashboardState {
  const beads = new Map<string, BeadState>();
  beads.set(beadId, {
    id: beadId,
    title: "Test Bead",
    description: "A test bead",
    priority: 2,
    issueType: "task",
    bdStatus: "open",
    stage: "ready",
    stageStartedAt: 1000,
    ...beadOverrides,
  });

  const pipelines = new Map<string, Pipeline>();
  pipelines.set(pipelineId, {
    id: pipelineId,
    title: "Pipeline",
    status: "active",
    currentBeadId: null,
    beads,
  });

  const projects = new Map<string, ProjectState>();
  projects.set(projectPath, {
    projectPath,
    projectName: "project",
    pluginId: "plugin-1",
    lastHeartbeat: 1000,
    connected: true,
    pipelines,
    lastBeadSnapshot: [],
    columns: [],
  });

  return { projects };
}

// ============================================================
// Tests
// ============================================================

describe("boardReducer", () => {
  // ----------------------------------------------------------
  // STATE_FULL
  // ----------------------------------------------------------
  describe("STATE_FULL", () => {
    it("deserializes tuple-format state:full payload", () => {
      const payload = {
        version: 1,
        savedAt: Date.now(),
        projects: [
          [
            "/test/project",
            {
              projectPath: "/test/project",
              projectName: "project",
              pluginId: "p1",
              lastHeartbeat: 1000,
              connected: true,
              pipelines: [
                [
                  "pipe-1",
                  {
                    id: "pipe-1",
                    title: "My Pipeline",
                    status: "active",
                    currentBeadId: null,
                    beads: [
                      [
                        "bead-1",
                      {
                        id: "bead-1",
                        title: "Test",
                        description: "",
                        priority: 1,
                        issueType: "task",
                        bdStatus: "open",
                        stage: "ready",
                        stageStartedAt: 1000,
                      },
                      ],
                    ],
                  },
                ],
              ],
              lastBeadSnapshot: [],
            },
          ],
        ],
      };

      const result = boardReducer(initialState, {
        type: "STATE_FULL",
        payload: payload as any,
      });

      expect(result.projects.size).toBe(1);
      const project = result.projects.get("/test/project")!;
      expect(project.projectName).toBe("project");
      expect(project.pipelines.size).toBe(1);
      const pipeline = project.pipelines.get("pipe-1")!;
      expect(pipeline.title).toBe("My Pipeline");
      expect(pipeline.beads.size).toBe(1);
      expect(pipeline.beads.get("bead-1")!.title).toBe("Test");
    });

    it("deserializes object-format state:full payload (from toJSON)", () => {
      const payload = {
        projects: [
          {
            projectPath: "/test/project",
            projectName: "project",
            pluginId: "p1",
            lastHeartbeat: 1000,
            connected: true,
            pipelines: [
              {
                id: "pipe-1",
                title: "Pipeline",
                status: "active",
                currentBeadId: null,
                beads: [
                  {
                    id: "bead-1",
                    title: "Bead One",
                    description: "desc",
                    priority: 2,
                    issueType: "task",
                    bdStatus: "open",
                    stage: "ready",
                    stageStartedAt: 1000,
                  },
                ],
              },
            ],
            lastBeadSnapshot: [],
          },
        ],
      };

      const result = boardReducer(initialState, {
        type: "STATE_FULL",
        payload: payload as any,
      });

      expect(result.projects.size).toBe(1);
      const project = result.projects.get("/test/project")!;
      expect(project.pipelines.size).toBe(1);
      const pipeline = project.pipelines.get("pipe-1")!;
      expect(pipeline.beads.size).toBe(1);
      expect(pipeline.beads.get("bead-1")!.title).toBe("Bead One");
    });

    it("handles empty/invalid payload gracefully", () => {
      const result1 = boardReducer(initialState, {
        type: "STATE_FULL",
        payload: null as any,
      });
      expect(result1.projects.size).toBe(0);

      const result2 = boardReducer(initialState, {
        type: "STATE_FULL",
        payload: { projects: "not-an-array" } as any,
      });
      expect(result2.projects.size).toBe(0);

      const result3 = boardReducer(initialState, {
        type: "STATE_FULL",
        payload: {} as any,
      });
      expect(result3.projects.size).toBe(0);
    });

    it("replaces previous state entirely", () => {
      const existingState = makeStateWithBead("old-bead");
      const payload = {
        projects: [
          {
            projectPath: "/new/project",
            projectName: "new-project",
            pluginId: "p2",
            lastHeartbeat: 2000,
            connected: true,
            pipelines: [],
            lastBeadSnapshot: [],
          },
        ],
      };

      const result = boardReducer(existingState, {
        type: "STATE_FULL",
        payload: payload as any,
      });

      expect(result.projects.has("/test/project")).toBe(false);
      expect(result.projects.has("/new/project")).toBe(true);
    });

    it("defaults connected to true when not explicitly false", () => {
      const payload = {
        projects: [
          {
            projectPath: "/test",
            projectName: "test",
            pluginId: "",
            lastHeartbeat: 0,
            pipelines: [],
            lastBeadSnapshot: [],
            // connected is omitted
          },
        ],
      };

      const result = boardReducer(initialState, {
        type: "STATE_FULL",
        payload: payload as any,
      });

      expect(result.projects.get("/test")!.connected).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // BEAD_DISCOVERED
  // ----------------------------------------------------------
  describe("BEAD_DISCOVERED", () => {
    it("adds a new bead to the pipeline", () => {
      const bead = makeBeadRecord({ id: "new-bead", status: "open" });
      const result = boardReducer(initialState, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead,
          pipelineId: "pipe-1",
        },
      });

      const project = result.projects.get("/test/project")!;
      const pipeline = project.pipelines.get("pipe-1")!;
      expect(pipeline.beads.has("new-bead")).toBe(true);
      const beadState = pipeline.beads.get("new-bead")!;
      expect(beadState.stage).toBe("ready");
      expect(beadState.title).toBe("Test Bead");
    });

    it("does not overwrite an existing bead", () => {
      const existingState = makeStateWithBead("bead-1", {
        title: "Existing",
        stage: "builder",
      });

      const bead = makeBeadRecord({ id: "bead-1", title: "New Title" });
      const result = boardReducer(existingState, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead,
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.beads.get("bead-1")!.title).toBe("Existing");
      expect(pipeline.beads.get("bead-1")!.stage).toBe("builder");
    });

    it("maps in_progress status to ready stage", () => {
      const bead = makeBeadRecord({ id: "bead-ip", status: "in_progress" });
      const result = boardReducer(initialState, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead,
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.beads.get("bead-ip")!.stage).toBe("ready");
    });

    it("maps closed status to done stage", () => {
      const bead = makeBeadRecord({ id: "bead-c", status: "closed" });
      const result = boardReducer(initialState, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead,
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.beads.get("bead-c")!.stage).toBe("done");
    });

    it("maps blocked status to error stage", () => {
      const bead = makeBeadRecord({ id: "bead-b", status: "blocked" });
      const result = boardReducer(initialState, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead,
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.beads.get("bead-b")!.stage).toBe("error");
    });

    it("returns state unchanged when bead record has no id", () => {
      const result = boardReducer(initialState, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead: { ...makeBeadRecord(), id: "" } as any,
        },
      });

      // No project should be created for a bead with no id
      expect(result.projects.size).toBe(0);
    });

    it("creates project and pipeline auto if they don't exist", () => {
      const bead = makeBeadRecord({ id: "bead-1" });
      const result = boardReducer(initialState, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/new/project",
          timestamp: Date.now(),
          bead,
          pipelineId: "auto-pipe",
        },
      });

      expect(result.projects.has("/new/project")).toBe(true);
      const project = result.projects.get("/new/project")!;
      expect(project.projectName).toBe("project");
      expect(project.connected).toBe(true);
      expect(project.pipelines.has("auto-pipe")).toBe(true);
    });

    it("uses default pipeline when no pipelineId specified", () => {
      const bead = makeBeadRecord({ id: "bead-1" });
      const result = boardReducer(initialState, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead,
        },
      });

      const project = result.projects.get("/test/project")!;
      expect(project.pipelines.has("default")).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // BEAD_CLAIMED
  // ----------------------------------------------------------
  describe("BEAD_CLAIMED", () => {
    it("transitions existing bead to orchestrator stage", () => {
      const state = makeStateWithBead("bead-1", { stage: "ready" });
      const result = boardReducer(state, {
        type: "BEAD_CLAIMED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          bead: makeBeadRecord({ id: "bead-1" }),
          stage: "orchestrator",
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      const bead = pipeline.beads.get("bead-1")!;
      expect(bead.stage).toBe("orchestrator");
      expect(bead.bdStatus).toBe("in_progress");
      expect(bead.claimedAt).toBeDefined();
      expect(pipeline.currentBeadId).toBe("bead-1");
      expect(pipeline.status).toBe("active");
    });

    it("creates bead if not previously discovered", () => {
      const state = makeStateWithBead("other-bead");
      const result = boardReducer(state, {
        type: "BEAD_CLAIMED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "new-bead",
          bead: makeBeadRecord({ id: "new-bead", title: "New" }),
          stage: "orchestrator",
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.beads.has("new-bead")).toBe(true);
      const bead = pipeline.beads.get("new-bead")!;
      expect(bead.title).toBe("New");
      expect(bead.stage).toBe("orchestrator");
      expect(bead.bdStatus).toBe("in_progress");
    });

    it("resolves beadId from bead record when beadId is missing", () => {
      const state = makeStateWithBead("bead-1");
      const result = boardReducer(state, {
        type: "BEAD_CLAIMED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "",
          bead: makeBeadRecord({ id: "bead-1" }),
          stage: "orchestrator",
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.beads.get("bead-1")!.stage).toBe("orchestrator");
    });

    it("returns state unchanged when no beadId can be resolved", () => {
      const result = boardReducer(initialState, {
        type: "BEAD_CLAIMED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "",
          bead: { ...makeBeadRecord(), id: "" } as any,
          stage: "orchestrator",
        },
      });

      expect(result.projects.size).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // BEAD_STAGE
  // ----------------------------------------------------------
  describe("BEAD_STAGE", () => {
    it("transitions bead to specified stage", () => {
      const state = makeStateWithBead("bead-1", { stage: "orchestrator" });
      const result = boardReducer(state, {
        type: "BEAD_STAGE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          stage: "builder",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.stage).toBe("builder");
    });

    it("sets agentSessionId when provided", () => {
      const state = makeStateWithBead("bead-1", { stage: "orchestrator" });
      const result = boardReducer(state, {
        type: "BEAD_STAGE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          stage: "builder",
          agentSessionId: "session-123",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.agentSessionId).toBe("session-123");
    });

    it("preserves existing agentSessionId when not provided", () => {
      const state = makeStateWithBead("bead-1", {
        stage: "builder",
        agentSessionId: "old-session",
      });
      const result = boardReducer(state, {
        type: "BEAD_STAGE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          stage: "reviewer",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.agentSessionId).toBe("old-session");
    });

    it("accepts any string as a valid stage (e.g. designer)", () => {
      const state = makeStateWithBead("bead-1", { stage: "orchestrator" });
      const result = boardReducer(state, {
        type: "BEAD_STAGE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          stage: "designer",
          pipelineId: "pipe-1",
        },
      });

      // Stage is now any string — designer is accepted
      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.stage).toBe("designer");
    });

    it("returns state unchanged when beadId is missing", () => {
      const state = makeStateWithBead("bead-1");
      const result = boardReducer(state, {
        type: "BEAD_STAGE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "",
          stage: "builder",
          pipelineId: "pipe-1",
        },
      });

      // Should be the same reference when early-returning
      expect(result).toBe(state);
    });

    it("returns state unchanged when stage is missing", () => {
      const state = makeStateWithBead("bead-1");
      const result = boardReducer(state, {
        type: "BEAD_STAGE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          stage: "" as any,
          pipelineId: "pipe-1",
        },
      });

      expect(result).toBe(state);
    });
  });

  // ----------------------------------------------------------
  // BEAD_DONE
  // ----------------------------------------------------------
  describe("BEAD_DONE", () => {
    it("transitions bead to done stage and clears agent", () => {
      const state = makeStateWithBead(
        "bead-1",
        {
          stage: "committer",
          agentSessionId: "session-1",
          error: "old error",
        },
        "pipe-1",
      );
      // Set currentBeadId
      state.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!.currentBeadId = "bead-1";

      const result = boardReducer(state, {
        type: "BEAD_DONE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          bead: makeBeadRecord({ id: "bead-1", status: "closed" }),
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      const bead = pipeline.beads.get("bead-1")!;
      expect(bead.stage).toBe("done");
      expect(bead.bdStatus).toBe("closed");
      expect(bead.completedAt).toBeDefined();
      expect(bead.agentSessionId).toBeUndefined();
      expect(bead.error).toBeUndefined();
      expect(pipeline.currentBeadId).toBeNull();
    });

    it("does not clear currentBeadId if it's a different bead", () => {
      const state = makeStateWithBead("bead-1", { stage: "builder" });
      state.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!.currentBeadId = "bead-2";

      const result = boardReducer(state, {
        type: "BEAD_DONE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          bead: makeBeadRecord({ id: "bead-1" }),
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.currentBeadId).toBe("bead-2");
    });

    it("does nothing if bead doesn't exist", () => {
      const state = makeStateWithBead("bead-1");
      const result = boardReducer(state, {
        type: "BEAD_DONE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "nonexistent",
          bead: makeBeadRecord({ id: "nonexistent" }),
          pipelineId: "pipe-1",
        },
      });

      // Bead-1 should still be untouched
      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.beads.has("nonexistent")).toBe(false);
      expect(pipeline.beads.get("bead-1")!.stage).toBe("ready");
    });
  });

  // ----------------------------------------------------------
  // BEAD_ERROR
  // ----------------------------------------------------------
  describe("BEAD_ERROR", () => {
    it("transitions bead to error stage with error message", () => {
      const state = makeStateWithBead("bead-1", { stage: "builder" });
      state.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!.currentBeadId = "bead-1";

      const result = boardReducer(state, {
        type: "BEAD_ERROR",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          error: "Build failed",
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      const bead = pipeline.beads.get("bead-1")!;
      expect(bead.stage).toBe("error");
      expect(bead.error).toBe("Build failed");
      expect(pipeline.currentBeadId).toBeNull();
    });

    it("defaults to 'Unknown error' when error message is empty", () => {
      const state = makeStateWithBead("bead-1");
      const result = boardReducer(state, {
        type: "BEAD_ERROR",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          error: "",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.error).toBe("Unknown error");
    });

    it("creates bead in error state if not previously discovered", () => {
      const state = makeStateWithBead("other-bead");
      const result = boardReducer(state, {
        type: "BEAD_ERROR",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "new-bead",
          bead: makeBeadRecord({ id: "new-bead", title: "Error Bead" }),
          error: "Failed",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("new-bead")!;
      expect(bead.stage).toBe("error");
      expect(bead.error).toBe("Failed");
      expect(bead.title).toBe("Error Bead");
    });

    it("updates bdStatus from bead record if provided", () => {
      const state = makeStateWithBead("bead-1", { bdStatus: "in_progress" });
      const result = boardReducer(state, {
        type: "BEAD_ERROR",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          bead: makeBeadRecord({ id: "bead-1", status: "blocked" }),
          error: "Stuck",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.bdStatus).toBe("blocked");
    });
  });

  // ----------------------------------------------------------
  // BEAD_CHANGED
  // ----------------------------------------------------------
  describe("BEAD_CHANGED", () => {
    it("updates bead metadata from bead record", () => {
      const state = makeStateWithBead("bead-1", {
        title: "Old Title",
        description: "old desc",
        priority: 2,
      });

      const result = boardReducer(state, {
        type: "BEAD_CHANGED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead: makeBeadRecord({
            id: "bead-1",
            title: "New Title",
            description: "new desc",
            priority: 0,
            status: "in_progress",
          }),
          prevStatus: "open",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.title).toBe("New Title");
      expect(bead.description).toBe("new desc");
      expect(bead.priority).toBe(0);
      expect(bead.bdStatus).toBe("in_progress");
    });

    it("preserves priority when bead record has nullish priority", () => {
      const state = makeStateWithBead("bead-1", { priority: 3 });

      const record = makeBeadRecord({ id: "bead-1" });
      (record as any).priority = undefined;

      const result = boardReducer(state, {
        type: "BEAD_CHANGED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead: record,
          prevStatus: "open",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.priority).toBe(3);
    });

    it("does nothing for unknown bead", () => {
      const state = makeStateWithBead("bead-1");
      const result = boardReducer(state, {
        type: "BEAD_CHANGED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead: makeBeadRecord({ id: "nonexistent" }),
          prevStatus: "open",
          pipelineId: "pipe-1",
        },
      });

      // Original bead should still be there unchanged
      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.title).toBe("Test Bead");
    });
  });

  // ----------------------------------------------------------
  // BEAD_REMOVED
  // ----------------------------------------------------------
  describe("BEAD_REMOVED", () => {
    it("removes bead from pipeline", () => {
      const state = makeStateWithBead("bead-1");
      const result = boardReducer(state, {
        type: "BEAD_REMOVED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.beads.has("bead-1")).toBe(false);
    });

    it("clears currentBeadId if removed bead was current", () => {
      const state = makeStateWithBead("bead-1");
      state.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!.currentBeadId = "bead-1";

      const result = boardReducer(state, {
        type: "BEAD_REMOVED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.currentBeadId).toBeNull();
    });

    it("returns state unchanged when beadId is empty", () => {
      const result = boardReducer(initialState, {
        type: "BEAD_REMOVED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "",
        },
      });

      expect(result).toBe(initialState);
    });
  });

  // ----------------------------------------------------------
  // PIPELINE_STARTED
  // ----------------------------------------------------------
  describe("PIPELINE_STARTED", () => {
    it("creates a new pipeline", () => {
      const result = boardReducer(initialState, {
        type: "PIPELINE_STARTED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          pipelineId: "pipe-new",
          title: "My Pipeline",
        },
      });

      const project = result.projects.get("/test/project")!;
      const pipeline = project.pipelines.get("pipe-new")!;
      expect(pipeline.title).toBe("My Pipeline");
      expect(pipeline.status).toBe("active");
      expect(pipeline.currentBeadId).toBeNull();
      expect(pipeline.beads.size).toBe(0);
    });

    it("re-activates an existing pipeline and updates title", () => {
      const state = makeStateWithBead("bead-1", {}, "pipe-1");
      state.projects.get("/test/project")!.pipelines.get("pipe-1")!.status =
        "done";

      const result = boardReducer(state, {
        type: "PIPELINE_STARTED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          pipelineId: "pipe-1",
          title: "Restarted Pipeline",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.status).toBe("active");
      expect(pipeline.title).toBe("Restarted Pipeline");
      // Should preserve beads
      expect(pipeline.beads.has("bead-1")).toBe(true);
    });

    it("returns state unchanged when pipelineId is missing", () => {
      const result = boardReducer(initialState, {
        type: "PIPELINE_STARTED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          pipelineId: "",
        },
      });

      expect(result).toBe(initialState);
    });
  });

  // ----------------------------------------------------------
  // PIPELINE_DONE
  // ----------------------------------------------------------
  describe("PIPELINE_DONE", () => {
    it("marks pipeline as done and clears currentBeadId", () => {
      const state = makeStateWithBead("bead-1", {}, "pipe-1");
      state.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!.currentBeadId = "bead-1";

      const result = boardReducer(state, {
        type: "PIPELINE_DONE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          pipelineId: "pipe-1",
        },
      });

      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.status).toBe("done");
      expect(pipeline.currentBeadId).toBeNull();
      // Beads should be preserved
      expect(pipeline.beads.has("bead-1")).toBe(true);
    });

    it("does nothing for unknown pipeline", () => {
      const state = makeStateWithBead("bead-1", {}, "pipe-1");
      const result = boardReducer(state, {
        type: "PIPELINE_DONE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          pipelineId: "nonexistent",
        },
      });

      // pipe-1 should still be active
      const pipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(pipeline.status).toBe("active");
    });

    it("returns state unchanged when pipelineId is missing", () => {
      const result = boardReducer(initialState, {
        type: "PIPELINE_DONE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          pipelineId: "",
        },
      });

      expect(result).toBe(initialState);
    });
  });

  // ----------------------------------------------------------
  // PROJECT_CONNECTED
  // ----------------------------------------------------------
  describe("PROJECT_CONNECTED", () => {
    it("creates a new project when not previously seen", () => {
      const result = boardReducer(initialState, {
        type: "PROJECT_CONNECTED",
        payload: {
          pluginId: "plugin-new",
          projectPath: "/new/project",
          projectName: "new-project",
        },
      });

      expect(result.projects.size).toBe(1);
      const project = result.projects.get("/new/project")!;
      expect(project.projectName).toBe("new-project");
      expect(project.pluginId).toBe("plugin-new");
      expect(project.connected).toBe(true);
      expect(project.lastHeartbeat).toBeGreaterThan(0);
      expect(project.pipelines.size).toBe(0);
      expect(project.lastBeadSnapshot).toEqual([]);
    });

    it("re-activates an existing disconnected project", () => {
      // Start with a disconnected project that has beads
      const state = makeStateWithBead("bead-1", { stage: "builder" });
      state.projects.get("/test/project")!.connected = false;
      state.projects.get("/test/project")!.pluginId = "old-plugin";

      const result = boardReducer(state, {
        type: "PROJECT_CONNECTED",
        payload: {
          pluginId: "new-plugin",
          projectPath: "/test/project",
          projectName: "project",
        },
      });

      const project = result.projects.get("/test/project")!;
      expect(project.connected).toBe(true);
      expect(project.pluginId).toBe("new-plugin");
      expect(project.lastHeartbeat).toBeGreaterThan(0);
      // Pipelines and beads should be preserved
      expect(project.pipelines.size).toBe(1);
      expect(project.pipelines.get("pipe-1")!.beads.has("bead-1")).toBe(true);
      expect(project.pipelines.get("pipe-1")!.beads.get("bead-1")!.stage).toBe(
        "builder",
      );
    });

    it("updates pluginId and lastHeartbeat on reconnect", () => {
      const state = makeStateWithBead("bead-1");
      const oldHeartbeat = state.projects.get("/test/project")!.lastHeartbeat;

      const result = boardReducer(state, {
        type: "PROJECT_CONNECTED",
        payload: {
          pluginId: "updated-plugin",
          projectPath: "/test/project",
          projectName: "project",
        },
      });

      const project = result.projects.get("/test/project")!;
      expect(project.pluginId).toBe("updated-plugin");
      expect(project.lastHeartbeat).toBeGreaterThanOrEqual(oldHeartbeat);
    });

    it("returns state unchanged when projectPath is empty", () => {
      const result = boardReducer(initialState, {
        type: "PROJECT_CONNECTED",
        payload: {
          pluginId: "p1",
          projectPath: "",
          projectName: "test",
        },
      });

      expect(result).toBe(initialState);
    });

    it("derives projectName from path when projectName is empty", () => {
      const result = boardReducer(initialState, {
        type: "PROJECT_CONNECTED",
        payload: {
          pluginId: "p1",
          projectPath: "/users/dev/my-app",
          projectName: "",
        },
      });

      const project = result.projects.get("/users/dev/my-app")!;
      expect(project.projectName).toBe("my-app");
    });

    it("produces new Map references (immutability)", () => {
      const state = makeStateWithBead("bead-1");
      const result = boardReducer(state, {
        type: "PROJECT_CONNECTED",
        payload: {
          pluginId: "new-plugin",
          projectPath: "/test/project",
          projectName: "project",
        },
      });

      // Projects Map should be a new reference
      expect(result.projects).not.toBe(state.projects);
      // Pipelines Map should be a new reference
      const oldPipelines = state.projects.get("/test/project")!.pipelines;
      const newPipelines = result.projects.get("/test/project")!.pipelines;
      expect(newPipelines).not.toBe(oldPipelines);
    });

    it("handles disconnect → connect lifecycle correctly", () => {
      // Start with connected project
      let state = makeStateWithBead("bead-1", { stage: "builder" });
      expect(state.projects.get("/test/project")!.connected).toBe(true);

      // Disconnect
      state = boardReducer(state, {
        type: "PROJECT_DISCONNECTED",
        payload: {
          projectPath: "/test/project",
          pluginId: "plugin-1",
          projectName: "project",
          reason: "heartbeat timeout",
        },
      });
      expect(state.projects.get("/test/project")!.connected).toBe(false);

      // Reconnect
      state = boardReducer(state, {
        type: "PROJECT_CONNECTED",
        payload: {
          pluginId: "plugin-2",
          projectPath: "/test/project",
          projectName: "project",
        },
      });
      const project = state.projects.get("/test/project")!;
      expect(project.connected).toBe(true);
      expect(project.pluginId).toBe("plugin-2");
      // Beads should survive the cycle
      expect(project.pipelines.get("pipe-1")!.beads.has("bead-1")).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // PROJECT_DISCONNECTED
  // ----------------------------------------------------------
  describe("PROJECT_DISCONNECTED", () => {
    it("marks project as disconnected", () => {
      const state = makeStateWithBead("bead-1");
      const result = boardReducer(state, {
        type: "PROJECT_DISCONNECTED",
        payload: {
          projectPath: "/test/project",
          pluginId: "plugin-1",
          projectName: "project",
          reason: "heartbeat timeout",
        },
      });

      const project = result.projects.get("/test/project")!;
      expect(project.connected).toBe(false);
      // Pipelines and beads should be preserved
      expect(project.pipelines.get("pipe-1")!.beads.has("bead-1")).toBe(true);
    });

    it("marks active pipelines as idle on disconnect", () => {
      const state = makeStateWithBead("bead-1");
      // Verify pipeline starts as active
      expect(
        state.projects.get("/test/project")!.pipelines.get("pipe-1")!.status
      ).toBe("active");

      const result = boardReducer(state, {
        type: "PROJECT_DISCONNECTED",
        payload: {
          projectPath: "/test/project",
          pluginId: "plugin-1",
          projectName: "project",
          reason: "heartbeat timeout",
        },
      });

      const pipeline = result.projects.get("/test/project")!.pipelines.get("pipe-1")!;
      expect(pipeline.status).toBe("idle");
      // Beads should still be preserved
      expect(pipeline.beads.has("bead-1")).toBe(true);
    });

    it("preserves done pipeline status on disconnect", () => {
      const state = makeStateWithBead("bead-1");
      // Manually set pipeline to done
      state.projects.get("/test/project")!.pipelines.get("pipe-1")!.status = "done";

      const result = boardReducer(state, {
        type: "PROJECT_DISCONNECTED",
        payload: {
          projectPath: "/test/project",
          pluginId: "plugin-1",
          projectName: "project",
          reason: "heartbeat timeout",
        },
      });

      const pipeline = result.projects.get("/test/project")!.pipelines.get("pipe-1")!;
      expect(pipeline.status).toBe("done");
    });

    it("returns state unchanged for unknown project", () => {
      const result = boardReducer(initialState, {
        type: "PROJECT_DISCONNECTED",
        payload: {
          projectPath: "/unknown",
          pluginId: "p1",
          projectName: "unknown",
          reason: "timeout",
        },
      });

      expect(result).toBe(initialState);
    });

    it("returns state unchanged when projectPath is empty", () => {
      const result = boardReducer(initialState, {
        type: "PROJECT_DISCONNECTED",
        payload: {
          projectPath: "",
          pluginId: "p1",
          projectName: "",
          reason: "timeout",
        },
      });

      expect(result).toBe(initialState);
    });
  });

  // ----------------------------------------------------------
  // AGENT_ACTIVE
  // ----------------------------------------------------------
  describe("AGENT_ACTIVE", () => {
    it("sets agentSessionId on the bead", () => {
      const state = makeStateWithBead("bead-1", { stage: "builder" });
      const result = boardReducer(state, {
        type: "AGENT_ACTIVE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          sessionId: "session-123",
          parentSessionId: "parent-1",
          agent: "builder",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.agentSessionId).toBe("session-123");
    });

    it("returns state unchanged when beadId is missing", () => {
      const result = boardReducer(initialState, {
        type: "AGENT_ACTIVE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "",
          sessionId: "session-123",
          parentSessionId: "parent-1",
          agent: "builder",
        },
      });

      expect(result).toBe(initialState);
    });

    it("returns state unchanged when sessionId is missing", () => {
      const result = boardReducer(initialState, {
        type: "AGENT_ACTIVE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          sessionId: "",
          parentSessionId: "parent-1",
          agent: "builder",
        },
      });

      expect(result).toBe(initialState);
    });
  });

  // ----------------------------------------------------------
  // AGENT_IDLE
  // ----------------------------------------------------------
  describe("AGENT_IDLE", () => {
    it("clears agentSessionId when sessionId matches", () => {
      const state = makeStateWithBead("bead-1", {
        agentSessionId: "session-123",
      });
      const result = boardReducer(state, {
        type: "AGENT_IDLE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          sessionId: "session-123",
          agent: "builder",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.agentSessionId).toBeUndefined();
    });

    it("does not clear agentSessionId when sessionId doesn't match", () => {
      const state = makeStateWithBead("bead-1", {
        agentSessionId: "session-123",
      });
      const result = boardReducer(state, {
        type: "AGENT_IDLE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          sessionId: "different-session",
          agent: "builder",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.agentSessionId).toBe("session-123");
    });

    it("returns state unchanged when beadId is missing", () => {
      const result = boardReducer(initialState, {
        type: "AGENT_IDLE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "",
          sessionId: "session-123",
          agent: "builder",
        },
      });

      expect(result).toBe(initialState);
    });
  });

  // ----------------------------------------------------------
  // Unknown Action
  // ----------------------------------------------------------
  describe("unknown action", () => {
    it("returns state unchanged for unknown action type", () => {
      const result = boardReducer(initialState, {
        type: "UNKNOWN_EVENT" as any,
        payload: {} as any,
      });

      expect(result).toBe(initialState);
    });
  });

  // ----------------------------------------------------------
  // Immutability
  // ----------------------------------------------------------
  describe("immutability", () => {
    it("does not mutate original state on BEAD_DISCOVERED", () => {
      const state = makeStateWithBead("bead-1");
      const originalProject = state.projects.get("/test/project")!;
      const originalPipeline = originalProject.pipelines.get("pipe-1")!;
      const originalBeadsSize = originalPipeline.beads.size;

      boardReducer(state, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead: makeBeadRecord({ id: "bead-2" }),
          pipelineId: "pipe-1",
        },
      });

      // Original state should be untouched
      expect(originalPipeline.beads.size).toBe(originalBeadsSize);
      expect(originalPipeline.beads.has("bead-2")).toBe(false);
    });

    it("returns new Map references on mutation", () => {
      const state = makeStateWithBead("bead-1");
      const result = boardReducer(state, {
        type: "BEAD_CLAIMED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          bead: makeBeadRecord({ id: "bead-1" }),
          stage: "orchestrator",
          pipelineId: "pipe-1",
        },
      });

      // Projects Map should be a new reference
      expect(result.projects).not.toBe(state.projects);

      // Pipeline's beads Map should be a new reference
      const oldPipeline = state.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      const newPipeline = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      expect(newPipeline.beads).not.toBe(oldPipeline.beads);
    });
  });

  // ----------------------------------------------------------
  // Full Lifecycle
  // ----------------------------------------------------------
  describe("full lifecycle", () => {
    it("handles discover → claim → stage → done sequence", () => {
      const bead = makeBeadRecord({ id: "lifecycle-bead", status: "open" });
      let state = initialState;

      // Discover
      state = boardReducer(state, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead,
          pipelineId: "pipe-1",
        },
      });
      expect(
        state.projects
          .get("/test/project")!
          .pipelines.get("pipe-1")!
          .beads.get("lifecycle-bead")!.stage,
      ).toBe("ready");

      // Claim
      state = boardReducer(state, {
        type: "BEAD_CLAIMED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "lifecycle-bead",
          bead,
          stage: "orchestrator",
          pipelineId: "pipe-1",
        },
      });
      expect(
        state.projects
          .get("/test/project")!
          .pipelines.get("pipe-1")!
          .beads.get("lifecycle-bead")!.stage,
      ).toBe("orchestrator");

      // Stage → builder
      state = boardReducer(state, {
        type: "BEAD_STAGE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "lifecycle-bead",
          stage: "builder",
          agentSessionId: "builder-session",
          pipelineId: "pipe-1",
        },
      });
      expect(
        state.projects
          .get("/test/project")!
          .pipelines.get("pipe-1")!
          .beads.get("lifecycle-bead")!.stage,
      ).toBe("builder");

      // Stage → reviewer
      state = boardReducer(state, {
        type: "BEAD_STAGE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "lifecycle-bead",
          stage: "reviewer",
          pipelineId: "pipe-1",
        },
      });
      expect(
        state.projects
          .get("/test/project")!
          .pipelines.get("pipe-1")!
          .beads.get("lifecycle-bead")!.stage,
      ).toBe("reviewer");

      // Done
      state = boardReducer(state, {
        type: "BEAD_DONE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "lifecycle-bead",
          bead: { ...bead, status: "closed" },
          pipelineId: "pipe-1",
        },
      });
      const finalBead = state.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("lifecycle-bead")!;
      expect(finalBead.stage).toBe("done");
      expect(finalBead.bdStatus).toBe("closed");
      expect(finalBead.completedAt).toBeDefined();
    });

    it("handles discover → claim → stage → error sequence", () => {
      const bead = makeBeadRecord({ id: "error-bead", status: "open" });
      let state = initialState;

      // Discover
      state = boardReducer(state, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead,
          pipelineId: "pipe-1",
        },
      });
      expect(
        state.projects
          .get("/test/project")!
          .pipelines.get("pipe-1")!
          .beads.get("error-bead")!.stage,
      ).toBe("ready");

      // Claim
      state = boardReducer(state, {
        type: "BEAD_CLAIMED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "error-bead",
          bead,
          stage: "orchestrator",
          pipelineId: "pipe-1",
        },
      });

      // Stage → builder with active agent
      state = boardReducer(state, {
        type: "BEAD_STAGE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "error-bead",
          stage: "builder",
          agentSessionId: "builder-session",
          pipelineId: "pipe-1",
        },
      });

      // Error — agent timeout during builder stage
      state = boardReducer(state, {
        type: "BEAD_ERROR",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "error-bead",
          error: "agent timeout",
          pipelineId: "pipe-1",
        },
      });

      const errorBead = state.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("error-bead")!;
      expect(errorBead.stage).toBe("error");
      expect(errorBead.error).toBe("agent timeout");
      // Agent session should be preserved (was set before error)
      expect(errorBead.agentSessionId).toBe("builder-session");
    });

    it("handles error from any stage (orchestrator → error)", () => {
      const bead = makeBeadRecord({ id: "orch-err", status: "open" });
      let state = initialState;

      // Discover + Claim
      state = boardReducer(state, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead,
          pipelineId: "pipe-1",
        },
      });
      state = boardReducer(state, {
        type: "BEAD_CLAIMED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "orch-err",
          bead,
          stage: "orchestrator",
          pipelineId: "pipe-1",
        },
      });

      // Error from orchestrator — bead abandoned
      state = boardReducer(state, {
        type: "BEAD_ERROR",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "orch-err",
          error: "abandoned",
          pipelineId: "pipe-1",
        },
      });

      const errBead = state.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("orch-err")!;
      expect(errBead.stage).toBe("error");
      expect(errBead.error).toBe("abandoned");
    });

    it("handles error from committer stage", () => {
      const state = makeStateWithBead("bead-1", {
        stage: "committer",
        agentSessionId: "committer-session",
      });
      state.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!.currentBeadId = "bead-1";

      const result = boardReducer(state, {
        type: "BEAD_ERROR",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          error: "commit hook failed",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.stage).toBe("error");
      expect(bead.error).toBe("commit hook failed");
      // currentBeadId should be cleared on error
      expect(
        result.projects.get("/test/project")!.pipelines.get("pipe-1")!
          .currentBeadId,
      ).toBeNull();
    });

    it("handles blocked bead discovered → appears in error column", () => {
      const bead = makeBeadRecord({
        id: "blocked-bead",
        status: "blocked",
        title: "Blocked Task",
      });

      const state = boardReducer(initialState, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead,
          pipelineId: "pipe-1",
        },
      });

      const beadState = state.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("blocked-bead")!;
      expect(beadState.stage).toBe("error");
      expect(beadState.title).toBe("Blocked Task");
    });

    it("handles error with close reason from bead record", () => {
      const state = makeStateWithBead("bead-1", {
        stage: "reviewer",
        bdStatus: "in_progress",
      });

      const result = boardReducer(state, {
        type: "BEAD_ERROR",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          bead: makeBeadRecord({
            id: "bead-1",
            status: "closed",
            close_reason: "failed_review",
          }),
          error: "Review failed: code quality issues detected",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.stage).toBe("error");
      expect(bead.error).toBe("Review failed: code quality issues detected");
      expect(bead.bdStatus).toBe("closed");
    });

    it("error bead can be moved to any stage via BEAD_STAGE", () => {
      const state = makeStateWithBead("bead-1", {
        stage: "error",
        error: "Something failed",
      });

      // Setting stage to "designer" is now valid (Stage is string)
      const result = boardReducer(state, {
        type: "BEAD_STAGE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          stage: "designer",
          pipelineId: "pipe-1",
        },
      });

      // Should move to designer stage
      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.stage).toBe("designer");
      expect(bead.error).toBe("Something failed");
    });

    it("error bead can be moved back to a valid stage (recovery)", () => {
      const state = makeStateWithBead("bead-1", {
        stage: "error",
        error: "Build failed",
      });

      // A valid BEAD_STAGE can move the bead out of error (retry scenario)
      const result = boardReducer(state, {
        type: "BEAD_STAGE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          stage: "builder",
          agentSessionId: "retry-session",
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.stage).toBe("builder");
      expect(bead.agentSessionId).toBe("retry-session");
      // Error field persists (it's metadata) — it's up to the UI to check stage
      expect(bead.error).toBe("Build failed");
    });

    it("error bead can be completed via BEAD_DONE (resolves error)", () => {
      const state = makeStateWithBead("bead-1", {
        stage: "error",
        error: "Transient failure",
        agentSessionId: "old-session",
      });

      const result = boardReducer(state, {
        type: "BEAD_DONE",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          bead: makeBeadRecord({ id: "bead-1", status: "closed" }),
          pipelineId: "pipe-1",
        },
      });

      const bead = result.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!
        .beads.get("bead-1")!;
      expect(bead.stage).toBe("done");
      expect(bead.error).toBeUndefined();
      expect(bead.agentSessionId).toBeUndefined();
      expect(bead.completedAt).toBeDefined();
    });

    it("multiple beads can be in error state simultaneously", () => {
      let state = initialState;

      // Add two beads
      state = boardReducer(state, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead: makeBeadRecord({ id: "bead-1", status: "open" }),
          pipelineId: "pipe-1",
        },
      });
      state = boardReducer(state, {
        type: "BEAD_DISCOVERED",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          bead: makeBeadRecord({ id: "bead-2", status: "open" }),
          pipelineId: "pipe-1",
        },
      });

      // Error both
      state = boardReducer(state, {
        type: "BEAD_ERROR",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-1",
          error: "Build failed",
          pipelineId: "pipe-1",
        },
      });
      state = boardReducer(state, {
        type: "BEAD_ERROR",
        payload: {
          projectPath: "/test/project",
          timestamp: Date.now(),
          beadId: "bead-2",
          error: "Review timeout",
          pipelineId: "pipe-1",
        },
      });

      const pipeline = state.projects
        .get("/test/project")!
        .pipelines.get("pipe-1")!;
      const bead1 = pipeline.beads.get("bead-1")!;
      const bead2 = pipeline.beads.get("bead-2")!;
      expect(bead1.stage).toBe("error");
      expect(bead1.error).toBe("Build failed");
      expect(bead2.stage).toBe("error");
      expect(bead2.error).toBe("Review timeout");
    });
  });
});
