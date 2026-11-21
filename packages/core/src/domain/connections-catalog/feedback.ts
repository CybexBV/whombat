import { builtin, type CatalogEntryInput } from './shared.js';

export const entry = builtin(
  'feedback',
  'Website feedback',
  'developer',
  'Bug reports from your website, looked at by the agent.',
  null,
) satisfies CatalogEntryInput;
