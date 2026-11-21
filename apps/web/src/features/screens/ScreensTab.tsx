/**
 * Settings → Screens (Whombat desk-display.md DK-128, DK-137, DK-146, DK-147; desk-display-web.md AP-5940…): every
 * screen with a live picture of what it shows, its lines (what it is, its grid and pages; what pops up, how it locks)
 * and *Edit layout*; *+ Add a screen* (the six letters a tablet or computer shows). A screen's own page (`&screen=`):
 * its picture and *Edit layout*, its name (not the box's), *What pops up*, and for the box's own the parts that were the
 * *Screen* tab's (*Top bar*, *Lock and PIN*, *Night*, *Talk*); a screen elsewhere can be removed.
 */
import {
  DESK_POPUPS,
  DESK_SCREEN_WORDS,
  DESK_SCREENS_TEXT,
  type DeskApi,
  type DeskPopups,
  type DeskScreen,
  type DeskScreenDetail,
  type DeskScreenSummary,
  deskLayoutWidgets,
  deskLockAgainOf,
  fillDeskWords,
  screenLines,
  screensErrorText,
} from '@whombat/client/desk';
import {
  useDesk,
  useDeskClock,
  useDeskScreen,
  useDeskScreenActions,
  useDeskScreens,
  useDeskScreenViews,
} from '@whombat/client/desk/react';
import { useTheAgent } from '@whombat/client/react';
import { formatClock, formatDate } from '@whombat/core/text';
import { FittedScreen } from '@whombat/screen/react';
import { ChevronLeft } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { Modal, ModalTitle } from '../../components/Modal';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toast';
import { ScreenTab } from '../desk/ScreenTab';
import type { ScreenPart } from '../desk/screenTab';
import { useDeskHere } from '../desk/useDeskHere';
import styles from '../settings/SettingsScreen.module.css';
import { AddScreenDialog } from './AddScreenDialog';
import { useScreenImages } from './drawing';
import s from './Screens.module.css';

const T = DESK_SCREENS_TEXT;

export interface ScreensTabProps {
  burrow: string;
  /** A screen's own page (`&screen=`); the list without. */
  screen?: string;
  onScreenChange: (screen: string | undefined) => void;
  /** *Edit layout*: the editor's page for a screen. */
  onEditLayout: (screen: string) => void;
  /** The box's own page: its part (`&part=`). */
  part?: ScreenPart;
  onPartChange?: (part: ScreenPart) => void;
}

export function ScreensTab({
  burrow,
  screen,
  onScreenChange,
  onEditLayout,
  part,
  onPartChange,
}: ScreensTabProps) {
  const here = useDeskHere(burrow);
  const list = useDeskScreens(here.api);
  const desk = useDesk(here.api);
  const [adding, setAdding] = useState(false);
  if (!here.api || !list.data) return null;
  const api = here.api;
  if (screen) {
    const summary = list.data.screens.find((x) => x.id === screen);
    return (
      <ScreenSettings
        burrow={burrow}
        api={api}
        id={screen}
        known={summary !== undefined}
        desk={desk.data}
        timeZone={here.timeZone}
        onBack={() => onScreenChange(undefined)}
        onEditLayout={() => onEditLayout(screen)}
        {...(part ? { part } : {})}
        {...(onPartChange ? { onPartChange } : {})}
      />
    );
  }
  return (
    <div className={s.tab} data-screens-tab="">
      <div className={s.head}>
        <div className={s.headText}>
          <h2 className={s.title}>{T.title}</h2>
          <p className={s.intro}>{T.intro}</p>
        </div>
        <Button
          variant="primary"
          onClick={() => setAdding(true)}
          disabled={!list.data.canAdd}
          title={list.data.canAdd ? undefined : DESK_SCREENS_TEXT.addDialog.title}
        >
          {T.add}
        </Button>
      </div>
      <div className={cx(styles.card, s.list)}>
        {list.data.screens.map((x) => (
          <ScreenRow
            key={x.id}
            burrow={burrow}
            api={api}
            summary={x}
            desk={desk.data}
            timeZone={here.timeZone}
            onOpen={() => onScreenChange(x.id)}
            onEditLayout={() => onEditLayout(x.id)}
          />
        ))}
      </div>
      <AddScreenDialog
        burrow={burrow}
        api={api}
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(id) => {
          setAdding(false);
          onScreenChange(id);
        }}
      />
    </div>
  );
}

