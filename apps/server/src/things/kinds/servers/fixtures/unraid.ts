/**
 * Unraid's GraphQL answers in the shape of its published schema (github.com/unraid/api, `api/generated-schema.graphql`,
 * fetched 2026-11-23): sizes in kilobytes (`capacity.kilobytes` as text, `fsSize`/`fsFree`), enums in capitals. One
 * answer per query the kind sends (`ARRAY_QUERY`, `GUESTS_QUERY`, `MORE_QUERY`). Made-up values on example names; not
 * recorded from a real server.
 */

/** `ARRAY_QUERY`: a started array of two data disks and a parity, one cache pool. */
export const UNRAID_ARRAY = {
  data: {
    info: { os: { hostname: 'Tower', uptime: '2026-11-11T08:00:00.000Z' } },
    array: {
      state: 'STARTED',
      capacity: { kilobytes: { free: '2929687500', used: '4882812500', total: '7812500000' } },
      parities: [{ name: 'parity', status: 'DISK_OK', temp: 34, numErrors: 0 }],
      disks: [
        {
          name: 'disk1',
          status: 'DISK_OK',
          temp: 36,
          numErrors: 0,
          fsSize: '3906250000',
          fsFree: '976562500',
        },
        {
          name: 'disk2',
          status: 'DISK_OK',
          temp: 38,
          numErrors: 0,
          fsSize: '3906250000',
          fsFree: '1953125000',
        },
        { name: 'disk3', status: 'DISK_NP', temp: null, numErrors: 0, fsSize: null, fsFree: null },
      ],
      caches: [
        {
          name: 'cache',
          status: 'DISK_OK',
          temp: 41,
          numErrors: 0,
          fsSize: '976562500',
          fsFree: '585937500',
        },
      ],
    },
  },
};

/** `GUESTS_QUERY`: three containers (one unhealthy, one stopped) and two VMs. */
export const UNRAID_GUESTS = {
  data: {
    docker: {
      containers: [
        { id: 'c1', names: ['/plex'], state: 'RUNNING', status: 'Up 12 days' },
        { id: 'c2', names: ['/nextcloud'], state: 'RUNNING', status: 'Up 3 hours (unhealthy)' },
        { id: 'c3', names: ['/old-sonarr'], state: 'EXITED', status: 'Exited (0) 2 weeks ago' },
      ],
    },
    vms: {
      domains: [
        { id: 'v1', name: 'Windows 11', state: 'SHUTOFF' },
        { id: 'v2', name: 'Home Assistant', state: 'RUNNING' },
      ],
    },
  },
};

/** `MORE_QUERY`: shares, unread notifications, the last parity check, the processor and memory, the version. */
export const UNRAID_MORE = {
  data: {
    shares: [{ name: 'appdata' }, { name: 'media' }, { name: 'isos' }, { name: 'backups' }],
    notifications: { overview: { unread: { warning: 1, alert: 0, total: 3 } } },
    array: {
      parityCheckStatus: {
        date: '2026-11-01T04:43:30.000Z',
        status: 'COMPLETED',
        progress: 100,
        errors: 0,
        running: false,
        paused: false,
      },
    },
    metrics: { cpu: { percentTotal: 12.5 }, memory: { total: 34359738368, used: 12884901888 } },
    info: { versions: { core: { unraid: '7.2.2' } } },
  },
};

/** A refused part: GraphQL's error beside no data. */
export const UNRAID_FORBIDDEN = { errors: [{ message: 'Forbidden resource' }] };
