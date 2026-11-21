// Changes a running Proxmox guest takes only at the next restart: a banner
// above the configuration tabs with every waiting key (now → then) and
// Revert per key or for all of them (docs/MANAGE.md, Editing).

import type { GuestConfig } from '../../api/manage';
import type { Guest } from '../../api/types';
import { Icon } from '../../components/Icon';
import { t, tn } from '../../lib/i18n';
import { pendingKeys, shownValue } from './config';
import { useConfigChange } from './useConfigChange';

export function PendingBanner({ serverId, guest, config }: { serverId: string; guest: Guest; config: GuestConfig }) {
  const change = useConfigChange(serverId, guest, config);
  const keys = pendingKeys(config);
  if (!keys.length) return null;
  const revert = (ks: string[]) =>
    void change.apply(ks.length > 1 ? t('Revert {n} changes of {name}', { n: ks.length, name: guest.name }) : t('Revert {key} of {name}', { key: ks[0]!, name: guest.name }), { revert: ks }, { done: t('{name}: reverted.', { name: guest.name }) });
  return (
    <section className="card banner is-warning pending-banner" aria-labelledby="pending-title">
      <span className="warn-ic">
        <Icon name="clock" size={16} />
      </span>
      <h2 className="t" id="pending-title">
        {tn(keys.length, '{n} change applies at the next restart', '{n} changes apply at the next restart')}
      </h2>
      {keys.length > 1 && (
        <button type="button" className="btn-ghost row-action" disabled={change.busy} onClick={() => revert(keys)}>
          {t('Revert all')}
        </button>
      )}
      <ul className="plain-list pending-list" aria-label={t('Waiting for a restart')}>
        {keys.map((k) => {
          const removed = !(k in (config.pending ?? {}));
          return (
            <li key={k} className="pending-item">
              <span className="mono strong">{k}</span>
              <span className="pending-vals mono">
                {shownValue(k, config.values[k])} → {removed ? t('removed') : shownValue(k, config.pending?.[k])}
              </span>
              <button type="button" className="btn-ghost row-action" disabled={change.busy} onClick={() => revert([k])}>
                {t('Revert')}
                <span className="sr-only"> {k}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
