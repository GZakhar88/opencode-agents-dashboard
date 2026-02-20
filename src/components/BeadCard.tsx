/**
 * BeadCard — Individual bead card displayed within a Kanban column.
 *
 * Displays: bead ID badge, title (truncated), priority badge, elapsed time.
 * Shows error tooltip when in error stage.
 * Uses shadcn Card + Tooltip + Badge components.
 *
 * Animated with Framer Motion:
 * - `layoutId` enables smooth position transitions between columns
 * - Fade/scale on mount and unmount via initial/animate/exit
 * - Subtle pulse ring when an agent is actively working on the bead
 */

import type { BeadState } from "@shared/types";
import { motion } from "framer-motion";
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

/** Framer Motion animation variants for card enter/exit */
const cardVariants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: { opacity: 1, scale: 1 },
} as const;

/** Spring transition for layout animations (natural card movement) */
const cardTransition = {
  type: "spring" as const,
  stiffness: 300,
  damping: 30,
};

export function BeadCard({ bead }: BeadCardProps) {
  const priorityColor = PRIORITY_COLORS[bead.priority] ?? PRIORITY_COLORS[3];
  const priorityLabel = PRIORITY_LABELS[bead.priority] ?? `P${bead.priority}`;
  const isError = bead.stage === "error";
  const isActive = !!bead.agentSessionId;

  const cardContent = (
    <motion.div
      layoutId={bead.id}
      variants={cardVariants}
      initial="hidden"
      animate="visible"
      exit="hidden"
      transition={cardTransition}
    >
      <Card
        className={cn(
          "p-3 transition-colors hover:bg-accent/50",
          isError && "border-red-500/50 bg-red-500/5",
          isActive &&
            "ring-1 ring-blue-400/60 shadow-[0_0_8px_rgba(96,165,250,0.2)]",
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
              priorityColor,
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
    </motion.div>
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
