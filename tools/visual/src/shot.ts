import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { REFERENCE_FILES, type ReferenceFile, SCREENS, setReferenceState, shootReference } from './reference';

const USAGE = `Render a design reference (docs/design-handoff/design/*.dc.html) to a PNG.

Usage:
  pnpm ref:shot --file desktop|mobile|avatar [--screen <start>] [--theme light|dark]
                [--width 1440 --height 900 | --size 180] [--prop key=value ...]
                [--click "visible text" ...] [--state key=value ...] [--wait ms] [--wait-for <js>]
                [--full-page] [--no-freeze] --out <file.png>

  --wait-for shoot as soon as this page expression is truthy (e.g. a later live tick)
  --screen   desktop start screen: ${SCREENS.join(', ')}
  --theme    desktop: theme prop; mobile: clip to that phone (both are rendered side by side)
  --prop     any data-props default, e.g. --prop role=developer --prop crop=head
  --click    click visible text, in order (repeatable)
  --state    patch the mock's component state before the clicks (JSON values, else strings),
             e.g. --state pane=thread (the mock's thread link has no handler)
  --size     square viewport (avatar), same as --width N --height N
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string', default: 'desktop' },
      screen: { type: 'string' },
      theme: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      size: { type: 'string' },
      prop: { type: 'string', multiple: true, default: [] },
      click: { type: 'string', multiple: true, default: [] },
      state: { type: 'string', multiple: true, default: [] },
      wait: { type: 'string' },
      'wait-for': { type: 'string' },
      out: { type: 'string' },
      'full-page': { type: 'boolean', default: false },
      'no-freeze': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.out) throw new Error(`--out is required\n\n${USAGE}`);
  const file = values.file as ReferenceFile;
  if (!(file in REFERENCE_FILES))
    throw new Error(`--file must be one of ${Object.keys(REFERENCE_FILES).join(', ')}`);
  if (values.theme && values.theme !== 'light' && values.theme !== 'dark') {
    throw new Error('--theme must be light or dark');
  }

  const props: Record<string, string> = {};
  for (const kv of values.prop) {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`--prop expects key=value, got "${kv}"`);
    props[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const state: Record<string, unknown> = {};
  for (const kv of values.state) {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`--state expects key=value, got "${kv}"`);
    const raw = kv.slice(i + 1);
    try {
      state[kv.slice(0, i)] = JSON.parse(raw);
    } catch {
      state[kv.slice(0, i)] = raw;
    }
  }
  let phone: 'light' | 'dark' | undefined;
  if (file === 'mobile') {
    if (values.screen) throw new Error('--screen does not apply to mobile; navigate with --click instead');
    phone = values.theme as 'light' | 'dark' | undefined;
  } else {
    if (values.screen) props.start = values.screen;
    if (values.theme) props.theme = values.theme;
  }

  const num = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
    return n;
  };
  const size = num(values.size, 'size');

  const png = await shootReference({
    file,
    props,
    phone,
    clicks: values.click,
    prepare: Object.keys(state).length ? (page) => setReferenceState(page, state) : undefined,
    width: num(values.width, 'width') ?? size,
    height: num(values.height, 'height') ?? size,
    wait: values.wait === undefined ? undefined : Number(values.wait),
    fullPage: values['full-page'],
    freezeClock: !values['no-freeze'],
    waitFor: values['wait-for'],
  });
  const out = resolve(process.env.INIT_CWD ?? process.cwd(), values.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, png);
  console.log(`wrote ${out}`);
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
