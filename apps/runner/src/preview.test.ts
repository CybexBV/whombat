import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_PREVIEW_MAX_FILES } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  type PreviewFolder,
  previewPath,
  previewSourceOf,
  readPreviewFolder,
  WORK_FOLDER_ALIASES,
} from './preview';

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'wb-preview-'));
  const cwd = join(root, 'checkout');
  mkdirSync(join(cwd, 'dist', 'assets'), { recursive: true });
  mkdirSync(join(cwd, 'dist', '.git'));
  writeFileSync(join(cwd, 'dist', 'index.html'), '<h1>Home</h1>');
  writeFileSync(join(cwd, 'dist', 'assets', 'site.css'), 'h1{}');
  writeFileSync(join(cwd, 'dist', '.git', 'config'), 'secret');
  writeFileSync(join(root, 'outside.txt'), 'not yours');
  symlinkSync(join(root, 'outside.txt'), join(cwd, 'dist', 'leak.txt'));
  symlinkSync(root, join(cwd, 'up'));
  return cwd;
}

const paths = (got: PreviewFolder) => ('files' in got ? got.files.map((f) => f.path) : got);

describe('the folder a browser_preview asks for (BT-48)', () => {
  it('reads the files inside, never .git or a symlink', async () => {
    const got = await readPreviewFolder(checkout(), 'dist');
    expect('files' in got && got.files.map((f) => f.path)).toEqual(['assets/site.css', 'index.html']);
    expect('files' in got && Buffer.from(got.files[1]?.data ?? '', 'base64').toString()).toBe(
      '<h1>Home</h1>',
    );
  });

  it('refuses a folder outside the working directory, by .., by path or by a symlink', async () => {
    const cwd = checkout();
    expect(await readPreviewFolder(cwd, '../')).toMatchObject({
      error: expect.stringContaining('without “..”'),
    });
    expect(await readPreviewFolder(cwd, '/etc')).toMatchObject({
      error: expect.stringContaining('relative'),
    });
    expect(await readPreviewFolder(cwd, 'up')).toMatchObject({ error: expect.stringContaining('outside') });
    expect(await readPreviewFolder(cwd, 'missing')).toMatchObject({
      error: expect.stringContaining('no folder'),
    });
    expect(await readPreviewFolder(cwd, 'dist/index.html')).toMatchObject({
      error: expect.stringContaining('not a folder'),
    });
  });
});

describe('where a turn’s folders are read from (resourceful-agents.md RA-DS70)', () => {
  const cwd = '/srv/whombat/workspaces/x';
  it('a checkout, or the agent’s work folder in any turn without a checkout', () => {
    expect(previewSourceOf({ cwd, git: {} })).toEqual({ root: cwd, where: 'your checkout' });
    // A read-only checkout (an automation's reviewer) is an export, still the turn's checkout.
    expect(previewSourceOf({ cwd, git: {}, workFolder: false })?.where).toBe('your checkout');
    expect(previewSourceOf({ cwd, git: null, workFolder: true })).toEqual({
      root: cwd,
      where: 'your work folder (~/work, where your shell starts)',
      aliases: WORK_FOLDER_ALIASES,
    });
  });

  it('nothing for a turn without a folder of its own: a chat turn’s empty folder', () => {
    expect(previewSourceOf({ cwd, git: null })).toBeNull();
    expect(previewSourceOf(null)).toBeNull();
  });

  it('~/work and the folder’s own path name places inside it; the rest of the home doesn’t', () => {
    const work = previewSourceOf({ cwd, git: null, workFolder: true });
    if (!work) throw new Error('no source');
    expect(previewPath(work, 'site/dist')).toEqual({ rel: 'site/dist' });
    expect(previewPath(work, '~/work/site/dist/')).toEqual({ rel: 'site/dist' });
    expect(previewPath(work, `${cwd}/site/dist`)).toEqual({ rel: 'site/dist' });
    expect(previewPath(work, '~/work')).toEqual({ rel: '.' });
    expect(previewPath(work, '/home/agent/site/dist')).toMatchObject({
      error: expect.stringContaining('Only your work folder (~/work, where your shell starts) is read'),
    });
    expect(previewPath(work, '~/site')).toMatchObject({
      error: expect.stringContaining('Only your work folder'),
    });
    expect(previewPath(work, '~/work/../.ssh')).toMatchObject({
      error: expect.stringContaining('without “..”'),
    });
    // A checkout has no ~/work.
    expect(previewPath({ root: cwd, where: 'your checkout' }, '~/work/dist')).toMatchObject({
      error: expect.stringContaining('Only your checkout is read'),
    });
  });

  it('reads the work folder by any of its names, and says where it looked', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-work-')));
    const work = join(root, 'work');
    mkdirSync(join(work, 'site', 'dist'), { recursive: true });
    writeFileSync(join(work, 'site', 'dist', 'index.html'), '<h1>Live</h1>');
    const source = previewSourceOf({ cwd: work, git: null, workFolder: true });
    if (!source) throw new Error('no source');
    for (const dir of ['site/dist', '~/work/site/dist', `${work}/site/dist`])
      expect(paths(await readPreviewFolder(source, dir))).toEqual(['index.html']);
    expect(await readPreviewFolder(source, 'dist')).toMatchObject({
      error: expect.stringContaining(
        'There is no folder dist in your work folder (~/work, where your shell starts)',
      ),
    });
  });
});

