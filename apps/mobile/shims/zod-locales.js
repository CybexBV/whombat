// zod's `locales` namespace with English only (metro.config.cjs, AP-889): the app never switches zod's language, and the
// other ~45 locales were ~250 kB of the bundle.
export { default as en } from 'zod/v4/locales/en.js';
