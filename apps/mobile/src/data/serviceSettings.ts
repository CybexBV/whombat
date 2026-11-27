/**
 * A service's settings on the phone (Whombat service-settings.md SST-01…SST-10; mock service-dash-v2 screen 6): what the
 * `settings` panel, its Change sheet and a card's Ask draw, as plain data. A row is its name with who changed it last
 * under it (“Changed by Dusty yesterday”), then a switch, or its value with a chevron that opens the sheet, or its value
 * with “In Plex” that opens the service's own page. The sheet lists the choices with “Now” on the one it has; Change it
 * waits until another one is picked. Every change is the page's one `setting` button (`useThingButtons`); only Ask
 * needs the assistant. Pure; the screen parts are `screens/thing/Settings.tsx`.
 */
import type {
  ThingButtonValue,
  ThingPagePanel,
  ThingSetting,
  ThingSettingChoice,
  ThingSettingChoose,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

export type ThingSettingsPanel = Extract<ThingPagePanel, { kind: 'settings' }>;

export function settingsCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    changeIt: t('data.serviceSettings.changeIt'),
    askInstead: (assistant: string) => t('data.serviceSettings.askInstead', { assistant }),
    putBack: t('data.serviceSettings.putBack'),
    putBackDone: t('data.serviceSettings.putBackDone'),
    now: t('data.serviceSettings.now'),
    cancel: t('data.common.cancel'),
    /** What “Ask {assistant} instead” starts with (SST-09). */
    helpChoose: (setting: string, service: string) =>
      t('data.serviceSettings.helpChoose', { setting, service }),
    /** A card's Ask (SST-08). */
    ask: t('data.serviceSettings.ask'),
    askTitle: (assistant: string, title: string) => t('data.serviceSettings.askTitle', { assistant, title }),
    askElse: t('data.serviceSettings.askElse'),
    askHint: (title: string) => t('data.serviceSettings.askHint', { title }),
    /** TalkBack's hints on a row. */
    opensChoices: t('data.serviceSettings.opensChoices'),
    // The service's tag reads “In Plex” in both languages; the hint names only the service.
    opensElsewhere: (where: string) =>
      t('data.serviceSettings.opensElsewhere', { where: where.replace(/^In /, '') }),
    pickHint: t('data.serviceSettings.pickHint'),
  } as const;
}
export const SETTINGS_COPY = settingsCopy();

/** How a row looks on the right. */
export type SettingRowLook = 'switch' | 'choose' | 'elsewhere' | 'value';

export interface SettingRowView {
  id: string;
  label: string;
  /** Who changed it last, under the name: “Changed by Dusty yesterday”. */
  note: string | null;
  look: SettingRowLook;
  /** The words on the right (none for a switch): a choice's own short label (“8 Mbps”), else the row's value. */
  value: string | null;
  /** A switch's state now (what the person set while it settles). */
  on: boolean;
  /** “In Plex”. */
  tag: string | null;
  /** The service's own page for an `elsewhere` row. */
  url: string | null;
  /** Whether its switch or Change may be pressed (Look only: not, with `reason`). */
  allowed: boolean;
  reason: string | null;
  /** One line for TalkBack: “Quality outside your home, 8 Mbps. Changed by Dusty yesterday”. */
  spoken: string;
}

/** A switch's state: what the person set while it settles (`guess`), else the page's. */
export function settingOn(row: Pick<ThingSetting, 'on'>, guess: boolean | number | undefined): boolean {
  return typeof guess === 'boolean' ? guess : !!row.on;
}

/** The current choice of a sheet, if it is one of them. */
export function currentChoice(choose: ThingSettingChoose): ThingSettingChoice | null {
  if (choose.current === null) return null;
  return choose.choices.find((c) => sameChoice(c.value, choose.current)) ?? null;
}

