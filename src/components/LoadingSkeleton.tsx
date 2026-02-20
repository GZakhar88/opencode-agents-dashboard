/**
 * LoadingSkeleton — Placeholder skeleton shown during initial SSE connection.
 *
 * Mimics the layout of a project section with pipeline header and columns
 * to avoid layout shift when data loads.
 */

import { Skeleton } from "@/components/ui/skeleton";

export function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      {/* Project header skeleton */}
      <div className="flex items-center gap-3 px-4 py-3">
        <Skeleton className="h-4 w-4" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-64" />
        <span className="flex-1" />
        <Skeleton className="h-6 w-24 rounded-full" />
      </div>

      {/* Pipeline header skeleton */}
      <div className="flex items-center gap-3 pl-11">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-12 rounded-full" />
      </div>

      {/* Columns skeleton */}
      <div className="flex gap-3 overflow-x-auto pl-11 scrollbar-thin">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex w-[240px] min-w-[240px] flex-col rounded-lg border bg-muted/30 p-3"
          >
            <Skeleton className="mb-3 h-4 w-20" />
            <div className="space-y-2">
              {i < 3 && <Skeleton className="h-20 w-full rounded-lg" />}
              {i < 2 && <Skeleton className="h-20 w-full rounded-lg" />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
