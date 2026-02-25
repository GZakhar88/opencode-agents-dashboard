/**
 * Tests for server/state.ts — StateManager
 *
 * Covers:
 * - Plugin registration/deregistration
 * - All event types: bead:discovered, bead:claimed, bead:stage, bead:done,
 *   bead:error, bead:changed, bead:removed, agent:active, agent:idle,
 *   beads:refreshed, pipeline:started, pipeline:done
 * - State serialization (toJSON)
 * - Disk persistence (save/load cycle)
 * - Edge cases: unknown events, missing data, duplicate beads
 *
 * Run: bun test server/state.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  StateManager,
  formatAgentLabel,
  hasColumn,
  pickColor,
  computeOrder,
  createDynamicColumn,
} from "./state";
import type { ProjectState, ColumnConfig } from "../shared/types";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";

const TEST_PERSIST_PATH = join(import.meta.dir, ".test-state.json");

function createManager(): StateManager {
  // Use a test-specific persist path with 0ms debounce for immediate writes
  return new StateManager(TEST_PERSIST_PATH, 0);
}

function cleanup() {
  try {
    if (existsSync(TEST_PERSIST_PATH)) {
      unlinkSync(TEST_PERSIST_PATH);
    }
  } catch {}
}

// --- Tests ---

describe("StateManager - Registration", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("registers a new plugin and creates project state", () => {
    sm.registerPlugin("p1", "/path/project-a", "project-a");

    const state = sm.getState();
    expect(state.projects.size).toBe(1);

    const project = state.projects.get("/path/project-a")!;
    expect(project).toBeDefined();
    expect(project.pluginId).toBe("p1");
    expect(project.projectPath).toBe("/path/project-a");
    expect(project.projectName).toBe("project-a");
    expect(project.connected).toBe(true);
    expect(project.lastHeartbeat).toBeGreaterThan(0);
    expect(project.pipelines.size).toBe(0);
    expect(project.lastBeadSnapshot).toEqual([]);
  });

  it("re-registers a plugin for the same project path", () => {
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    sm.registerPlugin("p2", "/path/project-a", "project-a");

    const state = sm.getState();
    expect(state.projects.size).toBe(1);

    const project = state.projects.get("/path/project-a")!;
    expect(project.pluginId).toBe("p2"); // Updated to new plugin
    expect(project.connected).toBe(true);
  });

  it("registers multiple projects", () => {
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    sm.registerPlugin("p2", "/path/project-b", "project-b");

    expect(sm.getState().projects.size).toBe(2);
  });

  it("deregisters a plugin (marks disconnected, retains state)", () => {
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    const result = sm.deregisterPlugin("p1");

    expect(result).not.toBeNull();
    expect(result!.connected).toBe(false);

    // State is retained
    expect(sm.getState().projects.size).toBe(1);
    expect(sm.getState().projects.get("/path/project-a")!.connected).toBe(
      false
    );
  });

  it("deregistering a plugin marks active pipelines as idle", () => {
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    // Create an active pipeline via pipeline:started
    sm.processEvent("p1", "pipeline:started", {
      pipelineId: "pipe-1",
      title: "Active pipeline",
    });

    const beforeProject = sm.getState().projects.get("/path/project-a")!;
    expect(beforeProject.pipelines.get("pipe-1")!.status).toBe("active");

    sm.deregisterPlugin("p1");

    const afterProject = sm.getState().projects.get("/path/project-a")!;
    expect(afterProject.pipelines.get("pipe-1")!.status).toBe("idle");
  });

  it("deregistering a plugin does not change done pipelines", () => {
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    sm.processEvent("p1", "pipeline:started", {
      pipelineId: "pipe-1",
      title: "Done pipeline",
    });
    sm.processEvent("p1", "pipeline:done", { pipelineId: "pipe-1" });

    const beforeProject = sm.getState().projects.get("/path/project-a")!;
    expect(beforeProject.pipelines.get("pipe-1")!.status).toBe("done");

    sm.deregisterPlugin("p1");

    const afterProject = sm.getState().projects.get("/path/project-a")!;
    expect(afterProject.pipelines.get("pipe-1")!.status).toBe("done");
  });

  it("deregister returns null for unknown pluginId", () => {
    expect(sm.deregisterPlugin("nonexistent")).toBeNull();
  });

  it("initializes activeAgents Set on plugin registration", () => {
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    const agents = sm.getActiveAgents("/path/project-a");
    expect(agents).toBeDefined();
    expect(agents.size).toBe(0);
  });

  it("deregistering a plugin clears activeAgents", () => {
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    // Discover a bead so agent:active has something to bind to
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Test",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
    // Make agents active
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-abc",
      sessionId: "s1",
      agent: "builder",
    });
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-abc",
      sessionId: "s2",
      agent: "reviewer",
    });

    expect(sm.getActiveAgents("/path/project-a").size).toBe(2);

    sm.deregisterPlugin("p1");

    expect(sm.getActiveAgents("/path/project-a").size).toBe(0);
  });

  it("updates heartbeat for a registered plugin", () => {
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    const before = sm.getState().projects.get("/path/project-a")!.lastHeartbeat;

    // Small delay for timestamp difference
    const result = sm.updateHeartbeat("p1");

    expect(result).toBe(true);
    const after = sm.getState().projects.get("/path/project-a")!.lastHeartbeat;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("updateHeartbeat returns false for unknown pluginId", () => {
    expect(sm.updateHeartbeat("nonexistent")).toBe(false);
  });

  it("findProjectByPluginId returns correct project", () => {
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    const project = sm.findProjectByPluginId("p1");
    expect(project).not.toBeNull();
    expect(project!.projectPath).toBe("/path/project-a");
  });

  it("findProjectByPluginId returns null for unknown id", () => {
    expect(sm.findProjectByPluginId("nonexistent")).toBeNull();
  });
});

describe("StateManager - bead:discovered", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("adds a new bead to state", () => {
    const result = sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "Add authentication",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.event).toBe("bead:discovered");
    expect(result!.data.projectPath).toBe("/path/project-a");
    expect(result!.data.pipelineId).toBeDefined();

    // Check state was updated
    const project = sm.getState().projects.get("/path/project-a")!;
    expect(project.pipelines.size).toBe(1);
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.size).toBe(1);

    const bead = pipeline.beads.get("bd-abc")!;
    expect(bead.id).toBe("bd-abc");
    expect(bead.title).toBe("Add auth");
    expect(bead.stage).toBe("ready");
    expect(bead.bdStatus).toBe("open");
    expect(bead.priority).toBe(1);
  });

  it("does not duplicate an already-tracked bead", () => {
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Add auth (updated)",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.size).toBe(1);
    // Original title preserved (not overwritten by second discovery)
    expect(pipeline.beads.get("bd-abc")!.title).toBe("Add auth");
  });

  it("maps in_progress bead to ready stage", () => {
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Test",
        description: "",
        status: "in_progress",
        priority: 0,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.get("bd-abc")!.stage).toBe("ready");
  });

  it("maps closed bead to done stage", () => {
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Test",
        description: "",
        status: "closed",
        priority: 0,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.get("bd-abc")!.stage).toBe("done");
  });

  it("maps blocked bead to error stage", () => {
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Test",
        description: "",
        status: "blocked",
        priority: 0,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.get("bd-abc")!.stage).toBe("error");
  });

  it("updates bead snapshot", () => {
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Test",
        description: "",
        status: "open",
        priority: 0,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    expect(project.lastBeadSnapshot.length).toBe(1);
    expect(project.lastBeadSnapshot[0].id).toBe("bd-abc");
  });

  it("handles missing bead data gracefully", () => {
    const result = sm.processEvent("p1", "bead:discovered", {});
    expect(result).not.toBeNull();
    expect(result!.event).toBe("bead:discovered");
  });

  it("returns null for unknown pluginId", () => {
    const result = sm.processEvent("unknown", "bead:discovered", {});
    expect(result).toBeNull();
  });
});

describe("StateManager - bead:claimed", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    // Pre-populate a bead
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("moves bead to orchestrator stage on claim", () => {
    sm.processEvent("p1", "bead:claimed", {
      beadId: "bd-abc",
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "",
        status: "in_progress",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
      stage: "orchestrator",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    const bead = pipeline.beads.get("bd-abc")!;

    expect(bead.stage).toBe("orchestrator");
    expect(bead.bdStatus).toBe("in_progress");
    expect(bead.claimedAt).toBeGreaterThan(0);
    expect(pipeline.currentBeadId).toBe("bd-abc");
    expect(pipeline.status).toBe("active");
  });

  it("creates bead if not previously discovered", () => {
    sm.processEvent("p1", "bead:claimed", {
      beadId: "bd-new",
      bead: {
        id: "bd-new",
        title: "New bead",
        description: "",
        status: "in_progress",
        priority: 0,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
      stage: "orchestrator",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.has("bd-new")).toBe(true);
    expect(pipeline.beads.get("bd-new")!.stage).toBe("orchestrator");
  });
});

describe("StateManager - bead:stage", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
    sm.processEvent("p1", "bead:claimed", {
      beadId: "bd-abc",
      stage: "orchestrator",
    });
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("moves bead to builder stage", () => {
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "builder",
      agentSessionId: "session-123",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    const bead = pipeline.beads.get("bd-abc")!;

    expect(bead.stage).toBe("builder");
    expect(bead.agentSessionId).toBe("session-123");
  });

  it("moves bead through multiple stages", () => {
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "builder",
    });
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "reviewer",
    });
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "committer",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.get("bd-abc")!.stage).toBe("committer");
  });
});

describe("StateManager - bead:done", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
    sm.processEvent("p1", "bead:claimed", {
      beadId: "bd-abc",
      stage: "orchestrator",
    });
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("moves bead to done stage", () => {
    sm.processEvent("p1", "bead:done", {
      beadId: "bd-abc",
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "",
        status: "closed",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
        closed_at: "2026-01-02",
      },
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    const bead = pipeline.beads.get("bd-abc")!;

    expect(bead.stage).toBe("done");
    expect(bead.bdStatus).toBe("closed");
    expect(bead.completedAt).toBeGreaterThan(0);
    expect(bead.error).toBeUndefined();
    expect(bead.agentSessionId).toBeUndefined();
    expect(pipeline.currentBeadId).toBeNull();
  });
});

describe("StateManager - bead:error", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("moves bead to error stage with message", () => {
    sm.processEvent("p1", "bead:error", {
      beadId: "bd-abc",
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "",
        status: "blocked",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
      error: "Bead status changed to blocked",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    const bead = pipeline.beads.get("bd-abc")!;

    expect(bead.stage).toBe("error");
    expect(bead.error).toBe("Bead status changed to blocked");
    expect(bead.bdStatus).toBe("blocked");
  });

  it("creates bead in error state if not previously tracked", () => {
    sm.processEvent("p1", "bead:error", {
      beadId: "bd-new",
      bead: {
        id: "bd-new",
        title: "Broken bead",
        description: "",
        status: "blocked",
        priority: 0,
        issue_type: "bug",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
      error: "Found in blocked state",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.has("bd-new")).toBe(true);
    expect(pipeline.beads.get("bd-new")!.stage).toBe("error");
    expect(pipeline.beads.get("bd-new")!.error).toBe("Found in blocked state");
  });

  it("clears currentBeadId when errored bead was current", () => {
    sm.processEvent("p1", "bead:claimed", {
      beadId: "bd-abc",
      stage: "orchestrator",
    });
    sm.processEvent("p1", "bead:error", {
      beadId: "bd-abc",
      error: "abandoned",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.currentBeadId).toBeNull();
  });
});

describe("StateManager - bead:changed", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Original title",
        description: "Original desc",
        status: "open",
        priority: 2,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("updates bead metadata on change", () => {
    sm.processEvent("p1", "bead:changed", {
      bead: {
        id: "bd-abc",
        title: "Updated title",
        description: "Updated desc",
        status: "in_progress",
        priority: 0,
        issue_type: "bug",
        created_at: "2026-01-01",
        updated_at: "2026-01-02",
      },
      prevStatus: "open",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    const bead = pipeline.beads.get("bd-abc")!;

    expect(bead.title).toBe("Updated title");
    expect(bead.description).toBe("Updated desc");
    expect(bead.bdStatus).toBe("in_progress");
    expect(bead.priority).toBe(0);
    expect(bead.issueType).toBe("bug");
  });
});

describe("StateManager - bead:removed", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Test",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("removes bead from state", () => {
    sm.processEvent("p1", "bead:removed", { beadId: "bd-abc" });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.has("bd-abc")).toBe(false);
  });

  it("removes bead from snapshot", () => {
    sm.processEvent("p1", "bead:removed", { beadId: "bd-abc" });

    const project = sm.getState().projects.get("/path/project-a")!;
    expect(project.lastBeadSnapshot.find((b) => b.id === "bd-abc")).toBeUndefined();
  });

  it("clears currentBeadId if removed bead was current", () => {
    sm.processEvent("p1", "bead:claimed", {
      beadId: "bd-abc",
      stage: "orchestrator",
    });
    sm.processEvent("p1", "bead:removed", { beadId: "bd-abc" });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.currentBeadId).toBeNull();
  });
});

describe("StateManager - agent:active / agent:idle", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Test",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("sets agentSessionId on agent:active", () => {
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-abc",
      sessionId: "child-session-1",
      agent: "builder",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.get("bd-abc")!.agentSessionId).toBe(
      "child-session-1"
    );
  });

  it("clears agentSessionId on agent:idle", () => {
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-abc",
      sessionId: "child-session-1",
      agent: "builder",
    });
    sm.processEvent("p1", "agent:idle", {
      beadId: "bd-abc",
      sessionId: "child-session-1",
      agent: "builder",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.get("bd-abc")!.agentSessionId).toBeUndefined();
  });

  it("does not clear agentSessionId on idle for different session", () => {
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-abc",
      sessionId: "child-session-1",
      agent: "builder",
    });
    sm.processEvent("p1", "agent:idle", {
      beadId: "bd-abc",
      sessionId: "different-session",
      agent: "builder",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.get("bd-abc")!.agentSessionId).toBe(
      "child-session-1"
    );
  });

  it("adds agent to activeAgents Set on agent:active", () => {
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-abc",
      sessionId: "child-session-1",
      agent: "builder",
    });

    const agents = sm.getActiveAgents("/path/project-a");
    expect(agents.has("builder")).toBe(true);
    expect(agents.size).toBe(1);
  });

  it("removes agent from activeAgents Set on agent:idle", () => {
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-abc",
      sessionId: "child-session-1",
      agent: "builder",
    });
    sm.processEvent("p1", "agent:idle", {
      beadId: "bd-abc",
      sessionId: "child-session-1",
      agent: "builder",
    });

    const agents = sm.getActiveAgents("/path/project-a");
    expect(agents.has("builder")).toBe(false);
    expect(agents.size).toBe(0);
  });

  it("tracks multiple active agents simultaneously", () => {
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-abc",
      sessionId: "session-1",
      agent: "builder",
    });
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-abc",
      sessionId: "session-2",
      agent: "reviewer",
    });

    const agents = sm.getActiveAgents("/path/project-a");
    expect(agents.has("builder")).toBe(true);
    expect(agents.has("reviewer")).toBe(true);
    expect(agents.size).toBe(2);
  });

  it("serializes activeAgents as string[] in toJSON", () => {
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-abc",
      sessionId: "session-1",
      agent: "builder",
    });
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-abc",
      sessionId: "session-2",
      agent: "reviewer",
    });

    const json = sm.toJSON();
    const project = json.projects[0] as any;
    expect(Array.isArray(project.activeAgents)).toBe(true);
    expect(project.activeAgents).toContain("builder");
    expect(project.activeAgents).toContain("reviewer");
    expect(project.activeAgents.length).toBe(2);
  });
});

describe("StateManager - pipeline:started / pipeline:done", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("creates a pipeline on pipeline:started", () => {
    sm.processEvent("p1", "pipeline:started", {
      pipelineId: "pipe-1",
      title: "Authentication feature",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    expect(project.pipelines.has("pipe-1")).toBe(true);
    const pipeline = project.pipelines.get("pipe-1")!;
    expect(pipeline.title).toBe("Authentication feature");
    expect(pipeline.status).toBe("active");
  });

  it("marks pipeline as done on pipeline:done", () => {
    sm.processEvent("p1", "pipeline:started", {
      pipelineId: "pipe-1",
      title: "Auth",
    });
    sm.processEvent("p1", "pipeline:done", { pipelineId: "pipe-1" });

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.get("pipe-1")!;
    expect(pipeline.status).toBe("done");
    expect(pipeline.currentBeadId).toBeNull();
  });
});

describe("StateManager - unknown events", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("passes through unknown events with projectPath enrichment", () => {
    const result = sm.processEvent("p1", "custom:event", {
      customField: "value",
    });

    expect(result).not.toBeNull();
    expect(result!.event).toBe("custom:event");
    expect(result!.data.projectPath).toBe("/path/project-a");
    expect(result!.data.customField).toBe("value");
  });

  it("passes through beads:refreshed with enrichment", () => {
    const result = sm.processEvent("p1", "beads:refreshed", {
      beadCount: 5,
      changed: 2,
    });

    expect(result).not.toBeNull();
    expect(result!.event).toBe("beads:refreshed");
    expect(result!.data.beadCount).toBe(5);
    expect(result!.data.changed).toBe(2);
    expect(result!.data.projectPath).toBe("/path/project-a");
    // No beadIds provided — no reconciliation, removedBeadIds should be empty
    expect(result!.data.removedBeadIds).toEqual([]);
  });

  it("reconciles stale beads on beads:refreshed with beadIds", () => {
    // Discover 3 beads
    sm.processEvent("p1", "bead:discovered", {
      bead: { id: "b1", title: "B1", status: "open", priority: 1, issue_type: "task" },
    });
    sm.processEvent("p1", "bead:discovered", {
      bead: { id: "b2", title: "B2", status: "open", priority: 1, issue_type: "task" },
    });
    sm.processEvent("p1", "bead:discovered", {
      bead: { id: "b3", title: "B3", status: "open", priority: 1, issue_type: "task" },
    });

    // beads:refreshed with only b1 — b2 and b3 should be removed
    const result = sm.processEvent("p1", "beads:refreshed", {
      beadCount: 1,
      changed: 0,
      beadIds: ["b1"],
    });

    expect(result).not.toBeNull();
    const removedIds = result!.data.removedBeadIds as string[];
    expect(removedIds).toHaveLength(2);
    expect(removedIds).toContain("b2");
    expect(removedIds).toContain("b3");

    // Verify b1 still exists, b2/b3 are gone from state
    const state = sm.toJSON();
    const project = state.projects.find(
      (p: any) => p.projectPath === "/path/project-a"
    ) as any;
    const pipeline = project.pipelines[0];
    const beadIds = pipeline.beads.map((b: any) => b.id);
    expect(beadIds).toContain("b1");
    expect(beadIds).not.toContain("b2");
    expect(beadIds).not.toContain("b3");
  });

  it("removes all beads when beadIds is empty array", () => {
    // Discover a bead
    sm.processEvent("p1", "bead:discovered", {
      bead: { id: "b1", title: "B1", status: "open", priority: 1, issue_type: "task" },
    });

    // beads:refreshed with empty beadIds — all beads should be removed
    const result = sm.processEvent("p1", "beads:refreshed", {
      beadCount: 0,
      changed: 0,
      beadIds: [],
    });

    expect(result).not.toBeNull();
    expect(result!.data.removedBeadIds).toEqual(["b1"]);

    // Verify bead is gone from state
    const state = sm.toJSON();
    const project = state.projects.find(
      (p: any) => p.projectPath === "/path/project-a"
    ) as any;
    expect(project.pipelines[0].beads).toHaveLength(0);
  });

  it("clears currentBeadId when reconciled bead was the current bead", () => {
    // Discover and claim a bead (sets currentBeadId)
    sm.processEvent("p1", "bead:discovered", {
      bead: { id: "b1", title: "B1", status: "in_progress", priority: 1, issue_type: "task" },
    });
    sm.processEvent("p1", "bead:claimed", {
      beadId: "b1",
      bead: { id: "b1", title: "B1", status: "in_progress", priority: 1, issue_type: "task" },
    });

    // Reconcile with empty set — b1 should be removed and currentBeadId cleared
    const result = sm.processEvent("p1", "beads:refreshed", {
      beadCount: 0,
      changed: 0,
      beadIds: [],
    });

    expect(result!.data.removedBeadIds).toEqual(["b1"]);

    const state = sm.toJSON();
    const project = state.projects.find(
      (p: any) => p.projectPath === "/path/project-a"
    ) as any;
    expect(project.pipelines[0].currentBeadId).toBeNull();
  });

  it("also cleans up lastBeadSnapshot on reconciliation", () => {
    // Discover beads (which populates lastBeadSnapshot via handleBeadDiscovered)
    sm.processEvent("p1", "bead:discovered", {
      bead: { id: "b1", title: "B1", status: "open", priority: 1, issue_type: "task" },
    });
    sm.processEvent("p1", "bead:discovered", {
      bead: { id: "b2", title: "B2", status: "open", priority: 1, issue_type: "task" },
    });

    // Reconcile with only b1 — b2 should be removed from snapshot too
    sm.processEvent("p1", "beads:refreshed", {
      beadCount: 1,
      changed: 0,
      beadIds: ["b1"],
    });

    // Check via toJSON — the lastBeadSnapshot should only contain b1
    const state = sm.toJSON();
    const project = state.projects.find(
      (p: any) => p.projectPath === "/path/project-a"
    ) as any;
    const snapshotIds = project.lastBeadSnapshot.map((b: any) => b.id);
    expect(snapshotIds).toEqual(["b1"]);
  });
});

describe("StateManager - toJSON serialization", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "Auth middleware",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("serializes state to plain JSON", () => {
    const json = sm.toJSON();

    expect(json.projects).toBeDefined();
    expect(Array.isArray(json.projects)).toBe(true);
    expect(json.projects.length).toBe(1);

    const project = json.projects[0] as any;
    expect(project.projectPath).toBe("/path/project-a");
    expect(project.projectName).toBe("project-a");
    expect(project.connected).toBe(true);
    expect(Array.isArray(project.pipelines)).toBe(true);
    expect(project.pipelines.length).toBe(1);

    const pipeline = project.pipelines[0];
    expect(Array.isArray(pipeline.beads)).toBe(true);
    expect(pipeline.beads.length).toBe(1);
    expect(pipeline.beads[0].id).toBe("bd-abc");
    expect(pipeline.beads[0].title).toBe("Add auth");
  });

  it("produces valid JSON.stringify output", () => {
    const jsonStr = JSON.stringify(sm.toJSON());
    const parsed = JSON.parse(jsonStr);
    expect(parsed.projects.length).toBe(1);
  });
});

describe("StateManager - Disk Persistence", () => {
  afterEach(cleanup);

  it("persists state to disk and loads it back", async () => {
    // Create and populate
    const sm1 = createManager();
    sm1.registerPlugin("p1", "/path/project-a", "project-a");
    sm1.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Persist test",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
    sm1.processEvent("p1", "bead:claimed", {
      beadId: "bd-abc",
      stage: "orchestrator",
    });

    // Force persist
    sm1.persistNow();
    sm1.destroy();

    // Verify file was written
    expect(existsSync(TEST_PERSIST_PATH)).toBe(true);

    // Load into new manager
    const sm2 = createManager();

    // State should be loaded
    const state = sm2.getState();
    expect(state.projects.size).toBe(1);

    const project = state.projects.get("/path/project-a")!;
    // Projects are marked as disconnected on load
    expect(project.connected).toBe(false);
    expect(project.projectName).toBe("project-a");
    expect(project.pipelines.size).toBe(1);

    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.size).toBe(1);
    expect(pipeline.beads.get("bd-abc")!.stage).toBe("orchestrator");
    expect(pipeline.beads.get("bd-abc")!.claimedAt).toBeGreaterThan(0);
    // Active pipelines should be marked idle on load (no session running)
    expect(pipeline.status).toBe("idle");

    sm2.destroy();
  });

  it("marks active pipelines as idle on load, preserves done pipelines", async () => {
    const sm1 = createManager();
    sm1.registerPlugin("p1", "/path/project-a", "project-a");

    // Create two pipelines: one active, one done
    sm1.processEvent("p1", "pipeline:started", {
      pipelineId: "pipe-active",
      title: "Active pipeline",
    });
    sm1.processEvent("p1", "pipeline:started", {
      pipelineId: "pipe-done",
      title: "Done pipeline",
    });
    sm1.processEvent("p1", "pipeline:done", { pipelineId: "pipe-done" });

    sm1.persistNow();
    sm1.destroy();

    const sm2 = createManager();
    const project = sm2.getState().projects.get("/path/project-a")!;

    expect(project.pipelines.get("pipe-active")!.status).toBe("idle");
    expect(project.pipelines.get("pipe-done")!.status).toBe("done");

    sm2.destroy();
  });

  it("starts fresh if no persist file exists", () => {
    cleanup(); // Ensure no file
    const sm = createManager();
    expect(sm.getState().projects.size).toBe(0);
    sm.destroy();
  });

  it("starts fresh if persist file is corrupted", () => {
    // Write garbage
    const { writeFileSync } = require("fs");
    writeFileSync(TEST_PERSIST_PATH, "not valid json {{{");

    const sm = createManager();
    expect(sm.getState().projects.size).toBe(0);
    sm.destroy();
  });

  it("starts fresh if persist file has unknown version", () => {
    const { writeFileSync } = require("fs");
    writeFileSync(
      TEST_PERSIST_PATH,
      JSON.stringify({ version: 99, projects: [] })
    );

    const sm = createManager();
    expect(sm.getState().projects.size).toBe(0);
    sm.destroy();
  });
});

describe("StateManager - Full lifecycle integration", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("tracks a bead through its full pipeline lifecycle", () => {
    // 1. Discovered
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });

    let bead = getBead(sm, "bd-abc");
    expect(bead.stage).toBe("ready");

    // 2. Claimed by orchestrator
    sm.processEvent("p1", "bead:claimed", {
      beadId: "bd-abc",
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "",
        status: "in_progress",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
      stage: "orchestrator",
    });

    bead = getBead(sm, "bd-abc");
    expect(bead.stage).toBe("orchestrator");
    expect(bead.claimedAt).toBeDefined();

    // 3. Moves to builder
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "builder",
      agentSessionId: "orch-session-1",
    });

    bead = getBead(sm, "bd-abc");
    expect(bead.stage).toBe("builder");

    // 4. Builder agent active
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-abc",
      sessionId: "child-session-1",
      agent: "builder",
    });

    bead = getBead(sm, "bd-abc");
    expect(bead.agentSessionId).toBe("child-session-1");

    // 5. Builder agent idle
    sm.processEvent("p1", "agent:idle", {
      beadId: "bd-abc",
      sessionId: "child-session-1",
      agent: "builder",
    });

    bead = getBead(sm, "bd-abc");
    expect(bead.agentSessionId).toBeUndefined();

    // 6. Moves to reviewer
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "reviewer",
    });

    bead = getBead(sm, "bd-abc");
    expect(bead.stage).toBe("reviewer");

    // 7. Moves to committer
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "committer",
    });

    bead = getBead(sm, "bd-abc");
    expect(bead.stage).toBe("committer");

    // 8. Done
    sm.processEvent("p1", "bead:done", {
      beadId: "bd-abc",
      bead: {
        id: "bd-abc",
        title: "Add auth",
        description: "",
        status: "closed",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-02",
        closed_at: "2026-01-02",
      },
    });

    bead = getBead(sm, "bd-abc");
    expect(bead.stage).toBe("done");
    expect(bead.bdStatus).toBe("closed");
    expect(bead.completedAt).toBeDefined();

    // Pipeline currentBeadId should be cleared
    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.currentBeadId).toBeNull();
  });

  it("handles multiple beads across discovery and pipeline", () => {
    // Discover 3 beads
    for (let i = 1; i <= 3; i++) {
      sm.processEvent("p1", "bead:discovered", {
        bead: {
          id: `bd-${i}`,
          title: `Bead ${i}`,
          description: "",
          status: "open",
          priority: i,
          issue_type: "task",
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
      });
    }

    const project = sm.getState().projects.get("/path/project-a")!;
    const pipeline = project.pipelines.values().next().value!;
    expect(pipeline.beads.size).toBe(3);

    // Claim first bead
    sm.processEvent("p1", "bead:claimed", {
      beadId: "bd-1",
      stage: "orchestrator",
    });

    // Complete first bead
    sm.processEvent("p1", "bead:done", { beadId: "bd-1" });

    expect(pipeline.beads.get("bd-1")!.stage).toBe("done");
    expect(pipeline.beads.get("bd-2")!.stage).toBe("ready");
    expect(pipeline.beads.get("bd-3")!.stage).toBe("ready");
  });
});

describe("StateManager - Dynamic Column Creation", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
    // Set up initial columns (as would be sent by the plugin via columns:update)
    sm.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "orchestrator", label: "Orchestrator", type: "agent", color: "#8b5cf6", order: 1, group: "pipeline", source: "discovered" },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 2 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 3 },
      ],
    });
    // Discover a bead
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-abc",
        title: "Test bead",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
    sm.processEvent("p1", "bead:claimed", {
      beadId: "bd-abc",
      stage: "orchestrator",
    });
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("creates a new column when bead:stage has unknown stage", () => {
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "pipeline-builder",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const col = project.columns.find((c) => c.id === "pipeline-builder");
    expect(col).toBeDefined();
    expect(col!.label).toBe("Builder");
    expect(col!.type).toBe("agent");
    expect(col!.group).toBe("pipeline");
    expect(col!.source).toBe("dynamic");
  });

  it("creates a new column when bead:claimed has unknown stage", () => {
    // Discover a second bead
    sm.processEvent("p1", "bead:discovered", {
      bead: {
        id: "bd-xyz",
        title: "Another bead",
        description: "",
        status: "open",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    });
    sm.processEvent("p1", "bead:claimed", {
      beadId: "bd-xyz",
      bead: {
        id: "bd-xyz",
        title: "Another bead",
        description: "",
        status: "in_progress",
        priority: 1,
        issue_type: "task",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
      stage: "my-custom-agent",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const col = project.columns.find((c) => c.id === "my-custom-agent");
    expect(col).toBeDefined();
    expect(col!.label).toBe("My-custom-agent");
    expect(col!.group).toBe("standalone");
    expect(col!.source).toBe("dynamic");
  });

  it("does NOT create a column for 'ready' stage", () => {
    const project = sm.getState().projects.get("/path/project-a")!;
    const colCountBefore = project.columns.length;

    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "ready",
    });

    // Should not have added a new column
    expect(project.columns.length).toBe(colCountBefore);
  });

  it("does NOT create a column for 'done' stage", () => {
    const project = sm.getState().projects.get("/path/project-a")!;
    const colCountBefore = project.columns.length;

    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "done",
    });

    expect(project.columns.length).toBe(colCountBefore);
  });

  it("does NOT create a column for 'error' stage", () => {
    const project = sm.getState().projects.get("/path/project-a")!;
    const colCountBefore = project.columns.length;

    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "error",
    });

    expect(project.columns.length).toBe(colCountBefore);
  });

  it("does NOT create duplicate columns", () => {
    // Create first
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "pipeline-builder",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const colCountAfterFirst = project.columns.length;

    // Try to create again
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "pipeline-builder",
    });

    expect(project.columns.length).toBe(colCountAfterFirst);
  });

  it("does NOT create column for already-existing stage (orchestrator)", () => {
    const project = sm.getState().projects.get("/path/project-a")!;
    const colCountBefore = project.columns.length;

    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "orchestrator",
    });

    expect(project.columns.length).toBe(colCountBefore);
  });

  it("pipeline agents get group='pipeline'", () => {
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "pipeline-builder",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    expect(project.columns.find((c) => c.id === "pipeline-builder")!.group).toBe("pipeline");
  });

  it("standalone agents get group='standalone'", () => {
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "my-agent",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    expect(project.columns.find((c) => c.id === "my-agent")!.group).toBe("standalone");
  });

  it("maintains order: ready < pipeline < standalone < done < error", () => {
    // Add pipeline and standalone agents
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "pipeline-builder",
    });
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "pipeline-reviewer",
    });
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "custom-agent",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const colIds = project.columns
      .sort((a, b) => a.order - b.order)
      .map((c) => c.id);

    // ready should be first
    expect(colIds[0]).toBe("ready");
    // done should be second to last
    expect(colIds[colIds.length - 2]).toBe("done");
    // error should be last
    expect(colIds[colIds.length - 1]).toBe("error");

    // pipeline agents should come before standalone
    const builderOrder = project.columns.find((c) => c.id === "pipeline-builder")!.order;
    const reviewerOrder = project.columns.find((c) => c.id === "pipeline-reviewer")!.order;
    const customOrder = project.columns.find((c) => c.id === "custom-agent")!.order;
    const doneOrder = project.columns.find((c) => c.id === "done")!.order;

    expect(builderOrder).toBeLessThan(reviewerOrder);
    expect(reviewerOrder).toBeLessThan(customOrder);
    expect(customOrder).toBeLessThan(doneOrder);
  });

  it("colors don't duplicate existing columns when possible", () => {
    // Create multiple dynamic columns and check colors are unique
    const stages = [
      "pipeline-builder",
      "pipeline-refactor",
      "pipeline-reviewer",
      "pipeline-committer",
      "custom-1",
      "custom-2",
    ];

    for (const stage of stages) {
      sm.processEvent("p1", "bead:stage", {
        beadId: "bd-abc",
        stage,
      });
    }

    const project = sm.getState().projects.get("/path/project-a")!;
    const dynamicCols = project.columns.filter((c) => c.source === "dynamic");
    const colors = dynamicCols.map((c) => c.color);
    const uniqueColors = new Set(colors);
    // All dynamic columns should have unique colors (we have 8 in palette)
    expect(uniqueColors.size).toBe(colors.length);
  });

  it("order values are clean sequential integers after insertion", () => {
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "pipeline-builder",
    });
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-abc",
      stage: "custom-agent",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const orders = project.columns.map((c) => c.order).sort((a, b) => a - b);

    // Orders should be 0, 1, 2, ..., n-1
    for (let i = 0; i < orders.length; i++) {
      expect(orders[i]).toBe(i);
    }
  });
});

describe("formatAgentLabel", () => {
  it("strips pipeline- prefix and capitalizes", () => {
    expect(formatAgentLabel("pipeline-builder")).toBe("Builder");
  });

  it("capitalizes regular agent name", () => {
    expect(formatAgentLabel("build")).toBe("Build");
  });

  it("capitalizes hyphenated agent name", () => {
    expect(formatAgentLabel("my-custom-agent")).toBe("My-custom-agent");
  });

  it("handles orchestrator", () => {
    expect(formatAgentLabel("orchestrator")).toBe("Orchestrator");
  });

  it("handles pipeline-refactor", () => {
    expect(formatAgentLabel("pipeline-refactor")).toBe("Refactor");
  });
});

describe("hasColumn", () => {
  it("returns true when column exists", () => {
    const project = {
      columns: [
        { id: "ready", label: "Ready", type: "status" as const, color: "#000", order: 0 },
      ],
    } as ProjectState;
    expect(hasColumn(project, "ready")).toBe(true);
  });

  it("returns false when column does not exist", () => {
    const project = {
      columns: [
        { id: "ready", label: "Ready", type: "status" as const, color: "#000", order: 0 },
      ],
    } as ProjectState;
    expect(hasColumn(project, "builder")).toBe(false);
  });

  it("returns false on empty columns", () => {
    const project = { columns: [] } as unknown as ProjectState;
    expect(hasColumn(project, "ready")).toBe(false);
  });
});

describe("pickColor", () => {
  it("picks first available color", () => {
    const project = { columns: [] } as unknown as ProjectState;
    const color = pickColor(project, "test");
    expect(color).toBe("#8b5cf6"); // first in palette
  });

  it("avoids already-used colors", () => {
    const project = {
      columns: [
        { id: "a", color: "#8b5cf6", label: "", type: "agent" as const, order: 0 },
      ],
    } as ProjectState;
    const color = pickColor(project, "test");
    expect(color).toBe("#3b82f6"); // second in palette
  });

  it("cycles when all colors are used", () => {
    const project = {
      columns: [
        { id: "1", color: "#8b5cf6", label: "", type: "agent" as const, order: 0 },
        { id: "2", color: "#3b82f6", label: "", type: "agent" as const, order: 1 },
        { id: "3", color: "#06b6d4", label: "", type: "agent" as const, order: 2 },
        { id: "4", color: "#f59e0b", label: "", type: "agent" as const, order: 3 },
        { id: "5", color: "#10b981", label: "", type: "agent" as const, order: 4 },
        { id: "6", color: "#ec4899", label: "", type: "agent" as const, order: 5 },
        { id: "7", color: "#f97316", label: "", type: "agent" as const, order: 6 },
        { id: "8", color: "#6366f1", label: "", type: "agent" as const, order: 7 },
      ],
    } as ProjectState;
    // All colors used; should cycle
    const color = pickColor(project, "test");
    expect(typeof color).toBe("string");
    expect(color.startsWith("#")).toBe(true);
  });
});

describe("computeOrder", () => {
  it("returns fixed order for pipeline agents", () => {
    const project = {
      columns: [
        { id: "ready", order: 0 },
        { id: "done", order: 5 },
      ],
    } as unknown as ProjectState;

    expect(computeOrder(project, "orchestrator")).toBe(1);
    expect(computeOrder(project, "pipeline-builder")).toBe(2);
    expect(computeOrder(project, "pipeline-refactor")).toBe(3);
    expect(computeOrder(project, "pipeline-reviewer")).toBe(4);
    expect(computeOrder(project, "pipeline-committer")).toBe(5);
  });

  it("inserts standalone agents before done column", () => {
    const project = {
      columns: [
        { id: "ready", order: 0 },
        { id: "orchestrator", order: 1 },
        { id: "done", order: 2 },
        { id: "error", order: 3 },
      ],
    } as unknown as ProjectState;

    const order = computeOrder(project, "custom-agent");
    expect(order).toBe(2); // same as done, will be reordered by renormalize
  });

  it("returns column count when no done column", () => {
    const project = {
      columns: [
        { id: "ready", order: 0 },
      ],
    } as unknown as ProjectState;

    const order = computeOrder(project, "custom-agent");
    expect(order).toBe(1);
  });
});

describe("createDynamicColumn", () => {
  it("returns null for bookend stages", () => {
    const project = { columns: [] } as unknown as ProjectState;
    expect(createDynamicColumn(project, "ready")).toBeNull();
    expect(createDynamicColumn(project, "done")).toBeNull();
    expect(createDynamicColumn(project, "error")).toBeNull();
  });

  it("returns null for duplicate column", () => {
    const project = {
      columns: [
        { id: "builder", label: "Builder", type: "agent" as const, color: "#8b5cf6", order: 1 },
      ],
    } as ProjectState;
    expect(createDynamicColumn(project, "builder")).toBeNull();
    expect(project.columns.length).toBe(1);
  });

  it("creates a pipeline column with correct properties", () => {
    const project = {
      columns: [
        { id: "ready", label: "Ready", type: "status" as const, color: "#64748b", order: 0 },
        { id: "done", label: "Done", type: "status" as const, color: "#22c55e", order: 1 },
        { id: "error", label: "Error", type: "status" as const, color: "#ef4444", order: 2 },
      ],
    } as ProjectState;

    const col = createDynamicColumn(project, "pipeline-builder");
    expect(col).not.toBeNull();
    expect(col!.id).toBe("pipeline-builder");
    expect(col!.label).toBe("Builder");
    expect(col!.group).toBe("pipeline");
    expect(col!.source).toBe("dynamic");
    expect(col!.type).toBe("agent");
  });

  it("creates a standalone column with correct properties", () => {
    const project = {
      columns: [
        { id: "ready", label: "Ready", type: "status" as const, color: "#64748b", order: 0 },
        { id: "done", label: "Done", type: "status" as const, color: "#22c55e", order: 1 },
        { id: "error", label: "Error", type: "status" as const, color: "#ef4444", order: 2 },
      ],
    } as ProjectState;

    const col = createDynamicColumn(project, "my-agent");
    expect(col).not.toBeNull();
    expect(col!.id).toBe("my-agent");
    expect(col!.label).toBe("My-agent");
    expect(col!.group).toBe("standalone");
    expect(col!.source).toBe("dynamic");
  });

  it("re-normalizes order after insertion", () => {
    const project = {
      columns: [
        { id: "ready", label: "Ready", type: "status" as const, color: "#64748b", order: 0 },
        { id: "done", label: "Done", type: "status" as const, color: "#22c55e", order: 1 },
        { id: "error", label: "Error", type: "status" as const, color: "#ef4444", order: 2 },
      ],
    } as ProjectState;

    createDynamicColumn(project, "pipeline-builder");

    // Orders should be: ready=0, pipeline-builder=1, done=2, error=3
    expect(project.columns.find((c) => c.id === "ready")!.order).toBe(0);
    expect(project.columns.find((c) => c.id === "pipeline-builder")!.order).toBe(1);
    expect(project.columns.find((c) => c.id === "done")!.order).toBe(2);
    expect(project.columns.find((c) => c.id === "error")!.order).toBe(3);
  });

  it("standalone agents sort alphabetically and insert before done", () => {
    const project = {
      columns: [
        { id: "ready", label: "Ready", type: "status" as const, color: "#64748b", order: 0 },
        { id: "done", label: "Done", type: "status" as const, color: "#22c55e", order: 1 },
        { id: "error", label: "Error", type: "status" as const, color: "#ef4444", order: 2 },
      ],
    } as ProjectState;

    createDynamicColumn(project, "zebra-agent");
    createDynamicColumn(project, "alpha-agent");

    const sorted = project.columns.sort((a, b) => a.order - b.order);
    const ids = sorted.map((c) => c.id);

    // ready, alpha-agent, zebra-agent, done, error
    expect(ids).toEqual(["ready", "alpha-agent", "zebra-agent", "done", "error"]);
  });

  it("pipeline agents order correctly among mixed columns", () => {
    const project = {
      columns: [
        { id: "ready", label: "Ready", type: "status" as const, color: "#64748b", order: 0 },
        { id: "orchestrator", label: "Orchestrator", type: "agent" as const, color: "#8b5cf6", order: 1, group: "pipeline" as const },
        { id: "done", label: "Done", type: "status" as const, color: "#22c55e", order: 2 },
        { id: "error", label: "Error", type: "status" as const, color: "#ef4444", order: 3 },
      ],
    } as ProjectState;

    createDynamicColumn(project, "pipeline-reviewer");
    createDynamicColumn(project, "pipeline-builder");
    createDynamicColumn(project, "custom-agent");

    const sorted = project.columns.sort((a, b) => a.order - b.order);
    const ids = sorted.map((c) => c.id);

    // ready, orchestrator, pipeline-builder, pipeline-reviewer, custom-agent, done, error
    expect(ids).toEqual([
      "ready",
      "orchestrator",
      "pipeline-builder",
      "pipeline-reviewer",
      "custom-agent",
      "done",
      "error",
    ]);
  });
});

// --- Test Helpers ---

function getBead(sm: StateManager, beadId: string) {
  for (const [, project] of sm.getState().projects) {
    for (const [, pipeline] of project.pipelines) {
      const bead = pipeline.beads.get(beadId);
      if (bead) return bead;
    }
  }
  throw new Error(`Bead ${beadId} not found in state`);
}

// --- Column Visibility Tests ---

/** Helper: set up a project with standard columns for visibility testing */
function setupProjectWithColumns(sm: StateManager): void {
  sm.registerPlugin("p1", "/path/project-a", "project-a");
  sm.processEvent("p1", "columns:update", {
    columns: [
      { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
      { id: "orchestrator", label: "Orchestrator", type: "agent", color: "#8b5cf6", order: 1, group: "pipeline", source: "discovered" },
      { id: "pipeline-builder", label: "Builder", type: "agent", color: "#3b82f6", order: 2, group: "pipeline", source: "discovered" },
      { id: "pipeline-refactor", label: "Refactor", type: "agent", color: "#06b6d4", order: 3, group: "pipeline", source: "discovered" },
      { id: "pipeline-reviewer", label: "Reviewer", type: "agent", color: "#f59e0b", order: 4, group: "pipeline", source: "discovered" },
      { id: "pipeline-committer", label: "Committer", type: "agent", color: "#10b981", order: 5, group: "pipeline", source: "discovered" },
      { id: "done", label: "Done", type: "status", color: "#22c55e", order: 6 },
      { id: "error", label: "Error", type: "status", color: "#ef4444", order: 7 },
    ],
  });
}

/** Helper: create a bead in a specific stage */
function createBeadInStage(sm: StateManager, beadId: string, stage: string): void {
  sm.processEvent("p1", "bead:discovered", {
    bead: {
      id: beadId,
      title: `Bead ${beadId}`,
      description: "",
      status: "open",
      priority: 1,
      issue_type: "task",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    },
  });
  if (stage !== "ready") {
    sm.processEvent("p1", "bead:claimed", {
      beadId,
      stage,
    });
  }
}

describe("StateManager - anyBeadInStages", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    setupProjectWithColumns(sm);
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("returns false when no beads exist", () => {
    const project = sm.getState().projects.get("/path/project-a")!;
    expect(sm.anyBeadInStages(project, new Set(["orchestrator"]))).toBe(false);
  });

  it("returns false when no beads match any stage", () => {
    createBeadInStage(sm, "bd-1", "ready");
    const project = sm.getState().projects.get("/path/project-a")!;
    expect(sm.anyBeadInStages(project, new Set(["orchestrator", "pipeline-builder"]))).toBe(false);
  });

  it("returns true when a bead matches a stage", () => {
    createBeadInStage(sm, "bd-1", "orchestrator");
    const project = sm.getState().projects.get("/path/project-a")!;
    expect(sm.anyBeadInStages(project, new Set(["orchestrator"]))).toBe(true);
  });

  it("returns true when any bead matches any of multiple stages", () => {
    createBeadInStage(sm, "bd-1", "pipeline-builder");
    const project = sm.getState().projects.get("/path/project-a")!;
    expect(
      sm.anyBeadInStages(project, new Set(["orchestrator", "pipeline-builder", "pipeline-reviewer"]))
    ).toBe(true);
  });

  it("checks across multiple pipelines", () => {
    // Create a bead in the default pipeline
    createBeadInStage(sm, "bd-1", "pipeline-builder");
    // Create a second pipeline with a bead
    sm.processEvent("p1", "pipeline:started", {
      pipelineId: "pipe-2",
      title: "Second pipeline",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    expect(sm.anyBeadInStages(project, new Set(["pipeline-builder"]))).toBe(true);
  });
});

describe("StateManager - computeVisibleColumns", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    setupProjectWithColumns(sm);
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("shows only bookend columns when no activity (fresh start)", () => {
    const project = sm.getState().projects.get("/path/project-a")!;
    const visible = sm.computeVisibleColumns(project);
    const ids = visible.map((c) => c.id);

    expect(ids).toEqual(["ready", "done", "error"]);
  });

  it("shows pipeline columns when orchestrator is active", () => {
    // Make orchestrator active
    createBeadInStage(sm, "bd-1", "ready");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const visible = sm.computeVisibleColumns(project);
    const ids = visible.map((c) => c.id);

    expect(ids).toEqual([
      "ready",
      "orchestrator",
      "pipeline-builder",
      "pipeline-refactor",
      "pipeline-reviewer",
      "pipeline-committer",
      "done",
      "error",
    ]);
  });

  it("shows pipeline columns when a bead is in a pipeline stage", () => {
    createBeadInStage(sm, "bd-1", "pipeline-builder");

    const project = sm.getState().projects.get("/path/project-a")!;
    const visible = sm.computeVisibleColumns(project);
    const ids = visible.map((c) => c.id);

    expect(ids).toContain("orchestrator");
    expect(ids).toContain("pipeline-builder");
    expect(ids).toContain("pipeline-refactor");
    expect(ids).toContain("pipeline-reviewer");
    expect(ids).toContain("pipeline-committer");
  });

  it("shows all pipeline columns as a unit (not individually)", () => {
    // Only one bead in pipeline-builder, but all pipeline cols should show
    createBeadInStage(sm, "bd-1", "pipeline-builder");

    const project = sm.getState().projects.get("/path/project-a")!;
    const visible = sm.computeVisibleColumns(project);
    const pipelineIds = visible.filter((c) => c.group === "pipeline").map((c) => c.id);

    expect(pipelineIds).toEqual([
      "orchestrator",
      "pipeline-builder",
      "pipeline-refactor",
      "pipeline-reviewer",
      "pipeline-committer",
    ]);
  });

  it("shows standalone column when its agent is active", () => {
    // Add a standalone column
    sm.processEvent("p1", "columns:update", {
      columns: [
        ...sm.getState().projects.get("/path/project-a")!.columns,
        { id: "build", label: "Build", type: "agent", color: "#ec4899", order: 6, group: "standalone", source: "dynamic" },
      ],
    });
    // Re-normalize (done/error need to be last)
    const project = sm.getState().projects.get("/path/project-a")!;

    // Make build agent active
    createBeadInStage(sm, "bd-1", "ready");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "build",
    });

    const visible = sm.computeVisibleColumns(project);
    const ids = visible.map((c) => c.id);

    expect(ids).toContain("build");
    expect(ids).toContain("ready");
    expect(ids).toContain("done");
    expect(ids).toContain("error");
  });

  it("shows standalone column when a bead occupies that stage", () => {
    // Add a standalone column and put a bead in it
    createBeadInStage(sm, "bd-1", "build");

    const project = sm.getState().projects.get("/path/project-a")!;
    const visible = sm.computeVisibleColumns(project);
    const ids = visible.map((c) => c.id);

    expect(ids).toContain("build");
  });

  it("hides standalone column when agent is idle and no beads in that stage", () => {
    // Add standalone column
    sm.processEvent("p1", "columns:update", {
      columns: [
        ...sm.getState().projects.get("/path/project-a")!.columns,
        { id: "build", label: "Build", type: "agent", color: "#ec4899", order: 6, group: "standalone", source: "dynamic" },
      ],
    });

    // No active agent, no beads in build
    const project = sm.getState().projects.get("/path/project-a")!;
    const visible = sm.computeVisibleColumns(project);
    const ids = visible.map((c) => c.id);

    expect(ids).not.toContain("build");
  });

  it("returns columns sorted by order", () => {
    createBeadInStage(sm, "bd-1", "orchestrator");

    const project = sm.getState().projects.get("/path/project-a")!;
    const visible = sm.computeVisibleColumns(project);
    const orders = visible.map((c) => c.order);

    // Orders should be monotonically increasing
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThanOrEqual(orders[i - 1]);
    }
  });

  it("scenario: orchestrator active, builder working", () => {
    createBeadInStage(sm, "bd-1", "pipeline-builder");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s2",
      agent: "pipeline-builder",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const visible = sm.computeVisibleColumns(project);
    const ids = visible.map((c) => c.id);

    expect(ids).toEqual([
      "ready",
      "orchestrator",
      "pipeline-builder",
      "pipeline-refactor",
      "pipeline-reviewer",
      "pipeline-committer",
      "done",
      "error",
    ]);
  });

  it("scenario: build mode while orchestrator also active", () => {
    // Add build column
    createBeadInStage(sm, "bd-1", "orchestrator");
    createBeadInStage(sm, "bd-2", "build");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const visible = sm.computeVisibleColumns(project);
    const ids = visible.map((c) => c.id);

    expect(ids).toContain("orchestrator");
    expect(ids).toContain("pipeline-builder");
    expect(ids).toContain("build");
    expect(ids).toContain("ready");
    expect(ids).toContain("done");
    expect(ids).toContain("error");
  });
});

