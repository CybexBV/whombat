/**
 * Connectors and connections (docs/decisions/connectors.md "Endpoints"). The provider app belongs to this
 * Whombat and connections to an account, not a burrow, so these routes are not under `/burrows/:burrow`
 * (CN-07: account-level writes, not the burrow commit pipeline).
 *
 * Google's redirect after consent, `GET /api/v1/connectors/google/callback` (`googleRedirectPath`), is a
 * browser route that answers with a redirect, not JSON, so it is not a contract endpoint. Its JSON twin is
 * `connections.finishGoogle` (AG-14, CT-81): the managed appliance's redirect lands in the app, which hands
 * `code` and `state` over the session; a self-hosted server serves it too.
 */
import { z } from 'zod';
import { Email } from '../domain/common.js';
import {
  Connection,
  ConnectorService,
  ConnectorsStatus,
  GoogleUserType,
  ImapProviderHint,
  ImapServerSettings,
  ImapSettingsSource,
  ReturnLocation,
  ReturnPath,
} from '../domain/connectors.js';
import { ConnectionId } from '../ids.js';
import { endpoint } from './endpoint.js';
import { OkResponse } from './errors.js';

/** Save or replace the Google OAuth client (CN-02, CN-03 step 5). */
export const SetGoogleAppBody = z.object({
  /** Omit to keep the stored client while changing the audience (clients only see `clientIdHint`). */
  clientId: z
    .string()
    .trim()
    .min(10)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/, 'Paste the Client ID from Google.')
    .optional(),
  /** Omit to keep the stored secret while changing the id or audience. */
  clientSecret: z.string().trim().min(8).max(200).optional(),
  userType: GoogleUserType,
});
export type SetGoogleAppBody = z.infer<typeof SetGoogleAppBody>;

export const StartGoogleBody = z.object({
  /** The ticked services (all on by default in the UI). */
  services: z.array(ConnectorService).min(1).max(6),
  returnTo: ReturnPath,
});
export type StartGoogleBody = z.infer<typeof StartGoogleBody>;

export const StartGoogleResponse = z.object({
  /** Where the browser goes, as a full-page navigation (Google's consent screen; the callback in fake mode). */
  authorizeUrl: z.string().url(),
});
export type StartGoogleResponse = z.infer<typeof StartGoogleResponse>;

/**
 * `connections.finishGoogle` (AG-14): what Google put on the redirect, as the app took it off the address bar.
 * Deliberately lenient (bounded strings only): an unknown, used or expired state still answers with a return path
 * carrying `connect_error=invalid_state`, exactly as the browser callback redirects.
 */
export const FinishGoogleBody = z.object({
  /** Google's authorization code (absent when Google sent `error`). Single use, useless without the verifier. */
  code: z.string().min(1).max(2048).optional(),
  /** The `state` from `connections.startGoogle`'s consent URL (`oas_…`). */
  state: z.string().min(1).max(200),
  /** Google's `error` (`access_denied`, …), when consent failed. */
  error: z.string().min(1).max(200).optional(),
});
export type FinishGoogleBody = z.infer<typeof FinishGoogleBody>;

/** Where the app goes next: the path of the started connect with `connected=google` or `connect_error=<code>`. */
export const FinishGoogleResponse = z.object({
  returnPath: ReturnLocation,
});
export type FinishGoogleResponse = z.infer<typeof FinishGoogleResponse>;

export { ReturnPath };

/** `connectors.imapDiscover` (0.97, CT-483; CM-20): the address to find the servers of. */
export const ImapDiscoverBody = z.object({ email: Email });
export type ImapDiscoverBody = z.infer<typeof ImapDiscoverBody>;

/**
 * What `connectors.imapDiscover` found (CM-20, CM-21, CM-D02): the servers and where they came from (`guess`:
 * nothing was found and these are `imap.<domain>` / `smtp.<domain>`, so the form opens the server fields), and what to
 * say about a known provider. `settings` is null only when the address has no domain to guess from.
 */
export const ImapDiscoverResponse = z.object({
  settings: ImapServerSettings.nullable(),
  source: ImapSettingsSource.nullable(),
  hint: ImapProviderHint.nullable(),
});
export type ImapDiscoverResponse = z.infer<typeof ImapDiscoverResponse>;

/**
 * `connectors.imapConnect` (0.97, CT-483; CM-20, CM-22): the address, its password (an app password where the provider
 * has them) and the servers (absent: the ones `connectors.imapDiscover` finds). Whombat signs in to both servers
 * before it keeps anything; a refusal is `error.details` `ImapConnectErrorDetails`. Connecting again replaces the
 * caller's IMAP account (one per person). The password is sealed and never shown: a secret op.
 */
export const ImapConnectBody = z.object({
  email: Email,
  password: z.string().min(1).max(1000),
  settings: ImapServerSettings.optional(),
});
export type ImapConnectBody = z.input<typeof ImapConnectBody>;

