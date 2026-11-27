/**
 * The card `vault_ask` posts (Whombat connect-in-chat.md, vault-simplify.md): its form's
 * field ids, its words and the card itself, one for every sign-in. The server builds the card with `vaultAskCard`;
 * the web and the phone show a `server` card's three ways and a locked card's line with the same words. The
 * assistant's own name is always a parameter, never “the agent”. Pure.
 */
import {
  GUIDE_VAULT_SERVER_TRIES,
  GuideCard,
  type GuideField,
  type GuideVaultAsk,
  type GuideVaultKind,
  type GuideVaultOutcome,
  type GuideVaultRefusal,
  type GuideVaultServerWay,
} from '../domain/guides.js';
import { coreTranslator, coreTree } from '../i18n/catalog.js';

/** The form block's id: what `guides.act` names when the person saves (or signs in). */
export const VAULT_ASK_FORM = 'save';
/** The Not now button's id. */
export const VAULT_ASK_DECLINE = 'no';

/**
 * The form's values by id (the keys of `guides.act`'s `values`). `secret` is a `login`'s or `basic`'s password or a
 * `token`; `totp` a `login`'s optional authenticator key; `way` a `server` card's chosen way (`GuideVaultServerWay`,
 * sent without a field of its own); `password`, `private_key` and `passphrase` a `server` card's; `code` a `code` card's.
 */
export const VAULT_ASK_FIELDS = {
  username: 'username',
  secret: 'secret',
  totp: 'totp',
  way: 'way',
  password: 'password',
  privateKey: 'private_key',
  passphrase: 'passphrase',
  code: 'code',
} as const;
export type VaultAskField = (typeof VAULT_ASK_FIELDS)[keyof typeof VAULT_ASK_FIELDS];

/** The `server` card's fields each way shows (the app hides the others; the server reads only these). */
export const VAULT_ASK_WAY_FIELDS: Readonly<Record<GuideVaultServerWay, readonly VaultAskField[]>> = {
  key_once: [VAULT_ASK_FIELDS.password],
  keep_password: [VAULT_ASK_FIELDS.password],
  own_key: [VAULT_ASK_FIELDS.privateKey, VAULT_ASK_FIELDS.passphrase],
};

/** The way a `server` card's form value names, `key_once` when absent or unknown. */
export function vaultAskWay(value: string | undefined): GuideVaultServerWay {
  return value === 'keep_password' || value === 'own_key' ? value : 'key_once';
}

const SERVER_WAYS = [
  'key_once',
  'keep_password',
  'own_key',
] as const satisfies readonly GuideVaultServerWay[];

/** The card's words: plain, the assistant by name, curly quotes. */
export interface VaultAskText {
  /** Under the field of every kind but `code`. */
  under: (assistant: string) => string;
  /** Under a `code` card's field. */
  underCode: string;
  /** A card that gives a saved entry a new secret. */
  replaces: (name: string) => string;
  save: string;
  signIn: string;
  /** A `code` card's button: the code isn't saved anywhere, so it isn't “Save”. */
  send: string;
  notNow: string;
  /** The desk screen in place of the form: it never takes a secret. */
  desk: string;
  fields: Readonly<
    Record<'username' | 'password' | 'token' | 'totp' | 'privateKey' | 'passphrase' | 'code', string>
  >;
  placeholders: Readonly<Record<'totp' | 'privateKey' | 'passphrase', string>>;
  /** A `server` card's ways, as the choice lists them. */
  ways: Readonly<Record<GuideVaultServerWay, (assistant: string) => string>>;
  /** The line under each way. */
  wayDetails: Readonly<Record<GuideVaultServerWay, (assistant: string) => string>>;
  /** After the last try failed: the card closes. */
  tooManyTries: string;
  /** A field left empty. */
  empty: Readonly<Record<'username' | 'secret' | 'token' | 'password' | 'privateKey' | 'code', string>>;
}