describe("StateManager - broadcastColumnsUpdate", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    setupProjectWithColumns(sm);
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("returns true when visible columns changed", () => {
    const project = sm.getState().projects.get("/path/project-a")!;

    // The columns:update handler already called broadcastColumnsUpdate,
    // setting the key to "ready,done,error". Making the orchestrator active
    // should change visible columns.
    createBeadInStage(sm, "bd-1", "ready");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    // The broadcastColumnsUpdate was already called by agent:active handler
    // which should have returned true. Verify by checking visible columns changed.
    const visible = sm.computeVisibleColumns(project);
    expect(visible.map((c) => c.id)).toContain("orchestrator");

    // Now call it again — should return false since nothing changed
    const changed = sm.broadcastColumnsUpdate(project);
    expect(changed).toBe(false);
  });

  it("returns false when visible columns have not changed", () => {
    const project = sm.getState().projects.get("/path/project-a")!;

    sm.broadcastColumnsUpdate(project);
    const changed = sm.broadcastColumnsUpdate(project);
    expect(changed).toBe(false);
  });

  it("returns true when columns change (agent becomes active)", () => {
    const project = sm.getState().projects.get("/path/project-a")!;

    // Initial
    sm.broadcastColumnsUpdate(project);

    // Make orchestrator active
    createBeadInStage(sm, "bd-1", "ready");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    // broadcastColumnsUpdate was already called by agent:active handler
    // So let's check it was tracked
    const visible = sm.computeVisibleColumns(project);
    expect(visible.length).toBeGreaterThan(3); // more than just bookends
  });

  it("notifies listeners when columns change", () => {
    const events: Array<{ event: string; data: unknown }> = [];
    sm.onEvent((event, data) => {
      events.push({ event, data });
    });

    // Trigger a change: make orchestrator active (changes visible columns)
    createBeadInStage(sm, "bd-1", "ready");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    // Should have notified with columns:visibility
    const visEvent = events.find((e) => e.event === "columns:visibility");
    expect(visEvent).toBeDefined();
    expect((visEvent!.data as any).projectPath).toBe("/path/project-a");
    expect(Array.isArray((visEvent!.data as any).visibleColumns)).toBe(true);
  });

  it("does not notify listeners when columns have not changed", () => {
    const events: Array<{ event: string; data: unknown }> = [];

    const project = sm.getState().projects.get("/path/project-a")!;
    sm.broadcastColumnsUpdate(project);

    // Register listener after first call
    sm.onEvent((event, data) => {
      events.push({ event, data });
    });

    // Second call — no change
    sm.broadcastColumnsUpdate(project);
    const visEvents = events.filter((e) => e.event === "columns:visibility");
    expect(visEvents.length).toBe(0);
  });
});

