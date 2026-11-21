/**
 * Bringing a Whombat back (app backup-options.md AP-6830…, backup-v2.md) against the fixture's backup service on an
 * in-memory box: Start fresh goes on; the passkey's copy at the account is named; without one Look on my network looks
 * and the paper copy's text joins the backups, the newest chosen; the steps carry on while the runtime is away; Start
 * waits for the one answer; the last line adds a passkey; a restore that stopped says so with Try again; and later, on a
 * Whombat that started fresh, it says first what is replaced. And the pure parts.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeSession, type FakeHandler } from '@whombat/client/fake';
import { BACKUP_OPTIONS_TEXT } from '@whombat/client/managed';
import type { KitEnvelope } from '@whombat/control-contracts';
import type { BackupCheckpoint } from '@whombat/protocol/session';
import { describe, expect, it, vi } from 'vitest';
import { createFakeBackupOptions, type FakeBackupOptionsOptions } from '../app/backupOptionsFixtures';
import { ThemeProvider } from '../app/theme';
import { awayState, BringBackFlow, type BringBackProps } from './BringBack';
import { chooseRows, kitWhombatName, stepOfRestore, stepOfRestoreLater } from './bringBackModel';

const B = BACKUP_OPTIONS_TEXT.bringBack;

const KIT = [
  'WHOMBAT BACKUP DETAILS',
  'Whombat: Home',
  JSON.stringify({
    kind: 'whombat.backup-recovery-material/1',
    applianceId: 'wb-home',
    generation: 2,
    createdAt: '2026-11-03T03:00:00Z',
    repository: 'rest:http://10.100.1.30:8747/whombat-home/',
    repositoryPassword: 'rp-0123456789ab',
    repositoryId: 'repo_home',
    manifestKey: 'ed25519:AAAA',
  }),
].join('\n');

const envelope: KitEnvelope = {
  id: 'kit_1',
  appliance: '12D3KooWOld',
  credentialId: 'cred',
  salt: 'c2FsdA',
  envelope: 'wbkit1.bm9uY2U.Y2lwaGVy',
  generation: 2,
  whombatName: 'Home',
  retired: true,
  createdAt: '2026-11-03T08:00:00Z',
};

function setup(
  envelopes: KitEnvelope[] = [],
  backupOptions: FakeBackupOptionsOptions = {},
  props: Partial<BringBackProps> = {},
) {
  const backups = createFakeBackupOptions({ restoreStageMs: 40, protectedAtStart: false, ...backupOptions });
  const handle: FakeHandler = async (op, input) =>
    (await backups.call(op, input)) ??
    (op === 'backup.places'
      ? { status: 200, body: { currentPlaceId: null, places: [] } }
      : { status: 404, body: { error: { code: 'unknown_op', message: op } } });
  const { session } = createFakeSession({ handle, account: { id: 'acc_mara', name: 'Mara' } });
  session.connect();
  const onFresh = vi.fn();
  const onOpenChat = vi.fn();
  const onList = vi.fn();
  render(
    <ThemeProvider>
      <BringBackFlow
        session={session}
        control={{ kitEnvelopes: async () => envelopes }}
        platform={null}
        email="mara@burrowhq.example"
        thisPeerId="12D3KooWThis"
        onFresh={onFresh}
        onOpenChat={onOpenChat}
        onList={onList}
        pollMs={30}
        {...props}
      />
    </ThemeProvider>,
  );
  return { onFresh, onOpenChat, onList };
}

/** The paper copy's text pasted, then its backups: the newest chosen, brought back. */
async function pasteAndBringBack(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: B.pasteTitle }));
  await user.click(screen.getByLabelText(B.pasteLabel));
  await user.paste(KIT);
  await user.click(screen.getByRole('button', { name: B.openIt }));
  await screen.findByRole('heading', { name: B.chooseTitle('Home') }, { timeout: 4000 });
  await user.click(screen.getByRole('button', { name: B.restore('Home') }));
}

