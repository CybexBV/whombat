/**
 * The account site's own pages once signed in (docs/app/decisions/account-home.md): the home at `/` (the person's
 * Whombats, each opening at its own address; one leads with one big Open; none shows how to add the first), and the
 * account at `/account` (Whombat Link, email, the phone app, signing out, deleting the account). Both under one top bar
 * with the logo and the account's menu. The containers talk to control; the screens only show what they are given.
 */
import { WhombatLogo } from '@whombat/brand/react';
import {
  ACCOUNT_TEXT,
  type ApplianceSummary,
  type ControlApi,
  ControlError,
  type ControlSession,
  DOWNLOAD_URL,
  HOME_TEXT,
  type HomeRow,
  homePlanLine,
  homeRows,
  type LinkAccount,
  type LinkInterval,
  linkAccountErrorText,
  linkCheckoutInput,
  linkNotice,
  linkSubscribed,
  pollLinkCheckout,
  WHOMBAT_LINK_TEXT as T,
} from '@whombat/client/managed';
import { normalizeLinkCode } from '@whombat/protocol';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Download,
  LogOut,
  MoreHorizontal,
  Plus,
  Smartphone,
  Trash2,
  User,
} from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Button, ButtonLink, IconButton } from '../components/Button';
import { cx } from '../components/cx';
import { Icon } from '../components/Icon';
import { Input } from '../components/Input';
import { StatusDot } from '../components/StatusDot';
import styles from './home.module.css';
import {
  goToStripe,
  keepOpenPage,
  type LinkPlanChoice,
  PlanCard,
  readLastOpened,
  readOpenPage,
  toCheckout,
  typedLinkCode,
  writeLastOpened,
} from './LinkAccount';
import m from './managed.module.css';
import { ErrorLine } from './screens';

/* The frame: the top bar with the logo and the account's menu, then one column ---------------------------- */

export interface AccountFrameProps {
  session: ControlSession;
  onHome: () => void;
  onAccount: () => void;
  onPhone: () => void;
  onSignOut: () => void;
  children: ReactNode;
}

export function AccountFrame({
  session,
  onHome,
  onAccount,
  onPhone,
  onSignOut,
  children,
}: AccountFrameProps) {
  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <a
          href="/"
          className={styles.home}
          aria-label="Whombat"
          onClick={(e) => {
            e.preventDefault();
            onHome();
          }}
        >
          <WhombatLogo variant="lockup" height={22} label="Whombat" />
        </a>
        <AccountMenu session={session} onAccount={onAccount} onPhone={onPhone} onSignOut={onSignOut} />
      </header>
      <main className={styles.column}>{children}</main>
    </div>
  );
}

function initialOf(session: ControlSession): string {
  const from = session.account.name?.trim() || session.account.email;
  return (from[0] ?? '?').toUpperCase();
}

function AccountMenu({
  session,
  onAccount,
  onPhone,
  onSignOut,
}: Pick<AccountFrameProps, 'session' | 'onAccount' | 'onPhone' | 'onSignOut'>) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const { email, name } = session.account;
  const pick = (go: () => void) => () => {
    setOpen(false);
    go();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: closes the menu on Esc from inside it
    <div
      className={styles.accountMenu}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={cx(styles.accountButton, open && styles.accountButtonOpen)}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={HOME_TEXT.menu.label(email)}
        onClick={() => setOpen((v) => !v)}
        data-testid="account-menu"
      >
        <span className={styles.avatar} aria-hidden="true">
          {initialOf(session)}
        </span>
        <span className={styles.accountEmail}>{email}</span>
        <Icon icon={ChevronDown} size={15} className={styles.chevron} />
      </button>
      {open && (
        <div id={menuId} className={styles.menu}>
          <div className={styles.menuHead}>
            <span className={styles.avatar} aria-hidden="true">
              {initialOf(session)}
            </span>
            <span className={styles.menuWho}>
              {name && <b>{name}</b>}
              <small>{email}</small>
            </span>
          </div>
          <hr className={styles.menuDivider} />
          <button type="button" className={styles.menuItem} onClick={pick(onAccount)}>
            <Icon icon={User} size={15} />
            {HOME_TEXT.menu.account}
          </button>
          <button type="button" className={styles.menuItem} onClick={pick(onPhone)}>
            <Icon icon={Smartphone} size={15} />
            {HOME_TEXT.menu.phone}
          </button>
          <hr className={styles.menuDivider} />
          <button type="button" className={styles.menuItem} onClick={pick(onSignOut)}>
            <Icon icon={LogOut} size={15} />
            {HOME_TEXT.menu.signOut}
          </button>
        </div>
      )}
    </div>
  );
}

