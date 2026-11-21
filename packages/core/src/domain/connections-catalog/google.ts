import { builtin, type CatalogEntryInput } from './shared.js';

export const entry = builtin(
  'google',
  'Google',
  'accounts',
  'Gmail, Calendar, Drive, Docs, Sheets and Contacts, for the agent to use for you.',
  'https://support.google.com/accounts',
) satisfies CatalogEntryInput;
