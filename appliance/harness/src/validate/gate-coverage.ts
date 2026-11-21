/** A successful root Go check covers the identical check in a subdirectory of the same source commit. */
import type { Component } from '../manifest/pins.ts';

export const gateId = (component: string, gate: string) => `${component}:${gate}`;

export function gateCoverage(components: Component[], only: string[] | null) {
  const selected = components.flatMap((c) =>
    c.gates
      .filter((g) => !only || only.includes(c.id) || only.includes(gateId(c.id, g.id)))
      .map((g) => ({ c, g })),
  );
  const sameInputs = (g: Component['gates'][number]) =>
    JSON.stringify({
      run: g.run,
      env: Object.fromEntries(Object.entries(g.env).sort()),
      timeoutS: g.timeoutS,
      needsPostgres: g.needsPostgres,
    });
  const roots = selected.filter(
    ({ c, g }) =>
      c.repository === 'whombat-appliance' &&
      g.cwd === '.' &&
      g.run[0] === 'go' &&
      ['vet', 'test'].includes(g.run[1] ?? '') &&
      g.run.at(-1) === './...',
  );
  const coverage = new Map<string, { component: string; gate: string }>();
  for (const { c, g } of selected) {
    if (!['backup', 'provisioning'].includes(g.cwd)) continue;
    const root = roots.find(
      (r) =>
        r.c.id !== c.id &&
        r.c.repository === c.repository &&
        r.c.commit === c.commit &&
        sameInputs(r.g) === sameInputs(g),
    );
    if (root) coverage.set(gateId(c.id, g.id), { component: root.c.id, gate: root.g.id });
  }
  return coverage;
}
