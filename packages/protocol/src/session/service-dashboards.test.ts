/**
 * Contracts 0.121.0, service dashboards over the session (Whombat service-dashboards.md SD-06, SD-07, SD-11; CT-1000,
 * CT-1006): a page's picture as a download, the buttons' body through `things.action`, and an older client's view of a
 * newer page.
 */
import { ThingPage } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { Open, StreamSpec } from './messages.js';
import { operationSafety } from './operation-safety.js';
import { API_OPERATIONS } from './operations.js';
import { decodeTolerant } from './tolerant.js';

const REF = 'eyJjIjoiY29uX3BsZXgiLCJzIjoiYyJ9.q3Vx9LpA0dZkT7mW2bNcYe';
const open = (resource: unknown) => ({ t: 'open', stream: 11, spec: { kind: 'download', resource } });

describe('a picture as a download (CT-1000)', () => {
  it('opens a thing’s picture by its ref', () => {
    const r = Open.safeParse(
      open({ type: 'thing-image', burrow: 'lumio-bv', thing: 'connection:con_plex', ref: REF }),
    );
    expect(r.success).toBe(true);
    const spec = StreamSpec.parse({
      kind: 'download',
      resource: { type: 'thing-image', burrow: 'lumio-bv', thing: 'connection:con_plex', ref: REF },
    });
    expect(spec.kind === 'download' && spec.resource.type).toBe('thing-image');
  });

  it('refuses a ref that isn’t one, a thing too long and a missing part', () => {
    for (const resource of [
      { type: 'thing-image', burrow: 'lumio-bv', thing: 'connection:con_plex', ref: 'short.ref' },
      {
        type: 'thing-image',
        burrow: 'lumio-bv',
        thing: 'connection:con_plex',
        ref: '../../etc/passwd.abcdefgh',
      },
      { type: 'thing-image', burrow: 'lumio-bv', thing: 'x'.repeat(221), ref: REF },
      { type: 'thing-image', burrow: 'lumio-bv', ref: REF },
      { type: 'thing-image', thing: 'connection:con_plex', ref: REF },
    ])
      expect(Open.safeParse(open(resource)).success, JSON.stringify(resource).slice(0, 80)).toBe(false);
  });
});

describe('buttons through things.action (CT-1006)', () => {
  it('carries the target and value, and stays an op that acts outside its receipt', () => {
    const op = API_OPERATIONS.get('things.action');
    expect(op?.mutating).toBe(true);
    expect(operationSafety('things.action')).toEqual({ destructive: true, retry: 'never' });
    const input = {
      params: { burrow: 'lumio-bv', thing: 'connection:con_ha' },
      body: { action: 'toggle', target: 'light.hall', value: false },
    };
    expect(op?.input.safeParse(input).success).toBe(true);
    const bad = { ...input, body: { action: 'toggle', target: 'light.hall', value: { on: false } } };
    expect(op?.input.safeParse(bad).success).toBe(false);
  });
});

describe('an older client meets a newer page (SD-11)', () => {
  const page = {
    id: 'connection:con_plex',
    kind: 'connection',
    name: 'Plex',
    icon: 'plex',
    status: 'ok',
    badge: 'Running fine',
    facts: [],
    runsOn: null,
    canManage: true,
    settings: true,
    actions: [],
    readAt: null,
    tabs: [
      {
        key: 'overview',
        label: 'Summary',
        panels: [
          { kind: 'kpis', id: 'figures', items: [{ key: 'movies', label: 'Movies', value: '1,284' }] },
          { kind: 'hologram', id: 'future', title: 'From a newer server' },
          {
            kind: 'gallery',
            id: 'recent',
            title: 'Recently added',
            shape: 'poster',
            items: [
              {
                id: '1',
                title: 'Dune: Part Two',
                actions: [{ action: 'play', label: 'Play', icon: 'teleport', allowed: true }],
              },
            ],
          },
          {
            kind: 'notices',
            id: 'worth',
            title: 'Worth a look',
            items: [{ id: 'n', tone: 'info', icon: 'satellite', title: 'A newer icon' }],
          },
        ],
      },
    ],
  };

  it('leaves out an unknown panel, unsets an unknown button icon and drops a line with an unknown icon', () => {
    const r = decodeTolerant(ThingPage, page);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const panels = r.data.tabs[0]?.panels ?? [];
    expect(panels.map((p) => p.kind)).toEqual(['kpis', 'gallery', 'notices']);
    const gallery = panels[1];
    expect(gallery?.kind === 'gallery' && gallery.items[0]?.actions?.[0]).toMatchObject({ action: 'play' });
    expect(gallery?.kind === 'gallery' && gallery.items[0]?.actions?.[0]?.icon).toBeUndefined();
    const notices = panels[2];
    expect(notices?.kind === 'notices' && notices.items).toEqual([]);
    expect(r.skipped.map((s) => s.value).sort()).toEqual(['hologram', 'satellite', 'teleport']);
  });
});
