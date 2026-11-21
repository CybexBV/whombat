/**
 * The guides as state machines (docs/decisions/assistant-guides.md AG-04…AG-13): which steps a topic starts with
 * for the state of this Whombat, what each action means, and that every card fits the contract.
 */
import { GuideCard } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { parseAppForm } from './app-form';
import * as copy from './copy';
import {
  actionable,
  type GuideFacts,
  type GuidePost,
  GuideRefusal,
  materialize,
  resultStep,
  retrySteps,
  type Step,
  startSteps,
  transition,
} from './flows';
import { pickSuggestion, suggestionDue } from './suggestions';
import { mailStep } from './welcome';

function facts(over: Partial<GuideFacts> = {}): GuideFacts {
  return {
    personName: 'Mara',
    agentName: 'Dusty',
    google: { mode: 'real', enabled: true, appReady: true, appInConfig: false },
    connection: null,
    setup: {
      redirectUri: 'https://whombat.example.com/api/v1/connectors/google/callback',
      enableApisUrl: 'https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com',
      links: {
        createProject: 'https://console.cloud.google.com/projectcreate',
        consentScreen: 'https://console.cloud.google.com/auth/branding',
        audience: 'https://console.cloud.google.com/auth/audience',
        createClient: 'https://console.cloud.google.com/auth/clients/create',
      },
      scopes: [],
      appName: 'Whombat',
      supportEmail: 'mara@example.com',
      authorizedDomain: 'example.com',
    },
    timeZone: 'Europe/Amsterdam',
    chatPath: '/moss-co/chat',
    threadRootId: null,
    dontAsk: [],
    ...over,
  };
}

let n = 0;
const ids = () => `msg_test${++n}`;
const post = (steps: readonly Step[], f = facts()): GuidePost[] => materialize(steps, f, ids);
const only = (steps: readonly Step[], f = facts()): GuidePost => {
  const posts = post(steps, f);
  expect(posts).toHaveLength(1);
  return posts[0] as GuidePost;
};
const cardOf = (p: GuidePost): GuideCard => {
  if (!p.card) throw new Error('no card');
  // Every card is a valid contract card as stored and as read back.
  expect(GuideCard.parse(JSON.parse(JSON.stringify(p.card)))).toEqual(p.card);
  return p.card;
};
const blocksOf = (p: GuidePost, type: string) => cardOf(p).blocks.filter((b) => b.type === type);

describe('the welcome (AG-04)', () => {
  it('takes Gmail into the Google setup, keeps other email a link, and refuses what the card does not offer', () => {
    const card = cardOf(only([mailStep]));
    const gmail = transition(card, { actionId: 'google' }, facts());
    expect(gmail.label).toBe(copy.MAIL_GOOGLE);
    expect(cardOf(only(gmail.next)).blocks.some((b) => b.type === 'connect')).toBe(true);
    expect(() => transition(card, { actionId: 'imap' }, facts())).toThrow(GuideRefusal);
    expect(() => transition(card, { actionId: 'nope' }, facts())).toThrow(GuideRefusal);
  });

  it('still answers a welcome card from before', () => {
    const old = {
      kind: 'guide',
      guide: 'welcome',
      node: 'start',
      title: 'What would you like to set up?',
      body: '',
      step: null,
      state: 'open',
      answer: null,
      blocks: [
        {
          type: 'choices',
          id: 'topic',
          mode: 'single',
          submitLabel: null,
          options: [
            { id: 'email', title: 'Email', description: '', icon: null, badge: null, disabled: false },
          ],
        },
      ],
    } as GuideCard;
    expect(transition(old, { actionId: 'topic', optionIds: ['email'] }, facts()).next).toHaveLength(1);
    expect(() => transition(old, { actionId: 'topic', optionIds: ['github'] }, facts())).toThrow(
      GuideRefusal,
    );
  });
});