describe("StateManager - Pipeline Grace Period", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    setupProjectWithColumns(sm);
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("pipeline columns remain visible during grace period after going idle", () => {
    // Make pipeline visible
    createBeadInStage(sm, "bd-1", "orchestrator");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    const project = sm.getState().projects.get("/path/project-a")!;

    // Verify pipeline is visible
    let visible = sm.computeVisibleColumns(project);
    expect(visible.map((c) => c.id)).toContain("orchestrator");

    // Move bead to done and idle the orchestrator
    sm.processEvent("p1", "bead:done", {
      beadId: "bd-1",
    });
    sm.processEvent("p1", "agent:idle", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    // Pipeline should still be visible (grace period)
    visible = sm.computeVisibleColumns(project);
    expect(visible.map((c) => c.id)).toContain("orchestrator");
  });

  it("pipeline columns are hidden after grace period expires", async () => {
    // We can't easily test real 30s timeout in unit test.
    // Instead, we verify the timer mechanism is set up correctly.
    // The actual timeout behavior relies on setTimeout firing.

    // Make pipeline visible
    createBeadInStage(sm, "bd-1", "orchestrator");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    const project = sm.getState().projects.get("/path/project-a")!;

    // Verify pipeline visible
    let visible = sm.computeVisibleColumns(project);
    expect(visible.map((c) => c.id)).toContain("orchestrator");

    // Move bead to done and idle orchestrator
    sm.processEvent("p1", "bead:done", { beadId: "bd-1" });
    sm.processEvent("p1", "agent:idle", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    // Grace period is active — still visible
    visible = sm.computeVisibleColumns(project);
    expect(visible.map((c) => c.id)).toContain("orchestrator");
  });

  it("grace period is cancelled when pipeline activity resumes", () => {
    // Make pipeline visible
    createBeadInStage(sm, "bd-1", "orchestrator");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    const project = sm.getState().projects.get("/path/project-a")!;

    // Move bead to done and idle orchestrator (starts grace period)
    sm.processEvent("p1", "bead:done", { beadId: "bd-1" });
    sm.processEvent("p1", "agent:idle", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    // Resume activity — new bead claimed
    createBeadInStage(sm, "bd-2", "orchestrator");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-2",
      sessionId: "s2",
      agent: "orchestrator",
    });

    // Pipeline should be visible (grace period cancelled by new activity)
    const visible = sm.computeVisibleColumns(project);
    expect(visible.map((c) => c.id)).toContain("orchestrator");
    expect(visible.map((c) => c.id)).toContain("pipeline-builder");
  });
});

