/**
 * PipelineProgress — Segmented progress bar with active bead label.
 *
 * Default (collapsed) view of the hybrid pipeline visualization.
 * Shows a segmented progress bar where each segment represents a pipeline
 * stage from ColumnConfig. Visual states:
 * - Completed stages: filled segments
 * - Active stage: pulsing segment with agent's color
 * - Upcoming stages: unfilled/muted segments
 *
 * Below the bar: ActiveBeadLabel shows the currently active bead's summary.
 * Batch progress displayed as "3/7 beads" on the right side.
 *
 * Stage ordering follows ColumnConfig.order. A stage is "completed" if
 * its order is less than the active stage's order AND it has no beads.
 * A stage is "active" if it currently has beads with agentSessionId set
 * OR is the highest-order stage with any beads.
 */

import { useMemo } from "react";
import type { Pipeline, BeadState, ColumnConfig } from "@shared/types";
import { DEFAULT_COLUMNS } from "@/lib/constants";
import { ProgressSegment, type SegmentState } from "@/components/ProgressSegment";
import { ActiveBeadLabel } from "@/components/ActiveBeadLabel";

interface PipelineProgressProps {
  pipeline: Pipeline;
  columns?: ColumnConfig[];
}

/**
 * Determine the segment state for each column based on bead distribution
 * and pipeline flow.
 */
function computeSegmentStates(
  sortedColumns: ColumnConfig[],
  beadsByStage: Map<string, BeadState[]>,
  _pipeline: Pipeline,
): Map<string, SegmentState> {
  const states = new Map<string, SegmentState>();

  // Find the highest-order stage that has active beads (with agentSessionId)
  let activeStageOrder = -1;
  for (const col of sortedColumns) {
    const beads = beadsByStage.get(col.id) ?? [];
    const hasActiveBead = beads.some((b) => !!b.agentSessionId);
    if (hasActiveBead) {
      activeStageOrder = Math.max(activeStageOrder, col.order);
    }
  }

  // If no active bead found, find the highest-order stage with any beads
  // that isn't "done" or "error" (those are terminal states)
  if (activeStageOrder === -1) {
    for (const col of sortedColumns) {
      if (col.id === "done" || col.id === "error") continue;
      const beads = beadsByStage.get(col.id) ?? [];
      if (beads.length > 0) {
        activeStageOrder = Math.max(activeStageOrder, col.order);
      }
    }
  }

  for (const col of sortedColumns) {
    const beads = beadsByStage.get(col.id) ?? [];
    const hasActiveBead = beads.some((b) => !!b.agentSessionId);

    if (hasActiveBead || col.order === activeStageOrder) {
      states.set(col.id, "active");
    } else if (col.order < activeStageOrder || col.id === "done") {
      // Completed if before the active stage, or if it's the done column with beads
      if (col.id === "done" && beads.length === 0) {
        states.set(col.id, "upcoming");
      } else {
        states.set(col.id, "completed");
      }
    } else {
      states.set(col.id, "upcoming");
    }
  }

  // Special case: if there are NO beads at all, everything is upcoming
  let totalBeads = 0;
  for (const beads of beadsByStage.values()) {
    totalBeads += beads.length;
  }
  if (totalBeads === 0) {
    for (const col of sortedColumns) {
      states.set(col.id, "upcoming");
    }
  }

  return states;
}

export function PipelineProgress({ pipeline, columns }: PipelineProgressProps) {
  const columnConfig =
    columns !== undefined && columns.length > 0 ? columns : DEFAULT_COLUMNS;

  // Sort columns by order
  const sortedColumns = useMemo(
    () => [...columnConfig].sort((a, b) => a.order - b.order),
    [columnConfig],
  );

  // Collect all known column IDs for fallback routing
  const knownColumnIds = useMemo(
    () => new Set(sortedColumns.map((c) => c.id)),
    [sortedColumns],
  );

  // Group beads by stage
  const beadsByStage = useMemo(() => {
    const map = new Map<string, BeadState[]>();
    for (const col of sortedColumns) {
      map.set(col.id, []);
    }
    for (const bead of pipeline.beads.values()) {
      if (knownColumnIds.has(bead.stage)) {
        map.get(bead.stage)!.push(bead);
      } else {
        const readyBeads = map.get("ready");
        if (readyBeads) {
          readyBeads.push(bead);
        }
      }
    }
    return map;
  }, [pipeline.beads, sortedColumns, knownColumnIds]);

  // Compute segment states
  const segmentStates = useMemo(
    () => computeSegmentStates(sortedColumns, beadsByStage, pipeline),
    [sortedColumns, beadsByStage, pipeline],
  );

  // Find the active bead (first bead with agentSessionId)
  const activeBead = useMemo(() => {
    for (const bead of pipeline.beads.values()) {
      if (bead.agentSessionId) return bead;
    }
    return null;
  }, [pipeline.beads]);

  // Batch progress: done / total
  const batchProgress = useMemo(() => {
    let done = 0;
    let total = 0;
    for (const bead of pipeline.beads.values()) {
      total++;
      if (bead.stage === "done") done++;
    }
    return { done, total };
  }, [pipeline.beads]);

  return (
    <div
      className="space-y-2"
      role="progressbar"
      aria-label="Pipeline progress"
      aria-valuemin={0}
      aria-valuemax={batchProgress.total || 1}
      aria-valuenow={batchProgress.done}
      aria-valuetext={
        batchProgress.total > 0
          ? `${batchProgress.done} of ${batchProgress.total} beads completed`
          : "No beads"
      }
    >
      {/* Progress bar row */}
      <div className="flex items-end gap-0.5">
        {/* Segmented bar */}
        <div className="flex flex-1 gap-0.5">
          {sortedColumns.map((col, index) => (
            <ProgressSegment
              key={col.id}
              label={col.label}
              color={col.color}
              state={segmentStates.get(col.id) ?? "upcoming"}
              beadCount={(beadsByStage.get(col.id) ?? []).length}
              isFirst={index === 0}
              isLast={index === sortedColumns.length - 1}
            />
          ))}
        </div>

        {/* Batch progress counter */}
        {batchProgress.total > 0 && (
          <div className="ml-3 shrink-0 text-right">
            <span className="text-xs font-semibold tabular-nums text-foreground">
              {batchProgress.done}
              <span className="text-muted-foreground/70">/{batchProgress.total}</span>
            </span>
            <span className="ml-1 text-[10px] text-muted-foreground">beads</span>
          </div>
        )}
      </div>

      {/* Active bead label */}
      <ActiveBeadLabel bead={activeBead} columns={sortedColumns} />
    </div>
  );
}
