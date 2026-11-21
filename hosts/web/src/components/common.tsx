// Shared page-level pieces: severity icon, range control, view-as-table toggle,
// error and loading states.

import type { CSSProperties, ReactNode } from 'react';
import type { Range, Severity } from '../api/types';
import { RANGES } from '../api/types';
import { t } from '../lib/i18n';
import { SegmentedControl } from './controls';
import { Icon } from './Icon';

export function SeverityIcon({ severity, size = 20 }: { severity: Severity; size?: number }) {
  return severity === 'critical' ? (
    <span style={{ color: 'var(--critical-text)', display: 'inline-flex' }}>
      <Icon name="critical" size={size} label={t('Critical')} />
    </span>
  ) : (
    <span style={{ color: 'var(--warning)', display: 'inline-flex' }}>
      <Icon name="warning" size={size} label={t('Warning')} />
    </span>
  );
}

export function RangeControl({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return <SegmentedControl label={t('Time range')} value={value} onChange={onChange} options={RANGES.map((r) => ({ value: r, label: r }))} />;
}

export function ViewAsTableToggle({ showTable, onToggle, chart }: { showTable: boolean; onToggle: () => void; chart: string }) {
  return (
    <button type="button" className="view-toggle" aria-pressed={showTable} aria-label={showTable ? t('View {chart} as chart', { chart }) : t('View {chart} as table', { chart })} onClick={onToggle}>
      <Icon name={showTable ? 'chart' : 'table'} size={14} />
      {showTable ? t('View as chart') : t('View as table')}
    </button>
  );
}

export function ErrorCard({ title, error, onRetry }: { title: string; error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="card empty-card" role="alert">
      <div className="h2">{title}</div>
      <div className="ink-2">{msg}</div>
      {onRetry && (
        <button type="button" className="btn-ghost" onClick={onRetry}>
          {t('Retry')}
        </button>
      )}
    </div>
  );
}

export function Skeleton({ height, style }: { height: number | string; style?: CSSProperties }) {
  return <div className="skeleton" style={{ height, ...style }} aria-hidden="true" />;
}

export function LoadingRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div aria-busy="true" aria-label={label} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}
