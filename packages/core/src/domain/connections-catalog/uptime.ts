import { z } from 'zod';
import { utf8ByteLength } from '../../text/utf8.js';
import { parseIpv6, parseUrlAuthority } from '../../vault/network.js';
import { HostCheck, HostCheckKind } from '../hosts.js';
import type { CatalogEntryInput } from './shared.js';

export const UPTIME_ID = 'uptime';
export const UPTIME_HUB_RUNNER = 'hub';
export const UPTIME_HUB_NAME = 'This Whombat';

export const UPTIME_KINDS = [
  { value: 'http', label: 'Website' },
  { value: 'tcp', label: 'Port' },
  { value: 'ping', label: 'Ping' },
  { value: 'dns', label: 'Name lookup' },
  { value: 'heartbeat', label: 'Check-in' },
] as const;

const EVERY = ['1', '5', '15'] as const;
/** The kinds Whombat asks itself (everything but a check-in, which calls Whombat). */
const PROBES = ['http', 'tcp', 'ping', 'dns'] as const;
const LATE = ['0', '1', '5', '15', '60'] as const;
const address = z.string().trim().max(500);
const keyword = z
  .string()
  .trim()
  .max(200)
  .refine((v) => !/\p{Cc}/u.test(v), 'Use a word without line breaks.')
  .refine((v) => utf8ByteLength(v) <= 256, 'Use a shorter word.');

/** The fields the connect form and the assistant's connect card save. */
export const UptimeFields = z
  .object({
    kind: HostCheckKind,
    address: address.optional(),
    keyword: keyword.optional(),
    runner: z.string().trim().min(1).max(63).default(UPTIME_HUB_RUNNER),
    every: z.enum(EVERY).default('5'),
    late: z.enum(LATE).default('5'),
  })
  .superRefine((fields, ctx) => {
    if (fields.kind === 'heartbeat') return;
    if (validAddress(fields.kind, fields.address ?? '')) return;
    const message = {
      http: 'Enter a website address starting with http:// or https://.',
      tcp: 'Enter a host and port, like example.com:443.',
      ping: 'Enter a host name or IP address.',
      dns: 'Enter the name to look up, like example.com.',
    }[fields.kind];
    ctx.addIssue({ code: 'custom', path: ['address'], message });
  });
export type UptimeFields = z.output<typeof UptimeFields>;

/** Extra check fields that older hubs may leave out. */
export const UptimeHubCheck = HostCheck.extend({
  owner: z.string().optional(),
  stale: z.boolean().optional(),
  periodStatus: z.enum(['up', 'down', 'unseen']).optional(),
});
export type UptimeHubCheck = z.output<typeof UptimeHubCheck>;

const NAME = /^[a-z0-9_][a-z0-9_-]{0,62}(?:\.[a-z0-9_][a-z0-9_-]{0,62})*$/i;

