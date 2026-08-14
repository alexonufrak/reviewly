import type { Label } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface Props {
  label: Label;
  className?: string;
}

/**
 * Render a GitHub label as a soft, truly borderless chip.
 *
 * A PR header can carry a dozen of these side by side, so an outline on each
 * one is the single biggest source of visual noise in the app — a row of tiny
 * caged boxes. The chip reads by FILL alone: a tint of the label's own color,
 * strong enough to hold its shape without a ring, plus text in that same hue.
 */
export function LabelChip({ label, className }: Props) {
  const hex = normalizeHex(label.color);
  const isLight =
    typeof document !== "undefined" && document.documentElement.classList.contains("light");
  // Tint carries the whole chip now that nothing outlines it, so it's stronger
  // than it was — enough that even a pale label holds its shape against the
  // surface. Light mode needs more: a faint wash over near-white disappears.
  const bg = hexToRgba(hex, isLight ? 0.24 : 0.17);
  const fg = readableTextColor(hex, isLight);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium leading-normal tracking-tight",
        className,
      )}
      style={{ background: bg, color: fg }}
      aria-label={label.description ?? label.name}
    >
      {label.name}
    </span>
  );
}

function normalizeHex(c: string | null | undefined): string {
  if (!c) return "888888";
  return c.replace(/^#/, "").padEnd(6, "0").slice(0, 6);
}

function hexToRgba(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function readableTextColor(hex: string, isLight: boolean): string {
  const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const hue = rgbToHue(r, g, b);
  // Grey/neutral labels have ~no saturation — hue is meaningless, so tint them
  // with neutral text instead of an accidental red (hue 0).
  const grey = Math.max(r, g, b) - Math.min(r, g, b) < 0.08;

  if (isLight) {
    // Dark, saturated text reads on the pale tint over a white surface.
    if (grey) return "oklch(0.42 0.01 65)";
    return `hsl(${hue}deg 72% 30%)`;
  }
  // Dark UI: keep text bright + saturated against the faint tint.
  if (grey) return lum < 0.12 ? "oklch(0.78 0.005 65)" : "oklch(0.74 0.005 65)";
  if (lum < 0.4) return `hsl(${hue}deg 75% 78%)`;
  return `hsl(${hue}deg 65% 82%)`;
}

function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h = 0;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    case b:
      h = (r - g) / d + 4;
      break;
  }
  return Math.round(h * 60);
}