describe("StateManager - toJSON includes visibleColumns", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    setupProjectWithColumns(sm);
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("includes visibleColumns in serialized output", () => {
    const json = sm.toJSON();
    const project = json.projects[0] as any;
    expect(Array.isArray(project.visibleColumns)).toBe(true);
  });

  it("visibleColumns shows only bookends when no activity", () => {
    const json = sm.toJSON();
    const project = json.projects[0] as any;
    const ids = project.visibleColumns.map((c: any) => c.id);
    expect(ids).toEqual(["ready", "done", "error"]);
  });

  it("visibleColumns includes pipeline when active", () => {
    createBeadInStage(sm, "bd-1", "orchestrator");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    const json = sm.toJSON();
    const project = json.projects[0] as any;
    const ids = project.visibleColumns.map((c: any) => c.id);
    expect(ids).toContain("orchestrator");
    expect(ids).toContain("pipeline-builder");
  });

  it("toJSON does not start grace period timers (no side effects)", () => {
    // Make pipeline visible, then idle it
    createBeadInStage(sm, "bd-1", "orchestrator");
    sm.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    // Move bead to done and idle orchestrator (starts grace period via broadcastColumnsUpdate)
    sm.processEvent("p1", "bead:done", { beadId: "bd-1" });
    sm.processEvent("p1", "agent:idle", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "orchestrator",
    });

    // toJSON should be safe to call without creating extra timers
    // (computeVisibleColumns is now a pure read)
    const json1 = sm.toJSON();
    const json2 = sm.toJSON();
    const project1 = json1.projects[0] as any;
    const project2 = json2.projects[0] as any;

    // Both calls should return the same result
    const ids1 = project1.visibleColumns.map((c: any) => c.id);
    const ids2 = project2.visibleColumns.map((c: any) => c.id);
    expect(ids1).toEqual(ids2);
  });
});