/* The home: the person's Whombats ---------------------------------------------------------------------------- */

export interface HomeScreenProps extends Omit<AccountFrameProps, 'children' | 'onHome'> {
  /** Null while loading; `error` when Whombat Link couldn't be loaded. */
  account: LinkAccount | null | 'error';
  /** An older organization's Whombats (this site opens them), when the account has one; null while loading. */
  hosted?: readonly ApplianceSummary[] | null;
  lastOpened: string | null;
  onRetry: () => void;
  /** A Whombat is being opened (at its own address, or here for an older organization's). */
  onOpen: (row: HomeRow) => void;
  /** Resolves to why it failed, or null. */
  onRemove: (row: HomeRow) => Promise<string | null>;
  /** Add a Whombat, with the code already typed on this page. */
  onAdd: (code?: string) => void;
  now?: number;
}

export function HomeScreen(props: HomeScreenProps) {
  const { account, hosted, lastOpened, onRetry, onAdd, onAccount, now } = props;
  const frame = (children: ReactNode) => (
    <AccountFrame {...props} onHome={() => {}}>
      {children}
    </AccountFrame>
  );
  if (account === 'error')
    return frame(
      <>
        <ErrorLine text={T.loadFailed} />
        <div className={m.actions}>
          <Button variant="primary" size="lg" onClick={onRetry}>
            {T.retry}
          </Button>
        </div>
      </>,
    );
  if (account === null || hosted === null)
    return frame(
      <p className={m.hint} role="status">
        {HOME_TEXT.loading}
      </p>,
    );
  const rows = homeRows({ account, hosted: hosted ?? null, lastOpened, ...(now !== undefined && { now }) });
  if (rows.length === 0) return frame(<FirstWhombat onAdd={onAdd} />);
  const notice = linkNotice(account);
  const plan = homePlanLine(account);
  return frame(
    <>
      <div className={styles.intro}>
        <h1 className={styles.title}>{HOME_TEXT.title(rows.length)}</h1>
        <p className={styles.sub}>{HOME_TEXT.sub(rows.length)}</p>
      </div>
      {notice && (
        <div className={m.notice} role="status" data-testid="link-notice">
          <p>{notice}</p>
        </div>
      )}
      {rows.length === 1 && rows[0] ? (
        <OnlyWhombat row={rows[0]} {...props} />
      ) : (
        <ul className={m.card} aria-label={HOME_TEXT.title(rows.length)}>
          {rows.map((row, i) => (
            <WhombatRow key={row.device} row={row} lead={i === 0} {...props} />
          ))}
        </ul>
      )}
      <button type="button" className={styles.addRow} onClick={() => onAdd()}>
        <span className={styles.addTile} aria-hidden="true">
          <Icon icon={Plus} size={18} />
        </span>
        {HOME_TEXT.add}
      </button>
      <div className={styles.foot}>
        {plan ? (
          <span className={styles.footPlan}>
            <StatusDot tone={plan.tone} size={8} label={null} />
            {plan.text}
          </span>
        ) : (
          <span />
        )}
        <Button variant="link" onClick={onAccount} iconEnd={<Icon icon={ArrowRight} size={15} />}>
          {HOME_TEXT.account}
        </Button>
      </div>
    </>,
  );
}

