/**
 * LoadingSkeleton — Placeholder skeleton shown during initial SSE connection.
 *
 * Mimics the layout of the project card grid to avoid layout shift
 * when data loads. Shows 3 skeleton cards in the responsive grid.
 */

import { Skeleton } from "@/components/ui/skeleton";

export function LoadingSkeleton() {
  return (
    <div className="project-grid">
      {Array.from({ length: 3 }).map((_, cardIndex) => (
        <div
          key={cardIndex}
          className="project-card"
          data-status="idle"
        >
          {/* Card header skeleton */}
          <div className="flex items-center gap-3 px-4 py-3.5">
            <Skeleton className="h-4 w-4 shrink-0" />
            <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-6 w-24 shrink-0 rounded-full" />
          </div>

          {/* Pipeline content skeleton */}
          <div className="border-t border-border/50 px-4 pb-4 pt-2">
            {/* Pipeline header */}
            <div className="flex items-center gap-3 py-2">
              <Skeleton className="h-6 w-16 rounded" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-12 rounded-full" />
            </div>

            {/* Board columns */}
            <div className="flex gap-3 overflow-x-auto scrollbar-thin">
              {Array.from({ length: cardIndex === 0 ? 4 : 3 }).map((_, colIndex) => (
                <div
                  key={colIndex}
                  className="flex w-[240px] min-w-[240px] flex-col rounded-lg border bg-muted/30 p-3"
                >
                  <Skeleton className="mb-3 h-4 w-20" />
                  {colIndex < 2 && (
                    <div className="space-y-2">
                      <Skeleton className="h-16 w-full rounded-lg" />
                      {colIndex === 0 && <Skeleton className="h-16 w-full rounded-lg" />}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
