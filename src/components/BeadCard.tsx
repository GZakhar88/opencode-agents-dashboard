/**
 * BeadCard — Individual bead card displayed within a Kanban column.
 *
 * Displays: bead ID badge, title (truncated), priority badge, elapsed time.
 * Shows error tooltip when in error stage.
 * Uses shadcn Card + Tooltip + Badge components.
 */

import type { BeadState } from "@shared/types";
import { PRIORITY_COLORS } from "@/lib/constants";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ElapsedTime } from "@/components/ElapsedTime";
import { cn } from "@/lib/utils";

interface BeadCardProps {
  bead: BeadState;
}

/** Priority label mapping */
const PRIORITY_LABELS: Record<number, string> = {
  0: "P0",
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
};

export function BeadCard({ bead }: BeadCardProps) {
  const priorityColor = PRIORITY_COLORS[bead.priority] ?? PRIORITY_COLORS[3];
  const priorityLabel = PRIORITY_LABELS[bead.priority] ?? `P${bead.priority}`;
  const isError = bead.stage === "error";

  const cardContent = (
    <Card
      className={cn(
        "p-3 transition-colors hover:bg-accent/50",
        isError && "border-red-500/50 bg-red-500/5"
      )}
    >
      {/* Top row: ID badge + priority badge */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <Badge
          variant="outline"
          className="shrink-0 font-mono text-[10px] px-1.5 py-0"
        >
          {bead.id}
        </Badge>
        <Badge
          className={cn(
            "shrink-0 border-0 text-[10px] px-1.5 py-0",
            priorityColor
          )}
        >
          {priorityLabel}
        </Badge>
      </div>

      {/* Title (truncated to 2 lines) */}
      <p className="mb-2 line-clamp-2 text-sm leading-snug text-foreground">
        {bead.title}
      </p>

      {/* Bottom row: elapsed time + error indicator */}
      <div className="flex items-center justify-between">
        <ElapsedTime startTime={bead.stageStartedAt} />
        {isError && (
          <span className="text-[10px] font-medium text-red-400">Error</span>
        )}
      </div>
    </Card>
  );

  // Wrap in tooltip if in error state
  if (isError && bead.error) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{cardContent}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="text-xs">{bead.error}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return cardContent;
}
