/**
 * The launcher's and panel container's styles (docs/decisions/feedback.md FB-03). They live in the closed shadow
 * root only (a constructable stylesheet: no `<style>`, no `unsafe-inline`, nothing global). Colors, font, radii
 * and shadows come from `@whombat/tokens`, set as the same CSS variables the web app uses.
 */
import { fontFamilies, radii, shadows, type ThemeColors, themeColors } from '@whombat/tokens';

const COLORS = ['btn', 'btnfg', 'sf', 'sf2', 'ink', 'ink2', 'mut', 'line', 'line2', 'brand'] as const;

function vars(theme: ThemeColors): string {
  return COLORS.map((c) => `--${c}:${theme[c]}`).join(';');
}

/** The panel is a full-screen sheet below this width (px). */
export const SHEET_BELOW = 480;
/** Above every ordinary page layer; the host page's own modals stay usable when they sit higher. */
export const Z_INDEX = 2147483000;

export function loaderCss(): string {
  const light = vars(themeColors.light);
  const dark = vars(themeColors.dark);
  return `
.wb{--font-sans:${fontFamilies.sans};--radius-pill:${radii.pill}px;--radius-modal:${radii.modal}px;--radius-panel:${radii.panel}px;--radius-button:${radii.button}px;--shadow-modal:${shadows.modal};--shadow-toast:${shadows.toast};${light};color-scheme:light;font:400 15px/1.4 var(--font-sans);-webkit-font-smoothing:antialiased}
.wb[data-theme=dark]{${dark};color-scheme:dark}
@media (prefers-color-scheme:dark){.wb[data-theme=auto]{${dark};color-scheme:dark}}
.wb *,.wb *::before,.wb *::after{box-sizing:border-box}
.launcher{position:fixed;bottom:20px;right:20px;z-index:${Z_INDEX};display:inline-flex;align-items:center;gap:8px;min-height:44px;min-width:44px;margin:0;padding:0 18px 0 16px;border:1px solid var(--btn);border-radius:var(--radius-pill);background:var(--btn);color:var(--btnfg);font:600 15px/1 var(--font-sans);letter-spacing:normal;text-transform:none;box-shadow:var(--shadow-toast);cursor:pointer;-webkit-tap-highlight-color:transparent}
.wb[data-position=bottom-left] .launcher{right:auto;left:20px}
.launcher:hover{filter:brightness(1.12)}
.launcher:focus{outline:none}
.launcher:focus-visible{outline:3px solid var(--brand);outline-offset:3px}
.launcher svg{width:18px;height:18px;flex:none}
.panel{position:fixed;right:20px;bottom:80px;z-index:${Z_INDEX};width:400px;max-width:calc(100vw - 40px);height:min(680px,calc(100vh - 100px));border:1px solid var(--line);border-radius:var(--radius-modal);background:var(--sf);box-shadow:var(--shadow-modal);overflow:hidden}
.wb[data-launcher=custom] .panel{bottom:20px;height:min(680px,calc(100vh - 40px))}
.wb[data-position=bottom-left] .panel{right:auto;left:20px}
.panel[hidden]{display:none}
.panel[data-size=compact]{height:232px}
.panel iframe{display:block;width:100%;height:100%;border:0;margin:0;padding:0;background:var(--sf)}
.panel[data-state=loading] iframe,.panel[data-state=unavailable] iframe{visibility:hidden;position:absolute;inset:0}
.status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;margin:0;color:var(--mut);font-size:14px}
.panel:not([data-state=loading]) .status{display:none}
.notice{display:none;padding:20px}
.panel[data-state=unavailable]{height:auto}
.panel[data-state=unavailable] .notice{display:block}
.notice h2{margin:0 0 6px;color:var(--ink);font:700 17px/1.3 var(--font-sans)}
.notice p{margin:0 0 16px;color:var(--ink2);font-size:15px;line-height:1.5}
.close{min-height:44px;padding:0 18px;border:1px solid var(--line2);border-radius:var(--radius-button);background:transparent;color:var(--ink);font:500 15px var(--font-sans);cursor:pointer}
.close:focus{outline:none}
.close:focus-visible{outline:3px solid var(--brand);outline-offset:2px}
@media (max-width:${SHEET_BELOW - 0.02}px){
.panel,.wb[data-launcher=custom] .panel,.wb[data-position=bottom-left] .panel{inset:0;width:auto;max-width:none;height:auto;border:0;border-radius:0}
.panel[data-state=unavailable],.panel[data-size=compact]{inset:auto 0 0 0;border-top:1px solid var(--line);border-radius:var(--radius-modal) var(--radius-modal) 0 0}
}
@media (prefers-reduced-motion:no-preference){.launcher{transition:filter .15s}}
`;
}

/**
 * Where constructable stylesheets are missing: just enough inline layout (CSSOM, not a `style` attribute, so a
 * strict `style-src` still allows it) that the launcher and panel are placed and usable.
 */
export const FALLBACK_STYLES = {
  launcher: {
    position: 'fixed',
    bottom: '20px',
    'z-index': String(Z_INDEX),
    'min-height': '44px',
    padding: '0 18px',
    'border-radius': `${radii.pill}px`,
    border: '0',
    background: themeColors.light.btn,
    color: themeColors.light.btnfg,
    font: `600 15px ${fontFamilies.sans}`,
    cursor: 'pointer',
  },
  panel: {
    position: 'fixed',
    bottom: '80px',
    'z-index': String(Z_INDEX),
    width: 'min(400px, calc(100vw - 40px))',
    height: 'min(680px, calc(100vh - 100px))',
    background: themeColors.light.sf,
    color: themeColors.light.ink,
    'border-radius': `${radii.modal}px`,
    'box-shadow': shadows.modal,
    overflow: 'hidden',
  },
  frame: { display: 'block', width: '100%', height: '100%', border: '0' },
} as const;
