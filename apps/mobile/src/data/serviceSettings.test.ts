/** A service's settings on the phone (service-settings.md SST-01…SST-10): rows, the Change sheet and a card's Ask. */

import { ThingPage, type ThingPagePanel, type ThingSetting } from '@whombat/core';
import { at, mara } from '@whombat/fixtures';
import { decodeTolerant } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { createThingPageFixtures } from '../fixtures/thingPages';
import {
  canChange,
  panelAsk,
  putBackAction,
  SETTINGS_COPY,
  settingRowView,
  settingSheet,
} from './serviceSettings';
import { phoneThingTabs, shownPanels } from './thingPage';

const allowed = { action: 'setting', target: 'x', label: 'Change', allowed: true } as const;
const lookOnly = { ...allowed, allowed: false, reason: 'Whombat only looks here.' };

const quality: ThingSetting = {
  id: 'remote_quality',
  label: 'Quality outside your home',
  value: 'Up to 8 Mbps',
  changed: {
    text: 'Dusty changed this yesterday from 4 Mbps.',
    short: 'Changed by Dusty yesterday',
    changeId: 'chg_1',
  },
  choose: {
    button: { ...allowed, target: 'remote_quality' },
    current: 8000,
    help: 'The most one stream may use when someone watches away from home.',
    hint: 'Your upload is about 40 Mbps.',
    choices: [
      { value: 0, label: 'Original quality', note: 'no limit' },
      { value: 20000, label: '20 Mbps', note: '1080p, high' },
      { value: 8000, label: '8 Mbps', note: '1080p' },
    ],
  },
};

const remote: ThingSetting = {
  id: 'remote_access',
  label: 'Remote access',
  value: 'On',
  on: true,
  toggle: { ...allowed, target: 'remote_access', label: 'Remote access' },
};

const updates: ThingSetting = {
  id: 'updates',
  label: 'Updates',
  value: 'Ask me',
  elsewhere: { label: 'In Plex', url: 'http://plex.local/web' },
};

describe('a setting’s row', () => {
  it('is a switch that shows what the person set while it settles', () => {
    const row = settingRowView(remote);
    expect(row).toMatchObject({ look: 'switch', on: true, value: null, allowed: true, note: null });
    expect(settingRowView(remote, false).on).toBe(false);
    expect(row.spoken).toBe('Remote access');
  });

  it('shows a choice’s short words with who changed it under the name', () => {
    const row = settingRowView(quality);
    expect(row).toMatchObject({ look: 'choose', value: '8 Mbps', note: 'Changed by Dusty yesterday' });
    expect(row.spoken).toContain('8 Mbps');
    expect(row.spoken).toContain('Changed by Dusty yesterday');
    // A value that is none of the choices (set in the service itself): the row's own words.
    const odd = {
      ...quality,
      value: 'Up to 9 Mbps',
      choose: { ...(quality.choose as NonNullable<ThingSetting['choose']>), current: 9000 },
    };
    expect(settingRowView(odd).value).toBe('Up to 9 Mbps');
  });

  it('says where a setting is changed instead', () => {
    expect(settingRowView(updates)).toMatchObject({
      look: 'elsewhere',
      value: 'Ask me',
      tag: 'In Plex',
      url: 'http://plex.local/web',
    });
  });

  it('keeps the reason of a setting the viewer may not change', () => {
    const row = settingRowView({ ...remote, toggle: { ...lookOnly, target: 'remote_access' } });
    expect(row).toMatchObject({ allowed: false, reason: 'Whombat only looks here.' });
  });

  it('is only shown without a switch, Change or a page elsewhere', () => {
    expect(settingRowView({ id: 'v', label: 'Version', value: '1.43' })).toMatchObject({
      look: 'value',
      value: '1.43',
    });
  });
});

