// The assistant in fixture mode (docs/ASSIST.md): per-browser settings,
// Claude Code and Codex with a simulated install (progress over SSE),
// sign-in (a `claude setup-token` token; Codex's device code, signed in
// a few seconds later), and investigations whose transcript grows over SSE
// like a real run (tool steps, answers, approvals, the summary). Off by
// default, so the other pages look as they always did; `?assistant=1` turns
// it on with both CLIs installed and four investigations seeded
// (`?assistant=nosandbox`: the same, with a runner that is not sandboxed).

import type {
  Access,
  AssistantSettings,
  AssistantState,
  Investigation,
  InvestigationEvent,
  InvestigationState,
  ProviderId,
  ProviderState,
} from '../../src/api/assist-types.ts';
import type { Alert } from '../../src/api/types.ts';
import { appendAudit } from './audit.ts';
import type { Ctx } from './ctx.ts';
import { pushEvent } from './events.ts';
import { bodyObject, type FxResponse, json, noContent, problem } from './http.ts';
import { type BrowserState, findServer, iso } from './state.ts';

type EventBody = InvestigationEvent extends infer E ? (E extends InvestigationEvent ? Omit<E, 'seq' | 'at'> : never) : never;

interface AssistFx {
  settings: AssistantSettings;
  runner: AssistantState['runner'];
  providers: Record<ProviderId, ProviderState>;
  /** Newest first. */
  investigations: Investigation[];
  events: Map<string, InvestigationEvent[]>;
  /** Run generation per investigation: a newer run (or a stop) silences the steps of an older one. */
  runs: Map<string, number>;
  next: number;
}

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

const LATEST: Record<ProviderId, string> = { claude: '2.3.16', codex: '0.52.0' };
const NAME: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex' };
/** The token prefix `claude setup-token` prints (sk-ant-oat01-…); API keys (sk-ant-api…) work too. */
const TOKEN_RE = /^sk-ant-(oat|api)\d{2}-[A-Za-z0-9_-]{8,}$/;
export const CODEX_LOGIN_MS = 4000;
/** Real-clock pause between the steps of a simulated run. */
export const STEP_MS = 450;

function provider(id: ProviderId, more: Partial<ProviderState> = {}): ProviderState {
  return {
    id,
    name: NAME[id],
    installed: false,
    version: null,
    latest: LATEST[id],
    update_available: false,
    checked_at: null,
    busy: null,
    progress: null,
    signed_in: false,
    account: null,
    login: null,
    error: null,
    ...more,
  };
}

function initial(): AssistFx {
  return {
    settings: { enabled: false, provider: 'claude', access: 'full', auto_investigate: 'off', auto_update: true, claude_model: '', codex_model: '', claude_channel: 'stable' },
    runner: { connected: true, sandboxed: true, error: null },
    providers: { claude: provider('claude'), codex: provider('codex') },
    investigations: [],
    events: new Map(),
    runs: new Map(),
    next: 1,
  };
}

const states = new WeakMap<BrowserState, AssistFx>();

export function assistState(st: BrowserState): AssistFx {
  let a = states.get(st);
  if (!a) states.set(st, (a = initial()));
  return a;
}

function stateJson(a: AssistFx): AssistantState {
  return {
    settings: { ...a.settings },
    runner: { ...a.runner },
    providers: { claude: { ...a.providers.claude }, codex: { ...a.providers.codex } },
    running: a.investigations.filter((i) => i.state === 'starting' || i.state === 'running' || i.state === 'waiting').length,
  };
}

// ---------------------------------------------------------------- seeds

interface Seed {
  inv: Omit<Investigation, 'updated_at' | 'pending_approvals' | 'created_at'>;
  /** Created this long before the browser state's anchor. */
  ago: number;
  /** Seconds after the start, and the event. */
  events: [number, EventBody][];
}

const SMART_NVME = `smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.48] (local build)
=== START OF INFORMATION SECTION ===
Model Number:                       Samsung SSD 990 PRO 2TB
Serial Number:                      S6Z2NJ0W******
Firmware Version:                   4B2QJXD7
Total NVM Capacity:                 2,000,398,934,016 [2.00 TB]

=== START OF SMART DATA SECTION ===
SMART overall-health self-assessment test result: PASSED

SMART/Health Information (NVMe Log 0x02)
Critical Warning:                   0x00
Temperature:                        44 Celsius
Available Spare:                    100%
Available Spare Threshold:          10%
Percentage Used:                    78%
Data Units Read:                    402,118,562 [205 TB]
Data Units Written:                 1,828,125,000 [936 TB]
Power On Hours:                     11,204
Unsafe Shutdowns:                   21
Media and Data Integrity Errors:    0
Error Information Log Entries:      0`;

const MDSTAT = `Personalities : [raid1]
md0 : active raid1 sdb1[0] sdc1[1](F)
      3906886464 blocks super 1.2 [2/1] [U_]
      bitmap: 12/30 pages [48KB], 65536KB chunk

unused devices: <none>

/dev/md0:
           Version : 1.2
        Raid Level : raid1
        Array Size : 3906886464 (3.64 TiB 4.00 TB)
      Raid Devices : 2
     Total Devices : 2
             State : clean, degraded
    Active Devices : 1
    Failed Devices : 1

    Number   Major   Minor   RaidDevice State
       0       8       17        0      active sync   /dev/sdb1
       -       0        0        1      removed

       1       8       33        -      faulty   /dev/sdc1`;

