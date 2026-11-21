/**
 * Real answers of Grafana OSS 13.2.4 (a throwaway container, 2026-10-21; a Viewer service account’s token), trimmed:
 * the rules’ `query` left out. Data source health: TestData 200 OK, a Prometheus at a closed port 400 ERROR, an
 * Alertmanager data source (no backend health check) 500 “Plugin unavailable”.
 */

export const GRAFANA_HEALTH = {
  database: 'ok',
  version: '13.2.4',
  commit: '0e79aef9d91abf3bdadae9af15763029072fb45b',
};

export const GRAFANA_ALERTS = [
  {
    annotations: {
      __alert_rule_namespace_uid__: 'homelab',
      __orgId__: '1',
      __value_string__:
        "[ var='B' labels={__name__=A-series} type='reduce' value=5 ], [ var='C' labels={__name__=A-series} type='threshold' value=1 ]",
      __values__: '{"B":5,"C":1}',
      summary: 'The disk on nas is almost full',
    },
    endsAt: '2026-10-21T19:49:30.000Z',
    fingerprint: '1a6b2e0dbf55c214',
    receivers: [{ name: 'empty' }],
    startsAt: '2026-10-21T19:47:30.000Z',
    status: { inhibitedBy: [], silencedBy: [], state: 'active' },
    updatedAt: '2026-10-21T19:47:35.009Z',
    generatorURL: 'http://localhost:3000/alerting/grafana/disk-full/view',
    labels: {
      __alert_rule_uid__: 'disk-full',
      __name__: 'A-series',
      alertname: 'Disk almost full',
      grafana_folder: 'Homelab',
      severity: 'critical',
    },
  },
];

export const GRAFANA_RULES = {
  status: 'success',
  data: {
    groups: [
      {
        name: 'fixtures',
        file: 'Homelab',
        folderUid: 'homelab',
        rules: [
          {
            state: 'firing',
            name: 'Disk almost full',
            queriedDatasourceUIDs: ['testdata'],
            annotations: { summary: 'The disk on nas is almost full' },
            activeAt: '2026-10-21T19:47:30Z',
            alerts: [
              {
                labels: {
                  __name__: 'A-series',
                  alertname: 'Disk almost full',
                  grafana_folder: 'Homelab',
                  severity: 'critical',
                },
                annotations: { summary: 'The disk on nas is almost full' },
                state: 'Alerting',
                activeAt: '2026-10-21T19:47:30Z',
                value: '1e+00',
              },
            ],
            totals: { alerting: 1 },
            totalsFiltered: { alerting: 1 },
            uid: 'disk-full',
            folderUid: 'homelab',
            labels: { severity: 'critical' },
            health: 'ok',
            type: 'alerting',
            lastEvaluation: '2026-10-21T19:47:30Z',
            evaluationTime: 0.000517878,
            isPaused: false,
          },
          {
            state: 'pending',
            name: 'Backup is late',
            queriedDatasourceUIDs: ['testdata'],
            duration: 3600,
            annotations: { summary: 'The nightly backup has not finished' },
            alerts: [
              {
                labels: {
                  __name__: 'A-series',
                  alertname: 'Backup is late',
                  grafana_folder: 'Homelab',
                  severity: 'warning',
                },
                annotations: { summary: 'The nightly backup has not finished' },
                state: 'Pending',
                activeAt: '2026-10-21T19:47:30Z',
                value: '1e+00',
              },
            ],
            totals: { pending: 1 },
            totalsFiltered: { pending: 1 },
            uid: 'backup-late',
            folderUid: 'homelab',
            labels: { severity: 'warning' },
            health: 'ok',
            type: 'alerting',
            lastEvaluation: '2026-10-21T19:47:40Z',
            evaluationTime: 0.000234673,
            isPaused: false,
          },
        ],
        totals: { firing: 1, pending: 1 },
        interval: 10,
        lastEvaluation: '2026-10-21T19:47:40Z',
        evaluationTime: 0.000234673,
      },
    ],
    totals: { firing: 1, pending: 1 },
  },
};

