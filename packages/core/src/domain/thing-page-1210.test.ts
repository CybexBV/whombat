/**
 * Contracts 0.121.0, service dashboards (Whombat service-dashboards.md SD-06…SD-11; CT-1000…CT-1014): pictures,
 * buttons on cells, lines, panels, notices and the page's head, the gallery and controls panels, and the action body.
 */
import { describe, expect, it } from 'vitest';
import {
  api,
  THING_IMAGE_TRANSFER,
  ThingActionBody,
  ThingActionResponse,
  ThingParam,
  thingImagePath,
} from '../contracts/index.js';
import {
  THING_BUTTON_ICONS,
  THING_CONTROL_ICONS,
  THING_IMAGE_MAX_SIDE,
  THING_IMAGE_SHAPES,
  THING_IMAGE_TYPES,
  THING_NOTICE_ICONS,
  ThingControl,
  ThingGalleryItem,
  ThingImage,
  ThingImageRef,
  ThingPage,
  ThingPageButton,
  ThingPageCell,
  ThingPageItem,
  ThingPageNotice,
  ThingPagePanel,
  thingPanelPlace,
} from './thing-page.js';

const REF = 'eyJjIjoiY29uX3BsZXgiLCJzIjoiYyJ9.q3Vx9LpA0dZkT7mW2bNcYe';
const poster = { ref: REF, alt: 'Poster of Dune: Part Two', shape: 'poster' } as const;
const approve = {
  action: 'approve',
  target: '412',
  label: 'Approve',
  icon: 'check',
  tone: 'primary',
  allowed: true,
};
const decline = {
  action: 'decline',
  target: '412',
  label: 'Decline',
  icon: 'close',
  confirm: { title: 'Decline “Wicked”?', body: 'Sam is told it was declined.', button: 'Decline' },
  allowed: true,
};
const lookOnly = { action: 'pause', label: 'Pause', allowed: false, reason: 'Look only: changes are off.' };

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  expect(schema.safeParse(v).success).toBe(true);
const no = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  expect(schema.safeParse(v).success).toBe(false);

