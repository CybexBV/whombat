# Workstream: mail over IMAP and SMTP (stream E of “more connections”, 2026-10-19)

Builds CM-19…CM-27 and CM-D01…CM-D03 of `connections-more.md` (contracts 0.97.0, migration 0119). The lead's decisions
are not repeated; what this stream decided while building is below.

## The adapter

- **CM-M01 A third implementation of the mail methods.** `connectors/imap/workspace.ts` `ImapWorkspace` implements
  `GoogleWorkspace`; `providers.ts` gives it for `imap`, so `mail_search`, `mail_read`, `mail_attachment`, `mail_draft`,
  `mail_send` (its approval and executor) and `mail_organize` run unchanged. Every other method answers “Email (IMAP)
  only does mail.”. The “token” the tools pass is the connection's id (`ConnectionTokens.accessFor` for `imap` hands it
  out while the connection is active and touches `last_used_at`); the adapter loads the account and opens the password
  itself, so the password never travels through the tool layer.
- **CM-M02 Ids.** Messages exactly as CM-24. Threads: `base64url(R\0<folder>\0<root>)` for a References root (first id
  of References, else In-Reply-To, else the own Message-ID), `base64url(M\0<folder>\0<UIDVALIDITY>\0<UID>)` for a
  message alone (no Message-ID, or a root too long for an id). A thread is read in its folder, the inbox and Sent by a
  `HEADER` search for the root in Message-ID, References or In-Reply-To, the newest 50, oldest first, one copy per
  Message-ID. That works on every server, so the THREAD extension isn't used (imapflow doesn't speak it). A thread id
  names the inbox for a message in Drafts or Sent, so a draft and its sent reply carry the original's thread id. Ids
  stay within 200 characters (`MailSummary.id`): a folder name too long for that is written as `\x01` and the first 16
  bytes of its SHA-256 and found again by listing the folders.
- **CM-M03 Search words** (CM-25) as the table in `search.ts`, plus: `a OR b`; `label:` means `in:` (labels are
  folders); `in:anywhere`/`in:all` is the `\All` folder where there is one; `has:attachment` is the nearest IMAP has
  (`HEADER Content-Type multipart/mixed`); `is:unstarred`. A negated `in:` is left out (IMAP searches one folder). A key
  used twice (two words, two `from:`) is nested, as imapflow parenthesises an operand. IMAP dates are days: `newer_than`
  and `after:` are UTC days. Newest first means the highest UIDs, sorted by when the server received them. A folder that
  isn't there answers with the folder names (for the agent).
- **CM-M04 One connection per call** (connect, sign in, work, log out), as a socket call is one socket. `session.ts`
  `ImapSession` is the narrow set of commands the adapter uses, over imapflow (`openImapflow`) and over an in-memory
  account (`memory.ts`, tests only), so the adapter's logic is tested without a server. Reads have a 30 s whole-call
  deadline; sending has none beyond the socket timeouts (connect and greeting 10 s, idle 30 s), so a send is never cut
  short after the server took the message. Fetches use `BODY.PEEK`: reading never marks mail read.
- **CM-M05 Drafts and sending** (CM-26). A draft is Gmail's draft format (`mime.ts` `buildRawMessage`) with `From`
  (the Whombat account's name and the address), `Date` and a new `Message-ID` on the address's domain, appended to Drafts
  with `\Draft \Seen` (Drafts is made when the account has none). Without UIDPLUS the new draft is found by its
  Message-ID. Sending reads the draft, recomposes it as read (recipients, subject, text, files, threading headers, the
  same Message-ID) — what the owner approved is what goes out — sends it with the blind copies only in the envelope (the
  `Bcc` header stays in the draft and the Sent copy, not in the message sent), then files the copy in Sent and removes
  the draft. The Sent copy: none where the hints say the provider keeps one (`savesSent`); otherwise Whombat looks for the
  Message-ID in Sent first and appends only when it's missing (the lead's suggestion: it covers providers the table gets
  wrong). Once the server took the message nothing fails the send: the copy and removing the draft are best effort and
  logged. Recipients the server refused while taking it for the others are reported after that, counted, never named.
- **CM-M06 Organising** (CM-27, CM-D01) with `mail_organize`'s input as it is: `read` and `UNREAD` set `\Seen`,
  `STARRED` sets `\Flagged`, a folder name in `addLabels` moves there (one folder per call; a folder that isn't there is
  made, as Gmail makes a label), `INBOX` or `archive: false` moves back to the inbox, `archive: true` moves to `\Archive`
  (else “Archive”, made when missing), and taking away the label of the folder a message is in (`INBOX` included)
  archives it, as on Gmail. `IMPORTANT` and `CATEGORY_*` are refused (“on IMAP, labels are folders”). No trash, on any
  provider (IN-15 stands, CM-D01). Every message must still be there before anything changes; a moved message's old id
  is gone (it has a new UID). Messages show their folder (Gmail's ids `INBOX`, `SENT`, `DRAFT`, `TRASH`, `SPAM` for the
  special ones, else the path) and `STARRED`, `UNREAD`, `DRAFT` from their flags. Moving without the MOVE extension, and
  removing a draft, expunge by UID only with UIDPLUS; without it the message is only marked `\Deleted`, so another
  client's deleted-but-kept mail is never expunged with it.
- **CM-M07 Failures in words** (CM-22). `errors.ts` sorts imapflow's, nodemailer's and the socket's errors into
  `refused`, `unreachable`, `certificate`, `no_tls`, `not_allowed`, `timeout`, `busy` and `protocol`, each with our own
  sentence naming the side and the server (never what the server said). The connect form gets `IMAP_CONNECT_FAILURES`:
  `no_tls`, `timeout`, `busy` and `protocol` count as that side's `…_unreachable`, with their own words. A refused IMAP
  password marks the connection `needs_reauth` (`password_refused`, CM-D03) and the tool says “Mara’s mail account needs
  a new password …”; RFC 5530's `UNAVAILABLE`, `LIMIT`, `INUSE`, `OVERQUOTA`, `CONTACTADMIN` and SMTP 421/454 are “busy”,
  not a wrong password. An SMTP-only refusal shows in the check (`side: 'smtp'`) without marking the connection.
