/**
 * The storage kinds' tests share these (service-dashboards.md SD-50…SD-57): recorded answers from `fixtures/` (trimmed
 * real ones where the service ran in a throwaway container, else from its documented answers), and a check that a view
 * fits the page's contract, so a figure, panel or line the clients would refuse fails the test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ThingImage, ThingLine, ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import type { Services } from '../../../services';
import type { KindView } from '../types';

/** A recorded answer from `fixtures/<name>`. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));
}

/** A recorded text answer (QNAP's XML). */
export function fixtureText(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

/** Parses every figure, line, panel and head fact of a view with the contract's schemas; answers the view. */
export function checked(view: KindView): KindView {
  for (const k of view.kpis ?? []) ThingPageKpi.parse(k);
  for (const n of view.notices) ThingPageNotice.parse(n);
  for (const p of view.panels) ThingPagePanel.parse(p);
  for (const c of view.charts ?? []) ThingPagePanel.parse(c);
  for (const f of view.facts) ThingLine.parse(f);
  return view;
}

/** A panel of the view by id. */
export function panel<K extends ThingPagePanel['kind']>(
  view: KindView,
  id: string,
  kind: K,
): Extract<ThingPagePanel, { kind: K }> | undefined {
  const p = view.panels.find((x) => x.id === id);
  return p && p.kind === kind ? (p as Extract<ThingPagePanel, { kind: K }>) : undefined;
}

/** A figure's value by key. */
export const kpi = (view: KindView, key: string) => view.kpis?.find((k) => k.key === key);

/** Services for a pure read through mocked calls: only the clock and an identity for the read cache. */
export function fakeServices(now: Date): Services {
  return { clock: () => now } as unknown as Services;
}

/** A picture whose ref carries its path (the real ones are signed, `images.ts`); `picturePath` reads it back. */
export function fakePicture(path: string, alt: string, shape: ThingImage['shape']): ThingImage {
  return { ref: `${Buffer.from(path).toString('base64url')}.signature`, alt, shape };
}

/** The path a fake picture names. */
export function picturePath(image: ThingImage | undefined): string | null {
  return image ? Buffer.from(image.ref.split('.')[0] ?? '', 'base64url').toString('utf8') : null;
}
