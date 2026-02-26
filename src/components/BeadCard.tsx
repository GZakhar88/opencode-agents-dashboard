/**
 * BeadCard — Individual bead card displayed within a Kanban column.
 *
 * Redesigned for higher information density and better at-a-glance scanning:
 * - Priority indicated by colored left border (not pill badge)
 * - ID shown as tooltip on hover only (not a prominent badge)
 * - Issue type icon (bug/feature/task) for quick categorization
 * - Mini progress indicator showing current pipeline stage
 * - Elapsed time prominent and pulsing when actively processing
 * - Error state styling preserved with red treatment
 *
 * Animated with Framer Motion:
 * - `layoutId` enables smooth position transitions between columns
 * - Fade/scale on mount and unmount via initial/animate/exit
 * - Subtle pulse ring when an agent is actively working on the bead
 */

import { useMemo } from "react";
import type { BeadState, ColumnConfig } from "@shared/types";
import { motion } from "framer-motion";
import {
  AlertCircle,
  Bug,
  Sparkles,
  CheckSquare,
  Layers,
  Wrench,
  GitBranch,
  Circle,
  type LucideIcon,
} from "lucide-react";
import {
  PRIORITY_BORDER_COLORS,
  PRIORITY_LABELS,
  ISSUE_TYPE_LABELS,
  ISSUE_TYPE_COLORS,
} from "@/lib/constants";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ElapsedTime } from "@/components/ElapsedTime";
import { cn, hexToRgba } from "@/lib/utils";

interface BeadCardProps {
  bead: BeadState;
  /** All pipeline columns — used for the mini progress indicator */
  columns?: ColumnConfig[];
}

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

/** Error card: red border, subtle glow, ring highlight */
const ERROR_CARD_STYLES =
  "border-red-500/60 bg-red-500/5 ring-1 ring-red-500/20 shadow-[0_0_8px_rgba(239,68,68,0.1)]";

/** Active agent card: blue ring + animated glow pulse */
const ACTIVE_CARD_STYLES = "ring-1 ring-blue-400/60 animate-agent-pulse";

/** Map issue type string to Lucide icon component */
const ISSUE_TYPE_ICON_MAP: Record<string, LucideIcon> = {
  bug: Bug,
  feature: Sparkles,
  task: CheckSquare,
  epic: Layers,
  chore: Wrench,
  decision: GitBranch,
};

/**
 * MiniProgress — tiny dot-based progress indicator showing
 * which stage in the pipeline the bead is currently at.
 * Excludes error column from the progress visualization.
 */
