/**
 * Constants shared by the theme logic and the inline no-flash script. No imports: this file is also
 * loaded by `vite.config.ts` (and `.storybook/main.ts`).
 */
export const THEME_STORAGE_KEY = 'whombat:theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';
/** The language this browser showed last (any box), so the first paint already has the right `<html lang>`. */
export const LOCALE_LAST_KEY = 'whombat.locale.last';
/** A tab's `?lang=` choice for testing, kept while the tab lives so moving around the app keeps it. */
export const LOCALE_OVERRIDE_KEY = 'whombat.locale.override';

/**
 * The language part of the no-flash script: `?lang=`, the tab's test choice, else the language shown last. A shared
 * link's page is a visitor's and never takes the owner's language, so it is left alone.
 */
const NO_FLASH_LANG = `try{if(!/^\\/s\\/shr_/.test(location.pathname)){var l=null;try{l=new URLSearchParams(location.search).get('lang')}catch(e){}if(!l){try{l=sessionStorage.getItem(${JSON.stringify(
  LOCALE_OVERRIDE_KEY,
)})}catch(e){}}if(!l){try{l=localStorage.getItem(${JSON.stringify(
  LOCALE_LAST_KEY,
)})}catch(e){}}if(l){l=String(l).toLowerCase();if(l==='pseudo')d.lang='en-XA';else if(/^nl/.test(l))d.lang='nl-NL';else if(/^en/.test(l))d.lang='en-GB'}}}catch(e){}`;

/**
 * Inline `<head>` script that sets `data-theme` on `<html>` before first paint, so the page never
 * flashes the wrong theme. Same rule as `resolveTheme`: stored choice, else `prefers-color-scheme`. It also sets
 * `<html lang>` (`NO_FLASH_LANG`).
 */
export const NO_FLASH_SCRIPT = `(function(){var d=document.documentElement,t=null;try{t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}if(t!=='light'&&t!=='dark'){try{t=window.matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches?'dark':'light'}catch(e){t='light'}}d.dataset.theme=t;${NO_FLASH_LANG}})();`;
