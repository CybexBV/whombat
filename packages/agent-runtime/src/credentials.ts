/**
 * The login a managed turn's task mounts (MSB-13; docs/decisions/one-person.md OP-09): the person's own home for the
 * turn's provider (`providers/credential-home.ts`), or the burrow's AI gateway's. Never reassigned within a turn, never
 * pooled, never the host user's own login.
 */

export const CREDENTIAL_PROVIDERS = ['claude', 'codex'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

/** How the person signed in: a subscription login (Claude.ai / ChatGPT) or an API key of their own. */
export type AuthMode = 'subscription' | 'api_key';

/** The login a managed turn mounts. */
export interface CredentialOwner {
  /** Whose: `person`, or `gateway/<connection id>` for the AI gateway's (logs only). */
  account: string;
  provider: CredentialProvider;
  authMode: AuthMode;
  home: string;
}
