> Version `2026-11-27`.

# Whombat Privacy Policy

This policy explains what personal data Whombat's own services handle, why, for how long, and who else is involved.
It covers the Whombat websites and web app (such as `app.whombat.com`), the phone apps, and the cloud services that
sign you in, connect your devices to your Whombat (Whombat Link), deliver updates and notifications and handle
payments. The Whombat software itself is open source; when someone runs it without our services, none of that data
reaches us, and this policy doesn't cover it.

The most important thing first: **the work you and your agent do in Whombat lives on your Whombat, not with us.**
Messages, files, code, prompts and agent output travel end-to-end encrypted between your devices and your Whombat.
Our servers pass them on without being able to read them. The one exception is the short preview a notification shows,
described under Notifications below, which you can turn off.

## 1. The short version

- Your workspace content stays on your Whombat. We can't read it, apart from the short preview a notification shows
  (which you can turn off) and what you send us yourself, such as a report to the Whombat Team. There is no standing vendor login: we only get into your Whombat when you turn on remote
  help, for the time you choose.
- Our cloud keeps only what it needs to run your account and Whombat Link: your email address, your Whombats with
  their names, addresses and Link state, and your subscription.
- We don't store IP addresses. Where we need to recognize a network (for example to stop abuse), we keep a keyed
  hash of it instead. The one exception is the login log of our own servers, which only our staff log in to.
- No analytics, no advertising, no tracking cookies, no session recordings. We never sell your data and we never use
  it to train AI models.
- You can delete your account yourself, and you can ask us about everything we hold on you.

## 2. Who we are

Whombat is a product of **Cybex B.V.**, James Cookstraat 12G, 7825 AN Emmen, the Netherlands, registered with the
Dutch Chamber of Commerce (KvK) under number 77711815, VAT number NL861104432B01 (“we”, “us”). We are the controller
for the personal data our cloud services process, as described in this policy. You can reach us at
[privacy@whombat.com](mailto:privacy@whombat.com).

For the data on your Whombat, **you decide** what goes on it (if you use it for a business, the business is the
controller). We can't access that data, so we don't process it, except when you let Whombat support in with remote
help: then we see what support looks at on your behalf, only to help with what was asked.

## 3. What stays on your Whombat

Your Whombat is your own server. It holds your workspace: messages, channels, files and repositories, agent runs and
their output, memory, the vault, your account on it, and the sign-ins for the services you connect (such as Claude,
ChatGPT, GitHub or Google).

- Your devices reach your Whombat through our relay over an **end-to-end encrypted** connection. Each browser and
  phone has its own key, which never leaves it. The relay forwards encrypted bytes and never sees what's in them.
- With Whombat Link your Whombat also has its own web address. The connection to it is encrypted all the way to your
  Whombat: our door passes it on and sees only which address it is for and where it comes from.
- The Whombat has **no standing vendor login**. We only see diagnostics if you create a diagnostics bundle, check
  its contents and send it to us.
- **Remote help.** You can let Whombat support in for a limited time, to find out what's wrong. With **Look**,
  support reads the Whombat's logs, status, hardware and network, which don't hold your chats, files or Vault. With
  **Look and fix**, support can run commands and could see everything on the Whombat. The Whombat records what support
  does (the commands, what their command line showed, the connections they open) and keeps that record for 90 days,
  where only you can read it. You're told when support connects and can stop it at any time.
- Backups go where you choose, encrypted with a password only you hold.
- When your agent uses an AI provider or a connected service, your Whombat talks to that provider directly. What
  the provider does with the data it receives is covered by your agreement with that provider, not by this policy.

We build and sign the software updates your Whombat installs. You rely on us to ship honest software, the same way you
rely on the maker of any operating system you run. Its source code is open under the AGPL-3.0, so anyone can check
what it does, and you can have each update wait for your yes (“Ask before updating”).

## 4. What our cloud collects, and why

