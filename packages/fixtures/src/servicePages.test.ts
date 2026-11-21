/**
 * The service pages' fixtures (contracts 0.121.0, CT-1011): every page and row parses with its contract, every picture
 * is drawn, the buttons change what the next read shows, and the Fetch routes answer as the server's do. Since 0.122
 * (CT-1067) every line says its kind and check, and Ignore, Remind me tomorrow and Stop watching change the next read.
 */
import {
  QuietNoticeResponse,
  THING_IMAGE_TRANSFER,
  ThingActionResponse,
  thingImagePath,
} from '@whombat/core/contracts';
import {
  ThingImageRef,
  ThingPage,
  type ThingPageButton,
  type ThingPageNotice,
  ThingPagePanel,
  ThingSummary,
  ThingWatch,
} from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  encodePng,
  FIXTURE_PICTURE_SIZES,
  fixturePicture,
  fixturePictureDataUrl,
  fixturePictureRef,
} from './pictures.js';
import {
  createServicePages,
  type FixtureServicePage,
  SERVICE_PAGE_THINGS,
  SERVICE_THINGS,
  servicePageImages,
  withServiceThings,
} from './servicePages.js';
import { handleServicePagesRequest } from './servicePagesFetch.js';

const NOW = Date.parse('2026-10-21T12:30:00.000Z');
const HA = 'connection:con_ha';
const ALL = [...SERVICE_PAGE_THINGS, HA];

/** Every button on a page: head, cells, lines, galleries, controls and Worth a look. */
function buttons(page: ThingPage): ThingPageButton[] {
  const out: ThingPageButton[] = [...(page.buttons ?? [])];
  for (const tab of page.tabs)
    for (const p of tab.panels) {
      if ('buttons' in p && p.buttons) out.push(...p.buttons);
      if (p.kind === 'table')
        for (const r of p.rows) for (const c of Object.values(r.cells)) if (c.action) out.push(c.action);
      if (p.kind === 'list') for (const i of p.items) out.push(...(i.actions ?? []));
      if (p.kind === 'gallery') for (const i of p.items) out.push(...(i.actions ?? []));
      if (p.kind === 'notices') for (const n of p.items) if (n.action) out.push(n.action);
      if (p.kind === 'controls')
        for (const g of p.groups)
          for (const c of g.items) {
            if (c.toggle) out.push(c.toggle);
            if (c.stepper) out.push(c.stepper.button);
            out.push(...(c.buttons ?? []));
          }
    }
  return out;
}
const panel = <K extends ThingPagePanel['kind']>(page: ThingPage | null, id: string, kind: K) => {
  const p = page?.tabs.flatMap((t) => t.panels).find((x) => x.id === id);
  if (p?.kind !== kind) throw new Error(`${id} is not a ${kind}`);
  return p as Extract<ThingPagePanel, { kind: K }>;
};

