/**
 * A service's settings copy on its page (docs/decisions/outside-changes.md): “Settings copy · last night” with Download,
 * or why the last try didn't work; and the line “Whombat can’t copy OPNsense’s settings any more” once a copy worked
 * before and none has for two days. Said in the box's language.
 */

import type { SettingsCopyView } from '@whombat/core';
import { formatLocaleOf } from '@whombat/core/i18n';
import { count, desc, eq } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../../connections/types';
import { settingsCopies, settingsCopyStates } from '../../db/schema/index';
import { serverTranslator } from '../../i18n/catalog';
import type { Services } from '../../services';
import type { KindNotice } from '../../things/quiet/types';
import { copyServiceOf, SETTINGS_COPY_CHECK } from './index';
import { COPY_PROBLEMS, type CopyProblem } from './types';

const H = 60 * 60_000;
/** No copy for this long while tries fail: the line comes. */
export const COPY_FAILING_LINE_MS = 48 * H;

const day = (d: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);

/** “last night”, “today 14:05”, “Tue 25 Nov”: when a copy was made or found the same, at the box's clock. */
export function copyWhen(at: Date, now: Date, timeZone: string, locale: string): string {
  const tr = serverTranslator(locale);
  const hour = Number.parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(at),
    10,
  );
  const today = day(at, timeZone) === day(now, timeZone);
  const yesterday = day(at, timeZone) === day(new Date(now.getTime() - 24 * H), timeZone);
  if ((today && hour < 7) || (yesterday && hour >= 20)) return tr.t('changes.copy.lastNight');
  if (today)
    return tr.t('changes.copy.today', {
      time: new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(at),
    });
  return new Intl.DateTimeFormat(formatLocaleOf(locale), {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
    .format(at)
    .replace(',', '');
}

const isProblem = (p: string | null): p is CopyProblem =>
  !!p && (COPY_PROBLEMS as readonly string[]).includes(p);

export interface SettingsCopyShown {
  view: SettingsCopyView;
  /** “Settings copy failing”, when it is time for it. */
  line: KindNotice | null;
}

/** A connection's settings copy for its page and its health pass; null for a service Whombat doesn't copy. */
export async function settingsCopyOf(
  services: Services,
  row: Pick<CatalogConnectionRow, 'id' | 'catalogId'>,
  now: Date,
  timeZone: string,
  locale: string,
): Promise<SettingsCopyShown | null> {
  const service = copyServiceOf(row.catalogId);
  if (!service) return null;
  const tr = serverTranslator(locale);
  const [[latest], [kept], [state]] = await Promise.all([
    services.db
      .select({
        id: settingsCopies.id,
        fileName: settingsCopies.fileName,
        size: settingsCopies.size,
        checkedAt: settingsCopies.checkedAt,
      })
      .from(settingsCopies)
      .where(eq(settingsCopies.connectionId, row.id))
      .orderBy(desc(settingsCopies.madeAt))
      .limit(1),
    services.db.select({ n: count() }).from(settingsCopies).where(eq(settingsCopies.connectionId, row.id)),
    services.db.select().from(settingsCopyStates).where(eq(settingsCopyStates.connectionId, row.id)),
  ]);
  const name = service.name;
  const failing = !!state?.failedSince;
  const code: CopyProblem = isProblem(state?.problem ?? null)
    ? (state?.problem as CopyProblem)
    : 'unreachable';
  const problem = failing ? tr.t(`changes.copy.problem.${code}`, { service: name }) : null;
  const view: SettingsCopyView = {
    service: name,
    title: latest
      ? tr.t('changes.copy.title', { when: copyWhen(latest.checkedAt, now, timeZone, locale) })
      : tr.t('changes.copy.none'),
    detail: (problem
      ? tr.t('changes.copy.failed', { problem })
      : latest
        ? tr.t('changes.copy.holds', { service: name })
        : tr.t('changes.copy.first', { service: name })
    ).slice(0, 300),
    ...(latest ? { copyId: latest.id, fileName: latest.fileName.slice(0, 120), size: latest.size } : {}),
    ...(latest ? { at: latest.checkedAt.toISOString() } : {}),
    kept: Math.min(kept?.n ?? 0, 10),
    failing,
  };
  const lastOk = state?.okAt ?? latest?.checkedAt ?? null;
  const line: KindNotice | null =
    failing && latest && lastOk && now.getTime() - lastOk.getTime() >= COPY_FAILING_LINE_MS
      ? {
          id: 'settings-copy',
          tone: 'warn',
          icon: 'backup',
          title: tr.t('changes.copy.lineTitle', { service: name }).slice(0, 120),
          detail: tr
            .t('changes.copy.lineDetail', {
              when: copyWhen(lastOk, now, timeZone, locale),
              problem: problem ?? '',
            })
            .slice(0, 200),
          nature: SETTINGS_COPY_CHECK.nature,
          check: SETTINGS_COPY_CHECK.check,
          ignore: { lifts: 'fixed', words: tr.t('changes.copy.ignore').slice(0, 60) },
        }
      : null;
  return { view, line };
}
