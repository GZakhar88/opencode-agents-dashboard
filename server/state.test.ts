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
import { StateManager } from "./state";
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

  it("deregister returns null for unknown pluginId", () => {
    expect(sm.deregisterPlugin("nonexistent")).toBeNull();
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
    expect(bead.stage).toBe("backlog");
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

  it("maps in_progress bead to orchestrator stage", () => {
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
    expect(pipeline.beads.get("bd-abc")!.stage).toBe("orchestrator");
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
    expect(bead.stage).toBe("backlog");

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
    expect(pipeline.beads.get("bd-2")!.stage).toBe("backlog");
    expect(pipeline.beads.get("bd-3")!.stage).toBe("backlog");
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