function Tile({ large = false }: { large?: boolean }) {
  return (
    <span className={cx(styles.tile, large && styles.tileLarge)} aria-hidden="true">
      <WhombatLogo height={large ? 28 : 20} />
    </span>
  );
}

function Line({ row }: { row: HomeRow }) {
  return (
    <span className={styles.meta}>
      <StatusDot tone={row.tone} size={8} label={row.text ?? row.host ?? row.name} />
      {row.text && <span>{row.text}</span>}
      {row.text && row.host && <span aria-hidden="true">·</span>}
      {row.host && <span className={styles.host}>{row.host}</span>}
    </span>
  );
}

function OpenButton({
  row,
  size,
  variant,
  label,
  onOpen,
  className,
}: {
  row: HomeRow;
  size: 'sm' | 'xl';
  variant: 'primary' | 'secondary';
  label: string;
  onOpen: (row: HomeRow) => void;
  className?: string;
}) {
  const end = <Icon icon={ArrowRight} size={size === 'xl' ? 16 : 15} />;
  if (!row.open) return null;
  if (row.open.kind === 'url')
    return (
      <ButtonLink
        variant={variant}
        size={size}
        href={row.open.url}
        iconEnd={end}
        className={className}
        aria-label={HOME_TEXT.openName(row.name)}
        onClick={() => onOpen(row)}
        data-testid="home-open"
      >
        {label}
      </ButtonLink>
    );
  return (
    <Button
      variant={variant}
      size={size}
      iconEnd={end}
      className={className}
      aria-label={HOME_TEXT.openName(row.name)}
      onClick={() => onOpen(row)}
      data-testid="home-open"
    >
      {label}
    </Button>
  );
}

function OnlyWhombat({ row, onOpen, onRemove }: { row: HomeRow } & HomeScreenProps) {
  return (
    <div className={styles.hero} data-testid="home-only" data-link-state={row.link?.state}>
      <div className={styles.heroTop}>
        <Tile large />
        <div className={styles.heroText}>
          <span className={styles.heroName}>{row.name}</span>
          <Line row={row} />
        </div>
        {row.link && <MoreMenu row={row} onRemove={onRemove} />}
      </div>
      <OpenButton
        row={row}
        size="xl"
        variant="primary"
        label={HOME_TEXT.openName(row.name)}
        onOpen={onOpen}
        className={styles.heroOpen}
      />
    </div>
  );
}

function WhombatRow({ row, lead, onOpen, onRemove }: { row: HomeRow; lead: boolean } & HomeScreenProps) {
  return (
    <li className={styles.row} data-whombat={row.device} data-link-state={row.link?.state}>
      <Tile />
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>
          {row.name}
          {row.openedLast && <span className={styles.tag}>{HOME_TEXT.openedLast}</span>}
        </span>
        <Line row={row} />
      </div>
      <div className={styles.rowEnd}>
        <OpenButton
          row={row}
          size="sm"
          variant={lead ? 'primary' : 'secondary'}
          label={HOME_TEXT.open}
          onOpen={onOpen}
        />
        {row.link && <MoreMenu row={row} onRemove={onRemove} />}
      </div>
    </li>
  );
}