const SMART_SDC = `smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.48-amd64] (local build)
Device Model:     WDC WD40EFRX-68N32N0
Serial Number:    WD-WCC7K4******
User Capacity:    4,000,787,030,016 bytes [4.00 TB]
SMART overall-health self-assessment test result: PASSED

ID# ATTRIBUTE_NAME          FLAGS    VALUE WORST THRESH FAIL RAW_VALUE
  5 Reallocated_Sector_Ct   PO--CK   142   142   140    -    1184
  9 Power_On_Hours          -O--CK   035   035   000    -    47612
194 Temperature_Celsius     -O---K   117   102   000    -    33
197 Current_Pending_Sector  -O--CK   200   200   000    -    56
198 Offline_Uncorrectable   ----CK   200   200   000    -    12
199 UDMA_CRC_Error_Count    -O--CK   200   200   000    -    0`;

const SEEDS: Seed[] = [
  {
    ago: 12 * MIN,
    inv: { id: 'inv_wear', title: 'nvme1n1 wear at 78%', server: 'basalt', server_name: 'basalt', alert_id: 'al_02', provider: 'claude', model: 'opus', state: 'waiting', access: 'ask', auto: false, created_by: 'admin', summary: null, resolved: null, cost_usd: 0.18 },
    events: [
      [0, { kind: 'user', by: 'admin', text: 'Investigate the alert “nvme1n1 wear at 78%” on basalt.' }],
      [1, { kind: 'status', state: 'running', text: null }],
      [4, { kind: 'tool', tool_id: 't1', tool: 'get_host', title: 'Host state', server: 'basalt', input: { host: 'basalt' } }],
      [
        5,
        {
          kind: 'tool_result',
          tool_id: 't1',
          ok: true,
          truncated: false,
          duration_ms: 84,
          output:
            'basalt · NixOS 26.05 · 64 threads · up 41 d\nCPU 23% · memory 61% · load 4.1 / 3.8 / 3.6\nnvme1n1  Samsung 990 PRO 2TB  wear 78%  936 / 1200 TBW  44 °C\nnvme0n1  Samsung 990 PRO 2TB  wear 12%  144 / 1200 TBW  41 °C\nOpen alerts: nvme1n1 wear at 78% (warning, 2 d)',
        },
      ],
      [9, { kind: 'tool', tool_id: 't2', tool: 'diagnose', title: 'SMART data', server: 'basalt', input: { host: 'basalt', check: 'smart', args: { device: 'nvme1n1' } } }],
      [11, { kind: 'tool_result', tool_id: 't2', ok: true, truncated: false, duration_ms: 1840, output: SMART_NVME }],
      [14, { kind: 'tool', tool_id: 't3', tool: 'get_metrics', title: 'Disk I/O · 30 d', server: 'basalt', input: { host: 'basalt', metric: 'disk_io', range: '30d' } }],
      [15, { kind: 'tool_result', tool_id: 't3', ok: true, truncated: false, duration_ms: 212, output: 'nvme1n1 write: average 22.4 MB/s (1.9 TB a day), maximum 412 MB/s\nnvme1n1 read: average 3.1 MB/s, maximum 1.2 GB/s' }],
      [18, { kind: 'tool', tool_id: 't4', tool: 'diagnose', title: 'Logs', server: 'basalt', input: { host: 'basalt', check: 'logs', args: { grep: 'nvme1n1', since: '7d', kernel: true } } }],
      [20, { kind: 'tool_result', tool_id: 't4', ok: true, truncated: false, duration_ms: 960, output: 'Oct 04 02:11:03 basalt kernel: nvme nvme1: 32/0/0 default/read/poll queues\nOct 04 02:11:03 basalt kernel:  nvme1n1: p1' }],
      [
        31,
        {
          kind: 'assistant',
          text: `**nvme1n1 is wearing out, but it is healthy.** Its controller reports:

- **78%** of its rated endurance used (936 of 1,200 TBW)
- no media errors, 100% spare blocks, no critical warnings
- about **1.9 TB written a day** over the last 30 days, mostly by the Incus pool \`fast\`

At this rate it reaches its rated endurance in about **4 months** (mid-February). Drives often last past the rating, but the warranty ends there.

I'd like to run a short SMART self-test (about 2 minutes, read-only) to rule out anything else.`,
        },
      ],
      [33, { kind: 'tool', tool_id: 't5', tool: 'run_command', title: 'Run command', server: 'basalt', input: { host: 'basalt', command: 'smartctl -t short /dev/nvme1n1', reason: 'Short self-test' } }],
      [33, { kind: 'approval', approval_id: 'ap_1', tool_id: 't5', server: 'basalt', action: 'command', command: 'smartctl -t short /dev/nvme1n1', reason: 'A short self-test checks the controller and a sample of the flash in about 2 minutes. It reads only; your data is not touched.' }],
      [33, { kind: 'status', state: 'waiting', text: null }],
      [34, { kind: 'usage', cost_usd: 0.18, input_tokens: 41_200, output_tokens: 2_100 }],
    ],
  },
  {
    ago: D + 4 * H,
    inv: {
      id: 'inv_md0',
      title: 'Array md0 is degraded',
      server: 'granite',
      server_name: 'granite',
      alert_id: 'al_md0',
      provider: 'claude',
      model: null,
      state: 'done',
      access: 'ask',
      auto: true,
      created_by: 'auto',
      summary: 'Replace sdc: it fails its self-test with a read failure; md0 runs on sdb alone.',
      resolved: false,
      cost_usd: 0.42,
    },
    events: [
      [0, { kind: 'user', by: 'auto', text: 'Alert “Array md0 is degraded” on granite (critical): md0 (raid1) runs on 1 of 2 devices. Find out why and what to do.' }],
      [1, { kind: 'status', state: 'running', text: null }],
      [5, { kind: 'tool', tool_id: 't1', tool: 'diagnose', title: 'RAID arrays', server: 'granite', input: { host: 'granite', check: 'raid' } }],
      [6, { kind: 'tool_result', tool_id: 't1', ok: true, truncated: false, duration_ms: 310, output: MDSTAT }],
      [9, { kind: 'tool', tool_id: 't2', tool: 'diagnose', title: 'SMART data', server: 'granite', input: { host: 'granite', check: 'smart', args: { device: 'sdc' } } }],
      [12, { kind: 'tool_result', tool_id: 't2', ok: true, truncated: false, duration_ms: 2410, output: SMART_SDC }],
      [15, { kind: 'tool', tool_id: 't3', tool: 'diagnose', title: 'Logs', server: 'granite', input: { host: 'granite', check: 'logs', args: { grep: 'sdc', since: '24h', kernel: true } } }],
      [
        16,
        {
          kind: 'tool_result',
          tool_id: 't3',
          ok: true,
          truncated: false,
          duration_ms: 1120,
          output:
            'Oct 10 09:41:17 granite kernel: ata3.00: exception Emask 0x0 SAct 0x40000 SErr 0x0 action 0x0\nOct 10 09:41:17 granite kernel: ata3.00: failed command: READ FPDMA QUEUED\nOct 10 09:41:17 granite kernel: I/O error, dev sdc, sector 2214592512 op 0x0:(READ) flags 0x0 phys_seg 8 prio class 2\nOct 10 09:41:21 granite kernel: md/raid1:md0: sdc1: rescheduling sector 2214590464\nOct 10 09:41:24 granite kernel: md/raid1:md0: Disk failure on sdc1, disabling device.\nOct 10 09:41:24 granite kernel: md/raid1:md0: Operation continuing on 1 devices.',
        },
      ],
      [
        29,
        {
          kind: 'assistant',
          text: `**sdc failed out of md0.** The kernel hit read errors on it at 09:41 and md disabled the disk, so the array runs on **sdb alone**, without redundancy.

SMART agrees: **1,184 reallocated** and **56 pending** sectors, 12 offline uncorrectable. The drive is about 5.4 years old (47,612 hours); the cable looks fine (no CRC errors).

| Disk | Reallocated | Pending | In md0 |
|---|---:|---:|---|
| sdb | 0 | 0 | active |
| sdc | 1,184 | 56 | faulty |

A short self-test will tell whether the surface is failing.`,
        },
      ],
      [31, { kind: 'tool', tool_id: 't4', tool: 'run_command', title: 'Run command', server: 'granite', input: { host: 'granite', command: 'smartctl -t short /dev/sdc', reason: 'Short self-test' } }],
      [31, { kind: 'approval', approval_id: 'ap_1', tool_id: 't4', server: 'granite', action: 'command', command: 'smartctl -t short /dev/sdc', reason: 'A short self-test reads a sample of the surface in about 2 minutes. It does not write to the disk.' }],
      [31, { kind: 'status', state: 'waiting', text: null }],
      [118, { kind: 'approval_decided', approval_id: 'ap_1', decision: 'approved', by: 'admin', reply: null }],
      [118, { kind: 'status', state: 'running', text: null }],
      [
        119,
        {
          kind: 'tool_result',
          tool_id: 't4',
          ok: true,
          truncated: false,
          duration_ms: 1460,
          output:
            '=== START OF OFFLINE IMMEDIATE AND SELF-TEST SECTION ===\nSending command: "Execute SMART Short self-test routine immediately in off-line mode".\nDrive command "Execute SMART Short self-test routine immediately in off-line mode" successful.\nTesting has begun.\nPlease wait 2 minutes for test to complete.',
        },
      ],
      [245, { kind: 'tool', tool_id: 't5', tool: 'diagnose', title: 'SMART data', server: 'granite', input: { host: 'granite', check: 'smart', args: { device: 'sdc' } } }],
      [
        247,
        {
          kind: 'tool_result',
          tool_id: 't5',
          ok: true,
          truncated: false,
          duration_ms: 2290,
          output: 'SMART Self-test log structure revision number 1\nNum  Test_Description    Status                  Remaining  LifeTime(hours)  LBA_of_first_error\n# 1  Short offline       Completed: read failure       90%     47614         2214592512\n# 2  Extended offline    Completed without error       00%     46890         -',
        },
      ],
      [
        262,
        {
          kind: 'summary',
          resolved: false,
          text: `**Replace sdc.** It fails its self-test with a read failure and has 1,184 reallocated sectors; md removed it from md0, which runs without redundancy on sdb.

1. Put in a new 4 TB disk and copy the partition table: \`sfdisk -d /dev/sdb | sfdisk /dev/sdX\`
2. Remove the failed member: \`mdadm /dev/md0 --remove /dev/sdc1\`
3. Add the new one: \`mdadm /dev/md0 --add /dev/sdX1\` (the rebuild takes about 7 hours)

Until then, make sure the backup of md0 is current.`,
        },
      ],
      [263, { kind: 'usage', cost_usd: 0.42, input_tokens: 96_400, output_tokens: 4_800 }],
      [263, { kind: 'status', state: 'done', text: null }],
    ],
  },
  {
    ago: 2 * D + 3 * H,
    inv: { id: 'inv_quartz', title: 'Check this host’s health', server: 'quartz', server_name: 'quartz', alert_id: null, provider: 'codex', model: 'gpt-5-codex', state: 'idle', access: 'ask', auto: false, created_by: 'admin', summary: null, resolved: null, cost_usd: null },
    events: [
      [0, { kind: 'user', by: 'admin', text: 'Check this host’s health' }],
      [1, { kind: 'status', state: 'running', text: null }],
      [4, { kind: 'tool', tool_id: 't1', tool: 'get_host', title: 'Host state', server: 'quartz', input: { host: 'quartz' } }],
      [5, { kind: 'tool_result', tool_id: 't1', ok: true, truncated: false, duration_ms: 71, output: 'quartz · Ubuntu 24.04 LTS · 16 threads · up 12 d\nCPU 4% · memory 38% · load 0.4 / 0.3 / 0.3\n/ 41% · /srv 63%\nNo open alerts.' }],
      [7, { kind: 'tool', tool_id: 't2', tool: 'diagnose', title: 'Failed services', server: 'quartz', input: { host: 'quartz', check: 'services', args: { state: 'failed' } } }],
      [8, { kind: 'tool_result', tool_id: 't2', ok: true, truncated: false, duration_ms: 390, output: '  UNIT LOAD ACTIVE SUB DESCRIPTION\n0 loaded units listed.' }],
      [10, { kind: 'tool', tool_id: 't3', tool: 'diagnose', title: 'Pending updates', server: 'quartz', input: { host: 'quartz', check: 'updates' } }],
      [13, { kind: 'tool_result', tool_id: 't3', ok: true, truncated: false, duration_ms: 2870, output: '14 updates, 3 of them security updates:\nlibssl3t64 3.0.13-0ubuntu3.6 (security)\nopenssl 3.0.13-0ubuntu3.6 (security)\nlibexpat1 2.6.1-2ubuntu0.3 (security)\n…' }],
      [
        21,
        {
          kind: 'assistant',
          text: '**quartz is healthy.** No failed services, CPU and memory are low and both file systems have room.\n\nOne thing to do: **14 package updates are pending, 3 of them security fixes** (OpenSSL and expat). Install them with `apt upgrade` when it suits you; none needs a reboot.',
        },
      ],
      [21, { kind: 'status', state: 'idle', text: null }],
    ],
  },
  {
    ago: 3 * D + 9 * H,
    inv: { id: 'inv_backups', title: 'Why did last night’s backups take so long?', server: null, server_name: null, alert_id: null, provider: 'claude', model: null, state: 'failed', access: 'ask', auto: false, created_by: 'admin', summary: null, resolved: null, cost_usd: 0.02 },
    events: [
      [0, { kind: 'user', by: 'admin', text: 'Why did last night’s backups take so long?' }],
      [1, { kind: 'status', state: 'running', text: null }],
      [4, { kind: 'tool', tool_id: 't1', tool: 'list_hosts', title: 'Hosts', server: null, input: {} }],
      [5, { kind: 'tool_result', tool_id: 't1', ok: true, truncated: false, duration_ms: 52, output: '8 hosts: basalt, granite, obsidian, quartz, shale (Proxmox VE), flint, onyx, marble (offline)' }],
      [9, { kind: 'error', text: 'Claude Code stopped: the token is no longer valid (401). Sign in again under Settings › Assistant.' }],
      [9, { kind: 'status', state: 'failed', text: null }],
    ],
  },
];