describe('an automation step’s own folder, besides the checkout (RN-R2)', () => {
  /** A checkout and a step folder in the agent's work folder, as the runner lays them out. */
  const layout = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-step-preview-')));
    const cwd = join(root, 'acme', 'repo', 'feat--x');
    mkdirSync(join(cwd, 'dist'), { recursive: true });
    writeFileSync(join(cwd, 'dist', 'index.html'), '<h1>Checkout</h1>');
    const work = join(root, 'agent', 'home', 'work');
    const step = join(work, '.automation', 'dsp_fix');
    mkdirSync(join(step, 'site', 'dist', '.git'), { recursive: true });
    writeFileSync(join(step, 'site', 'dist', 'index.html'), '<h1>Step</h1>');
    writeFileSync(join(step, 'site', 'dist', '.git', 'config'), 'secret');
    mkdirSync(join(root, 'secrets', 'dsp_fix', 'site', 'dist'), { recursive: true });
    writeFileSync(join(root, 'secrets', 'dsp_fix', 'site', 'dist', 'index.html'), 'a person’s sign-in');
    return { root, cwd, work, step };
  };
  const words = (step: string) => `this step’s own folder (${step})`;

  it('is read besides a checkout, writable or read-only; in a turn without one it is in the work folder already', () => {
    const cwd = '/srv/ws/acme/repo/feat--x';
    const work = '/srv/whombat/agent/home/work';
    const stepFolder = `${work}/.automation/dsp_fix`;
    const step = {
      root: stepFolder,
      where: words(stepFolder),
      aliases: ['~/work/.automation/dsp_fix'],
      anchor: work,
    };
    expect(previewSourceOf({ cwd, git: {}, stepFolder })).toEqual({
      root: cwd,
      where: 'your checkout',
      step,
    });
    expect(previewSourceOf({ cwd: work, git: null, workFolder: true, stepFolder })).toEqual({
      root: work,
      where: 'your work folder (~/work, where your shell starts)',
      aliases: WORK_FOLDER_ALIASES,
    });
    expect(previewSourceOf({ cwd, git: null, stepFolder })).toEqual(step);
  });

  it('reads a folder named by its full path there; any other path is the checkout’s', async () => {
    const { cwd, step } = layout();
    const source = previewSourceOf({ cwd, git: {}, stepFolder: step });
    if (!source) throw new Error('no source');
    for (const dir of [`${step}/site/dist`, '~/work/.automation/dsp_fix/site/dist/']) {
      const got = await readPreviewFolder(source, dir);
      expect(paths(got)).toEqual(['index.html']);
      expect('files' in got && Buffer.from(got.files[0]?.data ?? '', 'base64').toString()).toBe(
        '<h1>Step</h1>',
      );
    }
    const checkout = await readPreviewFolder(source, 'dist');
    expect('files' in checkout && Buffer.from(checkout.files[0]?.data ?? '', 'base64').toString()).toBe(
      '<h1>Checkout</h1>',
    );
    expect(await readPreviewFolder(source, '/etc')).toEqual({
      error: `Only your checkout and ${words(step)} are read: give a folder of your checkout relative to it (like dist or site/dist), or one in this step’s folder by its full path.`,
    });
    expect(await readPreviewFolder(source, `${step}/build`)).toEqual({
      error: `There is no folder ${step}/build in ${words(step)}: give its full path (like ${step}/site/dist), or build it first, then preview it.`,
    });
    expect(await readPreviewFolder(source, `${step}/../../x`)).toMatchObject({
      error: expect.stringContaining('without “..”'),
    });
    // The checkout's own refusal still names its words.
    expect(await readPreviewFolder(source, 'site/dist')).toMatchObject({
      error: expect.stringContaining('There is no folder site/dist in your checkout'),
    });
  });

  it('never follows a link a command put in place of the step’s folders, before or while it reads', async () => {
    const { root, cwd, work, step } = layout();
    const source = previewSourceOf({ cwd, git: {}, stepFolder: step });
    if (!source) throw new Error('no source');
    const swap = () => {
      renameSync(join(work, '.automation'), join(work, '.automation-old'));
      symlinkSync(join(root, 'secrets'), join(work, '.automation'));
    };
    const unswap = () => {
      rmSync(join(work, '.automation'));
      renameSync(join(work, '.automation-old'), join(work, '.automation'));
    };
    swap();
    expect(await readPreviewFolder(source, `${step}/site/dist`)).toEqual({
      error: `${step}/site/dist leads outside ${words(step)}.`,
    });
    unswap();
    const raced = await readPreviewFolder(source, `${step}/site/dist`, {
      beforeOpen: (name) => {
        if (name === '.automation') swap();
      },
    });
    expect(raced).toEqual({ error: `${step}/site/dist leads outside ${words(step)}.` });
  });
});

