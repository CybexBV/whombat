import { useQueryClient } from '@tanstack/react-query';
import {
  AVATAR_COPY,
  avatarErrorText,
  INBOX_WORDS,
  quietChoiceOf,
  SETTLE_QUIET_CHOICES,
  SETTLE_WORDS,
  settleNote,
} from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import {
  useApiMutation,
  useBootstrap,
  useChatPreferences,
  useSaveChatPreferences,
  useTheAgent,
} from '@whombat/client/react';
import type { ChatPreferences } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { PersonName, PersonTitle } from '@whombat/core/domain';
import { type ChangeEvent, type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { PersonAvatar } from '../messaging/PersonAvatar';
import { photoFromFile } from './photo';
import styles from './SettingsScreen.module.css';
import { useDeveloperTools } from './useDeveloperTools';

/**
 * Settings → You → Profile (the default; settings-groups.md; was General and About you, SS-01): PROFILE —
 * your name, title and photo — then CHAT (when threads settle by themselves, chat-settle.md AP-6156). What the
 * assistant remembers is its own group's Memory; your signing key is in Advanced.
 */
export function ProfileTab({ burrow }: { burrow: string }) {
  return (
    <>
      <ProfileSection burrow={burrow} />
      <ChatSection burrow={burrow} />
    </>
  );
}

/**
 * CHAT (Whombat chat-settle.md CHS-06, chat-inbox.md CIB-09; app chat-inbox-web.md): when threads settle by themselves —
 * never, after a day, three days or a week — and, for a developer, when the pull request they asked for merges, then
 * the note that one the assistant works on or that waits for an answer never does. Saved at once
 * (`me.updatePreferences`), like the theme.
 */
function ChatSection({ burrow }: { burrow: string }) {
  const ids = useId();
  const toast = useToast();
  const { words } = useTheAgent(burrow);
  const prefs = useChatPreferences(burrow);
  const save = useSaveChatPreferences(burrow);
  // Pull requests are a developer's: the switch shows only where GitHub or website feedback is connected.
  const developer = useDeveloperTools(burrow);
  const change = (next: ChatPreferences) =>
    void save(next).then(
      (ok) => ok || toast.show('Couldn’t save that. Try again.'),
      () => toast.show('Couldn’t save that. Try again.'),
    );
  // A day count set elsewhere (the assistant may set 1–90) shows as the nearest choice until one is picked here.
  const quiet = quietChoiceOf(prefs.settleQuietDays);
  const choices = SETTLE_QUIET_CHOICES.map((c) => ({ value: String(c.days ?? 'never'), label: c.label }));
  return (
    <section className={styles.section} aria-labelledby={`${ids}-chat`} data-section="chat">
      <SectionLabel as="h2" id={`${ids}-chat`}>
        {SETTLE_WORDS.chat.toUpperCase()}
      </SectionLabel>
      <div className={styles.card}>
        <div className={cx(styles.row, !developer && styles.lastRow)} data-quiet-choice="">
          <span className={styles.rowMain}>
            <span className={styles.rowTitle} id={`${ids}-quiet`}>
              {INBOX_WORDS.quietChoice}
            </span>
            <span className={styles.rowMeta} id={`${ids}-quiet-hint`}>
              {INBOX_WORDS.quietChoiceHint}
            </span>
          </span>
          <SegmentedControl
            label={INBOX_WORDS.quietChoice}
            role="radiogroup"
            size="sm"
            describedBy={`${ids}-quiet-hint`}
            options={choices}
            value={String(quiet.days ?? 'never')}
            onChange={(v) => change({ ...prefs, settleQuietDays: v === 'never' ? null : Number(v) })}
          />
        </div>
        {developer ? (
          <div className={cx(styles.row, styles.lastRow)}>
            <span className={styles.rowMain}>
              <label className={styles.rowTitle} htmlFor={`${ids}-merged`}>
                {SETTLE_WORDS.mergedSwitch}
              </label>
              <span className={styles.rowMeta} id={`${ids}-merged-hint`}>
                {SETTLE_WORDS.mergedHint}
              </span>
            </span>
            <Toggle
              id={`${ids}-merged`}
              checked={prefs.settleMerged}
              aria-describedby={`${ids}-merged-hint`}
              onCheckedChange={(on) => change({ ...prefs, settleMerged: on })}
            />
          </div>
        ) : null}
      </div>
      <p className={styles.sectionNote}>{settleNote(words.name)}</p>
    </section>
  );
}

/**
 * PROFILE: name and title (`me.updateProfile` — the account and your person in every burrow, each a signed
 * event there) and your photo (`me.setAvatar`, docs/decisions/person-avatars.md PA-05). The key your actions are
 * signed with is Advanced's (`SigningKeyRow`).
 */
function ProfileSection({ burrow }: { burrow: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const ids = useId();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const updateProfile = useApiMutation(api.me.updateProfile);
  const setAvatar = useApiMutation(api.me.setAvatar);
  const fileInput = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const me = bootstrap?.me;
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Start from (and follow) the saved profile until the person edits a field.
  const savedName = me?.name ?? '';
  const savedTitle = me?.title ?? '';
  useEffect(() => {
    setName(savedName);
    setTitle(savedTitle);
  }, [savedName, savedTitle]);

  const dirty = name.trim() !== savedName || title.trim() !== savedTitle;

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    const parsedName = PersonName.safeParse(name);
    if (!parsedName.success) {
      setError(parsedName.error.issues[0]?.message ?? 'Tell us your name.');
      return;
    }
    const parsedTitle = PersonTitle.safeParse(title);
    if (!parsedTitle.success) {
      setError(parsedTitle.error.issues[0]?.message ?? 'That title is too long.');
      return;
    }
    setError(null);
    const result = await updateProfile.mutateAsync({
      body: { name: parsedName.data, title: parsedTitle.data },
    });
    if (result.status === 'ok') {
      refreshProfile();
      toast.show('Profile saved.');
    }
  }

  /** What shows the person: this burrow's bootstrap and the account. */
  function refreshProfile() {
    void qc.invalidateQueries({ queryKey: queryKeys.conversations.bootstrap({ params: { burrow } }) });
    void qc.invalidateQueries({ queryKey: queryKeys.me.get() });
  }

  /** A new photo (base64, cropped and sized here) or none (`null`): account-wide, like the name. */
  async function savePhoto(image: () => Promise<string | null>) {
    setPhotoBusy(true);
    try {
      const photo = await image();
      const result = await setAvatar.mutateAsync({ body: { image: photo } });
      if (result.status === 'ok') {
        refreshProfile();
        toast.show(photo === null ? AVATAR_COPY.removed : AVATAR_COPY.saved);
      }
    } catch (err) {
      toast.show(avatarErrorText(err));
    } finally {
      setPhotoBusy(false);
    }
  }

  function handlePhotoPicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // The same file picked again must fire `change` again.
    event.target.value = '';
    if (file) void savePhoto(() => photoFromFile(file));
  }

  const canChangePhoto = !!me && !photoBusy;
  const pickPhoto = () => fileInput.current?.click();

  return (
    <section className={styles.section}>
      <SectionLabel as="h2">PROFILE</SectionLabel>
      <div className={styles.card}>
        <form className={`${styles.row} ${styles.profileRow}`} onSubmit={handleSave} noValidate>
          {me ? (
            // The avatar is the way to a new photo too (PA-05): the same picker as Change photo.
            <button
              type="button"
              className={styles.avatarButton}
              onClick={pickPhoto}
              disabled={!canChangePhoto}
              aria-label={AVATAR_COPY.change}
              title={AVATAR_COPY.change}
              data-photo-button=""
            >
              <PersonAvatar
                avatarUrl={me.avatarUrl}
                initials={me.initials}
                tone={me.tone}
                size={32}
                label={me.name}
              />
            </button>
          ) : (
            <span className={styles.avatarSlot} aria-hidden="true" />
          )}
          <div className={styles.profileFields}>
            <label className={styles.profileField} htmlFor={`${ids}-name`}>
              <span className={styles.fieldLabel}>NAME</span>
              <Input
                id={`${ids}-name`}
                size="lg"
                autoComplete="name"
                maxLength={80}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                invalid={error !== null}
                aria-describedby={error ? `${ids}-error` : undefined}
              />
            </label>
            <label className={styles.profileField} htmlFor={`${ids}-title`}>
              <span className={styles.fieldLabel}>TITLE</span>
              <Input
                id={`${ids}-title`}
                size="lg"
                autoComplete="organization-title"
                maxLength={80}
                placeholder="Engineering lead"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            {error && (
              <span id={`${ids}-error`} className={styles.fieldError} role="alert">
                {error}
              </span>
            )}
          </div>
          <Button
            type="submit"
            variant="secondary"
            size="lg"
            disabled={!me || !dirty || !name.trim() || updateProfile.isPending}
          >
            Save
          </Button>
        </form>
        <div className={styles.row} data-photo-row="">
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>Photo</span>
            <span className={styles.rowMeta}>
              Shown with your name. Any picture works: it’s cropped to a square.
            </span>
          </span>

          {me?.avatarUrl ? (
            <Button
              variant="link"
              size="sm"
              disabled={!canChangePhoto}
              onClick={() => void savePhoto(async () => null)}
            >
              {AVATAR_COPY.remove}
            </Button>
          ) : null}
          <Button variant="secondary" size="lg" disabled={!canChangePhoto} onClick={pickPhoto}>
            {AVATAR_COPY.change}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={handlePhotoPicked}
            data-photo-input=""
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Your signing key (Settings → Advanced → Audit log and signing keys): everything you do on this Whombat is
 * signed with it; its fingerprint, for comparing with the audit log's.
 */
export function SigningKeyRow({ burrow }: { burrow: string }) {
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  return (
    <div className={styles.row}>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>Your signing key</span>
        <span className={styles.rowMeta}>
          Everything you do on {bootstrap?.burrow.name ?? 'this Whombat'} is signed with it.
        </span>
      </span>
      <span className={styles.fingerprint} title="Key fingerprint">
        {bootstrap?.me.fingerprint ?? ''}
      </span>
    </div>
  );
}