describe('connect topics (AG-05)', () => {
  it('offers Google and other email (IMAP), with Microsoft 365 coming soon', () => {
    const p = only(startSteps('email', facts()));
    expect(p.text).toBe('I’ll guide you through it. You only do this once; after that it keeps working.');
    const card = cardOf(p);
    expect(card.title).toBe('Connect your email');
    const [choices] = card.blocks;
    if (choices?.type !== 'choices') throw new Error('no choices');
    expect(choices.options.map((o) => [o.id, o.disabled, o.badge?.label ?? null])).toEqual([
      ['google', false, null],
      ['microsoft', true, 'Coming soon'],
      ['other', false, null],
    ]);
    // A mailbox over IMAP is connected in Settings, where its password is typed (CM-19).
    const other = transition(card, { actionId: 'provider', optionIds: ['other'] }, facts());
    expect(other.next.map((step) => step(facts(), 'msg_x').text).join(' ')).toContain('Email (IMAP)');
    expect(choices.options[0]?.icon).toEqual({ brand: 'google' });
    // “Other email” is for email only.
    const calendar = cardOf(only(startSteps('calendar', facts())));
    expect(calendar.blocks[0]?.type === 'choices' && calendar.blocks[0].options.map((o) => o.id)).toEqual([
      'google',
      'microsoft',
    ]);
    expect(() => transition(card, { actionId: 'provider', optionIds: ['microsoft'] }, facts())).toThrow(
      'That option isn’t available yet.',
    );
  });
});

describe('the person’s Google app setup (AG-06)', () => {
  const noApp = facts({
    google: { mode: 'real', enabled: true, appReady: false, appInConfig: false },
  });

  it('walks steps 1 to 6 with CN-03’s links and values', () => {
    const intro = cardOf(only(startSteps('google_app', noApp), noApp));
    expect(intro.node).toBe('intro.none');
    let t = transition(intro, { actionId: 'audience', optionIds: ['external'] }, noApp);
    expect(t.label).toBe('A personal Gmail account');
    for (let step = 1; step <= 4; step++) {
      const p = only(t.next, noApp);
      const card = cardOf(p);
      expect(card.step).toEqual({ index: step, total: 6 });
      expect(card.title).toBe(copy.STEP_TITLES[step - 1]);
      t = transition(card, { actionId: 'next' }, noApp);
      expect(t.label).toBe('Done, next step');
    }
    const five = cardOf(only(t.next, noApp));
    expect(five).toMatchObject({ node: 'step_5.external.none', step: { index: 5, total: 6 } });
    const [form] = five.blocks;
    expect(form).toMatchObject({ type: 'form', id: 'app', submitLabel: 'Save' });
    // The form can't be answered without the route's save.
    expect(() => transition(five, { actionId: 'app' }, noApp)).toThrow(GuideRefusal);
    const saved = transition(five, { actionId: 'app' }, noApp, {
      clientIdHint: '1234567890ab…',
      redirectListed: true,
    });
    expect(saved.label).toBe('Client ID 1234567890ab… saved');
    const six = only(saved.next, noApp);
    expect(six.text).toBe('Saved. Now connect your own Google account to test it.');
    expect(cardOf(six)).toMatchObject({ step: { index: 6, total: 6 }, title: 'Test it' });
    expect(blocksOf(six, 'connect')).toHaveLength(1);
  });
});

describe('coming back from Google (AG-08)', () => {
  it('a failure explains itself with a new connect card (none without an app)', () => {
    const p = only(retrySteps('email', 'access_denied', ['mail']));
    expect(p.text).toBe(copy.CONNECT_ERROR_TEXT.access_denied);
    expect(cardOf(p).blocks[0]).toMatchObject({ type: 'connect', services: ['mail'] });
    expect(only(retrySteps('email', 'no_app', ['mail'])).card).toBeNull();
  });
});

