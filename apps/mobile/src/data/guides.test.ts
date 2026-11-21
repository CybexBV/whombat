import { GUIDE_VALUE_MAX } from '@whombat/core/contracts';
import { GuideCard, type GuideField } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  applyClientFile,
  connectAppLabel,
  connectLabel,
  connectNote,
  connectStartProblem,
  connectWebUrl,
  DESKTOP_CLIENT_ERROR,
  formValues,
  GUIDE_TEXT,
  guideAnswerText,
  guideView,
  missingFields,
  NOT_A_CLIENT_FILE,
  parseClientSecretFile,
  toggleOption,
} from './guides';

const AT = '2026-09-26T10:00:00.000Z';

function card(over: Record<string, unknown> = {}): GuideCard {
  return GuideCard.parse({
    kind: 'guide',
    guide: 'email',
    node: 'provider',
    step: { index: 2, total: 6 },
    title: 'Connect your email',
    body: 'I’ll guide you through it.\n\nYou only do this once; after that it keeps working.',
    blocks: [
      {
        type: 'choices',
        id: 'provider',
        options: [
          { id: 'google', title: 'Google', icon: { brand: 'google' } },
          { id: 'microsoft', title: 'Microsoft 365', disabled: true, badge: { label: 'Coming soon' } },
        ],
      },
      { type: 'actions', actions: [{ id: 'later', label: 'Maybe later', style: 'quiet' }] },
    ],
    state: 'open',
    ...over,
  });
}

const FIELDS: GuideField[] = [
  { id: 'clientId', label: 'Client ID', kind: 'text', placeholder: null, optional: false },
  { id: 'clientSecret', label: 'Client secret', kind: 'secret', placeholder: null, optional: false },
  {
    id: 'clientJson',
    label: 'Or the downloaded JSON file',
    kind: 'json_file',
    placeholder: null,
    optional: true,
  },
];

const WEB_FILE = JSON.stringify({
  web: { client_id: ' 123-abc.apps.googleusercontent.com ', client_secret: 'GOCSPX-x', redirect_uris: [] },
});

describe('guide card view', () => {
  it('builds the label row, paragraphs and the open state', () => {
    const v = guideView(card());
    expect(v.label).toBe('SET UP · EMAIL · STEP 2 OF 6');
    expect(v.title).toBe('Connect your email');
    expect(v.paragraphs).toEqual([
      'I’ll guide you through it.',
      'You only do this once; after that it keeps working.',
    ]);
    expect(v.locked).toBe(false);
    expect(v.answer).toBeNull();
    expect(v.chosen).toEqual([]);
    expect(v.blocks.map((b) => b.type)).toEqual(['choices', 'actions']);
  });

  it('labels an unknown topic GUIDE and a card without a step by its topic', () => {
    expect(guideView(card({ guide: 'newer_topic', step: null })).label).toBe('GUIDE');
    expect(guideView(card({ guide: 'repair', step: null })).label).toBe('RECONNECT');
  });

  it('locks a done card with “You chose …” and the chosen options', () => {
    const v = guideView(
      card({
        state: 'done',
        answer: { actionId: 'provider', optionIds: ['google'], label: 'Google', at: AT },
      }),
    );
    expect(v.locked).toBe(true);
    expect(v.answer).toBe('You chose Google');
    expect(v.chosen).toEqual(['google']);
  });

  it('shows the expiry note on an expired card without an answer', () => {
    expect(guideView(card({ state: 'expired' })).answer).toBe(GUIDE_TEXT.expired);
    expect(guideAnswerText({ state: 'expired', answer: null })).toBe('This expired. Ask me any time.');
    expect(guideAnswerText({ state: 'open', answer: null })).toBeNull();
  });

  it('ticks and unticks options', () => {
    expect(toggleOption([], 'a')).toEqual(['a']);
    expect(toggleOption(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('guide form', () => {
  it('asks for the required fields left empty', () => {
    expect(missingFields(FIELDS, { clientId: '  ' })).toEqual({
      clientId: 'Fill this in.',
      clientSecret: 'Fill this in.',
    });
    expect(missingFields(FIELDS, { clientId: 'a', clientSecret: 'b' })).toEqual({});
  });

  it('sends the filled values as typed and leaves empty ones out', () => {
    expect(formValues(FIELDS, { clientId: ' a ', clientSecret: 'b', clientJson: '' })).toEqual({
      clientId: ' a ',
      clientSecret: 'b',
    });
  });

  it('reads Google’s client file like the web', () => {
    expect(parseClientSecretFile(WEB_FILE)).toEqual({
      ok: true,
      clientId: '123-abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-x',
    });
    expect(parseClientSecretFile('{"installed":{"client_id":"x","client_secret":"y"}}')).toEqual({
      ok: false,
      error: DESKTOP_CLIENT_ERROR,
    });
    expect(parseClientSecretFile('not json')).toEqual({ ok: false, error: NOT_A_CLIENT_FILE });
    expect(parseClientSecretFile('{"web":{"client_id":"x"}}')).toEqual({
      ok: false,
      error: NOT_A_CLIENT_FILE,
    });
  });

  it('fills the first text and secret fields from a Web client file, and keeps the file’s text', () => {
    expect(applyClientFile(FIELDS, 'clientJson', WEB_FILE)).toEqual({
      values: {
        clientJson: WEB_FILE,
        clientId: '123-abc.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-x',
      },
      error: null,
    });
    expect(applyClientFile(FIELDS, 'clientJson', '{"installed":{}}')).toEqual({
      values: {},
      error: 'This is a Desktop app client. Create one of type Web application.',
    });
    expect(applyClientFile(FIELDS, 'clientJson', ' '.repeat(GUIDE_VALUE_MAX + 1)).error).toBe(
      GUIDE_TEXT.fileTooBig,
    );
  });
});

describe('guide links', () => {
  const managed = { applianceId: 'dev_1', uiOrigin: 'https://app.whombat.com/' };
  const demo = { applianceId: null, uiOrigin: 'https://app.whombat.com' };

  it('opens the card’s thread in Chat on the web for the connect block, without the guide marker', () => {
    const block = { returnTo: '/acme/chat?thread=msg_root&guide=msg_card' };
    expect(connectWebUrl(managed, block)).toBe(
      'https://app.whombat.com/appliances/dev_1/acme/chat?thread=msg_root',
    );
    expect(connectWebUrl(managed, { returnTo: '/acme/chat?guide=msg_card' })).toBe(
      'https://app.whombat.com/appliances/dev_1/acme/chat',
    );
    expect(connectWebUrl(demo, block)).toBeNull();
    expect(connectLabel({ provider: 'google', reconnect: false })).toBe('Connect Google on the web');
    expect(connectLabel({ provider: 'google', reconnect: true })).toBe('Reconnect Google on the web');
    expect(connectNote({ provider: 'google' })).toBe('Google sign-in opens in your browser.');
    // The phone starts the sign-in itself on a managed Whombat (phone-connect.md AP-2907).
    expect(connectAppLabel({ provider: 'google', reconnect: false })).toBe('Connect Google');
    expect(connectAppLabel({ provider: 'microsoft', reconnect: true })).toBe('Reconnect Microsoft');
    expect(connectStartProblem({ provider: 'google' })).toContain('Google');
  });
});
