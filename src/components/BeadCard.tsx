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
 * - Directional trail animation: cards slide in from the left when entering
 *   a later stage and from the right when moving backward (e.g., error → retry)
 * - Subtle breathing ring when an agent is actively working on the bead
 */

import { useMemo, useEffect } from "react";
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

/** Horizontal slide distance for directional enter/exit */
const SLIDE_X = 24;

/**
 * Module-level stage history per bead ID.
 * Persists across unmount/remount cycles so that when a bead moves from
 * column A → column B (unmount + mount), the new mount can compute
 * direction by comparing against the bead's *previous* stage.
 *
 * Bounded to prevent memory leaks: entries are cleaned up when the bead
 * reaches "done" or "error" terminal states.
 */
const prevStageMap = new Map<string, string>();

/** Spring transition for layout animations (natural card movement) */
const cardTransition = {
  type: "spring" as const,
  stiffness: 300,
  damping: 30,
};

/** Error card: red border, subtle glow, ring highlight */
const ERROR_CARD_STYLES =
  "border-status-error/60 bg-status-error/5 ring-1 ring-status-error/20 shadow-[0_0_8px_rgba(239,68,68,0.1)]";

/** Active agent card: amber ring + animated breathing ring */
const ACTIVE_CARD_STYLES = "ring-1 ring-status-warning/60 animate-agent-pulse";

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

  // Compute directional slide based on stage change.
  // Uses module-level prevStageMap to survive unmount/remount when the bead
  // moves between Column components.
  const direction = useMemo(() => {
    if (!columns || columns.length === 0) return 0;
    const prev = prevStageMap.get(bead.id);
    const curr = bead.stage;
    if (!prev || prev === curr) return 0;

    const prevOrder = columns.find((c) => c.id === prev)?.order ?? 0;
    const currOrder = columns.find((c) => c.id === curr)?.order ?? 0;
    return currOrder > prevOrder ? 1 : currOrder < prevOrder ? -1 : 0;
  }, [bead.id, bead.stage, columns]);

  // Persist current stage for next transition; clean up terminal states
  useEffect(() => {
    prevStageMap.set(bead.id, bead.stage);
    // Cleanup terminal states after animation completes to prevent memory leaks
    if (bead.stage === "done") {
      const timer = setTimeout(() => prevStageMap.delete(bead.id), 2000);
      return () => clearTimeout(timer);
    }
  }, [bead.id, bead.stage]);

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
        borderLeftColor: isError ? "hsl(var(--status-error))" : priorityBorderColor,
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
                "font-mono tabular-nums",
                isActive
                  ? "text-sm font-semibold text-status-warning animate-elapsed-pulse"
                  : "text-xs text-muted-foreground",
              )}
            >
              <ElapsedTime startTime={bead.stageStartedAt} />
            </span>
          )}
          {isError && (
            <span className="flex items-center gap-1 font-mono text-[10px] font-medium text-status-error">
              <AlertCircle className="h-3 w-3" />
              Error
            </span>
          )}
        </div>
      </div>

      {/* Error message preview (visible directly on card) */}
      {isError && bead.error && (
        <p className="mt-1.5 line-clamp-2 break-words rounded bg-status-error/10 px-1.5 py-1 font-mono text-[10px] leading-tight text-status-error">
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
      className="max-w-xs border-status-error/30 bg-popover"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-error" />
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
      initial={{ opacity: 0, x: direction * SLIDE_X, scale: 0.97 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: direction * -SLIDE_X, scale: 0.97 }}
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
