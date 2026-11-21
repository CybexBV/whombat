import { describe, expect, it } from 'vitest';
import { createClient } from './http/client';
import { createFakeAppliance } from './session/fake';
import { createSecureSession } from './session/secure';
import { fakeClient } from './test/session';
import {
  anyUploading,
  readyAttachmentIds,
  UploadError,
  type UploadItem,
  uploadErrorText,
  uploadFile,
  uploadStatusText,
  uploadsReducer,
} from './uploads';

const attachment = {
  id: 'att_abcdefghijkl',
  name: 'shot.png',
  contentType: 'image/png',
  size: 2048,
  url: '/api/v1/burrows/b/attachments/att_abcdefghijkl',
  kind: 'image' as const,
  width: 10,
  height: 10,
};

describe('the upload state machine', () => {
  it('goes uploading → progress → ready, or failed → retry, and can be removed', () => {
    let items: UploadItem[] = [];
    items = uploadsReducer(items, {
      type: 'add',
      item: { localId: 'l1', name: 'shot.png', size: 2048, mediaType: 'image/png' },
    });
    items = uploadsReducer(items, {
      type: 'add',
      item: { localId: 'l2', name: 'b.log', size: 10, mediaType: '' },
    });
    expect(anyUploading(items)).toBe(true);
    items = uploadsReducer(items, { type: 'progress', localId: 'l1', progress: 0.42 });
    expect(uploadStatusText(items[0] as UploadItem)).toBe('Uploading 42%');
    items = uploadsReducer(items, { type: 'ready', localId: 'l1', attachment });
    items = uploadsReducer(items, { type: 'failed', localId: 'l2', error: 'That file is too big.' });
    expect(anyUploading(items)).toBe(false);
    expect(readyAttachmentIds(items)).toEqual([attachment.id]);
    expect(uploadStatusText(items[0] as UploadItem)).toBe('2 KB');
    expect(uploadStatusText(items[1] as UploadItem)).toBe('That file is too big.');
    // Progress after it settled is ignored.
    expect(uploadsReducer(items, { type: 'progress', localId: 'l1', progress: 0.1 })[0]?.progress).toBe(1);
    items = uploadsReducer(items, { type: 'retry', localId: 'l2' });
    expect(items[1]).toMatchObject({ state: 'uploading', progress: 0, error: null });
    items = uploadsReducer(items, { type: 'remove', localId: 'l2' });
    expect(items.map((i) => i.localId)).toEqual(['l1']);
    expect(uploadsReducer(items, { type: 'clear' })).toEqual([]);
  });
});

const file = { name: 'shot.png', type: 'image/png', size: 3, body: new Blob(['abc']) };

describe('uploadFile', () => {
  it('surfaces the Whombat’s words for a refusal', async () => {
    const refusing = fakeClient(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'bad_request', message: 'That image is damaged, or isn’t an image we can show.' },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      { validateResponses: false },
    );
    const refused = uploadFile(refusing, { burrow: 'b', conversationId: 'cnv_general', file });
    await expect(refused).rejects.toThrow('That image is damaged');
    expect(uploadErrorText(new UploadError('x', 500))).toBe('x');
  });

  it('cancelling while the reservation is on its way is a cancel, not a failure (AP-576)', async () => {
    const appliance = createFakeAppliance({
      handle: async () => ({ status: 201, body: { attachment, uploadUrl: '', method: 'PUT', headers: {} } }),
    });
    appliance.faults.slowAccept(100);
    const session = createSecureSession({ connector: appliance.connector });
    try {
      const controller = new AbortController();
      const upload = uploadFile(createClient({ session, validateResponses: false }), {
        burrow: 'b',
        conversationId: 'cnv_general',
        file,
        signal: controller.signal,
      });
      // The reservation was sent and accepted: the session reports it as an unknown outcome, the upload as cancelled.
      const accepted = new Promise<void>((resolve) => {
        const tick = () => (appliance.stats().attempts.length ? resolve() : setTimeout(tick, 2));
        tick();
      });
      await accepted;
      controller.abort();
      const err = await upload.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UploadError);
      expect((err as UploadError).cancelled).toBe(true);
    } finally {
      session.close();
    }
  });
});
