/**
 * Settings → Connections in the demo world (connections-more-android.md AP-2815): the catalog's statuses, your own mail
 * accounts and the burrow's connections, so the Connections and Add a connection screens show what a Whombat
 * shows. The burrow's connections are the demo's own (Home Assistant, UniFi, Hetzner, from `assistant.ts`); Mara's
 * accounts are her Google (the Gmail of Home's Mail row) and her own domain's mailbox over IMAP (AP-2817). Every entry
 * is offered, Email (IMAP) included. Pure; every answer parses with its
 * endpoint's response schema (`connections.test.ts`).
 */
import {
  type Connection as AccountConnection,
  CATALOG,
  CONNECTIONS_MAX,
  CONNECTOR_SERVICES,
  type ConnectionsCatalogStatus,
  type ConnectionView,
  type ConnectorAppStatus,
  type ConnectorsStatus,
  googleScopesFor,
} from '@whombat/core';
import type { ConnectionsListResponse } from '@whombat/core/contracts';
import { at } from '@whombat/fixtures';

/** Every entry offered, none waiting for an app to be set up (the demo has no apps to register). */
export function demoCatalogStatus(): ConnectionsCatalogStatus {
  return {
    mode: 'fake',
    entries: CATALOG.map((e) => ({ catalogId: e.id, available: true, reason: null })),
    limit: CONNECTIONS_MAX,
  };
}

/** The burrow's connections, in the server's order (by label). */
export function demoConnectionsList(connections: readonly ConnectionView[]): ConnectionsListResponse {
  const sorted = [...connections].sort((a, b) => a.label.localeCompare(b.label));
  return { connections: sorted, count: sorted.length };
}

/** Mara's own accounts (`connectors.status`'s `connections`). */
export function demoAccounts(): AccountConnection[] {
  return [
    {
      id: 'con_google-mara',
      provider: 'google',
      email: 'mara@lumio.example',
      name: 'Mara Okafor',
      services: ['mail', 'calendar', 'files'],
      status: 'active',
      reauthReason: null,
      checks: [],
      checkedAt: at('14:00'),
      createdAt: at('09:00', -30),
      updatedAt: at('14:00'),
      lastUsedAt: at('08:00'),
    },
    // Her own domain's mailbox at Fastmail, over IMAP and SMTP (connections-more-android.md AP-2817).
    {
      id: 'con_imap-mara',
      provider: 'imap',
      email: 'mara@okafor.example',
      name: 'Mara Okafor',
      services: ['mail'],
      status: 'active',
      reauthReason: null,
      checks: [],
      checkedAt: at('14:00'),
      mail: { imapHost: 'imap.fastmail.com', smtpHost: 'smtp.fastmail.com', username: 'mara@okafor.example' },
      createdAt: at('10:00', -12),
      updatedAt: at('14:00'),
      lastUsedAt: at('13:40'),
    },
  ];
}

const APP: ConnectorAppStatus = {
  provider: 'google',
  configured: true,
  source: 'config',
  clientIdHint: 'demo-client…',
  secretSet: true,
  userType: 'internal',
  updatedAt: at('09:00', -30),
};

/** `connectors.status`: the demo's Google app (set in config) and Mara's accounts. */
export function demoConnectorsStatus(): ConnectorsStatus {
  return {
    mode: 'fake',
    google: {
      app: APP,
      setup: {
        redirectUri: 'https://whombat.example/api/v1/connectors/google/callback',
        enableApisUrl: 'https://console.cloud.google.com/apis/library',
        links: {
          createProject: 'https://console.cloud.google.com/projectcreate',
          consentScreen: 'https://console.cloud.google.com/auth/branding',
          audience: 'https://console.cloud.google.com/auth/audience',
          createClient: 'https://console.cloud.google.com/auth/clients/create',
        },
        scopes: googleScopesFor([...CONNECTOR_SERVICES]),
        appName: 'Whombat',
        supportEmail: null,
        authorizedDomain: 'whombat.example',
      },
      tested: true,
    },
    imap: { available: true },
    connections: demoAccounts(),
  };
}
