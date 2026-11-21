/**
 * The relay's rules (docs/decisions/ai-gateway.md AIG-09): the allow list, the headers either way, where a request goes
 * and the error shapes the CLIs read.
 */
import { aiGatewayRelayRoute } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  answeringAccount,
  relayErrorBody,
  relayRequestHeaders,
  relayResponseHeaders,
  upstreamUrl,
} from './relay-logic';

describe('the allow list (AIG-09)', () => {
  it('forwards only the provider’s own paths, answers api/hello itself, refuses the rest', () => {
    expect(aiGatewayRelayRoute('claude', 'v1/messages')).toBe('forward');
    expect(aiGatewayRelayRoute('claude', 'v1/messages/count_tokens')).toBe('forward');
    expect(aiGatewayRelayRoute('claude', '/v1/models/')).toBe('forward');
    expect(aiGatewayRelayRoute('claude', 'v1/messages?beta=true')).toBe('forward');
    expect(aiGatewayRelayRoute('claude', 'v1/responses')).toBe('refuse');
    expect(aiGatewayRelayRoute('codex', 'v1/responses')).toBe('forward');
    expect(aiGatewayRelayRoute('codex', 'v1/responses/compact')).toBe('forward');
    expect(aiGatewayRelayRoute('codex', 'v1/messages')).toBe('refuse');
    expect(aiGatewayRelayRoute('claude', 'api/hello')).toBe('hello');
    expect(aiGatewayRelayRoute('codex', 'v1/api/hello')).toBe('hello');
    expect(aiGatewayRelayRoute('claude', 'api/config/settings')).toBe('refuse');
    expect(aiGatewayRelayRoute('claude', 'v1/messages/../../api/accounts')).toBe('refuse');
  });
});

describe('headers (AIG-09)', () => {
  it('drops the agent token, hop-by-hop, forwarding and x-fusebox-* headers and sets the client key', () => {
    const out = relayRequestHeaders(
      {
        authorization: 'Bearer wat_secret',
        'x-api-key': 'wat_secret',
        connection: 'keep-alive, x-private',
        'x-private': 'listed in connection',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        host: 'whombat.local',
        'x-forwarded-for': '10.0.0.1',
        'x-fusebox-client-scope': 'spoofed',
        'x-fusebox-session-id': 'mine',
        cookie: 'whombat_session=1',
        'content-type': 'application/json',
        'content-length': '42',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'x,y',
        accept: 'text/event-stream',
      },
      'wbgw_client',
    );
    expect(out).toEqual({
      authorization: 'Bearer wbgw_client',
      'content-type': 'application/json',
      'content-length': '42',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'x,y',
      accept: 'text/event-stream',
    });
  });

  it('sends no key to an open Fusebox', () => {
    expect(relayRequestHeaders({ 'x-api-key': 'wat_1', accept: '*/*' }, null)).toEqual({ accept: '*/*' });
  });

  it('passes the answer’s headers on without hop-by-hop or x-fusebox-*, and reads the answering account', () => {
    const incoming = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'transfer-encoding': 'chunked',
      connection: 'keep-alive',
      'x-fusebox-account': 'claude-work.json',
      'request-id': 'req_1',
    };
    expect(relayResponseHeaders(incoming)).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'request-id': 'req_1',
    });
    expect(answeringAccount(incoming)).toBe('claude-work.json');
    expect(answeringAccount({})).toBeNull();
    // Fusebox's masked key label “fake-a…opic” in UTF-8, as Node hands the header over (Latin-1).
    expect(answeringAccount({ 'x-fusebox-account': Buffer.from('fake-a…opic').toString('latin1') })).toBe(
      'fake-a…opic',
    );
    expect(answeringAccount({ 'x-fusebox-account': 'caf\u00e9' })).toBe('caf\u00e9');
  });
});

describe('where a request goes', () => {
  it('is the base with the path below the provider and the query as sent', () => {
    expect(upstreamUrl('https://10.100.0.235:8317/', 'v1/messages', '?beta=true')).toBe(
      'https://10.100.0.235:8317/v1/messages?beta=true',
    );
    expect(upstreamUrl('https://llm.example.com/litellm', '/v1/responses', '')).toBe(
      'https://llm.example.com/litellm/v1/responses',
    );
  });
});

describe('error shapes the CLIs read', () => {
  it('Anthropic’s for Claude Code, OpenAI’s for Codex', () => {
    expect(relayErrorBody('claude', 502, 'Whombat couldn’t reach Fusebox.')).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'Whombat couldn’t reach Fusebox.' },
    });
    expect(relayErrorBody('claude', 401, 'no')).toMatchObject({ error: { type: 'authentication_error' } });
    expect(relayErrorBody('codex', 502, 'Whombat couldn’t reach Fusebox.')).toEqual({
      error: {
        message: 'Whombat couldn’t reach Fusebox.',
        type: 'server_error',
        code: 'bad_gateway',
        param: null,
      },
    });
    expect(relayErrorBody('codex', 401, 'no')).toMatchObject({ error: { code: 'invalid_api_key' } });
  });
});