describe('the pages (CT-1011)', () => {
  const pages = createServicePages({ now: () => NOW, homeAssistant: HA });

  it('parses every page and row with its contract', () => {
    for (const id of ALL) {
      const page = pages.page(id);
      expect(page, id).not.toBeNull();
      const r = ThingPage.safeParse(page);
      expect(r.success, `${id}: ${r.error?.issues[0]?.path.join('.')} ${r.error?.issues[0]?.message}`).toBe(
        true,
      );
    }
    for (const t of pages.things()) expect(ThingSummary.safeParse(t).success, t.id).toBe(true);
    const ids = pages.things().map((t) => t.id);
    expect(ids.length).toBe(new Set(ids).size);
    expect(new Set(ids)).toEqual(new Set(SERVICE_PAGE_THINGS));
    expect(ThingPagePanel.safeParse(pages.homeAssistantControls()).success).toBe(true);
    expect(pages.page('connection:con_other')).toBeNull();
  });

  it('shows what the brief asks of each', () => {
    const plex = pages.page(SERVICE_THINGS.plex);
    expect(plex?.refreshS).toBe(5);
    expect(plex?.buttons?.map((b) => b.action)).toEqual(['check_updates']);
    expect(panel(plex, 'recently_added', 'gallery').items.every((i) => i.image?.shape === 'poster')).toBe(
      true,
    );
    const playing = panel(plex, 'now_playing', 'gallery');
    expect([playing.look, playing.span, playing.items.length]).toEqual(['rows', 2, 3]);
    expect(playing.items.map((i) => i.person?.name)).toEqual(['Anna', 'John', 'Sam']);
    expect(panel(plex, 'recently_added', 'gallery').look).toBe('shelf');
    expect(panel(plex, 'week', 'chart').labels?.at(-1)).toBe('Today');
    expect(panel(plex, 'worth', 'notices').place).toBe('top');
    const libraries = panel(plex, 'libraries', 'list');
    expect([libraries.look, libraries.items[0]?.figure?.value]).toEqual(['counts', '1,284']);
    const scans = libraries.items.map((i) => i.actions?.[0]);
    expect(scans.map((b) => [b?.action, b?.target, b?.allowed])).toEqual([
      ['scan', '1', true],
      ['scan', '2', false],
      ['scan', '3', true],
      ['scan', '4', true],
    ]);

    const seerr = pages.page(SERVICE_THINGS.seerr);
    expect(seerr?.name).toBe('Seerr');
    const waiting = panel(seerr, 'pending', 'gallery');
    expect([waiting.look, waiting.span]).toEqual(['rows', 2]);
    expect(waiting.items.map((i) => i.person?.name)).toEqual(['Sam', 'Anna', 'John']);
    expect(waiting.items[0]?.actions?.map((b) => [b.action, b.target, Boolean(b.confirm)])).toEqual([
      ['approve', '412', false],
      ['decline', '412', true],
    ]);
    const requests = panel(seerr, 'requests', 'list');
    expect(requests.look).toBe('counts');
    expect(requests.items.map((i) => [i.title, i.figure?.value])).toContainEqual(['On its way', '2']);
    expect(panel(seerr, 'available', 'gallery').look).toBe('shelf');
    expect(panel(seerr, 'week', 'chart').labels?.at(-1)).toBe('Today');
    expect(panel(seerr, 'people', 'bars').items[0]?.label).toBe('Anna');
    expect(panel(seerr, 'progress', 'gallery').items[0]?.href).toBe('/things/connection%3Acon_sabnzbd');
    expect(panel(seerr, 'worth', 'notices').items[0]?.action?.action).toBe('retry');
    expect(seerr?.tabs[0]?.panels.some((p) => p.kind === 'kpis')).toBe(false);

    const sab = pages.page(SERVICE_THINGS.sabnzbd);
    expect(sab?.refreshS).toBe(5);
    const queue = panel(sab, 'queue', 'gallery');
    expect([queue.look, queue.shape]).toEqual(['rows', 'square']);
    expect(queue.buttons?.map((b) => [b.action, b.value ?? null])).toEqual([
      ['pause', null],
      ['pause', 30],
      ['speed', 50],
    ]);
    expect(queue.items.every((i) => typeof i.progress === 'number' && i.noteEnd)).toBe(true);
    expect(panel(sab, 'downloaded', 'list').items[0]?.figure?.note).toMatch(/this week$/);
    expect(panel(sab, 'week', 'chart').series[0]?.unit).toBe('GB');
    expect(panel(sab, 'failed', 'table').rows[0]?.cells.retry?.action?.action).toBe('retry');
    expect(panel(sab, 'failed', 'table').buttons?.[0]?.confirm).toBeDefined();
    expect(sab?.tabs[0]?.panels.some((p) => p.kind === 'kpis')).toBe(false);

    const controls = pages.homeAssistantControls();
    expect(controls.groups.length).toBe(2);
    const items = controls.groups.flatMap((g) => g.items);
    expect(items.filter((c) => c.toggle).length).toBeGreaterThanOrEqual(2);
    expect(items.some((c) => c.icon === 'scene' && c.buttons?.[0]?.action === 'scene')).toBe(true);
    expect(items.find((c) => c.stepper)?.stepper).toMatchObject({ min: 7, max: 30, step: 0.5 });
    expect(items.find((c) => c.icon === 'lock')?.buttons?.[0]?.confirm).toBeDefined();
    expect(items.find((c) => c.icon === 'camera')?.image?.shape).toBe('wide');
    const refused = items.flatMap((c) => c.buttons ?? []).filter((b) => !b.allowed);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((b) => (b.reason ?? '').length > 0)).toBe(true);
    expect(pages.page(HA)?.refreshS).toBe(10);

    const protect = pages.page(SERVICE_THINGS.protect);
    const cameras = panel(protect, 'cameras', 'gallery');
    expect(cameras.shape).toBe('wide');
    expect(cameras.items.filter((c) => c.muted).map((c) => c.id)).toEqual(['garage']);
    // In slots: the cameras are the shelf, Arm and Disarm on the alarm's line in Today, nothing in the head.
    expect(cameras.look).toBe('shelf');
    expect(protect?.buttons).toEqual([]);
    const alarm = panel(protect, 'detections', 'list').items[0];
    expect(alarm?.figure?.value).toBe('Disarmed');
    expect(alarm?.actions?.[0]?.confirm).toBeDefined();
    expect(panel(protect, 'week', 'chart').labels?.at(-1)).toBe('Today');
    expect(protect?.tabs[0]?.panels.some((p) => p.kind === 'kpis')).toBe(false);

    const pihole = pages.page(SERVICE_THINGS.pihole);
    expect(panel(pihole, 'queries', 'chart').series.length).toBe(2);
    expect(panel(pihole, 'queries', 'chart').labels?.at(-1)).toBe('Now');
    // In slots: Pause in Blocking now, Update lists on the lists' line, nothing in the head.
    expect(pihole?.buttons).toEqual([]);
    const blocking = panel(pihole, 'blocking-now', 'list').items[0];
    expect(blocking?.actions?.map((b) => [b.action, b.value ?? null, Boolean(b.confirm)])).toEqual([
      ['pause', 300, false],
      ['pause', 1800, true],
    ]);
    expect(panel(pihole, 'inventory', 'list').items[0]?.actions?.[0]?.action).toBe('update_lists');
    expect(panel(pihole, 'top-clients', 'bars').items[0]?.person).toBe(true);

    // Home Assistant in slots: its Controls live, what it has, the cameras, the week and who's home.
    const home = pages.page(HA);
    expect(home?.tabs[0]?.panels.map((p) => p.id)).toEqual([
      'worth',
      'controls',
      'inventory',
      'cameras',
      'automations-week',
      'people',
      'machine',
      'not-loading',
    ]);
    expect(panel(home, 'controls', 'controls')).toMatchObject({ place: 'chart', span: 2 });
    expect(panel(home, 'cameras', 'gallery')).toMatchObject({ look: 'shelf', shape: 'wide' });
  });

  it('draws every picture the pages name', () => {
    const refs = ALL.flatMap((id) => {
      const page = pages.page(id);
      return page ? servicePageImages(page) : [];
    });
    expect(refs.length).toBeGreaterThan(30);
    for (const img of refs) {
      expect(ThingImageRef.safeParse(img.ref).success, img.ref).toBe(true);
      const p = pages.image(img.ref);
      expect(p?.contentType, img.ref).toBe('image/png');
      const bytes = p?.bytes ?? new Uint8Array();
      expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const v = new DataView(bytes.buffer, bytes.byteOffset);
      expect([v.getUint32(16), v.getUint32(20)]).toEqual([
        FIXTURE_PICTURE_SIZES[img.shape].width,
        FIXTURE_PICTURE_SIZES[img.shape].height,
      ]);
    }
    expect(pages.image('eyJjIjoiY29uX3BsZXgiLCJzIjoiYyJ9.q3Vx9LpA0dZkT7mW2bNcYe')).toBeNull();
  });
});