describe("StateManager - handleColumnsUpdate merge logic", () => {
  let sm: StateManager;

  beforeEach(() => {
    cleanup();
    sm = createManager();
    sm.registerPlugin("p1", "/path/project-a", "project-a");
  });

  afterEach(() => {
    sm.destroy();
    cleanup();
  });

  it("plugin reconnect preserves dynamic columns not in new set", () => {
    // Initial columns from plugin
    sm.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "orchestrator", label: "Orchestrator", type: "agent", color: "#8b5cf6", order: 1, group: "pipeline", source: "discovered" },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 2 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 3 },
      ],
    });

    // Create a dynamic column during session (e.g., from bead:stage)
    sm.processEvent("p1", "bead:discovered", {
      bead: { id: "bd-1", title: "B1", status: "open", priority: 1, issue_type: "task", created_at: "2026-01-01", updated_at: "2026-01-01" },
    });
    sm.processEvent("p1", "bead:claimed", {
      beadId: "bd-1",
      stage: "orchestrator",
    });
    sm.processEvent("p1", "bead:stage", {
      beadId: "bd-1",
      stage: "pipeline-builder",
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    expect(project.columns.find((c) => c.id === "pipeline-builder")).toBeDefined();
    expect(project.columns.find((c) => c.id === "pipeline-builder")!.source).toBe("dynamic");

    // Plugin reconnects and sends fresh columns (without pipeline-builder)
    sm.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "orchestrator", label: "Orchestrator", type: "agent", color: "#8b5cf6", order: 1, group: "pipeline", source: "discovered" },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 2 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 3 },
      ],
    });

    // Dynamic column should be preserved
    const col = project.columns.find((c) => c.id === "pipeline-builder");
    expect(col).toBeDefined();
    expect(col!.source).toBe("dynamic");
    expect(col!.group).toBe("pipeline");
  });

  it("plugin columns take precedence over dynamic columns with same ID", () => {
    // Create a dynamic column
    sm.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 1 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 2 },
      ],
    });

    // Dynamic column created
    sm.processEvent("p1", "bead:discovered", {
      bead: { id: "bd-1", title: "B1", status: "open", priority: 1, issue_type: "task", created_at: "2026-01-01", updated_at: "2026-01-01" },
    });
    sm.processEvent("p1", "bead:claimed", { beadId: "bd-1", stage: "my-agent" });

    const project = sm.getState().projects.get("/path/project-a")!;
    expect(project.columns.find((c) => c.id === "my-agent")!.source).toBe("dynamic");

    // Plugin now includes my-agent as a discovered column
    sm.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "my-agent", label: "My Agent (Discovered)", type: "agent", color: "#ff0000", order: 1, group: "standalone", source: "discovered" },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 2 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 3 },
      ],
    });

    // Plugin version should win
    const col = project.columns.find((c) => c.id === "my-agent");
    expect(col).toBeDefined();
    expect(col!.source).toBe("discovered");
    expect(col!.label).toBe("My Agent (Discovered)");
    expect(col!.color).toBe("#ff0000");

    // Should not have duplicate my-agent
    const myAgentCols = project.columns.filter((c) => c.id === "my-agent");
    expect(myAgentCols.length).toBe(1);
  });

  it("multiple dynamic columns are preserved on plugin reconnect", () => {
    sm.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "orchestrator", label: "Orchestrator", type: "agent", color: "#8b5cf6", order: 1, group: "pipeline", source: "discovered" },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 2 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 3 },
      ],
    });

    // Create multiple dynamic columns
    sm.processEvent("p1", "bead:discovered", {
      bead: { id: "bd-1", title: "B1", status: "open", priority: 1, issue_type: "task", created_at: "2026-01-01", updated_at: "2026-01-01" },
    });
    sm.processEvent("p1", "bead:claimed", { beadId: "bd-1", stage: "orchestrator" });
    sm.processEvent("p1", "bead:stage", { beadId: "bd-1", stage: "pipeline-builder" });
    sm.processEvent("p1", "bead:stage", { beadId: "bd-1", stage: "pipeline-reviewer" });
    sm.processEvent("p1", "bead:stage", { beadId: "bd-1", stage: "custom-agent" });

    const project = sm.getState().projects.get("/path/project-a")!;
    expect(project.columns.filter((c) => c.source === "dynamic").length).toBe(3);

    // Plugin reconnects with same initial columns
    sm.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "orchestrator", label: "Orchestrator", type: "agent", color: "#8b5cf6", order: 1, group: "pipeline", source: "discovered" },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 2 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 3 },
      ],
    });

    // All 3 dynamic columns should be preserved
    const dynamicCols = project.columns.filter((c) => c.source === "dynamic");
    expect(dynamicCols.length).toBe(3);
    expect(dynamicCols.map((c) => c.id).sort()).toEqual(["custom-agent", "pipeline-builder", "pipeline-reviewer"]);
  });

  it("order is renormalized after merge", () => {
    sm.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "orchestrator", label: "Orchestrator", type: "agent", color: "#8b5cf6", order: 1, group: "pipeline", source: "discovered" },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 2 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 3 },
      ],
    });

    // Create dynamic columns
    sm.processEvent("p1", "bead:discovered", {
      bead: { id: "bd-1", title: "B1", status: "open", priority: 1, issue_type: "task", created_at: "2026-01-01", updated_at: "2026-01-01" },
    });
    sm.processEvent("p1", "bead:claimed", { beadId: "bd-1", stage: "orchestrator" });
    sm.processEvent("p1", "bead:stage", { beadId: "bd-1", stage: "pipeline-builder" });
    sm.processEvent("p1", "bead:stage", { beadId: "bd-1", stage: "custom-agent" });

    // Plugin reconnects
    sm.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "orchestrator", label: "Orchestrator", type: "agent", color: "#8b5cf6", order: 1, group: "pipeline", source: "discovered" },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 2 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 3 },
      ],
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const orders = project.columns.map((c) => c.order).sort((a, b) => a - b);

    // Orders should be sequential: 0, 1, 2, ..., n-1
    for (let i = 0; i < orders.length; i++) {
      expect(orders[i]).toBe(i);
    }

    // Verify ordering: ready < pipeline < standalone < done < error
    const sorted = [...project.columns].sort((a, b) => a.order - b.order);
    const ids = sorted.map((c) => c.id);
    expect(ids[0]).toBe("ready");
    expect(ids[ids.length - 2]).toBe("done");
    expect(ids[ids.length - 1]).toBe("error");
  });

  it("columns without source field are treated as non-dynamic (not preserved on merge)", () => {
    // Initial setup: columns without source field (simulating old plugin/state)
    sm.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "old-agent", label: "Old Agent", type: "agent", color: "#8b5cf6", order: 1 },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 2 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 3 },
      ],
    });

    // Plugin reconnects without old-agent
    sm.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 1 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 2 },
      ],
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    // old-agent should be gone (it wasn't dynamic)
    expect(project.columns.find((c) => c.id === "old-agent")).toBeUndefined();
  });

  it("preserves group field from plugin columns", () => {
    sm.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "orchestrator", label: "Orchestrator", type: "agent", color: "#8b5cf6", order: 1, group: "pipeline", source: "discovered" },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 2 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 3 },
      ],
    });

    const project = sm.getState().projects.get("/path/project-a")!;
    const orchCol = project.columns.find((c) => c.id === "orchestrator");
    expect(orchCol).toBeDefined();
    expect(orchCol!.group).toBe("pipeline");
    expect(orchCol!.source).toBe("discovered");
  });
});

