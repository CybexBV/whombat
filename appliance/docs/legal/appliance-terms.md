> Version `2026-11-22`.

# Whombat Appliance Terms

These terms are between **Cybex BV** (Cybex B.V., James Cookstraat 12G, 7825 AN Emmen, the Netherlands; KvK
77711815; VAT NL861104432B01; “Whombat”, “we”, “us”) and you, the person who sets up a Whombat, for yourself or for a
business. They cover what we provide for your Whombat: signed updates, Whombat
Link if you use it, remote help, notifications and support (together, “the service”) and, if you got it from us, the
box itself.

You accept them when you claim a Whombat or link one to your account. If you do that for a business, you confirm that
you may. They work alongside the Whombat Terms of Service, the Whombat Subscription Terms and the Whombat Privacy
Policy.

A Whombat is **one person's device**: you sign in to it and work with its agent, and nobody else signs in to it.

## 1. The software is open source

- The software that runs on a Whombat (its operating system image, the Whombat runtime and the tools that manage
  and update it; together, “the Whombat software”) is free software under the **GNU Affero General Public License,
  version 3** (AGPL-3.0), copyright Cybex BV. Software by others in it keeps its own licence.
- Anyone may run, study, change and share the Whombat software under that licence, also without whombat.com.
  **Nothing in these terms limits the rights the AGPL-3.0 gives you.** If anything here seems to, the licence wins.
- What Whombat Link pays for is **the service**, not the right to run the software. The servers that run the
  service, and the software on them, aren't part of the Whombat software.
- The AGPL-3.0 gives no right to use the Whombat name or logo. Section 10 says how you may use them.

## 2. Your data stays yours

- Everything you and your agent create or store on your Whombat (messages, documents, files, code, agent output,
  settings and backups) belongs to you. We don't claim any rights to it.
- You can **read and export all of it at any time**, with or without Whombat Link. The export tools and the recovery
  kit always keep working.
- We keep providing **security updates** for the Whombat software while we support your Whombat's release, with or
  without Whombat Link.
- Ending Whombat Link never deletes your data or locks you out of it.
- Your devices reach your Whombat over an end-to-end encrypted connection, and the Whombat software doesn't send us
  your content. There is **no standing vendor login**: nobody from Whombat can get in unless you let us in with
  remote help (section 7). We only see a diagnostics bundle if you create one, check what's in it and send it to us.

## 3. With and without Whombat Link

- Your Whombat **works fully without Whombat Link**: at home, and away from home with Tailscale or Headscale, which
  you set up on each of your devices. Your agent, automations, backups and updates don't depend on Whombat Link.
- Whombat Link adds its own secure web address, notifications on your phones, the Whombat apps away from home and
  sign-ins like Google. Its price, the free month and what happens when it ends are in the Subscription Terms.
- You may change the Whombat software on your Whombat: the AGPL-3.0 allows it. We support our own releases, so with
  a changed version we may not be able to help you, and parts of the service may not work with it.

## 4. Updates

- Your Whombat installs our updates to the Whombat software **by itself.** Every update is signed by us, and your
  Whombat checks the signature before it installs anything. If an update fails, it goes back to the previous version.
- You choose where its updates come from: **Production**, tested versions, or **Beta**, new versions first, before
  they're fully tested. With Beta, something may break.
- If you turn on **Ask before updating**, each update waits until you say yes. Say yes soon, so that security fixes
  arrive in time.
- If you choose Claude, your Whombat downloads the Claude Code client straight from Anthropic, its maker, as the
  unmodified program Anthropic publishes. Our signed updates only name the version, and your Whombat checks that it
  got exactly that version before it installs it.
- Keep your Whombat connected to the internet, so it gets security updates in time. We announce in advance when we'll
  stop supporting a release.

## 5. Your Whombat's hardware

- **A box from us:** the terms under which you bought or rented it cover the hardware itself.
- **Installed yourself:** you're responsible for the machine it runs on, its power, network and physical security. We
  support the platforms we've listed as qualified; on other hardware it may not work, and we can't help with problems
  that come from the hardware.
- Either way, keep the Whombat in a place where only people you trust can get to it.

## 6. Keys only you hold

Your Whombat protects your data with keys that we never receive and can't restore:

- your **passkey**, which opens your backups, and the paper copy of your backup details if you printed one;
- the **recovery kit**, if you made one in Settings, which lets you add devices to your Whombat.

A Whombat you install yourself doesn't encrypt its disk: whoever has the disk can read what's on it. Put it on an
encrypted disk or encrypted virtual machine storage if that matters to you.

**Keep them somewhere safe, apart from the Whombat.** If they're lost, we can't get your data back. If someone else
gets them, they may be able to get to your data. You're also responsible for your backups: setting up a backup
destination, and checking that it works.

## 7. Remote help

If something is wrong, you can let Whombat support into your Whombat for a limited time (“remote help”, in
Settings → This Whombat → About).

- It's **off unless you turn it on**, and it turns itself off when the time you chose runs out (at most a week).
- You choose how much. **Look** lets support read the Whombat's logs, status, hardware and network; they can't
  change anything or see your chats, files or Vault. **Look and fix** also lets them restart parts, change settings
  and run commands, which means they can see everything on that Whombat.
