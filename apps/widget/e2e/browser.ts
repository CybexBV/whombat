/**
 * Driving the widget from Playwright (run.ts, and end-to-end tests against a real Whombat). The launcher lives in
 * a **closed** shadow root, which Playwright selectors don't pierce: `shadow()` reaches it through CDP
 * (Chromium only). The frame is an ordinary cross-origin `Frame`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { WIDGET_ROOT } from './servers';

// axe-core comes with the widget's own @axe-core/playwright.
const require = createRequire(join(WIDGET_ROOT, 'package.json'));
const axeSource = readFileSync(
  createRequire(require.resolve('@axe-core/playwright')).resolve('axe-core/axe.min.js'),
  'utf8',
);

/**
 * Runs `fn` (a function source taking the element) on the first match of `selector` inside the widget's
 * **closed** shadow root. Playwright's selectors only pierce open roots; CDP sees closed ones too.
 */
export async function shadow<T>(page: Page, selector: string, fn: string): Promise<T | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root: CdpNode;
    };
    const hostNode = findNode(root, (n) => n.localName === 'whombat-feedback');
    const shadowRoot = hostNode?.shadowRoots?.[0];
    if (!shadowRoot) return null;
    const { nodeId } = (await cdp.send('DOM.querySelector', { nodeId: shadowRoot.nodeId, selector })) as {
      nodeId: number;
    };
    if (!nodeId) return null;
    const { object } = (await cdp.send('DOM.resolveNode', { nodeId })) as { object: { objectId: string } };
    const { result } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: fn,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: T } };
    return result.value;
  } finally {
    await cdp.detach();
  }
}

interface CdpNode {
  nodeId: number;
  localName?: string;
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  contentDocument?: CdpNode;
}

function findNode(node: CdpNode, test: (n: CdpNode) => boolean): CdpNode | null {
  if (test(node)) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const hit = findNode(child, test);
    if (hit) return hit;
  }
  return null;
}

type Rect = { x: number; y: number; width: number; height: number };
export const rectOf = (page: Page, selector: string) =>
  shadow<Rect>(
    page,
    selector,
    'function () { const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }',
  );
export const attrOf = (page: Page, selector: string, name: string) =>
  shadow<string | null>(page, selector, `function () { return this.getAttribute(${JSON.stringify(name)}); }`);
export const textOf = (page: Page, selector: string) =>
  shadow<string>(page, selector, 'function () { return this.innerText; }');
export const exists = async (page: Page, selector: string) =>
  (await shadow<boolean>(page, selector, 'function () { return true; }')) === true;

/** A real mouse click in the middle of a shadow element. */
export async function clickShadow(page: Page, selector: string): Promise<void> {
  const r = await rectOf(page, selector);
  if (!r || r.width === 0) throw new Error(`${selector} isn’t visible`);
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
}

export async function until(what: string, test: () => Promise<boolean>, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function frameOf(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await until('the frame', async () => {
    found = page.frames().find((fr) => fr.url().includes('/embed/v1/frame.html'));
    return Boolean(found);
  });
  return found as Frame;
}

export async function waitForForm(page: Page): Promise<Frame> {
  const f = await frameOf(page);
  await f.locator('#wb-description').waitFor({ state: 'visible' });
  return f;
}

/** Serious or critical axe-core findings inside the frame (axe can't reach into the closed shadow root). */
export async function axeFrame(page: Page): Promise<string[]> {
  const target = page.frames().find((fr) => fr.url().includes('/embed/v1/frame.html'));
  if (!target) throw new Error('no frame');
  await target.evaluate(axeSource);
  const violations = await target.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run(): Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }>;
        };
      }
    ).axe;
    const result = await axe.run();
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      targets: v.nodes.map((n) => n.target.join(' ')),
    }));
  });
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.targets.join(', ')}`);
}

/** The widget's host element is focused, i.e. something inside its closed shadow root (the launcher). */
export async function focusInWidget(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.tagName === 'WHOMBAT-FEEDBACK');
}
