/**
 * Tests only: one in-process HTTP server that plays every service the connect side talks to, by host name (tests
 * resolve `*.home.test` to 192.168.77.x and dial 127.0.0.1): Home Assistant (`ha.`: `/api/`, `/api/mcp`, `/auth/token`,
 * `/auth/revoke`), an MCP server with MCP authorization (`mcp.`: a 401 challenge, protected-resource and
 * authorization-server metadata, dynamic registration, the token endpoint), a Nextcloud (`cloud.`: Login Flow v2 and
 * WebDAV) and a plain API (`api.`). Every request is kept; knobs switch answers.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { answerMcp, type McpToolSpec } from './tool-stubs';

/** Home Assistant's MCP server (the Model Context Protocol Server integration): one read tool, one write tool. */
const HA_MCP_TOOLS: McpToolSpec[] = [
  {
    name: 'list_things',
    description: 'list_things on the stub',
    annotations: { readOnlyHint: true },
    answer: () => 'Kitchen light: on.',
  },
  {
    name: 'change_thing',
    description: 'change_thing on the stub',
    answer: (a) => `Changed ${String(a.name)}.`,
  },
];

/** A remote MCP server's one read tool. */
const FILES_MCP_TOOLS: McpToolSpec[] = [
  {
    name: 'search',
    description: 'Searches files.',
    annotations: { readOnlyHint: true },
    answer: () => 'Nothing found.',
  },
];