function pendingOf(events: InvestigationEvent[]): number {
  const decided = new Set(events.flatMap((e) => (e.kind === 'approval_decided' ? [e.approval_id] : [])));
  return events.filter((e) => e.kind === 'approval' && !decided.has(e.approval_id)).length;
}

function seed(a: AssistFx, anchor: number): void {
  a.investigations = [];
  a.events.clear();
  for (const s of SEEDS) {
    const start = anchor - s.ago;
    const events = s.events.map(([sec, body], k) => ({ ...body, seq: k + 1, at: iso(start + sec * 1000) }) as InvestigationEvent);
    a.events.set(s.inv.id, events);
    a.investigations.push({ ...s.inv, created_at: iso(start), updated_at: events[events.length - 1]!.at, pending_approvals: pendingOf(events) });
  }
}

/** ?assistant=1 (on, both CLIs ready, seeded investigations), ?assistant=nosandbox (the same, not sandboxed). */
export function applyAssistToggle(st: BrowserState, value: string | null): void {
  if (value !== '1' && value !== 'nosandbox') return;
  const a = assistState(st);
  a.settings = { ...a.settings, enabled: true, access: 'ask' };
  a.runner = { connected: true, sandboxed: value !== 'nosandbox', error: null };
  const checked = iso(st.anchor - 25 * MIN);
  a.providers.claude = provider('claude', { installed: true, version: '2.3.14', update_available: true, checked_at: checked, signed_in: true, account: 'Claude subscription' });
  a.providers.codex = provider('codex', { installed: true, version: LATEST.codex, checked_at: checked });
  seed(a, st.anchor);
}

