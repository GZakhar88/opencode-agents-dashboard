/**
 * Tests for diffBeadState logic.
 *
 * These tests validate the bead diff algorithm extracted from the
 * dashboard-bridge plugin. Since the plugin file uses module-level
 * state and imports from @opencode-ai/plugin (not available in test
 * environment), we duplicate the core types and function here.
 *
 * Run: bun test server/diffBeadState.test.ts
 */
import { describe, it, expect } from "bun:test";

// ─── Types (duplicated from dashboard-bridge.ts) ──────────────

interface BeadRecord {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  issue_type: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
  dependencies?: Array<{
    issue_id: string;
    depends_on_id: string;
    type: string;
    created_at?: string;
    created_by?: string;
    metadata?: string;
  }>;
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
}

type BeadDiff =
  | { type: "discovered"; bead: BeadRecord }
  | { type: "changed"; bead: BeadRecord; prevStatus: string }
  | { type: "removed"; beadId: string }
  | { type: "error"; bead: BeadRecord; error: string };

// ─── Function under test (duplicated from dashboard-bridge.ts) ─

function diffBeadState(prev: BeadRecord[], next: BeadRecord[]): BeadDiff[] {
  const diffs: BeadDiff[] = [];

  const prevMap = new Map<string, BeadRecord>();
  for (const bead of prev) {
    prevMap.set(bead.id, bead);
  }

  const nextMap = new Map<string, BeadRecord>();
  for (const bead of next) {
    nextMap.set(bead.id, bead);
  }

  // Check for new and changed beads
  for (const [id, bead] of nextMap) {
    const prevBead = prevMap.get(id);

    if (!prevBead) {
      // New bead discovered — also check if it's already in an error state
      diffs.push({ type: "discovered", bead });

      if (bead.status === "blocked") {
        diffs.push({
          type: "error",
          bead,
          error: `Discovered bead already blocked`,
        });
      } else if (
        bead.status === "closed" &&
        bead.close_reason &&
        /fail|reject|abandon|error|abort/i.test(bead.close_reason)
      ) {
        diffs.push({
          type: "error",
          bead,
          error: `Discovered bead closed with failure: ${bead.close_reason}`,
        });
      }

      continue;
    }

    // Check for status change
    if (prevBead.status !== bead.status) {
      // Detect error conditions
      if (bead.status === "blocked") {
        diffs.push({
          type: "error",
          bead,
          error: `Bead status changed to blocked (was: ${prevBead.status})`,
        });
      } else if (
        bead.status === "closed" &&
        bead.close_reason &&
        /fail|reject|abandon|error|abort/i.test(bead.close_reason)
      ) {
        // Closed with a failure-indicating reason
        diffs.push({
          type: "error",
          bead,
          error: `Bead closed with failure: ${bead.close_reason}`,
        });
      } else {
        // Normal status change
        diffs.push({
          type: "changed",
          bead,
          prevStatus: prevBead.status,
        });
      }
    }
  }

  // Check for removed beads
  for (const [id] of prevMap) {
    if (!nextMap.has(id)) {
      diffs.push({ type: "removed", beadId: id });
    }
  }

  return diffs;
}

// ─── Test helpers ──────────────────────────────────────────────

