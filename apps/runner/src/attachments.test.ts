import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASIC_CAPABILITIES } from '@whombat/agent-runtime';
import type { AttachmentRef } from '@whombat/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchedAttachment, RunnerApi } from './api';
import { prepareTurnFiles } from './attachments';
import { FilesCache } from './files-cache';
import { testContext } from './test-context';

const root = mkdtempSync(join(tmpdir(), 'whombat-turn-files-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const bytes: Record<string, Buffer> = {
  att_imgaaaaaaaa: Buffer.from('not really a png, but bytes'),
  att_txtaaaaaaaa: Buffer.from('line one\nline two\n'),
  att_badaaaaaaaa: Buffer.from('tampered'),
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function ref(
  id: string,
  kind: AttachmentRef['kind'],
  contentType: string,
  claimed = bytes[id] as Buffer,
): AttachmentRef {
  return {
    id,
    name: `${id}.x`,
    contentType,
    size: claimed.length,
    kind,
    sha256: sha(claimed),
    messageId: 'jorisAsks',
    conversationId: 'cnv_billing-v2',
    width: kind === 'image' ? 10 : null,
    height: kind === 'image' ? 10 : null,
  };
}

const api = {
  async fetchAttachment(_dispatchId: string, attachmentId: string): Promise<FetchedAttachment> {
    const b = bytes[attachmentId] as Buffer;
    return {
      body: (async function* () {
        yield new Uint8Array(b);
      })(),
      size: b.length,
      sha256: sha(b),
    };
  },
} as Pick<RunnerApi, 'fetchAttachment'> as RunnerApi;

describe('turn files', () => {
  it('without images the provider gets no image files, only the honest line', async () => {
    const ctx = testContext({ attachments: [ref('att_imgaaaaaaaa', 'image', 'image/png')] });
    const files = await prepareTurnFiles(ctx, { api, workspacesRoot: root }, BASIC_CAPABILITIES);
    expect(files.attachments).toEqual([]);
    expect(files.section).toContain('you can’t open images here');
  });
});

describe('turn files from the cache by sha256 (turn-efficiency.md TE-09)', () => {
  it('fetches a file once across attempts and turns, and never keeps bytes that don’t match', async () => {
    const cache = new FilesCache({ root: join(root, '.files-cache') });
    let fetches = 0;
    const counting = {
      async fetchAttachment(dispatchId: string, attachmentId: string) {
        fetches++;
        return (api.fetchAttachment as (d: string, a: string) => Promise<FetchedAttachment>)(
          dispatchId,
          attachmentId,
        );
      },
    } as Pick<RunnerApi, 'fetchAttachment'> as RunnerApi;
    const caps = { ...BASIC_CAPABILITIES, images: true };
    const turn = (id: string, attachments: AttachmentRef[]) =>
      testContext({ attachments, dispatch: { ...testContext().dispatch, id } });
    const image = ref('att_imgaaaaaaaa', 'image', 'image/png');
    const first = await prepareTurnFiles(
      turn('dsp_one', [image]),
      { api: counting, workspacesRoot: root, filesCache: cache },
      caps,
    );
    expect(first.attachments).toHaveLength(1);
    expect(readFileSync(first.attachments[0]?.path as string, 'utf8')).toBe('not really a png, but bytes');
    await first.release();
    const second = await prepareTurnFiles(
      turn('dsp_two', [image]),
      { api: counting, workspacesRoot: root, filesCache: cache },
      caps,
    );
    expect(second.attachments).toHaveLength(1);
    expect(fetches).toBe(1);
    await second.release();
    // Bytes that don't match their sha256 are refused and never cached.
    const tampered = ref('att_badaaaaaaaa', 'image', 'image/png', Buffer.from('what was uploaded'));
    for (const id of ['dsp_three', 'dsp_four']) {
      const files = await prepareTurnFiles(
        turn(id, [tampered]),
        { api: counting, workspacesRoot: root, filesCache: cache },
        caps,
      );
      expect(files.attachments).toEqual([]);
      await files.release();
    }
    expect(fetches).toBe(3);
  });
});
