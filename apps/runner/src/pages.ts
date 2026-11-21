/**
 * A page set for `show_pages` (docs/decisions/page-sets.md): the folder the agent named, read like a preview's folder
 * (`readFolderFiles`, inside the turn's own folder only) within the set's limits, checked for links that lead nowhere,
 * and packed as one ZIP of stored entries with `.whombat/cover.png` (the picture of the page it opens on) and
 * `.whombat/pages.json` last, so the server finds what the set is in the file's last bytes.
 */
import {
  cleanPagePath,
  isPagePath,
  isPagesOwnPath,
  PAGES_COVER,
  PAGES_MANIFEST,
  PAGES_MAX_BYTES,
  PAGES_MAX_FILES,
  PAGES_MAX_PROBLEMS,
  type PageSetManifest,
  pageFileFor,
  resolvePageRef,
  zipStored,
} from '@whombat/core';
import type { FolderFile, FolderLimits } from './preview';

export const PAGES_LIMITS: FolderLimits = {
  files: PAGES_MAX_FILES,
  bytes: PAGES_MAX_BYTES,
  tooMany: (dir) => `${dir} has more than ${PAGES_MAX_FILES} files: show a smaller folder.`,
  tooLarge: (dir) => `${dir} is larger than ${PAGES_MAX_BYTES / 1024 / 1024} MB: show a smaller folder.`,
  empty: (dir) => `${dir} is empty: put the pages in it first.`,
};

/** A turn without a folder of its own. */
export const PAGES_NO_FOLDER =
  'This turn has no folder of its own to read: show_pages takes a folder of your checkout or of your work folder (~/work). Copy the pages there first.';

/** Pages and stylesheets bigger than this aren't checked for links (they are still in the set). */
const CHECK_MAX_BYTES = 2 * 1024 * 1024;

const TAG = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g;
const ATTR = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g;
const CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/g;
/** References that are fine as they are: in-page, inline data, a mail or phone link, script. */
const NOT_A_FILE = /^(?:#|data:|blob:|mailto:|tel:|javascript:|about:)/i;
const WEB = /^(?:https?:)?\/\//i;

interface Ref {
  /** Where it is (the file it is in). */
  from: string;
  value: string;
  /** A link to click (`a`/`area` `href`): a link to the internet is fine; anything else must load from the set. */
  link: boolean;
  /** A page in a frame inside this one (`iframe src`): the viewer shows a link to it instead. */
  frame?: boolean;
}

/** The references of a page: its tags' `src`, `href`, `poster`, `data`, `srcset`, inline `url()`s, and its styles'. */
function pageRefs(from: string, page: string): Ref[] {
  const refs: Ref[] = [];
  // What a script writes is the script's: only its own tag counts.
  const html = page.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, '$1$2');
  for (const tag of html.matchAll(TAG)) {
    const name = (tag[1] ?? '').toLowerCase();
    for (const attr of (tag[2] ?? '').matchAll(ATTR)) {
      const key = (attr[1] ?? '').toLowerCase();
      const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
      if (key === 'srcset')
        for (const candidate of value.split(','))
          refs.push({ from, value: candidate.trim().split(/\s+/)[0] ?? '', link: false });
      else if (key === 'style') refs.push(...cssRefs(from, value));
      else if (key === 'href' || key === 'xlink:href') {
        // A <link> that isn't a stylesheet or an icon (preconnect, canonical, alternate) loads nothing worth checking.
        if (name === 'link' && !/\b(?:stylesheet|icon)\b/i.test(tag[2] ?? '')) continue;
        refs.push({ from, value, link: name === 'a' || name === 'area' });
      } else if (key === 'src' && name === 'iframe') refs.push({ from, value, link: false, frame: true });
      else if (key === 'src' || key === 'poster' || (key === 'data' && name === 'object'))
        refs.push({ from, value, link: false });
    }
  }
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    refs.push(...cssRefs(from, style[1] ?? ''));
  return refs;
}

function cssRefs(from: string, css: string): Ref[] {
  return [
    ...[...css.matchAll(CSS_URL)].map((m) => ({ from, value: m[2] ?? '', link: false })),
    ...[...css.matchAll(CSS_IMPORT)].map((m) => ({ from, value: m[2] ?? '', link: false })),
  ];
}

const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One thing that doesn't work, and the files it is in. */
interface Problem {
  /** What breaks when it fails: a file a page loads (first), or a link to click. */
  loads: boolean;
  text: string;
  from: string[];
}

