/**
 * Board — Kanban board container with 8 stage columns.
 *
 * Displays columns in order: backlog → orchestrator → builder → refactor →
 * reviewer → committer → error → done.
 * Filters beads by stage and passes them to each Column.
 * Horizontal scroll container for narrow screens.
 * Supports compact mode (1 card height) and expanded mode (full height).
 *
 * Wrapped in LayoutGroup to provide a shared layout animation context,
 * enabling smooth card transitions between columns via Framer Motion layoutId.
 */

import type { Pipeline, BeadState, Stage } from "@shared/types";
import { LayoutGroup } from "framer-motion";
import { COLUMNS } from "@/lib/constants";
import { Column } from "@/components/Column";

interface BoardProps {
  pipeline: Pipeline;
  isExpanded: boolean;
}

export function Board({ pipeline, isExpanded }: BoardProps) {
  // Group beads by stage
  const beadsByStage = new Map<Stage, BeadState[]>();
  for (const columnId of COLUMNS) {
    beadsByStage.set(columnId, []);
  }

  for (const bead of pipeline.beads.values()) {
    const list = beadsByStage.get(bead.stage);
    if (list) {
      list.push(bead);
    } else {
      // Fallback: put unknown stages in backlog
      beadsByStage.get("backlog")!.push(bead);
    }
  }

  return (
    <div className="overflow-x-auto pb-2 scrollbar-thin">
      <LayoutGroup id={pipeline.id}>
        <div className="flex gap-3">
          {COLUMNS.map((columnId) => (
            <Column
              key={columnId}
              columnId={columnId}
              beads={beadsByStage.get(columnId) ?? []}
              isCompact={!isExpanded}
            />
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}