describe('pictures (CT-1011)', () => {
  it('names and draws the same picture every time, a different one per slug', () => {
    const a = fixturePictureRef('poster', 'Dune: Part Two');
    expect(a).toBe('fx-poster-dune-part-two.fixture');
    expect(fixturePicture(a)?.bytes).toEqual(fixturePicture(a)?.bytes);
    expect(fixturePicture(a)?.bytes).not.toEqual(fixturePicture(fixturePictureRef('poster', 'Flow'))?.bytes);
    expect(fixturePicture('fx-tall-thing.fixture')).toBeNull();
    expect(fixturePictureDataUrl(a)).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  });

  it('writes a PNG whose chunks carry their CRCs and whose rows come back out', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 0, 255]);
    const png = encodePng(2, 1, rgb);
    const v = new DataView(png.buffer);
    expect(v.getUint32(8)).toBe(13); // IHDR's length
    // IEND's CRC is the same in every PNG.
    expect(v.getUint32(png.length - 4).toString(16)).toBe('ae426082');
    // IDAT: zlib header, one stored block (final), the filter byte and the row.
    const idat = 8 + 12 + 13;
    const len = v.getUint32(idat);
    const z = png.slice(idat + 8, idat + 8 + len);
    expect([z[0], z[1], z[2]]).toEqual([0x78, 0x01, 1]);
    expect([...z.slice(7, 14)]).toEqual([0, ...rgb]);
  });
});