describe('the Change sheet', () => {
  it('lists the choices with Now on the current one and opens on it', () => {
    const sheet = settingSheet(quality);
    expect(sheet?.title).toBe('Quality outside your home');
    expect(sheet?.help).toContain('away from home');
    expect(sheet?.hint).toContain('40 Mbps');
    expect(sheet?.choices.map((c) => [c.label, c.now])).toEqual([
      ['Original quality', false],
      ['20 Mbps', false],
      ['8 Mbps', true],
    ]);
    expect(sheet?.initial).toBe(8000);
    expect(sheet?.changeId).toBe('chg_1');
    expect(settingSheet(remote)).toBeNull();
  });

  it('lets Change it go only for another choice the viewer may set', () => {
    const sheet = settingSheet(quality);
    if (!sheet) throw new Error('no sheet');
    expect(canChange(sheet, 8000)).toBe(false);
    expect(canChange(sheet, '8000')).toBe(false);
    expect(canChange(sheet, 20000)).toBe(true);
    expect(canChange(sheet, 12345)).toBe(false);
    expect(canChange(sheet, null)).toBe(false);
    const locked = settingSheet({
      ...quality,
      choose: { ...(quality.choose as NonNullable<ThingSetting['choose']>), button: lookOnly },
    });
    if (!locked) throw new Error('no sheet');
    expect(canChange(locked, 20000)).toBe(false);
    expect(locked.reason).toBe('Whombat only looks here.');
  });

  it('asks the assistant to help choose with the setting and the service named', () => {
    const q = SETTINGS_COPY.helpChoose('Conversion quality', 'Plex');
    expect(q).toContain('Conversion quality');
    expect(q).toContain('Plex');
    expect(SETTINGS_COPY.askInstead('Dusty')).toContain('Dusty');
  });

  it('puts a change back from the toast', () => {
    let ran = 0;
    const action = putBackAction(() => {
      ran += 1;
    });
    expect(action.label).toBe(SETTINGS_COPY.putBack);
    action.onPress();
    expect(ran).toBe(1);
  });
});

describe('a card’s Ask', () => {
  const panel: ThingPagePanel = {
    kind: 'settings',
    id: 'settings-remote',
    title: 'Watching away from home',
    rows: [remote],
    ask: { questions: ['Why does it buffer?'] },
  };

  it('names the assistant and the card, with its questions', () => {
    const ask = panelAsk(panel, 'Dusty');
    expect(ask?.title).toContain('Dusty');
    expect(ask?.title).toContain('Watching away from home');
    expect(ask?.questions).toEqual(['Why does it buffer?']);
    expect(ask?.other).toBe(SETTINGS_COPY.askElse);
  });

  it('is none without questions or a title', () => {
    expect(panelAsk({ ...panel, ask: undefined }, 'Dusty')).toBeNull();
    expect(panelAsk({ kind: 'text', id: 't', body: 'Hi', ask: { questions: ['Q?'] } }, 'Dusty')).toBeNull();
  });

  it('leaves out a group without rows unless it says why', () => {
    expect(shownPanels([{ ...panel, rows: [] }])).toEqual([]);
    expect(shownPanels([{ ...panel, rows: [], empty: 'Nothing here.' }])).toHaveLength(1);
  });
});

describe('pages from other releases', () => {
  const NOW = new Date(at('14:05'));
  const plex = () =>
    createThingPageFixtures({
      now: () => NOW,
      json: (body, status = 200) => new Response(JSON.stringify(body), { status }),
      notFound: (text) => new Response(JSON.stringify({ error: { message: text } }), { status: 404 }),
      bodyOf: async <T>(init: RequestInit | undefined) => JSON.parse(String(init?.body ?? '{}')) as T,
      heatOn: () => true,
      assistant: () => ({ id: mara.id, name: 'Neo' }),
      heatChatHref: '/chats/cnv_chat-heat',
    }).page('connection:con_plex') as ThingPage;

  it('an older Whombat’s page (no verdict, settings tab or Ask) still reads', () => {
    const { verdict: _verdict, ...older } = plex();
    const page = {
      ...older,
      tabs: older.tabs
        .filter((t) => t.key !== 'service-settings')
        .map((t) => ({ ...t, panels: t.panels.map(({ ask: _ask, ...p }) => p) })),
    };
    const decoded = decodeTolerant(ThingPage, JSON.parse(JSON.stringify(page)));
    if (!decoded.ok) throw decoded.error;
    expect(decoded.skipped).toEqual([]);
    expect(decoded.data.verdict).toBeUndefined();
    expect(phoneThingTabs(decoded.data).some((t) => t.key === 'service-settings')).toBe(false);
  });

  it('a newer Whombat’s panel of a kind this app doesn’t know is left out, the rest stays', () => {
    const page = plex();
    const tab = page.tabs.find((t) => t.key === 'service-settings');
    const newer = {
      ...page,
      tabs: page.tabs.map((t) =>
        t === tab ? { ...t, panels: [...t.panels, { kind: 'hologram', id: 'h', title: 'Newer' }] } : t,
      ),
    };
    const decoded = decodeTolerant(ThingPage, JSON.parse(JSON.stringify(newer)));
    if (!decoded.ok) throw decoded.error;
    const shown = decoded.data.tabs.find((t) => t.key === 'service-settings')?.panels.map((p) => p.id);
    expect(shown).toEqual(tab?.panels.map((p) => p.id));
  });
});
