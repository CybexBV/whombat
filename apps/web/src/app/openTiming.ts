/** Content-free opening timings, kept in this tab only. The browser's Performance panel shows the same phases. */
export type OpenPhase = 'selected' | 'welcome' | 'bootstrap' | 'rooms' | 'history' | 'content';

export interface OpenTiming {
  mark(phase: OpenPhase): void;
}

interface OpenSample {
  prepared: boolean;
  phasesMs: Partial<Record<OpenPhase, number>>;
  connectionMs: number | null;
  dataMs: number | null;
  totalMs: number | null;
}

const samples: { prefix: string; phases: Partial<Record<OpenPhase, number>> }[] = [];
let sequence = 0;

declare global {
  interface Window {
    /** Local opening measurements only: no names, identifiers, addresses, tokens or conversation content. */
    __WHOMBAT_OPEN_TIMINGS__?: () => OpenSample[];
  }
}

export function readOpenTimings(): OpenSample[] {
  return samples.flatMap(({ phases }) => {
    const selected = phases.selected;
    if (selected === undefined) return [];
    const welcome = phases.welcome;
    const content = phases.content;
    return [
      {
        prepared: welcome !== undefined && welcome < selected,
        phasesMs: Object.fromEntries(
          Object.entries(phases).map(([phase, at]) => [phase, Math.round(at - selected)]),
        ),
        connectionMs: welcome === undefined ? null : Math.round(Math.max(0, welcome - selected)),
        dataMs:
          content === undefined || welcome === undefined
            ? null
            : Math.round(content - Math.max(selected, welcome)),
        totalMs: content === undefined ? null : Math.round(content - selected),
      },
    ];
  });
}

export function clearOpenTimings(): void {
  for (const { prefix, phases } of samples)
    for (const phase of Object.keys(phases)) performance.clearMarks?.(`${prefix}.${phase}`);
  samples.length = 0;
}

export function createOpenTiming(): OpenTiming {
  const sample = { prefix: `whombat.open.${++sequence}`, phases: {} as Partial<Record<OpenPhase, number>> };
  // Unselected preparations are kept out of the export. Bound marks and memory during a long-lived tab, too.
  samples.push(sample);
  if (samples.length > 10) {
    const old = samples.shift();
    if (old) for (const phase of Object.keys(old.phases)) performance.clearMarks?.(`${old.prefix}.${phase}`);
  }
  if (typeof window !== 'undefined') window.__WHOMBAT_OPEN_TIMINGS__ = readOpenTimings;
  return {
    mark(phase) {
      if (sample.phases[phase] !== undefined || !samples.includes(sample)) return;
      sample.phases[phase] = performance.now();
      performance.mark?.(`${sample.prefix}.${phase}`);
    },
  };
}