export interface SeenRequest {
  host: string;
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface Stubs {
  port: number;
  requests: SeenRequest[];
  knobs: {
    haToken: string;
    haRefresh: string;
    /** The MCP server's token endpoint refuses refreshes with `invalid_grant`. */
    haRefreshDead: boolean;
    mcpAccess: string;
    mcpIssParameter: boolean;
    /** Polls of the Nextcloud flow that answer 404 before the app password. */
    ncPendingPolls: number;
    apiToken: string;
  };
  url(host: string, path?: string): string;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export async function startStubs(): Promise<Stubs> {
  const requests: SeenRequest[] = [];
  const knobs: Stubs['knobs'] = {
    haToken: 'ha-good-token',
    haRefresh: 'ha-refresh-1',
    haRefreshDead: false,
    mcpAccess: 'mcp-access-1',
    mcpIssParameter: true,
    ncPendingPolls: 1,
    apiToken: 'api-good-token',
  };
  let port = 0;
  let accessN = 0;
  const base = (host: string) => `http://${host}:${port}`;
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    requests.push({ host, method: req.method ?? 'GET', path, headers: req.headers, body });
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    const form = new URLSearchParams(body);
    const auth = req.headers.authorization ?? '';
    if (host === 'ha.home.test') {
      if (path === '/api/mcp' && req.method === 'POST') {
        if (auth !== `Bearer ${knobs.haToken}`) return json(401, {});
        return answerMcp(req, res, body, HA_MCP_TOOLS);
      }
      if (path === '/api/' && req.method === 'GET')
        return auth === `Bearer ${knobs.haToken}` ? json(200, { message: 'API running.' }) : json(401, {});
      if (path === '/auth/token' && req.method === 'POST') {
        if (
          form.get('grant_type') === 'authorization_code' &&
          form.get('code') === 'ha-code' &&
          form.get('client_id')
        ) {
          accessN++;
          knobs.haToken = `ha-access-${accessN}`;
          return json(200, {
            access_token: knobs.haToken,
            refresh_token: knobs.haRefresh,
            expires_in: 1800,
            token_type: 'Bearer',
          });
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (knobs.haRefreshDead || form.get('refresh_token') !== knobs.haRefresh)
            return json(400, { error: 'invalid_grant' });
          accessN++;
          knobs.haToken = `ha-access-${accessN}`;
          return json(200, { access_token: knobs.haToken, expires_in: 1800, token_type: 'Bearer' });
        }
        return json(400, { error: 'invalid_request' });
      }
      if (path === '/auth/revoke') return json(200, {});
      return json(404, {});
    }
    if (host === 'mcp.home.test') {
      const issuer = base('mcp.home.test');
      if (path === '/mcp' && req.method === 'POST') {
        if (auth !== `Bearer ${knobs.mcpAccess}`)
          return json(
            401,
            { error: 'unauthorized' },
            {
              'www-authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="files:read"`,
            },
          );
        return answerMcp(req, res, body, FILES_MCP_TOOLS, 'Stub MCP');
      }
      if (path === '/.well-known/oauth-protected-resource/mcp')
        return json(200, {
          resource: `${issuer}/mcp`,
          authorization_servers: [issuer],
          scopes_supported: ['files:read'],
        });
      if (path === '/.well-known/oauth-authorization-server')
        return json(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          revocation_endpoint: `${issuer}/revoke`,
          code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: knobs.mcpIssParameter,
        });
      if (path === '/register' && req.method === 'POST') return json(201, { client_id: 'dcr-client-1' });
      if (path === '/token' && req.method === 'POST') {
        if (
          form.get('grant_type') === 'authorization_code' &&
          form.get('code') === 'mcp-code' &&
          form.get('client_id') === 'dcr-client-1' &&
          form.get('code_verifier') &&
          form.get('resource') === `${issuer}/mcp`
        )
          return json(200, {
            access_token: knobs.mcpAccess,
            refresh_token: 'mcp-refresh-1',
            expires_in: 3600,
          });
        return json(400, { error: 'invalid_grant' });
      }
      if (path === '/revoke') return json(200, {});
      return json(404, {});
    }
    if (host === 'open.home.test' && path === '/mcp' && req.method === 'POST')
      return answerMcp(req, res, body, FILES_MCP_TOOLS, 'Open MCP');
    if (host === 'cloud.home.test') {
      const cloud = base('cloud.home.test');
      if (path === '/index.php/login/v2' && req.method === 'POST')
        return json(200, {
          poll: { token: 'poll-token-1', endpoint: `${cloud}/index.php/login/v2/poll` },
          login: `${cloud}/login/v2/flow/abc`,
        });
      if (path === '/index.php/login/v2/poll' && req.method === 'POST') {
        if (form.get('token') !== 'poll-token-1') return json(404, []);
        if (knobs.ncPendingPolls > 0) {
          knobs.ncPendingPolls--;
          return json(404, []);
        }
        return json(200, { server: cloud, loginName: 'mara', appPassword: 'nc-app-password-1' });
      }
      // The check (connection-signin.md SG-15a): who the app password signs in as; the user id isn't the login name.
      if (path === '/ocs/v2.php/cloud/user' && req.method === 'GET') {
        const ok = auth === `Basic ${Buffer.from('mara:nc-app-password-1').toString('base64')}`;
        return ok
          ? json(200, { ocs: { meta: { status: 'ok' }, data: { id: 'mara-uid', displayname: 'Mara' } } })
          : json(401, { ocs: { meta: { status: 'failure', statuscode: 997 }, data: [] } });
      }
      if (path === '/remote.php/dav/files/mara/' && req.method === 'PROPFIND') {
        const ok = auth === `Basic ${Buffer.from('mara:nc-app-password-1').toString('base64')}`;
        res.writeHead(ok ? 207 : 401, { 'content-type': 'application/xml' });
        return res.end('<d:multistatus xmlns:d="DAV:"/>');
      }
      return json(404, {});
    }
    if (host === 'ps5.home.test' && path === '/list_payloads' && req.method === 'GET')
      return json(200, { self: { running_version: '0.6.3', pending_version: '' }, items: [] });
    if (host === 'api.home.test') {
      if (auth !== `Bearer ${knobs.apiToken}`) return json(401, {});
      return json(404, { detail: 'no root' });
    }
    return json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    knobs,
    url: (host, path = '') => `${base(host)}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
