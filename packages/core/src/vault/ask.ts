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

/** The card's words: plain, the assistant by name, curly quotes. */
export const VAULT_ASK_TEXT = {
  /** Under the field of every kind but `code`. */
  under: (assistant: string) => `It goes straight to your Vault. ${assistant} never sees it.`,
  /** Under a `code` card's field. */
  underCode: 'Used once, not kept.',
  /** A card that gives a saved entry a new secret. */
  replaces: (name: string) => `It replaces the one saved as “${name}”.`,
  save: 'Save',
  signIn: 'Sign in',
  /** A `code` card's button: the code isn't saved anywhere, so it isn't “Save”. */
  send: 'Send',
  notNow: 'Not now',
  /** The desk screen in place of the form: it never takes a secret. */
  desk: 'Answer on your phone or computer',
  fields: {
    username: 'Username',
    password: 'Password',
    token: 'Sign-in key',
    totp: 'Authenticator key',
    privateKey: 'Private key',
    passphrase: 'Passphrase',
    code: 'Code',
  },
  placeholders: {
    totp: 'Optional: the setup key or otpauth:// link',
    privateKey: 'Paste it or pick the file',
    passphrase: 'Only if the key has one',
  },
  /** A `server` card's ways, as the choice lists them. */
  ways: {
    key_once: (assistant: string) => `Use the password once to put ${assistant}’s key on it`,
    keep_password: () => 'Keep the password',
    own_key: () => 'Use my own private key',
  } satisfies Record<GuideVaultServerWay, (assistant: string) => string>,
  /** The line under each way. */
  wayDetails: {
    key_once: (assistant: string) =>
      `Whombat signs in once, adds ${assistant}’s key and forgets the password.`,
    keep_password: () => 'For servers that don’t take keys. Kept in your Vault with this server.',
    own_key: () => 'Paste it or pick the file. A passphrase is used once and not kept.',
  } satisfies Record<GuideVaultServerWay, (assistant: string) => string>,
  /** After the last try failed: the card closes. */
  tooManyTries: `That didn’t work ${GUIDE_VAULT_SERVER_TRIES} times, so this card is closed.`,
  /** A field left empty. */
  empty: {
    username: 'Type the username.',
    secret: 'Type the password.',
    token: 'Type the sign-in key.',
    password: 'Type the password.',
    privateKey: 'Paste the private key or pick its file.',
    code: 'Type the code.',
  },
} as const;

/** The card's title: “Dusty needs the password for github.com”, “Type the code github.com sent you”. */
export function vaultAskTitle(
  assistant: string,
  ask: Pick<GuideVaultAsk, 'kind' | 'name'> & {
    server?: Pick<NonNullable<GuideVaultAsk['server']>, 'reason'>;
  },
): string {
  const text = (() => {
    switch (ask.kind) {
      case 'token':
        return `${assistant} needs a sign-in key for ${ask.name}`;
      case 'server':
        return ask.server?.reason === 'key_refused'
          ? `${assistant} couldn’t sign in to ${ask.name} with its key`
          : `${assistant} needs to sign in to ${ask.name}`;
      case 'code':
        return `Type the code ${ask.name} sent you`;
      default:
        return `${assistant} needs the password for ${ask.name}`;
    }
  })();
  return text.slice(0, 120);
}

/** The line under the field: where it goes, or that a code isn't kept. */
export function vaultAskUnder(assistant: string, kind: GuideVaultKind): string {
  return kind === 'code' ? VAULT_ASK_TEXT.underCode : VAULT_ASK_TEXT.under(assistant);
}

/** The form's button: Sign in for a server, Send for a code, else Save. */
export function vaultAskSubmitLabel(kind: GuideVaultKind): string {
  if (kind === 'server') return VAULT_ASK_TEXT.signIn;
  if (kind === 'code') return VAULT_ASK_TEXT.send;
  return VAULT_ASK_TEXT.save;
}

/**
 * A try that didn't sign in, on its field, with the server's name: “That password didn’t work. Try again.”,
 * “prod-1 refused that key.”
 */
export function vaultAskErrorText(refusal: GuideVaultRefusal, server: string): string {
  switch (refusal) {
    case 'password_wrong':
      return 'That password didn’t work. Try again.';
    case 'password_login_off':
      return `${server} doesn’t take passwords. Use your own private key instead.`;
    case 'key_refused':
      return `${server} refused that key.`;
    case 'passphrase_wrong':
      return 'That passphrase doesn’t open the key.';
    case 'key_invalid':
      return 'That isn’t a private key Whombat can use.';
    case 'host_key_changed':
      return `Something else answers at ${server}’s address now, so Whombat sent nothing. Check the server in the Vault.`;
    case 'unreachable':
      return `Couldn’t reach ${server}. Check it’s on and try again.`;
    case 'not_allowed':
      return `Whombat can’t reach ${server}’s address.`;
  }
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
): string {
  const server = at.server || at.name;
  switch (outcome) {
    case 'saved':
      return `Saved to your Vault · ${at.name}`;
    case 'signed_in':
      return `Signed in to ${server}`;
    case 'key_added':
      return `Signed in to ${server} · key added`;
    case 'password_saved':
      return `Signed in to ${server} · password saved`;
    case 'key_imported':
      return `Signed in to ${server} · your key saved`;
    case 'code_given':
      return 'Code used once · not kept';
    case 'refused':
      return `Couldn’t sign in to ${server}`;
    case 'declined':
      return VAULT_ASK_TEXT.notNow;
    case 'too_late':
      return 'Too late for that sign-in · not used';
  }
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
export function vaultAskFields(ask: GuideVaultAsk): GuideField[] {
  const t = VAULT_ASK_TEXT;
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
export function vaultAskCard(assistant: string, ask: GuideVaultAsk, why: string | null): GuideCard {
  const lines: string[] = [];
  if (why?.trim()) lines.push(why.trim());
  if (ask.kind === 'code' && ask.hint?.trim()) lines.push(ask.hint.trim());
  if (ask.entryId && ask.kind !== 'server') lines.push(VAULT_ASK_TEXT.replaces(ask.name));
  lines.push(vaultAskUnder(assistant, ask.kind));
  const node = ask.kind === 'server' || ask.kind === 'code' ? ask.kind : ask.entryId ? 'replace' : 'new';
  const card = GuideCard.parse({
    kind: 'guide',
    guide: 'secret',
    node,
    title: vaultAskTitle(assistant, ask),
    body: lines.join('\n\n').slice(0, 1200),
    blocks: [
      {
        type: 'form',
        id: VAULT_ASK_FORM,
        fields: vaultAskFields(ask),
        submitLabel: vaultAskSubmitLabel(ask.kind),
      },
      {
        type: 'actions',
        actions: [{ id: VAULT_ASK_DECLINE, label: VAULT_ASK_TEXT.notNow, style: 'quiet', href: null }],
      },
    ],
    state: 'open',
    vaultAsk: ask,
  });
  return card;
}