// ---------------------------------------------------------------- live changes

function invById(a: AssistFx, id: string): Investigation | undefined {
  return a.investigations.find((i) => i.id === id);
}

/** Append an event (SSE `assistant.event`) and announce the investigation's new state. */
function emit(c: Ctx, a: AssistFx, inv: Investigation, body: EventBody): void {
  const list = a.events.get(inv.id) ?? [];
  const ev = { ...body, seq: (list[list.length - 1]?.seq ?? 0) + 1, at: iso(c.store.fxNow()) } as InvestigationEvent;
  list.push(ev);
  a.events.set(inv.id, list);
  if (ev.kind === 'status') inv.state = ev.state;
  if (ev.kind === 'summary') {
    inv.summary = ev.text.split('\n')[0]!.replace(/\*\*/g, '');
    inv.resolved = ev.resolved;
  }
  if (ev.kind === 'usage' && ev.cost_usd != null) inv.cost_usd = ev.cost_usd;
  inv.updated_at = ev.at;
  inv.pending_approvals = pendingOf(list);
  pushEvent(c.st, 'assistant.event', { investigation: inv.id, event: ev });
  pushEvent(c.st, 'assistant.investigation', { ...inv });
}

/** Play events one after another (real clock); a stopped or deleted investigation stops listening. */
function play(c: Ctx, a: AssistFx, inv: Investigation, steps: EventBody[], ms = STEP_MS): void {
  const gen = (a.runs.get(inv.id) ?? 0) + 1;
  a.runs.set(inv.id, gen);
  steps.forEach((body, k) =>
    c.store.schedule(c.st, ms * (k + 1), () => {
      const live = invById(a, inv.id);
      if (!live || live.state === 'stopped' || a.runs.get(inv.id) !== gen) return;
      emit(c, a, live, body);
    }),
  );
}

