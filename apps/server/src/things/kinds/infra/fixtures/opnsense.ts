/**
 * OPNsense 25.7 answers as its source writes them (opnsense/core master, 2026-10-21: the controllers and scripts each
 * read names; no live OPNsense to ask), trimmed to the fields read.
 */

/** `GET /api/routes/gateway/status`: the default first (upstream, then priority). */
export const OPN_GATEWAYS = {
  items: [
    {
      name: 'WAN_DHCP',
      address: '203.0.113.1',
      status: 'none',
      status_translated: 'Online',
      loss: '0.0 %',
      delay: '4.2 ms',
      stddev: '0.6 ms',
      monitor: '203.0.113.1',
    },
    {
      name: 'WAN_DHCP6',
      address: 'fe80::1',
      status: 'none',
      status_translated: 'Online',
      loss: '0.0 %',
      delay: '5.1 ms',
      stddev: '0.4 ms',
      monitor: 'fe80::1',
    },
    {
      name: 'LTE_GW',
      address: '10.64.64.64',
      status: 'loss',
      status_translated: 'Packetloss',
      loss: '12.0 %',
      delay: '48.3 ms',
      stddev: '9.1 ms',
      monitor: '10.64.64.64',
    },
    {
      name: 'VPN_GW',
      address: '~',
      status: 'none',
      status_translated: 'Online',
      loss: '~',
      delay: '~',
      stddev: '~',
      monitor: '~',
    },
  ],
  status: 'ok',
};

/** `GET /api/routing/settings/search_gateway` (rows trimmed). */
export const OPN_GATEWAY_SEARCH = {
  total: 3,
  rowCount: 3,
  current: 1,
  rows: [
    {
      name: 'WAN_DHCP',
      ipprotocol: 'inet',
      priority: '254',
      upstream: true,
      defaultgw: true,
      status: 'Online',
    },
    {
      name: 'WAN_DHCP6',
      ipprotocol: 'inet6',
      priority: '254',
      upstream: true,
      defaultgw: true,
      status: 'Online',
    },
    {
      name: 'LTE_GW',
      ipprotocol: 'inet',
      priority: '255',
      upstream: false,
      defaultgw: false,
      status: 'Online',
    },
  ],
};

/** `GET /api/core/system/status` with a crash report and a disk notice. */
export const OPN_SYSTEM_STATUS = {
  metadata: {
    system: { status: 'ERROR', message: 'No pending messages', title: 'System' },
    translations: { dialogTitle: 'System Status', dialogCloseButton: 'Close' },
    subsystems: [],
  },
  subsystems: {
    crashreporter: {
      title: 'Crash Reporter',
      statusCode: -1,
      message: 'An issue was detected and can be reviewed using the problem reporter.',
      location: '/crash_reporter.php',
      timestamp: 1761000000,
      persistent: false,
      isBanner: false,
      priority: 10,
      status: 'ERROR',
      age: '3 days ago',
    },
    systembooting: {
      title: 'System',
      statusCode: 0,
      message: 'The system is booting.',
      isBanner: true,
      status: 'WARNING',
    },
  },
};

/** `GET /api/core/firmware/status` with an update waiting. */
export const OPN_FIRMWARE = {
  api_version: '2',
  connection: 'ok',
  repository: 'ok',
  last_check: 'Tue Oct 21 10:00:00 CEST 2026',
  needs_reboot: '0',
  os_version: 'FreeBSD 14.3-RELEASE-p4',
  product_version: '25.7.5',
  upgrade_major_version: '',
  all_packages: {
    opnsense: { reason: 'upgrade', old: '25.7.5', new: '25.7.6', repository: 'OPNsense', name: 'opnsense' },
    curl: { reason: 'upgrade', old: '8.16.0', new: '8.16.1', repository: 'OPNsense', name: 'curl' },
  },
  all_sets: {},
  status_msg: 'There are 2 updates available, total download size is 45.0 MiB.',
  status: 'update',
  product: {
    product_version: '25.7.5',
    product_latest: '25.7.6',
    product_series: '25.7',
    product_name: 'OPNsense',
  },
};

/** `GET /api/core/service/search`. */
export const OPN_SERVICES = {
  total: 4,
  rowCount: 4,
  current: 1,
  rows: [
    { id: 'configd', locked: 1, running: 1, description: 'System Configuration Daemon', name: 'configd' },
    { id: 'unbound', locked: 0, running: 1, description: 'Unbound DNS', name: 'unbound' },
    { id: 'openvpn/3', locked: 0, running: 0, description: 'OpenVPN server Road warriors', name: 'openvpn' },
    { id: 'ntpd', locked: 0, running: 1, description: 'Network Time Daemon', name: 'ntpd' },
  ],
};

/** `GET /api/diagnostics/system/system_resources`. */
export const OPN_RESOURCES = {
  memory: {
    total: '8455315456',
    total_frmt: '8063',
    used: 2536594637,
    used_frmt: '2419',
    arc: '523190272',
    arc_frmt: '498',
    arc_txt: 'ARC size 498 MB',
  },
};

/** `GET /api/diagnostics/activity/get_activity` (the head; processes left out). */
export const OPN_ACTIVITY = {
  headers: [
    'last pid: 81234;  load averages:  0.21,  0.25,  0.22  up 12+03:04:05    21:40:00',
    '84 processes: 1 running, 83 sleeping',
    'CPU:  2.3% user,  0.0% nice,  1.2% system,  0.4% interrupt, 96.1% idle',
    'Mem: 312M Active, 1418M Inact, 498M Wired, 5612M Free',
  ],
  details: [],
};

/** `GET /api/diagnostics/system/system_time`. */
export const OPN_TIME = {
  uptime: '12 days, 03:04:05',
  datetime: 'Tue Oct 21 21:40:00 CEST 2026',
  boottime: 'Thu Oct 9 18:35:55 CEST 2026',
  loadavg: '0.21, 0.25, 0.22',
};

/** `GET /api/diagnostics/firewall/pf_states`. */
export const OPN_STATES = { current: '1234', limit: '1622000' };

/** `GET /api/wireguard/service/show`: an interface and two peers. */
export const OPN_WIREGUARD = {
  rows: [
    {
      if: 'wg0',
      type: 'interface',
      'public-key': 'aGVsbG8gd29ybGQgaW50ZXJmYWNlIGtleSAxMjM0NTY=',
      'listen-port': '51820',
      status: 'up',
      name: 'HomeVPN',
      'latest-handshake-age': null,
      'peer-status': 'offline',
      ifname: 'HomeVPN',
    },
    {
      if: 'wg0',
      type: 'peer',
      'public-key': 'cGhvbmUgcGVlciBrZXkgYWJjZGVmZ2hpamtsbW5vcA==',
      endpoint: '198.51.100.7:51820',
      'allowed-ips': '10.0.0.2/32',
      'latest-handshake': 1761075600,
      'transfer-rx': 123456,
      'transfer-tx': 654321,
      name: 'phone',
      'latest-handshake-age': 42,
      'peer-status': 'online',
      ifname: 'HomeVPN',
    },
    {
      if: 'wg0',
      type: 'peer',
      'public-key': 'bGFwdG9wIHBlZXIga2V5IGFiY2RlZmdoaWprbG1ub3A=',
      endpoint: '(none)',
      'latest-handshake': 0,
      'transfer-rx': 0,
      'transfer-tx': 0,
      name: 'laptop',
      'latest-handshake-age': null,
      'peer-status': 'offline',
      ifname: 'HomeVPN',
    },
  ],
  total: 3,
  rowCount: 3,
  current: 1,
};
