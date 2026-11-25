import type { NeedsYouButton, NeedsYouListRow } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import { approvalRowDoors, sheetOffersButtons } from './needsYou';

const listed = [{ id: 'apr:12' }, { id: 'look:nas' }];

describe('an item’s sheet', () => {
  it('offers its buttons while the Inbox lists the item', () => {
    expect(sheetOffersButtons('apr:12', listed, false)).toBe(true);
  });

  it('offers nothing more once the item left: an answer that may have gone through is never sent again', () => {
    expect(sheetOffersButtons('apr:13', listed, false)).toBe(false);
  });

  it('keeps them while a button is on its way, or before the Inbox is read', () => {
    expect(sheetOffersButtons('apr:13', listed, true)).toBe(true);
    expect(sheetOffersButtons('apr:13', undefined, false)).toBe(true);
  });
});

describe('an approval row of the assistant’s draft report', () => {
  const DRAFT = 'trd_AbCdEfGhIjKlMnOpQrStUv';
  const button = (kind: 'approve' | 'decline'): NeedsYouButton => ({
    id: kind,
    kind: 'action',
    label: kind === 'approve' ? 'Yes, do it' : 'No, never',
    look: 'secondary',
    action: { id: kind, label: kind, style: 'secondary', kind },
  });
  const row = (href: string | undefined, kinds: ('approve' | 'decline')[]) =>
    ({
      item: { kind: 'approval', approvalNumber: 7, ...(href ? { href } : {}) },
      buttons: kinds.map(button),
    }) as unknown as Pick<NeedsYouListRow, 'item' | 'buttons'>;

  it('offers Edit with the draft, and its yes stays on the row', () => {
    expect(approvalRowDoors(row(`/reports/new?draft=${DRAFT}`, ['approve', 'decline']))).toEqual({
      draftId: DRAFT,
      approvalNumber: null,
    });
  });

  it('opens the approval’s own screen when the draft is too long for its yes here', () => {
    expect(approvalRowDoors(row(`/reports/new?draft=${DRAFT}`, ['decline']))).toEqual({
      draftId: DRAFT,
      approvalNumber: 7,
    });
  });

  it('offers nothing more for any other approval', () => {
    expect(approvalRowDoors(row(undefined, ['approve', 'decline']))).toEqual({
      draftId: null,
      approvalNumber: null,
    });
  });
});