describe('buttons change the next read (CT-1011)', () => {
  it('approves a request and pauses the queue', () => {
    const pages = createServicePages({ now: () => NOW });
    const answer = pages.action(SERVICE_THINGS.seerr, { action: 'approve', target: '412' });
    expect(answer?.status).toBe(202);
    expect(ThingActionResponse.safeParse(answer?.body).success).toBe(true);
    expect(answer?.status === 202 && answer.body.changeId).toMatch(/^chg_/);
    expect(panel(pages.page(SERVICE_THINGS.seerr), 'pending', 'gallery').items.map((i) => i.id)).toEqual([
      '411',
      '409',
    ]);
    expect(pages.action(SERVICE_THINGS.seerr, { action: 'approve', target: '412' })?.status).toBe(404);

    const paused = pages.action(SERVICE_THINGS.sabnzbd, { action: 'pause', value: 30 });
    expect(paused?.status === 202 && paused.body).toMatchObject({ refresh: true });
    expect(paused?.status === 202 && paused.body.changeId).toBeUndefined();
    expect(
      panel(pages.page(SERVICE_THINGS.sabnzbd), 'queue', 'gallery').buttons?.map((b) => b.action),
    ).toEqual(['resume']);
  });

  it('switches a light, sets the thermostat and pauses blocking', () => {
    const pages = createServicePages({ now: () => NOW });
    const ha = 'connection:con_home-assistant';
    const light = () => pages.homeAssistantControls().groups[0]?.items[0];
    expect(light()?.on).toBe(true);
    expect(
      pages.action(ha, { action: 'toggle', target: 'light.living_room_ceiling', value: false })?.status,
    ).toBe(202);
    expect(light()?.on).toBe(false);
    expect(light()?.toggle?.value).toBe(true);
    expect(
      pages.action(ha, { action: 'set_temperature', target: 'climate.living_room', value: 22 })?.status,
    ).toBe(202);
    expect(
      pages.action(ha, { action: 'set_temperature', target: 'climate.living_room', value: 22.3 })?.status,
    ).toBe(404);
    expect(pages.action(ha, { action: 'toggle', target: 'light.unknown', value: true })?.status).toBe(404);
    expect(pages.action(SERVICE_THINGS.pihole, { action: 'pause', value: 300 })?.status).toBe(202);
    // A pause pressed here ends by itself: a heads-up, the page and its row stay fine (0.122, QN-04).
    const paused = pages.page(SERVICE_THINGS.pihole);
    expect([paused?.status, paused?.badge]).toEqual(['ok', 'Paused']);
    expect(panel(paused, 'worth', 'notices').items[0]?.nature).toBe('fyi');
    expect(pages.things().find((t) => t.id === SERVICE_THINGS.pihole)?.status).toBe('ok');
    expect(pages.action('connection:con_other', { action: 'pause' })).toBeNull();
  });

  it('shows every button disabled with its reason on Look only, and refuses them', () => {
    const pages = createServicePages({ now: () => NOW, lookOnly: true });
    for (const id of [...Object.values(SERVICE_THINGS), 'connection:con_home-assistant']) {
      const page = pages.page(id);
      if (!page) throw new Error(id);
      for (const b of buttons(page)) {
        expect(b.allowed, `${id} ${b.action}`).toBe(false);
        expect(b.reason, `${id} ${b.action}`).toBeTruthy();
      }
    }
    expect(pages.action(SERVICE_THINGS.plex, { action: 'check_updates' })?.status).toBe(403);
  });
});

