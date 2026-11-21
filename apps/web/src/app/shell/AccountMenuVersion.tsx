import { Link } from '@tanstack/react-router';
import { useWhombatVersions, versionLine } from '../../features/settings/version';
import styles from './AccountMenuVersion.module.css';

/**
 * The account menu's last line (docs/decisions/settings-simplify.md SS-08): “Whombat 0.41.1 · app 0.36.0” in muted mono
 * (“app 0.36.0” while the Whombat's version is unknown), a link to Settings → This Whombat → About, where VERSION says
 * more (this-whombat-sections.md AP-1233).
 * Read when the menu opens (it mounts with it).
 */
export function AccountMenuVersion({ onNavigate }: { onNavigate?: () => void }) {
  const line = versionLine(useWhombatVersions());
  return (
    <Link
      to="/settings"
      search={{ tab: 'appliance', section: 'about' }}
      className={styles.version}
      onClick={onNavigate}
      aria-label={`${line}. This Whombat`}
      data-account-version=""
    >
      {line}
    </Link>
  );
}