describe('Is this a new Whombat?', () => {
  it('goes on to Protect with Start fresh, chosen when no passkey’s copy is found', async () => {
    const user = userEvent.setup();
    const { onFresh } = setup();
    await screen.findByRole('heading', { name: B.question });
    expect(screen.getByRole('radio', { name: /^Start fresh/ })).toHaveProperty('checked', true);
    // The web has no camera: no scanning in its words.
    expect(screen.getByText(B.noKitHintWeb)).toBeTruthy();
    expect(screen.queryByText(/scan/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: B.continue }));
    expect(onFresh).toHaveBeenCalled();
  });

  it('brings Home back: the account’s copy named, the paper copy, steps, one answer, a passkey at the end', async () => {
    const user = userEvent.setup();
    const { onOpenChat } = setup([envelope]);
    await screen.findByRole('heading', { name: B.question });
    expect(screen.getByText(B.found('Home', '3 November'))).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^Bring back a Whombat/ })).toHaveProperty('checked', true);
    await user.click(screen.getByRole('button', { name: B.continue }));
    await screen.findByRole('heading', { name: B.openTitle('Home') });
    // No PRF in this browser: no unlock, the paper copy instead.
    expect(screen.queryByRole('button', { name: B.unlock })).toBeNull();
    await user.click(screen.getByRole('button', { name: B.pasteTitle }));
    await user.type(screen.getByLabelText(B.pasteLabel), 'not a kit');
    await user.click(screen.getByRole('button', { name: B.openIt }));
    expect(await screen.findByText(B.wrongKit)).toBeTruthy();
    await user.clear(screen.getByLabelText(B.pasteLabel));
    await user.click(screen.getByLabelText(B.pasteLabel));
    await user.paste(KIT);
    await user.click(screen.getByRole('button', { name: B.openIt }));

    await screen.findByRole('heading', { name: B.chooseTitle('Home') }, { timeout: 4000 });
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios[0]).toHaveProperty('checked', true);
    expect(screen.getByText(B.newest)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: B.olderBackups }));
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(3);
    await user.click(screen.getByRole('button', { name: B.restore('Home') }));

    await screen.findByRole('heading', { name: B.workingTitle('Home') });
    expect(document.querySelectorAll('[data-restore-steps] li')).toHaveLength(4);
    await screen.findByRole('heading', { name: B.almostTitle }, { timeout: 5000 });
    // One question: no sign-ins or devices to answer.
    expect(document.querySelectorAll('[data-answer]')).toHaveLength(1);
    const start = screen.getByRole('button', { name: B.start('Home') });
    expect(start).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: B.oldLost }));
    expect(screen.getByText(B.oldLostMeta)).toBeTruthy();
    expect(start).toHaveProperty('disabled', false);
    await user.click(start);

    await screen.findByRole('heading', { name: B.doneTitle('Home') }, { timeout: 5000 });
    // Where they carry on, as the restore state names the place, and the old Whombat switched off.
    expect(screen.getByText(B.doneBackups('BlackBox'))).toBeTruthy();
    expect(screen.getByText(B.doneOldOff('Home'))).toBeTruthy();
    // The last line is the passkey for this Whombat (a button where the browser has passkeys).
    expect(document.querySelector('[data-done-passkey]')?.textContent).toContain(B.doneKey('Home'));
    await user.click(screen.getByRole('button', { name: B.openChat }));
    expect(onOpenChat).toHaveBeenCalled();
  }, 20_000);

  it('looks on the network when the account has no copy, and says when nothing is there', async () => {
    const user = userEvent.setup();
    setup([]);
    await screen.findByRole('heading', { name: B.question });
    await user.click(screen.getByRole('radio', { name: /^Bring back a Whombat/ }));
    await user.click(screen.getByRole('button', { name: B.continue }));
    await screen.findByRole('heading', { name: B.findTitle });
    await user.click(screen.getByRole('button', { name: B.look }));
    expect(await screen.findByText(B.looking)).toBeTruthy();
    expect(await screen.findByText(B.nothingNear, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: B.lookAgain })).toBeTruthy();
  });

  it('says plainly when a restore stopped, and tries the same backup again', async () => {
    const user = userEvent.setup();
    setup([envelope], { restoreStops: true });
    await screen.findByRole('heading', { name: B.question });
    await user.click(screen.getByRole('button', { name: B.continue }));
    await screen.findByRole('heading', { name: B.openTitle('Home') });
    await pasteAndBringBack(user);
    await screen.findByRole('heading', { name: B.failedTitle }, { timeout: 5000 });
    expect(document.querySelector('[data-restore-error]')?.textContent).toMatch(/restarted/);
    expect(screen.getByRole('button', { name: B.startOver })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: B.tryAgain }));
    await screen.findByRole('heading', { name: B.almostTitle }, { timeout: 5000 });
  }, 20_000);
});

