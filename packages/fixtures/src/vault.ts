/**
 * The Vault in the mock world (docs/decisions/vault.md; since 0.125 without tiers or delivery, CT-1240): Mara's own
 * entries, which of them are on for Dusty, a few recent uses (a row per turn of Mara's an entry reached Dusty in) and the
 * home network list. No mock exists (VT-70): the web's fixture mode and visual tests render the Vault from
 * these. The seeded uses carry no audit event (the audit chain mirrors the mock's LOG exactly); uses and changes made in
 * a fixture world append real Vault events.
 */
import type { VaultEntryDetail, VaultNetwork, VaultTool, VaultUse } from '@whombat/core/vault';
import {
  mergeVaultTools,
  VAULT_SSH_PASSWORD_UNSET,
  VAULT_TOTP_UNSET,
  vaultTurnUseWhat,
} from '@whombat/core/vault';
import { dusty, mara } from './principals.js';
import { at } from './time.js';

export const VAULT_HOME_NETWORK: VaultNetwork = {
  id: 'vln_home',
  cidr: '192.168.1.0/24',
  ports: [80, 8123],
  note: 'Home Assistant and the printer',
  addedBy: mara.name,
  addedAt: at('09:00', -12),
};

export const VAULT_NETWORKS: VaultNetwork[] = [VAULT_HOME_NETWORK];

const HOME_ASSISTANT_ID = 'vlt_homeassistant';

/** Home Assistant's MCP server as `tools/list` gives it (Assist API tools). */
export const HOME_ASSISTANT_TOOLS = [
  { name: 'HassTurnOn', description: 'Turns on/opens/presses a device or entity.' },
  { name: 'HassTurnOff', description: 'Turns off/closes a device or entity.' },
  { name: 'HassLightSet', description: 'Sets the brightness or color of a light.' },
  { name: 'HassCancelAllTimers', description: 'Cancels all timers.' },
  {
    name: 'GetLiveContext',
    description: 'Provides real-time information about the CURRENT state of devices in the home.',
  },
];

/** Every tool was on after the first check; Mara turned HassCancelAllTimers off; GetLiveContext appeared later (“New”). */
function homeAssistantTools(): VaultTool[] {
  const first = mergeVaultTools([], HOME_ASSISTANT_TOOLS.slice(0, 4), true).tools.map((t) =>
    t.name === 'HassCancelAllTimers' ? { ...t, enabled: false } : t,
  );
  return mergeVaultTools(first, HOME_ASSISTANT_TOOLS, false).tools;
}

/** One turn of Mara's an entry reached Dusty in. */
const use = (
  id: string,
  entryId: string,
  kind: Parameters<typeof vaultTurnUseWhat>[0],
  outcome: VaultUse['outcome'],
  when: string,
): VaultUse => ({
  id,
  entryId,
  agentId: dusty.id,
  requesterId: mara.id,
  dispatchId: null,
  what: vaultTurnUseWhat(kind, dusty.name),
  outcome,
  at: when,
  eventId: null,
});

export const HOME_ASSISTANT_USES: VaultUse[] = [
  use('vlu_ha3', HOME_ASSISTANT_ID, 'mcp', 'done', at('10:48')),
  use('vlu_ha2', HOME_ASSISTANT_ID, 'mcp', 'done', at('18:05', -1)),
  use('vlu_ha1', HOME_ASSISTANT_ID, 'mcp', 'refused', at('07:00', -1)),
];

export const vaultHomeAssistant: VaultEntryDetail = {
  id: HOME_ASSISTANT_ID,
  name: 'Home Assistant',
  description:
    'Lights, heating and sensors at home. Turning things off is fine; ask me before unlocking a door.',
  kind: 'mcp',
  url: 'http://192.168.1.10:8123/api/mcp',
  auth: { type: 'bearer' },
  secret: { set: true, setAt: at('09:30', -2) },
  totp: { ...VAULT_TOTP_UNSET },
  check: { status: 'reached', summary: 'Reached · 5 tools', checkedAt: at('11:19'), toolCount: 5 },
  agentOn: true,
  serverCount: 0,
  moveToConnections: true,
  lastUsedAt: at('10:48'),
  createdAt: at('09:00', -12),
  updatedAt: at('09:30', -2),
  tools: homeAssistantTools(),
  toolsIgnored: 0,
  key: { givenAt: at('09:05', -12), servers: null, envName: null },
  recentUses: HOME_ASSISTANT_USES,
  servers: [],
};

