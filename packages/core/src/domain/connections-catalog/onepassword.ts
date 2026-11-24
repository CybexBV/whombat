import { BEARER, type CatalogEntryInput } from './shared.js';

/** The field naming the 1Password vault the Vault is kept in step with; the service lists the token's vaults. */
export const ONEPASSWORD_VAULT_FIELD = 'vault';

/** The form's one question (“Your Vault entries”): what happens to the entries already in the Vault when linking. */
export const ONEPASSWORD_ENTRIES_FIELD = 'entries';

/**
 * Its two answers: `put` puts the logins and API tokens already in the Vault in the 1Password vault too (the default:
 * the person asked for both ways), `keep` leaves them only in Whombat. What is added afterwards syncs either way.
 */
export const ONEPASSWORD_ENTRIES_CHOICES = [
  { value: 'put', label: 'Also put them in this 1Password vault' },
  { value: 'keep', label: 'Keep them only in Whombat' },
] as const;

export type OnePasswordEntriesChoice = (typeof ONEPASSWORD_ENTRIES_CHOICES)[number]['value'];

/** Where the base URL points: nowhere. Only 1Password's own SDK talks to 1Password, never a request of Whombat's. */
export const ONEPASSWORD_BASE_URL = 'onepassword:';

/**
 * 1Password (docs/decisions/onepassword-sync.md): a vault of the person's kept in step with their Vault, both ways. It
 * signs in with a service account token, sealed like every connection's secret; only the Vault's sync uses it, never
 * the assistant. Its check signs in through 1Password's SDK and lists the vaults the token sees, which fill the vault
 * field. The form says what happens before anything moves: the person consents to a new place for their secrets.
 * Steps follow 1Password's own guide (https://www.1password.dev/service-accounts/get-started, read 2026-11-24).
 */
export const entry = {
  id: 'onepassword',
  name: '1Password',
  category: 'productivity',
  description: 'Keep a 1Password vault and your Vault in step, both ways.',
  use: 'vault',
  signIn: [
    {
      kind: 'token',
      label: 'Service account token',
      auth: BEARER,
      secretLabel: 'Service account token',
      secretHelp:
        'A 1Password service account that can read and write only the vault you made for Whombat. 1Password shows its token once.',
      steps: [
        { text: 'On 1Password.com, make a new vault for Whombat.' },
        {
          text: 'Open Developer → Directory, choose Other under Infrastructure Secrets Management, then Create a Service Account.',
        },
        {
          text: 'Let it read and write only the vault you made for Whombat. It can’t be changed later.',
        },
        { text: 'Copy the token 1Password shows and paste it here.' },
      ],
    },
  ],
  fields: [
    {
      id: ONEPASSWORD_VAULT_FIELD,
      label: 'Vault',
      kind: 'select',
      required: true,
      fromService: true,
      help: 'The 1Password vault Whombat keeps in step with your Vault. Logins and API tokens go both ways; Whombat’s own settings stay in Whombat.',
    },
    {
      id: ONEPASSWORD_ENTRIES_FIELD,
      label: 'Your Vault entries',
      kind: 'select',
      required: false,
      default: 'put',
      options: [...ONEPASSWORD_ENTRIES_CHOICES],
      help: 'The logins and API tokens already in your Vault. Passwords you give Whombat from now on go into this 1Password vault too.',
    },
  ],
  transport: 'rest',
  baseUrl: ONEPASSWORD_BASE_URL,
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'onepassword' },
  tools: [],
  request: null,
  guide:
    'Make a vault in 1Password for Whombat and a service account that can read and write only that vault. Whombat then keeps that vault and your Vault in step, both ways: website logins and API tokens you change on one side change on the other. Notes, SSH keys and Whombat’s own settings stay where they are. The passwords you give Whombat go into that vault too. The assistant doesn’t use this connection.',
  sensitive: [],
  docsUrl: 'https://www.1password.dev/service-accounts',
  tokenUrl: null,
  handle: 'onepassword',
} satisfies CatalogEntryInput;
