/**
 * Bringing things back from one backup (app backup-look.md AP-6940…AP-6946; Whombat backup-look.md): opened from a
 * backup's page. The backup opens (a short wait that says so), its categories show with how many things each has, a
 * category lists its things (searchable; each says when and where it was, and whether it is here already), the person
 * picks, “Bring back” brings them back — only adding — and a line says how it went; Close closes the backup.
 */
import {
  lookCategoryName,
  lookCategoryRows,
  lookDoneLine,
  lookItemMeta,
  lookProblemText,
  lookStage,
  togglePick,
} from '@whombat/client/managed';
import { useBackupLook, useBackupLookItems, useBringBack } from '@whombat/client/react';
import type { BackupCheckpoint, BackupLookCategory } from '@whombat/protocol/session';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { SkeletonRows } from '../../components/ListState';
import { Modal, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { BACKUP_LOOK_TEXT } from '../../i18n/clientWords';
import { currentLocale } from '../../i18n/provider';
import { backupErrorText } from './BackupDestination';
import styles from './BringBack.module.css';
import { backupWhen } from './backupOptionsModel';

const T = BACKUP_LOOK_TEXT;

export function BringBack({
  checkpoint,
  open,
  onClose,
}: {
  checkpoint: Pick<BackupCheckpoint, 'id' | 'createdAt'>;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()}>
      {open ? <BringBackFlow checkpoint={checkpoint} onClose={onClose} /> : null}
    </Modal>
  );
}

function BringBackFlow({
  checkpoint,
  onClose,
}: {
  checkpoint: Pick<BackupCheckpoint, 'id' | 'createdAt'>;
  onClose: () => void;
}) {
  const { session } = useAppServices();
  const { look, categories, error, retry } = useBackupLook(session, checkpoint.id);
  const [category, setCategory] = useState<BackupLookCategory | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const bring = useBringBack(session);
  const stage = lookStage(look);
  const lookId = look?.lookId ?? null;
  const items = useBackupLookItems(session, stage === 'ready' ? lookId : null, category, query);
  const done = look?.bring && !bring.isPending ? lookDoneLine(look.bring, currentLocale()) : null;
  const finishedAt = look?.bring?.finishedAt ?? null;
  const [shown, setShown] = useState(false);
  // Each bring-back's line replaces the list until the person asks to bring back more.
  useEffect(() => {
    if (finishedAt) setShown(true);
  }, [finishedAt]);

  const problem = error ? backupErrorText(error) : lookProblemText(look, currentLocale());
  return (
    <div className={styles.flow} data-bring-back={checkpoint.id}>
      <div className={styles.head}>
        <ModalTitle className={styles.title}>{T.title}</ModalTitle>
        <p className={styles.lead}>{backupWhen(checkpoint.createdAt)}</p>
      </div>

      {problem ? (
        <>
          <p className={styles.problem} role="alert">
            {problem}
          </p>
          <div className={styles.actions}>
            {look?.problem?.code !== 'not_supported' ? (
              <Button variant="primary" size="lg" block onClick={retry}>
                {T.tryAgain}
              </Button>
            ) : null}
            <Button variant="secondary" size="lg" block onClick={onClose}>
              {T.close}
            </Button>
          </div>
        </>
      ) : stage === 'opening' ? (
        <div className={styles.opening} role="status">
          <p className={styles.openingTitle}>{T.opening}</p>
          <p className={styles.note}>{T.openingLead}</p>
          <SkeletonRows count={3} lines={1} />
        </div>
      ) : shown && done ? (
        <>
          <p className={styles.done} role="status" data-bring-done>
            {done}
          </p>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              size="lg"
              block
              onClick={() => {
                setShown(false);
                setPicked(new Set());
                setCategory(null);
                setQuery('');
              }}
            >
              {T.pickMore}
            </Button>
            <Button variant="primary" size="lg" block onClick={onClose}>
              {T.close}
            </Button>
          </div>
        </>
      ) : category === null ? (
        <>
          <p className={styles.note}>{T.pickLead}</p>
          <SectionLabel as="h3">{T.inIt}</SectionLabel>
          {categories.length === 0 ? (
            <p className={styles.note}>{T.empty}</p>
          ) : (
            <ul className={styles.list} aria-label={T.inIt}>
              {lookCategoryRows(categories, currentLocale()).map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={styles.category}
                    data-look-category={c.id}
                    onClick={() => {
                      setCategory(c.id);
                      setQuery('');
                    }}
                  >
                    <span className={styles.categoryName}>{c.name}</span>
                    <span className={styles.count}>{c.count}</span>
                    <span className={styles.chevron} aria-hidden="true">
                      <Icon icon={ChevronRight} size={16} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <BringButton
            count={picked.size}
            busy={bring.isPending}
            onBring={() => lookId && bring.mutate({ lookId, items: [...picked] })}
          />
        </>
      ) : (
        <>
          <Button
            variant="ghost"
            size="sm"
            className={styles.back}
            iconStart={<Icon icon={ChevronLeft} size={15} />}
            onClick={() => setCategory(null)}
          >
            {T.inIt}
          </Button>
          <SectionLabel as="h3">{lookCategoryName(category, currentLocale())}</SectionLabel>
          <Input
            type="search"
            value={query}
            placeholder={T.search(lookCategoryName(category, currentLocale()))}
            aria-label={T.search(lookCategoryName(category, currentLocale()))}
            onChange={(e) => setQuery(e.target.value)}
          />
          {items.loading ? (
            <SkeletonRows count={3} lines={2} />
          ) : items.items.length === 0 ? (
            <p className={styles.note}>{query.trim() ? T.noMatch : T.empty}</p>
          ) : (
            <ul className={styles.list} aria-label={lookCategoryName(category, currentLocale())}>
              {items.items.map((item) => {
                const meta = lookItemMeta(item, undefined, currentLocale());
                return (
                  <li key={item.id}>
                    <label className={styles.item} data-look-item={item.id}>
                      <input
                        type="checkbox"
                        checked={picked.has(item.id)}
                        onChange={() => setPicked((p) => togglePick(p, item.id))}
                      />
                      <span className={styles.itemMain}>
                        <span className={styles.itemTitle}>{item.title}</span>
                        {meta ? <span className={styles.itemMeta}>{meta}</span> : null}
                      </span>
                      {item.here ? <span className={styles.here}>{T.here}</span> : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {items.more ? (
            <Button variant="secondary" size="md" onClick={items.more}>
              {T.more}
            </Button>
          ) : null}
          <BringButton
            count={picked.size}
            busy={bring.isPending}
            onBring={() => lookId && bring.mutate({ lookId, items: [...picked] })}
          />
        </>
      )}
      {bring.error ? (
        <p className={styles.problem} role="alert">
          {backupErrorText(bring.error)}
        </p>
      ) : null}
    </div>
  );
}

function BringButton({ count, busy, onBring }: { count: number; busy: boolean; onBring: () => void }) {
  return (
    <div className={styles.actions}>
      <Button variant="primary" size="lg" block disabled={count === 0 || busy} onClick={onBring}>
        {busy ? T.bringing : T.bring(count)}
      </Button>
    </div>
  );
}
