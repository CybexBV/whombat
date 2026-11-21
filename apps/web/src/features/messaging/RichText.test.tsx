import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PAGE_MAX_HEIGHT } from '@whombat/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RichText } from './RichText';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

describe('RichText images (AP-101)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('shows a data: image that opens in the lightbox', async () => {
    const user = userEvent.setup();
    render(<RichText text={`Here: ![Chart](${PNG})`} />);
    const img = screen.getByRole('img', { name: 'Chart' });
    expect(img.getAttribute('src')).toBe(PNG);
    await user.click(screen.getByRole('button', { name: 'Open image: Chart' }));
    expect(within(screen.getByRole('dialog')).getByRole('img', { name: 'Chart' }).getAttribute('src')).toBe(
      PNG,
    );
  });

  it('links remote images, which the page’s policy blocks', () => {
    render(<RichText text="![Logo](https://example.com/logo.png)" />);
    expect(screen.queryByRole('img')).toBeNull();
    const chip = screen.getByRole('link', { name: 'Logo, on example.com' });
    expect(chip.getAttribute('href')).toBe('https://example.com/logo.png');
  });

  it('draws an SVG code block, with its code a toggle away', async () => {
    const user = userEvent.setup();
    render(<RichText text={SVG} />);
    const img = screen.getByRole('img', { name: 'Drawing' });
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml[;,]/);
    expect(document.querySelector('svg rect')).toBeNull();
    // The lazy highlighter may already have split the code into spans (AP-322), so compare the code's whole text.
    const code = () => [...document.querySelectorAll('pre code')].find((el) => el.textContent === SVG);
    expect(code()).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'View code' }));
    expect(code()).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Hide code' }));
    expect(code()).toBeUndefined();
  });
});

describe('RichText blocks (CT-149, AP-321)', () => {
  it('renders a GitHub table with its header, alignment and a keyboard-scrollable wrapper', () => {
    render(<RichText text={'| Variant | Size |\n|:--|--:|\n| Mark | 128 px |\n| Favicon | 16 px |'} />);
    const region = screen.getByRole('region', { name: 'Table' });
    expect(region.tabIndex).toBe(0);
    const table = within(region).getByRole('table');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['Variant', 'Size']);
    expect(headers[1]?.className).toContain('alignRight');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('cell', { name: '16 px' }).className).toContain('alignRight');
  });

  it('shows task items as read-only checkboxes labelled by their text', () => {
    render(<RichText text={'- [x] Mark on paper\n- [ ] Favicon\n- plain item'} />);
    const done = screen.getByRole('checkbox', { name: 'Mark on paper' }) as HTMLInputElement;
    const open = screen.getByRole('checkbox', { name: 'Favicon' }) as HTMLInputElement;
    expect(done.checked).toBe(true);
    expect(open.checked).toBe(false);
    expect(done.disabled && open.disabled).toBe(true);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText('plain item').closest('li')).toBeTruthy();
  });

  it('keeps headings under the page’s own: # is an h3, ###### an h6', () => {
    render(<RichText text={'# One\n## Two\n###### Six'} />);
    expect(screen.getByRole('heading', { name: 'One' }).tagName).toBe('H3');
    expect(screen.getByRole('heading', { name: 'Two' }).tagName).toBe('H4');
    expect(screen.getByRole('heading', { name: 'Six' }).tagName).toBe('H6');
  });

  it('nests quotes', () => {
    render(<RichText text={'> outer\n> > inner'} />);
    const inner = screen.getByText('inner').closest('blockquote');
    expect(inner?.parentElement?.closest('blockquote')).toBeTruthy();
  });

  it('labels code with its language and copies it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<RichText text={'```ts\nconst a = 1;\n```'} />);
    expect(screen.getByText('ts')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('const a = 1;');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });
});

describe('RichText previews (AP-320, AP-323)', () => {
  const PAGE =
    '<!doctype html><html><head><title>Logo &amp; mark</title></head><body><svg><title>no</title></svg><script>go()</script></body></html>';

  it('shows an HTML page in the sandboxed frame, never in the app’s DOM', async () => {
    const user = userEvent.setup();
    render(<RichText text={`\`\`\`html\n${PAGE}\n\`\`\``} />);
    const card = screen.getByRole('figure', { name: 'Logo & mark' });
    const frame = within(card).getByTitle('Page preview: Logo & mark') as HTMLIFrameElement;
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe('/sandbox/html-frame.html');
    expect(document.querySelector('script')).toBeNull();
    // View source: the highlighted page instead of the frame.
    await user.click(within(card).getByRole('button', { name: 'View source' }));
    expect(within(card).getByRole('button', { name: 'View source' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(within(card).queryByTitle('Page preview: Logo & mark')).toBeNull();
    expect(card.textContent).toContain('<script>go()</script>');
    expect(within(card).getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('posts the page to its own frame whenever that frame is ready, and takes only heights from it', () => {
    render(<RichText text={PAGE} />);
    const frame = screen.getByTitle('Page preview: Logo & mark') as HTMLIFrameElement;
    const win = frame.contentWindow as Window;
    const post = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
    const ready = (source: Window) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'whombat.ready' }, source }));
      });
    frame.dispatchEvent(new Event('load'));
    ready(window);
    expect(post).not.toHaveBeenCalled();
    ready(win);
    // The page, with the app's theme as its first style (visual-replies.md).
    const sent = post.mock.calls[0]?.[0] as { type: string; html: string };
    expect(sent.type).toBe('whombat.html');
    expect(sent.html.replace(/<style id="whombat-page">[^<]*<\/style>/, '')).toBe(PAGE);
    expect(sent.html).toContain('--chart-1:');
    // Moved in the document, the frame reloads and asks again.
    ready(win);
    expect(post).toHaveBeenCalledTimes(2);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'whombat.height', height: 480 }, source: window }),
      );
    });
    expect(frame.style.height).toBe('320px');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'whombat.height', height: 480 }, source: win }),
      );
    });
    expect(frame.style.height).toBe('480px');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'whombat.height', height: 99999 }, source: win }),
      );
    });
    expect(frame.style.height).toBe(`${PAGE_MAX_HEIGHT}px`);
  });

  it('opens a page full screen', async () => {
    const user = userEvent.setup();
    render(<RichText text={PAGE} />);
    await user.click(screen.getByRole('button', { name: 'Open full screen' }));
    const dialog = screen.getByRole('dialog', { name: 'Logo & mark' });
    expect(within(dialog).getByTitle('Page preview: Logo & mark').getAttribute('sandbox')).toBe(
      'allow-scripts',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Close full screen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('draws a Mermaid diagram in the same sandbox, its source a toggle away', async () => {
    const user = userEvent.setup();
    render(<RichText text={'```mermaid\ngraph TD\n  A --> B\n```'} />);
    const card = screen.getByRole('figure', { name: 'Diagram' });
    const frame = within(card).getByTitle('Diagram: Diagram');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    await user.click(within(card).getByRole('button', { name: 'View source' }));
    expect(card.textContent).toContain('A --> B');
  });
});
