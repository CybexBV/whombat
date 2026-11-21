import { DESK_WORDS, type LookResearch, type NeedsYouItem, type ThingPage } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  deskHeroButtons,
  fixingResearch,
  lookFixOutcomeText,
  lookResearchView,
  lookThreadHref,
  withNeedsYouResearch,
  withThingResearch,
} from './lookResearch';
import {
  needsYouAskIntent,
  needsYouResearch,
  needsYouResearchActions,
  needsYouResearchWords,
  needsYouRows,
} from './needsYou';

const AT = '2026-10-27T09:12:00Z';
const KEY = 'connection:con_home-assistant';

function research(over: Partial<LookResearch> = {}): LookResearch {
  return {
    key: KEY,
    state: 'found',
    title: 'Zigbee stopped working in Home Assistant',
    summary: 'After this morning’s update, Zigbee didn’t start again.',
    fix: 'Restart Zigbee',
    conversationId: 'cnv_chat' as LookResearch['conversationId'],
    threadRootId: 'msg_look-ha' as LookResearch['threadRootId'],
    at: AT,
    ...over,
  };
}

function item(over: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    id: `ny_${KEY}`,
    ref: { kind: 'connection', id: 'con_home-assistant' },
    kind: 'connection',
    severity: 'warn',
    nature: 'problem',
    title: 'Home Assistant needs a look',
    body: '2 integrations stopped loading.',
    at: AT,
    subject: { kind: 'connection', id: 'con_home-assistant', name: 'Home Assistant' },
    actions: [
      { id: 'look', label: 'Look into it', style: 'primary', kind: 'investigate' },
      { id: 'later', label: 'Not now', style: 'secondary', kind: 'snooze' },
      { id: 'open', label: 'Open Home Assistant', style: 'primary', kind: 'open', href: '/things/x' },
    ],
    ...over,
  };
}

describe('lookResearchView (LR-09)', () => {
  it('draws nothing new without research or once it failed', () => {
    expect(lookResearchView(undefined, 'Neo')).toBeNull();
    expect(lookResearchView(research({ state: 'failed' }), 'Neo')).toBeNull();
  });

  it('while looking: the look’s own words stay, with the desk’s words and the reason so far', () => {
    const view = lookResearchView(research({ state: 'looking', title: undefined, fix: undefined }), 'Neo');
    expect(view).toMatchObject({
      state: 'looking',
      title: null,
      busy: true,
      fix: null,
      ignore: true,
      ask: null,
    });
    expect(view?.text).toBe(DESK_WORDS.looks.looking);
    const soFar = lookResearchView(research({ state: 'looking' }), 'Neo', '2 integrations stopped loading.');
    expect(soFar?.text).toContain('So far: 2 integrations stopped loading.');
    expect(soFar?.text).not.toContain('loading..');
  });

  it('once found: its title and summary, the step, Ignore and Ask with the assistant’s name', () => {
    expect(lookResearchView(research(), 'Neo')).toMatchObject({
      state: 'found',
      title: 'Zigbee stopped working in Home Assistant',
      text: 'After this morning’s update, Zigbee didn’t start again.',
      busy: false,
      fixed: false,
      fix: 'Restart Zigbee',
      ignore: true,
      ask: 'Ask Neo',
    });
    // Only the person can: no step.
    expect(lookResearchView(research({ fix: undefined }), 'Neo')?.fix).toBeNull();
  });

  it('while it takes the step and once fixed', () => {
    const fixing = lookResearchView(research({ state: 'fixing', fix: undefined }), 'Neo');
    expect(fixing).toMatchObject({ busy: true, fix: null, ask: 'Ask Neo' });
    expect(fixing?.text).toBe(DESK_WORDS.looks.fixing);
    const fixed = lookResearchView(
      research({
        state: 'fixed',
        title: 'Zigbee works again',
        summary: 'I restarted Zigbee.',
        fix: undefined,
      }),
      'Neo',
    );
    expect(fixed).toMatchObject({
      title: 'Zigbee works again',
      text: 'I restarted Zigbee.',
      fixed: true,
      fix: null,
      ignore: false,
    });
  });

  it('opens the look’s thread in Chat', () => {
    expect(lookThreadHref(research())).toBe('/chat?thread=msg_look-ha');
    expect(lookThreadHref(research({ threadRootId: undefined }))).toBeNull();
  });
});