/** The lines' context from the box's screen: what it is, how it locks, what a locked screen shows. */
function linesContext(desk: DeskScreen | undefined, timeZone: string) {
  const now = new Date();
  return {
    box: desk?.display ? { builtIn: desk.display.builtIn, name: desk.display.name } : null,
    lockAgain: desk?.paired ? deskLockAgainOf(desk.settings) : null,
    lockedView: desk?.paired ? desk.settings.lockedView : null,
    when: (iso: string) =>
      formatDate(iso, timeZone, { now }) === formatDate(now, timeZone, { now })
        ? formatClock(iso, timeZone)
        : formatDate(iso, timeZone, { year: 'auto', now }),
  };
}

function ScreenRow({
  burrow,
  api,
  summary,
  desk,
  timeZone,
  onOpen,
  onEditLayout,
}: {
  burrow: string;
  api: DeskApi;
  summary: DeskScreenSummary;
  desk: DeskScreen | undefined;
  timeZone: string;
  onOpen: () => void;
  onEditLayout: () => void;
}) {
  const detail = useDeskScreen(api, summary.id);
  const id = useId();
  const lines = detail.data ? screenLines(detail.data, linesContext(desk, timeZone)) : null;
  return (
    <div className={s.row} data-screen={summary.id}>
      <Thumbnail
        burrow={burrow}
        api={api}
        detail={detail.data}
        timeZone={timeZone}
        width={176}
        height={120}
      />
      <button type="button" className={s.rowText} onClick={onOpen} aria-describedby={`${id}-lines`}>
        <span className={s.rowName}>{summary.name}</span>
        <span className={s.rowLines} id={`${id}-lines`}>
          {lines ? (
            <>
              <span>{lines.what}</span>
              <span>{lines.how}</span>
              {lines.status ? <span className={s.status}>{lines.status}</span> : null}
            </>
          ) : null}
        </span>
      </button>
      <Button size="md" onClick={onEditLayout} aria-label={`${T.editLayout}: ${summary.name}`}>
        {T.editLayout}
      </Button>
    </div>
  );
}

/** What a screen shows now, drawn small: its first page with its live views, as the screen draws it. */
export function Thumbnail({
  burrow,
  api,
  detail,
  timeZone,
  width,
  height,
}: {
  burrow: string;
  api: DeskApi;
  detail: DeskScreenDetail | undefined;
  timeZone: string;
  width: number;
  height: number;
}) {
  const { words } = useTheAgent(burrow);
  const now = useDeskClock(true, 30_000);
  const loadImage = useScreenImages(burrow);
  const input = useMemo(
    () => (detail ? { screen: detail.id, widgets: deskLayoutWidgets(detail.layout).slice(0, 64) } : null),
    [detail],
  );
  const views = useDeskScreenViews(api, input);
  const size = detail?.size ?? { width: 1280, height: 800 };
  return (
    <div
      className={s.thumb}
      style={{ width, height }}
      role="img"
      aria-label={detail ? fillDeskWords(T.thumbnail, { name: detail.name }) : undefined}
    >
      {detail && views.data ? (
        // A picture: nothing in it reacts to a pointer or takes the focus.
        <div className={s.thumbInner} aria-hidden="true" inert>
          <FittedScreen
            fit="contain"
            width={size.width}
            height={size.height}
            grid={{
              screen: detail.id,
              layout: detail.layout,
              views: views.data.views,
              attention: views.data.attention,
              popups: detail.popups,
            }}
            calm={views.data.calm}
            name={views.data.name}
            assistant={words.name}
            timeZone={timeZone}
            now={now}
            loadImage={loadImage}
          />
        </div>
      ) : null}
    </div>
  );
}

/* A screen's own page ---------------------------------------------------------------------------------------------- */