/**
 * What doesn't work in the set: files a page loads that aren't in the folder, point outside it or would come from the
 * internet, then links to click that lead nowhere. The same one in several files is told once, with where it is.
 */
export function pageProblems(files: readonly FolderFile[]): string[] {
  const paths = new Set(files.map((f) => f.path));
  const has = (p: string) => paths.has(p);
  const found = new Map<string, Problem>();
  const note = (ref: Ref, text: string) => {
    const key = `${ref.link ? 'link' : 'load'}\n${text}`;
    const problem = found.get(key) ?? { loads: !ref.link, text, from: [] };
    if (!problem.from.includes(ref.from)) problem.from.push(ref.from);
    found.set(key, problem);
  };
  const decoder = new TextDecoder();
  for (const file of files) {
    const page = isPagePath(file.path);
    if (!page && !/\.css$/i.test(file.path)) continue;
    if (file.bytes.length > CHECK_MAX_BYTES) continue;
    const text = decoder.decode(file.bytes);
    for (const ref of page ? pageRefs(file.path, text) : cssRefs(file.path, text)) {
      const value = ref.value.trim();
      // A template's placeholder (`${url}`, `{{ src }}`) is filled in later.
      if (!value || NOT_A_FILE.test(value) || /\$\{|\{\{/.test(value)) continue;
      if (WEB.test(value)) {
        if (!ref.link)
          note(
            ref,
            `${short(value)} would load from the internet, which these pages can’t: put it in the folder.`,
          );
        continue;
      }
      const target = resolvePageRef(ref.from, value);
      if (target.kind === 'outside') {
        if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) note(ref, `${short(value)} points outside the folder.`);
      } else if (target.kind === 'file' && !pageFileFor(has, target.path))
        note(ref, `${short(value)} isn’t in the folder.`);
      else if (ref.frame)
        note(
          ref,
          `${short(value)} is in a frame inside the page, which shows as a link to it here: link to it instead.`,
        );
    }
  }
  const all = [...found.values()];
  const told = [...all.filter((p) => p.loads), ...all.filter((p) => !p.loads)].map((p) => {
    const where = p.from.length > 1 ? `${p.from[0]} and ${p.from.length - 1} more` : p.from[0];
    return `${where}: ${p.text}`;
  });
  if (told.length <= PAGES_MAX_PROBLEMS) return told;
  const left = told.length - (PAGES_MAX_PROBLEMS - 1);
  return [...told.slice(0, PAGES_MAX_PROBLEMS - 1), `And ${left} more like these.`];
}

export interface PackedPages {
  parts: Uint8Array[];
  size: number;
  manifest: PageSetManifest;
}

/**
 * The set of `files` that opens on `open` (a static site's way: `open`, `open.html`, `open/index.html`), with `cover`
 * when there is one, or why not.
 */
export function packPages(
  files: readonly FolderFile[],
  want: { open: string; title: string },
  dir: string,
  cover: Buffer | null,
): PackedPages | { error: string } {
  const kept = files.filter((f) => !isPagesOwnPath(f.path) && cleanPagePath(f.path) === f.path);
  const paths = new Set(kept.map((f) => f.path));
  const open = pageFileFor((p) => paths.has(p), want.open);
  if (!open || !isPagePath(open))
    return {
      error: `There is no page ${want.open} in ${dir}: name the page it opens on (open), like index.html.`,
    };
  const problems = pageProblems(kept);
  const skipped = files.length - kept.length;
  if (skipped > 0 && problems.length < PAGES_MAX_PROBLEMS)
    problems.push(
      `${skipped} file${skipped === 1 ? '' : 's'} left out: Whombat’s own .whombat folder, or names a page can’t link to.`,
    );
  const manifest: PageSetManifest = {
    v: 1,
    title: want.title,
    open,
    files: kept.length,
    pages: kept.filter((f) => isPagePath(f.path)).length,
    cover: cover !== null,
    problems,
  };
  const entries = [
    ...kept.map((f) => ({ path: f.path, bytes: f.bytes })),
    ...(cover ? [{ path: PAGES_COVER, bytes: cover }] : []),
    { path: PAGES_MANIFEST, bytes: new TextEncoder().encode(JSON.stringify(manifest)) },
  ];
  const parts = zipStored(entries);
  return { parts, size: parts.reduce((n, p) => n + p.length, 0), manifest };
}
