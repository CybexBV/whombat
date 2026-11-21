import { describe, expect, it } from 'vitest';
import {
  constList,
  deskSocketSource,
  deskWordsSource,
  lookResearchSource,
  quietSource,
} from './contractsSource';
import {
  type DeskAsk,
  type DeskGlance,
  type DeskLook,
  LOOK_KINDS,
  LOOK_QUIET_HOWS,
  LOOK_STATES,
  LOOKS_MAX,
  NOTICE_CHECK_RE,
  NOTICE_NATURES,
  parseDesk,
} from './desk';
import { DESK, DESK_WORDS, fill } from './deskCopy';
import { trimGlance } from './deskHold';
import { nightLine } from './deskScene';
import {
  assistantLine,
  lookActions,
  lookDetail,
  lookQuestion,
  lookQuietBody,
  lookStage,
  lookStep,
  lookTitle,
  needRows,
  needsTotal,
  parseQuietAnswer,
  parseStepAnswer,
  quietDone,
  quietRefusal,
  researchSays,
  researchTitle,
} from './needsYou';
import {
  LOOK_FIX_LABEL_MAX,
  LOOK_RESEARCH_STATES,
  LOOK_SUMMARY_MAX,
  LOOK_TITLE_MAX,
  type LookResearch,
} from './research';

const ha: DeskLook = {
  key: 'connection:con_7Hq2v8LkP0aX',
  kind: 'connection',
  name: 'Home Assistant',
  state: 'look',
  reason: '2 integrations not loading',
};
const down: DeskLook = {
  key: 'server:nas',
  kind: 'server',
  name: 'nas',
  state: 'down',
  reason: null,
  server: 'nas',
};
const ask = (number: number): DeskAsk => ({
  number,
  kind: 'approval',
  title: 'Restart Plex on blackbox?',
  at: '2026-10-21T12:31:00Z',
  where: 'blackbox',
  detail: null,
  facts: [],
  approveLabel: null,
  onDesk: true,
  phoneReason: null,
});
const glance = (needsYou: DeskGlance['needsYou']): DeskGlance => ({
  status: { text: 'Home Assistant needs a look.', more: null },
  needsYou,
  working: null,
  done: [],
  servers: [],
  moreServers: 0,
  tiles: [],
  box: null,
});

