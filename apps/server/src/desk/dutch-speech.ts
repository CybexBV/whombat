/**
 * Dutch at the desk (docs/decisions/desk-display-talk.md DK-T22, DK-T23): the language an answer is in, and a Dutch
 * answer written out the way it is said. The box's Dutch voice (Supertonic 3) reads written-out words well but digits,
 * times, decimals and names like “pve-02” badly, so those become words before it speaks; what the screen shows stays the
 * answer as written.
 */
import { VOICE_TTS_TEXT_MAX, type VoiceSpeechLanguage } from '@whombat/control-contracts/local';

/* The language ----------------------------------------------------------------------------------------------------- */

/**
 * Words that say a sentence is Dutch, or English. Words both languages write the same way (is, in, we, was, had, of,
 * over, door, me, ten, die) count for neither, nor do the loanwords Dutch answers use (backup, online, snapshots).
 */
const DUTCH_WORDS = new Set(
  (
    'de het een en niet van dat deze dit je jij jouw uw ik er zijn met voor maar ook nog wat kan kun kunt wordt worden ' +
    'naar bij om als dan geen wel nu zal zou moet mijn hij zij ze hier daar heb hebt heeft hebben staat staan draait ' +
    'draaien alles alle nee ja klaar goed even gaat ging wil wilt weer al toch dus omdat waar wie hoe welke zo veel ' +
    'meer minder vandaag morgen gisteren nacht uur minuten vrij vol schijf op aan uit te tot sinds zonder tussen'
  ).split(' '),
);
const ENGLISH_WORDS = new Set(
  (
    'the a an and not that this these it you your yours i there are be been with for but also still what can could ' +
    'will would must should at as than no yes now my he she they them here has have having running runs all ' +
    'everything done good well just again already so because where who how which much more less today tomorrow ' +
    'yesterday night hour hours minutes free full disk to from until since without between on off up'
  ).split(' '),
);

/**
 * The language an answer is in, for the voice that says it: Dutch when more of its words are Dutch than English, else
 * English (empty text and ties too, the voice every service has).
 */
export function speechLanguage(text: string): VoiceSpeechLanguage {
  let dutch = 0;
  let english = 0;
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (DUTCH_WORDS.has(word)) dutch++;
    else if (ENGLISH_WORDS.has(word)) english++;
  }
  return dutch > english ? 'nl' : 'en';
}

/* Numbers ---------------------------------------------------------------------------------------------------------- */

const UNITS = ['nul', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen'];
const TEENS = [
  'tien',
  'elf',
  'twaalf',
  'dertien',
  'veertien',
  'vijftien',
  'zestien',
  'zeventien',
  'achttien',
  'negentien',
];
const TENS = ['', '', 'twintig', 'dertig', 'veertig', 'vijftig', 'zestig', 'zeventig', 'tachtig', 'negentig'];
/** Above this a number is read digit by digit. */
const LARGEST = 999_999_999_999;

function below100(n: number): string {
  if (n < 10) return UNITS[n] as string;
  if (n < 20) return TEENS[n - 10] as string;
  const unit = n % 10;
  const tens = TENS[Math.floor(n / 10)] as string;
  if (unit === 0) return tens;
  const u = UNITS[unit] as string;
  // tweeëntwintig, drieëntwintig: the diaeresis where “en” follows an e.
  return `${u}${u.endsWith('e') ? 'ën' : 'en'}${tens}`;
}

function below1000(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = hundreds === 0 ? '' : hundreds === 1 ? 'honderd' : `${UNITS[hundreds]}honderd`;
  return rest === 0 && head ? head : `${head}${below100(rest)}`;
}

function below1e6(n: number): string {
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = thousands === 0 ? '' : thousands === 1 ? 'duizend' : `${below1000(thousands)}duizend`;
  return rest === 0 && head ? head : `${head}${below1000(rest)}`;
}

/** A whole number as Dutch words: one word below a million (“tweeduizendzesentwintig”), “één” alone. */
export function dutchNumber(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n > LARGEST) return digits(String(n));
  if (n === 1) return 'één';
  if (n < 1_000_000) return below1e6(n);
  const parts: string[] = [];
  for (const [size, name] of [
    [1_000_000_000, 'miljard'],
    [1_000_000, 'miljoen'],
  ] as const) {
    const count = Math.floor(n / size);
    if (count > 0) parts.push(`${count === 1 ? 'één' : below1e6(count)} ${name}`);
    n %= size;
  }
  if (n > 0) parts.push(below1e6(n) === 'een' ? 'één' : below1e6(n));
  return parts.join(' ');
}

/** Digit by digit (“nul twee”). */
function digits(s: string): string {
  return [...s.replace(/\D/g, '')].map((d) => (d === '1' ? 'één' : UNITS[Number(d)])).join(' ');
}

/** A run of digits as it is said: with a leading zero digit by digit (“02”), else as a number. */
function digitRun(s: string): string {
  return s.length > 1 && s.startsWith('0') ? digits(s) : dutchNumber(Number(s));
}

/**
 * A written number as it is said: thousands grouped with dots (1.234.567, 1.234,5), decimals after a comma, or after a
 * dot that isn't followed by exactly three digits (“1.2 TB” from an English habit); a version's parts with “punt”.
 */
