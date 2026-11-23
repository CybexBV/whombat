/**
 * The thing pages' fixture world (connection-pages-web.md AP-1900…, dashboards-web.md AP-2050…): every page is what the
 * contract allows for every range, and the world answers like a server — the range in the query (an unknown one gives
 * 24 hours), Restart records a change, what a connection runs on can be chosen, and a part of a server says so.
 */
import { ThingPage } from '@whombat/core';
import { SetRunsOnResponse, ThingActionResponse } from '@whombat/core/contracts';
import { isAccountPageId } from '@whombat/core/domain';
import { burrow, createServicePages } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { createOneFixtures } from './oneFixtures';
import { createThingPageFixtures, HOME_ASSISTANT_THING } from './thingPageFixtures';

const B = `http://fixtures.local/api/v1/burrows/${burrow.slug}`;

function world() {
  const one = createOneFixtures({ now: () => Date.parse('2026-10-18T12:05:00Z') });
  return { one, pages: createThingPageFixtures(one) };
}

describe('thing page fixtures', () => {
  it('builds every page to the contract, for every range', () => {
    const { pages } = world();
    for (const range of ['1h', '6h', '24h', '7d', '30d'] as const)
      for (const id of [
        'connection:con_home-assistant',
        'connection:con_unifi',
        'connection:con_hetzner',
        'connection:con_fixture_tracker',
        'connection:con_pve-02-api',
        'connection:con_mara',
        'connection:con_findmy',
        'device:con_pool',
        'device:con_heat-pump',
      ]) {
        const page = pages.page(id, range);
        expect(page, id).not.toBeNull();
        const parsed = ThingPage.safeParse(page);
        expect(parsed.success ? null : parsed.error.issues.slice(0, 3), `${id} ${range}`).toBeNull();
      }
    expect(pages.page('server:pve-02')).toBeNull();
    expect(pages.page('connection:con_nope')).toBeNull();
  });

  it('answers the range asked for, and its default for one it doesn’t offer', async () => {
    const { pages } = world();
    const thing = encodeURIComponent('connection:con_home-assistant');
    const read = async (q: string) =>
      ThingPage.parse(
        await ((await pages.handle(new Request(`${B}/things/${thing}${q}`))) as Response).json(),
      );
    const week = await read('?range=7d');
    expect([week.range, week.ranges, week.refreshS]).toEqual(['7d', ['1h', '6h', '24h', '7d', '30d'], 60]);
    // In slots its week of automation runs is its own seven days, whatever the range.
    const runs = week.tabs[0]?.panels.find((p) => p.id === 'automations-week');
    expect(runs?.kind === 'chart' ? runs.labels?.length : 0).toBe(7);
    expect((await read('?range=90d')).range).toBe('24h');
    expect((await read('')).range).toBe('24h');
  });

  it('restarts Home Assistant as a person’s change and lets a person choose what it runs on', async () => {
    const { one, pages } = world();
    const thing = encodeURIComponent('connection:con_home-assistant');
    const res = (await pages.handle(
      new Request(`${B}/things/${thing}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action: 'restart' }),
      }),
    )) as Response;
    expect(res.status).toBe(202);
    const answer = ThingActionResponse.parse(await res.json());
    expect(answer.message).toBe('Restarting Home Assistant. It’s back in about a minute.');
    const changes = (await (
      (await one.handle(new Request(`${B}/changes?thing=${thing}`))) as Response
    ).json()) as { changes: { title: string }[] };
    expect(changes.changes[0]?.title).toBe('Restarted Home Assistant');

    const set = async (body: unknown) =>
      SetRunsOnResponse.parse(
        await (
          (await pages.handle(
            new Request(`${B}/connections/con_home-assistant/runs-on`, {
              method: 'POST',
              body: JSON.stringify(body),
            }),
          )) as Response
        ).json(),
      );
    expect((await set({ mode: 'none' })).runsOn).toBeNull();
    expect(pages.page('connection:con_home-assistant')?.runsOn).toBeNull();
    expect((await set({ mode: 'chosen', serverId: 'pve-01', guestId: null })).runsOn?.name).toBe('pve-01');
    expect((await set({ mode: 'auto' })).runsOn?.name).toBe('homeassistant (pve-02)');
  });

  it('answers the accounts’ pages, and lists each account once beside the service pages', async () => {
    const now = () => Date.parse('2026-10-18T12:05:00Z');
    const services = createServicePages({ now, homeAssistant: HOME_ASSISTANT_THING });
    const one = createOneFixtures({ now, moreThings: () => services.things() });
    const pages = createThingPageFixtures(one, { services });
    const ids = [
      'connection:con_mara',
      'connection:con_mail_mara_fastmail_com',
      'connection:github',
      'connection:feedback',
    ];
    for (const id of ids) {
      const res = (await pages.handle(new Request(`${B}/things/${encodeURIComponent(id)}`))) as Response;
      const page = ThingPage.parse(await res.json());
      expect([page.id, isAccountPageId(page.catalogId), page.settings]).toEqual([id, true, true]);
    }
    // The world's own Google is the same account as the service pages' one: listed once.
    const accounts = one.things().filter((t) => isAccountPageId(t.catalogId));
    expect(accounts.map((t) => t.id).sort()).toEqual([...ids].sort());
  });

  it('answers the service pages by address, and Home Assistant’s Controls, buttons and pictures with them (AP-4571)', async () => {
    const now = () => Date.parse('2026-10-18T12:05:00Z');
    const one = createOneFixtures({ now });
    const services = createServicePages({ now, homeAssistant: HOME_ASSISTANT_THING });
    const pages = createThingPageFixtures(one, { services, controls: true });
    const get = (thing: string, rest = '') =>
      pages.handle(new Request(`${B}/things/${encodeURIComponent(thing)}${rest}`)) as Promise<Response>;
    const plex = ThingPage.parse(await (await get('connection:con_plex')).json());
    expect(plex.catalogId).toBe('plex');
    const gallery = plex.tabs[0]?.panels.find((p) => p.kind === 'gallery');
    const ref = gallery?.kind === 'gallery' ? gallery.items.find((i) => i.image)?.image?.ref : undefined;
    expect(ref).toBeTruthy();
    const picture = await get('connection:con_plex', `/images/${ref}`);
    expect([picture.status, picture.headers.get('content-type')]).toEqual([200, 'image/png']);

    const ha = ThingPage.parse(await (await get(HOME_ASSISTANT_THING)).json());
    expect(ha.refreshS).toBe(10);
    // The Controls are its Live slot: first of the slots' rows, two columns wide.
    const first = ha.tabs[0]?.panels.find((p) => p.place === 'chart');
    expect([first?.kind, first?.place, first?.span]).toEqual(['controls', 'chart', 2]);
    const controls = first?.kind === 'controls' ? first : null;
    const light = controls?.groups.flatMap((g) => g.items).find((c) => c.toggle && c.on !== undefined);
    expect(light?.toggle).toBeTruthy();
    const pressed = await pages.handle(
      new Request(`${B}/things/${encodeURIComponent(HOME_ASSISTANT_THING)}/actions`, {
        method: 'POST',
        body: JSON.stringify({
          action: light?.toggle?.action,
          target: light?.toggle?.target,
          value: !light?.on,
        }),
      }),
    );
    expect(pressed?.status).toBe(202);
    expect(ThingActionResponse.parse(await pressed?.json()).message).toBeTruthy();
    const again = ThingPage.parse(await (await get(HOME_ASSISTANT_THING)).json());
    const after = again.tabs[0]?.panels.find((p) => p.kind === 'controls');
    const flipped =
      after?.kind === 'controls'
        ? after.groups.flatMap((g) => g.items).find((c) => c.id === light?.id)
        : null;
    expect(flipped?.on).toBe(!light?.on);
    // Restart is still Home Assistant's own.
    expect(ha.actions.map((a) => a.id)).toEqual(['restart']);
  });

  it('leaves Home Assistant’s page as drawn without the services world', async () => {
    const { pages } = world();
    const ha = pages.page(HOME_ASSISTANT_THING);
    expect(ha?.tabs[0]?.panels.some((p) => p.kind === 'controls')).toBe(false);
    expect(ha?.refreshS).toBe(60);
  });
});
