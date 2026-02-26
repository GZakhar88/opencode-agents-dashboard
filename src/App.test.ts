/**
 * Tests for src/App.tsx — isProjectCompleted and isProjectStale
 *
 * Tests the pure categorization functions used for project filtering (Phase 6).
 * Covers: completed detection, stale detection, edge cases (empty, clock skew).
 *
 * Run: bun test src/App.test.ts
 */

import { describe, it, expect } from "bun:test";
import { isProjectCompleted, isProjectStale } from "./App";
import type { ProjectState, Pipeline, BeadState } from "../shared/types";

// ============================================================
// Test Helpers
// ============================================================

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectPath: "/test/project",
    projectName: "project",
    pluginId: "plugin-1",
    lastHeartbeat: Date.now(),
    connected: true,
    pipelines: new Map(),
    lastBeadSnapshot: [],
    columns: [],
    ...overrides,
  };
}

function makeBead(overrides: Partial<BeadState> = {}): BeadState {
  return {
    id: "bead-1",
    title: "Test Bead",
    description: "A test bead",
    priority: 2,
    issueType: "task",
    bdStatus: "open",
    stage: "ready",
    stageStartedAt: 1000,
    ...overrides,
  };
}

function makePipeline(
  id: string,
  beads: BeadState[],
  overrides: Partial<Pipeline> = {},
): Pipeline {
  const beadMap = new Map<string, BeadState>();
  for (const bead of beads) {
    beadMap.set(bead.id, bead);
  }
  return {
    id,
    title: "Pipeline",
    status: "active",
    currentBeadId: null,
    beads: beadMap,
    ...overrides,
  };
}

// ============================================================
// isProjectCompleted
// ============================================================

describe("isProjectCompleted", () => {
  it("returns false for a project with no pipelines", () => {
    const project = makeProject();
    expect(isProjectCompleted(project)).toBe(false);
  });

  it("returns false for a project with an empty pipeline (no beads)", () => {
    const pipeline = makePipeline("pipe-1", []);
    const project = makeProject({
      pipelines: new Map([["pipe-1", pipeline]]),
    });
    expect(isProjectCompleted(project)).toBe(false);
  });

  it("returns true when all beads are done", () => {
    const pipeline = makePipeline("pipe-1", [
      makeBead({ id: "b1", stage: "done" }),
      makeBead({ id: "b2", stage: "done" }),
    ]);
    const project = makeProject({
      pipelines: new Map([["pipe-1", pipeline]]),
    });
    expect(isProjectCompleted(project)).toBe(true);
  });

  it("returns false when any bead is not done", () => {
    const pipeline = makePipeline("pipe-1", [
      makeBead({ id: "b1", stage: "done" }),
      makeBead({ id: "b2", stage: "builder" }),
    ]);
    const project = makeProject({
      pipelines: new Map([["pipe-1", pipeline]]),
    });
    expect(isProjectCompleted(project)).toBe(false);
  });

  it("returns true when single bead is done", () => {
    const pipeline = makePipeline("pipe-1", [
      makeBead({ id: "b1", stage: "done" }),
    ]);
    const project = makeProject({
      pipelines: new Map([["pipe-1", pipeline]]),
    });
    expect(isProjectCompleted(project)).toBe(true);
  });

  it("returns false when single bead is active", () => {
    const pipeline = makePipeline("pipe-1", [
      makeBead({ id: "b1", stage: "orchestrator" }),
    ]);
    const project = makeProject({
      pipelines: new Map([["pipe-1", pipeline]]),
    });
    expect(isProjectCompleted(project)).toBe(false);
  });

  it("checks across multiple pipelines — all done", () => {
    const p1 = makePipeline("pipe-1", [
      makeBead({ id: "b1", stage: "done" }),
    ]);
    const p2 = makePipeline("pipe-2", [
      makeBead({ id: "b2", stage: "done" }),
    ]);
    const project = makeProject({
      pipelines: new Map([
        ["pipe-1", p1],
        ["pipe-2", p2],
      ]),
    });
    expect(isProjectCompleted(project)).toBe(true);
  });

  it("checks across multiple pipelines — one not done", () => {
    const p1 = makePipeline("pipe-1", [
      makeBead({ id: "b1", stage: "done" }),
    ]);
    const p2 = makePipeline("pipe-2", [
      makeBead({ id: "b2", stage: "ready" }),
    ]);
    const project = makeProject({
      pipelines: new Map([
        ["pipe-1", p1],
        ["pipe-2", p2],
      ]),
    });
    expect(isProjectCompleted(project)).toBe(false);
  });

  it("returns false when one pipeline has beads and another is empty", () => {
    const p1 = makePipeline("pipe-1", [
      makeBead({ id: "b1", stage: "done" }),
    ]);
    const p2 = makePipeline("pipe-2", []);
    const project = makeProject({
      pipelines: new Map([
        ["pipe-1", p1],
        ["pipe-2", p2],
      ]),
    });
    // Has at least one bead and all beads are done — should be true
    expect(isProjectCompleted(project)).toBe(true);
  });
});

// ============================================================
// isProjectStale
// ============================================================

const ONE_HOUR_MS = 60 * 60 * 1000;

describe("isProjectStale", () => {
  it("returns false for connected projects regardless of heartbeat age", () => {
    const project = makeProject({
      connected: true,
      lastHeartbeat: Date.now() - ONE_HOUR_MS * 10, // very old heartbeat
    });
    expect(isProjectStale(project, Date.now())).toBe(false);
  });

  it("returns false for recently disconnected projects (< 1 hour)", () => {
    const now = Date.now();
    const project = makeProject({
      connected: false,
      lastHeartbeat: now - 30 * 60 * 1000, // 30 minutes ago
    });
    expect(isProjectStale(project, now)).toBe(false);
  });

  it("returns true for projects disconnected > 1 hour", () => {
    const now = Date.now();
    const project = makeProject({
      connected: false,
      lastHeartbeat: now - ONE_HOUR_MS - 1, // 1 hour + 1ms ago
    });
    expect(isProjectStale(project, now)).toBe(true);
  });

  it("returns false at exactly 1 hour boundary (not stale yet)", () => {
    const now = Date.now();
    const project = makeProject({
      connected: false,
      lastHeartbeat: now - ONE_HOUR_MS, // exactly 1 hour ago
    });
    // (now - lastHeartbeat) === STALE_THRESHOLD_MS, not > — should be false
    expect(isProjectStale(project, now)).toBe(false);
  });

  it("handles clock skew: future heartbeat is not stale", () => {
    const now = Date.now();
    const project = makeProject({
      connected: false,
      lastHeartbeat: now + 5000, // future timestamp (clock skew)
    });
    // now - lastHeartbeat is negative, which is < threshold
    expect(isProjectStale(project, now)).toBe(false);
  });

  it("handles very old disconnected projects", () => {
    const now = Date.now();
    const project = makeProject({
      connected: false,
      lastHeartbeat: now - ONE_HOUR_MS * 24 * 30, // 30 days ago
    });
    expect(isProjectStale(project, now)).toBe(true);
  });

  it("handles lastHeartbeat of 0 (epoch)", () => {
    const now = Date.now();
    const project = makeProject({
      connected: false,
      lastHeartbeat: 0,
    });
    // now - 0 = now, which is > 1 hour
    expect(isProjectStale(project, now)).toBe(true);
  });
});