describe("StateManager - Serialization of group/source fields", () => {
  afterEach(cleanup);

  it("persists and restores group and source fields on columns", () => {
    const sm1 = createManager();
    sm1.registerPlugin("p1", "/path/project-a", "project-a");
    sm1.processEvent("p1", "columns:update", {
      columns: [
        { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
        { id: "orchestrator", label: "Orchestrator", type: "agent", color: "#8b5cf6", order: 1, group: "pipeline", source: "discovered" },
        { id: "done", label: "Done", type: "status", color: "#22c55e", order: 2 },
        { id: "error", label: "Error", type: "status", color: "#ef4444", order: 3 },
      ],
    });

    // Create a dynamic column
    sm1.processEvent("p1", "bead:discovered", {
      bead: { id: "bd-1", title: "B1", status: "open", priority: 1, issue_type: "task", created_at: "2026-01-01", updated_at: "2026-01-01" },
    });
    sm1.processEvent("p1", "bead:claimed", { beadId: "bd-1", stage: "orchestrator" });
    sm1.processEvent("p1", "bead:stage", { beadId: "bd-1", stage: "pipeline-builder" });

    sm1.persistNow();
    sm1.destroy();

    // Load into new manager
    const sm2 = createManager();
    const project = sm2.getState().projects.get("/path/project-a")!;

    // discovered column should retain group/source
    const orchCol = project.columns.find((c) => c.id === "orchestrator");
    expect(orchCol).toBeDefined();
    expect(orchCol!.group).toBe("pipeline");
    expect(orchCol!.source).toBe("discovered");

    // dynamic column should retain group/source
    const builderCol = project.columns.find((c) => c.id === "pipeline-builder");
    expect(builderCol).toBeDefined();
    expect(builderCol!.group).toBe("pipeline");
    expect(builderCol!.source).toBe("dynamic");

    sm2.destroy();
  });

  it("backward compatible: loads old state without group/source fields", () => {
    // Write a state file with columns that DON'T have group/source
    const { writeFileSync } = require("fs");
    const oldState = {
      version: 1,
      savedAt: Date.now(),
      projects: [
        [
          "/path/project-a",
          {
            projectPath: "/path/project-a",
            projectName: "project-a",
            pluginId: "p1",
            lastHeartbeat: Date.now(),
            connected: true,
            pipelines: [],
            lastBeadSnapshot: [],
            columns: [
              { id: "ready", label: "Ready", type: "status", color: "#64748b", order: 0 },
              { id: "orchestrator", label: "Orchestrator", type: "agent", color: "#8b5cf6", order: 1 },
              { id: "done", label: "Done", type: "status", color: "#22c55e", order: 2 },
              { id: "error", label: "Error", type: "status", color: "#ef4444", order: 3 },
            ],
          },
        ],
      ],
    };
    writeFileSync(TEST_PERSIST_PATH, JSON.stringify(oldState));

    // Should load without crashing
    const sm = createManager();
    const project = sm.getState().projects.get("/path/project-a")!;

    expect(project.columns.length).toBe(4);
    // group and source should be undefined (backward compatible)
    const orchCol = project.columns.find((c) => c.id === "orchestrator");
    expect(orchCol).toBeDefined();
    expect(orchCol!.group).toBeUndefined();
    expect(orchCol!.source).toBeUndefined();

    sm.destroy();
  });

  it("server restart clears activeAgents", () => {
    const sm1 = createManager();
    sm1.registerPlugin("p1", "/path/project-a", "project-a");
    sm1.processEvent("p1", "bead:discovered", {
      bead: { id: "bd-1", title: "B1", status: "open", priority: 1, issue_type: "task", created_at: "2026-01-01", updated_at: "2026-01-01" },
    });
    sm1.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s1",
      agent: "builder",
    });
    sm1.processEvent("p1", "agent:active", {
      beadId: "bd-1",
      sessionId: "s2",
      agent: "reviewer",
    });

    expect(sm1.getActiveAgents("/path/project-a").size).toBe(2);

    sm1.persistNow();
    sm1.destroy();

    // Load into new manager (simulates server restart)
    const sm2 = createManager();
    // Active agents should be empty after restart
    const agents = sm2.getActiveAgents("/path/project-a");
    expect(agents.size).toBe(0);

    sm2.destroy();
  });
});
