/**
 * Reports to the Whombat Team on the phone (Whombat team-reports.md): the web's `/reports` addresses open the phone's
 * screens, in either path form, from a link, an Inbox item's link or a tapped notification.
 */
import { LinkRef } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  appScreenOfLink,
  appScreenUrlForPath,
  appUrlForPath,
  LINKING_SCREENS,
  notificationUrl,
  parseNotificationUrl,
  urlTarget,
} from './routes';

const REPORT = 'tr_AbCdEfGhIjKlMnOpQrSt';

describe('report addresses', () => {
  it('opens the list, the form and one report', () => {
    expect(appScreenUrlForPath('/reports')).toBe('whombat://reports');
    expect(appScreenUrlForPath('/reports/new')).toBe('whombat://reports/new');
    expect(appScreenUrlForPath(`/reports/${REPORT}`)).toBe(`whombat://reports/${REPORT}`);
    expect(appScreenUrlForPath(`/burrow-hq/reports/${REPORT}`)).toBe(`whombat://reports/${REPORT}`);
    expect(LINKING_SCREENS).toMatchObject({
      TeamReports: 'reports',
      TeamReportNew: 'reports/new',
      TeamReport: 'reports/:reportId',
    });
  });

  it('opens the form with the assistant’s draft, and drops one that isn’t a draft’s id', () => {
    expect(appScreenUrlForPath('/reports/new?draft=drf_12345678')).toBe(
      'whombat://reports/new?draftId=drf_12345678',
    );
    expect(appScreenUrlForPath('/reports?draft=drf_12345678')).toBe(
      'whombat://reports/new?draftId=drf_12345678',
    );
    expect(appScreenUrlForPath('/reports/new?draft=%3Cx%3E')).toBe('whombat://reports/new');
  });

  it('opens the list for anything else under /reports', () => {
    expect(appScreenUrlForPath('/reports/tr_short')).toBe('whombat://reports');
    expect(appScreenUrlForPath('/reports/%3Cscript%3E')).toBe('whombat://reports');
  });

  it('takes a push or an Inbox item about a report to it', () => {
    const tapped = parseNotificationUrl(
      notificationUrl({ path: `/reports/${REPORT}`, burrow: 'burrow-hq', notificationId: 'ntf_1' }),
    );
    expect(tapped?.url).toBe(`whombat://reports/${REPORT}`);
    expect(appUrlForPath(`/reports/${REPORT}`)).toBe(`whombat://reports/${REPORT}`);
    expect(urlTarget(`/reports/${REPORT}`, ['https://app.whombat.com'])).toEqual({
      kind: 'app',
      url: `whombat://reports/${REPORT}`,
      burrow: null,
      path: `/reports/${REPORT}`,
    });
    expect(urlTarget(`https://app.whombat.com/reports/${REPORT}`, ['https://app.whombat.com'])).toMatchObject(
      {
        kind: 'app',
        url: `whombat://reports/${REPORT}`,
      },
    );
  });

  it('opens a report from the push its Whombat sends, wherever that Whombat lives', () => {
    // The Whombat names the report's page by its path, never by an address of its own.
    const link = LinkRef.parse({ type: 'external', url: `/reports/${REPORT}` });
    const hosted = ['https://app.whombat.com'];
    expect(appScreenOfLink(link, hosted)).toBe(`whombat://reports/${REPORT}`);
    expect(appScreenOfLink(link, [])).toBe(`whombat://reports/${REPORT}`);
    // A box's own address isn't one the phone knows as the app's: such a link would open the Inbox instead.
    expect(
      appScreenOfLink({ type: 'external', url: `https://box.example.com/reports/${REPORT}` }, hosted),
    ).toBeNull();
    expect(appScreenOfLink({ type: 'dm' }, hosted)).toBeNull();
  });
});