export const vaultGrafana: VaultEntryDetail = {
  id: 'vlt_grafana',
  name: 'Grafana',
  description: 'Read-only dashboards for billing-api. Use the “Billing” folder.',
  kind: 'http',
  url: 'https://grafana.example.com',
  auth: { type: 'bearer' },
  secret: { set: true, setAt: at('16:00', -6) },
  totp: { ...VAULT_TOTP_UNSET },
  check: { status: 'reached', summary: 'Reached · answered 200', checkedAt: at('10:20'), toolCount: null },
  agentOn: true,
  serverCount: 0,
  moveToConnections: false,
  lastUsedAt: at('09:12'),
  createdAt: at('16:00', -6),
  updatedAt: at('16:00', -6),
  tools: [],
  toolsIgnored: 0,
  key: { givenAt: at('16:02', -6), servers: null, envName: 'GRAFANA' },
  recentUses: [use('vlu_gf1', 'vlt_grafana', 'http', 'done', at('09:12'))],
  servers: [],
};

export const vaultPrinter: VaultEntryDetail = {
  id: 'vlt_printer',
  name: 'Printer admin',
  description: 'The office printer’s admin pages.',
  kind: 'http',
  url: 'http://192.168.1.20',
  auth: { type: 'basic', username: 'admin' },
  secret: { set: true, setAt: at('11:00', -4) },
  totp: { ...VAULT_TOTP_UNSET },
  check: {
    status: 'failing',
    summary: 'The server rejected the secret (401).',
    checkedAt: at('11:01', -4),
    toolCount: null,
  },
  agentOn: false,
  serverCount: 0,
  moveToConnections: false,
  lastUsedAt: null,
  createdAt: at('11:00', -4),
  updatedAt: at('11:00', -4),
  tools: [],
  toolsIgnored: 0,
  key: null,
  recentUses: [],
  servers: [],
};

export const vaultPackSecret: VaultEntryDetail = {
  id: 'vlt_weather',
  name: 'Weather API key',
  description: 'Kept from an older Whombat.',
  kind: 'secret',
  url: null,
  auth: null,
  secret: { set: true, setAt: at('10:00', -1) },
  totp: { ...VAULT_TOTP_UNSET },
  check: { status: 'unchecked', summary: '', checkedAt: null, toolCount: null },
  agentOn: false,
  serverCount: 0,
  moveToConnections: false,
  lastUsedAt: null,
  createdAt: at('10:00', -1),
  updatedAt: at('10:00', -1),
  tools: [],
  toolsIgnored: 0,
  key: null,
  recentUses: [],
  servers: [],
};

/**
 * A website login for the browser (contracts 0.20.0, VT-D28), opt-in like the handoff fixtures (CT-114): not in
 * `VAULT_ENTRIES`, so the seeded Vault page stays as it was. It is on for Dusty.
 */
export const vaultShopLogin: VaultEntryDetail = {
  id: 'vlt_shop',
  name: 'Shop admin',
  description: 'The webshop’s admin: orders and refunds.',
  kind: 'login',
  url: 'https://shop.example.com/admin/login',
  auth: { type: 'form', username: 'mara@burrowhq.example' },
  secret: { set: true, setAt: at('14:00', -3) },
  totp: { ...VAULT_TOTP_UNSET },
  check: { status: 'unchecked', summary: '', checkedAt: null, toolCount: null },
  agentOn: true,
  serverCount: 0,
  moveToConnections: false,
  lastUsedAt: null,
  createdAt: at('14:00', -3),
  updatedAt: at('14:00', -3),
  tools: [],
  toolsIgnored: 0,
  key: { givenAt: at('14:02', -3), servers: null, envName: null },
  recentUses: [],
  servers: [],
};

/** The public half of the fixture SSH key (a throwaway ed25519 pair made for these fixtures; nothing trusts it). */
export const FIXTURE_SSH_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILBmrVrARUqTYfBxNry+DHEJ+VGkRAsfW8i0duG7bwv5';
export const FIXTURE_SSH_FINGERPRINT = 'SHA256:zibNZfkJQ795P2dUA9+2CmiONZBYBhGqzBdZj+lYkxY';
/** The host key web-1 and staging show (a throwaway ed25519 host key). */
export const FIXTURE_SSH_HOST_KEY = {
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:lA0GcvPK3fxFYd43pMMqq275b2pIPqT3oQfQlcC3wnU',
};

