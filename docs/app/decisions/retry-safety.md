# Retry safety from the contract, not from op names (AP-570…AP-582)

The secure session decided what to do with a request whose answer it lost from the op's name: `defaultIsDestructive`
matched `DELETE` and a word list (`merge|deploy|decide|delete|remove|revoke|…`), and after `status` answered `not_found`
it resent everything else with the same id. A mutation that acts before its commit (a GitHub merge, a repository made on
disk, a sign-in console) but doesn't look dangerous by name was resent — and ran twice — and every new op inherited
that. Contracts 0.29.0 classify every operation (`OperationSpec.destructive` and `retry: safe | receipt | never`,
`OPERATION_SAFETY`, CT-194); the session now follows that.

What `not_found` means: the appliance has no receipt for the id. For a `receipt` op that was never acknowledged
(`accepted`, or `executing` from `status`), and within the receipt retention (`WHOMBAT_COMMAND_RECEIPT_HOURS`, 7 days by
default, after which finished receipts are swept), that means it never committed. Nothing more: after an acknowledgement
it means the receipt expired, and for an op that acts before its commit it proves no absence of effect.

## Decisions

- **AP-570 The session's retry policy is the contract's (`retryPolicy`).** After a reconnect a `safe` op (a read) is
  asked again as it is; anything else is checked with `status` first, and a finished receipt's stored outcome is the
  answer (a `secret` op's is `OutcomeRedactedError`). The same request — same id, exact input — is sent again only when
  `status` answered `not_found`, the op is `receipt` and not destructive, and the appliance never acknowledged it
  (AP-574); everything else becomes `OutcomeUnknownError`. An op the contract doesn't list (a newer runtime's, an
  `invoke` of another name) is never asked or sent again by itself, even one the caller calls a read. `isDestructive`
  stays, stricter only: it adds to the contract's `destructive`, never removes it. `defaultIsDestructive` is the
  contract's mark (an unlisted op: when it is a DELETE). The classification is advice for this client: the appliance
  authorizes every request, and its receipts are what run a resend at most once. Nothing new goes on the wire, so older
  runtimes behave as before with this client.
- **AP-571 Never sent vs. outcome unknown.** A request still queued when the session closes fails as
  `SessionClosedError` (nothing happened); one already sent — a mutation that may have been applied — fails as
  `OutcomeUnknownError` with the `SessionClosedError` as its `cause`. The command tracker maps `NotDeliveredError` (and
  `NetworkError`, `SessionClosedError`, `AbortError`) to `not_delivered` and `OutcomeUnknownError` to `unknown`.
- **AP-572 “Not sent” only when the receipt proves it** — narrowed by AP-574 and AP-577.
- **AP-573 The fake appliance keeps receipts like the runtime.** Digests are `receiptDigest` (over the op alone for
  `secret` ops); a secret op's `status` is `redacted` and a same-id retry of a finished one gets `unknown_outcome`.
  `faults.loseBeforeCommit(n)` runs a mutation's handler and drops the connection before its commit, leaving no receipt
  and no `accepted` (what a runtime does when a session closes before the first commit); `faults.expireReceipts()`
  forgets finished receipts (the retention sweep). `stats().attempts` records every request with its digest, lost ones
  included, and `stats().statusAsked` every `status`.
- **AP-574 Once acknowledged, never resent.** A request the appliance acknowledged — the `accepted` frame, or `status`
  answering `accepted` or `executing` — remembers it across reconnects; a later `not_found` means its receipt was swept
  (a device away longer than the retention), so it is `OutcomeUnknownError`, never a resend. `executing` counts although
  a runtime may answer it before its commit (A4 below): the safe side. This is `nextCommandState`, which keeps `accepted`
  on `not_found`. The command tracker keeps the same fact (`TrackedCommand.acknowledged`, set by `progress` and `check`).
- **AP-575 A request never sent is sent when the connection opens.** On a fresh connection a queued request is sent
  before anything else is decided, an ephemeral one (`enroll.claim.begin` asked before the first connection) included;
  if it can't be sent before its deadline it is `NotDeliveredError`. Only an ephemeral op already sent on a lost
  connection is `OutcomeUnknownError`, and typing and presence simply lapse.