describe('Bring back a Whombat you had, later', () => {
  it('says first what is replaced, then joins with replace', async () => {
    const user = userEvent.setup();
    const { onList } = setup([], { protectedAtStart: true }, { later: 'replace', thisName: 'Attic' });
    const L = BACKUP_OPTIONS_TEXT.later;
    await screen.findByRole('heading', { name: L.confirmTitle });
    expect(screen.getByText(L.confirmLead('Attic'))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: L.confirm }));
    await screen.findByRole('heading', { name: B.findTitle });
    // The box has backups of its own: joining works only because the flow says `replace`.
    await pasteAndBringBack(user);
    await screen.findByRole('heading', { name: B.workingTitle('Home') }, { timeout: 4000 });
    expect(onList).not.toHaveBeenCalled();
  }, 20_000);

  it('goes back to Backups when there is nothing to finish', async () => {
    const { onList } = setup([], {}, { later: 'resume' });
    await vi.waitFor(() => expect(onList).toHaveBeenCalled());
  });
});

const cp = (over: Partial<BackupCheckpoint>): BackupCheckpoint => ({
  id: 'cp_1',
  seq: 1,
  snapshotId: 'aa',
  createdAt: '2026-11-03T03:00:00Z',
  reason: 'scheduled',
  schemaVersion: 1,
  bytes: 1,
  bytesAdded: 1,
  applianceId: 'wb-home',
  own: false,
  check: null,
  ...over,
});

describe('the pure parts', () => {
  it('resumes a restore under way where it is', () => {
    expect(stepOfRestore(null)).toBeNull();
    expect(stepOfRestore({ phase: 'none' })).toBeNull();
    expect(stepOfRestore({ phase: 'restoring' })).toBe('working');
    expect(stepOfRestore({ phase: 'checking' })).toBe('almost');
    expect(stepOfRestore({ phase: 'failed' })).toBe('failed');
  });

  it('reads the old Whombat’s name from a kit file', () => {
    expect(kitWhombatName(KIT)).toBe('Home');
    expect(kitWhombatName('{"kind":"x"}')).toBeNull();
  });

  it('marks the newest backup and says why the others were made and which were checked', () => {
    const rows = chooseRows([
      cp({ id: 'a', check: { at: '2026-11-03T05:00:00Z', ok: true } }),
      cp({ id: 'b', reason: 'pre-migration', releaseId: '0.198' }),
    ]);
    expect(rows.map((r) => r.newest)).toEqual([true, false]);
    expect(rows[0]?.meta).toMatch(/checked: it restores$/);
    expect(rows[1]?.meta).toMatch(/Before the update to 0\.198$/);
  });

  it('from the app, resumes only a restore under way', () => {
    expect(stepOfRestoreLater({ phase: 'released' })).toBeNull();
    expect(stepOfRestoreLater({ phase: 'failed' })).toBe('failed');
    expect(stepOfRestoreLater({ phase: 'checking' })).toBe('almost');
  });

  it('moves the steps past the check while the runtime is away', () => {
    const state = {
      phase: 'restoring' as const,
      stage: 'check',
      since: null,
      error: null,
      restored: null,
      oldApplianceId: null,
      relogin: [],
      servers: null,
      items: [],
    };
    expect(awayState(state, true)).toBe(state);
    expect(awayState(state, false)).toBeNull();
    const later = { ...state, stage: 'database' };
    expect(awayState(later, false)).toBe(later);
  });
});