/** Two choice values are the same whatever their type (a service says `20000` or `"20000"`). */
export function sameChoice(
  a: ThingButtonValue | null | undefined,
  b: ThingButtonValue | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

/** A row as the phone draws it (SST-01, SST-05); `guess` is a switch's state while it settles. */
export function settingRowView(row: ThingSetting, guess?: boolean | number): SettingRowView {
  const note = row.changed?.short ?? null;
  const base = { id: row.id, label: row.label, note, tag: null, url: null };
  const speak = (value: string | null) =>
    [row.label, value].filter(Boolean).join(', ') + (note ? `. ${note}` : '');
  if (row.toggle) {
    const on = settingOn(row, guess);
    return {
      ...base,
      look: 'switch',
      value: null,
      on,
      allowed: row.toggle.allowed,
      reason: row.toggle.allowed ? null : row.toggle.reason?.trim() || null,
      spoken: speak(null),
    };
  }
  if (row.choose) {
    // The phone has room for the choice's short words (“8 Mbps”), the web the row's (“Up to 8 Mbps”).
    const value = currentChoice(row.choose)?.label ?? row.value;
    return {
      ...base,
      look: 'choose',
      value,
      on: false,
      allowed: row.choose.button.allowed,
      reason: row.choose.button.allowed ? null : row.choose.button.reason?.trim() || null,
      spoken: speak(value),
    };
  }
  if (row.elsewhere) {
    return {
      ...base,
      look: 'elsewhere',
      value: row.value,
      on: false,
      tag: row.elsewhere.label,
      url: row.elsewhere.url ?? null,
      allowed: true,
      reason: null,
      spoken: speak(`${row.value}, ${row.elsewhere.label}`),
    };
  }
  return {
    ...base,
    look: 'value',
    value: row.value,
    on: false,
    allowed: true,
    reason: null,
    spoken: speak(row.value),
  };
}

/* The Change sheet (SST-09) --------------------------------------------------------------------------------------- */

export interface SettingChoiceView {
  key: string;
  value: ThingButtonValue;
  label: string;
  /** “· lighter on the machine”: after the label, muted. */
  note: string | null;
  /** The value it has now (“Now”). */
  now: boolean;
  spoken: string;
}

export interface SettingSheetView {
  title: string;
  help: string | null;
  hint: string | null;
  choices: SettingChoiceView[];
  /** What is picked when it opens: the value it has now. */
  initial: ThingButtonValue | null;
  /** While the change can be put back (SST-03). */
  changeId: string | null;
  /** “Dusty changed this yesterday from 4 Mbps.” */
  changed: string | null;
  allowed: boolean;
  reason: string | null;
}

export function settingSheet(row: ThingSetting, locale?: string): SettingSheetView | null {
  const choose = row.choose;
  if (!choose) return null;
  const nowWord = settingsCopy(locale).now;
  const choices = choose.choices.map((c) => {
    const now = sameChoice(c.value, choose.current);
    return {
      key: String(c.value),
      value: c.value,
      label: c.label,
      note: c.note?.trim() || null,
      now,
      spoken: [c.label, c.note?.trim(), now ? nowWord : null].filter(Boolean).join(', '),
    };
  });
  return {
    title: row.label,
    help: choose.help?.trim() || row.help?.trim() || null,
    hint: choose.hint?.trim() || null,
    choices,
    initial: choose.current,
    changeId: row.changed?.changeId ?? null,
    changed: row.changed?.text ?? null,
    allowed: choose.button.allowed,
    reason: choose.button.allowed ? null : choose.button.reason?.trim() || null,
  };
}

/** Change it is pressable once a choice other than the current one is picked, and the viewer may change it. */
export function canChange(sheet: SettingSheetView, picked: ThingButtonValue | null): boolean {
  if (!sheet.allowed || picked === null) return false;
  if (!sheet.choices.some((c) => sameChoice(c.value, picked))) return false;
  return !sameChoice(picked, sheet.initial);
}

/* A card's Ask (SST-08) -------------------------------------------------------------------------------------------- */

export interface PanelAskView {
  title: string;
  questions: string[];
  /** “Or ask something else…”: the Ask sheet with nothing typed. */
  other: string;
}

/** A panel's Ask, when it has one and a title to name it by. */
export function panelAsk(panel: ThingPagePanel, assistant: string, locale?: string): PanelAskView | null {
  const questions = panel.ask?.questions.filter((q) => q.trim()) ?? [];
  const title = 'title' in panel && typeof panel.title === 'string' ? panel.title.trim() : '';
  if (!questions.length || !title) return null;
  const copy = settingsCopy(locale);
  return { title: copy.askTitle(assistant, title), questions, other: copy.askElse };
}

/* Put it back in the toast (SST-03) -------------------------------------------------------------------------------- */

/** The press toast's button when the change can be put back. */
export function putBackAction(run: () => void, locale?: string): { label: string; onPress: () => void } {
  return { label: settingsCopy(locale).putBack, onPress: run };
}