describe('the caps and a folder that changes while it is read (RA-DS71)', () => {
  const work = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-race-')));
    const cwd = join(root, 'work');
    mkdirSync(join(cwd, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(cwd, 'dist', 'index.html'), '<h1>x</h1>');
    writeFileSync(join(cwd, 'dist', 'assets', 'a.css'), 'a{}');
    mkdirSync(join(root, 'secrets'));
    writeFileSync(join(root, 'secrets', 'a.css'), 'a person’s sign-in');
    writeFileSync(join(root, 'secrets', 'index.html'), 'a person’s sign-in');
    return { root, cwd };
  };

  it('a folder swapped for a link after it was listed is skipped, never followed', async () => {
    const { root, cwd } = work();
    const got = await readPreviewFolder(cwd, 'dist', {
      beforeOpen: (name) => {
        if (name !== 'assets') return;
        renameSync(join(cwd, 'dist', 'assets'), join(cwd, 'assets-old'));
        symlinkSync(join(root, 'secrets'), join(cwd, 'dist', 'assets'));
      },
    });
    expect(paths(got)).toEqual(['index.html']);
  });

  it('a file swapped for a link or a pipe is skipped; the folder itself swapped leads nowhere', async () => {
    const { root, cwd } = work();
    const got = await readPreviewFolder(cwd, 'dist', {
      beforeOpen: (name) => {
        if (name === 'index.html') {
          rmSync(join(cwd, 'dist', 'index.html'));
          symlinkSync(join(root, 'secrets', 'index.html'), join(cwd, 'dist', 'index.html'));
        }
        if (name === 'a.css') {
          rmSync(join(cwd, 'dist', 'assets', 'a.css'));
          execFileSync('mkfifo', [join(cwd, 'dist', 'assets', 'a.css')]);
        }
      },
    });
    expect(got).toEqual({ error: 'dist is empty. Build first, then preview the built folder.' });
    const swapped = await readPreviewFolder(cwd, 'dist', {
      beforeOpen: (name) => {
        if (name !== 'dist') return;
        renameSync(join(cwd, 'dist'), join(cwd, 'dist-old'));
        symlinkSync(join(root, 'secrets'), join(cwd, 'dist'));
      },
    });
    expect(swapped).toEqual({ error: 'dist leads outside your working directory.' });
  });

  it('at most 2 000 files and 50 MB', async () => {
    const { cwd } = work();
    mkdirSync(join(cwd, 'many'));
    for (let i = 0; i <= BROWSER_PREVIEW_MAX_FILES; i++) writeFileSync(join(cwd, 'many', `f${i}.txt`), 'x');
    expect(await readPreviewFolder(cwd, 'many')).toEqual({
      error: 'many has more than 2000 files: preview the built folder only.',
    });
    mkdirSync(join(cwd, 'big'));
    writeFileSync(join(cwd, 'big', 'video.mp4'), '');
    truncateSync(join(cwd, 'big', 'video.mp4'), 51 * 1024 * 1024);
    expect(await readPreviewFolder(cwd, 'big')).toEqual({
      error: 'big is larger than 50 MB: preview the built folder only.',
    });
  });
});
