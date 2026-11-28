/**
 * OPNsense's settings copy: its whole configuration as it offers it for download (`GET /api/core/backup/download/this`,
 * `config.xml`, the API user needs the backup privilege), compared by part: firewall rules, port forwards, aliases,
 * interfaces, DHCP, DNS, VPN, gateways and routes, users and the system's own settings. Items keep their `uuid` or
 * their description as key; what OPNsense changes by itself (each change's time and user) is left out.
 */
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import {
  cleaned,
  copyKeyHasher,
  type KeyHasher,
  SECRET_FIELD,
  type SettingsSummary,
  SummaryBuilder,
} from './summary';
import { CopyFailed, type CopyService, getBytes } from './types';
import { childText, nodesAt, parseXml, type XmlNode, xmlValue } from './xml';

/** What OPNsense writes by itself on every save: never a change of the settings. */
const VOLATILE = new Set(['revision', 'updated', 'created', 'time', 'lastchange', 'widgets', 'username']);

/** Each part and where its items are below `<opnsense>`; `*` takes every child, keyed by its name. */
const PARTS: readonly { part: string; paths: readonly (readonly string[])[] }[] = [
  {
    part: 'filter',
    paths: [
      ['filter', 'rule'],
      ['OPNsense', 'Firewall', 'Filter', 'rules', 'rule'],
    ],
  },
  {
    part: 'nat',
    paths: [
      ['nat', 'rule'],
      ['nat', 'outbound', 'rule'],
      ['nat', 'onetoone'],
      ['OPNsense', 'Firewall', 'SourceNat', 'rules', 'rule'],
      ['OPNsense', 'Firewall', 'DNat', 'rule'],
    ],
  },
  { part: 'aliases', paths: [['OPNsense', 'Firewall', 'Alias', 'aliases', 'alias']] },
  { part: 'interfaces', paths: [['interfaces', '*']] },
  {
    part: 'dhcp',
    paths: [
      ['dhcpd', '*'],
      ['dhcpdv6', '*'],
      ['OPNsense', 'Kea', 'dhcp4', 'subnets', 'subnet4'],
      ['OPNsense', 'Kea', 'dhcp4', 'reservations', 'reservation'],
      ['OPNsense', 'dnsmasq', 'dhcp_ranges'],
    ],
  },
  {
    part: 'dns',
    paths: [
      ['OPNsense', 'unboundplus', 'hosts', 'host'],
      ['OPNsense', 'unboundplus', 'aliases', 'alias'],
      ['OPNsense', 'unboundplus', 'domains', 'domain'],
      ['OPNsense', 'unboundplus', 'dots', 'dot'],
      ['OPNsense', 'unboundplus', 'general'],
      ['OPNsense', 'dnsmasq', 'hosts'],
      ['unbound'],
      ['dnsmasq'],
    ],
  },
  {
    part: 'vpn',
    paths: [
      ['OPNsense', 'wireguard', 'server', 'servers', 'server'],
      ['OPNsense', 'wireguard', 'client', 'clients', 'client'],
      ['OPNsense', 'OpenVPN', 'Instances', 'Instance'],
      ['OPNsense', 'Swanctl', 'Connections', 'Connection'],
      ['openvpn', '*'],
      ['ipsec', 'phase1'],
      ['ipsec', 'phase2'],
    ],
  },
  {
    part: 'routes',
    paths: [
      ['gateways', 'gateway_item'],
      ['OPNsense', 'Gateways', 'gateway_item'],
      ['staticroutes', 'route'],
      ['OPNsense', 'routes', 'route'],
    ],
  },
  {
    part: 'users',
    paths: [
      ['system', 'user'],
      ['system', 'group'],
    ],
  },
];

/** An item's key: its uuid, else its description or name, else (a `*` item) its element's name. */
function keyOf(node: XmlNode, any: boolean): string {
  const uuid = node.attrs.uuid ?? childText(node, 'uuid');
  if (uuid) return uuid;
  const named =
    childText(node, 'descr') ??
    childText(node, 'description') ??
    childText(node, 'name') ??
    childText(node, 'hostname') ??
    childText(node, 'domain');
  if (named) return any ? `${node.name}:${named}` : named;
  return node.name;
}

/** An element that is a secret itself (`<system><radius_secret>`), not only a holder of one: never an item. */
const skipped = (node: XmlNode) => VOLATILE.has(node.name) || SECRET_FIELD.test(node.name);

/** The summary of an OPNsense `config.xml`. */
export function opnsenseSummary(xml: string, hashKey?: KeyHasher): SettingsSummary {
  const doc = parseXml(xml);
  const top = doc.children.find((c) => c.name === 'opnsense');
  if (!top) throw new CopyFailed('unreadable');
  const out = new SummaryBuilder(hashKey);
  for (const { part, paths } of PARTS)
    for (const path of paths)
      for (const node of nodesAt(top, path)) {
        if (skipped(node)) continue;
        out.add(part, keyOf(node, path[path.length - 1] === '*'), cleaned(xmlValue(node), VOLATILE));
      }
  // The system's own settings, one item each (its users and groups are a part of their own).
  for (const node of nodesAt(top, ['system', '*'])) {
    if (node.name === 'user' || node.name === 'group' || skipped(node)) continue;
    out.add('system', node.name, cleaned(xmlValue(node), VOLATILE));
  }
  // The whole file but OPNsense's own times, secrets in: a password changed is another copy.
  out.content(cleaned(xmlValue(top), VOLATILE, 'keep'));
  return out.summary;
}

const fileDate = (d: Date) => d.toISOString().slice(0, 10);

export const OPNSENSE_COPY: CopyService = {
  name: 'OPNsense',
  async take(services: Services, row: CatalogConnectionRow, now: Date) {
    const bytes = await getBytes(services, row, '/api/core/backup/download/this', 'application/xml, */*');
    const xml = bytes.toString('utf8');
    if (!xml.includes('<opnsense')) throw new CopyFailed('unreadable');
    return {
      bytes,
      fileName: `opnsense-config-${fileDate(now)}.xml`,
      contentType: 'application/xml',
      summary: opnsenseSummary(xml, copyKeyHasher(services)),
    };
  },
};
