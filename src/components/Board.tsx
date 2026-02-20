/**
 * Board — Kanban board container with 8 stage columns.
 *
 * Displays columns in order: backlog → orchestrator → builder → refactor →
 * reviewer → committer → error → done.
 * Filters beads by stage and passes them to each Column.
 * Horizontal scroll container for narrow screens.
 */

import type { Pipeline, BeadState, Stage } from "@shared/types";
import { COLUMNS } from "@/lib/constants";
import { Column } from "@/components/Column";

interface BoardProps {
  pipeline: Pipeline;
}

export function Board({ pipeline }: BoardProps) {
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
    <div className="overflow-x-auto pb-2">
      <div className="flex gap-3">
        {COLUMNS.map((columnId) => (
          <Column
            key={columnId}
            columnId={columnId}
            beads={beadsByStage.get(columnId) ?? []}
          />
        ))}
      </div>
    </div>
  );
}
