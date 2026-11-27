import { createLink, Link } from '@tanstack/react-router';
import { type AdvancedPart, type AdvancedRow, type AdvancedSection, advancedRowsHere } from '@whombat/client';
import { MANAGED_TEXT } from '@whombat/client/managed';
import { useBootstrap, useHostInfo, useTheAgent } from '@whombat/client/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useAppServices } from '../../app/providers';
import { ButtonLink } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { SectionLabel } from '../../components/SectionLabel';
import { useWebI18n } from '../../i18n/provider';
import { useSettingsGroupText } from '../../i18n/words';
import { AgentProfilePart } from '../agent/settings/AgentTab';
import { ModelTab } from '../agent/settings/ModelTab';
import { ServicesTab } from '../agent/settings/ServicesTab';
import { YourAi } from '../ai/YourAi';
import { SkillsLibraryTab } from '../skills';
import a from './Advanced.module.css';
import { DiagnosticsSection } from './ManagedTabs';
import { SigningKeyRow } from './ProfileTab';
import styles from './SettingsScreen.module.css';

const RouterButtonLink = createLink(ButtonLink);

const SECTIONS: readonly AdvancedSection[] = ['ai', 'work', 'whombat'];

export interface AdvancedTabProps {
  burrow: string;
  /** `&part=`: an expert page; Advanced's list without. */
  part?: AdvancedPart;
}

/**
 * Settings → **Advanced** (`?tab=advanced`; settings-groups.md): folded by default — a list of the expert
 * pages in three groups (the assistant's AI, its work, this Whombat), one line each, every one a page of its own at
 * `&part=` with the way back. Nothing here needs changing for Whombat to work: the model and effort, the AI programs,
 * the AI gateway and a model on your network, what it keeps running, its skills, the audit log with the signing keys,
 * and the diagnostics file. What anyone may want to see is elsewhere: the keys and the home network ranges in What it
 * may do, GitHub and Website feedback in Connections, its schedules in Automations, Spend in Usage.
 */
export function AdvancedTab({ burrow, part }: AdvancedTabProps) {
  const SETTINGS_GROUP_TEXT = useSettingsGroupText();
  const { tag: uiLocale } = useWebI18n();
  const { words } = useTheAgent(burrow);
  const { managed } = useAppServices();
  const host = useHostInfo({ params: { burrow } });
  const rows = advancedRowsHere(
    words.name,
    {
      managed: managed !== null,
      services: host.data ? !!host.data.services : undefined,
    },
    uiLocale,
  );
  const row = part ? rows.find((r) => r.key === part) : undefined;
  // Usage isn't offered anywhere on the web; its page still opens at its address for an old link.
  if (!row) return <AdvancedList rows={rows.filter((r) => r.key !== 'spend')} agent={words.name} />;
  return (
    <div className={a.page} data-advanced-part={row.key}>
      <Link to="/settings" search={{ tab: 'advanced' }} className={a.back}>
        <Icon icon={ChevronLeft} size={15} />
        {SETTINGS_GROUP_TEXT.advanced.back}
      </Link>
      <div className={a.head}>
        <h2 className={a.title}>{row.title}</h2>
        <p className={a.line}>{row.line}</p>
      </div>
      <AdvancedPage burrow={burrow} row={row} />
    </div>
  );
}

/** The list: a fold per group, a row per page (title, its line, a chevron). */
function AdvancedList({ rows, agent }: { rows: readonly AdvancedRow[]; agent: string }) {
  const SETTINGS_GROUP_TEXT = useSettingsGroupText();
  const ids = useId();
  const labels = SETTINGS_GROUP_TEXT.advanced.sections(agent);
  return (
    <div className={a.list} data-advanced-list="">
      <p className={a.intro}>{SETTINGS_GROUP_TEXT.advanced.intro}</p>
      {SECTIONS.map((section) => {
        const mine = rows.filter((r) => r.section === section);
        if (mine.length === 0) return null;
        return (
          <section key={section} className={styles.section} aria-labelledby={`${ids}-${section}`}>
            <SectionLabel as="h2" id={`${ids}-${section}`}>
              {labels[section]}
            </SectionLabel>
            <div className={styles.card}>
              {mine.map((r) => (
                <Link
                  key={r.key}
                  to="/settings"
                  search={{ tab: 'advanced', part: r.key }}
                  className={cx(styles.row, a.row)}
                  data-advanced-row={r.key}
                >
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>{r.title}</span>
                    <span className={styles.rowMeta}>{r.line}</span>
                  </span>
                  <span className={a.chevron} aria-hidden="true">
                    <Icon icon={ChevronRight} size={16} />
                  </span>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function AdvancedPage({ burrow, row }: { burrow: string; row: AdvancedRow }): ReactNode {
  const { words } = useTheAgent(burrow);
  switch (row.key) {
    case 'model':
      return (
        <AgentProfilePart burrow={burrow} part="model" label={row.title}>
          {(props) => <ModelTab {...props} />}
        </AgentProfilePart>
      );
    case 'ai':
      return <YourAi burrow={burrow} only="machine" />;
    // Usage is a page of its own (SettingsScreen draws it).
    case 'spend':
      return null;
    case 'running':
      return (
        <AgentProfilePart burrow={burrow} part="running" label={row.title}>
          {(props) => <ServicesTab {...props} />}
        </AgentProfilePart>
      );
    case 'skills':
      return <SkillsLibraryTab burrow={burrow} agent={{ name: words.name }} />;
    case 'audit':
      return <AuditPage burrow={burrow} />;
    case 'diagnostics':
      return <DiagnosticsSection />;
  }
}

/**
 * Audit log and signing keys: the way to the log — “Everything signed in {burrow}” — then the keys things are signed
 * with: yours, and this Whombat's fingerprint on a box.
 */
function AuditPage({ burrow }: { burrow: string }) {
  const ids = useId();
  const { managed } = useAppServices();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  return (
    <>
      <section className={styles.section} aria-labelledby={`${ids}-log`}>
        <SectionLabel as="h2" id={`${ids}-log`}>
          AUDIT LOG
        </SectionLabel>
        <div className={styles.card}>
          <div className={styles.row}>
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>Audit log</span>
              <span className={styles.rowMeta}>Everything signed in {bootstrap?.burrow.name ?? burrow}</span>
            </span>
            <RouterButtonLink variant="secondary" size="lg" to="/log" aria-label="Open the audit log">
              Open
            </RouterButtonLink>
          </div>
        </div>
      </section>
      <section className={styles.section} aria-labelledby={`${ids}-keys`}>
        <SectionLabel as="h2" id={`${ids}-keys`}>
          SIGNING KEYS
        </SectionLabel>
        <div className={styles.card}>
          <SigningKeyRow burrow={burrow} />
          {managed ? (
            <div className={styles.row} data-row="whombat-fingerprint">
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{managed.applianceName ?? 'Your Whombat'}</span>
                <span className={styles.rowMeta}>
                  {MANAGED_TEXT.connected} · {MANAGED_TEXT.fingerprint(managed.applianceFingerprint)}
                </span>
              </span>
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}
