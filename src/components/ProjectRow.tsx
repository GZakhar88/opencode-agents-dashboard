/**
 * ProjectRow — Renders 1-3 project cards in a single grid row.
 *
 * Each row independently decides its column count based on the number
 * of children, so every row fills the full available width:
 *   1 child  → full width
 *   2 children → 50/50
 *   3 children → 33/33/33
 *
 * This eliminates orphan gaps in the last row — if 4 projects exist
 * in a 3-column layout, row 1 gets 3 cards and row 2 gets 1 card
 * that spans the full width.
 */

interface ProjectRowProps {
  columns: number;
  children: React.ReactNode;
}

export function ProjectRow({ columns, children }: ProjectRowProps) {
  return (
    <div
      className="grid gap-5"
      style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
    >
      {children}
    </div>
  );
}