function result(tool_id: string, output: string, duration_ms = 600): EventBody {
  return { kind: 'tool_result', tool_id, ok: true, truncated: false, duration_ms, output };
}

/** A new investigation's run: about the alert, the host, or the fleet. */
function runScript(server: string | null, alert: Alert | undefined, prompt: string): EventBody[] {
  const host = server ?? '';
  if (alert?.rule === 'sensor.temp_high') {
    return [
      { kind: 'status', state: 'running', text: null },
      { kind: 'tool', tool_id: 't1', tool: 'get_metrics', title: 'Temperatures · 24 h', server: host, input: { host, metric: 'temp', range: '24h' } },
      result('t1', 'CPU package: average 71 °C, maximum 86 °C (13:52); above 80 °C since 13:46\nNVMe: average 44 °C, maximum 49 °C', 240),
      { kind: 'tool', tool_id: 't2', tool: 'diagnose', title: 'Processes by CPU', server: host, input: { host, check: 'processes', args: { sort: 'cpu', limit: 10 } } },
      result('t2', '    PID USER     %CPU %MEM COMMAND\n 418833 root     1260  3.1 /usr/bin/kvm -id 104 -name k3s-worker-2 …\n 402117 root      388  6.4 /usr/bin/kvm -id 101 -name build-01 …\n   1873 root       12  0.2 pvestatd', 880),
      { kind: 'tool', tool_id: 't3', tool: 'diagnose', title: 'Sensors', server: host, input: { host, check: 'sensors' } },
      result('t3', 'coretemp-isa-0000\nPackage id 0:  +83.0°C  (high = +80.0°C, crit = +100.0°C)\n\nnct6798-isa-0290\nfan1:  412 RPM  (min = 300 RPM)\nfan2:    0 RPM  (min = 300 RPM)  ALARM', 520),
      {
        kind: 'assistant',
        text: `**The CPU is hot because VM 104 (k3s-worker-2) keeps 12 cores busy and a case fan has stopped.**

- \`fan2\` reads **0 RPM** (alarm); \`fan1\` still turns at 412 RPM
- the package reached **86 °C** at 13:52; it has been above 80 °C since 13:46
- VM 104 uses about 1,260% CPU since 13:40`,
      },
      { kind: 'summary', resolved: false, text: '**Check fan2 on shale.** It has stopped, and with VM 104 busy the CPU runs above 80 °C. Until the fan is fixed, limit VM 104 or move it to another host.' },
      { kind: 'usage', cost_usd: 0.09, input_tokens: 18_300, output_tokens: 900 },
      { kind: 'status', state: 'done', text: null },
    ];
  }
  const fleet = !server;
  return [
    { kind: 'status', state: 'running', text: null },
    fleet
      ? { kind: 'tool', tool_id: 't1', tool: 'list_hosts', title: 'Hosts', server: null, input: {} }
      : { kind: 'tool', tool_id: 't1', tool: 'get_host', title: 'Host state', server: host, input: { host } },
    result('t1', fleet ? '8 hosts: 7 online, marble offline; 3 open alerts' : `${host} · online · no failed collectors`, 90),
    { kind: 'tool', tool_id: 't2', tool: 'diagnose', title: 'Failed services', server: fleet ? 'basalt' : host, input: { host: fleet ? 'basalt' : host, check: 'services', args: { state: 'failed' } } },
    result('t2', '  UNIT LOAD ACTIVE SUB DESCRIPTION\n0 loaded units listed.', 410),
    {
      kind: 'assistant',
      text: alert
        ? `I looked into **${alert.title}**: ${alert.detail}. Nothing else on the host is failing; the alert is the only problem I found.`
        : `About “${prompt}”: ${fleet ? 'every online host' : host} looks fine. No failed services and nothing near a limit beyond the open alerts.`,
    },
    { kind: 'status', state: 'idle', text: null },
  ];
}

