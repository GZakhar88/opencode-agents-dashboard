import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Convert a hex color string to an rgba() CSS value with the given alpha.
 *
 * Handles 6-digit hex with or without leading "#".
 * Returns a neutral gray fallback if parsing fails.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace("#", "");
  const r = parseInt(cleaned.substring(0, 2), 16);
  const g = parseInt(cleaned.substring(2, 4), 16);
  const b = parseInt(cleaned.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return `rgba(128, 128, 128, ${alpha})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
