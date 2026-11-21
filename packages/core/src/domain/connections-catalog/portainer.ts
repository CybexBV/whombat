import {
  type CatalogEntryInput,
  certificateField,
  DELETES_ASK,
  REQUEST_TOOL_NAME,
  urlField,
} from './shared.js';

export const entry = {
  id: 'portainer',
  name: 'Portainer',
  category: 'infrastructure',
  description: 'Containers, stacks and images on the Docker hosts your Portainer manages.',
  tagline: 'Docker containers and stacks',
  signIn: [
    {
      kind: 'password',
      label: 'Sign in once',
      account: { label: 'Username', placeholder: 'admin', help: 'The name you sign in to Portainer with.' },
      secondFactor: 'never',
      creates:
        'An access token named Whombat on this account. Portainer gives a token its user’s rights, so Whombat keeps it to the level you choose.',
      serviceLimits: false,
    },
    {
      kind: 'token',
      label: 'Access token',
      auth: { type: 'header', name: 'X-API-Key', template: '{secret}' },
      secretLabel: 'Access token',
      secretPlaceholder: 'ptr_…',
      secretHelp:
        'Create one in Portainer → your user menu (top right) → My account → Access tokens → Add access token. It can do what that user can: use an administrator for full control.',
      steps: [
        { text: 'In Portainer, open your user menu (top right) → My account.' },
        {
          text: 'Under Access tokens, click Add access token, describe it and confirm your password.',
          values: [{ label: 'Description', value: 'Whombat' }],
        },
        { text: 'Copy the token (it’s shown once) and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b(ptr_[A-Za-z0-9+/=_-]+)' }],
    },
  ],
  fields: [
    urlField('https://portainer.local:9443', 'Your Portainer’s address with its port (usually 9443).'),
    certificateField('your browser shows it under the padlock → certificate'),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api/users/me' },
  tools: [],
  request: {
    prefixes: ['/api/'],
    readPaths: [
      {
        method: 'POST',
        path: '^/api/(templates/[0-9]+/file|gitops/repo/file/preview|kubernetes/[0-9]+/manifests/dry_run|registries/ping|gitops/sources(/[0-9]+)?/test|ldap/check)$',
      },
    ],
    allowedHeaders: ['X-Registry-Auth'],
  },
  guide:
    'Portainer’s API under /api/. GET /api/endpoints?excludeSnapshots=true lists environments (Id, Name, Type 1 Docker, 2 Agent, 4 Edge, 5–7 Kubernetes; Status 1 up, 2 down). Each environment’s Docker Engine API is under /api/endpoints/<id>/docker/: GET …/containers/json?all=1, …/containers/<id or name>/json; POST …/containers/<id>/start, /stop, /restart; GET …/images/json, …/volumes, …/networks, …/info, …/system/df; POST …/images/create?fromImage=<image>&tag=<tag> pulls (X-Registry-Auth for a private registry). GET …/containers/<id>/logs?stdout=1&stderr=1&tail=200 reads the last log lines as text (stderr lines start with “stderr: ”). Stacks: GET /api/stacks (Id, Name, EndpointId, Status 1 active, 2 inactive), GET /api/stacks/<id>/file reads the compose file; POST /api/stacks/<id>/start or /stop?endpointId=<env>; PUT /api/stacks/<id>?endpointId=<env> {StackFileContent, Env, PullImage} updates it; PUT /api/stacks/<id>/git/redeploy?endpointId=<env> {PullImage: true} pulls from Git and redeploys; POST /api/stacks/create/standalone/string?endpointId=<env> {Name, StackFileContent} creates one. The token can do what its user can: a 403 means that user lacks the environment or action. Deleting containers, images, volumes, stacks or environments, Docker prune, creating users or access tokens, changing a user, restoring Portainer and leaving a swarm always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/endpoints/[0-9]+/docker(/v[0-9.]+)?/(containers|images|volumes|networks|build)/prune$',
      reason: 'Prunes Docker: removes stopped containers or unused images, volumes, networks or build cache',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/(endpoints|kubernetes/[0-9]+/[a-z_]+)/delete$',
      reason: 'Deletes environments or Kubernetes resources',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT'],
      path: '^/api/users(/admin/init|/[0-9]+(/(tokens|passwd))?)?$',
      reason: 'Creates or changes a user, their role or password, or an access token',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/(restore|system/upgrade)$',
      reason: 'Restores Portainer from a backup or upgrades it to Business Edition',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/endpoints/[0-9]+/docker(/v[0-9.]+)?/swarm/leave$',
      reason: 'Takes this Docker host out of its swarm',
    },
  ],
  docsUrl: 'https://docs.portainer.io/api/docs',
  tokenUrl: '{url}/#!/account',
  handle: 'portainer',
  access: {
    read: 'The agent can see containers, stacks, images and logs, and change nothing.',
    manage:
      'The agent can also start, stop and restart containers and redeploy stacks. Pruning, deleting and users ask you first.',
  },
  discovery: {
    targets: [
      { port: 9443, scheme: 'https' },
      { port: 9000, scheme: 'http' },
    ],
    probes: [
      {
        path: '/api/system/status',
        status: [200],
        bodyPattern: '"InstanceID"',
        version: { json: 'Version' },
      },
    ],
  },
} satisfies CatalogEntryInput;
