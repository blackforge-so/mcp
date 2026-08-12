// Value formatting for the widget's axis and hover readout.
//
// VENDORED SUBSET of `dashboard/src/components/charts/format-value.utils.ts`
// and `dashboard/src/lib/duration.ts` — see the origin note in `quality.ts`.
// The alignment and normalization helpers are deliberately absent: the widget
// draws exactly one metric, so there is no union axis to align onto and no
// second unit to normalize against.

const EMPTY = "—";

const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function groupedDecimals(value: number, maxDecimals: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}

/** Prices below 1 need six places or every altcoin reads as 0.00. */
function priceDecimals(value: number): number {
  return Math.abs(value) >= 1 ? 2 : 6;
}

/**
 * `lastTradeAgeTime` runs from a p50 of ~30 minutes to a p99 of ~30 hours, so a
 * bare "1,800s" is honest but hard to read.
 */
export function formatDurationSeconds(value: number): string {
  const total = Math.max(0, Math.round(value));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function formatAxisValue(value: number, unit: string): string {
  if (Number.isNaN(value)) return EMPTY;

  if (unit === "bool") return value ? "yes" : "no";
  // Durations are shown as a compact human span, never as a magnitude, so they
  // must skip the abs>=10000 compact-number path below.
  if (unit === "seconds") return formatDurationSeconds(value);

  if (Math.abs(value) >= 10000) {
    return unit === "percent" ? `${COMPACT.format(value)}%` : COMPACT.format(value);
  }

  switch (unit) {
    case "ms":
    case "count":
      return groupedDecimals(Math.round(value), 0);
    case "ratio":
      return groupedDecimals(value, 4);
    case "percent":
      return `${groupedDecimals(value, 2)}%`;
    default:
      return groupedDecimals(value, 2);
  }
}

export function formatReadoutValue(value: number | null | undefined, unit: string): string {
  if (value == null || Number.isNaN(value)) return EMPTY;

  switch (unit) {
    case "price":
    case "quote":
      return groupedDecimals(value, priceDecimals(value));
    case "usd":
      return `$${groupedDecimals(value, priceDecimals(value))}`;
    case "ms":
      return `${groupedDecimals(Math.round(value), 0)} ms`;
    case "seconds":
      return formatDurationSeconds(value);
    case "count":
      return groupedDecimals(Math.round(value), 0);
    case "ratio":
      return groupedDecimals(value, 4);
    case "percent":
      return `${groupedDecimals(value, 2)}%`;
    case "bool":
      return value ? "yes" : "no";
    case "base":
      return groupedDecimals(value, 4);
    case "index":
      return groupedDecimals(value, 2);
    default:
      return groupedDecimals(value, 2);
  }
}

/** Axis-appropriate timestamp label. The widget always renders one range at a time. */
export function formatTimestamp(ms: number, interval: string): string {
  const date = new Date(ms);
  if (interval === "1d") {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