/** The card's words in a locale. */
export function vaultAskText(locale?: string | null): VaultAskText {
  const tr = coreTranslator(locale);
  const words = coreTree(locale, 'vaultAsk.text', {
    underCode: 0,
    save: 0,
    signIn: 0,
    send: 0,
    notNow: 0,
    desk: 0,
    fields: { username: 0, password: 0, token: 0, totp: 0, privateKey: 0, passphrase: 0, code: 0 },
    placeholders: { totp: 0, privateKey: 0, passphrase: 0 },
    empty: { username: 0, secret: 0, token: 0, password: 0, privateKey: 0, code: 0 },
  });
  const byWay = (group: 'ways' | 'wayDetails') =>
    Object.fromEntries(
      SERVER_WAYS.map((way) => [
        way,
        (assistant: string) => tr.t(`vaultAsk.text.${group}.${way}`, { assistant }),
      ]),
    ) as Record<GuideVaultServerWay, (assistant: string) => string>;
  return {
    ...words,
    under: (assistant: string) => tr.t('vaultAsk.text.under', { assistant }),
    replaces: (name: string) => tr.t('vaultAsk.text.replaces', { name }),
    ways: byWay('ways'),
    wayDetails: byWay('wayDetails'),
    tooManyTries: tr.t('vaultAsk.text.tooManyTries', { count: GUIDE_VAULT_SERVER_TRIES }),
  };
}

/** The card's words in English. */
export const VAULT_ASK_TEXT: VaultAskText = vaultAskText('en');

/** The card's title: “Dusty needs the password for github.com”, “Type the code github.com sent you”. */
export function vaultAskTitle(
  assistant: string,
  ask: Pick<GuideVaultAsk, 'kind' | 'name'> & {
    server?: Pick<NonNullable<GuideVaultAsk['server']>, 'reason'>;
  },
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const vars = { assistant, name: ask.name };
  const text = (() => {
    switch (ask.kind) {
      case 'token':
        return tr.t('vaultAsk.title.token', vars);
      case 'server':
        return ask.server?.reason === 'key_refused'
          ? tr.t('vaultAsk.title.keyRefused', vars)
          : tr.t('vaultAsk.title.server', vars);
      case 'code':
        return tr.t('vaultAsk.title.code', vars);
      default:
        return tr.t('vaultAsk.title.password', vars);
    }
  })();
  return text.slice(0, 120);
}

/** The line under the field: where it goes, or that a code isn't kept. */
export function vaultAskUnder(assistant: string, kind: GuideVaultKind, locale?: string | null): string {
  const tr = coreTranslator(locale);
  return kind === 'code' ? tr.t('vaultAsk.text.underCode') : tr.t('vaultAsk.text.under', { assistant });
}

/** The form's button: Sign in for a server, Send for a code, else Save. */
export function vaultAskSubmitLabel(kind: GuideVaultKind, locale?: string | null): string {
  const tr = coreTranslator(locale);
  if (kind === 'server') return tr.t('vaultAsk.text.signIn');
  if (kind === 'code') return tr.t('vaultAsk.text.send');
  return tr.t('vaultAsk.text.save');
}

/**
 * A try that didn't sign in, on its field, with the server's name: “That password didn’t work. Try again.”,
 * “prod-1 refused that key.”
 */
export function vaultAskErrorText(
  refusal: GuideVaultRefusal,
  server: string,
  locale?: string | null,
): string {
  return coreTranslator(locale).t(`vaultAsk.error.${refusal}`, { server });
}

/** The field a try's refusal shows on, for the way the person chose. */
export function vaultAskErrorField(refusal: GuideVaultRefusal, way: GuideVaultServerWay): VaultAskField {
  if (refusal === 'passphrase_wrong') return VAULT_ASK_FIELDS.passphrase;
  if (way === 'own_key') return VAULT_ASK_FIELDS.privateKey;
  return VAULT_ASK_FIELDS.password;
}

/**
 * The locked card's line, `GuideAnswer.label`: “Saved to your Vault · UniFi”, “Signed in to prod-1 · key
 * added”. `name` is the card's (the entry, the server or the site); `server` the server's name once added.
 */