// ---------------------------------------------------------------- routes

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const PROVIDER_RE = '(claude|codex)';
const ACCESS: Access[] = ['read', 'ask', 'full'];

function settingsPatch(b: Record<string, unknown>): { patch: Partial<AssistantSettings> } | FxResponse {
  const patch: Partial<AssistantSettings> = {};
  const bad = (field: string) => problem(400, 'invalid_settings', `Invalid ${field}.`);
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return bad('enabled');
    patch.enabled = b.enabled;
  }
  if (b.provider !== undefined) {
    if (b.provider !== 'claude' && b.provider !== 'codex') return bad('provider');
    patch.provider = b.provider;
  }
  if (b.access !== undefined) {
    if (!ACCESS.includes(b.access as Access)) return bad('access');
    patch.access = b.access as Access;
  }
  if (b.auto_investigate !== undefined) {
    if (!['off', 'critical', 'all'].includes(str(b.auto_investigate))) return bad('auto_investigate');
    patch.auto_investigate = b.auto_investigate as AssistantSettings['auto_investigate'];
  }
  if (b.auto_update !== undefined) {
    if (typeof b.auto_update !== 'boolean') return bad('auto_update');
    patch.auto_update = b.auto_update;
  }
  if (b.claude_channel !== undefined) {
    if (b.claude_channel !== 'stable' && b.claude_channel !== 'latest') return bad('claude_channel');
    patch.claude_channel = b.claude_channel;
  }
  for (const k of ['claude_model', 'codex_model'] as const) {
    if (b[k] === undefined) continue;
    const v = str(b[k]).trim();
    if (typeof b[k] !== 'string' || v.length > 128 || /\s/.test(v)) return bad(k);
    patch[k] = v;
  }
  return { patch };
}

function ready(a: AssistFx, p: ProviderId): FxResponse | null {
  if (!a.settings.enabled) return problem(409, 'assistant_disabled', 'The assistant is turned off. An admin turns it on under Settings › Assistant.');
  if (!a.providers[p].installed) return problem(409, 'provider_not_installed', `${NAME[p]} is not installed. Install it under Settings › Assistant.`);
  if (!a.providers[p].signed_in) return problem(409, 'provider_signed_out', `${NAME[p]} is signed out. Sign in under Settings › Assistant.`);
  return null;
}

type Handler = (c: Ctx, params: string[]) => FxResponse;
export interface AssistRoute {
  method: string;
  re: RegExp;
  admin?: boolean;
  handler: Handler;
}

/** ⚿ routes need a recent sign-in: refused while ?reauth=1 waits for POST /auth/reauth. */
const sensitive =
  (h: Handler): Handler =>
  (c, p) =>
    c.st.reauthRequired ? problem(403, 'reauth_required', 'This change needs a recent sign-in.') : h(c, p);

