/**
 * A Mac's Find My tab (docs/implementation/macos/findmy.md §5): the people Find My shows on the Mac, read through
 * Whombat Helper when the tab opens on an old read, every 15 minutes while it stays open and on “Read again”; a map the
 * Mac draws in the page's theme with each person's avatar on it, ＋ and − to zoom and “Fit everyone”; and for one person
 * “Show exactly”, Find My's own map cut from the Mac's screen, in a dialog. The screen's own reason (the Mac not checking
 * in, the shell switch, Screen Sharing, its password) comes first, as on the Screen tab.
 */
import { HUMAN_TONES, initialsFor } from '@whombat/avatars';
import { HumanAvatar } from '@whombat/avatars/react';
import {
  FIND_MY_WORDS,
  type FindMyPersonRow,
  type FindMyRegion,
  findMyCanZoom,
  findMyExactView,
  findMyMapAsk,
  findMyMapRegion,
  findMyPins,
  findMyView,
  findMyZoom,
  hostErrorInfo,
  macScreenView,
} from '@whombat/client/hosts';
import { useFindMyMap, useFindMyPicture, useFindMyTab } from '@whombat/client/hosts/react';
import type { HostFindMy } from '@whombat/core/domain';
import { Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../../app/theme/ThemeProvider';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { Modal, ModalTitle } from '../../../components/Modal';
import { useToast } from '../../../components/Toast';
import { useNow } from '../../messaging/useRoom';
import { Badge, Card, Empty, ErrorLine, StateCell } from '../parts';
import styles from '../Things.module.css';
import type { TabProps } from '../tabs/tabProps';
import fm from './FindMy.module.css';
import mac from './Mac.module.css';

const toneOf = (p: Pick<FindMyPersonRow, 'tone'>) => HUMAN_TONES[p.tone] ?? HUMAN_TONES[0];

export function MacFindMyTab({ burrow, serverId, detail }: TabProps) {
  const toast = useToast();
  const name = detail.server.name ?? serverId;
  const now = useNow(15_000);
  // The person may change their servers (Whombat is one person's); the server's switches decide the rest.
  const screen = macScreenView(detail, { name, owner: true, now: Date.parse(detail.asOf) })?.screen ?? null;
  const tab = useFindMyTab({ burrow, serverId, canRead: !!screen?.can });
  const [exactFor, setExactFor] = useState<FindMyPersonRow | null>(null);
  if (!screen) return null;
  const view = findMyView(tab.state, { name, now, screen });

  const say = (problem: string | null) => {
    if (problem) toast.show(problem);
  };

  return (
    <>
      <Card
        id="mac-findmy"
        title={FIND_MY_WORDS.title}
        meta={view.readLine}
        link={
          <button
            type="button"
            className={styles.cardLink}
            disabled={!view.canRead || tab.asking}
            aria-busy={tab.asking || undefined}
            onClick={() => void tab.readNow().then(say)}
          >
            {FIND_MY_WORDS.readAgain}
          </button>
        }
      >
        {tab.error && !tab.state ? (
          <ErrorLine error={tab.error} />
        ) : view.status ? (
          <p className={fm.status} role="status">
            {view.status.tone === 'mut' ? (
              view.status.text
            ) : (
              <StateCell tone={view.status.tone} text={view.status.text} />
            )}
          </p>
        ) : null}
        {view.anyLocated ? (
          <FindMyMap burrow={burrow} serverId={serverId} name={name} state={tab.state} people={view.people} />
        ) : null}
        {view.anyLocated ? <p className={styles.cardNote}>{FIND_MY_WORDS.note}</p> : null}
      </Card>

      {view.people.length > 0 || view.empty ? (
        <Card id="mac-findmy-people" title={FIND_MY_WORDS.people}>
          {view.empty ? (
            <Empty>{view.empty}</Empty>
          ) : (
            <div className={styles.rows}>
              {view.people.map((p) => (
                <div key={p.id} className={styles.row}>
                  <HumanAvatar initials={initialsFor(p.name)} tone={toneOf(p)} size={36} />
                  <div className={styles.rowMain}>
                    <b className={fm.name}>
                      {p.name}
                      {p.nearby ? <Badge tone="ok">{FIND_MY_WORDS.nearby}</Badge> : null}
                    </b>
                    <small>{p.line}</small>
                  </div>
                  {p.placed ? (
                    <span className={mac.end}>
                      <Button
                        size="sm"
                        disabled={!screen.can}
                        onClick={() => {
                          setExactFor(p);
                          void tab.showExactly(p.id).then((problem) => {
                            if (problem) {
                              setExactFor(null);
                              toast.show(problem);
                            }
                          });
                        }}
                      >
                        {FIND_MY_WORDS.showExactly}
                      </Button>
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}

      {exactFor ? (
        <ExactDialog
          burrow={burrow}
          serverId={serverId}
          server={name}
          person={exactFor}
          state={tab.state}
          onClose={() => setExactFor(null)}
        />
      ) : null}
    </>
  );
}

/** The size of an element in CSS pixels, following it as the page changes. */
function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** The Mac's map at the box's size, each person with a spot as an avatar and first name, with ＋, − and Fit everyone. */
function FindMyMap({
  burrow,
  serverId,
  name,
  state,
  people,
}: {
  burrow: string;
  serverId: string;
  name: string;
  state: HostFindMy | undefined;
  people: readonly FindMyPersonRow[];
}) {
  const { theme } = useTheme();
  const [ref, box] = useBoxSize<HTMLDivElement>();
  const [region, setRegion] = useState<FindMyRegion | null>(null);
  const ask = findMyMapAsk(box);
  const map = useFindMyMap({
    burrow,
    serverId,
    ask,
    dark: theme === 'dark',
    region,
    enabled: !!state?.readAt,
  });
  const shown = map.shown;
  const drawn = shown ? findMyMapRegion(shown.map) : null;
  // From the region drawn last, so a zoom while one is drawn goes on from what the person sees.
  const zoom = (dir: 'in' | 'out') => drawn && setRegion(findMyZoom(drawn, dir));
  const byId = new Map(people.map((p) => [p.id, p]));
  const pins = shown ? findMyPins(shown.map.points, shown.ask, box) : [];

  return (
    <div ref={ref} className={fm.map} aria-busy={map.drawing || undefined}>
      {shown ? (
        <img
          className={fm.picture}
          src={`data:image/${shown.map.format};base64,${shown.map.imageB64}`}
          alt={FIND_MY_WORDS.mapAlt(name)}
          draggable={false}
        />
      ) : (
        <span className={fm.drawing}>{map.error ? null : FIND_MY_WORDS.drawing}</span>
      )}
      {pins.map((pin) => {
        const p = byId.get(pin.person);
        if (!p) return null;
        return (
          <span
            key={pin.person}
            className={pin.above ? `${fm.pin} ${fm.pinAbove}` : fm.pin}
            style={{ left: pin.x, top: pin.y }}
          >
            <HumanAvatar
              initials={initialsFor(p.name)}
              tone={toneOf(p)}
              size={30}
              label={p.name}
              className={fm.pinAvatar}
            />
            <span className={fm.pinName} aria-hidden="true">
              {p.firstName}
            </span>
          </span>
        );
      })}
      <span className={fm.zoom}>
        <button
          type="button"
          className={fm.zoomButton}
          aria-label={FIND_MY_WORDS.zoomIn}
          title={FIND_MY_WORDS.zoomIn}
          disabled={!drawn || !findMyCanZoom(drawn, 'in')}
          onClick={() => zoom('in')}
        >
          <Icon icon={Plus} size={16} />
        </button>
        <button
          type="button"
          className={fm.zoomButton}
          aria-label={FIND_MY_WORDS.zoomOut}
          title={FIND_MY_WORDS.zoomOut}
          disabled={!drawn || !findMyCanZoom(drawn, 'out')}
          onClick={() => zoom('out')}
        >
          <Icon icon={Minus} size={16} />
        </button>
      </span>
      {region ? (
        <button type="button" className={fm.fit} onClick={() => setRegion(null)}>
          {FIND_MY_WORDS.fit}
        </button>
      ) : null}
    </div>
  );
}

/** “Exactly where Ilse is”: Find My's own map of one person, taken when asked and shown once it is ready. */
function ExactDialog({
  burrow,
  serverId,
  server,
  person,
  state,
  onClose,
}: {
  burrow: string;
  serverId: string;
  server: string;
  person: FindMyPersonRow;
  state: HostFindMy | undefined;
  onClose: () => void;
}) {
  const now = useNow(5_000);
  const view = findMyExactView(state, person.id, server, now);
  const picture = useFindMyPicture({ burrow, serverId, state, person: person.id });
  const shot = view.kind === 'ready' ? picture.data : undefined;
  const busy = view.kind === 'taking' || (view.kind === 'ready' && !shot && !picture.error);
  return (
    <Modal open width="lg" onOpenChange={(o) => !o && onClose()}>
      <div className={fm.exactHead}>
        <ModalTitle className={styles.dialogTitle}>{FIND_MY_WORDS.exactTitle(person.name)}</ModalTitle>
        <p className={fm.exactLine} role="status">
          {view.kind === 'failed' ? (
            <StateCell tone="warn" text={view.text} />
          ) : view.kind === 'ready' && picture.error ? (
            <StateCell tone="warn" text={hostErrorInfo(picture.error).message} />
          ) : (
            view.text
          )}
        </p>
      </div>
      <div
        className={fm.exactBox}
        style={shot && shot.w > 0 && shot.h > 0 ? { aspectRatio: `${shot.w} / ${shot.h}` } : undefined}
        aria-busy={busy || undefined}
      >
        {shot ? (
          <img
            className={fm.picture}
            src={`data:image/${shot.format};base64,${shot.imageB64}`}
            alt={FIND_MY_WORDS.exactAlt(person.name, server)}
            draggable={false}
          />
        ) : busy ? (
          <span className={fm.spinner} aria-hidden="true" />
        ) : null}
      </div>
      <div className={styles.dialogActions}>
        <Button variant="secondary" onClick={onClose}>
          {FIND_MY_WORDS.close}
        </Button>
      </div>
    </Modal>
  );
}