describe('the Fetch routes (CT-1011)', () => {
  const B = '/api/v1/burrows/lumio-bv';
  const enc = encodeURIComponent;

  it('answers a page, a button and a picture, and leaves the rest to another layer', async () => {
    const pages = createServicePages({ now: () => NOW });
    const get = (path: string, method = 'GET') =>
      handleServicePagesRequest(pages, new Request(`http://x${path}`, { method }));

    const page = await get(`${B}/things/${enc(SERVICE_THINGS.plex)}`);
    expect(page?.status).toBe(200);
    expect(ThingPage.safeParse(await page?.json()).success).toBe(true);

    const pressed = await handleServicePagesRequest(
      pages,
      new Request(`http://x${B}/things/${enc(SERVICE_THINGS.pihole)}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'update_lists' }),
      }),
    );
    expect(pressed?.status).toBe(202);
    expect(ThingActionResponse.safeParse(await pressed?.json()).success).toBe(true);

    const ref = fixturePictureRef('poster', 'Dune: Part Two');
    const path = thingImagePath('lumio-bv', SERVICE_THINGS.plex, ref);
    expect(path.startsWith(THING_IMAGE_TRANSFER.image.base)).toBe(true);
    const picture = await get(path);
    expect(picture?.status).toBe(200);
    expect(picture?.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await (picture as Response).arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    expect((await get(path, 'HEAD'))?.status).toBe(200);
    expect(
      (await get(thingImagePath('lumio-bv', SERVICE_THINGS.plex, 'unknown-picture.fixture')))?.status,
    ).toBe(404);

    expect(await get(`${B}/things/${enc('connection:con_other')}`)).toBeNull();
    expect(await get(thingImagePath('lumio-bv', 'connection:con_other', ref))).toBeNull();
    expect(await get(`${B}/conversations`)).toBeNull();
  });
});

describe('quiet notices (0.122, CT-1067)', () => {
  const lines = (page: ThingPage | null): ThingPageNotice[] =>
    page?.tabs.flatMap((t) => t.panels.flatMap((p) => (p.kind === 'notices' ? p.items : []))) ?? [];
  const garage = { check: 'protect.camera_offline', subject: 'camera:garage' };

  it('says every line’s kind and check, and what Ignore does', () => {
    const pages = createServicePages({ now: () => NOW, homeAssistant: HA });
    for (const id of ALL)
      for (const n of lines(pages.page(id))) {
        expect(n.nature, `${id} ${n.id}`).toBeDefined();
        expect(n.check, `${id} ${n.id}`).toBeDefined();
        expect(n.ignore?.words, `${id} ${n.id}`).toMatch(/^Until /);
        if (n.nature !== 'problem') expect(n.link?.kind, `${id} ${n.id}`).not.toBe('ask');
      }
    // One line per integration (QN-03).
    expect(lines(pages.page(HA)).map((n) => n.subject?.name)).toEqual([
      'Shelly Living room',
      'Shelly Garage',
    ]);
  });

  it('ignores a line until it changes: greyed at the bottom, the page and its row fine, Undo takes it back', () => {
    const pages = createServicePages({ now: () => NOW });
    expect(pages.page(SERVICE_THINGS.protect)?.status).toBe('warn');
    const answer = pages.quiet(SERVICE_THINGS.protect, { notice: garage, how: 'ignore' });
    expect(answer?.status).toBe(200);
    expect(QuietNoticeResponse.safeParse(answer?.body).success).toBe(true);
    const page = pages.page(SERVICE_THINGS.protect);
    expect(ThingPage.safeParse(page).success).toBe(true);
    expect(page?.status).toBe('ok');
    expect(lines(page)[0]?.quiet).toMatchObject({
      state: 'ignored',
      words: 'until it’s back online',
      by: { name: 'Mara' },
    });
    expect(pages.things().find((t) => t.id === SERVICE_THINGS.protect)?.status).toBe('ok');
    const watch = pages.watch(SERVICE_THINGS.protect);
    expect(ThingWatch.safeParse(watch).success).toBe(true);
    const offline = watch?.checks.find((c) => c.check === garage.check);
    expect(offline?.exceptions.map((e) => [e.subject?.name, e.state])).toEqual([['Garage', 'ignored']]);

    expect(pages.quiet(SERVICE_THINGS.protect, { notice: garage, how: 'undo' })?.body).toEqual({
      notice: garage,
      quiet: null,
    });
    expect(pages.page(SERVICE_THINGS.protect)?.status).toBe('warn');
    expect(pages.quiet(SERVICE_THINGS.protect, { notice: garage, how: 'undo' })?.status).toBe(404);
  });

  it('snoozes until 09:00 tomorrow, then the line is back', () => {
    let now = NOW;
    const pages = createServicePages({ now: () => now });
    const answer = pages.quiet(SERVICE_THINGS.protect, { notice: garage, how: 'snooze' });
    expect(answer?.status === 200 && answer.body.quiet?.until).toBe('2026-10-22T09:00:00.000Z');
    expect(lines(pages.page(SERVICE_THINGS.protect))[0]?.quiet?.state).toBe('snoozed');
    now = Date.parse('2026-10-22T09:00:00.000Z');
    expect(lines(pages.page(SERVICE_THINGS.protect))[0]?.quiet).toBeUndefined();
  });

  it('stops watching an item: its line leaves until it is watched again', () => {
    const pages = createServicePages({ now: () => NOW });
    const subject = { id: 'camera:garage', name: 'Garage' };
    const off = pages.setWatch(SERVICE_THINGS.protect, { check: garage.check, subject, watched: false });
    expect(off?.status).toBe(200);
    const check = off?.status === 200 ? off.body.checks.find((c) => c.check === garage.check) : undefined;
    expect([check?.on, check?.exceptions[0]?.state, check?.exceptions[0]?.subject?.name]).toEqual([
      true,
      'stopped',
      'Garage',
    ]);
    expect(lines(pages.page(SERVICE_THINGS.protect))).toEqual([]);
    expect(pages.page(SERVICE_THINGS.protect)?.status).toBe('ok');
    pages.setWatch(SERVICE_THINGS.protect, { check: garage.check, subject, watched: true });
    expect(lines(pages.page(SERVICE_THINGS.protect))).toHaveLength(1);
    expect(pages.setWatch(SERVICE_THINGS.protect, { check: 'plex.updates', watched: false })?.status).toBe(
      404,
    );
  });

  it('offers no Ignore on Look only and refuses every change', () => {
    const pages = createServicePages({ now: () => NOW, lookOnly: true });
    for (const n of lines(pages.page(SERVICE_THINGS.protect))) expect(n.ignore).toBeUndefined();
    expect(pages.quiet(SERVICE_THINGS.protect, { notice: garage, how: 'ignore' })?.status).toBe(403);
    expect(pages.setWatch(SERVICE_THINGS.protect, { check: garage.check, watched: false })?.status).toBe(403);
    expect(pages.watch(SERVICE_THINGS.protect)?.mayChange).toBe(false);
    expect(pages.quiet('connection:con_other', { notice: garage, how: 'ignore' })).toBeNull();
  });

  it('answers over the Fetch routes', async () => {
    const pages = createServicePages({ now: () => NOW });
    const B = '/api/v1/burrows/lumio-bv/things';
    const at = (path: string, body?: unknown) =>
      handleServicePagesRequest(
        pages,
        new Request(`http://x${B}/${encodeURIComponent(SERVICE_THINGS.protect)}/${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    expect((await at('quiet', { notice: garage, how: 'ignore' }))?.status).toBe(200);
    expect(
      (await at('quiet', { notice: garage, how: 'ignore', until: '2026-10-22T09:00:00Z' }))?.status,
    ).toBe(400);
    const watch = await at('watch');
    expect(ThingWatch.safeParse(await watch?.json()).success).toBe(true);
    expect((await at('watch', { check: garage.check, watched: false }))?.status).toBe(200);
  });
});

describe('a group’s own pages (servicePages/<group>.ts)', () => {
  /** A stub of what a group adds: a page in slots with one button that changes the next read. */
  const stub = (thing: `connection:${string}`, name: string): FixtureServicePage => ({
    thing,
    catalogId: 'truenas',
    name,
    fields: { url: 'https://10.100.0.30' },
    make: ({ ago }) => {
      let scrubbed = false;
      return {
        page: () => ({
          id: thing,
          kind: 'connection',
          connectionId: thing.slice('connection:'.length),
          catalogId: 'truenas',
          name,
          icon: 'truenas',
          status: scrubbed ? 'ok' : 'warn',
          badge: scrubbed ? 'Running fine' : 'Scrub overdue',
          facts: [],
          runsOn: null,
          settings: true,
          readAt: ago(60_000),
          actions: [],
          tabs: [
            {
              key: 'overview',
              label: 'Summary',
              panels: [
                {
                  kind: 'list',
                  id: 'pools',
                  look: 'counts',
                  place: 'chart',
                  span: 1,
                  width: 'full',
                  title: 'Pools',
                  items: [
                    {
                      id: 'tank',
                      title: 'Tank',
                      right: '62 %',
                      figure: { value: '62 %', note: scrubbed ? 'Scrubbed today' : 'Scrub overdue' },
                    },
                  ],
                },
              ],
            },
          ],
        }),
        row: () => ({ line: '1 pool · 62 % used', facts: [{ label: 'Pools', value: '1' }] }),
        action: ({ action }) => {
          if (action !== 'scrub' || scrubbed) return null;
          scrubbed = true;
          return { message: 'Scrubbing Tank.' };
        },
        checks: [{ check: 'truenas.scrub', name: 'Scrubs overdue', nature: 'problem', perItem: true }],
      };
    },
  });

  it('shows its page and row, answers its buttons and checks, with no edit to the built-in pages', async () => {
    const thing = 'connection:con_truenas' as const;
    const pages = createServicePages({ now: () => NOW, pages: [stub(thing, 'TrueNAS')] });
    expect(ThingPage.safeParse(pages.page(thing)).success).toBe(true);
    const row = pages.things().find((t) => t.id === thing);
    expect(ThingSummary.safeParse(row).success).toBe(true);
    expect(row).toMatchObject({ name: 'TrueNAS', line: '1 pool · 62 % used' });
    expect(panel(pages.page(thing), 'pools', 'list').items[0]?.figure?.note).toBe('Scrub overdue');
    expect(pages.action(thing, { action: 'scrub' })).toMatchObject({ status: 202 });
    expect(panel(pages.page(thing), 'pools', 'list').items[0]?.figure?.note).toBe('Scrubbed today');
    expect(pages.action(thing, { action: 'scrub' })).toMatchObject({ status: 404 });
    expect(pages.watch(thing)?.checks.map((c) => c.check)).toContain('truenas.scrub');
    // Over the Fetch routes too, as the web's fixture layer asks.
    const res = await handleServicePagesRequest(
      pages,
      new Request(`http://x/api/v1/burrows/b/things/${encodeURIComponent(thing)}`),
    );
    expect(res?.status).toBe(200);
    // Look only refuses before the group is asked.
    const looking = createServicePages({ now: () => NOW, lookOnly: true, pages: [stub(thing, 'TrueNAS')] });
    expect(looking.action(thing, { action: 'scrub' })).toMatchObject({ status: 403 });
  });

  it('replaces a page the world draws already, row and all, keeping the built-in’s other buttons', () => {
    const pages = createServicePages({ now: () => NOW, pages: [stub(SERVICE_THINGS.protect, 'Protect')] });
    expect(pages.page(SERVICE_THINGS.protect)?.name).toBe('Protect');
    expect(
      pages
        .things()
        .filter((t) => t.id === SERVICE_THINGS.protect)
        .map((t) => t.name),
    ).toEqual(['Protect']);
    expect(pages.action(SERVICE_THINGS.protect, { action: 'arm' })).toMatchObject({ status: 202 });
    expect(
      withServiceThings(
        [
          { id: 'a', n: 1 },
          { id: 'b', n: 1 },
        ],
        [{ id: 'a', n: 2 }],
      ),
    ).toEqual([
      { id: 'b', n: 1 },
      { id: 'a', n: 2 },
    ]);
  });
});
