/** Markdown rendering of a validation report (exact commands, versions, outcomes; blocked is never passed). */
import type { ValidationReport } from './validate.ts';

const dur = (ms: number) =>
  ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
const cell = (s: unknown) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

export function renderMarkdown(r: ValidationReport): string {
  const out: string[] = [];
  out.push(`# Validation report ${r.runId}`, '');
  out.push(
    `Result: **${r.ok ? 'PASS' : 'NOT PASSING'}** · ${Object.entries(r.totals)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')}`,
    '',
  );
  out.push(
    `Started ${r.startedAt}, finished ${r.finishedAt}. Host: ${Object.entries(r.host)
      .map(([k, v]) => `${k} ${v}`)
      .join('; ')}.`,
    '',
  );
  out.push('## Manifest', '');
  out.push(`Pins: \`${r.manifest.pinsFile ?? 'manifest/pins.json'}\``, '');
  out.push(
    `Product ${r.manifest.productVersion}: ${r.manifest.ok ? 'valid (ProductManifest schema, pins, clean-clone build report)' : 'INVALID'}.`,
  );
  for (const s of r.manifest.summary) out.push(`- ${s}`);
  for (const p of r.manifest.problems) out.push(`- ✗ ${p}`);
  out.push('', '| Component | Repository | Ref | Commit |', '|---|---|---|---|');
  for (const p of r.pins) out.push(`| ${p.id} | ${p.repository} | ${p.ref} | \`${p.commit}\` |`);
  if (r.environment) {
    out.push('', `Environment (${r.environment.mode}):`);
    for (const [k, v] of Object.entries(r.environment.sources)) out.push(`- ${k}: \`${v}\``);
  }
  out.push('', '## Repository gates (exact pinned commits; cached successes are identified)', '');
  if (!r.gates.length) out.push('Not run in this validation (`--skip-gates`).');
  else {
    out.push('| Component | Gate | Command | Outcome | Duration | Summary |', '|---|---|---|---|---|---|');
    for (const g of r.gates)
      out.push(
        `| ${g.component} \`${g.commit.slice(0, 12)}\` | ${g.gate} | \`${cell(g.command)}\` (in \`${g.cwd}\`) | ${g.outcome}${g.coveredBy ? ' (covered)' : g.reused ? ' (reused)' : ''} | ${dur(g.durationMs)} | ${cell(g.summary)}${g.coveredBy ? `; covered by ${g.coveredBy.component}:${g.coveredBy.gate} running ${cell(g.coveredBy.command)} at the module root` : ''}${g.reused ? `; verified ${g.reused.finishedAt}, original ${dur(g.reused.durationMs)}, receipt ${g.reused.key}` : ''} |`,
      );
  }
  if (r.harness)
    out.push(
      '',
      `Harness: \`${r.harness.command}\` in harness/ — ${r.harness.outcome} (${dur(r.harness.durationMs)}; ${cell(r.harness.summary)}).`,
    );
  out.push('', '## Scenarios', '');
  if (!r.scenarios.length) out.push('Not run in this validation.');
  else {
    out.push('| Scenario | Outcome | Duration | Detail |', '|---|---|---|---|');
    for (const s of r.scenarios)
      out.push(
        `| ${cell(s.name)} | ${s.outcome === 'blocked' ? `blocked: ${cell(s.blocked)}` : s.outcome} | ${dur(s.durationMs)} | ${cell(s.error ?? '')} |`,
      );
  }
  if (r.measurements.length) {
    out.push('', '## Measurements (local; conditions per row)', '');
    out.push(
      '| Measurement | n | p50 | p95 | p99 | max | failures | extra |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const m of r.measurements) {
      const {
        name,
        n,
        p50,
        p95,
        p99,
        max,
        failures,
        unit,
        kind: _k,
        test: _t,
        at: _a,
        where: _w,
        target: _g,
        mean: _m,
        ...extra
      } = m as Record<string, unknown>;
      const v = (x: unknown) => (x === undefined ? '–' : `${x} ${unit ?? ''}`.trim());
      out.push(
        `| ${cell(name)} | ${n ?? '–'} | ${v(p50)} | ${v(p95)} | ${v(p99)} | ${v(max)} | ${failures ?? 0} | ${cell(JSON.stringify(extra))} |`,
      );
    }
    const where = (r.measurements[0] as { where?: string }).where;
    if (where)
      out.push('', `Conditions: ${where}. Regional targets (assignment §14) are not measured locally.`);
  }
  if (r.soak) {
    const k = r.soak as {
      durationS?: number;
      ok?: boolean;
      reasons?: string[];
      traffic?: Record<string, number>;
      services?: Record<string, Record<string, unknown>>;
    };
    out.push('', `## Soak (${Math.round((k.durationS ?? 0) / 60)} min): ${k.ok ? 'passed' : 'FAILED'}`, '');
    for (const reason of k.reasons ?? []) out.push(`- ✗ ${cell(reason)}`);
    if (k.traffic)
      out.push(
        `Traffic: ${Object.entries(k.traffic)
          .map(([a, b]) => `${a} ${b}`)
          .join(', ')}.`,
        '',
      );
    out.push(
      '| Service | first (MiB) | last (MiB) | max (MiB) | growth (MiB) | restarts | verdict |',
      '|---|---|---|---|---|---|---|',
    );
    for (const [name, v] of Object.entries(k.services ?? {}))
      out.push(
        `| ${name} | ${v.firstMiB ?? '–'} | ${v.lastMiB ?? '–'} | ${v.maxMiB ?? '–'} | ${v.growthMiB ?? '–'} | ${v.restarts} | ${v.verdict} |`,
      );
    out.push(
      '',
      'RSS summed over each service’s process group, every 15 s after a warm-up; series in `soak-series.json`.',
    );
  }
  if (r.gaps.length) {
    out.push('', '## Defects found in other components', '');
    for (const g of r.gaps)
      out.push(
        `- ${cell((g as { component?: string }).component)}: ${cell((g as { text?: string }).text)} (${cell((g as { test?: string }).test)})`,
      );
  }
  out.push(
    '',
    `Logs: \`harness/reports/${r.runId}/logs/\` (not committed). Scenario notes: \`scenario-records.jsonl\`.`,
    '',
  );
  return `${out.join('\n')}\n`;
}
