import { builtin, type CatalogEntryInput } from './shared.js';

export const entry = builtin(
  'imap',
  'Email (IMAP)',
  'accounts',
  'Mail from any other provider, like Fastmail, iCloud or your own server, for the agent to use for you.',
  null,
) satisfies CatalogEntryInput;
