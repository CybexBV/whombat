# Whombat Feedback

An optional form for **your website**: visitors report a problem or suggest an idea without leaving the page. Each
report becomes a thread in your **Feedback** room, where the agent assesses it. How it is built: `ARCHITECTURE.md`,
“Whombat Feedback”; decisions: [`decisions/feedback.md`](decisions/feedback.md),
[`decisions/feedback-drop.md`](decisions/feedback-drop.md) and
[`decisions/feedback-reporters.md`](decisions/feedback-reporters.md). Runnable examples:
[`examples/feedback/`](../examples/feedback/README.md).

What it is **not**: visitors get no account, no status emails and no conversation with you, and they never sign in to
your Whombat. The reference they get (`FB-7K3Q-9M2X`) is an acknowledgement to quote if they contact you; it opens
nothing and links nowhere. The one thing they can see afterwards is optional: with **reporter sign-in** a visitor signs
in to your site's form with their email address and a code, and then sees the reports they sent there with a short
status (“Being looked at”, “Fixed”; see [Reporter sign-in](#reporter-sign-in)). Everything else about a report — the
thread, the assessment, its status — stays inside Whombat.

Reports from the tracker go through automations: see [Automations → the tracker reports](automations.md#tracker-reports). A tracker
integration listed here keeps working until you press **Move to automations** on its page, which makes the tracker
connection and an automation that assesses its new reports, and switches the integration's intake off; its reports
stay readable here.

## On and off

`WHOMBAT_FEEDBACK=on` (the default) takes reports through
[the encrypted drop](#how-reports-reach-this-whombat-the-encrypted-drop) once you create an integration and turn on
**Accept reports**; with no integration it is inert. `WHOMBAT_FEEDBACK=off` withdraws every site card and stops
collecting; nothing else in Whombat changes. Integrations and reports stay in the database either way, and reports
already received are still handled: queued and running assessments finish (or time out) and retention still removes
content on schedule.

## Create an integration

Settings → Connections → **Website feedback** → **New integration**. What you choose:

- **Name** and **product label** (what visitors see above the form, e.g. “Lumio”).
- **Allowed origins**: the exact addresses of the websites that may show the form, one per line —
  `https://app.example.com`, with the port when it isn't the default. No wildcards and no paths; `www.` and the bare
  domain are different origins. `http://` only for `localhost` and `127.0.0.1` (testing).
- **Repository** (optional): one of your repositories that the agent may read while it assesses, and **project
  context**: a few lines for the agent about the product and where to look.
- **Report types** (problems, ideas or both), **theme**, **position**, **launcher** (floating button or your own) and
  its **label**, an https **privacy notice** link, whether to ask for **name** and **email** (optional fields, or off).
- **Redacted paths** (`/customers/*`, `/orders/*/invoices/*`) and **context keys** (see below).
- **Pages visited**: send the last 10 pages the visitor opened on your site with the report (on by default), or don't.
- **Reporter sign-in**: let visitors sign in with their email address to follow their reports (on by default).
- **Offer to build the fix** (off by default; see [Building the fix](#building-the-fix)), **limits** and **retention**.

Every change is a signed event in the audit log. The integration's page has two switches: **Accept reports** (off: the
website's panel says feedback is unavailable and new reports are refused; reports already received keep their state)
and **Assess new reports** (paused: reports are still accepted and wait; resuming queues them). **Health** lists what
needs attention, e.g. a site Whombat's cloud doesn't have yet, reports that couldn't be filed, or a repository that is
gone.

## Install it on your website

The card shows the snippet generated for this integration. Paste it before `</body>` (or in `<head>`; it is
`defer`red) on every page that should show the Feedback button:

```html
<script
  src="https://embed.whombat.com/embed/v1/widget.js"
  data-site="fbs_…"
  data-key="fbk_…"
  data-theme="auto"
  data-position="bottom-right"
  defer
></script>
```

That is all a plain site needs. `widget.js` is small (below), loads nothing else until the visitor opens the
form, and then opens Whombat's form in an iframe. `data-key` pins this Whombat's site signing key: the form checks
the site's card against it before it encrypts anything. Theme, position, launcher and label come from these
attributes: after changing them in the settings, copy the snippet again. Types, contact fields, the privacy
link, limits and redactions come from Whombat and apply within seconds.

### Content-Security-Policy

If your site sends a Content-Security-Policy, add Whombat's embed origin (the card has a Copy button for exactly
this line):

```
script-src https://embed.whombat.com; frame-src https://embed.whombat.com;
```

(appended to your existing `script-src` and `frame-src`, or `child-src` if that is what you use). Nothing else:
no `connect-src` — the form in the frame sends the reports itself — and no `'unsafe-inline'`; the launcher is
styled through CSSOM in a closed shadow root, so it works under a strict `style-src` too. Don't loosen your
policy for it.

### Your own button

Choose the **custom** launcher (or add `data-launcher="custom"` to the snippet) and no floating button is
shown. Any element with `data-whombat-feedback` opens the form: `"bug"` or `"feature"` preselects the type, empty
leaves the choice to the visitor.

```html
<button type="button" data-whombat-feedback="bug">Report a problem</button>
```

From your own script (a file of your site, so it works under your CSP):

```js
function withFeedback(fn) {
  if (window.WhombatFeedback) fn(window.WhombatFeedback);
  else document.addEventListener('whombat-feedback:ready', () => fn(window.WhombatFeedback), { once: true });
}
withFeedback((feedback) => {
  feedback.setContext({ app: { version: '1.4.2', environment: 'production' }, references: [lastRequestId] });
  document.querySelector('#help-menu-feedback').addEventListener('click', () => feedback.open({ type: 'feature' }));
});
```

### Reference

`window.WhombatFeedback` is the loader's only global. It exists as soon as `widget.js` has run; the
`whombat-feedback:ready` event is dispatched on `document` at that moment.

| | |
|---|---|
| `version` | The widget's version (`1.0.0`). |
| `ready()` | A promise of the API, resolved once the loader is set up (at once, after `widget.js` ran). Rejects after `destroy()` or when the snippet is broken. |
| `open({ type })` | Opens the form (loading the frame on first use); `type` is `'bug'` or `'feature'`, optional. Called before the frame has loaded, it opens as soon as it is ready. |
| `close()` | Closes it. Focus returns to the button or element that opened it. |
| `isOpen()` | Whether it is open. |
| `setContext({ app, custom, references })` | Replaces the context your site adds to the next report (below). Kept if called before the frame loaded. |
| `destroy()` | Removes the launcher, the frame and every listener; the global stays and does nothing. For single-page apps that drop the widget on some routes. |

| Attribute (on the script) | |
|---|---|
| `data-site` | The integration's site id, `fbs_…` (required). |
| `data-key` | The fingerprint of this Whombat's site signing key, `fbk_…` (required). |
| `data-theme` | `auto` (follows the visitor's system), `light` or `dark`. |
| `data-position` | `bottom-right` or `bottom-left`. |
| `data-launcher` | `custom`: no floating button. |
| `data-label` | The button's label (default “Feedback”, at most 40 characters). |
| `data-trail` | `off`: don't record the pages visited on this page, whatever the integration says (the snippet adds it when **Pages visited** is off). |
| `data-whombat-feedback` | On any element of the page: a click opens the form (`bug`, `feature` or empty). |

Included twice, the script runs once and warns in the console. With a missing or malformed `data-site` it
stays off and says why in the console. It never throws into your page and never blocks it: when Whombat can't be
reached the script simply isn't there, or — when Whombat went away after the page loaded — the panel says
“Feedback is unavailable right now.”

**Single-page apps** need nothing special: the widget follows `pushState`, `popstate` and `hashchange` navigation,
so a report carries the route the visitor is on when they send it, and the pages visited include your routes. Call
`setContext` again when your own context changes (`examples/feedback/spa`, `examples/feedback/lumio`).

## What is sent, and what never is

Visitors see all of it before sending, under “What will be sent”.

- What they write: the type, the description, for problems what they expected, optionally their name and email
  (unverified unless they signed in; only if the integration asks), and the screenshots they chose. Reports from
  older forms may also have steps to reproduce.
- **The page**: origin and path only. The query string and the fragment are never sent. Path segments that
  look like identifiers become `:id` — UUIDs, numbers of five digits or more, long hex or mixed letter-and-digit
  tokens, anything with `@` — and so does every `*` of the integration's **redacted paths**
  (`/orders/*` turns `/orders/123` into `/orders/:id`). Plus the page title.
- **The pages visited before reporting** (unless **Pages visited** is off or the snippet says `data-trail="off"`):
  the last 10 pages the visitor opened on your site in that browser tab, oldest first, each as origin and path
  sanitized exactly like the page above, with its title and when they got there (their clock). The widget keeps
  them in the tab's `sessionStorage` under `whombat-feedback:trail`, which the browser clears when the tab closes;
  pages on other sites are never seen. Whombat sanitizes them again with your redacted paths, and the assessor reads
  them as unverified context (“3 min before sending”). With the switch off, a trail an old form still sends is
  dropped.
- **The browser**, coarsely: name and major version with the operating system (“Chrome 131 · macOS”, never the
  user agent), language, window size and time zone.
- **What your site adds** with `setContext`: `app.version`, `app.environment`, `app.build` (64 characters each);
  `custom`, a flat map of text, numbers and true/false, of which only the keys you listed under **context keys**
  are sent (none by default; at most 20); `references`, up to 5 short diagnostic ids such as request ids.
  Send names from a fixed list (`page: 'computers'`) rather than raw identifiers, and **never** session or API
  tokens, organization, user or customer ids, or customer records. None of this is verified, and none of it
  can choose where the report goes, which repository is read or what the agent does.

Never collected: cookies, your site's local or session storage, request headers, the contents of your page or its
forms, the DOM, console or network logs, session replays. The widget's own storage is limited to the two keys named
here (the trail in the tab, a signed-in reporter's session in the form's own origin). Whombat re-sanitizes everything it receives. The frame sends
reports with `credentials: 'omit'`: no cookie — not even your own Whombat session while you test
the form — goes with a report, and third-party cookie blocking doesn't matter. The visitor's IP address never reaches
this Whombat: Whombat's cloud keeps only a keyed hash of their network for its per-address limits.

Reports are posted by Whombat's **Feedback** principal (created when first needed). What
the visitor wrote is shown in the report's card as plain text; it is never message text, so it can't mention
anyone, wake an agent or trigger an automation. The signed audit event of a report holds ids, sizes and hashes,
never its text or contact details.

## Reporter sign-in

With **Reporter sign-in** on, the form offers “Sign in to follow your reports”. The visitor enters their email
address and gets a 6-digit code by email (subject “123456 is your code for Lumio feedback”); with the code they are
signed in on that site's form for 30 days (stored in the browser under the form's own origin, which the browser
keeps apart per website). Signed in:

- the form knows their name and email; the email of their reports is marked **Email verified** in the report's
  details (without sign-in, a typed email is shown unmarked, as before);
- **Your reports** lists the reports they sent on that site while signed in, newest first, with the reference, the
  start of the description and a status: Received, Being looked at, Needs more information, Confirmed (Noted for
  ideas), In progress, Fixed (Done), Closed — from your status (Triaged → Confirmed, In progress, Resolved → Fixed,
  Closed) or, while a report is New, from its assessment. Reports whose content you removed disappear from the list.
  They never see the assessment, the thread or anything you wrote.

Reporting without signing in stays. A signed-in report's email is the address they proved, even when the integration
doesn't ask for an email: switch sign-in off if you don't want addresses. Sign-in never creates an account or a principal; nothing is emailed besides the code.

Whombat's hosted service does the sign-in: it sends the codes and keeps a keyed hash of the address,
the references, types and statuses of the signed-in reporters' reports — never their text — and this Whombat tells it
each status change (only for reports of signed-in reporters). A report is marked verified only when the address
sealed in the report matches the one the service vouches for.

## Screenshots

Chosen by the visitor (never captured), previewed before sending: PNG or JPEG, up to 3 per report (the
integration may allow fewer, or none), each at most **Screenshot size** (default 3 MB, at most 8 MB), 16
megapixels and 8192 pixels a side. Whombat checks the bytes (not the name), decodes and **re-encodes** each
image, which drops EXIF, GPS and every other piece of metadata. They are stored as ordinary attachments of the
report's first message: only you open them, and there is no public link. They count
toward the box's storage quota.

## How reports reach this Whombat (the encrypted drop)

A Whombat has no public address, so reports reach it through **Whombat’s cloud, encrypted**
([`decisions/feedback-drop.md`](decisions/feedback-drop.md)). The widget is served from Whombat’s embed origin
(`WHOMBAT_EMBED_URL`, e.g. `https://embed.whombat.com`; unset: the hosted app’s origin), not from the appliance, and
the snippet carries one more attribute, `data-key="fbk_…"`: the fingerprint of this Whombat’s site signing key. The
visitor’s browser checks the site’s published card against it, encrypts the whole report to this Whombat and sends
the ciphertext to Whombat’s cloud, which keeps it until this Whombat collects it (within seconds while it is online,
at most 7 days) and deletes it then. The cloud never sees the text, contact details, context or screenshots.

- Turning intake on publishes the site’s card; turning it off withdraws it. The card also tells the form whether it
  may send the pages visited and offer reporter sign-in (the hosted service sends the codes, see
  [Reporter sign-in](#reporter-sign-in)). The integration’s health shows when the
  card was published, the last collection, reports that couldn’t be filed and reports that expired unread.
- `WHOMBAT_FEEDBACK=off` withdraws every card and stops collecting.
- If the appliance’s cloud connection doesn’t support the drop yet, the Feedback policy says “Feedback needs an
  update of this Whombat’s cloud connection.” and intake can’t be switched on. A development box (`pnpm dev`) has no
  drop.
- The keys are in the database, sealed with the master key: a restored backup keeps every snippet working. The
  signing key is never replaced by itself; replacing it means pasting new snippets everywhere.

## Abuse limits

Whombat's cloud checks them before it stores anything, in this order: the site and origin, the request size and the
rate limits, then the body within a deadline (`docs/decisions/feedback-drop.md` FD-18). This Whombat checks the
screenshots (one decode at a time) and the daily count again when it files the report. Per integration (its page →
**Privacy and limits**):

| Limit | Default | Range |
|---|---|---|
| Reports per hour | 30 | 1–1000 |
| Reports per day (durable) | 200 | 1–10 000 |
| Reports per hour from one address | 5 | 1–100 |
| Screenshots per report | 3 | 0–3 |
| Screenshot size | 3 MB | 64 KB–8 MB |
| Assessments per day | 50 | 0–500 |
| Assessments at the same time | 1 | 1–5 |
| Assessment time limit | 30 minutes | 5–120 |

The cloud also limits each visitor network across sites and itself as a whole. A visitor over a limit is told to try
again later; nothing they wrote is lost (the form keeps it, and a retry is never stored twice).

## Assessment

Each new report is queued for a **read-only assessment by the agent**, within the daily budget and the concurrency
limit, in the report's thread. The agent must run on Claude or ChatGPT (an ACP runtime can't be kept read-only);
otherwise reports are filed and not assessed. Before it starts, Whombat checks again that what the report was received
under still holds (the repository, the integration); anything gone makes it **blocked** with the reason, until you fix
it and press Retry.

An assessment is an outsiders' turn: it never reaches your mail, files, Vault or memory, and nothing in it is
remembered. The agent sees only the report thread, the report as untrusted data, the project context and the
screenshots, with a read-only copy of the repository's default branch (or none), no network and read-only tools: it
can't push, write, open pull requests or approve anything. It answers with a structured assessment — an outcome
(confirmed bug, likely bug, needs information, duplicate, configuration or support, feature request, insufficient
evidence), confidence, reproduction, evidence marked as observed or hypothesis, severity, missing information and the
next step — which Whombat shows in the thread; a “confirmed bug” needs observed evidence. A turn that fails, times out
or ends without an assessment makes it **failed** with the reason; nothing is made up. You can retry (at most 5
attempts per report). The time limit counts from when the turn starts; a turn that doesn't start within 12 hours
fails with that reason.

The agent's words in an assessment — its replies in the thread and the assessment — are stored as plain text (no
links, no mentions, no formatting) and marked as coming from an assessment, so a later turn that reads the thread gets
them as untrusted data, and automations ignore them.

**Looking at your website.** When the agent holds **Use a web browser** at Go ahead, an assessment may also open pages
of your website — the sites of the integration's allowed origins, and no other — to check what the visitor describes:
it opens the reported page and the pages they went through, reads, scrolls and clicks, but never types, fills in forms,
keeps downloads or signs in. A link or redirect to anywhere else is refused before it loads. Screenshots it attaches
as evidence appear under the assessment, and what it saw there counts as reproduced. See `docs/browser.md`.

## Building the fix

With **Offer to build the fix** on, an assessed report offers to hand it to development. Asking for it makes an
ordinary approval for you, bound to the report, the repository, the commit the assessment read and the assessment;
its card shows the exact message that will be posted. Once you approve it — and Whombat checked that nothing changed —
that message is posted in the report's thread and the agent works on it in a turn of its own: the report and the
assessment reach it only as marked, untrusted data, and its own keys govern its branches, pushes and merges. Nothing a
visitor or an assessment writes counts as an approval.

## Keeping and removing reports

Reports are kept until you remove them. **Remove content** (in the report's details) deletes the text, the contact
details, the context and the screenshots, and what the assessment wrote from them: the assessment's text (its outcome,
confidence and severity stay) and everything the assessment posted in the report's thread, which then reads “Removed
with the report’s content.” (and is gone from search). The report's row, reference, times, states and signed history
stay. **Retention** (7–3650 days per integration, off by default) does the same automatically, hourly. Your own replies
in the thread are not touched, so don't quote a visitor's personal details there. The status (New, Triaged, In
progress, Resolved, Closed) is yours; visitors see it only as a signed-in reporter's short status of their own reports
([Reporter sign-in](#reporter-sign-in)). Removing a report's content removes it from that list.

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| No Feedback button | The browser console says why: `[Whombat Feedback] the widget is off: data-site …` (copy the snippet again) or “Refused to load the script” (add the CSP line). With the custom launcher there is no button by design. |
| The panel says “Feedback is unavailable right now.” | The frame was refused or couldn't load: the page's origin isn't exactly one of the allowed origins (scheme, `www.`, port), **Accept reports** is off or the integration is gone, the console shows `frame-src` (add the CSP line), or Whombat's embed origin isn't reachable from the visitor's browser. |
| The form says “Feedback isn’t available on this site right now.” | The form loaded, then Whombat's cloud had no card for the site: the settings changed meanwhile (intake off, origin removed), this Whombat hasn't published it yet (health says so), or the snippet has no `data-key` (copy it again). |
| “The screenshots are too large …” (413) | Bigger than the integration allows, or the box's storage quota is full. |
| “… couldn’t be used” (422) | Not a PNG or JPEG (whatever its name), damaged, too many pixels, or a JPEG named `.png`. |
| “Too many reports right now …” (429) | A limit above; `Retry-After` says when. Visitors behind one network address share its limit. |
| “This report was already sent …” (409) | An earlier attempt with the same draft was stored with different content (the visitor edited after a failed send). They can send it as a new report. |
| A report isn't in Feedback | Look in the Feedback room for a thread whose first message reads `Bug report FB-… · <product>` (or `Feature request …`) with the visitor's reference; the integration's health lists reports that couldn't be filed. |

## Backup and restore

Reports live in Postgres (`feedback_integrations`, `feedback_reports`, `feedback_assessments`) and their screenshots
are attachments under `files/` of `WHOMBAT_HOME` (or `WHOMBAT_FILES_DIR`); the appliance's backups keep both. A
backup file carries the integrations (with Connections), not the reports. Removed report content is gone from both.

## Sizes

Measured on the 1.0.0 build (`pnpm build:widget`):

| File | Raw | gzip | Loaded |
|---|---|---|---|
| `widget.js` | 17.9 KB | 7.2 KB | on every page with the snippet (cached 5 minutes) |
| `assets/frame.<hash>.js` | 34.9 KB | 12.2 KB | when the form is first opened (cached for a year) |
| `assets/frame.<hash>.css` | 15.0 KB | 4.0 KB | when the form is first opened (cached for a year) |

The frame loads no fonts (it uses the visitor's system font) and nothing from any other address.
