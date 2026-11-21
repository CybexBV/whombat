/** The file view (AP-664): its helpers, and opening a file from Files changed on the fixture world. */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';
import { changeStarts, gutterDigits, languageOf, neighbours, splitTokenLines } from './fileView';

describe('file view helpers', () => {
  it('highlights by extension, and a few files by name', () => {
    expect(languageOf('billing/pdf/format.ts')).toBe('ts');
    expect(languageOf('design/Home.dc.html')).toBe('html');
    expect(languageOf('Dockerfile')).toBe('bash');
    expect(languageOf('LICENSE')).toBeNull();
    expect(languageOf('.gitignore')).toBeNull();
  });

  it('splits a highlighted text into lines, keeping the colours of spans cut at a line break', () => {
    const tree = {
      kind: null,
      children: ['const a = ', { kind: 'string' as const, children: ['`x\ny`'] }, ';\nreturn a'],
    };
    const lines = splitTokenLines(tree, 3);
    expect(lines).toHaveLength(3);
    expect(lines[0]?.children).toEqual(['const a = ', { kind: 'string', children: ['`x'] }]);
    expect(lines[1]?.children).toEqual([{ kind: 'string', children: ['y`'] }, ';']);
    expect(lines[2]?.children).toEqual(['return a']);
  });

  it('finds where each change starts, the gutter and the neighbouring files', () => {
    const k = (kinds: string) =>
      [...kinds].map((c) => ({ kind: c === '+' ? 'add' : c === '-' ? 'del' : 'context' }) as const);
    expect(changeStarts(k(' -+  + -'))).toEqual([1, 5, 7]);
    expect(changeStarts(k('+  '))).toEqual([0]);
    expect(gutterDigits([{ old: 9, new: null }])).toBe(2);
    expect(gutterDigits([{ old: 120, new: 1004 }])).toBe(4);
    const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
    expect(neighbours(files, 'a')).toEqual({ previous: null, next: 'b' });
    expect(neighbours(files, 'c')).toEqual({ previous: 'b', next: null });
    expect(neighbours(files, 'x')).toEqual({ previous: null, next: null });
  });
});

describe('opening a file from Files changed', () => {
  it('shows the whole file view only, with removed and added lines in place, and steps between files', async () => {
    const user = userEvent.setup();
    renderApp('/pr/482?tab=files', fixtureServices());
    await user.click(await screen.findByRole('link', { name: /billing\/pdf\/format\.ts/ }));

    const code = await screen.findByRole('region', { name: 'billing/pdf/format.ts, view only' });
    expect(screen.getByText('View only')).toBeTruthy();
    expect(within(code).getAllByText('Removed:')).toHaveLength(9);
    expect(within(code).getAllByText('Added:')).toHaveLength(34);
    expect(within(code).getByText('// billing/pdf/format.ts')).toBeTruthy();
    expect(screen.getByText('1 change')).toBeTruthy();

    await user.click(screen.getByRole('link', { name: 'Next file' }));
    expect(await screen.findByRole('region', { name: 'billing/api/invoices.ts, view only' })).toBeTruthy();

    await user.click(screen.getByRole('link', { name: 'Files changed' }));
    expect(await screen.findByRole('list', { name: 'Files changed' })).toBeTruthy();
  });

  it('takes the whole room: no side pane or composer while a file is open (AP-666)', async () => {
    const user = userEvent.setup();
    renderApp('/pr/482?tab=files&file=billing%2Fpdf%2Fformat.ts', fixtureServices());
    await screen.findByRole('region', { name: 'billing/pdf/format.ts, view only' });
    expect(screen.queryByRole('complementary', { name: 'Pull request' })).toBeNull();
    expect(screen.queryByPlaceholderText('Comment on PR #482')).toBeNull();

    await user.click(screen.getByRole('link', { name: 'Files changed' }));
    expect(await screen.findByRole('complementary', { name: 'Pull request' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Comment on PR #482')).toBeTruthy();
  });

  it('says so when the pull request doesn’t change the file', async () => {
    renderApp('/pr/482?tab=files&file=nope.ts', fixtureServices());
    expect(await screen.findByText('This pull request doesn’t change nope.ts.')).toBeTruthy();
  });
});
