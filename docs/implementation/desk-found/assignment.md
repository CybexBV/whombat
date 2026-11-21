# Assignment: found on your network on the screen, Synology and QNAP, the scan's reach

Spec: `docs/decisions/desk-found.md` (DF-01…DF-14, NS-01…NS-08) in this branch. Mockups (the visual reference; PNGs are
authoritative, the HTML shows the CSS): appliance `docs/design/desk-found/frame1.png` (looking), `frame2.png` (done),
`frame3.png` (later, the strip), also `~/.cache/wb-tmp/mockups/desk-found/` (renders with
`node ~/.cache/wb-tmp/mockups/shoot-desk.cjs ~/.cache/wb-tmp/mockups/desk-found`).

Lead: session whombat-02 (merges, releases, ships). Peers build at the same time: whombat-14 (Bluetooth pairing:
contracts 0.109.0 CT-670…699, app 0.111.0 AP-3700…3799, appliance NX-350…369, CG-200…229). Its contracts land on main
before ours; the lead merges them in. Don't take their numbers.

## Streams and worktrees

| Stream | Worktree (branch) | Numbers |
| --- | --- | --- |
| C contracts 0.110.0 | `~/Code/.wt/contracts-found` (found) | CT-700…CT-729 |
| S server | `~/Code/.wt/whombat-found-server` (found-server) | DF-S01…, NS-S01…, migration 0127 |
| P console (desk page + Go broker) | `~/Code/.wt/appliance-found` (found) | CG-230…CG-259, NX-370…NX-389 |
| W app (web + Android) | `~/Code/.wt/app-found` (found) | AP-3800…AP-3899 |

