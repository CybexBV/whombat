import { splitPairs } from './pairs';

/** Emails the box sends itself (`mail/`): the shared layout, the notification digest and the mail server test. */
export const MAIL = splitPairs({
  'mail.template.linkFallback': [
    'If the button doesn’t work, paste this link into your browser:',
    'Werkt de knop niet? Plak deze link in je browser:',
  ],
  'mail.template.open': ['Open →', 'Openen →'],
  'mail.template.sentByAt': ['Sent by the Whombat at {host}', 'Verstuurd door de Whombat op {host}'],
  'mail.template.sentByYours': ['Sent by your Whombat', 'Verstuurd door je Whombat'],

  'mail.digest.needsYou': ['Needs you · {where}', 'Actie nodig · {where}'],
  'mail.digest.mention': ['{actor} mentioned you in {where}', '{actor} noemde je in {where}'],
  'mail.digest.reply': ['{actor} replied in {where}', '{actor} antwoordde in {where}'],
  'mail.digest.wroteToYou': ['{actor} wrote to you', '{actor} schreef je'],
  'mail.digest.wroteIn': ['{actor} wrote in {where}', '{actor} schreef in {where}'],
  'mail.digest.subjectMany': [
    { one: '{n} thing waiting for you in Whombat', other: '{n} things waiting for you in Whombat' },
    { one: '{n} ding wacht op je in Whombat', other: '{n} dingen wachten op je in Whombat' },
  ],
  'mail.digest.hi': ['Hi {name},', 'Hoi {name},'],
  'mail.digest.whileAway': ['While you were away:', 'Terwijl je weg was:'],
  'mail.digest.hiWhileAway': ['Hi {name}, while you were away:', 'Hoi {name}, terwijl je weg was:'],
  'mail.digest.more': ['…and {n} more in your inbox.', '…en nog {n} in je inbox.'],
  'mail.digest.openLine': ['Open Whombat: {url}', 'Open Whombat: {url}'],
  'mail.digest.open': ['Open Whombat', 'Open Whombat'],
  'mail.digest.daily': ['once a day', 'één keer per dag'],
  'mail.digest.hourly': ['at most once an hour', 'hooguit één keer per uur'],
  'mail.digest.youGetThis': [
    'You get this {cadence} when something waits for you.',
    'Je krijgt dit {cadence} als er iets op je wacht.',
  ],
  'mail.digest.youGetThisText': [
    'You get this {cadence} when something waits for you. Change it or turn it off in Settings → Notifications:',
    'Je krijgt dit {cadence} als er iets op je wacht. Wijzig het of zet het uit in Instellingen → Meldingen:',
  ],
  'mail.digest.change': [
    'Change it or turn it off in Settings → Notifications',
    'Wijzig het of zet het uit in Instellingen → Meldingen',
  ],
  'mail.digest.label': ['Notifications', 'Meldingen'],
  'mail.digest.titleOne': ['Something is waiting for you', 'Er wacht iets op je'],
  'mail.digest.titleMany': [
    { one: '{n} thing is waiting for you', other: '{n} things are waiting for you' },
    { one: '{n} ding wacht op je', other: '{n} dingen wachten op je' },
  ],
  'mail.digest.someone': ['Someone', 'Iemand'],
  'mail.digest.there': ['there', 'daar'],

  'mail.test.subject': ['Your Whombat can send email', 'Je Whombat kan e-mail versturen'],
  'mail.test.text': [
    'This is a test from your Whombat. If you can read it, email works.',
    'Dit is een test van je Whombat. Als je dit kunt lezen, werkt e-mail.',
  ],
  'mail.test.refused': [
    '{host} refused the sender or the recipient.',
    '{host} weigerde de afzender of de ontvanger.',
  ],
});
