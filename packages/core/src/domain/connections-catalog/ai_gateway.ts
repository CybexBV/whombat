import { BEARER, type CatalogEntryInput, certificateField, urlField } from './shared.js';

export const entry = {
  // Any other AI gateway (AIG-04): LiteLLM, a company's gateway, a Fusebox connected with a client key. Claude Code
  // uses `{url}` as its Anthropic base; a ChatGPT turn (Hermes's own loop, CT-1452) `{url}/v1` as an
  // OpenAI-compatible Responses base. No management API, so no pool.
  id: 'ai_gateway',
  name: 'AI gateway',
  category: 'developer',
  description: 'Send Claude Code and ChatGPT through your own AI gateway, like LiteLLM.',
  use: 'gateway',
  signIn: [
    {
      kind: 'token',
      label: 'Key',
      auth: BEARER,
      secretLabel: 'Key',
      secretHelp:
        'A key your gateway accepts for Claude Code and ChatGPT, like a LiteLLM virtual key. Whombat sends it as a bearer token.',
    },
  ],
  fields: [
    urlField(
      'https://llm.example.com',
      'The gateway’s address. Claude Code uses it as its Anthropic address; ChatGPT turns add /v1 for an OpenAI-compatible Responses API.',
    ),
    certificateField('your browser shows it under the padlock → certificate'),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/v1/models', okStatus: [200] },
  tools: [],
  request: null,
  guide:
    'An AI gateway carries the Claude Code and ChatGPT turns of this Whombat while that is switched on. The agent doesn’t use this connection.',
  sensitive: [],
  docsUrl: null,
  tokenUrl: null,
  handle: 'gateway',
} satisfies CatalogEntryInput;
