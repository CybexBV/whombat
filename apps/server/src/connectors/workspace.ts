/**
 * Google's services behind the connector tools (`GoogleWorkspace`, types.ts), picked by `WHOMBAT_GOOGLE`:
 * the real adapter (`workspace-real.ts`: plain `fetch` against *.googleapis.com, only `GOOGLE_HOSTS`), the
 * in-memory fake (`workspace-fake.ts`) for tests and the demo, or nothing (`off`).
 */
import type { GoogleMode } from '@whombat/core';
import { GoogleApiError, type GoogleWorkspace } from './types';
import { FakeGoogleWorkspace } from './workspace-fake';
import { RealGoogleWorkspace } from './workspace-real';

const METHODS = [
  'mailAttachment',
  'filesDownload',
  'filesOrganize',
  'checkService',
  'mailSearch',
  'mailRead',
  'mailDraft',
  'mailGetDraft',
  'mailSendDraft',
  'mailOrganize',
  'mailTrash',
  'calendarEvents',
  'calendarGetEvent',
  'calendarCreateEvent',
  'calendarUpdateEvent',
  'calendarDeleteEvent',
  'filesSearch',
  'filesGet',
  'filesRead',
  'filesCreate',
  'filesShare',
  'filesTrash',
  'docsEdit',
  'sheetsRead',
  'sheetsWrite',
  'contactsSearch',
  'inboxUnread',
  'mailBaseline',
  'mailChanges',
] as const satisfies readonly (keyof GoogleWorkspace)[];

/** `WHOMBAT_GOOGLE=off`: every method rejects (the tools refuse before calling). */
export function offGoogleWorkspace(): GoogleWorkspace {
  return Object.fromEntries(
    METHODS.map((name) => [
      name,
      async () => {
        throw new GoogleApiError(503, 'Google is turned off on this Whombat.', 'other');
      },
    ]),
  ) as unknown as GoogleWorkspace;
}

/** The `GoogleWorkspace` for a mode. */
export function createGoogleWorkspace(mode: GoogleMode, now?: () => Date): GoogleWorkspace {
  if (mode === 'real') return new RealGoogleWorkspace();
  if (mode === 'fake') return new FakeGoogleWorkspace(now);
  return offGoogleWorkspace();
}
