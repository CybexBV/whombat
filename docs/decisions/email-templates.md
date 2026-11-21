# Email templates (ET-01 … ET-06)

John, 2026-10-04: “Can you make some nice email templates that we are sending based on the email that's being sent?
Make them identifiable with Whombat and create them for the different types of email we send, for example, forgotten
password email.” Whombat has no passwords: the sign-in email (link and code) is the account-recovery email. The hosted
side's mail (control: sign-in link, org invitations, waitlist and signup invitations, billing, operator alerts)
got the same layout there (control `docs/decisions/email.md`).

| # | Decision | Why |
|---|---|---|
| ET-01 | **One layout, `renderEmailHtml` (`apps/server/src/mail/template.ts`)**: the logo on a burrow-ink band with the email's kind as a small mono label on the right (“Sign in”, “Invitation”, “Notifications”, “Feedback”), a paper card with the title and blocks (paragraph, button, large spaced code, fallback link, note, linked items, label/value rows), and under the card why the email came and which Whombat sent it (“Sent by the Whombat at acme.example”). Every email this server sends has it as its `html` part: sign-in code, burrow invitation, notification email, feedback reporter code. | Recognisable as Whombat at a glance in any inbox; the blocks cover every email we send without one-off markup. |
| ET-02 | **The logo travels inside the message** as an inline PNG part (`cid:whombat-logo@whombat.com`; `mail/logo.ts`, the paper horizontal logo at 140 × 27, 3×). The mailer attaches it when the HTML refers to it (`inlineParts`). | Mail clients don't show SVG; a self-hosted Whombat may not be reachable from the reader's mail client, and a remote image is blocked by default and tells the sender when mail is opened. |
| ET-03 | **The plain text stays the sender's own, unchanged**; the HTML is an alternative next to it. | Text-only clients, screen readers and tests read it; the sign-in code and links are where they always were. |
| ET-04 | **Inline styles, table layout, colours copied from @whombat/tokens** (light theme, solid lines instead of rgba) — an exception to “colours only through tokens”, as CSS variables don't work in mail. Dark mode through `prefers-color-scheme` where the client supports it (Apple Mail, iOS); elsewhere the ink band and paper card read well under a client's own dark mode. | What mail clients render reliably. |
| ET-05 | **No web fonts**: Bricolage Grotesque / DM Mono first in the stack, then the system fonts. | Loading Google Fonts from an email tells a third party when it is opened. |
| ET-06 | **Everything put into the HTML is escaped** (names, burrow names, quotes from messages, links). | Names and message text come from people; the notification email quotes them. |
