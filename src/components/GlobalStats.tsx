/**
 * GlobalStats — Aggregate dashboard statistics for the command bar header.
 *
 * Displays color-coded metrics across all projects:
 *   - Active projects (status-live / green)
 *   - Idle projects (muted / gray)
 *   - Beads in progress (status-warning / amber)
 *   - Errors (status-error / red)
 *
 * Each stat is a compact, dense chip optimized for quick scanning.
 */

import { useMemo } from "react";
import type { ProjectState } from "@shared/types";
import { Activity, Pause, CircleDot, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface GlobalStatsProps {
  projects: ProjectState[];
}

interface AggregateStats {
  activeProjects: number;
  idleProjects: number;
  beadsInProgress: number;
  totalErrors: number;
}

function computeStats(projects: ProjectState[]): AggregateStats {
  let activeProjects = 0;
  let idleProjects = 0;
  let beadsInProgress = 0;
  let totalErrors = 0;

  for (const project of projects) {
    if (!project.connected) continue;

    let isActive = false;
    for (const pipeline of project.pipelines.values()) {
      if (pipeline.status === "active") {
        isActive = true;
      }
      for (const bead of pipeline.beads.values()) {
        if (bead.stage !== "done" && bead.stage !== "error") {
          beadsInProgress++;
        }
        if (bead.stage === "error") {
          totalErrors++;
        }
      }
    }

    if (isActive) {
      activeProjects++;
    } else {
      idleProjects++;
    }
  }

  return { activeProjects, idleProjects, beadsInProgress, totalErrors };
}

export function GlobalStats({ projects }: GlobalStatsProps) {
  const stats = useMemo(() => computeStats(projects), [projects]);

  // Don't render anything if there are no connected projects
  if (stats.activeProjects === 0 && stats.idleProjects === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1" role="status" aria-label="Dashboard statistics">
      <StatChip
        icon={Activity}
        value={stats.activeProjects}
        label="active"
        colorClass="text-status-live"
        bgClass="bg-status-live/10"
        show={stats.activeProjects > 0}
      />
      <StatChip
        icon={Pause}
        value={stats.idleProjects}
        label="idle"
        colorClass="text-muted-foreground"
        bgClass="bg-muted/50"
        show={stats.idleProjects > 0}
      />
      <StatChip
        icon={CircleDot}
        value={stats.beadsInProgress}
        label="in progress"
        colorClass="text-status-warning"
        bgClass="bg-status-warning/10"
        show={stats.beadsInProgress > 0}
      />
      <StatChip
        icon={AlertTriangle}
        value={stats.totalErrors}
        label={stats.totalErrors === 1 ? "error" : "errors"}
        colorClass="text-status-error"
        bgClass="bg-status-error/10"
        show={stats.totalErrors > 0}
        urgent
      />
    </div>
  );
}

/** Individual stat chip — dense, monospace-feeling, color-coded */
function StatChip({
  icon: Icon,
  value,
  label,
  colorClass,
  bgClass,
  show,
  urgent = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: number;
  label: string;
  colorClass: string;
  bgClass: string;
  show: boolean;
  urgent?: boolean;
}) {
  if (!show) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px] font-medium tabular-nums leading-none",
        bgClass,
        colorClass,
        urgent && "motion-safe:animate-pulse",
      )}
      aria-label={`${value} ${label}`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="font-semibold">{value}</span>
      <span className="hidden sm:inline opacity-70">{label}</span>
    </span>
  );
}
