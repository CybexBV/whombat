/**
 * “Asks you first” on a server's page (Whombat server-asks.md SA-01…SA-08; server-asks-mobile.md AP-1740…): one
 * setting per server, Before risky actions (the default) or Never, on a Whombat whose runtime has `hosts.asks`; the words are core's `HOST_ASKS_FIRST_WORDS`. Switching to Never asks first (it widens what Whombat
 * does); back to Before risky actions doesn't. On the server this Whombat runs on, Never adds that restarting or
 * shutting it down still asks (SA-03). Pure.
 */
import {
  HOST_ASKS_FIRST,
  HOST_ASKS_FIRST_DEFAULT,
  type HostAsksFirst,
  hostAsksFirstWords,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

export interface ServerAsksRow {
  /** “Asks you first” */
  label: string;
  value: HostAsksFirst;
  /** “Before risky actions” · “Never”, in core's order. */
  options: { value: HostAsksFirst; label: string }[];
  /** What the chosen value means. */
  hint: string;
  /** On Never, on the server this Whombat runs on: it still asks before restarting or shutting it down. */
  selfNote: string | null;
  /** The choice group's label for TalkBack: “Asks you first on thetitan”. */
  accessibilityLabel: string;
}

/** The row, or null where it isn't offered: a runtime without `hosts.asks` (an older Whombat wouldn't keep the setting). */
export function serverAsksRow(input: {
  server: string;
  asksFirst: HostAsksFirst | null | undefined;
  hostsThisWhombat: boolean | null | undefined;
  available: boolean;
  locale?: string | undefined;
}): ServerAsksRow | null {
  if (!input.available) return null;
  const value = input.asksFirst ?? HOST_ASKS_FIRST_DEFAULT;
  const w = hostAsksFirstWords(input.locale);
  return {
    label: w.label,
    value,
    options: HOST_ASKS_FIRST.map((v) => ({ value: v, label: w.choices[v] })),
    hint: w.hint[value],
    selfNote: value === 'never' && input.hostsThisWhombat ? w.selfNote(input.server) : null,
    accessibilityLabel: w.labelOn(input.server),
  };
}

export interface ServerAsksStep {
  /** The question before Never (SA-08); null when the change needs no confirm. */
  confirm: { title: string; body: string; confirm: string; cancel: string } | null;
  /** The note once it is saved: “thetitan: Whombat goes ahead without asking.” */
  toast: string;
}

/** What changing `from` to `to` takes, or null when nothing changes. */
export function serverAsksChange(
  server: string,
  from: HostAsksFirst,
  to: HostAsksFirst,
  locale?: string,
): ServerAsksStep | null {
  if (from === to) return null;
  const w = hostAsksFirstWords(locale);
  return {
    confirm:
      to === 'never'
        ? {
            title: w.confirmTitle(server),
            body: w.confirmBody(server),
            confirm: w.confirm,
            cancel: mobileTranslator(locale).t('data.common.cancel'),
          }
        : null,
    toast: w.changed(server, to),
  };
}
