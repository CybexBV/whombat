# Does it really work? (WRK)

John's look-after build, 2026-11-28: a service can answer while what people use it for is broken. Nextcloud opens but
can't read files, Immich's page loads but photos don't, Jellyfin's library is gone. People hear it from their family.
Whombat already checks that a service answers (its health pass, uptime checks); this adds a test that does what a
person would, says where it got stuck, and tells a broken service apart from a sign-in that lost access.

The code is `apps/server/src/works/` (tests, rules, runs, the page's card, its buttons, the assistant's tool); the
contract is `packages/core/src/domain/service-works.ts` and `service_test` in `contracts/mcp-one.ts`.

## The tests

| # | Decision | Why |
|---|---|---|
| WRK-01 | **Six kinds have a test**: Nextcloud “Open one of your files”, Immich “Open your newest photo”, Paperless-ngx “Open your newest document”, Jellyfin and Plex “Open the newest item of a library”, Home Assistant “See a sensor change”. Each runs through the connection's own sign-in and rules (`signedConnectionFetch`), with no new permission. Others (Vaultwarden, mail) can follow the same shape. | These are the services a household notices first when they break, and their existing sign-ins can read what the test needs. |
| WRK-02 | **A test only reads, always.** Nextcloud lists the person's files over WebDAV (the top folder, then up to three folders in it) and reads the first 2 KB of the first file; Immich searches its newest photo and loads its preview; Paperless finds its newest document and reads the first 2 KB; Jellyfin and Plex list the libraries, find the newest film, episode, song or video and read the first 2 KB of its file (Plex opens its details first); Home Assistant reads when its sensors last reported, through a template. Whombat makes no file of its own. | No setup step, nothing to clean up, and it works on a connection set to Look only. A file of Whombat's own would test writing, which the person didn't ask for, and would need a write permission. |
| WRK-03 | **No picking.** Each test chooses what to open itself: the first file, the newest photo, document or item. Home Assistant looks at the newest reading of all sensors, not one chosen sensor. | Nothing to set up and nothing that goes stale when a file or sensor is removed. |
| WRK-04 | **How a run ends**: `ok`; `empty` (it works, but there is nothing to open yet, a new Nextcloud; counts as passed); `access` (a 401 or 403, or a sign-in that can't be renewed: the sign-in Whombat uses expired or lost access); `broken` (another error code, an answer Whombat can't read, nothing where there must be something such as no library, no answer within 30 seconds, or for Home Assistant no sensor change in the last hour); `down` (no answer at all). The step it stopped at is kept with the code. | The person's next step differs: fix the connection (access) or look into the service (broken, down). |
| WRK-05 | **Only results are kept**: when, outcome, step, reason, the answer code, how long, who ran it, and two facts for the words (a library's name, how long ago a sensor changed), 30 days (`service_test_runs`, migration 0044). Never a file, photo, document or item name. | Data stays on the box and a test result holds nothing worth stealing. |

## Run now and Watch it

| # | Decision | Why |
|---|---|---|
| WRK-06 | **“Does it really work?”** is a card on the page of a service with a test: the test in plain words, its last result in one sentence (“It works — opened your newest photo in 0.4 s.”, “Nextcloud opens, but it can’t list your files (it answered 503).”, “The sign-in Whombat uses can’t list your files any more (it answered 401).”), and **Run now** and **Watch it** (**Stop watching** once on) on its head. It is a list card with head buttons, so the web and the phone draw it without new UI. | The buttons are on the head because a line with buttons is one of the service's own things, whose title stays as the service wrote it. |
| WRK-07 | **Run now** runs the test at once and says the result in the toast; **Watch it** turns the check on and runs it once. Neither records a change and both work on Look only. | Neither changes anything on the service; what Whombat watches is Whombat's own setting. |
| WRK-08 | **The check `works.test` (“Whether it really works”) starts off** (`startsOn: false`, `nature: problem`). Watch it is the same switch as in What Whombat watches. Nothing runs until the person turns it on for a service. | A test opens the person's files on a rhythm: the person chooses that. Once on, a failure is exactly the “it is broken now” they asked to hear about. |
| WRK-09 | **Rhythm**: a watched test runs in the connection's health pass when due: every 15 minutes; after a first failure once more at the next pass (about 5 minutes) to confirm it; and at the next pass at least 2 minutes after something was changed on the connection since its last run (a restart, a setting, a fix by the assistant). It doesn't run while the thing is kept quiet or held by another cause, or while the connection doesn't answer. | Never more often than every 15 minutes on its own, yet a fix is checked without waiting a quarter of an hour. A service that is down is already a problem; the test adds nothing then. |
| WRK-10 | **Its line shows after two failed runs in a row** and goes with the first run that passes. A broken service is red (`problem`: incident, push and Inbox as any problem, Look into it asks the assistant); a refused sign-in is amber (`you`, no push, Show opens the Connection tab). Ignore lasts until the test passes again; a result older than 45 minutes says nothing about now. | One blip says nothing. The line is the glance's like every other, so holds, causes, incidents and pushes treat it the same. |

## The assistant

| # | Decision | Why |
|---|---|---|
| WRK-11 | **`service_test`** (read only, the person's turns): the test, whether it is watched and the last eight runs in words; `run: true` runs it now. | The assistant answers “does Immich work?” and checks its own fix the way the person would. |
| WRK-12 | **A look at a failed test names the tool**: when a look's line is the test's, the turn tells the assistant to read `service_test` for the step it stopped at, to run it again after a fix, and that a refused sign-in is the person's to fix in the connection. | The look already ends with “check it worked”; this says how. |

## Words

| # | Decision | Why |
|---|---|---|
| WRK-13 | **The words are English in the server and said in the person's language through the phrasebook** (`things.page.works.*`): each step's words fill `{what}` in the sentences and are said again, written in Dutch to follow “om” (“je bestanden te tonen”). | One sentence per outcome, and Dutch word order still works. |