describe('suggestions (AG-11)', () => {
  const day = 24 * 3_600_000;
  const now = new Date('2026-09-26T12:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * day);
  const base = {
    now,
    enabled: true,
    lastSuggestedAt: null,
    welcomedAt: ago(4),
    activeAt: ago(1),
    openCard: false,
  };

  it('at most one per 7 days, not within 3 days of the welcome, only when active, never over an open card', () => {
    expect(suggestionDue(base)).toBe(true);
    expect(suggestionDue({ ...base, enabled: false })).toBe(false);
    expect(suggestionDue({ ...base, lastSuggestedAt: ago(6) })).toBe(false);
    expect(suggestionDue({ ...base, lastSuggestedAt: ago(7) })).toBe(true);
    expect(suggestionDue({ ...base, welcomedAt: ago(2) })).toBe(false);
    expect(suggestionDue({ ...base, welcomedAt: null })).toBe(false);
    expect(suggestionDue({ ...base, activeAt: ago(4) })).toBe(false);
    expect(suggestionDue({ ...base, activeAt: null })).toBe(false);
    expect(suggestionDue({ ...base, openCard: true })).toBe(false);
  });
});

describe('the skills pack offer is gone (skill-store.md SST-09, SST-S20)', () => {
  const connected = {
    email: 'mara@example.com',
    services: ['mail', 'calendar', 'files', 'docs', 'sheets', 'contacts'] as const,
    status: 'active' as const,
    checks: [],
  };

  it('is neither started nor suggested', () => {
    expect(startSteps('skills', facts())).toEqual([]);
    const done = facts({ connection: connected });
    expect(pickSuggestion(done)).toBeNull();
    expect(pickSuggestion(facts())).toBe('email');
  });

  it('an old card’s Add changes nothing and points to Settings → Skills', () => {
    const actions = [
      { id: 'attach', label: 'Add the skills', style: 'primary', href: null },
      { id: 'never', label: 'Don’t ask again', style: 'quiet', href: null },
    ];
    const card = {
      guide: 'skills',
      node: 'offer',
      state: 'open',
      blocks: [{ type: 'actions', actions }],
    } as unknown as GuideCard;
    const t = transition(card, { actionId: 'attach' }, facts());
    expect(t.effects).toEqual([]);
    expect(only(t.next).text).toContain('Settings → Skills');
    const never = transition({ ...card, node: 'suggest' } as GuideCard, { actionId: 'never' }, facts());
    expect(never.effects).toEqual([{ kind: 'dont_ask', topic: 'skills' }]);
  });
});

describe('cards', () => {
  it('are open only while they wait for the person', () => {
    expect(actionable(cardOf(only([mailStep])))).toBe(true);
    expect(cardOf(only([resultStep(null, null)])).state).toBe('done');
  });

  it('a step that asks never stands', () => {
    expect(cardOf(only([mailStep])).standing).toBeUndefined();
  });
});

describe('the app form (AG-06 step 5)', () => {
  const uri = 'https://whombat.example.com/api/v1/connectors/google/callback';
  const web = (extra: object = {}) =>
    JSON.stringify({
      web: {
        client_id: '1234567890-abc.apps.googleusercontent.com',
        client_secret: 'GOCSPX-secret1',
        ...extra,
      },
    });

  it('takes the pasted id and secret, or the JSON file', () => {
    expect(
      parseAppForm(
        { clientId: ' 1234567890-abc.apps.googleusercontent.com ', clientSecret: 'GOCSPX-secret1' },
        uri,
      ),
    ).toEqual({
      clientId: '1234567890-abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-secret1',
      redirectListed: true,
    });
    expect(parseAppForm({ clientJson: web({ redirect_uris: [uri] }) }, uri).redirectListed).toBe(true);
    expect(parseAppForm({ clientJson: web() }, uri).redirectListed).toBe(false);
  });

  it('refuses a Desktop client, a wrong file and missing values, by field, without echoing them', () => {
    const refusal = (values: Record<string, string>) => {
      try {
        parseAppForm(values, uri);
      } catch (err) {
        return err as GuideRefusal;
      }
      throw new Error('accepted');
    };
    expect(refusal({ clientJson: JSON.stringify({ installed: {} }) }).fields).toEqual({
      clientJson: ['This is a Desktop app client. Create one of type Web application.'],
    });
    expect(refusal({ clientJson: 'not json' }).fields).toEqual({ clientJson: [copy.NOT_A_CLIENT_FILE] });
    expect(refusal({ clientSecret: 'GOCSPX-secret1' }).fields).toEqual({
      clientId: [copy.CLIENT_ID_MISSING],
    });
    const noSecret = refusal({ clientId: '1234567890-abc.apps.googleusercontent.com' });
    expect(noSecret.code).toBe('invalid_values');
    expect(noSecret.fields).toEqual({ clientSecret: [copy.CLIENT_SECRET_MISSING] });
    expect(JSON.stringify(refusal({ clientId: 'bad id!', clientSecret: 'GOCSPX-secret1' }))).not.toContain(
      'GOCSPX',
    );
  });
});
