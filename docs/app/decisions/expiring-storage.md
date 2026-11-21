# Held links on expiring records, and storage that fails (AP-590…AP-595)

Review finding, 2026-09-30: the web's held links (`ManagedRoot.tsx`: the link to get back in, invite and add-a-device
links, control's organization invitation, the card's claim secret) were cast from `JSON.parse` without checking their
shape, took a timestamp from the future as valid (`Date.now() - at < ttl` holds for any future `at`), were ignored but
never removed once expired, got a new expiry on every write (accepting a re-enrollment reset its 24 hours), and threw
from `setItem`/`removeItem` (a full or disabled storage broke the page's first render). Only the `/signup` code
(AP-161) dropped stale and future records. No contract changes.

## Decisions

- **AP-590 One expiring record, in the shared client (`@whombat/client/storage`).** `expiringRecord({storage, key,
  schema, ttlMs, legacy?, now?})` answers `read`, `entry` (value, `heldAt`, `expiresAt`), `hold`, `update` and
  `clear(which?)`. Pure: the storage is handed in as a function (reaching `window.localStorage` can throw), the clock
  too (default `Date.now`, looked up on each use).
  - **Format** `{"v":1,"heldAt":…,"expiresAt":…,"value":…}`: times finite non-negative integers (ms), `expiresAt`
    after `heldAt`, `value` checked against the record's Zod schema on every read. Anything else is invalid.
  - **Boundary.** Valid while `now < expiresAt`; expired at `expiresAt` exactly (as the signup code already was).
    Never longer than `ttlMs` after `heldAt`, whatever `expiresAt` says, so a shorter lifetime in a later version
    applies to records already held.
  - **Clock skew: 5 minutes** (`EXPIRING_CLOCK_SKEW_MS`). The same browser writes and reads with the same clock, so a
    `heldAt` in the future only comes from the clock being set back since (an NTP step, a manual change). Five minutes
    covers ordinary corrections and extends a record by at most that much; anything later can't have been written by
    this clock and is invalid. (The signup code allowed none before; a code held a few minutes “ahead” now reads.)
  - **Lifetime.** `hold` is a new hold with a new expiry (a new link arrived). `update(change)` keeps the expiry
    (progress in the same journey). Reading, and migrating a legacy record, never extend it.
  - **Legacy.** With `legacy: {ttlMs}`, a record from before this format (`{…value, at}`) reads as held at `at` for
    its old lifetime (never more than `ttlMs`), and is rewritten in this format with that same expiry.
  - **Cleanup.** Invalid and expired records are removed when read; only the record's own key is ever touched.
  - **Failures never throw.** Storage that can't be reached, read or written reads as nothing held. A hold that can't
    be written answers false and clears the key, so an older value (another Whombat's invite, an older organization
    invitation) never stands in for the link that just arrived. A record that must go but can't be removed gets a
    tombstone for this page (per storage object and key) holding exactly the raw text that had to go; when the
    storage can't even be read, the raw text this page last read or wrote (none if it never saw one). It is never
    read as valid again, while a different value another tab writes later is read, and never removed by this tab. A
    successful write or remove lifts it. A clear of one Whombat's record (`clear(which)`) on storage that can't be
    read decides on that last-seen text too. A failed `update` answers false and leaves the previous value; callers
    whose previous value holds a used secret clear it (AP-591).
  - **Not a security boundary** (said in the module's doc comment): whoever controls the device's storage controls
    these records. The appliance's and control's own expiry, authorization and one-time use of a link stay what
    counts; this only keeps a browser from resuming a journey it should have forgotten.

- **AP-591 The web's held links (`apps/web/src/managed/held.ts`).** Six records in `localStorage` (the magic link opens
  in a new tab, whose `sessionStorage` is empty), keys unchanged:
  `whombat:reenroll-link` 24 hours (the link's own lifetime, CT-51); `whombat:invite-link`,
  `whombat:add-device-link`, `whombat:org-invitation` 7 days; `whombat:claim-card` and `whombat:signup-code` an hour.
  Each keeps its old lifetime for legacy records (the signup code its hour from AP-161, not the older seven days).
  - **Shapes** are what the link parsers give: the invite and re-enrollment secrets as `InviteSecret` /
    `ReenrollSecret`, identities as PeerIds (or null for a link from before AP-67), the claim card's device and secret
    as `parseClaimFragment` checks them, the organization token as `parseOrgInvitationLink` does, a code of 1–64
    characters. The re-enrollment record may carry `accepted` and a null secret.
  - **Getting back in.** Accepting the re-enrollment is an `update` of that Whombat's record (secret dropped,
    `accepted` added): the expiry stays the one the link got when it was opened, and a reload while waiting for the
    owner resumes it. A record for another Whombat is left alone. When that update can't be stored (storage full),
    the record goes (`holdReenrollAccepted`): it still held the secret just used, and a reload would offer to accept
    it again; the reload now shows the missing-link words instead. The other writes need no such step: a failed
    `hold` already leaves nothing held, and every other change is a `clear`.
  - **When they go.** When the journey ends or is left (claimed, joined, back in, “Back”, “Claim with the code on its
    screen instead”); journey clears only take the record when it names that journey's Whombat. Forgetting a Whombat
    takes the invite, add-a-device and get-back-in links that name it. **Sign-out now forgets all six** (it forgot
    only the signup code, AP-161): a link, card or code is this browser's user's, not the next one's; someone who
    signs out in the middle of a journey opens the link from the email again. Account deletion forgets all six, as
    before. Signing in (the magic link, also in a new tab, also as another account without signing out first) keeps
    them: that round trip is what they are held for. Nothing is ever logged.
  - **A link that can't be held** (storage full or off): its fragment still leaves the address bar, and the journey
    goes on as without a held link (the screens' existing words for a missing or old link) instead of the blank page
    the throwing `setItem` gave. No new copy.

- **AP-592 The Google connect on the same record.** `holdGoogleConnect` / `heldGoogleConnect` (`sessionStorage`,
  30 minutes, AG-14) had the same faults. They keep their signatures and the `at` they answer; they now also take a
  function that reaches the storage (the web passes `() => sessionStorage`), `holdGoogleConnect` answers whether it
  held, the return path is checked as part of the record's shape, a future-dated or stale connect is removed, and one
  held exactly 30 minutes ago has expired (was: still valid). **A connect that can't be held doesn't start**
  (`useConnectGoogle`): before, the throwing `setItem` stopped it; answering false must not let it go on to Google and
  come back to `/connect/google` without knowing which Whombat started it (which falls back to the Whombat last used).
  The person sees the existing “Couldn’t start connecting Google. Try again in a moment.” No new copy. The fallback
  itself stays (AG-14: a tab that lost its record); the appliance's own check of Google's `state` still refuses an
  answer it didn't start.

- **AP-593 What stays as it is.** The phone keeps invite, add-a-device, get-back-in, claim and organization-invitation
  links in the route's state in memory (`ManagedApp`), never on disk, so there is nothing to move there; if it ever
  keeps one across launches it uses AP-590 on its preloaded file storage. The appliance registry (pins, not
  temporary), the cloud token store, push registrations and preferences aren't expiring records and keep their own
  storage (made fail-safe by AP-594).

- **AP-594 Storage that fails never blanks the app, and nothing unsaved pretends to be saved.** Round 2 of the review:
  the other stores threw on a full, turned-off or unreachable storage (private modes, sandboxed frames, quota).
  - **The appliance registry** (`createRegistry`, shared). A write that fails is kept for this page as changes (put,
    forgotten, last used; per storage and account, so a remount sees them too), never as a copy: every read applies
    them to what storage holds now, so other tabs' Whombats, pins and forgets count; a pin in storage wins over the
    page's own (its put is dropped, and a new one for another identity is refused) unless a claim replaces it
    (AP-63); the next write that works merges the changes into what storage holds then, and a write while storage
    can't be read keeps them instead of replacing what it couldn't see. A forget made while storage failed stays
    forgotten when the page writes again. A clear that fails empties it for this page. Reads that fail are an empty registry. `saved()` is false while
    something is kept for this page only. Before, `put` threw: in the claim's `onClaimed` it left the claim screen
    with an error after the Whombat was already claimed, and in `LinkTrust`'s effect it unmounted the page. The
    browser's `localStorage` is reached when used (the default is a function now).
  - **Telling the person.** While `saved()` is false the Whombats list shows the existing “This browser can’t keep
    a device key safely. Use a recent Chrome, Edge, Firefox or Safari.” in its error line (no new copy): this browser
    can't keep what it needs to remember a Whombat, and after a reload it asks to be set up again (the recovery kit,
    which the claim saves next, or a link). Everything keeps working for this page. The list is the place: it is
    where a Whombat is remembered or not. (A browser that can't reach storage at all can't keep the endpoint key in
    IndexedDB either and already stops at the same words, `ConnectionGate`.)
  - **The cloud token** (`createHttpControl`, shared by web and phone): its store never fails the client. A token
    that can't be stored signs in this page (or app run) only, and the older stored token is removed so another
    account's doesn't stand in after a reload; one that can't be read is none (signed out); one that can't be
    removed is gone for this page all the same (control ends it on sign-out). Before, a failed write made a good
    magic link say “That sign-in link doesn’t work any more.” after using it up. The web's `storageTokenStore`
    reaches `localStorage` when used: `realEnvironment` no longer throws before the first render (a blank page).
  - **Push registrations** (web `localPushStore`, phone `secretPushStore`): unreadable is none; a write that fails
    rejects (never pretends it was saved; registering reports its existing failure). The tidy-ups that only drop a
    Whombat from the local list (forgetting one, a revoked device, “Set up this device again”) ignore a failure, so
    they always finish: before, a refusing store stopped “Set up this device again” half-way.
  - **The phone.** Its registry is a preloaded file that already never throws (a failed write is retried on the
    next change; it doesn't report it, so the phone shows nothing: left as is). A keystore that refuses now reads as
    signed out when the self-hosted app starts (it waited for ever), and the theme choice reads as System and a
    refused save holds for the run (both were unhandled rejections).
  - Already safe and left alone: the web's burrow memory, theme, recent emoji, the welcome, the self-hosted push
    device id.

- **AP-595 Accepted re-enrollment progress names the key that accepted it.** A re-enrollment lets in the endpoint key
  whose session accepted it (CT-51). The web knows its key by its PeerId (`EndpointKey.peerId`, what the signed-in
  tree is keyed by), so `accepted.endpoint` stores that PeerId (the fingerprint the owner compares is derived from
  it). `heldReenrollFor(device, endpoint)` resumes progress only for that key; progress another key accepted (this
  browser was set up again since, AP-39) is never resumed and is removed, and the page shows the missing-link words.
  Progress held before AP-595 names no key and resumes as before until its 24 hours end. A link not yet accepted
  isn't bound: any key of this browser may use it.

## Known effect of the deploy

A tab still running the version before AP-590 while the new one is deployed reads the new format as invalid: its
`heldSignupCode` removes a `whombat:signup-code` record whose `code` isn't a string, so a code held by a new tab can be
dropped by an old tab that renders meanwhile (the old reads of the other held links only ignore it). One deploy only,
and the person types the code (or opens the `/signup` link) again; no code change.

## Tests

AP-594/AP-595: `registry.test.ts`, `tokens.test.ts` (client), `connect.test.ts`, `webPush.test.ts`, `held.test.ts`
(web), `stores.test.ts`, `session.test.ts`, `theme/preference.test.ts` (phone), and `held.spec.ts`: a claim whose
registry can't be stored completes, the list says the browser can't keep it, the Whombat opens for this page and after
a reload asks to be set up; progress another key accepted is refused and removed.


`packages/client/src/storage/expiring.test.ts` (a fake storage that throws on get, set, remove and quota; an injected
clock): resume, the exact boundary, the lifetime cap, skew accepted up to 5 minutes and not after, non-integer and
non-finite times, malformed JSON and wrong shapes, legacy kept until its original expiry and migrated with it, update
and migration keeping the expiry, tombstones (only of values this page saw; another tab's later value is read and
kept). `apps/web/src/managed/held.test.ts`: each record's lifetime and legacy shape, parser-shaped values only,
re-enrollment progress (and its failed write taking the used secret), sign-out/account deletion and forgetting a
Whombat, storage that throws. `signupCode.test.ts` and `google.test.ts` gained storage-failure and future/expired
cases; `useConnectGoogle.test.tsx` checks a connect that can't be held never starts. Playwright
`e2e-managed/held.spec.ts`: a card held through the sign-in in a new tab and a reload, then gone once claimed; an
accepted re-enrollment resumed after a reload with its expiry unchanged, then gone once in; progress that can't be
stored taking the used secret, so a reload doesn't offer it again; an expired or future-dated
get-back-in link, organization invitation and card ignored and removed with nothing resumed; sign-out forgetting every
held record and nothing else.
