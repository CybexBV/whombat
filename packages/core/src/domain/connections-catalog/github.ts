import { builtin, type CatalogEntryInput } from './shared.js';

export const entry = builtin(
  'github',
  'GitHub',
  'developer',
  'Repositories, pull requests and checks for this Whombat.',
  'https://docs.github.com',
) satisfies CatalogEntryInput;