export const GRAFANA_DATASOURCES = [
  {
    id: 3,
    uid: 'am-nohealth',
    orgId: 1,
    name: 'Alertmanager',
    type: 'alertmanager',
    typeName: 'Alertmanager',
    typeLogoUrl: 'public/plugins/alertmanager/img/logo.svg',
    access: 'proxy',
    url: 'http://127.0.0.1:9',
    user: '',
    database: '',
    basicAuth: false,
    isDefault: false,
    jsonData: { handleGrafanaManagedAlerts: false, implementation: 'prometheus' },
    readOnly: false,
  },
  {
    id: 2,
    uid: 'prom-down',
    orgId: 1,
    name: 'Prometheus',
    type: 'prometheus',
    typeName: 'Prometheus',
    typeLogoUrl: 'public/plugins/prometheus/img/prometheus_logo.svg',
    access: 'proxy',
    url: 'http://127.0.0.1:9',
    user: '',
    database: '',
    basicAuth: false,
    isDefault: false,
    jsonData: { httpMethod: 'POST' },
    readOnly: false,
  },
  {
    id: 1,
    uid: 'testdata',
    orgId: 1,
    name: 'TestData',
    type: 'grafana-testdata-datasource',
    typeName: 'TestData',
    typeLogoUrl: 'public/plugins/grafana-testdata-datasource/img/testdata.svg',
    access: 'proxy',
    url: '',
    user: '',
    database: '',
    basicAuth: false,
    isDefault: true,
    jsonData: {},
    readOnly: false,
  },
];

export const GRAFANA_HEALTH_OK = { message: 'Data source is working', status: 'OK' };

export const GRAFANA_HEALTH_ERROR = {
  message:
    'Post "http://127.0.0.1:9/api/v1/query": dial tcp 127.0.0.1:9: connect: connection refused - There was an error returned querying the Prometheus API.',
  status: 'ERROR',
};

export const GRAFANA_HEALTH_NONE = {
  statusCode: 500,
  messageId: 'plugin.unavailable',
  message: 'Plugin unavailable',
};

export const GRAFANA_STARRED = [
  {
    id: 805878364254208,
    uid: 'servers',
    orgId: 1,
    title: 'Servers',
    uri: 'db/servers',
    url: '/d/servers/servers',
    slug: '',
    type: 'dash-db',
    tags: ['homelab'],
    isStarred: true,
    folderId: 805878225846272,
    folderUid: 'homelab',
    folderTitle: 'Homelab',
    folderUrl: '/dashboards/f/homelab/homelab',
    sortMeta: 0,
    isDeleted: false,
  },
];

/**
 * Real answers of Grafana OSS 13.3.0 (a throwaway container, 2026-11-04; the same Viewer token), trimmed to the fields
 * read: `/api/annotations?type=alert&from&to&limit=1000`, the alert state history Grafana keeps by default, with a rule
 * that fires (“Disk almost full”, after an error while its query was wrong) and one about to fire; and
 * `/api/search?type=dash-db&limit=5000`.
 */
export const GRAFANA_HISTORY = [
  {
    id: 6,
    alertId: 1,
    alertName: 'Disk almost full',
    newState: 'Normal (Updated)',
    prevState: 'Error',
    time: 1793820265002,
    text: 'Disk almost full {alertname=Disk almost full, grafana_folder=Homelab, severity=critical} - ',
  },
  {
    id: 4,
    alertId: 3,
    alertName: 'Backup is late',
    newState: 'Normal (Updated)',
    prevState: 'Pending (Error)',
    time: 1793820260002,
    text: 'Backup is late {alertname=Backup is late, grafana_folder=Homelab, severity=warning} - ',
  },
  {
    id: 7,
    alertId: 1,
    alertName: 'Disk almost full',
    newState: 'Alerting',
    prevState: 'Normal',
    time: 1793820260000,
    text: 'Disk almost full {alertname=Disk almost full, grafana_folder=Homelab, severity=critical} - B=95.000000, C=1.000000',
  },
  {
    id: 5,
    alertId: 3,
    alertName: 'Backup is late',
    newState: 'Pending',
    prevState: 'Normal',
    time: 1793820260000,
    text: 'Backup is late {alertname=Backup is late, grafana_folder=Homelab, severity=warning} - B=95.000000, C=1.000000',
  },
  {
    id: 1,
    alertId: 1,
    alertName: 'Disk almost full',
    newState: 'Error',
    prevState: 'Normal',
    time: 1793820230000,
    text: 'Disk almost full {alertname=Disk almost full, grafana_folder=Homelab, severity=critical} - Error',
  },
];

export const GRAFANA_DASHBOARDS = [
  {
    id: 1369953362939904,
    uid: 'network',
    orgId: 1,
    title: 'Network',
    uri: 'db/network',
    url: '/d/network/network',
    slug: '',
    type: 'dash-db',
    tags: [],
    isStarred: false,
    sortMeta: 0,
    isDeleted: false,
  },
  {
    id: 1369953279053824,
    uid: 'servers',
    orgId: 1,
    title: 'Servers',
    uri: 'db/servers',
    url: '/d/servers/servers',
    slug: '',
    type: 'dash-db',
    tags: [],
    isStarred: false,
    sortMeta: 0,
    folderUid: 'homelab',
    folderTitle: 'Homelab',
    sortMetaName: '',
    isDeleted: false,
  },
];
