import { Link } from '@tanstack/react-router';
import { updateStateWords } from '@whombat/client/managed';
import { copyText } from '../../components/CopyButton';
import { cx } from '../../components/cx';
import { useToast } from '../../components/Toast';
import { menuVersion, type WhombatVersions } from '../../features/settings/version';
import { useWebI18n } from '../../i18n/provider';
import styles from './AccountMenuVersion.module.css';

/**
 * The account menu's last line, in muted mono: “Whombat 0.2.0” (the version without its build; “app 0.36.0” while the
 * Whombat's is unknown) and, on a box that says, “● Up to date” or “Update ready”, which opens This Whombat → About
 * where Update now is. The whole line (“Whombat 0.2.0-20261126… · app 3.171.0”) is its tooltip and its name, and a
 * click copies it for a report.
 */
export function AccountMenuVersion({
  versions,
  onNavigate,
}: {
  versions: WhombatVersions;
  onNavigate?: () => void;
}) {
  const { t, tag: uiLocale } = useWebI18n();
  const words = updateStateWords(uiLocale);
  const toast = useToast();
  const { short, full } = menuVersion(versions);
  return (
    <div className={styles.footer} data-account-version="">
      <button
        type="button"
        className={styles.version}
        title={full}
        aria-label={full}
        onClick={() =>
          void copyText(full).then((ok) =>
            toast.show(ok ? t('account.versionCopied') : t('common.copyDenied')),
          )
        }
      >
        {short}
      </button>
      {versions.update === 'ready' ? (
        <Link
          to="/settings"
          search={{ tab: 'appliance', section: 'about' }}
          className={cx(styles.state, styles.ready)}
          onClick={onNavigate}
          data-account-update="ready"
        >
          {words.ready}
        </Link>
      ) : versions.update === 'upToDate' ? (
        <span className={cx(styles.state, styles.upToDate)} data-account-update="up-to-date">
          <span aria-hidden="true">● </span>
          {words.upToDate}
        </span>
      ) : null}
    </div>
  );
}