export const assistRoutes: AssistRoute[] = [
  { method: 'GET', re: /^\/assistant$/, admin: true, handler: (c) => json(200, stateJson(assistState(c.st))) },
  {
    method: 'PUT',
    re: /^\/assistant\/settings$/,
    admin: true,
    handler: sensitive((c) => {
      const a = assistState(c.st);
      const r = settingsPatch(bodyObject(c.req));
      if ('status' in r) return r;
      if (r.patch.provider && !a.providers[r.patch.provider].installed) return problem(409, 'provider_not_installed', `Install ${NAME[r.patch.provider]} first.`);
      a.settings = { ...a.settings, ...r.patch };
      appendAudit(c.store, c.st, { event: 'assistant.settings_updated', details: Object.fromEntries(Object.entries(r.patch).map(([k, v]) => [k, String(v)])) }, c.req);
      pushEvent(c.st, 'assistant.state', stateJson(a));
      return json(200, stateJson(a));
    }),
  },
  {
    method: 'POST',
    re: new RegExp(`^/assistant/providers/${PROVIDER_RE}/install$`),
    admin: true,
    handler: sensitive((c, [id]) => {
      const a = assistState(c.st);
      const p = a.providers[id as ProviderId];
      if (p.busy) return problem(409, 'busy', `${p.name} is busy.`);
      if (p.installed && !p.update_available) return json(202, stateJson(a));
      Object.assign(p, { busy: 'installing', progress: 0, error: null });
      pushEvent(c.st, 'assistant.state', stateJson(a));
      for (let k = 1; k <= 5; k++) {
        c.store.schedule(c.st, 300 * k, () => {
          if (k < 5) p.progress = k / 5;
          else Object.assign(p, { busy: null, progress: null, installed: true, version: p.latest, update_available: false, checked_at: iso(c.store.fxNow()) });
          pushEvent(c.st, 'assistant.state', stateJson(a));
        });
      }
      appendAudit(c.store, c.st, { event: 'assistant.installed', details: { provider: p.id, version: p.latest ?? '' } }, c.req);
      return json(202, stateJson(a));
    }),
  },
  {
    method: 'DELETE',
    re: new RegExp(`^/assistant/providers/${PROVIDER_RE}$`),
    admin: true,
    handler: sensitive((c, [id]) => {
      const a = assistState(c.st);
      const p = a.providers[id as ProviderId];
      if (p.busy) return problem(409, 'busy', `${p.name} is busy.`);
      Object.assign(p, { installed: false, version: null, update_available: false, error: null });
      appendAudit(c.store, c.st, { event: 'assistant.uninstalled', details: { provider: p.id } }, c.req);
      pushEvent(c.st, 'assistant.state', stateJson(a));
      return json(200, stateJson(a));
    }),
  },
  {
    method: 'POST',
    re: new RegExp(`^/assistant/providers/${PROVIDER_RE}/login$`),
    admin: true,
    handler: sensitive((c, [id]) => {
      const a = assistState(c.st);
      const p = a.providers[id as ProviderId];
      if (!p.installed) return problem(409, 'provider_not_installed', `Install ${p.name} first.`);
      if (p.id === 'claude') {
        const token = str(bodyObject(c.req).token).trim();
        if (!TOKEN_RE.test(token)) return problem(400, 'invalid_token', 'Paste the token that `claude setup-token` prints.');
        Object.assign(p, { signed_in: true, account: 'Claude subscription', error: null });
        appendAudit(c.store, c.st, { event: 'assistant.signed_in', details: { provider: p.id } }, c.req);
      } else {
        p.login = { verification_url: 'https://auth.openai.com/codex/device', user_code: 'K7QX-4HTM', expires_at: iso(c.store.fxNow() + 15 * MIN) };
        appendAudit(c.store, c.st, { event: 'assistant.sign_in_started', details: { provider: p.id } }, c.req);
        c.store.schedule(c.st, CODEX_LOGIN_MS, () => {
          if (!p.login) return;
          Object.assign(p, { login: null, signed_in: true, account: 'admin@example.com (plus)' });
          pushEvent(c.st, 'assistant.state', stateJson(a));
        });
      }
      pushEvent(c.st, 'assistant.state', stateJson(a));
      return json(200, stateJson(a));
    }),
  },
  {
    method: 'DELETE',
    re: new RegExp(`^/assistant/providers/${PROVIDER_RE}/login$`),
    admin: true,
    handler: sensitive((c, [id]) => {
      const a = assistState(c.st);
      const p = a.providers[id as ProviderId];
      Object.assign(p, { signed_in: false, account: null, login: null });
      appendAudit(c.store, c.st, { event: 'assistant.signed_out', details: { provider: p.id } }, c.req);
      pushEvent(c.st, 'assistant.state', stateJson(a));
      return json(200, stateJson(a));
    }),
  },
  {
    method: 'GET',
    re: /^\/assistant\/investigations$/,
    admin: true,
    handler: (c) => {
      const q = c.req.query;
      const server = q.get('server');
      const alert = q.get('alert');
      const n = Number.parseInt(q.get('limit') ?? '', 10);
      const limit = Number.isFinite(n) && n > 0 && n <= 500 ? n : 100;
      const list = assistState(c.st).investigations.filter((i) => (!server || i.server === server) && (!alert || i.alert_id === alert));
      return json(200, list.slice(0, limit));
    },
  },
  {
    method: 'POST',
    re: /^\/assistant\/investigations$/,
    admin: true,
    handler: (c) => {
      const a = assistState(c.st);
      const b = bodyObject(c.req);
      const p = (b.provider === 'codex' || b.provider === 'claude' ? b.provider : a.settings.provider) as ProviderId;
      const refused = ready(a, p);
      if (refused) return refused;
      const alert = str(b.alert) ? c.fx().fleet.alerts.find((x) => x.id === b.alert) : undefined;
      if (str(b.alert) && !alert) return problem(404, 'not_found', 'No such alert.');
      const server = alert?.server || str(b.server) || null;
      if (server && !findServer(c.st, server)) return problem(400, 'invalid_server', 'No such server.');
      const prompt = str(b.prompt).trim().slice(0, 4000);
      if (!alert && !prompt) return problem(400, 'invalid_prompt', 'Ask a question.');
      const running = a.investigations.filter((i) => i.state === 'starting' || i.state === 'running').length;
      if (running >= 3) return problem(429, 'too_many_running', 'Three investigations are running; wait for one to finish.');
      const now = iso(c.store.fxNow());
      const inv: Investigation = {
        id: `inv_${a.next++}`,
        title: alert ? alert.title : prompt.split('\n')[0]!.slice(0, 120),
        server,
        server_name: server,
        alert_id: alert?.id ?? null,
        provider: p,
        model: (p === 'claude' ? a.settings.claude_model : a.settings.codex_model) || null,
        state: 'starting',
        access: a.settings.access,
        auto: false,
        created_by: c.st.user.name,
        created_at: now,
        updated_at: now,
        summary: null,
        resolved: null,
        cost_usd: null,
        pending_approvals: 0,
      };
      a.investigations.unshift(inv);
      a.events.set(inv.id, []);
      const text = alert ? `Investigate the alert “${alert.title}” on ${alert.server}.${prompt ? `\n${prompt}` : ''}` : prompt;
      emit(c, a, inv, { kind: 'user', by: c.st.user.name, text });
      appendAudit(c.store, c.st, { event: 'assistant.started', server, details: { investigation: inv.id, provider: p } }, c.req);
      play(c, a, inv, runScript(server, alert, prompt));
      return json(201, { ...inv });
    },
  },
  {
    method: 'GET',
    re: /^\/assistant\/investigations\/([^/]+)$/,
    admin: true,
    handler: (c, [id]) => {
      const a = assistState(c.st);
      const inv = invById(a, decodeURIComponent(id ?? ''));
      if (!inv) return problem(404, 'not_found', 'No such investigation.');
      return json(200, { investigation: { ...inv }, events: a.events.get(inv.id) ?? [] });
    },
  },
  {
    method: 'POST',
    re: /^\/assistant\/investigations\/([^/]+)\/messages$/,
    admin: true,
    handler: (c, [id]) => {
      const a = assistState(c.st);
      const inv = invById(a, decodeURIComponent(id ?? ''));
      if (!inv) return problem(404, 'not_found', 'No such investigation.');
      const text = str(bodyObject(c.req).text).trim();
      if (!text) return problem(400, 'invalid_text', 'Write a message.');
      const refused = ready(a, inv.provider);
      if (refused) return refused;
      emit(c, a, inv, { kind: 'user', by: c.st.user.name, text });
      // A message continues an idle, finished or stopped investigation.
      const waiting = inv.pending_approvals > 0;
      if (!waiting) emit(c, a, inv, { kind: 'status', state: 'running', text: null });
      play(c, a, inv, [
        { kind: 'assistant', text: `Noted: “${text.length > 80 ? `${text.slice(0, 80)}…` : text}”. ${waiting ? 'The command above still waits for your decision.' : 'I will take it into account.'}` },
        ...(waiting ? [] : [{ kind: 'status', state: 'idle', text: null } as EventBody]),
      ], 1000);
      return json(202, { ...inv });
    },
  },
  {
    method: 'POST',
    re: /^\/assistant\/investigations\/([^/]+)\/stop$/,
    admin: true,
    handler: (c, [id]) => {
      const a = assistState(c.st);
      const inv = invById(a, decodeURIComponent(id ?? ''));
      if (!inv) return problem(404, 'not_found', 'No such investigation.');
      const active: InvestigationState[] = ['starting', 'running', 'waiting'];
      if (active.includes(inv.state)) {
        emit(c, a, inv, { kind: 'status', state: 'stopped', text: `Stopped by ${c.st.user.name}` });
        appendAudit(c.store, c.st, { event: 'assistant.stopped', server: inv.server, details: { investigation: inv.id } }, c.req);
      }
      return json(200, { ...inv });
    },
  },
  {
    method: 'POST',
    re: /^\/assistant\/investigations\/([^/]+)\/approvals\/([^/]+)$/,
    admin: true,
    handler: (c, [id, aid]) => {
      const a = assistState(c.st);
      const inv = invById(a, decodeURIComponent(id ?? ''));
      if (!inv) return problem(404, 'not_found', 'No such investigation.');
      const events = a.events.get(inv.id) ?? [];
      const ap = events.find((e) => e.kind === 'approval' && e.approval_id === decodeURIComponent(aid ?? ''));
      if (!ap || ap.kind !== 'approval') return problem(404, 'not_found', 'No such approval.');
      if (events.some((e) => e.kind === 'approval_decided' && e.approval_id === ap.approval_id)) return problem(409, 'already_decided', 'This approval was already decided.');
      const b = bodyObject(c.req);
      if (typeof b.approve !== 'boolean') return problem(400, 'invalid_request', 'approve must be true or false.');
      const reply = str(b.reply).trim() || null;
      emit(c, a, inv, { kind: 'approval_decided', approval_id: ap.approval_id, decision: b.approve ? 'approved' : 'declined', by: c.st.user.name, reply });
      appendAudit(c.store, c.st, { event: b.approve ? 'assistant.approved' : 'assistant.declined', server: ap.server, details: { investigation: inv.id, command: ap.command } }, c.req);
      play(
        c,
        a,
        inv,
        b.approve
          ? [
              { kind: 'status', state: 'running', text: null },
              result(ap.tool_id, `=== START OF OFFLINE IMMEDIATE AND SELF-TEST SECTION ===\nSending command: "Execute SMART Short self-test routine immediately in off-line mode".\nTesting has begun.\nPlease wait 2 minutes for test to complete.`, 1380),
              { kind: 'assistant', text: 'The self-test is running; I will read its result in about 2 minutes.' },
              { kind: 'status', state: 'idle', text: null },
            ]
          : [
              { kind: 'tool_result', tool_id: ap.tool_id, ok: false, truncated: false, duration_ms: 0, output: `Declined by ${c.st.user.name}${reply ? `: ${reply}` : ''}` },
              { kind: 'assistant', text: reply ? `Understood, I won't run it. ${reply}` : "Understood, I won't run it. The SMART data above is all I have; nothing points to a defect beyond the wear." },
              { kind: 'status', state: 'idle', text: null },
            ],
      );
      return json(200, { ...inv });
    },
  },
  {
    method: 'DELETE',
    re: /^\/assistant\/investigations\/([^/]+)$/,
    admin: true,
    handler: (c, [id]) => {
      const a = assistState(c.st);
      const inv = invById(a, decodeURIComponent(id ?? ''));
      if (!inv) return problem(404, 'not_found', 'No such investigation.');
      a.investigations = a.investigations.filter((i) => i.id !== inv.id);
      a.events.delete(inv.id);
      a.runs.delete(inv.id);
      appendAudit(c.store, c.st, { event: 'assistant.deleted', details: { investigation: inv.id } }, c.req);
      pushEvent(c.st, 'assistant.deleted', { id: inv.id });
      return noContent();
    },
  },
];
