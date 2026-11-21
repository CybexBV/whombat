import { render, screen } from '@testing-library/react';
import type { SearchResult } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { receiptHref } from '../cards/links';
import { SearchResultRow } from './SearchResultRow';

const decision: SearchResult = {
  id: 'sr_apr_12',
  type: 'DECISION',
  where: 'PR #482 · 23 Sep',
  authorId: 'prn_whombat',
  snippet: 'Deploy feat/invoice-pdf to staging? Approved by Mara.',
  citedAs: 1,
  link: { type: 'approval', number: 12, in: { type: 'pr', number: 482 } },
  createdAt: '2026-09-23T09:20:00.000Z',
  status: { text: 'APPROVED BY MARA', tone: 'ok' },
};

describe('search result rows (WS-21, WS-25)', () => {
  it('show the TYPE tag and the state pill', () => {
    render(<SearchResultRow result={decision} onOpen={() => {}} />);
    expect(screen.getByText('DECISION')).toBeTruthy();
    expect(screen.getByText('APPROVED BY MARA')).toBeTruthy();
    expect(screen.getByText('receipt 1')).toBeTruthy();
  });

  it('a receipt of a decision or a plan step opens it, even from a search answer', () => {
    const card = { kind: 'answer' as const, query: 'staging', receipts: [] };
    expect(
      receiptHref(card as never, {
        n: 1,
        source: 'Approval #12',
        detail: '',
        resultId: null,
        link: decision.link,
      }),
    ).toBe('/pr/482?approval=12');
    expect(
      receiptHref(card as never, {
        n: 2,
        source: 'Invoice PDF export',
        detail: '',
        resultId: null,
        link: {
          type: 'plan',
          planId: 'pln_1',
          stepId: 'stp_2',
          in: { type: 'dm', room: 'chat' },
        },
      }),
    ).toBe('/chat?plan=pln_1&step=stp_2');
    // Other receipts keep the mock's behaviour: back to the search.
    expect(
      receiptHref(card as never, {
        n: 3,
        source: 'Run #1882',
        detail: '',
        resultId: null,
        link: { type: 'run', number: 1882 },
      }),
    ).toBe('/search?q=staging');
  });
});