describe('Needs you with research', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');

  it('a found item: the assistant’s words, its body folded into the summary, the step first', () => {
    const [row] = needsYouRows([item({ research: research() })], now, 'Europe/Amsterdam', 'Neo');
    expect(row?.title).toBe('Zigbee stopped working in Home Assistant');
    expect(row?.body).toBe('');
    expect(row?.research).toMatchObject({ key: KEY, view: { fix: 'Restart Zigbee', ask: 'Ask Neo' } });
    // Look into it and Not now go; Open stays, as a second choice after the step.
    expect(row?.actions.map((a) => [a.id, a.style])).toEqual([['open', 'secondary']]);
  });

  it('a looking item keeps its words and buttons, but not Look into it', () => {
    const looking = research({ state: 'looking', title: undefined, summary: undefined, fix: undefined });
    const [row] = needsYouRows([item({ research: looking })], now, 'Europe/Amsterdam', 'Neo');
    expect(row?.title).toBe('Home Assistant needs a look');
    expect(row?.body).toBe('2 integrations stopped loading.');
    expect(row?.actions.map((a) => a.id)).toEqual(['later', 'open']);
  });

  it('without a step its own buttons keep their look; without the assistant’s name, as before', () => {
    expect(
      needsYouResearchActions(item(), { state: 'found', fix: null }).map((a) => [a.id, a.style]),
    ).toEqual([['open', 'primary']]);
    const [row] = needsYouRows([item({ research: research() })], now, 'Europe/Amsterdam');
    expect(row?.research).toBeNull();
    expect(row?.title).toBe('Home Assistant needs a look');
  });

  it('the words beside it: the assistant’s title once it found out, the item’s own while it looks', () => {
    const own = item();
    expect(needsYouResearchWords(own, needsYouResearch(item({ research: research() }), 'Neo'))).toEqual({
      title: 'Zigbee stopped working in Home Assistant',
      body: '',
    });
    const fixing = needsYouResearch(
      item({ research: research({ state: 'fixing', title: undefined }) }),
      'Neo',
    );
    expect(needsYouResearchWords(own, fixing)).toEqual({ title: own.title, body: '' });
    const looking = needsYouResearch(item({ research: research({ state: 'looking' }) }), 'Neo');
    expect(needsYouResearchWords(own, looking)).toEqual({ title: own.title, body: own.body });
    expect(needsYouResearchWords(own, null)).toEqual({ title: own.title, body: own.body });
  });

  it('a failed research draws the item as before', () => {
    const [row] = needsYouRows(
      [item({ research: research({ state: 'failed' }) })],
      now,
      'Europe/Amsterdam',
      'Neo',
    );
    expect(row?.research).toBeNull();
    expect(row?.actions.map((a) => a.id)).toEqual(['look', 'later', 'open']);
  });

  it('Ask opens the thread, or starts a chat about it when there is none', () => {
    expect(needsYouAskIntent(item({ research: research() }))).toEqual({
      type: 'open',
      href: '/chat?thread=msg_look-ha',
    });
    expect(needsYouAskIntent(item({ research: research({ threadRootId: undefined }) }))).toMatchObject({
      type: 'investigate',
      subject: { id: 'con_home-assistant' },
    });
  });
});

describe('the step’s press (LR-08)', () => {
  it('reads fixing at once, without the step', () => {
    const next = fixingResearch(research(), Date.parse(AT) + 60_000);
    expect(next.state).toBe('fixing');
    expect(next.fix).toBeUndefined();
    expect(next.title).toBe('Zigbee stopped working in Home Assistant');
    expect(Date.parse(next.at)).toBe(Date.parse(AT) + 60_000);
  });

  it('puts the research on Home’s items and the page of its look only', () => {
    const other = item({ id: 'ny_other', research: research({ key: 'server:pve-02' }) });
    const home = { needsYou: [item({ research: research() }), other, item({ id: 'ny_plain' })] };
    const fixing = fixingResearch(research(), Date.parse(AT));
    const next = withNeedsYouResearch(home, fixing);
    expect(next.needsYou.map((i) => i.research?.state)).toEqual(['fixing', 'found', undefined]);
    expect(withNeedsYouResearch({ needsYou: [other] }, fixing).needsYou[0]).toBe(other);
    const page = { id: KEY, research: research() } as unknown as ThingPage;
    expect(withThingResearch(page, fixing).research?.state).toBe('fixing');
    const elsewhere = { id: 'server:pve-02' } as unknown as ThingPage;
    expect(withThingResearch(elsewhere, fixing)).toBe(elsewhere);
  });

  it('says only what went wrong', () => {
    expect(lookFixOutcomeText('ok')).toBeNull();
    expect(lookFixOutcomeText('gone')).toBeTruthy();
    expect(lookFixOutcomeText('forbidden')).not.toBe(lookFixOutcomeText('failed'));
  });
});

describe('deskHeroButtons (the preview’s hero, LR-09, LR-10)', () => {
  const words = { assistant: 'Neo', server: 'pve-01' };
  const labels = (b: ReturnType<typeof deskHeroButtons>) => b.map((x) => [x.label, x.look]);

  it('a question: Answer', () => {
    expect(labels(deskHeroButtons({ kind: 'ask', tone: 'bad' }, words))).toEqual([['Answer', 'primary']]);
  });

  it('a down server nobody looked into: Ask to fix it, Open, Ignore', () => {
    expect(labels(deskHeroButtons({ kind: 'look', tone: 'bad' }, words))).toEqual([
      ['Ask Neo to look into it', 'primary'],
      ['Open pve-01', 'outline'],
      [DESK_WORDS.calm.ignore, 'quiet'],
    ]);
  });

  it('found with a step: the step first; without one, no fix button', () => {
    expect(
      labels(deskHeroButtons({ kind: 'look', tone: 'bad', research: 'found', fix: 'Restart pve-01' }, words)),
    ).toEqual([
      ['Restart pve-01', 'primary'],
      ['Open pve-01', 'outline'],
      [DESK_WORDS.calm.ignore, 'quiet'],
    ]);
    expect(
      labels(deskHeroButtons({ kind: 'look', tone: 'warn', research: 'found' }, { ...words, server: null })),
    ).toEqual([[DESK_WORDS.calm.ignore, 'quiet']]);
  });

  it('while looking no fix button; once fixed nothing to ignore; failed as before', () => {
    expect(labels(deskHeroButtons({ kind: 'look', tone: 'bad', research: 'looking' }, words))).toEqual([
      ['Open pve-01', 'primary'],
      [DESK_WORDS.calm.ignore, 'quiet'],
    ]);
    expect(labels(deskHeroButtons({ kind: 'look', tone: 'bad', research: 'fixed' }, words))).toEqual([
      ['Open pve-01', 'primary'],
    ]);
    expect(deskHeroButtons({ kind: 'look', tone: 'bad', research: 'failed' }, words)[0]?.label).toBe(
      'Ask Neo to look into it',
    );
  });
});