Rules for every stream:
- Read the repo's CLAUDE.md / ARCHITECTURE.md / DECISIONS.md first; follow its conventions, decision files and test rules.
- Commit on your branch (small, imperative, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
  **Never push, never merge into main, never tag or release** — the lead does that.
- DEV is fast: one quick check per repo when you finish (`pnpm format` then `pnpm check`; S also `pnpm test:server`
  once). No VM tests, no CI runs, no repeated full suites, no waiting for future data. One repo's check at a time.
- Use `TMPDIR=/home/me/.cache/wb-tmp`, Node 24 (`export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`).
  Server tests use the shared Postgres :55432 with your own throwaway databases; never stop/reset shared containers.
- Record decisions you take in the decision files named below with your number range. Visible words are plain and
  short (concise-replies.md); copy in DF-09 is verbatim (curly quotes ’ “ ”, middle dot ·, thin-space grouping).
- When you finish, report: branch tip, what you built, what you decided, what you could not verify.

## The contract (C writes it; S, P, W build against this sketch until C's tarballs arrive)

`packages/control-contracts/src/local/desk.ts` (+ JSON Schema + generated Go in `go/local`):

```ts
/** A found service on the glance (DF-01, DF-08). */
DeskFoundItem = z.object({
  catalogId: CatalogId,            // 'homeassistant', 'synology', 'device', …
  name: ConsoleDisplayText ≤ 60,   // “Home Assistant”, “Proxmox VE”
  tagline: ConsoleDisplayText ≤ 40,// DF-08
  address: text ≤ 120,             // shown as is: “10.100.0.5”, “10.100.0.20:32400” (scheme and own port left out)
});
DeskFound = z.object({
  scanning: z.boolean(),
  /** Only while the first automatic scan runs (DF-07): addresses looked at / to look at. */
  progress: z.object({ done: Count, total: Count }).nullable(),
  items: z.array(DeskFoundItem).max(8),
  /** Every new one, `items` included (≥ items.length). */
  count: Count,
  /** When the result shown was finished; null while the first scan runs. */
  finishedAt: Rfc3339.nullable(),
});
DeskGlance.found: DeskFound.optional()   // present exactly when the panel or strip shows (DF-06); additive
```

Desk route `POST /v1/desk/found/dismiss {v} → {v}` (DeskAck), allowed while locked (DF-04); in DESK_PATHS.

`packages/core/src/domain/connections-catalog.ts`:
- `tagline` (optional on an entry, ≤ 40, no full stop; a test requires it on every entry with `discovery`) — C writes
  them all (DF-08).
- Session auth (NS-03): `login.method` also `GET`; `login.query` (templates, optional); `login.encoding` `json`
  (default, today's behaviour) | `form`; a `{field:base64}` template form; the token from JSON (`tokenJsonPath`) or from
  XML (`tokenXmlTag`, exactly one of them); `stale` — answers (by JSON path or XML tag, with values) that mean the
  session ended although the status is 2xx; `failures` — login answers mapped to a reason and the person's words (NS-04).
  Pure helpers for S in core (build the login request, read the token, `isStale`, `loginFailure`), unit-tested.
- Entries `synology` and `qnap` (NS-01…NS-07): discovery targets and probes, the token sign-in with session auth and
  guided steps, fields (address, account name, certificate like TrueNAS), check (`okJsonPath` / XML), `request` with
  prefixes and `queryReads`, `guide`, `sensitive`, `docsUrl`, `tokenUrl`, `handle`, `tagline`. C researches the real
  APIs (Synology DSM Web API: `SYNO.API.Auth` login → `data.sid`, applied as `_sid`; QNAP: `/cgi-bin/authLogin.cgi`
  with `user`, base64 `pwd` → `authSid`, applied as `sid`) from the vendors' docs and writes what it relied on into
  the decision file.
- `EVENT_TYPES` gets `connection.found_hidden` and `connection.found_shown` (CS-D47 promised them for the next minor).
- No SESSION_API_LEVEL bump unless a session op is added (none planned).

C's release flow: build provisional tarballs with the repo's release script into `~/Code/.wt/contracts-found/dist-release/0.110.0`
(version 0.110.0) as soon as the shapes above are in, then tell the lead (it vendors them into S, P, W); keep polishing
after. The lead merges contracts main (whombat-14's 0.109.0) into `found` before the real release.

## S — server (`~/Code/.wt/whombat-found-server`)

1. DF-13/DF-14: the own-network rule in `apps/server/src/connections/discover.ts` (`ownNetworks`, CS-14) — real prefix
   up to a /22, else the /22 around the address; tune concurrency/timeouts so a /22 with all discovery ports finishes in
   about a minute; keep the test seam (CS-D29). Amend CS-14/CS-D24 with a pointer to DF-13.
2. DF-02: automatic scans as the burrow (no person): when the burrow first has an owner with an assistant (find the
   moment the screen pairs itself, DK-17, `desk/owners.ts`), at each runtime start, daily; all stop after Not now. Reuse
   the scan machinery (one per burrow at a time; a running or fresh one is reused). The scan currently needs a viewer
   for `connectionIds`: split “scan” from “answer for a viewer” if needed.
3. Migration 0127: per burrow — the first automatic scan's finish time (DF-07), when the assistant told (DF-05), when
   the view was put away (DF-04). Name it as the schema's style asks.
4. DF-03/DF-06/DF-07: `glance.found` in `desk/glance.ts` from the latest scan as the paired person sees it; hidden and
   connected left out; order and limits as DF-03; `progress` only during the first automatic scan; absent per DF-06
   (Only the time, put away, nothing new and not first-scanning). Keep `box` as today — the console decides the layout.
   Names: the entry's `name`; device (Modbus) finds get a name and tagline of their own (decide, record).
5. DF-04: `POST /v1/desk/found/dismiss` in `desk/socket.ts`, allowed locked.
6. DF-05: the assistant's one message after the first automatic scan with something new — find where the assistant
   greets after the claim (assistant guides / Chat) and post there; link `{PUBLIC_URL or the app origin}/settings?tab=connections&found=1`.
   Read it in a real thread to check the words (concise-replies.md).
7. NS-03/NS-04: the session sign-in's new options in the connections code (`connections/` — find where Pi-hole's and
   Nginx Proxy Manager's sessions are made, CM-10/CM-11): form/query login, base64 template, XML token, stale answers
   (sign in again once and repeat the call), failure reasons. Synology/QNAP probes through the existing finder. Tests
   against local fakes (no real devices exist here, NS-08).
8. Tests: unit for the pure parts, one integration test file only where Postgres is needed (test-speed.md).
Decisions → `docs/decisions/desk-found.md` under a “Decided while building (server)” heading, DF-S01…/NS-S01….
Until C's tarballs arrive, write the server against the sketch; the lead vendors 0.110.0 into your branch
(`git merge found` when told).

## P — console (`~/Code/.wt/appliance-found`)

1. `console/ui`: the found panel (frames 1–2) in place of *This Whombat* on a glance without servers and tiles; the
   strip (frame 3) beside servers/tiles through the desk-fit planner (`lib/deskFit.ts`, CG-135…CG-142: measure its
   height, keep the planner's rules); the assistant line (DF-09), Not now → `found/dismiss`, cards fade in once
   (DF-10), locked shows it (DF-11), *Only the time* doesn't. Words in `lib/deskCopy.ts` (verbatim DF-09). `appUrl`
   comes from the console state the page already has. Marks (DF-12): vendor the app's marks for every findable entry
   plus `synology` and `qnap` (Simple Icons 16.34.0 — W adds them to the app too; take the same SVGs) into the console,
   first-letter fallback.
2. Go: the broker allows and validates `POST /v1/desk/found/dismiss`; `DeskGlance.found` passes through the generated
   types (contracts-go 0.110.0 once vendored; update the Nix `vendorHash` — set a fake hash to get the real one).
3. Demo fixtures (`src/demo/deskFixtures.ts`): looking, found 8, found 1, the strip beside servers/tiles. Unit tests for
   the planner and copy. Compare against the PNGs at 1280×800 (the Z13 at 200 %), dark and light.
Decisions → appliance `docs/decisions/console-gui.md` (CG-230…) and `docs/decisions/` nix file for NX-370… if any.
A host release is needed (console changed): the lead ships it.

## W — app (`~/Code/.wt/app-found`)

1. Marks `synology` and `qnap` from Simple Icons 16.34.0 (as AP-842) in `packages/brand/assets/marks` and wherever marks
   are registered (web and Android).
2. Web: `/settings?tab=connections&found=1` opens Connections with Found on your network in view (DF-05's link); keep
   existing search params working. Found rows show the entry's `tagline` (DF-08) when the catalog has it.
3. Android: the same tagline in its Found on your network rows if cheap; the marks.
4. Catalog fixtures for `synology`/`qnap` so the connect form renders their steps (session sign-in: address, account,
   password, certificate) — the form is catalog-driven; check it shows the new failure reasons' words.
5. `pnpm check` once. Decisions → whombat-app `docs/decisions/` (the file connections work uses), AP-3800….
   No release: the lead releases app 0.112.0.
