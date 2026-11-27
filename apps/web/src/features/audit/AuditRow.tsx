import { WhombatAvatar } from '@whombat/avatars/react';
import { agentFaceOf, appPath } from '@whombat/client';
import type { AuditDisplayContext, AuditEvent, AuditTone, Principal } from '@whombat/core';
import { auditFields, auditLinkLabel, auditMeta, auditPill, auditTag, formatClock } from '@whombat/core';
import { vaultAuditDetailText } from '@whombat/core/vault';
import { Button } from '../../components/Button';
import { Tag, type TagTone } from '../../components/Tag';
import { useWebI18n } from '../../i18n/provider';
import { PersonAvatar } from '../messaging/PersonAvatar';
import styles from './AuditRow.module.css';

/** `AuditTone` has a `neutral` state Tag's `TagTone` doesn't; the mock renders it as plain ink. */
function toTagTone(tone: AuditTone): TagTone {
  return tone === 'neutral' ? 'ink' : tone;
}

export interface AuditRowProps {
  event: AuditEvent;
  /** Actor's full principal (avatar role/tone/initials); `ctx.principal` only carries display text. */
  actor?: Principal;
  ctx: AuditDisplayContext;
  open: boolean;
  onToggle: () => void;
  onNavigate: (href: string) => void;
}

/** One audit log row: `[48px time · 28px avatar · content · pill]`, expandable to the signed detail. */
export function AuditRow({ event, actor, ctx, open, onToggle, onNavigate }: AuditRowProps) {
  const { tag: uiLocale } = useWebI18n();
  const info = ctx.principal(event.actorId);
  const name = info?.name ?? 'Someone';
  const tag = auditTag(info ?? { kind: 'person', name: 'Someone', shortName: 'Someone' }, uiLocale);
  const pill = auditPill(event, ctx);
  const link = event.ref;
  const linkLabel = link ? auditLinkLabel(link, { approvalPending: pill?.tone === 'warn' }) : null;

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.row} onClick={onToggle} aria-expanded={open}>
        <span className={styles.time}>{formatClock(event.createdAt, ctx.timeZone)}</span>
        {actor?.kind === 'agent' ? (
          <WhombatAvatar face={agentFaceOf(actor)} crop="head" size={28} label={actor.name} />
        ) : actor?.kind === 'person' ? (
          <PersonAvatar
            avatarUrl={actor.avatarUrl}
            initials={actor.initials}
            tone={actor.tone}
            size={28}
            label={actor.name}
          />
        ) : (
          <span className={styles.avatarPlaceholder} aria-hidden="true" />
        )}
        <span className={styles.content}>
          <span className={styles.nameRow}>
            <span className={styles.name}>{name}</span>
            <Tag>{tag}</Tag>
          </span>
          {/* Which entry and what was done (vault.md VT-52), else the signed text. */}
          <span className={styles.text}>{vaultAuditDetailText(event) ?? event.text ?? ''}</span>
          <span className={styles.meta}>{auditMeta(event)}</span>
        </span>
        {pill && (
          <Tag variant="outline" tone={toTagTone(pill.tone)} className={styles.pill}>
            {pill.text}
          </Tag>
        )}
      </button>
      {open && (
        <div className={styles.detail}>
          <div className={styles.fields}>
            {auditFields(event, ctx).map((field) => (
              <div key={field.label} className={styles.field}>
                <span className={styles.fieldLabel}>{field.label}</span>
                <span className={styles.fieldValue} style={{ color: `var(--${toTagTone(field.tone)})` }}>
                  {field.value}
                </span>
              </div>
            ))}
          </div>
          {link && linkLabel && (
            <Button
              variant="secondary"
              size="sm"
              className={styles.linkButton}
              onClick={() => onNavigate(appPath(link))}
            >
              {linkLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
