import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatPercent(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function formatPrice(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(digits);
}

/** 数值符号 → tailwind class:涨/跌/中性。A 股惯例:红涨绿跌。 */
export function changeColor(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0 || Number.isNaN(v)) return 'text-muted-foreground';
  return v > 0 ? 'text-[color:var(--destructive)]' : 'text-[color:var(--success)]';
}
