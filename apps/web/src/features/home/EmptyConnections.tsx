/**
 * Connections with nothing in it yet (Whombat first-day.md): no empty sections, one clear next step — Add a connection,
 * whose page opens with what the network scan found at its top (connections-page.md AP-3804). The assistant also says
 * in Chat what it found.
 */
import { useNavigate } from '@tanstack/react-router';
import { useTheAgent } from '@whombat/client/react';
import { Plus } from 'lucide-react';
import { ButtonLink } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { useWebI18n } from '../../i18n/provider';
import styles from './EmptyConnections.module.css';

export const EMPTY_CONNECTIONS_WORDS = {
  title: 'Nothing connected yet',
  body: (assistant: string) =>
    `Connect Home Assistant, your router, a NAS or a server, and ${assistant} keeps an eye on it. It starts with what it found on your network.`,
  add: 'Add a connection',
} as const;

export function EmptyConnections({ burrow }: { burrow: string }) {
  const { words } = useTheAgent(burrow);
  const navigate = useNavigate();
  const { t } = useWebI18n();
  return (
    <section className={styles.empty} aria-labelledby="conn-empty">
      <h2 id="conn-empty" className={styles.title}>
        {t('overview.empty.title')}
      </h2>
      <p className={styles.body}>{t('overview.empty.body', { assistant: words.Name })}</p>
      <div>
        <ButtonLink
          variant="primary"
          href="/settings?tab=connections&connection=add"
          iconStart={<Icon icon={Plus} size={15} />}
          onClick={(e) => {
            e.preventDefault();
            void navigate({ to: '/settings', search: { tab: 'connections', connection: 'add' } });
          }}
        >
          {t('sidebar.addConnection')}
        </ButtonLink>
      </div>
    </section>
  );
}