- **AP-576 Aborted or cancelled after it was sent: outcome unknown.** `cancel` stops a request only before it is
  accepted, and only if it arrives in time. So an abort (the caller's signal) or the appliance's `error{cancelled}` ends
  a read, or a request never sent, with `AbortError` as before, and anything else with `OutcomeUnknownError` whose
  `cause` is the `AbortError`. `uploadFile` turns an abort during the reservation into its `UploadError('Cancelled.')`
  either way (an unused reservation is removed by the appliance's orphan sweep).
- **AP-577 “Not sent” only for what the session itself would resend.** The tracker's `check` turns `not_found` into
  `not_delivered` (“Not sent”, Send again with the same id) only when `resendAfterNotFound(op)` holds — a `receipt` op
  that isn't destructive — and it was never acknowledged. Destructive ops stay `unknown` (“Not confirmed yet”): some act
  before their commit (`connections.remove` revokes the Google grant first; `signins.logout`, `providers.logout`,
  `signins.orgRemove`, `providers.org.remove` and `clients.remove` act on the runner or the manager first), so a person
  checks the current state instead. Contracts 0.29.1 (CT-195) classifies those six as `never`.
- **AP-578 Accepted work isn't waited for without end.** After a reconnect, `status` for accepted work is asked at
  `statusPollMs` (2 s), doubling while nothing changes up to `statusPollMaxMs` (30 s). After `acceptedWaitMs` (10 min)
  without progress — the same `accepted` or `executing` again and again — the session stops and rejects with
  `OutcomeUnknownError`, `acknowledged: true`: never resent, and the command tracker shows “Not confirmed yet” with
  Check again. A runtime before contracts 0.29.1 answers `accepted` for ever when the process that ran a command died
  after its commit; 0.29.1 answers `completed` + `redacted` instead (AP-580). Accepted work on a connection that stays
  up is still simply waited for (its result comes on that connection). Two `status()` callers asking about one id each
  get the answer: an earlier caller timing out no longer removes a later one's; closing the session ends them at once
  with `SessionClosedError` and clears their timers.
- **AP-579 A tracked command is never stuck.** `TrackedCommand.settled` says the call is over; `canCheck(command)` is
  true for `unknown`, and for `accepted` / `executing` once settled (what a person's check found). The web's delivery
  line keeps Check again beside “Received · working on it” then, until a check finds it finished. Existing copy only.
- **AP-580 Done, but its answer isn't kept.** `OutcomeRedactedError` with state `completed` (`wentThrough`, now in
  `@whombat/client` and `@whombat/client/session` as well as `/signins`) means the op went through — any op, not only a
  `secret` one (CT-195). The tracker calls it `completed` (as the settle and `check` paths already did; `status()` now
  also says `redacted: true`). The provider (`WhombatClientProvider`) refetches the queries on screen when a mutation
  ends that way, since something changed that no answer shows. A sent message stays in the conversation (not back in
  the composer) until the refetched list has the stored copy; a message's delete, edit and pin say what they say on
  success (“Message deleted.”, the edit closes, “Pinned to …”). Other screens still show their own error for it, over
  the refetched state. No new copy. Answers lost together (after a reconnect) make one refetch: the provider batches
  them over 50 ms. A delete that went through closes the thread pane of its root as a successful one does (since AP-553
  a deleted message leaves with its thread).
- **AP-581 The fake appliance keeps receipts closer to the runtime.** Receipts are keyed by (principal, op, id), the
  principal being the account or `peer:<endpoint>`; `status` answers the principal's newest receipt of the id. The
  handler is the command's work up to its commit: the receipt reads `executing` while it runs, `accepted` is sent after
  it (a refusal commits nothing and gets none), and `slowAccept` is the time between `accepted` and the result. A
  retry of a finished `secret` op's error gets only its code and message. `faults.loseAfterCommit(n, 'accepted' |
  'redacted')` models a process that died after the commit, as runtimes before 0.29.1 and 0.29.1 answer it.
- **AP-582 `unknown_outcome` is unknown, whatever the op.** A runtime that knows a command acted outside its commit
  before its answer was lost (Whombat CS-01…CS-08) answers `status` with `outcome{rejected, error.code:
  unknown_outcome}` and a same-id retry with `error{unknown_outcome}` (CT-196). The session reads both as
  `OutcomeUnknownError`, acknowledged — never resent, never a refusal; only a `secret` op's retry keeps its
  `OutcomeRedactedError` (state null, CT-44). `status()` answers `{state: 'unknown', acknowledged: true}`, and the
  tracker's `check` keeps it “Not confirmed yet” with Check again, never “Didn't go through” or “Not sent”. The fake's
  `faults.loseBeforeCommit(n, 'unknown_outcome')` models it.

## Known limits (not fixed here)

- **A4 `executing` before the commit.** A runtime answers `status` with `executing` for a receipt it received and is
  still running, before its first commit (Whombat `receipts.ts` `publicState`: `received` + live). The session treats
  `executing` like `accepted`: it clears the delivery deadline and polls, up to `acceptedWaitMs` without progress
  (AP-578), rather than failing at the delivery deadline. AP-574 counts it as acknowledged (no resend); the tracker
  offers Check again (AP-579).
- **A5 Accepted, result gone** — addressed by AP-578 (bounded) and, with runtimes from contracts 0.29.1, `completed` +
  `redacted` (AP-580).
- **A7 Nothing on the runtime keeps the table honest.** The classification is by hand; a change to an op's handler
  (a new outside effect before its commit) can make its `receipt` wrong without any test failing. CT-194 carries the
  checklist for adding or changing an op's handler.

AP-14's “resent with the same id, except destructive operations (…`defaultIsDestructive`)” now reads: resent only as
AP-570 allows.
