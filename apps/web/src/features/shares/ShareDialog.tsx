/**
 * The Share sheet (docs/decisions/share-links.md): what the link will show, the pictures and how long it works, what to
 * look at first; then the link with Copy. Opened from a Chat thread's head (the whole thread) or a message's menu
 * (from that message on).
 */
import {
  SHARE_EXPIRY_OPTIONS,
  SHARE_TEXT,
  shareContents,
  shareReadyLine,
  shareWarningText,
} from '@whombat/client';
import { shareErrorText, useCreateShare, useSharePreview } from '@whombat/client/react';
import type { SharedLink, ShareScope } from '@whombat/core';
import { SHARE_DEFAULT_EXPIRY, type ShareExpiry } from '@whombat/core/share';
import { useEffect, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SegmentedControl } from '../../components/SegmentedControl';
import { ToggleRow } from '../../components/Toggle';
import styles from './ShareDialog.module.css';

export interface ShareDialogProps {
  burrow: string;
  /** The thread (and the message it starts from); null: closed. */
  scope: ShareScope | null;
  onClose: () => void;
}

export function ShareDialog({ burrow, scope, onClose }: ShareDialogProps) {
  const preview = useSharePreview(burrow, scope);
  const create = useCreateShare(burrow);
  const [pictures, setPictures] = useState(true);
  const [expiry, setExpiry] = useState<ShareExpiry>(SHARE_DEFAULT_EXPIRY);
  const [made, setMade] = useState<SharedLink | null>(null);
  const linkId = useId();
  const open = scope !== null;
  useEffect(() => {
    if (!open) {
      setMade(null);
      setPictures(true);
      setExpiry(SHARE_DEFAULT_EXPIRY);
      create.reset();
    }
  }, [open, create.reset]);
  const p = preview.data;
  // Too big with its pictures: the sheet turns them off and says why.
  const fitsWithPictures = p?.fits.withPictures ?? true;
  const keepPictures = pictures && fitsWithPictures && (p?.pictures ?? 0) > 0;
  const canCreate = !!p && p.messages > 0 && (keepPictures ? p.fits.withPictures : p.fits.withoutPictures);
  const submit = () => {
    if (!scope || !canCreate) return;
    create.mutate({ ...scope, pictures: keepPictures, expiry }, { onSuccess: setMade });
  };
  const title = made ? SHARE_TEXT.readyTitle : scope?.fromMessageId ? SHARE_TEXT.fromHere : SHARE_TEXT.title;
  return (
    <Modal open={open} onOpenChange={(o) => !o && !create.isPending && onClose()} width="md">
      {open && (
        <div className={styles.form} data-share-dialog="">
          <div className={styles.heading}>
            <ModalTitle className={styles.title}>{title}</ModalTitle>
            <ModalDescription className={styles.description}>
              {made
                ? shareReadyLine(made)
                : p
                  ? `“${p.title}” · ${shareContents(p, keepPictures)}`
                  : preview.isError
                    ? shareErrorText(preview.error, SHARE_TEXT.failed)
                    : '…'}
            </ModalDescription>
          </div>

          {made ? (
            <>
              <div className={styles.linkRow}>
                <label htmlFor={linkId} className={styles.srOnly}>
                  The link
                </label>
                <input
                  id={linkId}
                  className={styles.link}
                  readOnly
                  value={made.url}
                  onFocus={(e) => e.currentTarget.select()}
                  data-share-url=""
                />
                <CopyButton text={made.url} copied={SHARE_TEXT.copied} className={styles.copy}>
                  {SHARE_TEXT.copy}
                </CopyButton>
              </div>
              <p className={styles.note}>{SHARE_TEXT.frozen}</p>
              <div className={styles.actions}>
                <ModalClose asChild>
                  <Button variant="primary" size="xl" padX={20}>
                    {SHARE_TEXT.done}
                  </Button>
                </ModalClose>
              </div>
            </>
          ) : (
            <>
              {p && p.pictures > 0 && (
                <ToggleRow
                  label={SHARE_TEXT.pictures}
                  checked={keepPictures}
                  onCheckedChange={setPictures}
                  locked={!fitsWithPictures}
                  note={fitsWithPictures ? undefined : SHARE_TEXT.noPicturesFit}
                />
              )}
              <div className={styles.field}>
                <span className={styles.fieldLabel} id={`${linkId}-expiry`}>
                  {SHARE_TEXT.expiry}
                </span>
                <SegmentedControl
                  label={SHARE_TEXT.expiry}
                  describedBy={`${linkId}-expiry`}
                  value={expiry}
                  onChange={setExpiry}
                  options={SHARE_EXPIRY_OPTIONS}
                />
              </div>
              {p && p.warnings.length > 0 && (
                <section className={styles.warnings} aria-label={SHARE_TEXT.lookFirst} data-share-warnings="">
                  <h3 className={styles.warningsTitle}>{SHARE_TEXT.lookFirst}</h3>
                  <ul className={styles.warningList}>
                    {p.warnings.map((w) => (
                      <li key={w.kind}>{shareWarningText(w)}</li>
                    ))}
                  </ul>
                </section>
              )}
              {p && !p.fits.withoutPictures && <p className={styles.error}>{SHARE_TEXT.tooBig}</p>}
              <p className={styles.note}>
                {SHARE_TEXT.privacy}
                {p && p.leftOut > 0 ? ` ${SHARE_TEXT.leftOutNote(p.leftOut)}` : ''}
              </p>
              {create.isError && (
                <p className={styles.error} role="alert">
                  {shareErrorText(create.error, SHARE_TEXT.failed)}
                </p>
              )}
              <div className={styles.actions}>
                <ModalClose asChild>
                  <Button variant="secondary" size="xl" disabled={create.isPending}>
                    {SHARE_TEXT.cancel}
                  </Button>
                </ModalClose>
                <Button
                  variant="primary"
                  size="xl"
                  padX={20}
                  onClick={submit}
                  disabled={!canCreate || create.isPending}
                  data-share-create=""
                >
                  {create.isPending ? SHARE_TEXT.creating : SHARE_TEXT.create}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
