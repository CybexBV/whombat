import { splitPairs } from './pairs.js';

export const VOICE_MESSAGES = splitPairs({
  'voice.section': ['Voice typing', 'Spraaktypen'],
  'voice.on.label': ['Voice typing', 'Spraaktypen'],
  'voice.on.meta': [
    'Speak instead of typing. This Whombat turns what you say into text, and the recording never leaves it.',
    'Spreek in plaats van te typen. Deze Whombat zet wat je zegt om in tekst, en de opname verlaat hem nooit.',
  ],
  'voice.model.label': ['Speech model', 'Spraakmodel'],
  'voice.model.choices.auto': ['Automatic', 'Automatisch'],
  'voice.model.choices.parakeet': ['Fast', 'Snel'],
  'voice.model.choices.whisper': ['Most accurate', 'Nauwkeurigst'],
  'voice.model.uses.parakeet': ['Uses Fast now', 'Gebruikt nu Snel'],
  'voice.model.uses.whisper': ['Uses Most accurate now', 'Gebruikt nu Nauwkeurigst'],
  'voice.model.slow': [
    'Without a graphics chip this takes about as long as you spoke.',
    'Zonder grafische chip duurt dit ongeveer even lang als je sprak.',
  ],
  'voice.language.label': ['Language', 'Taal'],
  'voice.language.choices.auto': ['Automatic', 'Automatisch'],
  'voice.language.choices.en': ['English', 'English'],
  'voice.language.choices.nl': ['Nederlands', 'Nederlands'],
  'voice.models.label': ['Speech models', 'Spraakmodellen'],
  'voice.models.parakeet.name': ['Fast', 'Snel'],
  'voice.models.parakeet.about': [
    'Parakeet. Quick on the processor, English and Dutch.',
    'Parakeet. Snel op de processor, Engels en Nederlands.',
  ],
  'voice.models.whisper.name': ['Most accurate', 'Nauwkeurigst'],
  'voice.models.whisper.about': [
    'Whisper. Best with Dutch, quick with a graphics chip.',
    'Whisper. Het best met Nederlands, snel met een grafische chip.',
  ],
  'voice.dutchVoice.label': ['Dutch voice', 'Nederlandse stem'],
  'voice.dutchVoice.meta': [
    'Speak Dutch answers in a Dutch voice instead of an English one (Supertonic 3, {size}).',
    'Spreek Nederlandse antwoorden uit met een Nederlandse stem in plaats van een Engelse (Supertonic 3, {size}).',
  ],
  'voice.dutchVoice.removing': [
    'Still removing the Dutch voice.',
    'De Nederlandse stem wordt nog verwijderd.',
  ],
  'voice.dutchVoice.dialog.title': ['Download the Dutch voice?', 'De Nederlandse stem downloaden?'],
  'voice.dutchVoice.dialog.intro': [
    'Whombat downloads Supertonic 3 ({size}) onto this Whombat. It uses the BigScience Open RAIL-M licence, which allows personal and business use with a few restrictions. By turning this on, you agree not to use it:',
    'Whombat downloadt Supertonic 3 ({size}) naar deze Whombat. Die gebruikt de BigScience Open RAIL-M-licentie, die persoonlijk en zakelijk gebruik toestaat met een paar beperkingen. De licentie is in het Engels en geldt zoals hij daar staat; dit is een korte samenvatting. Door dit aan te zetten, ga je ermee akkoord het niet te gebruiken:',
  ],
  'voice.dutchVoice.dialog.licenceLink': [
    'Read the full Open RAIL-M licence',
    'Lees de volledige Open RAIL-M-licentie (Engels)',
  ],
  'voice.dutchVoice.dialog.agree': ['Agree and download', 'Akkoord en downloaden'],
  'voice.dutchVoice.dialog.cancel': ['Cancel', 'Annuleren'],
  'voice.states.absent': ['Not downloaded', 'Niet gedownload'],
  'voice.states.downloading': ['Downloading · {percent}%', 'Downloaden · {percent}%'],
  'voice.states.waiting': ['Waiting to download', 'Wacht op downloaden'],
  'voice.states.ready': ['Ready', 'Klaar'],
  'voice.states.failed': ['Couldn’t download', 'Kon niet downloaden'],
  'voice.states.removing': ['Removing…', 'Verwijderen…'],
  'voice.problems.no_network': [
    'No internet right now. It tries again by itself.',
    'Nu geen internet. Het probeert het vanzelf opnieuw.',
  ],
  'voice.problems.no_room': ['Not enough room on this Whombat.', 'Niet genoeg ruimte op deze Whombat.'],
  'voice.problems.bad_download': ['The download was damaged.', 'De download was beschadigd.'],
  'voice.problems.failed': ['Something went wrong.', 'Er ging iets mis.'],
  'voice.actions.download': ['Download', 'Downloaden'],
  'voice.actions.remove': ['Remove', 'Verwijderen'],
  'voice.actions.retry': ['Try again', 'Opnieuw proberen'],
  'voice.gpu.found': ['Graphics chip: {name}', 'Grafische chip: {name}'],
  'voice.gpu.none': [
    'No graphics chip found, so speech runs on the processor.',
    'Geen grafische chip gevonden, dus spraak draait op de processor.',
  ],
  'voice.composer.dictate': ['Dictate', 'Dicteren'],
  'voice.composer.cancel': ['Cancel', 'Annuleren'],
  'voice.composer.done': ['Done', 'Klaar'],
  'voice.composer.preparing': ['Starting…', 'Starten…'],
  'voice.composer.recording': ['Recording {time}', 'Opnemen {time}'],
  'voice.composer.transcribing': ['Turning speech into text…', 'Spraak wordt tekst…'],
  'voice.errors.dictation_off': [
    'Voice typing is off. You can turn it on in Settings.',
    'Spraaktypen staat uit. Je kunt het aanzetten in Instellingen.',
  ],
  'voice.errors.not_ready': [
    'Voice typing is still downloading its speech model.',
    'Spraaktypen is zijn spraakmodel nog aan het downloaden.',
  ],
  'voice.errors.busy': [
    'This Whombat is busy with another recording. Try again in a moment.',
    'Deze Whombat is bezig met een andere opname. Probeer het zo opnieuw.',
  ],
  'voice.errors.bad_audio': [
    'That recording didn’t work. Try again.',
    'Die opname werkte niet. Probeer het opnieuw.',
  ],
  'voice.errors.too_long': [
    'That was longer than 5 minutes. Try a shorter one.',
    'Dat was langer dan 5 minuten. Probeer een kortere.',
  ],
  'voice.errors.failed': [
    'Couldn’t turn that into text. Try again.',
    'Kon dat niet omzetten in tekst. Probeer het opnieuw.',
  ],
  'voice.errors.microphone': [
    'Allow the microphone to use voice typing.',
    'Geef toegang tot de microfoon om spraaktypen te gebruiken.',
  ],
  'voice.errors.nothing': ['Nothing was heard.', 'Er werd niets gehoord.'],
  'voice.errors.offline': ['Can’t reach your Whombat right now.', 'Kan je Whombat nu niet bereiken.'],
  'voice.dutchVoice.dialog.restriction.law': [
    'to break the law, harm minors, harass or defame others, or spread harmful falsehoods or personal data;',
    'om de wet te overtreden, minderjarigen te schaden, anderen lastig te vallen of te belasteren, of schadelijke onwaarheden of persoonsgegevens te verspreiden;',
  ],
  'voice.dutchVoice.dialog.restriction.impersonate': [
    'to impersonate someone without their consent, or publish generated audio without saying it is AI-generated;',
    'om je zonder toestemming als iemand anders voor te doen, of gemaakte audio te publiceren zonder te zeggen dat die door AI is gemaakt;',
  ],
  'voice.dutchVoice.dialog.restriction.discrimination': [
    'for discrimination, exploiting vulnerable groups, automated legal decisions, justice or immigration profiling, or medical advice.',
    'voor discriminatie, het uitbuiten van kwetsbare groepen, geautomatiseerde juridische beslissingen, profilering voor justitie of immigratie, of medisch advies.',
  ],
});
