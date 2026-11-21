// Small shared building blocks: segmented control, status dot, meter, chips.

import type { CSSProperties, ReactNode } from 'react';

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Visually quieter count after the label ("Production 4"). */
  count?: number;
  /** Shown but not selectable (e.g. a console protocol Rackoon cannot serve); `title` gives the reason. */
  disabled?: boolean;
  title?: string;
}

interface SegProps<T extends string> {
  label: string;
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}

/** Segmented control: role="group" with an aria-label, aria-pressed on each option. */
export function SegmentedControl<T extends string>({ label, options, value, onChange, className }: SegProps<T>) {
  return (
    <div className={className ? `seg ${className}` : 'seg'} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          // aria-disabled keeps the option focusable so its reason (title) can be read.
          aria-disabled={o.disabled || undefined}
          title={o.title}
          onClick={() => !o.disabled && o.value !== value && onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && (
            <>
              {' '}
              <span className="count">{o.count}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

/** 8 px status dot. Always decorative: the adjacent text states the status. */
export function Dot({ color, style }: { color: string; style?: CSSProperties }) {
  return <span className="dot" aria-hidden="true" style={{ background: color, ...style }} />;
}

interface MeterProps {
  /** 0..100 fill width. */
  pct: number;
  color: string;
  /** Tick position (0..100), e.g. the 1 : 1 mark on the vCPU meter. */
  tick?: number;
  width?: number | string;
  style?: CSSProperties;
  className?: string;
}

/** 6 px meter on the blue-tinted track. Decorative: the value is printed beside it. */
export function Meter({ pct, color, tick, width, style, className }: MeterProps) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <span className={className ? `track ${className}` : 'track'} aria-hidden="true" style={{ width, ...style }}>
      <span className="fill" style={{ width: `${w}%`, background: color }} />
      {tick !== undefined && <span className="tick" style={{ left: `${tick}%` }} />}
    </span>
  );
}

export function Chip({ children, dot, className, title }: { children: ReactNode; dot?: string; className?: string; title?: string }) {
  return (
    <span className={className ? `chip ${className}` : 'chip'} title={title}>
      {dot && <Dot color={dot} />}
      {children}
    </span>
  );
}

/** Segmented state bar (Running / Stopped / Unhealthy) sized by count with 2 px gaps. */
export function StateBar({ segments }: { segments: { n: number; color: string }[] }) {
  const parts = segments.filter((s) => s.n > 0);
  return (
    <div className="state-bar" aria-hidden="true">
      {parts.length === 0 ? (
        <div style={{ flex: '1 1 0', background: 'var(--track)' }} />
      ) : (
        parts.map((s, i) => <div key={i} style={{ flex: `${s.n} 1 0`, background: s.color }} />)
      )}
    </div>
  );
}