**Your account.** Your email address, your sign-in sessions (when they were created and last used; no IP address
or browser details) and, if you use them, your passkeys. We use them to sign you in and to send you sign-in links.
We also keep which version of our terms you accepted, and when, with a keyed hash of the network you accepted them
from (not its IP address).

**Whombat Link.** For each Whombat you add: its name, its own address (`<name>.whombat.app`, the name you chose or a
random one; `<label>.box.whombat.app` for a Whombat that hasn't moved yet), the address it had before for 30 days after
you change it, whether Link is
on, starting, ending or off and since when, and when it last asked us for a connection. The one-time code a Whombat
shows to join your account lives 15 minutes. If we give you free time, we keep how long and a short note why. We use
this to run Whombat Link and to know what your subscription covers.

**Your Whombats.** For each Whombat: its serial number and model, its public keys, the name you gave it, when it was
set up, and when it was last online. Every few minutes a Whombat reports its health: software version, uptime, update
state, disk use, the number of open sessions and when it last made a backup. We use this to deliver updates safely and
to see when something goes wrong. None of it contains your content.

**Remote help.** A Whombat's health report also says whether remote help is on, at which level, how long it has
left, how many support people are connected, whether a help code is needed, and the key that identifies the
Whombat's support service. Never who turned it on, the help code, or what support did. When someone from Whombat
support is given a key to connect, we record who, for which Whombat, at which level and for how long, in our audit log
and in yours.

**Connecting to your Whombat.** When one of your devices connects, our cloud issues a short-lived ticket, and the relay
sees both ends' IP addresses and the size and timing of the encrypted messages while the connection is open. Visits to
your Whombat's own address pass through our door, which sees the visitor's IP address and the address visited. We
don't store tickets or these addresses.

**Billing.** Payments go through Stripe. Stripe collects your name, billing address and card details, and your company
name and VAT ID if you add them; **we never see your full card number.** We keep the Stripe customer and subscription
references, whether you pay by the month or by the year, the number of Whombats you pay for, a promotion code you
used, and the state of your subscription. To keep the free month to one per account, we remember which accounts and
email addresses have had one.

**Waitlist.** If you joined the waitlist before sign-up opened, we still have your email address, company name and
the note you left.

**Notifications.** If you turn on notifications: the push address your browser or phone gives us, and for each
notification when it was sent, what kind it was (such as a message or an approval) and whether it arrived. Your
Whombat registers your phones' push addresses with us; one unused for 90 days expires.
A notification shows a short preview so you know what it’s about: who wrote, where, and the start of the message (at
most 80 characters for the title and 160 for the text). Your Whombat sends the preview through our servers to the push
service, which delivers it to your device. We pass the preview on without storing or logging it. You can turn
previews off in Settings → Notifications (“Show message text in notifications”); notifications then only say
“Whombat” and what kind of notification it is.

**Shared links.** When you share a thread with a link, we keep a sealed copy that only the link can open: we can't
read it. We keep its size, when it expires, and how often and when it was last opened.

**Emails.** We send sign-in links and Whombat Link emails, such as the end of your free month or a payment that
failed. Two more are your choice, in your Whombat's Settings → Notifications, and only ever go to your Whombat Link
account's email address:

- **“Tell me when it goes offline”** (on unless you turn it off): we email you when we haven't heard from your Whombat
  for 2 hours. It uses only what we already know: when your Whombat was last in touch.
- **“Send my emails through Whombat Link”** (off unless you turn it on): your Whombat's notification emails and
  notices about it go through us. A notification email only says how many things are waiting for you, never who,
  where or what. A notice is a fixed sentence about your Whombat itself, such as “A new device signed in”. We keep a
  short reference of each email for 7 days so it is never sent twice, not its words.

**Keeping Whombat secure.** A log of important actions in your account (such as a Whombat linked or a subscription
changed), recorded under a pseudonymous account number, without email addresses, and of every change our staff make
to your account, with who made it and why. Request logs with the kind of request, its result and its duration,
without IP addresses, browser details or request contents. Counters that limit how often something can be tried,
keyed by a hash, never by an IP address. When you claim a new Whombat, we compare keyed hashes of your network and the
Whombat's network to find it; those hashes are erased once it's claimed. Our servers' own login log keeps the IP
addresses of logins to them: our staff's, and the attempts strangers make from the internet. Nobody else logs in
there.

**The Feedback widget.** If you put Whombat's Feedback widget on your website, the reports visitors send are encrypted
in their browser for your Whombat. We hold them, unreadable, until your Whombat collects them, together with the
website they came from, their size and when they arrived. You're responsible for those reports; we only carry them.

A report can include the pages the visitor opened on that website before reporting: at most 10, without query strings
or fragments, with their titles and times. The widget keeps this list in the visitor's browser tab until the tab is
closed, and it travels inside the encrypted report; the website can switch it off.

Visitors can also sign in with their email address to follow their reports. We receive the address to email them a
one-time code and don't keep it in readable form: we keep a keyed hash of it to recognise the visitor, and the address
encrypted under the visitor's own sign-in, so it can only be read while they use it. While a report sent while signed
in waits for your Whombat (at most 7 days), we also hold a one-way hash of the address, so your Whombat can check the
sign-in. For the visitor's list of reports we keep each report's reference, type, status and dates, never the text of
a report. Codes expire after 10 minutes and sign-ins after 30 days; a sign-in is kept in the visitor's browser, for
that website only, and signing out removes it.

**Reports to the Whombat Team.** If you send us a problem or an idea from inside Whombat, we keep what you wrote,
the Whombat and app versions, your Whombat's update channel, your device and system in a few words and your language,
with the answers in the report's conversation. The Whombat Team sees your name with it, never your email address. Unlike everything else above, we can read these: the form says so.
The Whombat Team reads them with the help of its own AI assistant, and may fix what you reported in Whombat's
public source code, in its own words, never yours and never naming you.

**Support.** If you email us, we use what you send to help you.

## 5. Our legal grounds

- **To provide the service you signed up for** (performance of a contract): your account, your Whombats, Whombat
  Link, connections, notifications, shared links, emails and billing, remote help when you turn it on, and the
  reports you send to the Whombat Team.
- **Our legitimate interest** in keeping Whombat secure and fair: the audit log, request logs, rate limits, network
  hashes, the server login log and the one-free-month-per-account check. We've kept each of these to the minimum that
  does the job.
- **Legal obligations:** keeping invoices and payment records as tax law requires.
- **Your consent:** notifications, which you can turn off at any time.

We don't make decisions about you based solely on automated processing that have legal or similarly significant
effects. The only automatic check is whether an account can have a free month; if you think we got that wrong, tell
us and a person will look at it.

## 6. What we don't do

- No analytics, crash reporting, session recordings or advertising in our websites or apps.
- No tracking cookies and no third-party scripts. The web app and phone apps bring their own fonts, so loading them
  doesn't tell anyone else you visited.
- We don't sell or rent personal data, and we don't use it, or anything on your Whombat, to train AI models.

## 7. Cookies and storage on your device

The web app doesn't use cookies to track you. It keeps what it needs to work in your browser's own storage: your
sign-in, the list of your Whombats and their identities, which Whombat you opened last (so it comes first), drafts
you haven't sent, and your device's key (stored so that even the page itself can't read it out). This is strictly
necessary for the app, so we don't ask for consent. “Forget this browser” removes the key, and clearing your
browser's site data removes the rest.

The payment pages are Stripe's own. Stripe sets its own cookies there, mainly to prevent fraud.

The Feedback widget on a website doesn't use cookies either. It keeps two things in the visitor's browser: the pages
visited on that website (`whombat-feedback:trail`, in the tab's session storage, gone when the tab is closed, and not
kept at all when the website switches it off) and, only for a visitor who signs in, their sign-in
(`whombat-feedback:` followed by the site's id, in the browser's local storage for that website, removed on sign-out or
after 30 days). Both are needed for what the visitor asked for, and neither is used to track anyone.

## 8. Who helps us

We use a small number of service providers, under agreements that only let them process data for us:

- **Hetzner Online GmbH** (Germany) hosts our servers, in Germany.
- **Cloudflare, Inc.** sits in front of our websites and services: it answers for their names (DNS), delivers and
  protects them. It handles the web traffic to them for us, including visitors' IP addresses, but not the content
  between your devices and your Whombat, which stays end-to-end encrypted.
- **Mailgun** (Sinch) sends our emails, including the ones your Whombat sends through Whombat Link when you chose it.
- **Stripe** handles payments. For fraud prevention and its own legal obligations, Stripe is also a controller in its
  own right; see Stripe's privacy policy.
- **Anthropic** and **OpenAI** provide the AI the Whombat Team's assistant uses to read, assess and answer the
  reports you send to the Whombat Team.
- **Push services** deliver notifications: Apple Push Notification service for the iPhone app, Google Firebase Cloud
  Messaging for the Android app, and the push service your browser uses (from Google, Mozilla or Apple, for example)
  on the web; they receive a notification’s preview while delivering it, unless you turned previews off.

**Services your Whombat talks to itself.** These aren't our service providers: your Whombat contacts them directly,
so they see its IP address and what it asks for, and their own privacy policies apply.

- **GitHub** (Microsoft) hosts the signed update files and the list of releases your Whombat checks for updates.
- **Anthropic** hosts Claude Code. Your Whombat downloads it from Anthropic's own site when you choose Claude.
- **Let's Encrypt** (ISRG) issues the certificate for your Whombat's own address when you use Whombat Link. Every
  certificate is published in public **Certificate Transparency logs**, so that address (a name under
  `whombat.app`) becomes public there. Your Whombat reads those logs through **Cert Spotter** (SSLMate) to warn
  you about any certificate for its address that it didn't ask for. Until 16 February 2027, **Cloudflare**, which runs
  `whombat.app`'s DNS, also holds a certificate for every name under `whombat.app`; your Whombat knows it and says so
  under its address.
- **Hugging Face** hosts the speech models. Your Whombat downloads its speech-to-text model while voice typing is on
  (it is at first), and the Dutch voice only after you turn it on and agree to its licence.
- **Time servers** keep its clock right: Cloudflare, Netnod, PTB and SIDN's TimeNL.
- **MET Norway** (the Norwegian Meteorological Institute) gives the weather forecast for where your Whombat is, or for
  a place you or your assistant ask about. Your Whombat sends it that place's coordinates, rounded to about a kilometre.
- **OpenStreetMap**'s place search (**Nominatim**, run by the OpenStreetMap Foundation) finds the place you type, or
  the town at your device's location (rounded to about a kilometre), when you set where your Whombat is or ask your
  assistant about the weather somewhere.
- **The news sites you choose** send your Whombat their headlines. It reads only the sites you turned on, added or
  imported, every quarter of an hour while something shows the news; until you turn one on, it reads none. YouTube,
  Reddit, Mastodon, Bluesky and GitHub are asked only when you add a channel, subreddit, account or project of theirs.
- **Apple**'s podcast directory tells your Whombat where a podcast's feed is, once, when you add an Apple Podcasts
  address.

Tailscale, the AI providers and the services you connect are yours to choose; section 3 says how your Whombat talks
to them.

We may disclose data if the law requires it, and only as much as it requires. We'd tell you unless we're legally
not allowed to.

## 9. Transfers outside Europe

Our servers are in the European Union. Some of the providers above are based in the United States or use affiliates
there. When personal data leaves the European Economic Area, we rely on the EU–US Data Privacy Framework where the
provider is certified, and otherwise on the European Commission's Standard Contractual Clauses.

## 10. How long we keep it

- **Your account:** until you delete it (section 11).
- **Sign-in links:** one day after they expire.
- **Your Whombats, their Link and your terms acceptances:** as long as your account exists. A Whombat that is retired
  keeps its hardware entry, without your account.
- **Health reports:** 30 days. **Notification deliveries:** 14 days. **Request logs:** 14 days. **Server login
  log:** up to 2 months.
  **Rate-limit counters:** 2 days. **Payment events from Stripe:** 90 days. **Audit log:** 400 days.
- **Phone push addresses:** until unused for 90 days.
- **Emails your Whombat sent through Whombat Link:** a short reference to each for 7 days; your two email choices as
  long as your Whombat is in your account.
- **Shared links:** until you remove them or they expire.
- **Feedback reports:** until your Whombat collects them, and never longer than 7 days.
- **Reports to the Whombat Team:** until 90 days after the report is closed. When you withdraw it, delete your account
  or take the Whombat out of Whombat Link: from our servers at once, and from the Whombat Team's list of reports within
  minutes. What the Whombat Team wrote while working on it (its assistant's notes, its answers, a fix) stays in its own
  records.
- **Remote help:** what support did stays on your Whombat for 90 days (at most 500 MB), not with us. Our record of
  each key we gave support is part of the audit log.
- **Feedback sign-ins:** codes for 10 minutes, sign-ins for 30 days. The entries of a visitor's list of reports: until
  your Whombat removes the report, or the website stops using Whombat's cloud for the widget.
- **Free month records** (which accounts and email addresses had one): as long as we offer a free month, so it can't
  be taken twice.
- **Waitlist entries:** until you ask us to remove yours.
- **Invoices and payment records:** 7 years, as Dutch tax law requires.
- **Backups** of our database are kept for up to 35 days, so deleted data disappears from them within that time.

## 11. Deleting your account

You can delete your Whombat account yourself: choose **Delete account** on the Your Whombats screen of the web app
or the Android app, and type your email address to confirm. Your account, sign-in sessions, passkeys and notification
addresses are deleted at once.

Two things to know:

- While you still have a subscription that hasn't ended, or a Whombat on your account, you can't delete your account
  yet: cancel the subscription and remove the Whombat first, or contact us.
- Deleting your Whombat account doesn't delete anything **on your Whombat**: that is yours, and only resetting the
  Whombat erases it. Export anything you want to keep first.

After deletion, the audit log keeps its pseudonymous entries (without your email address) until they expire, as
listed in section 10.

## 12. Your rights

Under the General Data Protection Regulation you have the right to access the personal data we hold on you, to have
it corrected or deleted, to restrict or object to how we use it, and to receive it in a portable format. Where we rely
on your consent, you can withdraw it at any time.

Email us at [privacy@whombat.com](mailto:privacy@whombat.com) to use any of these rights. We answer within one month.
We may ask you to confirm that the request comes from you, usually by replying from the email address of your
account.

If you're not happy with how we handle your data, please tell us first. You also have the right to complain to a
data protection authority: in the Netherlands, the Autoriteit Persoonsgegevens
([autoriteitpersoonsgegevens.nl](https://autoriteitpersoonsgegevens.nl)), or the authority where you live or work.

## 13. Security

End-to-end encryption between your devices and your Whombat, keys that stay on each device, encrypted connections to
our servers, and keeping as little as possible are how we protect your data. If you find a security problem, please
report it to [security@whombat.com](mailto:security@whombat.com).

## 14. Children

Whombat isn't meant for children, and we don't knowingly collect data from anyone under 16.

## 15. Changes to this policy

When we change this policy, we update the version at the top. If a change affects how we use your data in a way that
matters, we'll email you before it takes effect.

## 16. Contact

Cybex B.V. · James Cookstraat 12G · 7825 AN Emmen, the Netherlands · KvK 77711815 · VAT NL861104432B01 ·
[privacy@whombat.com](mailto:privacy@whombat.com)