function MiniProgress({
  currentStage,
  columns,
}: {
  currentStage: string;
  columns: ColumnConfig[];
}) {
  // Filter out error column and sort by order
  const stages = useMemo(
    () =>
      columns
        .filter((c) => c.id !== "error")
        .sort((a, b) => a.order - b.order),
    [columns],
  );

  if (stages.length <= 1) return null;

  const currentIndex = stages.findIndex((s) => s.id === currentStage);
  const stageLabel = stages.find((s) => s.id === currentStage)?.label ?? currentStage;

  // Build aria-label: include position when found, otherwise just show stage name
  const ariaLabel =
    currentIndex >= 0
      ? `Stage ${currentIndex + 1} of ${stages.length}: ${stageLabel}`
      : `Current stage: ${stageLabel}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-0.5" aria-label={ariaLabel} role="img">
          {stages.map((stage, i) => {
            const isCurrent = stage.id === currentStage;
            const isPast = currentIndex >= 0 && i < currentIndex;

            return (
              <div
                key={stage.id}
                className={cn(
                  "rounded-full transition-all duration-200",
                  isCurrent
                    ? "h-1.5 w-3"
                    : "h-1.5 w-1.5",
                )}
                style={{
                  backgroundColor: isCurrent
                    ? stage.color
                    : isPast
                      ? hexToRgba(stage.color, 0.5)
                      : hexToRgba(stage.color, 0.15),
                }}
              />
            );
          })}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        Stage: {stageLabel}
        {currentIndex >= 0 && ` (${currentIndex + 1}/${stages.length})`}
      </TooltipContent>
    </Tooltip>
  );
}

export function BeadCard({ bead, columns }: BeadCardProps) {
  const priorityBorderColor =
    PRIORITY_BORDER_COLORS[bead.priority] ?? PRIORITY_BORDER_COLORS[3];
  const priorityLabel = PRIORITY_LABELS[bead.priority] ?? `P${bead.priority}`;
  const isError = bead.stage === "error";
  const isActive = !!bead.agentSessionId;
  const showElapsed =
    bead.stage !== "ready" && bead.stage !== "done";

  // Issue type icon
  const IssueIcon = ISSUE_TYPE_ICON_MAP[bead.issueType] ?? Circle;
  const issueColor = ISSUE_TYPE_COLORS[bead.issueType] ?? "text-muted-foreground";
  const issueLabel = ISSUE_TYPE_LABELS[bead.issueType] ?? bead.issueType;

  // Card body — shared between normal and error tooltip variants
  const cardBody = (
    <Card
      className={cn(
        "relative overflow-hidden border-l-[3px] p-2 pl-2.5 transition-colors hover:bg-accent/50",
        isError && ERROR_CARD_STYLES,
        isActive && !isError && ACTIVE_CARD_STYLES,
      )}
      style={{
        borderLeftColor: isError ? "#ef4444" : priorityBorderColor,
      }}
    >
      {/* Row 1: Issue type icon + title + priority label */}
      <div className="flex items-start gap-1.5">
        {/* Issue type icon — uses title attr instead of nested Tooltip to
            avoid Radix Tooltip nesting issues with the outer card tooltip */}
        <span
          className={cn("mt-0.5 shrink-0", issueColor)}
          title={issueLabel}
          aria-label={issueLabel}
        >
          <IssueIcon className="h-3 w-3" aria-hidden="true" />
        </span>

        {/* Title (truncated to 2 lines) */}
        <p className="min-w-0 flex-1 line-clamp-2 text-[13px] leading-snug text-foreground">
          {bead.title}
        </p>

        {/* Priority label — small, unobtrusive */}
        <span
          className="mt-0.5 shrink-0 text-[9px] font-semibold uppercase tracking-wide"
          style={{ color: priorityBorderColor }}
        >
          {priorityLabel}
        </span>
      </div>

      {/* Row 2: Progress indicator + elapsed time + error */}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        {/* Left: mini progress dots */}
        <div className="flex items-center gap-2">
          {columns && columns.length > 1 && (
            <MiniProgress
              currentStage={bead.stage}
              columns={columns}
            />
          )}
        </div>

        {/* Right: elapsed time + error indicator */}
        <div className="flex items-center gap-2">
          {showElapsed && (
            <span
              className={cn(
                "tabular-nums",
                isActive
                  ? "text-sm font-semibold text-blue-400 animate-elapsed-pulse"
                  : "text-xs text-muted-foreground",
              )}
            >
              <ElapsedTime startTime={bead.stageStartedAt} />
            </span>
          )}
          {isError && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-red-400">
              <AlertCircle className="h-3 w-3" />
              Error
            </span>
          )}
        </div>
      </div>

      {/* Error message preview (visible directly on card) */}
      {isError && bead.error && (
        <p className="mt-1.5 line-clamp-2 break-words rounded bg-red-500/10 px-1.5 py-1 text-[10px] leading-tight text-red-400">
          {bead.error}
        </p>
      )}
    </Card>
  );

  // Tooltip content varies: error beads show the error message + ID;
  // normal beads show the bead ID for quick reference.
  const tooltipContent = isError && bead.error ? (
    <TooltipContent
      side="top"
      className="max-w-xs border-red-500/30 bg-popover"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
        <div>
          <p className="mb-1 font-mono text-[10px] text-muted-foreground">
            {bead.id}
          </p>
          <p className="max-h-40 overflow-y-auto break-words text-xs text-popover-foreground">
            {bead.error}
          </p>
        </div>
      </div>
    </TooltipContent>
  ) : (
    <TooltipContent
      side="top"
      className="font-mono text-xs"
    >
      {bead.id}
    </TooltipContent>
  );

  return (
    <motion.div
      layoutId={bead.id}
      variants={cardVariants}
      initial="hidden"
      animate="visible"
      exit="hidden"
      transition={cardTransition}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          {cardBody}
        </TooltipTrigger>
        {tooltipContent}
      </Tooltip>
    </motion.div>
  );
}
