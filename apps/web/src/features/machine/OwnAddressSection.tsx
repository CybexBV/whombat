/**
 * Settings → This Whombat → About → ADDRESS (Whombat own-address.md): the box's own
 * address with Copy, the owner's switch “Reach my Whombat's page from anywhere”, when its certificate ends, when
 * certificates were last checked and every stretch the watch couldn't check. A box without an own address (or before
 * 4.3) shows nothing. The words are the client's `OWN_ADDRESS_TEXT`; `ownAddressView` decides the lines.
 */
import {
  accountLinkErrorText,
  normalizeLinkCode,
  OWN_ADDRESS_TEXT,
  ownAddressView,
  readOwnAddress,
} from '@whombat/client/managed';
import { type ApplianceSession, type OwnAddressSummary, sessionOps } from '@whombat/client/session';
import { useEffect, useId, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { copyText } from '../../components/CopyButton';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import styles from '../settings/SettingsScreen.module.css';
import tw from '../settings/ThisWhombat.module.css';
import m from './Machine.module.css';
import { useReach } from './useReach';

const T = OWN_ADDRESS_TEXT.settings;

/** ADDRESS, on a box's session; nothing without an own address. */
export function OwnAddressSection() {
  const { session } = useAppServices();
  const [own, setOwn] = useState<OwnAddressSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const id = useId();
  const toast = useToast();
  // A box that knows Whombat Link answers `reach.get`; one before it doesn't.
  const withLink = useReach(session).reach?.link != null;

  useEffect(() => {
    let live = true;
    if (!session) return;
    readOwnAddress(session).then(
      (a) => live && setOwn(a),
      () => live && setOwn(null),
    );
    return () => {
      live = false;
    };
  }, [session]);

  if (!own || !session) return null;
  const v = ownAddressView(own);
  const reach = async (on: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      setOwn((await sessionOps.ownAddressReachSet(session, on)).ownAddress);
    } catch {
      setNote(T.failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={styles.section} aria-labelledby={id} data-own-address="">
      <SectionLabel as="h2" id={id}>
        {T.section}
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row} data-row="address">
          <StatusDot tone={v.tone} size={8} label={v.state} />
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{v.address}</span>
            <span className={styles.rowMeta} role="status">
              {v.state}
            </span>
          </span>
          <Button
            variant="secondary"
            size="sm"
            aria-label={`${T.copy} ${v.address}`}
            onClick={() => void copyText(v.url).then((ok) => ok && toast.show(T.copied))}
          >
            {T.copy}
          </Button>
        </div>
        <div className={styles.row} data-row="reach">
          <span className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor={`${id}-reach`}>
              {T.reach}
            </label>
            <span className={styles.rowMeta} id={`${id}-reach-hint`}>
              {note ?? T.reachMeta}
            </span>
          </span>
          <Toggle
            id={`${id}-reach`}
            checked={own.reachable}
            disabled={busy}
            aria-describedby={`${id}-reach-hint`}
            onCheckedChange={(next) => void reach(next)}
          />
        </div>
        {/* Linking with a code from the account is for a box before Whombat Link: REACH turns Link on now. */}
        {withLink ? null : (
          <div className={styles.row} data-row="link">
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{T.link}</span>
              <span className={styles.rowMeta}>{T.linkMeta}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => setLinking(true)}>
              {T.linkAction}
            </Button>
          </div>
        )}
        <div className={styles.row} data-row="certificate">
          <span className={styles.rowMain}>
            {v.certificate ? <span className={styles.rowTitle}>{v.certificate}</span> : null}
            <span className={styles.rowMeta}>{v.lastCheck}</span>
            {v.missed.map((line) => (
              <span key={line} className={styles.rowMeta} data-missed="">
                {line}
              </span>
            ))}
          </span>
        </div>
      </div>
      {linking ? <LinkDialog session={session} onClose={() => setLinking(false)} /> : null}
    </section>
  );
}

/**
 * Linking this Whombat to the person's account later (the setup's link step skipped): the code from app.whombat.com,
 * then “Link to <email>?” before anything is linked.
 */
function LinkDialog({ session, onClose }: { session: ApplianceSession; onClose: () => void }) {
  const t = OWN_ADDRESS_TEXT.link;
  const toast = useToast();
  const id = useId();
  const [typed, setTyped] = useState('');
  const [found, setFound] = useState<{ code: string; email: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const code = normalizeLinkCode(typed);
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      if (!found) {
        if (!code) return setProblem(t.errors.code);
        setFound({ code, email: (await sessionOps.accountLinkLookup(session, code)).email });
      } else {
        await sessionOps.accountLink(session, found.code);
        toast.show(t.linked(found.email));
        onClose();
      }
    } catch (error) {
      setProblem(accountLinkErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onOpenChange={(next) => (next ? null : onClose())} width="md">
      <form
        className={tw.dialog}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{found ? t.confirmTitle(found.email) : t.title}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>{found ? t.confirmSub : t.sub}</ModalDescription>
        </div>
        {found ? null : (
          <div className={m.fields}>
            <div className={m.field}>
              <label className={m.label} htmlFor={id}>
                {t.label}
              </label>
              <Input
                id={id}
                value={typed}
                placeholder={t.placeholder}
                autoComplete="one-time-code"
                spellCheck={false}
                invalid={problem !== null}
                onChange={(e) => {
                  setTyped(e.target.value.toUpperCase());
                  setProblem(null);
                }}
              />
            </div>
          </div>
        )}
        {problem ? (
          <span className={tw.dialogNote} role="alert">
            {problem}
          </span>
        ) : null}
        <div className={tw.dialogActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              {T.cancel}
            </Button>
          </ModalClose>
          <Button variant="primary" size="lg" type="submit" disabled={busy || (!found && !code)}>
            {found ? (busy ? t.linking : t.confirm) : busy ? t.checking : t.next}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
