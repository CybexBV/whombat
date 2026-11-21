// Overview card of the checks, only when there are any: status, name, 24 h
// uptime and latency. Down ones first; the page in Settings has the rest.

import { Link } from 'react-router';
import { useChecks } from '../../api/queries';
import { Sparkline } from '../../components/Sparkline';
import { plural } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { formatUptime, sortChecks } from './checkForm';
import { StatusDot } from './ChecksPage';

const SHOWN = 8;

export function ChecksCard() {
  const checks = useChecks();
  const list = sortChecks(checks.data ?? []);
  if (!list.length) return null;
  const down = list.filter((c) => c.status === 'down').length;
  return (
    <section className="card" aria-labelledby="checks-title">
      <div className="card-head">
        <h2 className="h2" id="checks-title">
          {t('Checks')}
        </h2>
        <span className="sub">
          {down ? `${t('{down} down', { down })} · ` : ''}
          {plural(list.length, 'check')} · <Link to="/settings/checks">{t('All checks')}</Link>
        </span>
      </div>
      <div className="gt-scroll">
        <table className="gt checks-mini">
          <thead className="sr-only">
            <tr>
              <th scope="col">{t('Status')}</th>
              <th scope="col">{t('Check')}</th>
              <th scope="col">{t('Uptime 24 h')}</th>
              <th scope="col">{t('Latency 24 h')}</th>
            </tr>
          </thead>
          <tbody>
            {list.slice(0, SHOWN).map((c) => (
              <tr key={c.id} className={c.status === 'disabled' ? 'is-stopped' : undefined}>
                <td className="first">
                  <StatusDot c={c} />
                </td>
                <td>
                  <div className="n">{c.name}</div>
                </td>
                <td className="num ink-2">{formatUptime(c.uptime_24h)}</td>
                <td className="last">
                  {c.latency_24h.some((v) => v != null) && (
                    <span className="sparkcell">
                      <Sparkline values={c.latency_24h} color="var(--series-cpu)" height={20} />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > SHOWN && (
        <div className="lbl guests-foot">
          {tx('{n} more in {link}', { n: list.length - SHOWN, link: <Link to="/settings/checks">{t('Settings › Checks')}</Link> })}
        </div>
      )}
    </section>
  );
}
