/**
 * Constants shared by the theme logic and the inline no-flash script. No imports: this file is also
 * loaded by `vite.config.ts` (and `.storybook/main.ts`).
 */
export const THEME_STORAGE_KEY = 'whombat:theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Inline `<head>` script that sets `data-theme` on `<html>` before first paint, so the page never
 * flashes the wrong theme. Same rule as `resolveTheme`: stored choice, else `prefers-color-scheme`.
 */
export const NO_FLASH_SCRIPT = `(function(){var d=document.documentElement,t=null;try{t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}if(t!=='light'&&t!=='dark'){try{t=window.matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches?'dark':'light'}catch(e){t='light'}}d.dataset.theme=t})();`;
