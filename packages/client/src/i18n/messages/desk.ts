import { treeCatalogs } from '../tree';

/**
 * The desk screen's SCREEN section in Settings (`desk/model.ts`) beyond the desk's own words (`deskWords` in core):
 * its rows, dialogs, checks and the unlock request.
 */
export const DESK_WORDS = treeCatalogs(
  'deskText',
  {
    unpairedTitle: 'The screen isn’t paired',
    pairingShown: 'The screen shows pairing letters until {until}.',
    pairedYouName: 'you',
    pairedMine: 'Unlock it with your PIN or your phone.',
    pairedMineNoPin: 'Unlock it with your phone.',
    pinMeta: '4 to 6 digits that unlock the screen.',
    pairsItself: 'It pairs itself with you in a moment.',
    lockedHints: {
      time: 'The clock, and whether something needs you.',
      summary: 'How many things need you, your servers and home. No titles or messages.',
      everything:
        'Also what needs you and what {assistant} is doing, by name. Anyone walking past can read it.',
    },
    quietOnBlack: 'From {start} to {end} the screen is black and makes no sound.',
    quietOnDim: 'From {start} to {end} the screen shows a dim clock and makes no sound.',
    quietOff: 'The screen may wake for something new at any hour.',
    inZone: 'In your time zone, {timeZone}.',
    talkOn: 'Hold to talk on the unlocked screen. What you say stays on this Whombat.',
    talkOff: 'The screen doesn’t listen.',
    dialog: {
      lead: 'The screen shows 4 letters now. Type them here and choose a PIN to unlock it with.',
      showLetters: 'Show the letters',
      changesSoon: 'They change in less than a minute.',
      changesIn: 'They change in {minutes} min.',
      expired: 'The letters ran out of time.',
      newLetters: 'Show new letters',
      submit: 'Pair',
      busy: 'Pairing…',
      done: 'The screen is paired with you.',
      cancel: 'Cancel',
    },
    pinDialog: {
      lead: 'The new PIN unlocks the screen from now on.',
      busy: 'Saving…',
      done: 'PIN changed.',
    },
    firstPinDialog: {
      lead: 'Type it on the screen to unlock it by touch. Your phone still works too.',
      submit: 'Save PIN',
      busy: 'Saving…',
      done: 'PIN saved.',
    },
    offDialog: {
      title: 'Turn the screen off?',
      leadPin: 'This unpairs it and removes its PIN. {offHint}',
      lead: 'This unpairs it. {offHint}',
      submit: 'Turn off',
      done: 'The screen is off.',
    },
    unpairDialog: {
      done: 'The screen is unpaired.',
    },
    problems: {
      letters: 'Type the 4 letters from the screen.',
      pin: 'The PIN is 4 to 6 digits.',
    },
    errors: {
      newLetters: 'Those weren’t the letters. The screen shows new ones now.',
      forbidden: 'You can’t change this.',
      failed: 'That didn’t work. Try again.',
      sixDigits: 'This Whombat takes a 6-digit PIN until it’s updated.',
      wrongCodeOne: 'Those letters don’t match the screen. 1 try left.',
    },
    unlock: {
      meta: 'Unlock it only if you’re at your desk. {ends}',
      endsMin: 'Ends in {n} min.',
      endsSec: 'Ends in {n} s.',
      unlocked: 'The screen is unlocked.',
      keptLocked: 'The screen stays locked.',
    },
  },
  {
    unpairedTitle: 'Het scherm is niet gekoppeld',
    pairingShown: 'Het scherm toont koppelletters tot {until}.',
    pairedYouName: 'jou',
    pairedMine: 'Ontgrendel het met je pincode of je telefoon.',
    pairedMineNoPin: 'Ontgrendel het met je telefoon.',
    pinMeta: '4 tot 6 cijfers die het scherm ontgrendelen.',
    pairsItself: 'Het koppelt zich zo meteen vanzelf aan jou.',
    lockedHints: {
      time: 'De klok, en of er iets op je wacht.',
      summary: 'Hoeveel dingen op je wachten, je servers en je huis. Geen titels of berichten.',
      everything:
        'Ook wat op je wacht en waar {assistant} mee bezig is, met naam. Iedereen die langsloopt kan het lezen.',
    },
    quietOnBlack: 'Van {start} tot {end} is het scherm zwart en maakt het geen geluid.',
    quietOnDim: 'Van {start} tot {end} toont het scherm een gedimde klok en maakt het geen geluid.',
    quietOff: 'Het scherm mag op elk uur wakker worden voor iets nieuws.',
    inZone: 'In jouw tijdzone, {timeZone}.',
    talkOn: 'Houd ingedrukt om te praten op het ontgrendelde scherm. Wat je zegt blijft op deze Whombat.',
    talkOff: 'Het scherm luistert niet.',
    dialog: {
      lead: 'Het scherm toont nu 4 letters. Typ ze hier en kies een pincode om het mee te ontgrendelen.',
      showLetters: 'Toon de letters',
      changesSoon: 'Ze veranderen binnen een minuut.',
      changesIn: 'Ze veranderen over {minutes} min.',
      expired: 'De tijd voor de letters is om.',
      newLetters: 'Toon nieuwe letters',
      submit: 'Koppelen',
      busy: 'Koppelen…',
      done: 'Het scherm is aan jou gekoppeld.',
      cancel: 'Annuleren',
    },
    pinDialog: {
      lead: 'Vanaf nu ontgrendelt de nieuwe pincode het scherm.',
      busy: 'Opslaan…',
      done: 'Pincode gewijzigd.',
    },
    firstPinDialog: {
      lead: 'Typ hem op het scherm om het met aanraken te ontgrendelen. Je telefoon werkt ook nog.',
      submit: 'Pincode opslaan',
      busy: 'Opslaan…',
      done: 'Pincode opgeslagen.',
    },
    offDialog: {
      title: 'Het scherm uitzetten?',
      leadPin: 'Hiermee ontkoppel je het en verdwijnt de pincode. {offHint}',
      lead: 'Hiermee ontkoppel je het. {offHint}',
      submit: 'Uitzetten',
      done: 'Het scherm staat uit.',
    },
    unpairDialog: {
      done: 'Het scherm is ontkoppeld.',
    },
    problems: {
      letters: 'Typ de 4 letters van het scherm.',
      pin: 'De pincode heeft 4 tot 6 cijfers.',
    },
    errors: {
      newLetters: 'Dat waren niet de letters. Het scherm toont nu nieuwe.',
      forbidden: 'Dit kun je niet wijzigen.',
      failed: 'Dat lukte niet. Probeer het opnieuw.',
      sixDigits: 'Deze Whombat wil een pincode van 6 cijfers tot hij is bijgewerkt.',
      wrongCodeOne: 'Die letters komen niet overeen met het scherm. Nog 1 poging.',
    },
    unlock: {
      meta: 'Ontgrendel het alleen als je aan je bureau zit. {ends}',
      endsMin: 'Nog {n} min.',
      endsSec: 'Nog {n} s.',
      unlocked: 'Het scherm is ontgrendeld.',
      keptLocked: 'Het scherm blijft vergrendeld.',
    },
  },
);