describe('what needs a look (0.118, DK-93, CG-310)', () => {
  it('knows the contracts’ kinds, states and most', () => {
    expect(LOOK_KINDS).toEqual(constList(deskWordsSource, 'DESK_LOOK_KINDS'));
    expect(LOOK_STATES).toEqual(constList(deskWordsSource, 'DESK_LOOK_STATES'));
    expect(deskWordsSource).toContain(`export const DESK_LOOKS_MAX = ${LOOKS_MAX};`);
    expect(deskSocketSource).toContain('looks: z.array(DeskLook).min(1).max(DESK_LOOKS_MAX).optional()');
  });

  it('reads the looks the console server passes, leaving out one it can’t draw', () => {
    const d = parseDesk({
      v: 1,
      now: '2026-10-21T12:34:00Z',
      paired: null,
      pairing: null,
      lock: { state: 'locked' },
      glance: null,
      power: null,
      talk: null,
    });
    expect(d).not.toBeNull();
    const withLooks = parseDesk({
      v: 1,
      now: '2026-10-21T12:34:00Z',
      paired: {
        person: { name: 'John', initial: 'J', tone: 3 },
        assistant: { name: 'Neo', face: 'neo' },
        timeZone: 'Europe/Amsterdam',
        lockedView: 'summary',
        night: 'dim',
        quiet: false,
        voice: true,
      },
      pairing: null,
      lock: { state: 'locked' },
      glance: {
        ...glance({ count: 0, items: [] }),
        needsYou: {
          count: 0,
          items: [],
          looks: [
            ha,
            { ...down, server: 'nas/1' },
            { ...ha, key: 'x', state: 'broken' },
            { ...ha, name: '' },
          ],
        },
      },
      power: null,
      talk: null,
    });
    const looks = withLooks?.glance?.needsYou.looks;
    expect(looks?.map((l) => l.name)).toEqual(['Home Assistant', 'nas']);
    expect(looks?.[1]).not.toHaveProperty('server');
  });

  it('lists what is down first, then the asks, then the rest; counts them all', () => {
    const g = glance({ count: 3, items: [ask(7), ask(8)], looks: [down, ha] });
    expect(needRows(g).map((r) => (r.kind === 'ask' ? r.ask.number : r.look.name))).toEqual([
      'nas',
      7,
      8,
      'Home Assistant',
    ]);
    expect(needsTotal(g)).toBe(5);
    expect(needsTotal(glance({ count: 0, items: [] }))).toBe(0);
  });

  it('lets the assistant speak only while something needs you, about the first thing (DK-94)', () => {
    expect(assistantLine(glance({ count: 0, items: [] }))).toBeNull();
    expect(assistantLine(null)).toBeNull();
    const look = assistantLine(glance({ count: 0, items: [], looks: [ha] }));
    expect(look?.text).toContain('Home Assistant');
    expect(look?.opens).toEqual({ kind: 'look', look: ha });
    const asked = assistantLine(glance({ count: 1, items: [ask(7)], looks: [ha] }));
    expect(asked?.text).toContain('Restart Plex on blackbox');
    expect(asked?.text).not.toContain('?');
    expect(asked?.opens).toMatchObject({ kind: 'ask' });
    // Locked without titles: how many, and touching it is the PIN first.
    const counted = assistantLine(glance({ count: 2, items: [] }));
    expect(counted?.text).toContain('2');
    expect(counted?.opens).toBeNull();
  });

  it('says what it is and what Ask to fix it sends (DK-95, DK-96)', () => {
    expect(lookTitle(down)).toContain('nas');
    expect(lookTitle(down)).not.toBe(lookTitle({ ...down, state: 'look' }));
    expect(lookDetail(ha)).toBe('2 integrations not loading.');
    expect(lookDetail({ ...ha, reason: 'Filling up.' })).toBe('Filling up.');
    expect(lookDetail(down)).toBeNull();
    expect(lookQuestion(ha)).toContain('Home Assistant');
    expect(lookQuestion(ha)).toContain('2 integrations not loading');
    expect(lookQuestion({ ...ha, reason: 'Filling up.' })).not.toContain('..');
    expect(lookQuestion(down)).toContain('nas');
  });

  it('stays on a locked screen with the cards, never in Only the time (DK-93)', () => {
    const g = glance({ count: 1, items: [ask(7)], looks: [ha] });
    expect(trimGlance(g, 'summary').needsYou).toEqual({ count: 1, items: [], looks: [ha] });
    expect(trimGlance(g, 'time').needsYou).toEqual({ count: 1, items: [] });
    expect(trimGlance(g, 'everything').needsYou.looks).toEqual([ha]);
  });

  it('makes the night say something needs you (DK-03)', () => {
    expect(nightLine(glance({ count: 0, items: [], looks: [ha] }))).toBe('needsYou');
    expect(nightLine(glance({ count: 0, items: [] }))).toBe('fine');
  });
});

/** A desk state with these looks in Needs you, as the console server passes it. */
const withLooks = (looks: unknown[]) =>
  parseDesk({
    v: 1,
    now: '2026-10-22T09:00:00Z',
    paired: {
      person: { name: 'John', initial: 'J', tone: 3 },
      assistant: { name: 'Neo', face: 'neo' },
      timeZone: 'Europe/Amsterdam',
      lockedView: 'summary',
      night: 'dim',
      quiet: false,
      voice: true,
    },
    pairing: null,
    lock: { state: 'locked' },
    glance: { ...glance({ count: 0, items: [] }), needsYou: { count: 0, items: [], looks } },
    power: null,
    talk: null,
  })?.glance?.needsYou.looks ?? [];

const unifi: DeskLook = {
  key: 'connection:con_U1',
  kind: 'connection',
  name: 'UniFi',
  state: 'look',
  reason: 'Hallway AP is offline',
  notice: { check: 'unifi.device_offline', subject: 'device:64a1' },
  nature: 'problem',
  ignoreWords: 'Until it’s back online.',
  question: 'Why is Hallway AP offline in UniFi?',
};
const signIn: DeskLook = {
  key: 'connection:con_G1',
  kind: 'connection',
  name: 'Google',
  state: 'look',
  reason: 'Needs to be connected again',
  notice: { check: 'conn.signin' },
  nature: 'you',
};

