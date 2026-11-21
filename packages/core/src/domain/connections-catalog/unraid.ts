import { type CatalogEntryInput, certificateField, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'unraid',
  name: 'Unraid',
  category: 'infrastructure',
  description: 'The array, shares, Docker containers and VMs on your Unraid server.',
  tagline: 'Storage, Docker and VMs',
  signIn: [
    {
      kind: 'password',
      label: 'Sign in once',
      account: {
        label: 'User',
        placeholder: 'root',
        help: 'Unraid’s web interface signs in as root.',
        fixed: 'root',
      },
      secondFactor: 'never',
      creates: 'An API key named Whombat with the Viewer role to look, or the Admin role to manage.',
      serviceLimits: true,
    },
    {
      kind: 'token',
      label: 'API key',
      auth: { type: 'header', name: 'x-api-key', template: '{secret}' },
      secretLabel: 'API key',
      secretHelp:
        'Create one in Unraid → Settings → Management Access → API Keys → Create (Unraid 7.2 or later; before that with the Unraid Connect plugin). Give it the Admin role so the agent can act, or Viewer to only look.',
      steps: [
        { text: 'Open the link and sign in: Unraid shows an API key made for Whombat.' },
        { text: 'Confirm, copy the key (it’s shown once) and paste it here.' },
      ],
      links: {
        read: '{url}/ApiKeyAuthorize?name=Whombat&scopes=role:viewer',
        manage: '{url}/ApiKeyAuthorize?name=Whombat&scopes=role:admin',
      },
    },
  ],
  fields: [
    urlField(
      'http://tower.local',
      'Your Unraid server’s address. Use https:// when Settings → Management Access → Use SSL/TLS is Yes, or the myunraid.net address when it is Strict.',
    ),
    certificateField('your browser shows it under the padlock → certificate'),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: {
    kind: 'request',
    method: 'POST',
    path: '/graphql',
    body: '{"query":"{ me { name roles } }"}',
    headers: { 'Content-Type': 'application/json' },
    okJsonPath: 'data.me.name',
  },
  tools: [],
  // A query reads, a mutation changes (0.91, CT-405).
  request: {
    prefixes: ['/graphql'],
    methods: ['POST'],
    readPaths: [{ method: 'POST', path: '^/graphql$', graphql: true }],
  },
  guide:
    'Unraid’s API is GraphQL: every call is POST /graphql with {"query": "…", "variables": {…}}; queries only read. It answers {"data": …}, errors as {"errors": […]} with status 200. Introspection is usually off: use these fields. Reads: { info { os { hostname uptime } versions { core { unraid api } } } }, { metrics { cpu { percentTotal } memory { used total } } }, { array { state capacity { kilobytes { free used total } } disks { name status temp fsFree numErrors } parities { name status } caches { name fsFree } parityCheckStatus { status progress errors running } } }, { shares { name free used comment } }, { docker { containers { id names image state status } } }, { docker { logs(id: "<id>", tail: 200) { lines { timestamp message } } } }, { vms { domains { id name state } } }, { notifications { list(filter: {type: UNREAD, offset: 0, limit: 20}) { id title subject importance } } }, { logFile(path: "/var/log/syslog", lines: 100) { content } }. Actions: mutation { docker { restart(id: "<id>") { state } } } (also start, stop, pause, unpause, updateContainer); mutation { vm { start(id: "<id>") } } (stop, reboot, pause, resume); mutation { parityCheck { start(correct: false) } } (pause, resume, cancel); mutation { archiveNotification(id: "<id>") { id } }. “Forbidden resource” means the key’s role lacks it. Stopping the array, force-stopping or resetting a VM, deleting anything, adding disks, opening remote or SSH access and creating API keys always ask a person.',
  sensitive: [
    {
      tools: [REQUEST_TOOL_NAME],
      argValue: '\\bsetState\\s*\\([\\s\\S]*\\bSTOP\\b|^STOP$',
      reason: 'Stops the array: shares, Docker and VMs go offline',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      argValue: '\\bmutation\\b[\\s\\S]*\\b(forceStop|reset)\\s*\\(',
      reason: 'Force-stops or resets a virtual machine without a clean shutdown',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      argValue: '\\bmutation\\b[\\s\\S]*\\b(delete|remove)\\w*\\s*[({]',
      reason: 'Deletes or removes something',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      argValue: '\\bapiKey\\s*\\{[\\s\\S]*\\b(create|addRole|update)\\s*\\(',
      reason: 'Creates an API key or widens one’s access',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      argValue: '\\bmutation\\b[\\s\\S]*\\b(addDiskToArray|createInternalBootPool)\\s*\\(',
      reason: 'Assigns disks to the array or formats a boot pool',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      argValue:
        '\\bmutation\\b[\\s\\S]*\\b(setupRemoteAccess|enableDynamicRemoteAccess|updateSshSettings)\\s*\\(',
      reason: 'Opens remote or SSH access to the server',
    },
  ],
  docsUrl: 'https://docs.unraid.net/API/how-to-use-the-api/',
  tokenUrl: '{url}/Settings/ManagementAccess',
  handle: 'unraid',
  access: {
    read: 'The agent can see the array, shares, Docker and VMs, and change nothing.',
    manage:
      'The agent can also start and stop containers and VMs. Stopping the array, force-stopping VMs and deleting ask you first.',
  },
  discovery: {
    targets: [
      { port: 80, scheme: 'http' },
      { port: 443, scheme: 'https' },
    ],
    probes: [{ path: '/login', status: [200], bodyPattern: 'Unraid webGUI|/webGui/styles/' }],
  },
  asServer: true,
} satisfies CatalogEntryInput;