- **CM-M08 Discovery details** (CM-20). The ISPDB, both autoconfig URLs and the MX lookup run at once; the ISPDB of the
  MX host's registrable domain (`tldts`) only when those found nothing, then SRV. Only the domain is sent anywhere.
  Plain-text servers are dropped; a server that only takes OAuth comes after one that takes a password; implicit TLS
  before STARTTLS; `%EMAILADDRESS%`, `%EMAILLOCALPART%` and `%EMAILDOMAIN%` are filled in (a username that isn't the
  address is kept). Nothing found: core's `imapGuessSettings` (`guess`, CM-D02). The ISPDB answers for gmail.com, gmx.de
  and messagingengine.com (Fastmail) are recorded in `imap/fixtures/` (2026-10-19).
- **CM-M09 The destination policy** (CM-23). A server is checked with the Vault's rule (`vaultDestinationProblem`)
  through a pseudo `https://<host>:<port>/` address: public addresses on any port (nothing crosses the internet
  unencrypted), a home-network address only when its network and port are listed (or the local network is open). The
  host is resolved by the Vault's resolver and the first checked address is dialled; a name is the TLS server name, an
  IP literal is checked as itself (no SNI). Connecting checks with the reason in full (the network to add); calls with
  the short one. Discovery's fetches are https to public addresses only (DNS pinned, 5 s, 256 KB, no redirects); MX and
  SRV use the system resolver with a 3 s timeout. Tests reach fakes through `useMailNetForTests` (refused outside
  `NODE_ENV=test`) and the Vault's address seam.
- **CM-M10 One real run against GreenMail** (2.1.14, IMAPS and SMTPS), by hand, through `agent-resource`:

  ```
  agent-resource run --task "imap test" --ttl 2h --disposable-data -- apps/server/scripts/mail-greenmail.sh "$PWD/apps/server"
  ```

  The script makes GreenMail's keystore from the tests' `mail.home.test` certificate (so TLS checks the chain and the
  name), starts it with `agent-resource docker-run` and runs `src/connectors/imap/greenmail.test.ts` (skipped unless
  `WHOMBAT_GREENMAIL` is set). It covers both sides' sign-in and a refused password, search, read, a file, a thread, a
  draft, sending to itself with the Sent copy, star, read, a folder as a label and archive. Passed on 2026-10-19.
  GreenMail matches `FROM` and `TO` against whole addresses (real servers match any part), so that test searches by
  whole address. (A first `docker run greenmail/standalone --help` by mistake started a container outside the helper;
  it was stopped at once and is gone. The image stays pulled.)

## Storage and the rest of the server

- **CM-M11 Storage** (migration 0119). `connections.mail_settings` (jsonb) holds `ImapServerSettings` and `savesSent`
  (from `imapProviderFor` by the domain and its MX hosts, when connected). The password is the row's long-lived secret in
  `refresh_token_enc`, sealed under the purpose `connection:<id>:password`: no code path, and no older binary, can open
  it as a refresh token. `external_id` is `<username>@<imap host>`, so a reconnect to another mailbox makes earlier
  approvals stale. Services are `['mail']`; one per person; connecting again replaces it; the licence counts it like any
  connector. Connecting stores the check that just passed.
- **CM-M18 A new password keeps the servers** (the lead, from the web stream's “Change password”). `connectors.imapConnect`
  for the address the person's IMAP connection already has, without `settings`, keeps its servers (hosts, ports,
  security, username) and `savesSent` instead of looking them up again; the new password is checked on both sides
  first, and the connection keeps its id. Only a request with `settings`, or another address, changes them.
- **CM-M12 Home** (the Android stream's ask). Mail things link to `/settings?tab=connections&connection=<provider>`.
  An IMAP account shows as “Email” (mark `imap`) with its inbox's unread count from `STATUS UNSEEN`, which opens
  nothing, every 5 minutes with the Google count. Microsoft 365 stays off Home: its search has no unread filter.
- **CM-M13 Backup files leave IMAP accounts out**: the record has no place for the servers, and connecting again is an
  address and a password.
- **CM-M14 Two accounts with mail.** The “provider” refusal names the providers (“Both Google and Email (IMAP) provide
  this service. Specify provider: google or imap …”); with nothing usable, the refusal speaks of the connected one (a
  mailbox that needs a new password says so). The personal agent's prompt says to pass `provider` when two accounts
  have the same service.
- **CM-M15 Words.** The assistant's repair message for a refused mail password is words only (“My email stopped
  working: your mail server refused the password. Enter a new one in Settings → Connections → Email (IMAP) …”), no
  Google card. The email guide's “Other email” is on and says where to connect it; the password is typed in Settings,
  never in chat.
- **CM-M16 Files and big messages.** A message's files are numbered by their place in mailparser's list (an IMAP
  message never changes, so `mail_attachment` reads it again and takes that one). A message over 30 MB is read from its
  first megabyte, marked cut, without its files.
- **CM-M17 Packages**: `imapflow` 2.5 and `mailparser` 3.9 on the server, `smtp-server` for the tests' SMTP server
  (nodemailer was there).

## Left for later

THREAD/SORT extensions; IDLE (new mail as it arrives); several IMAP accounts per person; self-signed certificates on
home-network mail servers (CM-D later); a separate SMTP password; Microsoft 365 on Home.