describe('quieting a look (0.122, QN-20, CG-330…)', () => {
  it('knows the contracts’ kinds of line, checks, ways to quiet and the request', () => {
    expect(NOTICE_NATURES).toEqual(constList(quietSource, 'NOTICE_NATURES'));
    expect(quietSource).toContain(`export const NOTICE_CHECK_RE = /${NOTICE_CHECK_RE.source}/;`);
    expect(quietSource).toContain('export const NoticeCheck = z.string().max(80).regex(NOTICE_CHECK_RE);');
    expect(LOOK_QUIET_HOWS).toEqual(constList(deskSocketSource, 'DESK_LOOK_QUIET_HOWS'));
    expect(deskSocketSource).toContain("lookQuiet: '/v1/desk/look/quiet',");
    for (const field of [
      'notice: z.object({ check: NoticeCheck, subject: text(160).optional() }).optional(),',
      'nature: NoticeNature.optional(),',
      'ignoreWords: text(60).optional(),',
      'question: text(300).optional(),',
      'key: text(120),',
      'notice: z.strictObject({ check: NoticeCheck, subject: text(160).optional() }),',
    ])
      expect(deskSocketSource).toContain(field);
    expect(constList(deskSocketSource, 'DESK_SOCKET_ERRORS')).toEqual(
      expect.arrayContaining(['locked', 'not_allowed', 'not_found']),
    );
  });

  it('reads a look’s line exactly as sent, its kind and words; a heads-up is no look', () => {
    const looks = withLooks([
      { ...unifi, notice: { check: 'unifi.device_offline', subject: ' device:64a1 ' } },
      signIn,
      { ...unifi, key: 'connection:con_F1', name: 'Fusebox', nature: 'fyi' },
      { ...unifi, key: 'connection:con_X', name: 'Plex', nature: 'later', notice: { check: 'Plex down' } },
      { ...unifi, key: 'server:nas', name: 'nas', question: 'x'.repeat(400), ignoreWords: 'y'.repeat(80) },
    ]);
    expect(looks.map((l) => l.name)).toEqual(['UniFi', 'Google', 'Plex', 'nas']);
    const [u, g, plex, nas] = looks;
    const [sonarr] = withLooks([
      { ...unifi, key: 'connection:con_Y', name: 'Sonarr', notice: { check: 'sonarr.queue', subject: '' } },
    ]);
    expect(u?.notice).toEqual({ check: 'unifi.device_offline', subject: ' device:64a1 ' });
    expect(u).toMatchObject({ nature: 'problem', ignoreWords: unifi.ignoreWords, question: unifi.question });
    expect(g?.notice).toEqual({ check: 'conn.signin' });
    expect(g?.nature).toBe('you');
    // A nature it doesn't know is a problem's; a line it can't send back is none.
    expect(plex).not.toHaveProperty('nature');
    expect(plex).not.toHaveProperty('notice');
    expect(sonarr).not.toHaveProperty('notice');
    expect([...(nas?.question ?? '')]).toHaveLength(300);
    expect([...(nas?.ignoreWords ?? '')]).toHaveLength(60);
  });

  it('offers Ask for a problem only, Ignore and Not now only with a line', () => {
    expect(lookActions(unifi)).toMatchObject({ fix: true, quiet: true });
    expect(lookActions(signIn)).toMatchObject({ fix: false, quiet: true });
    // A runtime from before 0.122: as 0.118, Ask to look into it and no quiet.
    expect(lookActions(ha)).toMatchObject({ fix: true, quiet: false });
    expect(lookActions({ ...signIn, notice: undefined })).toMatchObject({ fix: false, quiet: false });
    // Without research there is no step and no plain Ask (3.5).
    expect(lookActions(unifi)).toMatchObject({ step: null, ask: false });
  });

  it('asks the line’s own question, else DK-96’s words', () => {
    expect(lookQuestion(unifi)).toBe(unifi.question);
    expect(lookQuestion({ ...unifi, question: undefined })).toContain('Hallway AP is offline');
    expect(DESK_WORDS.looks.fix).toContain('look into it');
  });

  it('lets the assistant offer to look into a problem, not into what only you can do', () => {
    expect(assistantLine(glance({ count: 0, items: [], looks: [unifi] }))?.more).toBe(DESK_WORDS.looks.offer);
    const you = assistantLine(glance({ count: 0, items: [], looks: [signIn] }));
    expect(you?.text).toContain('Google');
    expect(you?.more).toBe(DESK.youOffer);
    expect(you?.opens).toEqual({ kind: 'look', look: signIn });
  });

  it('sends the look’s key and its line as they came, and how', () => {
    expect(lookQuietBody(unifi, 'ignore')).toEqual({
      key: 'connection:con_U1',
      notice: { check: 'unifi.device_offline', subject: 'device:64a1' },
      how: 'ignore',
    });
    expect(lookQuietBody(signIn, 'snooze')).toEqual({
      key: 'connection:con_G1',
      notice: { check: 'conn.signin' },
      how: 'snooze',
    });
    expect(lookQuietBody(ha, 'ignore')).toBeNull();
  });

  it('reads Whombat’s answer and says a refusal in plain words', () => {
    const refused = (status: number, code: string) => parseQuietAnswer(status, { message: code });
    expect(parseQuietAnswer(200, { v: 1 })).toBe('quieted');
    expect(refused(409, 'locked')).toBe('locked');
    expect(refused(403, 'not_allowed')).toBe('notAllowed');
    expect(refused(404, 'not_found')).toBe('gone');
    expect(refused(503, 'unavailable')).toBe('failed');
    expect(refused(400, 'bad_request')).toBe('failed');
    expect(quietRefusal('notAllowed', 'UniFi')).toContain('UniFi');
    expect(quietRefusal('gone', 'UniFi')).toBe(DESK.lookChanged);
    expect(quietRefusal('failed', 'UniFi')).toBe(DESK_WORDS.talkFailed);
    expect(quietRefusal('locked', 'UniFi')).toBeNull();
    expect(quietDone('ignore')).toBe(DESK_WORDS.looks.ignored);
    expect(quietDone('snooze')).toBe(DESK_WORDS.looks.snoozed);
  });
});

