import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeFinding, findUndefinedClasses } from './classes';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** A small tree under a fresh folder: files with their contents. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'css-modules-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const scan = async (files: Record<string, string>) =>
  (await findUndefinedClasses(tree(files), ['src'])).map(describeFinding);

describe('CSS-module classes the code reads', () => {
  it('names the file, line and lookup of a class the stylesheet lacks', async () => {
    const found = await scan({
      'src/A.module.css':
        '.dot { color: red; }\n.dot_new { color: blue; }\n.row:hover .slot { color: green; }\n',
      'src/A.tsx': [
        "import styles from './A.module.css';",
        'export const a = styles.dot;',
        'export const b = styles.dotNew;',
        'export const c = styles.slot + styles.row;',
        'export const d = styles.ring;',
        "export const e = styles['dot_new'];",
      ].join('\n'),
    });
    expect(found).toEqual([
      'src/A.tsx:5: styles.ring is not a class in src/A.module.css',
      "src/A.tsx:6: styles['dot_new'] is not a class in src/A.module.css",
    ]);
  });

  it('reads a template or variantClass lookup as a fixed start that some class must have', async () => {
    const found = await scan({
      'src/Pill.module.css': '.pill {}\n.pill_ok {}\n.pill_notWorking {}\n',
      'src/Pill.tsx': [
        "import styles from './Pill.module.css';",
        "import { variantClass } from './cx';",
        'export const ok = (level: string) => variantClass(styles, "pill", level);',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test
        'export const bad = (level: string) => styles[`pill_${level}`];',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test
        'export const fine = (level: string) => styles[`pill${level}`];',
        "export const exact = variantClass(styles, 'pill', 'notWorking');",
        "export const missing = variantClass(styles, 'pill', 'gone');",
        'export const computed = (name: string) => styles[name];',
        "export const either = (on: boolean) => styles[on ? 'pillOk' : 'pillOff'];",
      ].join('\n'),
      'src/cx.ts':
        'export const variantClass = (s: Record<string, string>, b: string, k: string) => s[b + k.charAt(0).toUpperCase() + k.slice(1)];\n',
    });
    expect(found).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test
      'src/Pill.tsx:4: styles[`pill_${level}`] is not a class in src/Pill.module.css',
      "src/Pill.tsx:7: variantClass(styles, 'pill', 'gone') is not a class in src/Pill.module.css",
      "src/Pill.tsx:9: styles[on ? 'pillOk' : 'pillOff'] is not a class in src/Pill.module.css",
    ]);
  });

  it('follows a re-exported stylesheet into the files that import it, and leaves a shadowing name alone', async () => {
    const found = await scan({
      'src/Frame.module.css': '.frame {}\n.button {}\n',
      'src/Frame.tsx':
        "import f from './Frame.module.css';\nexport { f as frameStyles };\nexport const x = f.frame;\n",
      'src/Card.tsx': [
        "import { frameStyles as f } from './Frame';",
        'export const a = f.button;',
        'export const b = f.title;',
        'export const c = (f: { title: string }) => f.title;',
        'export const { frame, slot } = f;',
      ].join('\n'),
    });
    expect(found).toEqual([
      'src/Card.tsx:3: f.title is not a class in src/Frame.module.css',
      'src/Card.tsx:5: { slot } = f is not a class in src/Frame.module.css',
    ]);
  });

  it('finds none in the web and widget code', async () => {
    const found = (await findUndefinedClasses(ROOT)).map(describeFinding);
    // A class the code reads that its stylesheet doesn't define: add the rule, or read a class that exists. With the
    // build's camelCaseOnly naming `.pill_ok` is `styles.pillOk`, which `variantClass(styles, 'pill', 'ok')` builds.
    expect(found, found.join('\n')).toEqual([]);
  });
});
