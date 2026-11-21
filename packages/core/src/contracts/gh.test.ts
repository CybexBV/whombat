import { describe, expect, it } from 'vitest';
import { runnerApi } from './index.js';
import {
  DispatchContext,
  GH_ARGS_MAX,
  GhAuthorizeBody,
  GhAuthorizeReply,
  GhDispatchContext,
} from './runner.js';

describe('gh through Whombat (contracts 0.41.0, Whombat agent-gh.md)', () => {
  it('reads the gh dispatch context; null means no gh', () => {
    expect(GhDispatchContext.parse({ repos: ['acme/web'], defaultRepo: 'acme/web' })).toEqual({
      repos: ['acme/web'],
      defaultRepo: 'acme/web',
    });
    expect(DispatchContext.shape.gh.safeParse(undefined).success).toBe(false);
    expect(DispatchContext.shape.gh.safeParse(null).success).toBe(true);
    expect(GhDispatchContext.safeParse({ repos: ['acme/web'] }).success).toBe(false);
  });

  it('bounds a command and defaults its files and stdin', () => {
    const body = GhAuthorizeBody.parse({ runnerId: 'rnr_1', attempt: 1, args: ['pr', 'view', '12'] });
    expect(body).toMatchObject({ files: [], stdin: null });
    expect(GhAuthorizeBody.safeParse({ args: Array(GH_ARGS_MAX + 1).fill('x') }).success).toBe(false);
    expect(
      GhAuthorizeBody.safeParse({ args: ['x'], files: Array(9).fill({ path: 'a', base64: '' }) }).success,
    ).toBe(false);
  });

  it('answers run or done', () => {
    expect(
      GhAuthorizeReply.parse({
        outcome: 'run',
        args: ['issue', 'view', '3'],
        repo: 'acme/web',
        token: 'gho_x',
        expiresAt: '2026-10-03T12:00:00.000Z',
      }).outcome,
    ).toBe('run');
    expect(
      GhAuthorizeReply.parse({ outcome: 'done', exitCode: 126, stdout: '', stderr: 'No.' }).outcome,
    ).toBe('done');
    expect(
      GhAuthorizeReply.safeParse({ outcome: 'done', exitCode: 256, stdout: '', stderr: '' }).success,
    ).toBe(false);
  });

  it('is a runner endpoint under the dispatch', () => {
    expect(runnerApi.ghAuthorize).toMatchObject({
      id: 'runner.ghAuthorize',
      method: 'POST',
      path: '/dispatches/:dispatchId/gh',
      auth: 'runner',
    });
  });
});
