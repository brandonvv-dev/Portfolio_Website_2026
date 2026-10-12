/**
 * Number, time and row helpers for the back office. Nothing is imported, so the browser script
 * (src/scripts/admin.ts) can share them with the server-rendered components.
 */

const integer = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

export const num = (n: number): string => integer.format(Math.round(n));
export const dec = (n: number): string => decimal.format(n);

/** Share of a whole as a short percentage; under one percent reads '<1%'. */
export function share(part: number, whole: number): string {
  if (!whole || !part) return '0%';
  const ratio = (part / whole) * 100;
  return ratio < 1 ? '<1%' : `${ratio < 10 ? dec(ratio) : num(ratio)}%`;
}

/** Seconds as '45s' or '3m 05s'; nothing measured reads as a dash. */
export function dur(secs: number): string {
  if (!secs) return '-';
  const whole = Math.round(secs);
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}

/** A lap in milliseconds as m:ss.s. */
export function lap(ms: number): string {
  const tenths = Math.round(ms / 100);
  return `${Math.floor(tenths / 600)}:${String(Math.floor((tenths % 600) / 10)).padStart(2, '0')}.${tenths % 10}`;
}

export interface Delta {
  text: string;
  dir: 'up' | 'down' | 'flat' | 'none';
}

/** Change against the previous period: relative percent, or whole points for values that are already percents. */
export function delta(now: number, before: number, points = false): Delta {
  if (!now && !before) return { text: '-', dir: 'none' };
  if (points) {
    const change = Math.round(now - before);
    return { text: `${change > 0 ? '+' : ''}${change} pts`, dir: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' };
  }
  if (!before) return { text: 'new', dir: 'up' };
  const change = ((now - before) / before) * 100;
  if (Math.abs(change) < 0.5) return { text: '0%', dir: 'flat' };
  return { text: `${change > 0 ? '+' : '-'}${num(Math.abs(change))}%`, dir: change > 0 ? 'up' : 'down' };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** 'yyyy-mm-dd' as '12 Oct'. */
export function dayLabel(day: string): string {
  const [, month = '1', date = '1'] = day.split('-');
  return `${Number(date)} ${MONTHS[Number(month) - 1] ?? ''}`;
}

/** Weekday of a 'yyyy-mm-dd' day, Monday 0. */
export const weekdayOf = (day: string): number => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

/** Relative time: 'now', '40s ago', '12m ago', '5h ago', '3d ago'. */
export function ago(at: number, now: number): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 5) return 'now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

/** One line of a ranked list. */
export interface Row {
  label: string;
  /** A second, quieter line: the host, the slug. */
  sub?: string;
  value: number;
  extra?: string;
  note?: string;
  /** A small outlined word after the label. */
  tag?: string;
}

/** An ordered funnel as rows: each step against the first, with the drop from the step before. */
export function funnel(steps: readonly { label: string; value: number }[]): Row[] {
  return steps.map((step, i) => {
    const before = steps[i - 1]?.value ?? 0;
    return {
      ...step,
      note: i && before ? `${step.value >= before ? '+' : '-'}${num((Math.abs(step.value - before) / before) * 100)}%` : '',
    };
  });
}

/** What the live endpoint sends and the LIVE tab shows. */
export interface LiveRow {
  /** Unix ms. */
  at: number;
  /** The first four characters of the day-salted visitor hash: enough to tell two visitors apart. */
  who: string;
  category: 'view' | 'section' | 'click' | 'game';
  path: string;
  what: string;
  country: string;
  device: string;
}
export interface LiveView {
  /** Server time in unix ms, so relative times do not depend on this computer's clock. */
  now: number;
  /** Distinct visitors with a hit in the last 5, 30 and 60 minutes. */
  m5: number;
  m30: number;
  m60: number;
  /** Hits per minute for the last hour, oldest first; the last bar is the minute just ended. */
  bars: number[];
  /** The newest hits, newest first. */
  hits: LiveRow[];
}
