/**
 * Which adapter a provider uses (docs/decisions/connectors.md CN-08; connections-more.md CM-19): Google (real, fake or
 * off by `WHOMBAT_GOOGLE`), Microsoft 365 (Graph), and Email (IMAP), whose adapter talks to the person's own mail
 * servers. IMAP has no OAuth: nothing asks it for a sign-in URL, a code exchange or a refresh.
 */
import type { ConnectorProvider } from '@whombat/core';
import type { Services } from '../services';
import { imapWorkspaceOf } from './imap/service';
import { MicrosoftOAuth } from './microsoft-oauth';
import { MicrosoftWorkspace } from './microsoft-workspace';
import { googleRedirectUriFor } from './setup';
import type { GoogleWorkspace } from './types';

const microsoftOAuth = new MicrosoftOAuth();
const microsoftWorkspace = new MicrosoftWorkspace();
export const providerOAuth = (services: Services, provider: ConnectorProvider) =>
  provider === 'google' ? services.google.oauth : microsoftOAuth;
export const providerWorkspace = (services: Services, provider: ConnectorProvider): GoogleWorkspace =>
  provider === 'google'
    ? services.google.workspace
    : provider === 'imap'
      ? imapWorkspaceOf(services)
      : microsoftWorkspace;
export const providerMode = (services: Services, provider: ConnectorProvider) =>
  provider === 'google' ? services.google.mode : ('real' as const);
export const providerRedirectUri = (services: Services, provider: ConnectorProvider) =>
  googleRedirectUriFor(services.config).replace(/\/google(?=\/callback$|$)/, `/${provider}`);