/** The authority of a website we can check, without its path or query. */
export function uptimeWebsiteHost(value: string): string | null {
  if (/[\s\p{Cc}\\]/u.test(value)) return null;
  const parts = /^(https?):\/\/([^/?#]+)[^#]*$/i.exec(value);
  if (!parts?.[2] || !parts[1]) return null;
  const parsed = parseUrlAuthority(parts[1].toLowerCase() === 'https' ? 'https' : 'http', parts[2]);
  if (!parsed.ok) return null;
  const { host, hostKind, explicitPort, port } = parsed.authority;
  const name = hostKind === 'ipv6' ? `[${host}]` : host;
  return explicitPort ? `${name}:${port}` : name;
}

function validAddress(kind: Exclude<HostCheckKind, 'heartbeat'>, value: string): boolean {
  if (!value || /[\s\p{Cc}\\]/u.test(value)) return false;
  if (kind === 'http') return uptimeWebsiteHost(value) !== null;
  if (kind === 'dns') {
    const name = value.replace(/\.$/, '');
    return name.length <= 253 && NAME.test(name);
  }
  if (kind === 'tcp') {
    const match = /^(\[[\da-f:.]+\]|[^:/?#@]+):(\d{1,5})$/i.exec(value);
    if (!match?.[1] || !match[2] || Number(match[2]) < 1 || Number(match[2]) > 65535) return false;
    return validAddress('ping', match[1]);
  }
  if (value.includes(':')) {
    const ip = /^\[([^\]]+)\]$/.exec(value)?.[1] ?? value;
    return parseIpv6(ip) !== null;
  }
  return value.length <= 253 && NAME.test(value);
}

/** Clear fields that don't apply so switching the kind can't preserve an old target or grace period. */
export function uptimeFields(fields: UptimeFields): Record<string, string> {
  const { kind, every } = fields;
  if (kind === 'heartbeat') return { kind, every, runner: UPTIME_HUB_RUNNER, late: fields.late };
  const target = fields.address ?? '';
  return {
    kind,
    every,
    runner: fields.runner,
    address: kind === 'ping' ? target.replace(/^\[|\]$/g, '') : target,
    ...(kind === 'http' && fields.keyword ? { keyword: fields.keyword } : {}),
  };
}

export const UPTIME_STATUS_TOOL = {
  name: 'uptime_status',
  title: 'See whether it answers',
  description:
    'Read the latest result of this website, port, ping, name lookup or check-in, including when it was checked and how long it took.',
  access: 'read',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
} as const;

export const entry = {
  id: UPTIME_ID,
  name: 'Website or address',
  category: 'infrastructure',
  description: 'Watch a website, port, ping, name lookup or a script that checks in.',
  signIn: [{ kind: 'none', label: 'No sign-in' }],
  fields: [
    {
      id: 'kind',
      label: 'What to watch',
      kind: 'select',
      required: true,
      default: 'http',
      options: [...UPTIME_KINDS],
      help: 'Use Check-in for a script or job that should let Whombat know it ran.',
    },
    {
      id: 'address',
      label: 'Address',
      kind: 'text',
      required: false,
      help: 'A full website address, a host and port like example.com:443, a host name, or a name to look up.',
      shownWhen: { field: 'kind', values: [...PROBES] },
    },
    {
      id: 'keyword',
      label: 'Word to look for (optional)',
      kind: 'text',
      required: false,
      help: 'Whombat checks that the page has it, so an error page doesn’t count as up.',
      shownWhen: { field: 'kind', values: ['http'] },
    },
    {
      id: 'runner',
      label: 'Runs from',
      kind: 'select',
      required: true,
      fromService: true,
      help: 'Check from this Whombat or from one of the servers it watches. Scripts check in with this Whombat.',
      shownWhen: { field: 'kind', values: [...PROBES] },
    },
    {
      id: 'every',
      label: 'How often',
      kind: 'select',
      required: false,
      default: '5',
      options: EVERY.map((value) => ({
        value,
        label: `Every ${value} ${value === '1' ? 'minute' : 'minutes'}`,
      })),
      help: 'How often Whombat checks, or how often your script should check in.',
    },
    {
      id: 'late',
      label: 'How late it may be',
      kind: 'select',
      required: false,
      default: '5',
      options: LATE.map((value) => ({
        value,
        label:
          value === '0'
            ? 'No extra time'
            : value === '60'
              ? '1 hour'
              : `${value} ${value === '1' ? 'minute' : 'minutes'}`,
      })),
      help: 'How long to wait after it was due before telling you.',
      shownWhen: { field: 'kind', values: ['heartbeat'] },
    },
  ],
  transport: 'rest',
  baseUrl: 'whombat-hosts:',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'uptime' },
  tools: [UPTIME_STATUS_TOOL],
  request: null,
  guide:
    'For “watch my website” or “tell me if my backup script doesn’t check in”, use connection_add with service uptime, a name, and uptime settings. Ask for the address for a website, port, ping or name lookup. A check-in needs no address and its page gives the script a line to paste. Use uptime_status to read the latest result and say when Whombat last checked.',
  sensitive: [],
  docsUrl: null,
  tokenUrl: null,
  handle: UPTIME_ID,
  access: {
    read: 'The assistant can see whether it answers and when Whombat checked.',
    manage: 'The assistant can see whether it answers and when Whombat checked.',
  },
} satisfies CatalogEntryInput;