/** ⋯ beside a Whombat: taking it out of Whombat Link, asked first. */
function MoreMenu({ row, onRemove }: { row: HomeRow; onRemove: (row: HomeRow) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuId = useId();
  const remove = async () => {
    setBusy(true);
    setError(null);
    const failed = await onRemove(row);
    setBusy(false);
    if (failed) setError(failed);
    else setAsking(false);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: closes the menu on Esc from inside it
    <div
      className={styles.more}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && (open || asking)) {
          event.preventDefault();
          setOpen(false);
          setAsking(false);
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <IconButton
        label={HOME_TEXT.more(row.name)}
        aria-expanded={open || asking}
        aria-controls={open || asking ? menuId : undefined}
        onClick={() => {
          setError(null);
          setAsking(false);
          setOpen((v) => !v);
        }}
      >
        <Icon icon={MoreHorizontal} size={16} />
      </IconButton>
      {open && (
        <div id={menuId} className={cx(styles.menu, styles.moreMenu)}>
          <button
            type="button"
            className={cx(styles.menuItem, styles.menuDanger)}
            onClick={() => {
              setOpen(false);
              setAsking(true);
            }}
          >
            <Icon icon={Trash2} size={15} />
            {HOME_TEXT.remove}
          </button>
        </div>
      )}
      {asking && (
        <div id={menuId} className={cx(styles.menu, styles.moreMenu, styles.confirm)} role="dialog">
          <p className={styles.confirmText}>{T.removeConfirm(row.name)}</p>
          <ErrorLine text={error} />
          <div className={m.actions}>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void remove()}>
              {busy ? T.removing : T.removeIt}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking(false)}>
              {T.cancel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** No Whombat yet: the three steps, with the code field right here. */
function FirstWhombat({ onAdd }: { onAdd: (code?: string) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const normal = normalizeLinkCode(code);
    if (!normal) return setError(T.errors.badCode);
    onAdd(normal);
  };
  return (
    <>
      <div className={styles.intro}>
        <h1 className={styles.title}>{HOME_TEXT.emptyTitle}</h1>
        <p className={styles.sub}>{HOME_TEXT.emptySub}</p>
      </div>
      <ol className={styles.steps}>
        {HOME_TEXT.steps.map((step, i) => (
          <li key={step.t} className={cx(styles.step, i === 2 && styles.stepNow)}>
            <span className={styles.stepDot} aria-hidden="true">
              {i + 1}
            </span>
            <b>{step.t}</b>
            <span className={styles.stepText}>{step.d}</span>
            {i === 0 && (
              <ButtonLink
                variant="link"
                href={DOWNLOAD_URL}
                iconStart={<Icon icon={Download} size={15} />}
                className={styles.stepLink}
              >
                {HOME_TEXT.download}
              </ButtonLink>
            )}
          </li>
        ))}
      </ol>
      <form className={styles.codeForm} onSubmit={submit}>
        <label htmlFor={id} className={styles.codeLabel}>
          {T.code}
        </label>
        <div className={styles.codeRow}>
          <Input
            id={id}
            size="lg"
            className={styles.codeInput}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="ABCD-EFGH"
            value={code}
            onChange={(e) => {
              setError(null);
              setCode(typedLinkCode(e.target.value));
            }}
          />
          <Button variant="primary" size="xl" type="submit" disabled={!code}>
            {T.find}
          </Button>
        </div>
        <ErrorLine text={error} />
      </form>
      <p className={styles.offer}>{HOME_TEXT.offer}</p>
    </>
  );
}

/** `/`: loads the account's Whombat Link (and an older organization's list), and remembers which one was opened. */
export function HomeFlow({
  control,
  session,
  hosted,
  onOpenHere,
  onAdd,
  onAccount,
  onPhone,
  onSignOut,
}: {
  control: ControlApi;
  session: ControlSession;
  /** An older organization's Whombats, loaded by the caller; undefined when the account has none. */
  hosted?: readonly ApplianceSummary[] | null;
  /** Opens an older organization's Whombat on this site. */
  onOpenHere?: (appliance: ApplianceSummary) => void;
  onAdd: (code?: string) => void;
  onAccount: () => void;
  onPhone: () => void;
  onSignOut: () => void;
}) {
  const [account, setAccount] = useState<LinkAccount | null | 'error'>(null);
  const [run, setRun] = useState(0);
  const [lastOpened, setLastOpened] = useState<string | null>(readLastOpened);
  useEffect(() => {
    let live = true;
    const load = control.linkAccount;
    if (!load) {
      // A control without Whombat Link: the older organization's list alone.
      setAccount({
        plan: {
          state: 'none',
          trialEndsAt: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          trialAvailable: false,
          boxes: 0,
        },
        boxes: [],
      });
      return;
    }
    if (run >= 0)
      load().then(
        (a) => live && setAccount(a),
        () => live && setAccount('error'),
      );
    return () => {
      live = false;
    };
  }, [control, run]);
  return (
    <HomeScreen
      session={session}
      account={account}
      {...(hosted !== undefined && { hosted })}
      lastOpened={lastOpened}
      onRetry={() => {
        setAccount(null);
        setRun((n) => n + 1);
      }}
      onOpen={(row) => {
        setLastOpened(row.device);
        writeLastOpened(row.device);
        if (row.open?.kind === 'here' && row.appliance) onOpenHere?.(row.appliance);
      }}
      onRemove={async (row) => {
        if (!control.linkRemove) return T.errors.unavailable;
        try {
          setAccount(await control.linkRemove(row.device));
          return null;
        } catch (e) {
          return linkAccountErrorText(e);
        }
      }}
      onAdd={onAdd}
      onAccount={onAccount}
      onPhone={onPhone}
      onSignOut={onSignOut}
    />
  );
}

/* The account: Whombat Link, you, and deleting the account ------------------------------------------------- */

export interface AccountScreenProps extends Omit<AccountFrameProps, 'children'> {
  account: LinkAccount | null | 'error';
  /** Back from Stripe Checkout: waiting for the subscription, waited a minute, or it shows. */
  checkout: 'waiting' | 'slow' | 'done' | null;
  onRetry: () => void;
  onPlan: (choice: LinkPlanChoice) => Promise<void>;
  openPage?: LinkInterval | null;
  onDeleteAccount: () => void;
}

export function AccountScreen(props: AccountScreenProps) {
  const { session, account, checkout, onRetry, onHome, onPhone, onSignOut, onDeleteAccount } = props;
  let link: ReactNode;
  if (checkout === 'waiting' || checkout === 'slow')
    link = (
      <>
        <p className={m.status} role="status">
          {checkout === 'waiting' ? T.settingUp : T.slow}
        </p>
        {checkout === 'slow' && (
          <div className={m.actions}>
            <Button variant="primary" size="sm" onClick={onRetry}>
              {T.checkAgain}
            </Button>
          </div>
        )}
      </>
    );
  else if (account === 'error')
    link = (
      <>
        <ErrorLine text={T.loadFailed} />
        <div className={m.actions}>
          <Button variant="primary" size="sm" onClick={onRetry}>
            {T.retry}
          </Button>
        </div>
      </>
    );
  else if (account === null)
    link = (
      <p className={m.hint} role="status">
        {HOME_TEXT.loading}
      </p>
    );
  else {
    const notice = checkout === 'done' && linkSubscribed(account.plan) ? T.subscribed : linkNotice(account);
    link = (
      <>
        {notice && (
          <div className={m.notice} role="status" data-testid="link-notice">
            <p>{notice}</p>
          </div>
        )}
        <PlanCard account={account} onPlan={props.onPlan} openPage={props.openPage ?? null} />
        <p className={styles.about}>{ACCOUNT_TEXT.linkAbout}</p>
      </>
    );
  }
  return (
    <AccountFrame {...props}>
      <div className={styles.intro}>
        <Button
          variant="link"
          className={styles.back}
          onClick={onHome}
          iconStart={<Icon icon={ArrowLeft} size={15} />}
        >
          {ACCOUNT_TEXT.back}
        </Button>
        <h1 className={styles.title}>{ACCOUNT_TEXT.title}</h1>
      </div>
      <section className={styles.section} aria-labelledby="account-link">
        <h2 id="account-link" className={styles.sectionLabel}>
          {ACCOUNT_TEXT.link}
        </h2>
        {link}
      </section>
      <section className={styles.section} aria-labelledby="account-you">
        <h2 id="account-you" className={styles.sectionLabel}>
          {ACCOUNT_TEXT.you}
        </h2>
        <ul className={m.card}>
          <li className={m.row}>
            <div className={m.rowMain}>
              <span className={m.rowTitle}>{ACCOUNT_TEXT.email}</span>
              <span className={cx(m.rowMeta, styles.host)}>{session.account.email}</span>
            </div>
          </li>
          <li className={m.row}>
            <div className={m.rowMain}>
              <span className={m.rowTitle}>{ACCOUNT_TEXT.phone}</span>
              <span className={m.rowMeta}>{ACCOUNT_TEXT.phoneMeta}</span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={onPhone}
              iconStart={<Icon icon={Smartphone} size={15} />}
            >
              {ACCOUNT_TEXT.phoneGet}
            </Button>
          </li>
          <li className={m.row}>
            <div className={m.rowMain}>
              <span className={m.rowTitle}>{ACCOUNT_TEXT.signOut}</span>
              <span className={m.rowMeta}>{ACCOUNT_TEXT.signOutMeta}</span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={onSignOut}
              iconStart={<Icon icon={LogOut} size={15} />}
            >
              {ACCOUNT_TEXT.signOut}
            </Button>
          </li>
        </ul>
      </section>
      <div className={styles.foot}>
        <span className={styles.footNote}>{ACCOUNT_TEXT.keepsWorking}</span>
        <Button variant="link" className={styles.danger} onClick={onDeleteAccount}>
          {ACCOUNT_TEXT.delete}
        </Button>
      </div>
    </AccountFrame>
  );
}

/**
 * `/account` and `/billing`: loads the account's Link, sends the browser to Stripe, and back from Checkout
 * (`?checkout=done`) asks every 2 s for up to a minute until the subscription shows (webhooks can lag).
 */
export function AccountFlow({
  control,
  session,
  billingRedirectOrigins,
  onHome,
  onPhone,
  onSignOut,
  onDeleteAccount,
}: {
  control: ControlApi;
  session: ControlSession;
  billingRedirectOrigins?: readonly string[];
  onHome: () => void;
  onPhone: () => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
}) {
  const [account, setAccount] = useState<LinkAccount | null | 'error'>(null);
  const [checkout, setCheckout] = useState<'waiting' | 'slow' | 'done' | null>(() =>
    new URLSearchParams(window.location.search).get('checkout') === 'done' ? 'waiting' : null,
  );
  const [run, setRun] = useState(0);
  const [openPage] = useState<LinkInterval | null>(readOpenPage);
  const checkoutNow = useRef(checkout);
  checkoutNow.current = checkout;
  useEffect(() => {
    let live = true;
    const load = control.linkAccount;
    if (!load) {
      setAccount('error');
      return;
    }
    if (run >= 0 && (checkoutNow.current === 'waiting' || checkoutNow.current === 'slow')) {
      setCheckout('waiting');
      void pollLinkCheckout({ load: () => load(), onAccount: setAccount, live: () => live }).then((out) => {
        if (!live || out === 'stopped') return;
        if (out === 'timeout') return setCheckout('slow');
        setCheckout('done');
        // The address no longer says it came back from Checkout (a reload doesn't wait again).
        window.history.replaceState(null, '', window.location.pathname);
      });
    } else
      load().then(
        (a) => live && setAccount(a),
        () => live && setAccount('error'),
      );
    return () => {
      live = false;
    };
  }, [control, run]);
  const plan = async (choice: LinkPlanChoice) => {
    if (account === null || account === 'error') return;
    if (choice.via === 'portal') {
      if (!control.linkPortal) throw new ControlError('unavailable', 'No Link here.');
      goToStripe((await control.linkPortal(choice.terms)).url, billingRedirectOrigins);
    } else
      await toCheckout(control, billingRedirectOrigins, linkCheckoutInput(account.plan, choice), () =>
        keepOpenPage(choice.interval),
      );
  };
  return (
    <AccountScreen
      session={session}
      account={account}
      checkout={checkout}
      onRetry={() => {
        if (checkout !== 'slow') setAccount(null);
        setRun((n) => n + 1);
      }}
      onPlan={plan}
      openPage={openPage}
      onHome={onHome}
      onAccount={() => {}}
      onPhone={onPhone}
      onSignOut={onSignOut}
      onDeleteAccount={onDeleteAccount}
    />
  );
}
