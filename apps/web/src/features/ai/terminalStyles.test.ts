import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { styleSafeDocument } from './terminalStyles';

class Sheet {
  replaceSync = vi.fn<(text: string) => void>();
}

const changed = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('terminal styles under the hosted CSP', () => {
  let root: HTMLElement;
  let stop: (() => void) | undefined;
  const adopted = Object.getOwnPropertyDescriptor(document, 'adoptedStyleSheets');

  beforeEach(() => {
    vi.stubGlobal('CSSStyleSheet', Sheet);
    Object.defineProperty(document, 'adoptedStyleSheets', { configurable: true, writable: true, value: [] });
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    root.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (adopted) Object.defineProperty(document, 'adoptedStyleSheets', adopted);
    else Reflect.deleteProperty(document, 'adoptedStyleSheets');
  });

  function terminal() {
    const safe = styleSafeDocument(document);
    if (!safe) throw new Error('Expected constructable stylesheets');
    return safe;
  }

  it('mirrors existing styles and handles style attributes through the CSSOM', () => {
    const safe = terminal();
    const style = safe.document.createElement('style');
    style.textContent = '.xterm { font-size: 13px; }';
    root.append(style);
    stop = safe.watch(root);
    expect(style.localName).toBe('wb-xterm-style');
    expect(style.hidden).toBe(true);
    expect(document.adoptedStyleSheets).toHaveLength(1);
    expect(document.adoptedStyleSheets[0]?.replaceSync).toHaveBeenCalledWith(style.textContent);
    const cell = safe.document.createElement('span');
    cell.setAttribute('style', 'font-weight: bold');
    cell.setAttribute('aria-label', 'Output');
    expect(cell.style.fontWeight).toBe('bold');
    expect(cell.getAttribute('aria-label')).toBe('Output');
  });

  it('leaves styles alone during output changes without rescanning the terminal', async () => {
    const safe = terminal();
    for (let i = 0; i < 4; i++) {
      const style = safe.document.createElement('style');
      style.textContent = `.row${i} { font-size: 13px; }`;
      root.append(style);
    }
    stop = safe.watch(root);
    const scan = vi.spyOn(root, 'querySelectorAll');
    for (let pass = 0; pass < 10; pass++) {
      const row = safe.document.createElement('div');
      for (let i = 0; i < 50; i++) {
        const cell = safe.document.createElement('span');
        cell.textContent = `Output ${i}`;
        row.append(cell);
      }
      root.append(row);
      await changed();
      if (row.firstChild?.firstChild) row.firstChild.firstChild.textContent = 'Changed output';
      await changed();
      row.remove();
      await changed();
    }
    expect(scan).not.toHaveBeenCalled();
    for (const sheet of document.adoptedStyleSheets) expect(sheet.replaceSync).toHaveBeenCalledTimes(1);
  });

  it('updates only changed styles, including text nodes and nested additions', async () => {
    const safe = terminal();
    stop = safe.watch(root);
    const group = safe.document.createElement('div');
    const style = safe.document.createElement('style');
    style.textContent = '.xterm { font-size: 13px; }';
    group.append(style);
    root.append(group);
    await changed();
    const sheet = document.adoptedStyleSheets[0];
    expect(sheet?.replaceSync).toHaveBeenCalledTimes(1);
    const unchanged = style.textContent;
    style.textContent = unchanged;
    await changed();
    expect(sheet?.replaceSync).toHaveBeenCalledTimes(1);
    const text = style.firstChild as Text;
    text.data = '.xterm { font-size: 14px; }';
    await changed();
    expect(sheet?.replaceSync).toHaveBeenLastCalledWith(text.data);
    expect(sheet?.replaceSync).toHaveBeenCalledTimes(2);
    style.textContent = '';
    await changed();
    expect(sheet?.replaceSync).toHaveBeenLastCalledWith('');
    expect(sheet?.replaceSync).toHaveBeenCalledTimes(3);
  });

  it('releases removed styles, preserves other terminals, and stops observing on disposal', async () => {
    const safe = terminal();
    const external = new CSSStyleSheet();
    document.adoptedStyleSheets = [external];
    stop = safe.watch(root);
    const group = safe.document.createElement('div');
    const style = safe.document.createElement('style');
    style.textContent = '.xterm { font-size: 13px; }';
    group.append(style);
    root.append(group);
    await changed();
    const sheet = document.adoptedStyleSheets[1];
    group.remove();
    root.append(group);
    await changed();
    expect(document.adoptedStyleSheets[1]).toBe(sheet);
    expect(sheet?.replaceSync).toHaveBeenCalledTimes(1);
    group.remove();
    await changed();
    expect(document.adoptedStyleSheets).toEqual([external]);
    root.append(group);
    await changed();
    const replacement = document.adoptedStyleSheets[1];
    expect(replacement).not.toBe(sheet);
    expect(replacement?.replaceSync).toHaveBeenCalledWith(style.textContent);
    stop();
    stop = undefined;
    style.textContent = '.xterm { font-size: 15px; }';
    await changed();
    expect(document.adoptedStyleSheets).toEqual([external]);
    expect(replacement?.replaceSync).toHaveBeenCalledTimes(1);
  });

  it('does not adopt a style added and removed before mutations are delivered', async () => {
    const safe = terminal();
    stop = safe.watch(root);
    const style = safe.document.createElement('style');
    root.append(style);
    style.remove();
    await changed();
    expect(document.adoptedStyleSheets).toEqual([]);
  });

  it('adopts styles added in one mutation batch in their DOM cascade order', async () => {
    const safe = terminal();
    stop = safe.watch(root);
    const last = safe.document.createElement('style');
    last.textContent = '.xterm { font-size: 14px; }';
    const first = safe.document.createElement('style');
    first.textContent = '.xterm { font-size: 13px; }';
    root.append(last);
    root.prepend(first);
    await changed();
    expect(document.adoptedStyleSheets[0]?.replaceSync).toHaveBeenCalledWith(first.textContent);
    expect(document.adoptedStyleSheets[1]?.replaceSync).toHaveBeenCalledWith(last.textContent);
  });

  it('leaves the default document in use without constructable stylesheets', () => {
    vi.stubGlobal('CSSStyleSheet', undefined);
    expect(styleSafeDocument(document)).toBeNull();
  });
});
