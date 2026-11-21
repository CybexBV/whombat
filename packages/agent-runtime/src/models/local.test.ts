/** A model on the person's network (HE-32, HE-S55): the base URL Hermes gets, and the check the person sees. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkLocalModel, localModelBaseUrl } from './local';

describe('a model on the network', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/v1/models')
        return res.end(JSON.stringify({ data: [{ id: 'qwen3:32b' }, { id: 'llama3.3' }] }));
      if (req.url === '/ollama/models') return res.end(JSON.stringify({ models: [{ name: 'gemma3' }] }));
      if (req.url === '/locked/models') return res.writeHead(401).end();
      res.writeHead(404).end('no');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('takes an http(s) base URL without credentials or a query', () => {
    expect(localModelBaseUrl(' http://192.168.1.20:11434/v1/ ')).toBe('http://192.168.1.20:11434/v1');
    for (const bad of ['ftp://x/v1', 'http://u:p@x/v1', 'http://x/v1?a=1', 'not a url'])
      expect(localModelBaseUrl(bad), bad).toBeNull();
  });

  it('lists what it serves, or says why not', async () => {
    expect(await checkLocalModel(`${base}/v1`)).toEqual({ ok: true, models: ['qwen3:32b', 'llama3.3'] });
    expect(await checkLocalModel(`${base}/ollama`)).toEqual({ ok: true, models: ['gemma3'] });
    expect(await checkLocalModel(`${base}/locked`)).toEqual({ ok: false, reason: 'refused' });
    expect(await checkLocalModel(`${base}/nothing`)).toEqual({ ok: false, reason: 'not_openai' });
    expect(await checkLocalModel('http://127.0.0.1:1/v1', { timeoutMs: 500 })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
    expect(await checkLocalModel('ftp://x')).toEqual({ ok: false, reason: 'bad_url' });
  });
});