function ScreenSettings({
  burrow,
  api,
  id,
  known,
  desk,
  timeZone,
  onBack,
  onEditLayout,
  part,
  onPartChange,
}: {
  burrow: string;
  api: DeskApi;
  id: string;
  known: boolean;
  desk: DeskScreen | undefined;
  timeZone: string;
  onBack: () => void;
  onEditLayout: () => void;
  part?: ScreenPart;
  onPartChange?: (part: ScreenPart) => void;
}) {
  const { words } = useTheAgent(burrow);
  const detail = useDeskScreen(api, known ? id : null);
  const actions = useDeskScreenActions(api);
  const toast = useToast();
  const [removing, setRemoving] = useState(false);
  const popupsId = useId();
  const back = (
    <button type="button" className={s.back} onClick={onBack}>
      <Icon icon={ChevronLeft} size={15} />
      {T.back}
    </button>
  );
  if (!known)
    return (
      <div className={s.tab}>
        {back}
        <p className={styles.empty}>{screensErrorText({})}</p>
      </div>
    );
  const screen = detail.data;
  if (!screen) return <div className={s.tab}>{back}</div>;
  const lines = screenLines(screen, linesContext(desk, timeZone));
  const save = (patch: { name?: string; popups?: DeskPopups }) =>
    void actions
      .update({ screen: screen.id, ...patch })
      .catch((error) => toast.show(screensErrorText(error)));
  return (
    <div className={s.tab} data-screen-page={screen.id}>
      {back}
      <div className={s.pageHead}>
        <h2 className={s.title}>{screen.name}</h2>
        <p className={s.intro}>{lines.what}</p>
      </div>
      <section className={cx(styles.card, s.overview)}>
        <Thumbnail burrow={burrow} api={api} detail={screen} timeZone={timeZone} width={300} height={200} />
        <div className={s.overviewText}>
          <span className={s.rowLines}>
            <span>{lines.how}</span>
            {lines.status ? <span className={s.status}>{lines.status}</span> : null}
          </span>
          <Button variant="primary" onClick={onEditLayout}>
            {T.editLayout}
          </Button>
        </div>
      </section>

      <section className={cx(styles.card, s.settingsCard)}>
        {screen.kind !== 'box' ? <NameRow screen={screen} onSave={(name) => save({ name })} /> : null}
        <div className={cx(styles.row, s.fieldRow)} data-row="popups">
          <span className={styles.rowMain}>
            <span className={styles.rowTitle} id={`${popupsId}-title`}>
              {T.page.popups}
            </span>
            <span className={styles.rowMeta} id={`${popupsId}-hint`}>
              {fillDeskWords(T.page.popupsHint[screen.popups], { assistant: words.name })}
            </span>
          </span>
          <SegmentedControl
            variant="soft"
            size="sm"
            role="radiogroup"
            label={T.page.popups}
            describedBy={`${popupsId}-hint`}
            value={screen.popups}
            onChange={(popups) => save({ popups })}
            options={DESK_POPUPS.map((p) => ({ value: p, label: DESK_SCREEN_WORDS.popups[p] }))}
          />
        </div>
        {screen.kind !== 'box' ? (
          <div className={cx(styles.row, s.fieldRow)} data-row="remove">
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{T.page.remove}</span>
              <span className={styles.rowMeta}>
                {screen.kind === 'output' ? T.page.removeOutput : T.page.removeLine}
              </span>
            </span>
            <Button className={s.danger} onClick={() => setRemoving(true)}>
              {T.page.remove}
            </Button>
          </div>
        ) : null}
      </section>

      {screen.kind === 'box' ? (
        <ScreenTab
          burrow={burrow}
          widgets
          {...(part ? { part } : {})}
          {...(onPartChange ? { onPartChange } : {})}
        />
      ) : null}

      <Modal open={removing} onOpenChange={setRemoving}>
        <ModalTitle className={s.dialogTitle}>
          {fillDeskWords(T.page.removeTitle, { name: screen.name })}
        </ModalTitle>
        <p className={s.dialogLine}>{screen.kind === 'output' ? T.page.removeOutput : T.page.removeLine}</p>
        <div className={s.dialogButtons}>
          <Button variant="ghost" onClick={() => setRemoving(false)}>
            {T.addDialog.cancel}
          </Button>
          <Button
            variant="primary"
            className={s.dangerPrimary}
            onClick={() => {
              setRemoving(false);
              void actions
                .remove(screen.id)
                .then(() => {
                  toast.show(
                    screen.kind === 'output'
                      ? T.page.forgotten
                      : fillDeskWords(T.page.removed, { name: screen.name }),
                  );
                  onBack();
                })
                .catch((error) => toast.show(screensErrorText(error)));
            }}
          >
            {T.page.removeConfirm}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** A screen's name: saved when it's left or Enter is pressed, put back when empty. */
function NameRow({ screen, onSave }: { screen: DeskScreenDetail; onSave: (name: string) => void }) {
  const id = useId();
  const [name, setName] = useState(screen.name);
  const commit = () => {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean) setName(screen.name);
    else if (clean !== screen.name) onSave(clean);
  };
  return (
    <div className={cx(styles.row, s.fieldRow)} data-row="name">
      <span className={styles.rowMain}>
        <label className={styles.rowTitle} htmlFor={`${id}-name`}>
          {T.page.name}
        </label>
        <span className={styles.rowMeta}>{T.page.nameHint}</span>
      </span>
      <Input
        id={`${id}-name`}
        className={s.nameInput}
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}
