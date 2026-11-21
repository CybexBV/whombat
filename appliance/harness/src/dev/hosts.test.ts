import { afterEach, describe, expect, it } from 'vitest';
import { paths } from '../lib/paths.ts';
import { HOSTS_AGENT_ARCHS, hostsArgs, hostsPaths } from './services.ts';

describe('the hosts service in the dev environment (NX-155)', () => {
  const host = process.env.WB_MGD_HOSTS_AGENT_HOST;
  afterEach(() => {
    if (host === undefined) delete process.env.WB_MGD_HOSTS_AGENT_HOST;
    else process.env.WB_MGD_HOSTS_AGENT_HOST = host;
  });

  it('runs the hub as a box does (hosts.nix), with the environment’s paths and port', () => {
    delete process.env.WB_MGD_HOSTS_AGENT_HOST;
    const p = hostsPaths();
    expect(p.socket.startsWith(paths.run)).toBe(true);
    expect(p.tokenFile.startsWith(p.data)).toBe(true);
    expect(hostsArgs('/bin/agents', 4743)).toEqual([
      'serve',
      '--headless',
      '--data',
      p.data,
      '--listen',
      `unix:${p.socket}`,
      '--agent-listen',
      ':4743',
      '--agent-url',
      'auto',
      '--agent-dist',
      '/bin/agents',
      '--service-token-file',
      p.tokenFile,
    ]);
    expect(HOSTS_AGENT_ARCHS).toEqual(['amd64', 'arm64']);
  });

  it('binds the agents’ listener to one address when asked', () => {
    process.env.WB_MGD_HOSTS_AGENT_HOST = '127.0.0.1';
    expect(hostsArgs('/d', 4643)).toContain('127.0.0.1:4643');
    process.env.WB_MGD_HOSTS_AGENT_HOST = '::1';
    expect(hostsArgs('/d', 4643)).toContain('[::1]:4643');
  });
});
