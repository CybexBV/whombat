/**
 * Settings → This Whombat → About → REACH (Whombat docs/decisions/whombat-link.md LNK-42, LNK-06; one-environment.md):
 * how this Whombat is reached, one row each, in the installer's words — Easy · Whombat Link in plain words (off with
 * the offer sentence, what it gives and Turn on; starting with the code and “Open app.whombat.com/link and enter
 * ABCD-EFGH”, asked again until it is on; on with Turn off, asked once; ending or ended with what still works), its
 * address, and Expert · Tailscale or Headscale with what to know (its full controls are the Overview's TAILSCALE). A
 * box before Link shows nothing. Every word is the client's `REACH_TEXT` and `REACH_CHOICE_TEXT`; `linkRowView` decides
 * the Link row.
 */
import {
  addressRowView,
  type LinkRowView,
  linkRowView,
  REACH_CHOICE_TEXT,
  REACH_TEXT,
  tailscaleRowView,
} from '@whombat/client/managed';
import { useId, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import styles from '../settings/SettingsScreen.module.css';
import tw from '../settings/ThisWhombat.module.css';
import m from './Machine.module.css';
import { ReachMore } from './ReachMore';
import { type Reach, useNow, useReach } from './useReach';

const T = REACH_TEXT;
const C = REACH_CHOICE_TEXT;

/** REACH, on a box's session; nothing on a box before Link. `onTailscale` opens the Overview's TAILSCALE. */
export function ReachSection({ onTailscale }: { onTailscale?: () => void }) {
  const { session } = useAppServices();
  const reach = useReach(session);
  const id = useId();
  const r = reach.reach;
  if (!r) return null;
  // The own address has its own section (ADDRESS) right below: here only that it comes with Link.
  const address = r.ownAddress ? null : addressRowView(r);
  const tailscale = tailscaleRowView(r.tailscale);
  return (
    // `#reach`: a connection that needs a secure address links here.
    <section className={styles.section} aria-labelledby={id} id="reach" data-reach="">
      <SectionLabel as="h2" id={id}>
        {T.section}
      </SectionLabel>
      <div className={styles.card}>
        {r.link ? <LinkRow reach={reach} /> : null}
        {address ? (
          <div className={styles.row} data-row="address">
            <StatusDot tone="mut" size={8} label={null} />
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{address.title}</span>
              <span className={styles.rowMeta}>{address.meta}</span>
            </span>
          </div>
        ) : null}
        {tailscale ? (
          <div className={styles.row} data-row="reach-tailscale">
            <StatusDot tone={tailscale.tone} size={8} label={null} />
            <span className={styles.rowMain}>
              <span className={m.reachKind}>{C.expert.label}</span>
              <span className={styles.rowTitle}>{T.tailscale.title}</span>
              <span className={styles.rowMeta}>
                {tailscale.title} · {tailscale.on ? T.tailscale.keyExpiry : C.expert.line}
              </span>
              {tailscale.on ? null : <ReachMore label={C.expert.more} points={C.expert.points} />}
            </span>
            {!tailscale.on && onTailscale ? (
              <Button
                variant={r.link?.state === 'grace' || r.link?.state === 'ended' ? 'primary' : 'secondary'}
                size="sm"
                onClick={onTailscale}
              >
                {T.tailscale.turnOn}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The Link row, its code while it starts, and Turn off asked once. */
export function LinkRow({ reach, offerLink = true }: { reach: Reach; offerLink?: boolean }) {
  const link = reach.reach?.link;
  const now = useNow(link?.state === 'starting' && !!link.pending);
  const [confirmOff, setConfirmOff] = useState(false);
  if (!link) return null;
  const v = linkRowView(link, { offerLink, now });
  const t = T.link;
  const action =
    v.action === 'on' || v.action === 'newCode' ? (
      <Button
        variant={v.action === 'newCode' ? 'primary' : 'secondary'}
        size="sm"
        disabled={reach.busy !== null}
        onClick={() => void reach.turnOn()}
      >
        {reach.busy === 'on' ? t.turningOn : v.action === 'newCode' ? t.newCode : t.turnOn}
      </Button>
    ) : v.action === 'off' || v.action === 'cancel' ? (
      <Button
        variant="secondary"
        size="sm"
        disabled={reach.busy !== null}
        onClick={() => (v.action === 'cancel' ? void reach.turnOff() : setConfirmOff(true))}
      >
        {v.action === 'cancel' ? t.cancel : reach.busy === 'off' ? t.turningOff : t.turnOff}
      </Button>
    ) : null;
  return (
    <>
      <div className={styles.row} data-row="link" data-link-state={v.state}>
        <StatusDot tone={v.tone} size={8} label={null} />
        <span className={styles.rowMain}>
          <span className={m.reachKind}>{C.easy.label}</span>
          <span className={styles.rowTitle} role="status">
            {v.title}
          </span>
          {v.code ? <LinkCodeLine view={v} /> : <span className={styles.rowMeta}>{v.meta}</span>}
          {v.more ? <ReachMore label={C.easy.more} points={C.easy.points} /> : null}
          {reach.error ? (
            <span className={styles.rowMeta} role="alert">
              {reach.error}
            </span>
          ) : null}
        </span>
        {action}
      </div>
      <Modal open={confirmOff} onOpenChange={(next) => setConfirmOff(next)} width="md">
        <div className={tw.dialog}>
          <div className={tw.dialogHead}>
            <ModalTitle className={tw.dialogTitle}>{t.offConfirm}</ModalTitle>
            <ModalDescription className={tw.dialogLead}>{t.offConfirmMeta}</ModalDescription>
          </div>
          <div className={tw.dialogActions}>
            <ModalClose asChild>
              <Button variant="secondary" size="lg">
                {t.cancel}
              </Button>
            </ModalClose>
            <Button
              variant="primary"
              size="lg"
              disabled={reach.busy !== null}
              onClick={() => void reach.turnOff().then((ok) => ok && setConfirmOff(false))}
            >
              {t.turnOff}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/** “Open app.whombat.com/link and enter ABCD-EFGH.” with the code big enough to read across a room, and the time left. */
export function LinkCodeLine({ view }: { view: LinkRowView }) {
  const code = view.code;
  if (!code) return null;
  const t = T.link;
  return (
    <>
      <span className={styles.rowMeta}>
        Open{' '}
        <a href={code.url} target="_blank" rel="noopener noreferrer">
          {code.where}
        </a>{' '}
        and enter
      </span>
      <span className={m.linkCode} data-testid="whombat-link-box-code">
        {code.code}
      </span>
      <span className={styles.rowMeta}>{code.left ? t.left(code.left) : t.codeOver}</span>
    </>
  );
}