function makeBead(overrides: Partial<BeadRecord> & { id: string }): BeadRecord {
  return {
    title: `Bead ${overrides.id}`,
    description: "Test bead",
    status: "open",
    priority: 1,
    issue_type: "task",
    created_at: "2026-02-20T09:00:00Z",
    updated_at: "2026-02-20T09:00:00Z",
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────

describe("diffBeadState", () => {
  it("returns empty array when both snapshots are empty", () => {
    const result = diffBeadState([], []);
    expect(result).toEqual([]);
  });

  it("returns empty array when snapshots are identical", () => {
    const beads = [makeBead({ id: "a1" }), makeBead({ id: "b2" })];
    const result = diffBeadState(beads, beads);
    expect(result).toEqual([]);
  });

  it("detects a new bead as discovered", () => {
    const prev: BeadRecord[] = [];
    const next = [makeBead({ id: "new-1" })];
    const result = diffBeadState(prev, next);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("discovered");
    if (result[0].type === "discovered") {
      expect(result[0].bead.id).toBe("new-1");
    }
  });

  it("detects multiple new beads", () => {
    const prev = [makeBead({ id: "existing" })];
    const next = [
      makeBead({ id: "existing" }),
      makeBead({ id: "new-1" }),
      makeBead({ id: "new-2" }),
    ];
    const result = diffBeadState(prev, next);

    const discovered = result.filter((d) => d.type === "discovered");
    expect(discovered).toHaveLength(2);
    const ids = discovered.map((d) => (d as any).bead.id).sort();
    expect(ids).toEqual(["new-1", "new-2"]);
  });

  it("detects a removed bead", () => {
    const prev = [makeBead({ id: "gone" }), makeBead({ id: "stays" })];
    const next = [makeBead({ id: "stays" })];
    const result = diffBeadState(prev, next);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("removed");
    if (result[0].type === "removed") {
      expect(result[0].beadId).toBe("gone");
    }
  });

  it("detects a normal status change (open -> in_progress)", () => {
    const prev = [makeBead({ id: "a1", status: "open" })];
    const next = [makeBead({ id: "a1", status: "in_progress" })];
    const result = diffBeadState(prev, next);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("changed");
    if (result[0].type === "changed") {
      expect(result[0].bead.id).toBe("a1");
      expect(result[0].prevStatus).toBe("open");
      expect(result[0].bead.status).toBe("in_progress");
    }
  });

  it("detects blocked status as an error", () => {
    const prev = [makeBead({ id: "a1", status: "in_progress" })];
    const next = [makeBead({ id: "a1", status: "blocked" })];
    const result = diffBeadState(prev, next);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("error");
    if (result[0].type === "error") {
      expect(result[0].bead.id).toBe("a1");
      expect(result[0].error).toContain("blocked");
      expect(result[0].error).toContain("in_progress");
    }
  });

  it("detects failure close reason as an error", () => {
    const prev = [makeBead({ id: "a1", status: "in_progress" })];
    const next = [
      makeBead({
        id: "a1",
        status: "closed",
        close_reason: "Pipeline failed: tests did not pass",
      }),
    ];
    const result = diffBeadState(prev, next);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("error");
    if (result[0].type === "error") {
      expect(result[0].error).toContain("failure");
      expect(result[0].error).toContain("Pipeline failed: tests did not pass");
    }
  });

  it("treats normal close reason as changed, not error", () => {
    const prev = [makeBead({ id: "a1", status: "in_progress" })];
    const next = [
      makeBead({
        id: "a1",
        status: "closed",
        close_reason: "Completed successfully",
      }),
    ];
    const result = diffBeadState(prev, next);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("changed");
  });

  it("detects a newly discovered bead already in blocked state", () => {
    const prev: BeadRecord[] = [];
    const next = [makeBead({ id: "blocked-new", status: "blocked" })];
    const result = diffBeadState(prev, next);

    // Should emit both discovered AND error
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("discovered");
    expect(result[1].type).toBe("error");
    if (result[1].type === "error") {
      expect(result[1].error).toContain("Discovered bead already blocked");
    }
  });

  it("detects newly discovered bead closed with failure", () => {
    const prev: BeadRecord[] = [];
    const next = [
      makeBead({
        id: "failed-new",
        status: "closed",
        close_reason: "rejected by reviewer",
      }),
    ];
    const result = diffBeadState(prev, next);

    // Should emit both discovered AND error
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("discovered");
    expect(result[1].type).toBe("error");
    if (result[1].type === "error") {
      expect(result[1].error).toContain("Discovered bead closed with failure");
    }
  });

  it("handles a complex scenario with mixed changes", () => {
    const prev = [
      makeBead({ id: "stays-same", status: "open" }),
      makeBead({ id: "gets-removed", status: "open" }),
      makeBead({ id: "changes-status", status: "open" }),
      makeBead({ id: "goes-blocked", status: "in_progress" }),
    ];
    const next = [
      makeBead({ id: "stays-same", status: "open" }),
      // "gets-removed" is gone
      makeBead({ id: "changes-status", status: "in_progress" }),
      makeBead({ id: "goes-blocked", status: "blocked" }),
      makeBead({ id: "brand-new", status: "open" }),
    ];
    const result = diffBeadState(prev, next);

    const types = result.map((d) => d.type);
    expect(types).toContain("changed");
    expect(types).toContain("error");
    expect(types).toContain("removed");
    expect(types).toContain("discovered");

    // Verify specifics
    const changed = result.find(
      (d) => d.type === "changed" && (d as any).bead?.id === "changes-status"
    );
    expect(changed).toBeDefined();

    const error = result.find(
      (d) => d.type === "error" && (d as any).bead?.id === "goes-blocked"
    );
    expect(error).toBeDefined();

    const removed = result.find(
      (d) => d.type === "removed" && (d as any).beadId === "gets-removed"
    );
    expect(removed).toBeDefined();

    const discovered = result.find(
      (d) => d.type === "discovered" && (d as any).bead?.id === "brand-new"
    );
    expect(discovered).toBeDefined();
  });

  it("does not emit a diff when only non-status fields change", () => {
    const prev = [makeBead({ id: "a1", title: "Old title", status: "open" })];
    const next = [makeBead({ id: "a1", title: "New title", status: "open" })];
    const result = diffBeadState(prev, next);

    // Current implementation only diffs on status — title changes alone
    // produce no diff. This is intentional: status drives the Kanban board.
    expect(result).toEqual([]);
  });

  it("handles various failure close reason patterns (case-insensitive)", () => {
    const failureReasons = [
      "failed: build error",
      "REJECTED by linter",
      "abandoned by user",
      "error in pipeline",
      "abort: timeout",
    ];

    for (const reason of failureReasons) {
      const prev = [makeBead({ id: "a1", status: "in_progress" })];
      const next = [makeBead({ id: "a1", status: "closed", close_reason: reason })];
      const result = diffBeadState(prev, next);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("error");
    }
  });

  it("treats closed without close_reason as a normal change", () => {
    const prev = [makeBead({ id: "a1", status: "in_progress" })];
    const next = [makeBead({ id: "a1", status: "closed" })];
    const result = diffBeadState(prev, next);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("changed");
  });
});

// ─── Pipeline stage helper functions (duplicated from dashboard-bridge.ts) ─

function mapSubagentTypeToStage(agentType: string): string | null {
  const mapping: Record<string, string> = {
    "pipeline-builder": "builder",
    "pipeline-refactor": "refactor",
    "pipeline-reviewer": "reviewer",
    "pipeline-committer": "committer",
    builder: "builder",
    refactor: "refactor",
    reviewer: "reviewer",
    committer: "committer",
    designer: "designer",
  };
  return mapping[agentType] ?? null;
}

function extractBeadId(text: string): string | null {
  const match = text.match(/\[([a-zA-Z0-9][\w-]*)\]/);
  return match ? match[1] : null;
}

// ─── Tests for mapSubagentTypeToStage ──────────────────────────

describe("mapSubagentTypeToStage", () => {
  it("maps pipeline-prefixed agent names to stage names", () => {
    expect(mapSubagentTypeToStage("pipeline-builder")).toBe("builder");
    expect(mapSubagentTypeToStage("pipeline-refactor")).toBe("refactor");
    expect(mapSubagentTypeToStage("pipeline-reviewer")).toBe("reviewer");
    expect(mapSubagentTypeToStage("pipeline-committer")).toBe("committer");
  });

  it("maps bare agent names to stage names", () => {
    expect(mapSubagentTypeToStage("builder")).toBe("builder");
    expect(mapSubagentTypeToStage("refactor")).toBe("refactor");
    expect(mapSubagentTypeToStage("reviewer")).toBe("reviewer");
    expect(mapSubagentTypeToStage("committer")).toBe("committer");
  });

  it("maps designer agent to designer stage", () => {
    expect(mapSubagentTypeToStage("designer")).toBe("designer");
  });

  it("returns null for unknown agent types", () => {
    expect(mapSubagentTypeToStage("unknown-agent")).toBeNull();
    expect(mapSubagentTypeToStage("")).toBeNull();
    expect(mapSubagentTypeToStage("orchestrator")).toBeNull();
    expect(mapSubagentTypeToStage("pipeline-orchestrator")).toBeNull();
  });

  it("is case-sensitive (agent names come from config, should be exact)", () => {
    expect(mapSubagentTypeToStage("Pipeline-Builder")).toBeNull();
    expect(mapSubagentTypeToStage("BUILDER")).toBeNull();
    expect(mapSubagentTypeToStage("Builder")).toBeNull();
  });
});

// ─── Tests for extractBeadId ───────────────────────────────────

describe("extractBeadId", () => {
  it("extracts bead ID from bracketed format", () => {
    expect(extractBeadId("Build: [bd-a1b2] Add auth middleware")).toBe("bd-a1b2");
  });

  it("extracts bead ID with complex format", () => {
    expect(extractBeadId("[opencode-dashboard-bom] Pipeline stage detection")).toBe("opencode-dashboard-bom");
  });

  it("extracts first bead ID when multiple brackets present", () => {
    expect(extractBeadId("[bd-a1] first [bd-b2] second")).toBe("bd-a1");
  });

  it("returns null when no bracketed ID is present", () => {
    expect(extractBeadId("Build the auth middleware")).toBeNull();
    expect(extractBeadId("")).toBeNull();
  });

  it("does not match empty brackets", () => {
    expect(extractBeadId("Build [] something")).toBeNull();
  });

  it("does not match brackets starting with non-alphanumeric", () => {
    expect(extractBeadId("Build [-invalid] something")).toBeNull();
    expect(extractBeadId("Build [_invalid] something")).toBeNull();
  });

  it("handles IDs with underscores and numbers", () => {
    expect(extractBeadId("[task_123] Do something")).toBe("task_123");
    expect(extractBeadId("[a1b2c3] Fix the thing")).toBe("a1b2c3");
  });

  it("handles IDs with hyphens throughout", () => {
    expect(extractBeadId("[my-project-bead-1] Implement feature")).toBe("my-project-bead-1");
  });
});