export function vaultAskLockedLabel(
  outcome: GuideVaultOutcome,
  at: { name: string; server?: string | null },
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const server = at.server || at.name;
  if (outcome === 'declined') return tr.t('vaultAsk.text.notNow');
  return tr.t(`vaultAsk.locked.${outcome}`, { name: at.name, server });
}

const field = (
  id: VaultAskField,
  label: string,
  kind: GuideField['kind'],
  options: { optional?: boolean; placeholder?: string } = {},
): GuideField => ({
  id,
  label,
  kind,
  placeholder: options.placeholder ?? null,
  optional: options.optional ?? false,
});

/** The form's fields for a card (the username only when it isn't known; a server's for every way, all optional). */
export function vaultAskFields(ask: GuideVaultAsk, locale?: string | null): GuideField[] {
  const t = vaultAskText(locale);
  switch (ask.kind) {
    case 'server':
      // Which are needed depends on the way (`VAULT_ASK_WAY_FIELDS`): the server checks that, not the form.
      return [
        field(VAULT_ASK_FIELDS.password, t.fields.password, 'secret', { optional: true }),
        field(VAULT_ASK_FIELDS.privateKey, t.fields.privateKey, 'key_file', {
          optional: true,
          placeholder: t.placeholders.privateKey,
        }),
        field(VAULT_ASK_FIELDS.passphrase, t.fields.passphrase, 'secret', {
          optional: true,
          placeholder: t.placeholders.passphrase,
        }),
      ];
    case 'code':
      return [field(VAULT_ASK_FIELDS.code, t.fields.code, 'text')];
    case 'token':
      return [field(VAULT_ASK_FIELDS.secret, t.fields.token, 'secret')];
    default: {
      const fields: GuideField[] = [];
      if (!ask.username && !ask.entryId)
        fields.push(field(VAULT_ASK_FIELDS.username, t.fields.username, 'text'));
      fields.push(field(VAULT_ASK_FIELDS.secret, t.fields.password, 'secret'));
      if (ask.kind === 'login')
        fields.push(
          field(VAULT_ASK_FIELDS.totp, t.fields.totp, 'secret', {
            optional: true,
            placeholder: t.placeholders.totp,
          }),
        );
      return fields;
    }
  }
}

/**
 * The card (topic `secret`): the agent's reason, where it goes, the write-only form and Not now. Step node
 * `replace` when a saved entry gets a new secret, else the kind's (`new`, `server`, `code`). Server-made; `vaultAsk`
 * rides along so the form's values can only go where the card says.
 */
export function vaultAskCard(
  assistant: string,
  ask: GuideVaultAsk,
  why: string | null,
  locale?: string | null,
): GuideCard {
  const t = vaultAskText(locale);
  const lines: string[] = [];
  if (why?.trim()) lines.push(why.trim());
  if (ask.kind === 'code' && ask.hint?.trim()) lines.push(ask.hint.trim());
  if (ask.entryId && ask.kind !== 'server') lines.push(t.replaces(ask.name));
  lines.push(vaultAskUnder(assistant, ask.kind, locale));
  const node = ask.kind === 'server' || ask.kind === 'code' ? ask.kind : ask.entryId ? 'replace' : 'new';
  const card = GuideCard.parse({
    kind: 'guide',
    guide: 'secret',
    node,
    title: vaultAskTitle(assistant, ask, locale),
    body: lines.join('\n\n').slice(0, 1200),
    blocks: [
      {
        type: 'form',
        id: VAULT_ASK_FORM,
        fields: vaultAskFields(ask, locale),
        submitLabel: vaultAskSubmitLabel(ask.kind, locale),
      },
      {
        type: 'actions',
        actions: [{ id: VAULT_ASK_DECLINE, label: t.notNow, style: 'quiet', href: null }],
      },
    ],
    state: 'open',
    vaultAsk: ask,
  });
  return card;
}
