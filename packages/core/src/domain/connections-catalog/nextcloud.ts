import { type CatalogEntryInput, DELETES_ASK, FILES_TOOLS, urlField } from './shared.js';

export const entry = {
  id: 'nextcloud',
  name: 'Nextcloud',
  category: 'files',
  description: 'Files, calendars and contacts on your Nextcloud.',
  tagline: 'Files, calendars and contacts',
  signIn: [
    // SG-15f (0.111, CT-741): no password, and it works for every account (two-step, single sign-on, LDAP).
    { kind: 'nextcloud_login', label: 'Sign in with Nextcloud', startPath: '/index.php/login/v2' },
    {
      kind: 'password',
      label: 'Sign in once',
      account: {
        label: 'Username',
        placeholder: 'mara',
        help: 'Your Nextcloud login name (not your email address).',
      },
      secondFactor: 'never',
      creates:
        'An app password named Whombat, listed under your devices in Nextcloud. Nextcloud can’t limit it, so Whombat keeps it to the level you choose.',
      serviceLimits: false,
    },
    {
      kind: 'token',
      label: 'App password',
      auth: { type: 'basic', usernameField: 'username' },
      secretLabel: 'App password',
      secretHelp:
        'Create one in Nextcloud → Personal settings → Security → Devices & sessions → Create new app password.',
      steps: [
        { text: 'In Nextcloud, open Personal settings → Security.' },
        {
          text: 'Under Devices & sessions, enter an app name and click Create new app password.',
          values: [{ label: 'App name', value: 'Whombat' }],
        },
        { text: 'Copy the username and the password it shows, and paste them here.' },
      ],
      paste: [
        { target: 'username', pattern: '(?:Username|Login name|Login)\\s*[:\\t ]\\s*(\\S+)' },
        { target: 'secret', pattern: '\\b([A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){4})\\b' },
      ],
    },
  ],
  fields: [
    urlField('https://cloud.example.com', 'Your Nextcloud’s address, as you open it in the browser.'),
    {
      id: 'username',
      label: 'Username',
      placeholder: 'mara',
      kind: 'text',
      required: true,
      methods: ['token'],
      help: 'Your Nextcloud login name.',
    },
    {
      // SG-15a (0.111, CT-737): an LDAP or AD account's user id isn't its login name; the check reads it.
      id: 'userId',
      label: 'User ID',
      kind: 'text',
      required: false,
      fromCheck: 'ocs.data.id',
      help: 'Whombat reads it from Nextcloud.',
    },
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  // The account's own user id (SG-15a, CT-741): fills `userId` for the WebDAV paths, whatever the login name is.
  check: {
    kind: 'request',
    method: 'GET',
    path: '/ocs/v2.php/cloud/user?format=json',
    headers: { 'OCS-APIRequest': 'true', Accept: 'application/json' },
    okJsonPath: 'ocs.data.id',
  },
  tools: [...FILES_TOOLS],
  request: {
    prefixes: ['/remote.php/dav/', '/ocs/'],
    methods: [
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'PROPFIND',
      'REPORT',
      'SEARCH',
      'MKCOL',
      'MOVE',
      'COPY',
    ],
    readMethods: ['GET', 'HEAD', 'PROPFIND', 'REPORT', 'SEARCH'],
    headers: { 'OCS-APIRequest': 'true' },
    allowedHeaders: ['Depth', 'Destination', 'Overwrite'],
  },
  guide:
    'Nextcloud. The files_* tools work in the person’s files (paths from their root: /Documents/…). With request, WebDAV is under /remote.php/dav/: files at /remote.php/dav/files/<user id>/ (PROPFIND with header Depth: 1 lists a folder, GET reads, PUT writes, MKCOL makes a folder, MOVE with a Destination header moves); SEARCH on /remote.php/dav/ searches. Calendars are CalDAV at /remote.php/dav/calendars/<user id>/ (REPORT with a calendar-query reads events, PUT of an .ics adds one) and contacts CardDAV at /remote.php/dav/addressbooks/users/<user id>/. OCS APIs are under /ocs/v2.php/… (add ?format=json; Whombat sends OCS-APIRequest: true), like /ocs/v2.php/cloud/capabilities or the Deck and Talk APIs. PROPFIND, REPORT and SEARCH count as reads. <user id> is the connection’s userId, which isn’t always the login name (GET /ocs/v2.php/cloud/user?format=json answers it as ocs.data.id).',
  sensitive: [DELETES_ASK],
  docsUrl: 'https://docs.nextcloud.com/server/latest/developer_manual/client_apis/',
  tokenUrl: '{url}/settings/user/security',
  handle: 'nextcloud',
  access: {
    read: 'The agent can browse and read your files, calendars and contacts, and change nothing.',
    manage: 'The agent can also add, change and move files and calendar items. Deleting asks you first.',
  },
  discovery: {
    targets: [
      { port: 443, scheme: 'https' },
      { port: 80, scheme: 'http' },
      { port: 8080, scheme: 'http' },
      { port: 11000, scheme: 'http' },
    ],
    probes: [
      {
        path: '/status.php',
        status: [200],
        bodyPattern: '"extendedSupport"',
        version: { json: 'versionstring' },
      },
    ],
  },
} satisfies CatalogEntryInput;