- Support connects through your Whombat's own outgoing connection, with a key that only works for that Whombat and
  runs out within hours, and the help code you give them.
- Your Whombat records what support does: the commands they run, what their command line showed and the connections
  they open. You're told when someone connects, can read that record in Settings, and can **stop remote help at any
  time.**
- Turning remote help on is your consent to that visit. We use what we see only to help with what you asked.

## 8. The agent and AI providers

- Your Whombat's agent runs on AI providers you sign in to with your own subscription or API key. Your Whombat sends
  those providers what the agent needs to do its work. Your agreement with each provider covers that, and you're
  responsible for following its terms.
- The Dutch voice is a model by Supertone Inc. under its own licence, the BigScience Open RAIL-M License. If you
  turn it on in Settings, you agree to that licence, including the use restrictions in Attachment A.
- You decide what the agent may do: which tools and connections it gets, and which actions need your approval. You're
  responsible for what it does with that access, and for checking its output before you rely on it.

## 9. Using the service fairly

You may not, and may not help anyone else to:

1. get Whombat Link without paying for it, for example with another Whombat's identity;
2. attack, overload or disrupt the relay, our other servers or anyone else's Whombat;
3. resell or rent the service or your subscription to others, or share your account, unless we've agreed to it in
   writing;
4. use the Whombat name or logo in ways section 10 doesn't allow.

These rules are about our service. They don't limit what you may do with the Whombat software under the AGPL-3.0.

## 10. The name and logo

“Whombat”, the Whombat logo, the wombat mascot and the Whombat app icons are trademarks of Cybex BV (registration
pending). You may say truthfully that your software is based on Whombat or works with it. A changed version you share
with others, or let them use over a network, needs a name and a logo of its own, and must not suggest that we made or
endorse it. The details are in “The name Whombat and its marks”, published with the source code.

## 11. Ending the service

- Whombat Link for a Whombat ends as the Subscription Terms say. Updates go on without it, while we support your
  Whombat's release.
- If you seriously break section 9 and don't stop after we've told you, we may stop the service for your Whombat.
  Section 2 still applies: you can still read, export and recover your data. You may also keep running the Whombat
  software without our service, under the AGPL-3.0.
- **Resetting a Whombat erases everything on it.** Export what you want to keep, and check your backups, before you
  reset, sell or give away a Whombat. A reset Whombat has to be claimed again.

## 12. Warranty and liability

The service, and a box from us, come with the commitments in these terms and in the Terms of Service. Beyond those,
and as far as the law allows, they're provided **“as is”.** The limits of our liability in the Terms of Service apply
here too. The Whombat software itself also comes with the AGPL-3.0's own disclaimer of warranty and limit of
liability (its sections 15 and 16). If you set up a Whombat for yourself, you keep every right that consumer law
gives you.

## 13. Other terms

If these terms conflict with the Terms of Service about your Whombat or the service for it, these terms apply. The
Terms of Service's rules on changes, law and disputes apply to these terms as well. We'll ask you to accept a new
version of these terms before you claim or link your next Whombat.

## Attachment A. The Dutch voice's use restrictions

These are the use restrictions of the BigScience Open RAIL-M License (its paragraph 5 and Attachment A), under which
Supertone Inc. publishes Supertonic 3, the Dutch voice your Whombat downloads only if you turn it on in Settings. They
apply to everyone who uses the model, also through a Whombat. The full licence is at
[huggingface.co/Supertone/supertonic-3](https://huggingface.co/Supertone/supertonic-3/blob/3cadd1ee6394adea1bd021217a0e650ede09a323/LICENSE),
and your Whombat keeps a copy beside the model.

You agree not to use the Model or Derivatives of the Model:

- (a) In any way that violates any applicable national, federal, state, local or international law or regulation;
- (b) For the purpose of exploiting, harming or attempting to exploit or harm minors in any way;
- (c) To generate or disseminate verifiably false information and/or content with the purpose of harming others;
- (d) To generate or disseminate personal identifiable information that can be used to harm an individual;
- (e) To generate or disseminate information and/or content (e.g. images, code, posts, articles), and place the
  information and/or content in any context (e.g. bot generating tweets) without expressly and intelligibly
  disclaiming that the information and/or content is machine generated;
- (f) To defame, disparage or otherwise harass others;
- (g) To impersonate or attempt to impersonate (e.g. deepfakes) others without their consent;
- (h) For fully automated decision making that adversely impacts an individual's legal rights or otherwise creates or
  modifies a binding, enforceable obligation;
- (i) For any use intended to or which has the effect of discriminating against or harming individuals or groups based
  on online or offline social behavior or known or predicted personal or personality characteristics;
- (j) To exploit any of the vulnerabilities of a specific group of persons based on their age, social, physical or
  mental characteristics, in order to materially distort the behavior of a person pertaining to that group in a manner
  that causes or is likely to cause that person or another person physical or psychological harm;
- (k) For any use intended to or which has the effect of discriminating against individuals or groups based on legally
  protected characteristics or categories;
- (l) To provide medical advice and medical results interpretation;
- (m) To generate or disseminate information for the purpose to be used for administration of justice, law
  enforcement, immigration or asylum processes, such as predicting an individual will commit fraud/crime commitment
  (e.g. by text profiling, drawing causal relationships between assertions made in documents, indiscriminate and
  arbitrarily-targeted use).
