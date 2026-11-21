import { builtin, type CatalogEntryInput } from './shared.js';

export const entry = builtin(
  'microsoft',
  'Microsoft 365',
  'accounts',
  'Outlook mail and calendar, OneDrive and contacts, for the agent to use for you.',
  'https://learn.microsoft.com/graph/overview',
) satisfies CatalogEntryInput;
