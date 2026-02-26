/**
 * ProjectSection — Self-contained project card for the grid layout.
 *
 * Displays: project name, directory path, connection status badge.
 * Renders all pipelines for this project, each with:
 * - PipelineHeader (title, status, expand/collapse toggle)
 * - PipelineProgress (collapsed: segmented progress bar + active bead label)
 * - Board (expanded: filtered Kanban with only non-empty + active columns)
 *
 * Uses shadcn Collapsible for expand/collapse within the card.
 *
 * Visual weight is proportional to project importance:
 * - Active (has active pipelines) — strong border, glow, full opacity
 * - Idle (connected, no active pipelines) — muted, recessed
 * - Disconnected — desaturated, dimmed
 */

import { useState, useEffect, useMemo } from "react";
import type { ProjectState } from "@shared/types";
import { ChevronRight, Activity, Pause, WifiOff } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PipelineHeader } from "@/components/PipelineHeader";
import { PipelineProgress } from "@/components/PipelineProgress";
import { Board } from "@/components/Board";
import { formatLastSeen } from "@/lib/format";
import { FOCUS_RING } from "@/lib/styles";
import { cn } from "@/lib/utils";

interface ProjectSectionProps {
  project: ProjectState;
}

/**
 * Derive the card-level status from project state.
 * This drives the CSS visual weight via data-status attribute.
 */
type CardStatus = "active" | "idle" | "disconnected";

function getCardStatus(project: ProjectState): CardStatus {
  if (!project.connected) return "disconnected";
  
  // Check if any pipeline is active
  for (const pipeline of project.pipelines.values()) {
    if (pipeline.status === "active") return "active";
  }
  
  return "idle";
}

/**
 * Get a quick summary of beads across all pipelines.
 */
function getBeadSummary(project: ProjectState) {
  let total = 0;
  let active = 0;
  let done = 0;
  let error = 0;

  for (const pipeline of project.pipelines.values()) {
    for (const bead of pipeline.beads.values()) {
      total++;
      if (bead.stage === "done") done++;
      else if (bead.stage === "error") error++;
      else if (bead.agentSessionId) active++;
    }
  }

  return { total, active, done, error };
}

export function ProjectSection({ project }: ProjectSectionProps) {
  const [isOpen, setIsOpen] = useState(true);
  const pipelines = Array.from(project.pipelines.values());
  const cardStatus = getCardStatus(project);
  const beadSummary = useMemo(() => getBeadSummary(project), [project]);
  
  // Track expanded/compact state per pipeline (default: compact)
  const [expandedPipelines, setExpandedPipelines] = useState<Set<string>>(() => {
    // Load from localStorage
    const stored = localStorage.getItem("dashboard:expandedPipelines");
    if (stored) {
      try {
        return new Set(JSON.parse(stored));
      } catch {
        return new Set();
      }
    }
    return new Set();
  });
  
  // Persist to localStorage when state changes
  useEffect(() => {
    localStorage.setItem(
      "dashboard:expandedPipelines",
      JSON.stringify(Array.from(expandedPipelines))
    );
  }, [expandedPipelines]);
  
  const togglePipeline = (pipelineId: string) => {
    setExpandedPipelines((prev) => {
      const next = new Set(prev);
      if (next.has(pipelineId)) {
        next.delete(pipelineId);
      } else {
        next.add(pipelineId);
      }
      return next;
    });
  };

  /** Status icon for the card header */
  const StatusIcon = cardStatus === "active" 
    ? Activity 
    : cardStatus === "disconnected" 
      ? WifiOff 
      : Pause;

  return (
    <article className="project-card" data-status={cardStatus} aria-label={project.projectName}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        {/* Card header */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-expanded={isOpen}
            className={cn(
              "flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/30",
              FOCUS_RING,
            )}
          >
            {/* Expand/collapse chevron */}
            <ChevronRight
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
                isOpen && "rotate-90",
              )}
            />

            {/* Status icon */}
            <StatusIcon
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                cardStatus === "active" && "text-green-400",
                cardStatus === "idle" && "text-muted-foreground",
                cardStatus === "disconnected" && "text-red-400",
              )}
            />

            {/* Project name + path */}
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-foreground">
                {project.projectName}
              </h2>
              <span className="block truncate text-[11px] text-muted-foreground/70">
                {project.projectPath}
              </span>
            </div>

            {/* Bead summary chips */}
            {beadSummary.total > 0 && (
              <div className="hidden items-center gap-1.5 sm:flex">
                {beadSummary.active > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
                    {beadSummary.active} active
                  </span>
                )}
                {beadSummary.done > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-400">
                    {beadSummary.done} done
                  </span>
                )}
                {beadSummary.error > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">
                    {beadSummary.error} err
                  </span>
                )}
              </div>
            )}

            {/* Connection status badge */}
            <ConnectionBadge
              connected={project.connected}
              lastHeartbeat={project.lastHeartbeat}
            />
          </button>
        </CollapsibleTrigger>

        {/* Pipeline content */}
        <CollapsibleContent>
          <div className="border-t border-border/50 px-4 pb-4 pt-2">
            {pipelines.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No active pipelines
              </p>
            ) : (
              pipelines.map((pipeline, index) => (
                <div key={pipeline.id}>
                  {index > 0 && <Separator className="my-3" />}
                  <PipelineHeader 
                    pipeline={pipeline}
                    isExpanded={expandedPipelines.has(pipeline.id)}
                    onToggle={() => togglePipeline(pipeline.id)}
                  />
                  {/* Collapsed view: segmented progress bar */}
                  {!expandedPipelines.has(pipeline.id) && (
                    <PipelineProgress
                      pipeline={pipeline}
                      columns={project.columns}
                    />
                  )}
                  {/* Expanded view: filtered Kanban board */}
                  <Board 
                    pipeline={pipeline}
                    isExpanded={expandedPipelines.has(pipeline.id)}
                    columns={project.columns}
                  />
                </div>
              ))
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}

/** Connection status badge with dot indicator */
function ConnectionBadge({
  connected,
  lastHeartbeat,
}: {
  connected: boolean;
  lastHeartbeat: number;
}) {
  // Tick every 10s to keep "last seen" time fresh when disconnected
  const [, setTick] = useState(0);
  useEffect(() => {
    if (connected) return;
    const timer = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(timer);
  }, [connected]);

  if (connected) {
    return (
      <Badge
        variant="outline"
        className="shrink-0 gap-1.5 border-green-500/50 bg-green-500/10 text-green-400"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
        Connected
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="shrink-0 gap-1.5 border-red-500/50 bg-red-500/10 text-red-400"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
      <span className="hidden sm:inline">Disconnected ·</span> {formatLastSeen(lastHeartbeat)}
    </Badge>
  );
}
