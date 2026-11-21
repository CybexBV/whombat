import { BEARER, type CatalogEntryInput, certificateField, urlField } from './shared.js';

export const entry = {
  // The AI gateway (0.76, CT-332; Whombat ai-gateway.md AIG-01, AIG-02, AIG-18): Whombat adds its own client key with
  // the management key, sends Claude Code and ChatGPT turns through it while a switch is on, and reads the accounts'
  // limits for Settings → AI → Usage.
  id: 'fusebox',
  name: 'Fusebox',
  category: 'developer',
  description: 'Send Claude Code and ChatGPT through Fusebox and see what’s left on its subscriptions.',
  tagline: 'One gateway for Claude Code and ChatGPT',
  use: 'gateway',
  signIn: [
    {
      kind: 'token',
      label: 'Management key',
      auth: BEARER,
      secretLabel: 'Management key',
      secretHelp:
        'Whombat uses it to add its own client key to Fusebox and to read the accounts’ limits. It’s the key you open Fusebox’s dashboard with.',
    },
  ],
  fields: [
    urlField('https://fusebox.example.com:8317', 'Fusebox’s address, with its port.'),
    certificateField('your browser shows it under the padlock → certificate'),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api/accounts', okStatus: [200] },
  tools: [],
  request: null,
  guide:
    'Fusebox carries the Claude Code and ChatGPT turns of this Whombat while that is switched on. The agent doesn’t use this connection.',
  sensitive: [],
  docsUrl: 'https://github.com/DigitalPals/Fusebox',
  tokenUrl: '{url}',
  handle: 'fusebox',
  discovery: {
    targets: [
      { port: 8317, scheme: 'https' },
      { port: 8317, scheme: 'http' },
    ],
    probes: [{ path: '/', bodyPattern: '<title>Fusebox</title>' }],
  },
} satisfies CatalogEntryInput;
