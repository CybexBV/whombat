import { describe, expect, it, vi } from 'vitest';
import type { Component } from '../manifest/pins.ts';
import type { SourceState } from './env.ts';
import { sourcePreparation } from './sources.ts';

const component = (id: string, commit = 'a'.repeat(40), source = '/repo/Whombat') =>
  ({ id, source, commit }) as Component;
const options =
  (live: string[] = []) =>
  (id: string) => ({
    live: live.includes(id),
    lockfileDrift: false,
    log: () => {},
  });
const sourceOf = (c: Component, live = false): SourceState => ({
  id: c.id,
  path: `/copies/${c.id}@${c.commit.slice(0, 12)}`,
  commit: c.commit,
  mode: live ? 'live' : 'pinned',
  dirty: false,
});
const pins = (app = component('app'), runtime = component('runtime')) =>
  new Map([
    ['app', app],
    ['runtime', runtime],
  ]);

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('preparing sources during startup', () => {
  it('shares a pending clone and install for the app and runtime, preserving both component identities', async () => {
    const clone = deferred<SourceState>();
    const install = deferred<void>();
    const resolve = vi.fn(() => clone.promise);
    const installed: SourceState[] = [];
    const prepare = vi.fn(async (src: SourceState) => {
      installed.push(src);
      await install.promise;
      src.lockfileDrift = true;
    });
    const prep = sourcePreparation(pins(), options(), { resolve, install: prepare });
    const app = prep.source('app');
    const runtime = prep.source('runtime');
    expect(resolve).toHaveBeenCalledTimes(1);
    clone.resolve(sourceOf(component('app')));
    const [a, r] = await Promise.all([app, runtime]);
    expect(a.id).toBe('app');
    expect(r.id).toBe('runtime');
    expect(r.path).toBe(a.path);
    expect(await prep.source('runtime')).toBe(r);
    const ai = prep.install(a);
    const ri = prep.install(r);
    expect(prepare).toHaveBeenCalledTimes(1);
    install.resolve();
    await Promise.all([ai, ri]);
    expect(a.lockfileDrift).toBe(true);
    expect(r.lockfileDrift).toBe(true);
    expect(installed).toHaveLength(1);
  });

  it.each([
    [component('runtime', 'b'.repeat(40)), []],
    [component('runtime', 'a'.repeat(40), '/repo/other'), []],
    [component('runtime'), ['runtime']],
    [component('runtime'), ['app', 'runtime']],
  ])('keeps different revisions, repositories and live components separate', async (runtime, live) => {
    const resolve = vi.fn(async (c: Component, p: { live: boolean }) => sourceOf(c, p.live));
    const prep = sourcePreparation(pins(component('app'), runtime), options(live), {
      resolve,
      install: vi.fn(async () => {}),
    });
    const [a, r] = await Promise.all([prep.source('app'), prep.source('runtime')]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(a.path).not.toBe(r.path);
  });

  it('reports a shared clone failure to every waiting component', async () => {
    const failure = new Error('clone failed');
    const resolve = vi.fn(async () => {
      throw failure;
    });
    const prep = sourcePreparation(pins(), options(), { resolve, install: vi.fn(async () => {}) });
    const results = await Promise.allSettled([prep.source('app'), prep.source('runtime')]);
    expect(resolve).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result).toEqual({ status: 'rejected', reason: failure });
  });

  it('never marks a failed install ready or runs a competing install', async () => {
    const failure = new Error('install failed');
    const install = vi.fn(async () => {
      throw failure;
    });
    const prep = sourcePreparation(pins(), options(), {
      resolve: async (c) => sourceOf(c),
      install,
    });
    const [a, r] = await Promise.all([prep.source('app'), prep.source('runtime')]);
    const results = await Promise.allSettled([prep.install(a), prep.install(r)]);
    expect(install).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result).toEqual({ status: 'rejected', reason: failure });
    expect(a.lockfileDrift).toBeUndefined();
    expect(r.lockfileDrift).toBeUndefined();
  });
});

describe('components that are folders of one repository', () => {
  it('share the clone and each get their own folder of it', async () => {
    const { mkdirSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const clone = mkdtempSync(join(tmpdir(), 'cloud-clone-'));
    mkdirSync(join(clone, 'control'));
    mkdirSync(join(clone, 'relay'));
    const cloud = (id: string, dir: string) => ({
      ...component(id, 'c'.repeat(40), '/repo/whombat-cloud'),
      dir,
    });
    const resolve = vi.fn(async (c: Component) => ({ ...sourceOf(c), path: clone }));
    const prepared = sourcePreparation(
      new Map([
        ['whombat-api', cloud('whombat-api', 'control')],
        ['whombat-relay', cloud('whombat-relay', 'relay')],
        // A commit from before the move: no such folder in its clone, so the clone is the component.
        ['old', { ...component('old', 'd'.repeat(40), '/repo/whombat-cloud'), dir: 'gone' }],
      ]),
      options(),
      { resolve, install: vi.fn(async () => {}) },
    );
    const [control, relay, old] = await Promise.all(
      ['whombat-api', 'whombat-relay', 'old'].map((id) => prepared.source(id)),
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(control).toMatchObject({ id: 'whombat-api', path: join(clone, 'control') });
    expect(relay).toMatchObject({ id: 'whombat-relay', path: join(clone, 'relay') });
    expect(old).toMatchObject({ id: 'old', path: clone });
  });
});