const C = z.object({ connectionId: ConnectionId });

export const connectorEndpoints = {
  imapDiscover: endpoint({
    id: 'connectors.imapDiscover',
    method: 'POST',
    path: '/me/connections/imap/discover',
    summary:
      'Find the IMAP and SMTP servers of an address (CM-20): the Thunderbird ISPDB, the domain’s autoconfig, the ISPDB ' +
      'for its MX host, SRV records, else a guess; and a known provider’s hint. Reads only; every lookup goes through ' +
      'the destination policy.',
    body: ImapDiscoverBody,
    response: ImapDiscoverResponse,
  }),
  imapConnect: endpoint({
    id: 'connectors.imapConnect',
    method: 'POST',
    path: '/me/connections/imap',
    summary:
      'Connect the caller’s mailbox over IMAP and SMTP (CM-22): signs in to both servers, then keeps the address, the ' +
      'servers and the sealed password as the caller’s Email (IMAP) connection (mail only). A secret op.',
    body: ImapConnectBody,
    response: Connection,
  }),
  setMicrosoftApp: endpoint({
    id: 'connectors.setMicrosoftApp',
    method: 'PUT',
    path: '/connectors/microsoft/app',
    summary: 'Save the Microsoft Entra application ID and encrypted secret.',
    body: SetGoogleAppBody,
    response: ConnectorsStatus,
  }),
  removeMicrosoftApp: endpoint({
    id: 'connectors.removeMicrosoftApp',
    method: 'DELETE',
    path: '/connectors/microsoft/app',
    summary: 'Remove the Microsoft application and require reconnection.',
    response: ConnectorsStatus,
  }),
  status: endpoint({
    id: 'connectors.status',
    method: 'GET',
    path: '/connectors',
    summary:
      'The provider apps of this Whombat (Google), the guided setup facts (redirect URI, enable-APIs link, ' +
      'scopes) and the connections (signed in).',
    response: ConnectorsStatus,
  }),
  setGoogleApp: endpoint({
    id: 'connectors.setGoogleApp',
    method: 'PUT',
    path: '/connectors/google/app',
    summary:
      'Save or replace the Google OAuth client (409 when it is set in config). The ' +
      'secret is stored encrypted and never returned.',
    body: SetGoogleAppBody,
    response: ConnectorsStatus,
  }),
  removeGoogleApp: endpoint({
    id: 'connectors.removeGoogleApp',
    method: 'DELETE',
    path: '/connectors/google/app',
    summary: 'Remove the Google OAuth client: every Google connection needs to be connected again.',
    response: ConnectorsStatus,
  }),
};

export const connectionEndpoints = {
  startMicrosoft: endpoint({
    id: 'connections.startMicrosoft',
    method: 'POST',
    path: '/me/connections/microsoft/start',
    summary: 'Connect Outlook, OneDrive and Contacts with delegated permissions and PKCE.',
    body: StartGoogleBody,
    response: StartGoogleResponse,
  }),
  finishMicrosoft: endpoint({
    id: 'connections.finishMicrosoft',
    method: 'POST',
    path: '/me/connections/microsoft/finish',
    summary: 'Finish Microsoft consent, bound to the requesting account and provider. Secret operation.',
    body: FinishGoogleBody,
    response: FinishGoogleResponse,
  }),
  startGoogle: endpoint({
    id: 'connections.startGoogle',
    method: 'POST',
    path: '/me/connections/google/start',
    summary:
      'Start connecting the caller’s Google account for the ticked services: returns Google’s consent URL ' +
      '(PKCE, offline access, a single-use state that expires in 10 minutes). 409 when Google is not set up.',
    body: StartGoogleBody,
    response: StartGoogleResponse,
  }),
  finishGoogle: endpoint({
    id: 'connections.finishGoogle',
    method: 'POST',
    path: '/me/connections/google/finish',
    summary:
      'Finish connecting Google from the redirect the app received (AG-14): takes the single-use state (it must be ' +
      'the caller’s), exchanges the code with its PKCE verifier and runs the same path as the browser callback, ' +
      'including the result in the assistant’s DM when a guide started it (AG-08). Always answers the return path ' +
      'with `connected=google` or `connect_error=<ConnectErrorCode>`; the input carries a code, so it is a secret op.',
    body: FinishGoogleBody,
    response: FinishGoogleResponse,
  }),
  check: endpoint({
    id: 'connections.check',
    method: 'POST',
    path: '/me/connections/:connectionId/check',
    summary: 'Run the service checks of one of the caller’s connections again (“Check again”).',
    params: C,
    response: Connection,
  }),
  remove: endpoint({
    id: 'connections.remove',
    method: 'DELETE',
    path: '/me/connections/:connectionId',
    summary: 'Disconnect: revoke the token at the provider (best effort) and forget the connection.',
    params: C,
    response: OkResponse,
  }),
};
