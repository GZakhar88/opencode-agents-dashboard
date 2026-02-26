/**
 * PipelineHeader — Pipeline title, status badge, and expand/collapse toggle.
 *
 * Displays: pipeline title, status badge (LIVE/IDLE/DONE), expand/collapse toggle.
 * Status colors: active=green, idle=gray, done=blue.
 *
 * The toggle switches between:
 * - Collapsed: segmented progress bar (PipelineProgress)
 * - Expanded: filtered Kanban board (Board)
 */

import type { Pipeline, PipelineStatus } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp, Layers, BarChart3 } from "lucide-react";
import { FOCUS_RING } from "@/lib/styles";
import { cn } from "@/lib/utils";

interface PipelineHeaderProps {
  pipeline: Pipeline;
  isExpanded: boolean;
  onToggle: () => void;
  /** When true, hides the expand/collapse toggle button (mobile) */
  hideToggle?: boolean;
}

const STATUS_CONFIG: Record<
  PipelineStatus,
  { label: string; className: string }
> = {
  active: {
    label: "LIVE",
    className: "border-status-live/50 bg-status-live/10 text-status-live",
  },
  idle: {
    label: "IDLE",
    className: "border-status-idle/50 bg-status-idle/10 text-status-idle",
  },
  done: {
    label: "DONE",
    className: "border-status-done/50 bg-status-done/10 text-status-done",
  },
};

export function PipelineHeader({ pipeline, isExpanded, onToggle, hideToggle = false }: PipelineHeaderProps) {
  const config = STATUS_CONFIG[pipeline.status] ?? STATUS_CONFIG.idle;

  return (
    <div className="flex items-center gap-2 py-2 sm:gap-3">
      {/* Expand/collapse toggle button — hidden on mobile */}
      {!hideToggle && (
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            "min-h-[44px] sm:min-h-0",
            FOCUS_RING,
          )}
          aria-label={isExpanded ? "Collapse to progress bar" : "Expand to Kanban board"}
          title={isExpanded ? "Collapse to progress bar" : "Expand to Kanban board"}
        >
          {isExpanded ? (
            <>
              <ChevronUp className="h-3 w-3" />
              <BarChart3 className="h-3 w-3" />
              <span>Collapse</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              <Layers className="h-3 w-3" />
              <span>Expand</span>
            </>
          )}
        </button>
      )}
      <h3 className="text-sm font-medium text-foreground">
        {pipeline.title}
      </h3>
      <Badge
        variant="outline"
        className={cn("font-mono text-[10px] px-2 py-0", config.className)}
      >
        {config.label}
      </Badge>
      <span className="font-mono text-xs text-muted-foreground">
        {pipeline.beads.size} bead{pipeline.beads.size !== 1 ? "s" : ""}
      </span>
    </div>
  );
}