function numberText(written: string): string {
  const grouped = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d+))?$/.exec(written);
  if (grouped) {
    const whole = dutchNumber(Number((grouped[1] as string).replace(/\./g, '')));
    return grouped[2] ? `${whole} komma ${digitRun(grouped[2])}` : whole;
  }
  const decimal = /^(\d+)[.,](\d+)$/.exec(written);
  if (decimal) return `${digitRun(decimal[1] as string)} komma ${digitRun(decimal[2] as string)}`;
  if (/^\d+(\.\d+)+$/.test(written)) return written.split('.').map(digitRun).join(' punt ');
  return digitRun(written.replace(/\D/g, ''));
}

/* Times ------------------------------------------------------------------------------------------------------------ */

/** On the 12-hour clock, as “half drie” and “kwart over twee” say it (0 and 12 are twaalf). */
const twelve = (h: number) => h % 12 || 12;

/** 03:00 → “drie uur”, 14:30 → “half drie”, 14:15 → “kwart over twee”, 14:45 → “kwart voor drie”, 09:05 → “negen uur vijf”. */
function timeText(h: number, m: number): string {
  if (m === 0) return `${dutchNumber(h)} uur`;
  if (m === 30) return `half ${dutchNumber(twelve(h + 1))}`;
  if (m === 15) return `kwart over ${dutchNumber(twelve(h))}`;
  if (m === 45) return `kwart voor ${dutchNumber(twelve(h + 1))}`;
  return `${dutchNumber(h)} uur ${dutchNumber(m)}`;
}

/* Writing it out --------------------------------------------------------------------------------------------------- */

const UNIT_WORDS: Record<string, string> = {
  TB: 'terabyte',
  TiB: 'terabyte',
  GB: 'gigabyte',
  GiB: 'gigabyte',
  MB: 'megabyte',
  MiB: 'megabyte',
  kB: 'kilobyte',
  KB: 'kilobyte',
  GHz: 'gigahertz',
  MHz: 'megahertz',
  kWh: 'kilowattuur',
  W: 'watt',
  ms: 'milliseconden',
};

const NUMBER = String.raw`\d+(?:[.,]\d+)*`;
const NOT_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}])`;

const TIME_RE = /(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g;
/** A name of letters and digits: pve-02, PVE-01, sda1, vm-104, node-3. */
const NAME_RE = new RegExp(`${NOT_WORD_BEFORE}(\\p{L}+)[-_]?(\\d+)${NOT_WORD_AFTER}`, 'gu');
const RANGE_RE = new RegExp(`(${NUMBER})\\s?[-–]\\s?(?=\\d)`, 'gu');
const PERCENT_RE = new RegExp(`(${NUMBER})\\s?%`, 'gu');
const DEGREES_RE = new RegExp(`(${NUMBER})\\s?°\\s?C?${NOT_WORD_AFTER}`, 'gu');
const UNIT_RE = new RegExp(`(${NUMBER})\\s?(${Object.keys(UNIT_WORDS).join('|')})${NOT_WORD_AFTER}`, 'gu');
const MINUS_RE = new RegExp(`${NOT_WORD_BEFORE}[-−](?=\\d)`, 'gu');
const NUMBER_RE = new RegExp(NUMBER, 'gu');

/**
 * Letters before digits are spelled when they are an abbreviation (“P V E”): three letters or fewer, or four in
 * capitals. A longer run is a word (“node drie”, “disk twee”), which spelling would make nonsense of.
 */
function nameText(letters: string, run: string): string {
  const spell = letters.length <= 3 || (letters.length === 4 && letters === letters.toUpperCase());
  const head = spell ? [...letters.toUpperCase()].join(' ') : letters;
  return `${head} ${digitRun(run)}`;
}

/**
 * A Dutch answer as the voice should say it: times, names with digits, ranges, percentages, degrees, units and numbers
 * written out, hyphens between words as spaces, at most `VOICE_TTS_TEXT_MAX` code points (cut after the last whole
 * sentence that fits).
 */
export function dutchSpeechText(text: string): string {
  const out = text
    .replace(TIME_RE, (_, h: string, m: string) => timeText(Number(h), Number(m)))
    .replace(NAME_RE, (_, letters: string, run: string) => nameText(letters, run))
    .replace(RANGE_RE, (_, n: string) => `${numberText(n)} tot `)
    .replace(MINUS_RE, 'min ')
    .replace(PERCENT_RE, (_, n: string) => `${numberText(n)} procent`)
    .replace(DEGREES_RE, (_, n: string) => `${numberText(n)} graden`)
    .replace(UNIT_RE, (_, n: string, unit: string) => `${numberText(n)} ${UNIT_WORDS[unit]}`)
    .replace(NUMBER_RE, (n) => numberText(n))
    .replace(/(?<=\p{L})-(?=\p{L})/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return fit(out, VOICE_TTS_TEXT_MAX);
}

/** At most `max` code points: up to the last sentence end that fits, else the last whole word. */
function fit(text: string, max: number): string {
  const points = [...text];
  if (points.length <= max) return text;
  const cut = points.slice(0, max).join('');
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end > max / 3) return cut.slice(0, end + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}
