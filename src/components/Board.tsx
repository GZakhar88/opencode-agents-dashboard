/**
 * Board — Kanban board container with dynamic agent columns.
 *
 * Columns are driven by ColumnConfig[] from the server (via agent discovery).
 * Falls back to DEFAULT_COLUMNS (ready, done, error) when no config available.
 *
 * Layout: ready → [agent columns] → done → error
 * Beads with unknown stages fall back to the "ready" column.
 *
 * In expanded mode, filters columns to only show:
 * - Columns that have beads (non-empty)
 * - The currently active stage (where an agent is working)
 * This eliminates horizontal waste from empty inactive columns.
 *
 * Wrapped in LayoutGroup to provide a shared layout animation context,
 * enabling smooth card transitions between columns via Framer Motion layoutId.
 */

import { useMemo } from "react";
import type { Pipeline, BeadState, ColumnConfig } from "@shared/types";
import { LayoutGroup } from "framer-motion";
import { DEFAULT_COLUMNS } from "@/lib/constants";
import { Column } from "@/components/Column";

interface BoardProps {
  pipeline: Pipeline;
  isExpanded: boolean;
  columns?: ColumnConfig[];
}

export function Board({ pipeline, isExpanded, columns }: BoardProps) {
  // Use provided columns when available. Fall back to default bookend
  // columns (ready, done, error) when no config exists or when the
  // visible column set is empty (no agents active yet). This ensures
  // the board always shows at least the status bookends.
  const columnConfig = columns !== undefined && columns.length > 0 ? columns : DEFAULT_COLUMNS;

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
        // Fallback: put unknown stages in "ready" column
        const readyBeads = map.get("ready");
        if (readyBeads) {
          readyBeads.push(bead);
        }
      }
    }
    return map;
  }, [pipeline.beads, sortedColumns, knownColumnIds]);

  // Find active stage (stage with an agent currently working)
  const activeStageId = useMemo(() => {
    for (const bead of pipeline.beads.values()) {
      if (bead.agentSessionId) return bead.stage;
    }
    return null;
  }, [pipeline.beads]);

  // Filter columns for expanded view: only non-empty + active stage
  const visibleColumns = useMemo(() => {
    if (!isExpanded) return sortedColumns;

    return sortedColumns.filter((col) => {
      const beads = beadsByStage.get(col.id) ?? [];
      // Show if: has beads, or is the currently active stage
      return beads.length > 0 || col.id === activeStageId;
    });
  }, [sortedColumns, beadsByStage, activeStageId, isExpanded]);

  // Don't render the board at all when collapsed — PipelineProgress handles that
  if (!isExpanded) return null;

  // Empty state: no columns to show (no beads and no active stage)
  if (visibleColumns.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-muted-foreground">
        No active stages to display
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pb-2 scrollbar-thin">
      <LayoutGroup id={pipeline.id}>
        <div className="flex gap-3">
          {visibleColumns.map((col) => (
            <Column
              key={col.id}
              columnId={col.id}
              label={col.label}
              color={col.color}
              beads={beadsByStage.get(col.id) ?? []}
            />
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}
