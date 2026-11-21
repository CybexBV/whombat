/**
 * A Mermaid diagram as a page for a sandboxed preview (web AP-323; mobile docs/decisions/visual-replies.md): the source
 * escaped (Mermaid reads the text), the Mermaid runtime, and a start in strict security mode in the app's colours. The
 * web loads the bundled runtime from its own origin; the phone embeds it as a data URL. If the runtime cannot load,
 * the page shows the diagram's source with a line saying so. Pure: web and mobile share it.
 */

/** What the page says above the source when Mermaid couldn't load. */
export const MERMAID_UNAVAILABLE = 'Couldn’t draw this diagram here, so this is what it says.';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] as string);
}

/** A token value for CSS or a script: never able to close the element it sits in. */
function cssValue(value: string): string {
  return value.replace(/[<>{};\\]/g, '').trim();
}

/** The app's colours and font for a diagram (read from the tokens' CSS variables). */
export interface DiagramTheme {
  dark: boolean;
  /** `--sf` */
  background: string;
  /** `--sf2` */
  node: string;
  /** `--ink` */
  text: string;
  /** `--mut` */
  line: string;
  /** `--brand` */
  accent: string;
  /** `--bubble` */
  secondary: string;
  /** `--font-sans` */
  font: string;
}

/** Mermaid's per-diagram settings that take `useMaxWidth`. */
const MERMAID_DIAGRAMS = [
  'flowchart',
  'sequence',
  'gantt',
  'journey',
  'timeline',
  'class',
  'state',
  'er',
  'pie',
  'quadrantChart',
  'xyChart',
  'requirement',
  'mindmap',
  'gitGraph',
  'c4',
  'sankey',
  'packet',
  'block',
  'architecture',
] as const;

/**
 * A Mermaid diagram as a page for the frame (AP-323): the source (escaped: Mermaid reads the text), the Mermaid
 * bundled runtime (`scriptUrl`, on the web app's origin or embedded as a data URL) and a start in strict
 * security mode, in the app's colours. A syntax error shows Mermaid's own error drawing.
 */
export function mermaidDocument(source: string, scriptUrl: string, theme: DiagramTheme): string {
  return mermaidDocumentWith(source, mermaidScriptElement(scriptUrl), theme);
}

/**
 * The runtime's `<script>` element, its address escaped. The phone's address embeds the whole runtime (megabytes), so it
 * makes this once and builds every diagram's page with `mermaidDocumentWith`.
 */
export function mermaidScriptElement(scriptUrl: string): string {
  return `<script src="${escapeHtml(scriptUrl)}"></script>`;
}

/** `mermaidDocument` with the runtime's element already made (`mermaidScriptElement`). */
export function mermaidDocumentWith(source: string, scriptElement: string, theme: DiagramTheme): string {
  const vars = {
    darkMode: theme.dark,
    background: cssValue(theme.background),
    primaryColor: cssValue(theme.node),
    primaryTextColor: cssValue(theme.text),
    primaryBorderColor: cssValue(theme.line),
    lineColor: cssValue(theme.line),
    secondaryColor: cssValue(theme.secondary),
    tertiaryColor: cssValue(theme.background),
    textColor: cssValue(theme.text),
    fontFamily: cssValue(theme.font),
    fontSize: '14px',
    edgeLabelBackground: cssValue(theme.background),
    clusterBkg: cssValue(theme.background),
  };
  // Drawn at their own size (a wide chart scrolls sideways) instead of shrunk to the card's width.
  const natural = { useMaxWidth: false };
  const config = {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: vars,
    fontFamily: vars.fontFamily,
    ...Object.fromEntries(MERMAID_DIAGRAMS.map((d) => [d, natural])),
  };
  // `<` escaped so nothing in the JSON can end the script element.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return [
    '<!doctype html>',
    `<html><head><meta charset="utf-8"><meta name="color-scheme" content="${theme.dark ? 'dark' : 'light'}">`,
    `<style>html,body{margin:0;background:${vars.background};color:${vars.textColor};font-family:${vars.fontFamily}}`,
    '#diagram{display:flex;justify-content:safe center;margin:0;padding:16px;overflow-x:auto}',
    '#diagram svg{flex:none}',
    `#unavailable{margin:0;padding:12px 16px 0;color:${vars.lineColor};font-size:13px}`,
    '#diagram.source{display:block;font:12.5px/1.55 ui-monospace,monospace;white-space:pre-wrap}</style></head><body>',
    `<pre id="diagram" class="mermaid">${escapeHtml(source)}</pre>`,
    scriptElement,
    // Without the runtime the source stays in place, under a line that says why.
    `<script>var d=document.getElementById('diagram');if(typeof mermaid==='undefined'){var p=document.createElement('p');p.id='unavailable';p.textContent=${JSON.stringify(MERMAID_UNAVAILABLE)};d.before(p);d.classList.add('source')}else{mermaid.initialize(${json});mermaid.run({nodes:[d]}).catch(function(){});}</script>`,
    '</body></html>',
  ].join('');
}