describe('what the assistant found out about a look (3.5, Whombat look-research.md, CG-372…CG-376)', () => {
  const zigbee: LookResearch = {
    state: 'found',
    title: 'Zigbee stopped working in Home Assistant',
    summary: 'Zigbee didn’t start again after the update. Restarting it usually fixes this.',
    fix: 'Restart Zigbee',
  };
  const researched = (research: LookResearch): DeskLook => ({ ...unifi, research });

  it('knows the contracts’ states, bounds, path and request', () => {
    expect(LOOK_RESEARCH_STATES).toEqual(constList(lookResearchSource, 'LOOK_RESEARCH_STATES'));
    expect(lookResearchSource).toContain(`export const LOOK_TITLE_MAX = ${LOOK_TITLE_MAX};`);
    expect(lookResearchSource).toContain(`export const LOOK_SUMMARY_MAX = ${LOOK_SUMMARY_MAX};`);
    expect(lookResearchSource).toContain(`export const LOOK_FIX_LABEL_MAX = ${LOOK_FIX_LABEL_MAX};`);
    expect(deskSocketSource).toContain('research: LookResearch.optional(),');
    expect(deskSocketSource).toContain("lookFix: '/v1/desk/look/fix',");
    expect(deskSocketSource).toContain(
      'export const DeskLookFixRequest = z.strictObject({ v: V, key: text(120) });',
    );
  });

  it('reads the research on its own look: words cut, the step only while found', () => {
    const [found, fixing, other, unknown] = withLooks([
      {
        ...unifi,
        research: { ...zigbee, key: unifi.key, at: '2026-10-22T08:55:00Z', summary: 'x'.repeat(300) },
      },
      {
        ...unifi,
        key: 'server:nas',
        name: 'nas',
        research: { ...zigbee, key: 'server:nas', state: 'fixing' },
      },
      { ...unifi, key: 'server:pve', name: 'pve', research: { ...zigbee, key: 'server:nas' } },
      { ...unifi, key: 'server:pi', name: 'pi', research: { key: 'server:pi', state: 'thinking' } },
    ]);
    expect(found?.research).toMatchObject({ state: 'found', title: zigbee.title, fix: 'Restart Zigbee' });
    expect([...(found?.research?.summary ?? '')]).toHaveLength(LOOK_SUMMARY_MAX);
    expect(found?.research).not.toHaveProperty('at');
    expect(fixing?.research).toMatchObject({ state: 'fixing' });
    expect(fixing?.research).not.toHaveProperty('fix');
    // Another look's research, or a state it doesn't know: the look as before.
    expect(other).not.toHaveProperty('research');
    expect(unknown).not.toHaveProperty('research');
  });

  it('says where the assistant is in its words, and what it found once it did', () => {
    const looking = researched({ state: 'looking' });
    expect(lookStage(looking)).toBe('looking');
    expect(researchTitle(looking)).toBe(lookTitle(unifi));
    expect(researchSays(looking, 'looking', null)).toBe(
      fill(DESK_WORDS.looks.lookingSoFar, { reason: 'Hallway AP is offline' }),
    );
    expect(researchSays({ ...looking, reason: null }, 'looking', null)).toBe(DESK_WORDS.looks.looking);
    const found = researched(zigbee);
    expect(researchTitle(found)).toBe(zigbee.title);
    expect(researchSays(found, 'found', 'before')).toBe(zigbee.summary);
    expect(researchSays(researched({ state: 'found' }), 'found', 'before')).toBe('before');
    expect(researchSays(researched({ ...zigbee, state: 'fixing' }), 'fixing', null)).toBe(
      DESK_WORDS.looks.fixing,
    );
    // Failed or none: the look as before.
    expect(lookStage(researched({ ...zigbee, state: 'failed' }))).toBeNull();
    expect(researchTitle(researched({ ...zigbee, state: 'failed' }))).toBe(lookTitle(unifi));
    expect(lookStage(unifi)).toBeNull();
  });

  it('offers the step first once found, Ask then, Ignore and Not now while it may be quieted, only Close later', () => {
    expect(lookActions(researched({ state: 'looking' }))).toEqual({
      fix: false,
      quiet: true,
      step: null,
      ask: false,
    });
    expect(lookActions(researched(zigbee))).toEqual({
      fix: false,
      quiet: true,
      step: 'Restart Zigbee',
      ask: true,
    });
    // Only you: no step, but Ask about it.
    const you = { ...signIn, research: { ...zigbee, fix: undefined } };
    expect(lookActions(you)).toEqual({ fix: false, quiet: true, step: null, ask: true });
    expect(lookStep(you)).toBeNull();
    for (const state of ['fixing', 'fixed'] as const)
      expect(lookActions(researched({ ...zigbee, state }))).toEqual({
        fix: false,
        quiet: false,
        step: null,
        ask: false,
      });
    expect(lookActions(researched({ ...zigbee, state: 'failed' }))).toEqual(lookActions(unifi));
  });

  it('reads the step’s answer as Ignore’s, and says a refusal the same way', () => {
    expect(parseStepAnswer(200, { v: 1 })).toBe('taken');
    expect(parseStepAnswer(404, { message: 'not_found' })).toBe('gone');
    expect(parseStepAnswer(403, { message: 'not_allowed' })).toBe('notAllowed');
    expect(parseStepAnswer(409, { message: 'locked' })).toBe('locked');
    expect(parseStepAnswer(502, { message: 'failed' })).toBe('failed');
    expect(quietRefusal(parseStepAnswer(404, { message: 'not_found' }), 'UniFi')).toBe(DESK.lookChanged);
  });

  it('lets the assistant’s line say where it is instead of offering to look', () => {
    const line = (research: LookResearch) =>
      assistantLine(glance({ count: 0, items: [], looks: [researched(research)] }));
    expect(line({ state: 'looking' })?.more).toBe(DESK_WORDS.looks.looking);
    expect(line({ ...zigbee, state: 'fixing' })?.more).toBe(DESK_WORDS.looks.fixing);
    expect(line(zigbee)).toMatchObject({ text: zigbee.title, more: null });
  });
});