const SSH_ID = 'vlt_deploykey';

/**
 * An SSH key with two servers (contracts 0.32.0, VT-S02…VT-S07), opt-in like `vaultShopLogin`: not in `VAULT_ENTRIES`
 * (pass it to `createFixtureFetch({vaultEntries})`). web-1 is trusted and signed in; staging waits for Mara to trust
 * its host key. It is on for Dusty on web-1 only.
 */
export const vaultSshDeployKey: VaultEntryDetail = {
  id: SSH_ID,
  name: 'Deploy key',
  description: 'Our web servers. Restarting services is fine; ask me before deleting anything.',
  kind: 'ssh',
  url: null,
  auth: {
    type: 'ssh_key',
    keyType: 'ed25519',
    publicKey: FIXTURE_SSH_PUBLIC_KEY,
    fingerprint: FIXTURE_SSH_FINGERPRINT,
    origin: 'generated',
  },
  secret: { set: true, setAt: at('08:30', -5) },
  totp: { ...VAULT_TOTP_UNSET },
  check: {
    status: 'reached',
    summary: 'Signed in to 1 of 2 servers',
    checkedAt: at('09:40'),
    toolCount: null,
  },
  agentOn: true,
  serverCount: 2,
  moveToConnections: false,
  lastUsedAt: at('10:05'),
  createdAt: at('08:30', -5),
  updatedAt: at('09:40'),
  tools: [],
  toolsIgnored: 0,
  key: { givenAt: at('08:40', -5), servers: ['vss_web1'], envName: null },
  recentUses: [use('vlu_ssh1', SSH_ID, 'ssh', 'done', at('10:05'))],
  servers: [
    {
      id: 'vss_web1',
      name: 'web-1',
      host: 'web1.example.com',
      port: 22,
      username: 'deploy',
      production: false,
      password: { ...VAULT_SSH_PASSWORD_UNSET },
      hostKey: { ...FIXTURE_SSH_HOST_KEY, trustedAt: at('08:45', -5) },
      seenHostKey: null,
      check: {
        status: 'reached',
        outcome: 'reached',
        summary: 'Signed in as deploy',
        checkedAt: at('09:30'),
      },
      createdAt: at('08:44', -5),
      updatedAt: at('08:45', -5),
    },
    {
      id: 'vss_staging',
      name: 'staging',
      host: 'staging.example.com',
      port: 22,
      username: 'deploy',
      production: false,
      password: { ...VAULT_SSH_PASSWORD_UNSET },
      hostKey: null,
      seenHostKey: { ...FIXTURE_SSH_HOST_KEY, seenAt: at('09:40') },
      check: {
        status: 'unchecked',
        outcome: 'host_key_unconfirmed',
        summary: 'Host key not confirmed yet',
        checkedAt: at('09:40'),
      },
      createdAt: at('09:39'),
      updatedAt: at('09:40'),
    },
  ],
};

/** Mara's entries, as `vault.list` orders them (by name). */
export const VAULT_ENTRIES: VaultEntryDetail[] = [
  vaultGrafana,
  vaultHomeAssistant,
  vaultPrinter,
  vaultPackSecret,
];

/**
 * Asking for every sign-in (Whombat vault-simplify.md VLT-42, VLT-46), opt-in like `vaultShopLogin`: the shop's login
 * with its authenticator key set, and the Deploy key with a third server, prod-1, that doesn't take keys, so its
 * password is kept (shown as set, never the value).
 */
export const vaultSignInEntries: readonly VaultEntryDetail[] = [
  { ...vaultShopLogin, totp: { set: true, setAt: at('14:05', -3) } },
  {
    ...vaultSshDeployKey,
    serverCount: 3,
    servers: [
      ...vaultSshDeployKey.servers,
      {
        id: 'vss_prod1',
        name: 'prod-1',
        host: '192.168.1.30',
        port: 22,
        username: 'deploy',
        production: true,
        password: { set: true, setAt: at('10:12') },
        hostKey: { ...FIXTURE_SSH_HOST_KEY, trustedAt: at('10:12') },
        seenHostKey: null,
        check: {
          status: 'reached',
          outcome: 'reached',
          summary: 'Signed in as deploy',
          checkedAt: at('10:12'),
        },
        createdAt: at('10:12'),
        updatedAt: at('10:12'),
      },
    ],
  },
];
