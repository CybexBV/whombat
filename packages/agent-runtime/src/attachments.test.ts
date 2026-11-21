import { type AttachmentRef, DispatchContext } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS, needsBytes, planAttachments } from './attachments';
import { BASIC_CAPABILITIES } from './contract';
import { base } from './testing/contexts';

const sha = 'a'.repeat(64);
const ref = (id: string, kind: AttachmentRef['kind'], extra: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id,
  name: `${id}.bin`,
  contentType:
    kind === 'image'
      ? 'image/png'
      : kind === 'document'
        ? 'application/pdf'
        : kind === 'text'
          ? 'text/plain'
          : 'application/zip',
  size: 1000,
  kind,
  sha256: sha,
  messageId: 'msg_m7',
  conversationId: 'cnv_billing-v2',
  width: kind === 'image' ? 100 : null,
  height: kind === 'image' ? 80 : null,
  ...extra,
});

const withFiles = (attachments: AttachmentRef[]) => DispatchContext.parse(base({ attachments }));
const claudeCaps = { ...BASIC_CAPABILITIES, images: true, documents: true };
const _codexCaps = { ...BASIC_CAPABILITIES, images: true };

describe('planning attachments by capability', () => {
  it('bounds count and size, keeping the triggering message’s files first', () => {
    const old = Array.from({ length: 9 }, (_, i) => ref(`att_old${i}`, 'image', { messageId: 'msg_m1' }));
    const ctx = withFiles([...old, ref('att_new', 'image'), ref('att_huge', 'image', { size: 5_000_000 })]);
    const plan = planAttachments(ctx, claudeCaps);
    expect(plan.slice(0, 2).map((p) => [p.ref.id, p.delivery.mode])).toEqual([
      ['att_new', 'image'],
      ['att_huge', 'note'],
    ]);
    expect(plan.filter((p) => p.delivery.mode === 'image')).toHaveLength(ATTACHMENT_LIMITS.images);
    expect(plan.at(-1)?.delivery).toEqual({ mode: 'note', why: 'too_many' });
    const wide = planAttachments(withFiles([ref('att_w', 'image', { width: 9000 })]), claudeCaps);
    expect(wide[0]?.delivery).toEqual({ mode: 'note', why: 'too_large' });
    expect(needsBytes({ ref: ref('att_big', 'text', { size: 3_000_000 }), delivery: { mode: 'text' } })).toBe(
      false,
    );
  });
});
