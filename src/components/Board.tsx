/**
 * Board — Kanban board container with dynamic agent columns.
 *
 * Columns are driven by ColumnConfig[] from the server (via agent discovery).
 * Falls back to DEFAULT_COLUMNS (ready, done, error) when no config available.
 *
 * Layout: ready → [agent columns] → done → error
 * Beads with unknown stages fall back to the "ready" column.
 *
 * Wrapped in LayoutGroup to provide a shared layout animation context,
 * enabling smooth card transitions between columns via Framer Motion layoutId.
 */

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
  // Use provided columns. Fall back to defaults only when no project
  // data exists at all (columns prop is undefined). An empty array means
  // the project is connected but no columns are visible yet — render
  // nothing rather than stale defaults so columns appear smoothly once
  // the server broadcasts the visible set.
  const columnConfig = columns !== undefined ? columns : DEFAULT_COLUMNS;

  // Sort columns by order
  const sortedColumns = [...columnConfig].sort((a, b) => a.order - b.order);

  // Collect all known column IDs for fallback routing
  const knownColumnIds = new Set(sortedColumns.map((c) => c.id));

  // Group beads by stage
  const beadsByStage = new Map<string, BeadState[]>();
  for (const col of sortedColumns) {
    beadsByStage.set(col.id, []);
  }

  for (const bead of pipeline.beads.values()) {
    if (knownColumnIds.has(bead.stage)) {
      beadsByStage.get(bead.stage)!.push(bead);
    } else {
      // Fallback: put unknown stages in "ready" column
      const readyBeads = beadsByStage.get("ready");
      if (readyBeads) {
        readyBeads.push(bead);
      }
    }
  }

  return (
    <div className="overflow-x-auto pb-2 scrollbar-thin">
      <LayoutGroup id={pipeline.id}>
        <div className="flex gap-3">
          {sortedColumns.map((col) => (
            <Column
              key={col.id}
              columnId={col.id}
              label={col.label}
              color={col.color}
              beads={beadsByStage.get(col.id) ?? []}
              isCompact={!isExpanded}
            />
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}