describe('pictures (CT-1000)', () => {
  it('takes a signed ref and refuses anything else', () => {
    ok(ThingImageRef, REF);
    ok(ThingImageRef, 'fx-poster-dune-part-two.fixture');
    ok(ThingImageRef, `${'a'.repeat(560)}.${'b'.repeat(39)}`);
    no(ThingImageRef, 'short.ref');
    no(ThingImageRef, `${'a'.repeat(560)}.${'b'.repeat(40)}`);
    no(ThingImageRef, 'no-dot-in-this-ref-at-all');
    no(ThingImageRef, 'two.dots.in-this-ref');
    no(ThingImageRef, '../../etc/passwd.x1234567');
    no(ThingImageRef, 'has space in it.abcdefgh');
    no(ThingImageRef, 'percent%2eencoded.abcdefgh');
  });

  it('keeps a shape’s box and short alt words', () => {
    expect(THING_IMAGE_SHAPES).toEqual(['poster', 'wide', 'square']);
    expect(THING_IMAGE_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(THING_IMAGE_MAX_SIDE).toBe(480);
    ok(ThingImage, poster);
    ok(ThingImage, { ...poster, alt: '' });
    no(ThingImage, { ...poster, alt: 'x'.repeat(121) });
    no(ThingImage, { ...poster, shape: 'tall' });
    no(ThingImage, { ref: REF, alt: 'x' });
  });

  it('names the picture route and its path', () => {
    const t = THING_IMAGE_TRANSFER.image;
    expect([t.id, t.method, t.base, t.path]).toEqual([
      'things.image',
      'GET',
      '/api/v1',
      '/burrows/:burrow/things/:thing/images/:ref',
    ]);
    expect(thingImagePath('lumio-bv', 'connection:con_plex', REF)).toBe(
      `/api/v1/burrows/lumio-bv/things/connection%3Acon_plex/images/${REF}`,
    );
    expect(t.params.safeParse({ burrow: 'lumio-bv', thing: 'connection:con_plex', ref: REF }).success).toBe(
      true,
    );
    expect(t.params.safeParse({ burrow: 'lumio-bv', thing: 'connection:con_plex', ref: 'x.y' }).success).toBe(
      false,
    );
    ok(ThingParam, 'connection:con_plex');
    no(ThingParam, 'x'.repeat(221));
    // Not a JSON endpoint: it answers bytes.
    expect(Object.keys(api.things)).not.toContain('image');
  });
});

describe('buttons (CT-1001…CT-1003, CT-1012, CT-1014)', () => {
  it('takes the brief’s buttons', () => {
    ok(ThingPageButton, approve);
    ok(ThingPageButton, decline);
    ok(ThingPageButton, lookOnly);
    ok(ThingPageButton, { action: 'pause', value: 30, label: 'Pause 30 min', icon: 'pause', allowed: true });
    ok(ThingPageButton, {
      action: 'toggle',
      target: 'light.hall',
      value: false,
      label: 'Turn off',
      allowed: true,
    });
    ok(ThingPageButton, {
      action: 'speed',
      value: 'half',
      label: 'Half speed',
      icon: 'speed',
      allowed: true,
    });
    expect(THING_BUTTON_ICONS).toHaveLength(17);
    for (const icon of THING_BUTTON_ICONS) ok(ThingPageButton, { ...approve, icon });
  });

  it('refuses what is out of range', () => {
    no(ThingPageButton, { ...approve, allowed: undefined });
    no(ThingPageButton, { ...approve, label: '' });
    no(ThingPageButton, { ...approve, label: 'x'.repeat(31) });
    no(ThingPageButton, { ...approve, action: 'Approve' });
    no(ThingPageButton, { ...approve, target: '' });
    no(ThingPageButton, { ...approve, target: 'x'.repeat(201) });
    no(ThingPageButton, { ...approve, value: 'x'.repeat(101) });
    no(ThingPageButton, { ...approve, value: { on: true } });
    no(ThingPageButton, { ...approve, value: Number.POSITIVE_INFINITY });
    no(ThingPageButton, { ...approve, icon: 'rocket' });
    no(ThingPageButton, { ...approve, tone: 'warn' });
    no(ThingPageButton, { ...decline, confirm: { title: 'Sure?', body: '', button: 'Yes' } });
    no(ThingPageButton, { ...decline, confirm: { title: 'Sure?', body: 'Yes', button: 'x'.repeat(31) } });
    no(ThingPageButton, { ...lookOnly, reason: 'x'.repeat(201) });
  });

  it('puts a button in a cell, buttons on a line, a link out on both, and one on a Worth a look line', () => {
    ok(ThingPageCell, {
      text: 'Scan',
      action: { ...approve, action: 'scan', label: 'Scan', icon: 'search' },
    });
    ok(ThingPageCell, { text: 'example.com', url: 'https://example.com/' });
    no(ThingPageCell, { text: 'example.com', url: 'not a url' });
    ok(ThingPageItem, {
      id: 'issue-17',
      title: 'Subtitles out of sync',
      image: poster,
      url: 'http://10.100.0.20:5055/issues/17',
      actions: [{ ...approve, action: 'resolve_issue', label: 'Mark resolved' }],
    });
    no(ThingPageItem, { id: 'i', title: 't', actions: [approve, approve, approve, approve] });
    no(ThingPageItem, { id: 'i', title: 't', url: `https://example.com/${'x'.repeat(490)}` });
    ok(ThingPageNotice, {
      id: 'failed',
      tone: 'bad',
      icon: 'download',
      title: 'A request failed: Gladiator II',
      action: { action: 'retry', target: '398', label: 'Retry', icon: 'retry', allowed: true },
    });
  });

  it('adds the new Worth a look icons', () => {
    for (const icon of ['download', 'camera', 'door', 'media', 'money', 'shield', 'certificate'])
      expect(THING_NOTICE_ICONS).toContain(icon);
    expect(THING_NOTICE_ICONS.slice(0, 14)).toEqual([
      'disk',
      'plug',
      'log',
      'update',
      'backup',
      'network',
      'power',
      'battery',
      'database',
      'clock',
      'key',
      'device',
      'info',
      'warn',
    ]);
  });

  it('puts at most four buttons on a panel’s head', () => {
    const table = {
      kind: 'table',
      id: 'queue',
      title: 'Queue',
      buttons: [lookOnly, approve, decline],
      columns: [{ key: 'name', label: 'Name' }],
      rows: [],
    };
    ok(ThingPagePanel, table);
    no(ThingPagePanel, { ...table, buttons: [approve, approve, approve, approve, approve] });
    for (const kind of ['list', 'bars'])
      ok(ThingPagePanel, { kind, id: 'p', title: 'P', buttons: [approve], items: [] });
    // Panels without a head of buttons drop them as unknown members.
    const notices = ThingPagePanel.parse({
      kind: 'notices',
      id: 'n',
      title: 'N',
      items: [],
      buttons: [approve],
    });
    expect('buttons' in notices).toBe(false);
  });
});

describe('galleries (CT-1004)', () => {
  const item = {
    id: '412',
    title: 'Wicked: For Good',
    sub: '2025 · Asked by Sam',
    image: poster,
    badge: { text: 'Converting', tone: 'warn' },
    progress: 0.63,
    note: '63 % · 12 min left',
    at: '2026-10-21T19:00:00.000Z',
    muted: false,
    href: '/things/connection%3Acon_sabnzbd',
    url: 'http://10.100.0.20:5055/movie/1',
    actions: [approve, decline],
  };

  it('takes the brief’s item and panel', () => {
    ok(ThingGalleryItem, item);
    ok(ThingGalleryItem, { id: 'cam', title: 'Garage', muted: true });
    const gallery = {
      kind: 'gallery',
      id: 'waiting',
      title: 'Waiting for approval',
      shape: 'poster',
      items: [item],
    };
    ok(ThingPagePanel, gallery);
    ok(ThingPagePanel, { ...gallery, shape: 'wide', buttons: [approve], meta: '8 cameras', empty: 'None.' });
    expect(thingPanelPlace(ThingPagePanel.parse({ ...gallery, width: 'wide' }), false)).toBe('main');
  });

  it('refuses what is out of range', () => {
    no(ThingGalleryItem, { ...item, progress: 1.01 });
    no(ThingGalleryItem, { ...item, progress: -0.1 });
    no(ThingGalleryItem, { ...item, title: '' });
    no(ThingGalleryItem, { ...item, title: 'x'.repeat(121) });
    no(ThingGalleryItem, { ...item, note: 'x'.repeat(81) });
    no(ThingGalleryItem, { ...item, badge: { text: 'x'.repeat(31), tone: 'ok' } });
    no(ThingGalleryItem, { ...item, href: 'https://elsewhere.example' });
    no(ThingGalleryItem, { ...item, actions: [approve, approve, approve, approve] });
    const gallery = { kind: 'gallery', id: 'g', title: 'G', shape: 'square' };
    no(ThingPagePanel, {
      ...gallery,
      items: Array.from({ length: 49 }, (_, i) => ({ id: `${i}`, title: 'T' })),
    });
    no(ThingPagePanel, { ...gallery, shape: 'tall', items: [] });
    no(ThingPagePanel, { kind: 'gallery', id: 'g', title: 'G', items: [] });
  });
});

describe('controls (CT-1005)', () => {
  const light = {
    id: 'light.living_room',
    label: 'Ceiling light',
    icon: 'light',
    state: 'On · 80 %',
    on: true,
    toggle: { action: 'toggle', target: 'light.living_room', value: false, label: 'Turn off', allowed: true },
  };
  const thermostat = {
    id: 'climate.living_room',
    label: 'Thermostat',
    icon: 'thermostat',
    state: '20.8 °C now',
    stepper: {
      value: 21.5,
      min: 7,
      max: 30,
      step: 0.5,
      unit: '°C',
      button: { action: 'set_temperature', target: 'climate.living_room', label: 'Set', allowed: true },
    },
  };
  const lock = {
    id: 'lock.front_door',
    label: 'Front door',
    icon: 'lock',
    state: 'Locked',
    buttons: [{ ...decline, action: 'unlock', label: 'Unlock', icon: 'unlock', tone: 'danger' }],
  };
  const camera = {
    id: 'camera.garden',
    label: 'Garden',
    icon: 'camera',
    image: { ...poster, shape: 'wide' },
  };

  it('takes switches, steppers, buttons and pictures in groups', () => {
    for (const c of [light, thermostat, lock, camera]) ok(ThingControl, c);
    expect(THING_CONTROL_ICONS).toHaveLength(16);
    const panel = {
      kind: 'controls',
      id: 'controls',
      title: 'Controls',
      meta: 'Your favourites',
      hint: 'Pin favourites on Home Assistant’s Home dashboard to choose what shows here.',
      buttons: [approve],
      groups: [
        { id: 'living_room', title: 'Living room', items: [light, thermostat] },
        { id: 'hall', title: 'Hall', items: [lock, camera] },
      ],
      empty: 'No favourites yet.',
    };
    ok(ThingPagePanel, panel);
    ok(ThingPagePanel, { kind: 'controls', id: 'c', title: 'Controls', groups: [] });
  });

  it('refuses what is out of range', () => {
    no(ThingControl, { ...light, on: undefined });
    no(ThingControl, { ...light, label: 'x'.repeat(61) });
    no(ThingControl, { ...light, icon: 'rocket' });
    no(ThingControl, { ...light, state: 'x'.repeat(61) });
    no(ThingControl, { ...lock, buttons: [approve, approve, approve, approve, approve] });
    no(ThingControl, { ...thermostat, stepper: { ...thermostat.stepper, value: 31 } });
    no(ThingControl, { ...thermostat, stepper: { ...thermostat.stepper, value: 6.5 } });
    no(ThingControl, { ...thermostat, stepper: { ...thermostat.stepper, min: 30, max: 7 } });
    no(ThingControl, { ...thermostat, stepper: { ...thermostat.stepper, step: 0 } });
    no(ThingControl, { ...thermostat, stepper: { ...thermostat.stepper, unit: 'degrees C' } });
    no(ThingControl, { ...thermostat, stepper: { ...thermostat.stepper, button: undefined } });
    const panel = { kind: 'controls', id: 'c', title: 'Controls' };
    no(ThingPagePanel, { ...panel, hint: 'x'.repeat(201), groups: [] });
    no(ThingPagePanel, {
      ...panel,
      groups: Array.from({ length: 17 }, (_, i) => ({ id: `${i}`, title: 'G', items: [] })),
    });
    no(ThingPagePanel, {
      ...panel,
      groups: [
        { id: 'g', title: 'G', items: Array.from({ length: 49 }, (_, i) => ({ id: `${i}`, label: 'L' })) },
      ],
    });
    no(ThingPagePanel, { ...panel, groups: [{ id: 'g', title: 'x'.repeat(61), items: [] }] });
  });
});

describe('the page and the action (CT-1006, CT-1010, CT-1014)', () => {
  const page = {
    id: 'connection:con_plex',
    kind: 'connection',
    connectionId: 'con_plex',
    catalogId: 'plex',
    name: 'Plex',
    icon: 'plex',
    status: 'ok',
    badge: 'Running fine',
    facts: [],
    runsOn: null,
    settings: true,
    actions: [],
    buttons: [{ action: 'check_updates', label: 'Check for updates', icon: 'search', allowed: true }],
    readAt: '2026-10-21T19:00:00.000Z',
    refreshS: 5,
    tabs: [{ key: 'overview', label: 'Summary', panels: [] }],
  };

  it('takes head buttons and a live page’s refresh', () => {
    ok(ThingPage, page);
    no(ThingPage, { ...page, buttons: [approve, approve, approve, approve, approve] });
    no(ThingPage, { ...page, refreshS: 4 });
    ok(ThingPage, { ...page, buttons: undefined, refreshS: undefined });
  });

  it('sends the button’s action, target and value', () => {
    ok(ThingActionBody, { action: 'restart' });
    ok(ThingActionBody, { action: 'approve', target: '412' });
    ok(ThingActionBody, { action: 'toggle', target: 'light.hall', value: false });
    ok(ThingActionBody, { action: 'set_temperature', target: 'climate.living_room', value: 21.5 });
    ok(ThingActionBody, { action: 'speed', value: 'half' });
    no(ThingActionBody, { action: 'approve', target: '' });
    no(ThingActionBody, { action: 'approve', target: 'x'.repeat(201) });
    no(ThingActionBody, { action: 'speed', value: 'x'.repeat(101) });
    no(ThingActionBody, { action: 'speed', value: [1] });
    no(ThingActionBody, { action: 'Not a key' });
    expect(api.things.action.body).toBe(ThingActionBody);
  });

  it('answers the toast and whether to read the page again', () => {
    ok(ThingActionResponse, { message: 'Approved Wicked: For Good', changeId: 'chg_1', refresh: true });
    ok(ThingActionResponse, { message: 'Turned it off.', refresh: true });
    ok(ThingActionResponse, { message: 'Restarting Home Assistant.' });
    no(ThingActionResponse, { message: '', refresh: true });
    no(ThingActionResponse, { message: 'x'.repeat(201) });
  });
});
