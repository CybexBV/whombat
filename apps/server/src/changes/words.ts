/**
 * A change's words from its facts, in the reader's language (docs/decisions/outside-changes.md): “Immich went from 2.3.0
 * to 2.4.0”, “Kernel updated to 6.12.1 and the server restarted”, “Proxy host photos.example.com now points to
 * http://10.100.0.12:2283”. Names and versions are the service's; every other word is Whombat's.
 */
import type { ChangeFact, SettingsPartChange } from '../db/schema/changes';
import { hasServerMessage, serverTranslator } from '../i18n/catalog';

const WORDS_MAX = 300;

/** “a, b, c and 2 more”: the names a combined change keeps, with how many more there were. */
function namesWords(locale: string | null | undefined, names: readonly string[], count: number): string {
  const tr = serverTranslator(locale);
  const shown = names.slice(0, 3);
  const list = shown.join(', ');
  return count > shown.length ? tr.t('changes.andMore', { names: list, count: count - shown.length }) : list;
}

/** Where a route goes, without the switched-off mark. */
const target = (v: string) => (v.startsWith('off:') ? v.slice(4) : v);
const isOff = (v: string) => v.startsWith('off:');

/** One part of a settings change: “firewall rules (2 added, 1 changed)”. */
function partWords(locale: string | null | undefined, p: SettingsPartChange): string {
  const tr = serverTranslator(locale);
  const key = `changes.part.${p.part}`;
  const name = hasServerMessage(key) ? tr.t(key) : tr.t('changes.part.other');
  const counts = [
    p.added ? tr.tp('changes.added', p.added) : null,
    p.removed ? tr.tp('changes.removed', p.removed) : null,
    p.changed ? tr.tp('changes.changed', p.changed) : null,
  ].filter((x): x is string => x !== null);
  return counts.length ? `${name} (${counts.join(', ')})` : name;
}

/** The words of one change, in `locale` (English when none). */
export function changeWords(fact: ChangeFact, locale?: string | null): string {
  const tr = serverTranslator(locale);
  const words = ((): string => {
    switch (fact.k) {
      case 'version':
        return tr.t('changes.version', { name: fact.name, from: fact.from, to: fact.to });
      case 'image':
        return fact.from === fact.to
          ? tr.t('changes.imageSameTag', { name: fact.name, to: fact.to })
          : tr.t('changes.image', { name: fact.name, from: fact.from, to: fact.to });
      case 'images':
        return tr.tp('changes.images', fact.count, { names: namesWords(locale, fact.names, fact.count) });
      case 'restart':
        return fact.kernel ? tr.t('changes.restartKernel', { kernel: fact.kernel }) : tr.t('changes.restart');
      case 'kernel':
        return tr.t('changes.kernel', { to: fact.to });
      case 'os':
        return tr.t('changes.os', { from: fact.from, to: fact.to });
      case 'packages':
        return tr.tp('changes.packages', fact.count);
      case 'firmware':
        return tr.t('changes.firmware', { device: fact.device, from: fact.from, to: fact.to });
      case 'firmwares': {
        const names = namesWords(locale, fact.devices, fact.count);
        return fact.to
          ? tr.tp('changes.firmwaresTo', fact.count, { names, to: fact.to })
          : tr.tp('changes.firmwares', fact.count, { names });
      }
      case 'route': {
        const what = tr.t(fact.via === 'proxy' ? 'changes.proxy' : 'changes.tunnel');
        const { host, from, to } = fact;
        if (to === null) return tr.t('changes.routeRemoved', { what, host });
        if (from === null) return tr.t('changes.routeAdded', { what, host, to: target(to) });
        if (target(from) === target(to) && isOff(from) !== isOff(to))
          return tr.t(isOff(to) ? 'changes.routeOff' : 'changes.routeOn', { what, host });
        return tr.t('changes.routeTo', { what, host, to: target(to) });
      }
      case 'routes': {
        const count = fact.added + fact.removed + fact.changed;
        const names = namesWords(locale, fact.hosts, count);
        return tr.tp(fact.via === 'proxy' ? 'changes.proxies' : 'changes.tunnels', count, { names });
      }
      case 'settings':
        return fact.parts.length
          ? tr.t('changes.settings', {
              service: fact.service,
              parts: fact.parts
                .slice(0, 4)
                .map((p) => partWords(locale, p))
                .join(', '),
            })
          : tr.t('changes.settingsSome', { service: fact.service });
    }
  })();
  return words.length > WORDS_MAX ? `${words.slice(0, WORDS_MAX - 1)}…` : words;
}
