/**
 * Emoji for reactions (0.26, CT-178): about 250 common emoji with their names, search keywords and group, so the web
 * popover and the mobile sheet offer the same set and find the same results. Pure data and pure lookups; no images
 * (clients draw the characters with the system font). A reaction's value is the emoji character (`ReactionValue`).
 */

import { coreWords } from '../i18n/catalog.js';

export const EMOJI_GROUPS = [
  'smileys',
  'people',
  'nature',
  'food',
  'activities',
  'travel',
  'objects',
  'symbols',
] as const;
export type EmojiGroup = (typeof EMOJI_GROUPS)[number];

/** Tab and section labels, in `EMOJI_GROUPS` order, in a locale. */
export function emojiGroupLabels(locale?: string | null): Readonly<Record<EmojiGroup, string>> {
  return coreWords(locale, 'emoji.group', EMOJI_GROUPS);
}

export const EMOJI_GROUP_LABELS: Record<EmojiGroup, string> = emojiGroupLabels('en');

export interface Emoji {
  /** The character, fully qualified (`❤️` with its variation selector): the reaction's value. */
  char: string;
  /** Unicode CLDR short name, lowercase: `thumbs up`. */
  name: string;
  /** Lowercase search words besides the name: `+1`, `yes`, `approve`. */
  keywords: readonly string[];
  group: EmojiGroup;
}

type Row = readonly [char: string, name: string, keywords: string];

const SMILEYS: Row[] = [
  ['😀', 'grinning face', 'smile happy'],
  ['😃', 'grinning face with big eyes', 'smile happy joy'],
  ['😄', 'grinning face with smiling eyes', 'smile happy laugh'],
  ['😁', 'beaming face with smiling eyes', 'grin happy'],
  ['😆', 'grinning squinting face', 'laugh happy'],
  ['😅', 'grinning face with sweat', 'relief nervous phew'],
  ['🤣', 'rolling on the floor laughing', 'rofl lol laugh'],
  ['😂', 'face with tears of joy', 'lol laugh cry joy'],
  ['🙂', 'slightly smiling face', 'smile'],
  ['🙃', 'upside-down face', 'silly sarcasm'],
  ['😉', 'winking face', 'wink'],
  ['😊', 'smiling face with smiling eyes', 'blush happy'],
  ['😇', 'smiling face with halo', 'angel innocent'],
  ['🥰', 'smiling face with hearts', 'love adore'],
  ['😍', 'smiling face with heart-eyes', 'love crush'],
  ['🤩', 'star-struck', 'wow amazing excited'],
  ['😘', 'face blowing a kiss', 'kiss love'],
  ['😋', 'face savoring food', 'yum delicious'],
  ['😛', 'face with tongue', 'tongue playful'],
  ['😜', 'winking face with tongue', 'silly joke'],
  ['🤪', 'zany face', 'crazy goofy'],
  ['🤑', 'money-mouth face', 'money rich'],
  ['🤗', 'smiling face with open hands', 'hug thanks'],
  ['🤭', 'face with hand over mouth', 'oops giggle'],
  ['🤫', 'shushing face', 'quiet secret shh'],
  ['🤔', 'thinking face', 'think hmm consider'],
  ['🤐', 'zipper-mouth face', 'secret quiet'],
  ['🤨', 'face with raised eyebrow', 'skeptical doubt'],
  ['😐', 'neutral face', 'meh'],
  ['😑', 'expressionless face', 'blank'],
  ['😶', 'face without mouth', 'speechless silent'],
  ['😏', 'smirking face', 'smirk'],
  ['😒', 'unamused face', 'meh unimpressed'],
  ['🙄', 'face with rolling eyes', 'eyeroll whatever'],
  ['😬', 'grimacing face', 'awkward yikes'],
  ['😌', 'relieved face', 'relief calm'],
  ['😔', 'pensive face', 'sad thoughtful'],
  ['😪', 'sleepy face', 'tired'],
  ['😴', 'sleeping face', 'sleep zzz'],
  ['😷', 'face with medical mask', 'sick mask'],
  ['🤒', 'face with thermometer', 'sick ill'],
  ['🤕', 'face with head-bandage', 'hurt injured'],
  ['🤢', 'nauseated face', 'sick gross'],
  ['🤮', 'face vomiting', 'sick gross'],
  ['🥵', 'hot face', 'hot heat'],
  ['🥶', 'cold face', 'cold freezing'],
  ['🥴', 'woozy face', 'dizzy'],
  ['😵', 'face with crossed-out eyes', 'dizzy dead'],
  ['🤯', 'exploding head', 'mind blown shocked'],
  ['🤠', 'cowboy hat face', 'cowboy yeehaw'],
  ['🥳', 'partying face', 'party celebrate birthday'],
  ['😎', 'smiling face with sunglasses', 'cool'],
  ['🤓', 'nerd face', 'nerd geek'],
  ['🧐', 'face with monocle', 'inspect curious'],
  ['😕', 'confused face', 'confused unsure'],
  ['😟', 'worried face', 'worried concern'],
  ['🙁', 'slightly frowning face', 'sad'],
  ['😮', 'face with open mouth', 'surprised wow'],
  ['😯', 'hushed face', 'surprised'],
  ['😲', 'astonished face', 'shocked amazed'],
  ['😳', 'flushed face', 'embarrassed'],
  ['🥺', 'pleading face', 'please puppy eyes'],
  ['😦', 'frowning face with open mouth', 'shocked'],
  ['😧', 'anguished face', 'anguish'],
  ['😨', 'fearful face', 'scared'],
  ['😰', 'anxious face with sweat', 'nervous anxious'],
  ['😥', 'sad but relieved face', 'phew'],
  ['😢', 'crying face', 'sad tear'],
  ['😭', 'loudly crying face', 'sob cry'],
  ['😱', 'face screaming in fear', 'scream shocked'],
  ['😖', 'confounded face', 'frustrated'],
  ['😣', 'persevering face', 'struggle'],
  ['😞', 'disappointed face', 'sad'],
  ['😓', 'downcast face with sweat', 'sweat hard work'],
  ['😩', 'weary face', 'tired'],
  ['😫', 'tired face', 'exhausted'],
  ['🥱', 'yawning face', 'bored tired'],
  ['😤', 'face with steam from nose', 'frustrated triumph'],
  ['😡', 'enraged face', 'angry mad'],
  ['😠', 'angry face', 'angry mad'],
  ['🤬', 'face with symbols on mouth', 'swear cursing'],
  ['😈', 'smiling face with horns', 'devil mischief'],
  ['💀', 'skull', 'dead dying laughing'],
  ['💩', 'pile of poo', 'poop'],
  ['🤡', 'clown face', 'clown'],
  ['👻', 'ghost', 'boo halloween'],
  ['👽', 'alien', 'ufo'],
  ['🤖', 'robot', 'bot agent'],
  ['😺', 'grinning cat', 'cat smile'],
  ['🙈', 'see-no-evil monkey', 'oops hide'],
  ['🙉', 'hear-no-evil monkey', 'monkey'],
  ['🙊', 'speak-no-evil monkey', 'monkey secret'],
];

const PEOPLE: Row[] = [
  ['👋', 'waving hand', 'wave hello hi bye'],
  ['🤚', 'raised back of hand', 'hand'],
  ['✋', 'raised hand', 'stop high five'],
  ['🖐️', 'hand with fingers splayed', 'hand five'],
  ['👌', 'ok hand', 'ok fine perfect'],
  ['🤌', 'pinched fingers', 'italian what'],
  ['🤏', 'pinching hand', 'small tiny little'],
  ['✌️', 'victory hand', 'peace'],
  ['🤞', 'crossed fingers', 'luck hope'],
  ['🤟', 'love-you gesture', 'love'],
  ['🤘', 'sign of the horns', 'rock metal'],
  ['🤙', 'call me hand', 'call shaka'],
  ['👈', 'backhand index pointing left', 'left point'],
  ['👉', 'backhand index pointing right', 'right point'],
  ['👆', 'backhand index pointing up', 'up point'],
  ['👇', 'backhand index pointing down', 'down point'],
  ['☝️', 'index pointing up', 'up point one'],
  ['👍', 'thumbs up', '+1 yes like approve agree'],
  ['👎', 'thumbs down', '-1 no dislike disagree'],
  ['✊', 'raised fist', 'fist solidarity'],
  ['👊', 'oncoming fist', 'punch fist bump'],
  ['👏', 'clapping hands', 'clap applause bravo'],
  ['🙌', 'raising hands', 'hooray celebrate yay'],
  ['👐', 'open hands', 'hands'],
  ['🤲', 'palms up together', 'hands'],
  ['🤝', 'handshake', 'deal agreement'],
  ['🙏', 'folded hands', 'please thanks pray'],
  ['✍️', 'writing hand', 'write'],
  ['💪', 'flexed biceps', 'strong muscle'],
  ['🧠', 'brain', 'smart think'],
  ['👀', 'eyes', 'look watching looking'],
  ['👁️', 'eye', 'look see'],
  ['👶', 'baby', 'baby new'],
  ['🧑‍💻', 'technologist', 'developer coder programmer'],
  ['🕵️', 'detective', 'investigate spy'],
  ['🤷', 'person shrugging', 'shrug dunno whatever'],
  ['🤦', 'person facepalming', 'facepalm'],
  ['🙋', 'person raising hand', 'question me volunteer'],
  ['🙇', 'person bowing', 'sorry thanks'],
  ['💃', 'woman dancing', 'dance'],
  ['🏃', 'person running', 'run hurry'],
  ['🧘', 'person in lotus position', 'calm meditate zen'],
];

const NATURE: Row[] = [
  ['🐶', 'dog face', 'dog puppy'],
  ['🐱', 'cat face', 'cat kitten'],
  ['🐭', 'mouse face', 'mouse'],
  ['🦊', 'fox', 'fox'],
  ['🐻', 'bear', 'bear'],
  ['🐼', 'panda', 'panda'],
  ['🐨', 'koala', 'koala'],
  ['🐯', 'tiger face', 'tiger'],
  ['🦁', 'lion', 'lion'],
  ['🐸', 'frog', 'frog'],
  ['🐵', 'monkey face', 'monkey'],
  ['🐔', 'chicken', 'chicken'],
  ['🐧', 'penguin', 'penguin linux'],
  ['🐦', 'bird', 'bird tweet'],
  ['🦉', 'owl', 'owl wise night'],
  ['🐝', 'honeybee', 'bee busy'],
  ['🐛', 'bug', 'bug insect'],
  ['🦋', 'butterfly', 'butterfly'],
  ['🐢', 'turtle', 'slow'],
  ['🐍', 'snake', 'python'],
  ['🐙', 'octopus', 'octopus'],
  ['🦄', 'unicorn', 'magic'],
  ['🐳', 'spouting whale', 'whale docker'],
  ['🦀', 'crab', 'rust'],
  ['🌱', 'seedling', 'grow new plant'],
  ['🌲', 'evergreen tree', 'tree'],
  ['🌴', 'palm tree', 'tropical'],
  ['🌵', 'cactus', 'desert'],
  ['🍀', 'four leaf clover', 'luck lucky'],
  ['🍁', 'maple leaf', 'autumn fall'],
  ['🌸', 'cherry blossom', 'spring flower'],
  ['🌻', 'sunflower', 'flower'],
  ['🌹', 'rose', 'flower love'],
  ['☀️', 'sun', 'sunny weather'],
  ['🌙', 'crescent moon', 'night moon'],
  ['⭐', 'star', 'star favourite favorite'],
  ['🌟', 'glowing star', 'star shine'],
  ['✨', 'sparkles', 'shiny new magic'],
  ['⚡', 'high voltage', 'lightning fast zap'],
  ['🔥', 'fire', 'hot lit flame'],
  ['🌈', 'rainbow', 'rainbow'],
  ['☁️', 'cloud', 'cloud weather'],
  ['🌧️', 'cloud with rain', 'rain weather'],
  ['⛈️', 'cloud with lightning and rain', 'storm thunder'],
  ['❄️', 'snowflake', 'cold winter snow'],
  ['🌊', 'water wave', 'wave ocean sea'],
  ['💧', 'droplet', 'water drop'],
  ['🌍', 'globe showing europe-africa', 'world earth globe'],
];

const FOOD: Row[] = [
  ['🍎', 'red apple', 'apple fruit'],
  ['🍋', 'lemon', 'lemon fruit'],
  ['🍌', 'banana', 'banana fruit'],
  ['🍉', 'watermelon', 'fruit summer'],
  ['🍇', 'grapes', 'fruit'],
  ['🍓', 'strawberry', 'fruit'],
  ['🍑', 'peach', 'fruit'],
  ['🥑', 'avocado', 'avocado'],
  ['🌶️', 'hot pepper', 'spicy chili'],
  ['🥕', 'carrot', 'vegetable'],
  ['🌽', 'ear of corn', 'corn'],
  ['🍞', 'bread', 'bread loaf'],
  ['🧀', 'cheese wedge', 'cheese'],
  ['🍕', 'pizza', 'pizza'],
  ['🍔', 'hamburger', 'burger'],
  ['🍟', 'french fries', 'fries'],
  ['🌮', 'taco', 'taco'],
  ['🍣', 'sushi', 'sushi'],
  ['🍜', 'steaming bowl', 'ramen noodles soup'],
  ['🍪', 'cookie', 'cookie biscuit'],
  ['🍩', 'doughnut', 'donut'],
  ['🎂', 'birthday cake', 'birthday cake'],
  ['🍰', 'shortcake', 'cake dessert'],
  ['🍫', 'chocolate bar', 'chocolate'],
  ['🍿', 'popcorn', 'popcorn movie'],
  ['☕', 'hot beverage', 'coffee tea'],
  ['🍵', 'teacup without handle', 'tea'],
  ['🍺', 'beer mug', 'beer'],
  ['🍻', 'clinking beer mugs', 'cheers beer'],
  ['🥂', 'clinking glasses', 'cheers celebrate toast'],
  ['🍷', 'wine glass', 'wine'],
  ['🥤', 'cup with straw', 'soda drink'],
  ['🧋', 'bubble tea', 'boba tea'],
];

const ACTIVITIES: Row[] = [
  ['🎉', 'party popper', 'tada celebrate congrats party'],
  ['🎊', 'confetti ball', 'celebrate party'],
  ['🎈', 'balloon', 'party birthday'],
  ['🎁', 'wrapped gift', 'present gift'],
  ['🏆', 'trophy', 'win award winner'],
  ['🥇', '1st place medal', 'gold first winner'],
  ['🥈', '2nd place medal', 'silver second'],
  ['🥉', '3rd place medal', 'bronze third'],
  ['🏅', 'sports medal', 'medal award'],
  ['⚽', 'soccer ball', 'football soccer'],
  ['🏀', 'basketball', 'basketball'],
  ['🏈', 'american football', 'football'],
  ['⚾', 'baseball', 'baseball'],
  ['🎾', 'tennis', 'tennis'],
  ['🏓', 'ping pong', 'table tennis'],
  ['🎯', 'bullseye', 'target goal direct hit'],
  ['🎲', 'game die', 'dice random'],
  ['🎮', 'video game', 'gaming controller'],
  ['🧩', 'puzzle piece', 'puzzle'],
  ['🎨', 'artist palette', 'art design paint'],
  ['🎬', 'clapper board', 'film movie action'],
  ['🎤', 'microphone', 'sing karaoke'],
  ['🎧', 'headphone', 'music listen'],
  ['🎵', 'musical note', 'music'],
  ['🎸', 'guitar', 'music rock'],
];

const TRAVEL: Row[] = [
  ['🚀', 'rocket', 'launch ship deploy'],
  ['✈️', 'airplane', 'travel flight'],
  ['🚗', 'automobile', 'car'],
  ['🚕', 'taxi', 'cab'],
  ['🚌', 'bus', 'bus'],
  ['🚲', 'bicycle', 'bike'],
  ['🚂', 'locomotive', 'train'],
  ['🚢', 'ship', 'ship boat'],
  ['⛵', 'sailboat', 'boat sail'],
  ['🏠', 'house', 'home'],
  ['🏢', 'office building', 'office work'],
  ['🏗️', 'building construction', 'wip construction'],
  ['🏖️', 'beach with umbrella', 'vacation holiday beach'],
  ['🗺️', 'world map', 'map'],
  ['🧭', 'compass', 'direction navigate'],
  ['⛰️', 'mountain', 'mountain'],
  ['🌋', 'volcano', 'eruption'],
  ['🚧', 'construction', 'wip roadwork'],
  ['🚦', 'vertical traffic light', 'traffic light'],
  ['🛑', 'stop sign', 'stop'],
  ['⚓', 'anchor', 'anchor'],
];

const OBJECTS: Row[] = [
  ['💡', 'light bulb', 'idea'],
  ['💻', 'laptop', 'computer'],
  ['🖥️', 'desktop computer', 'computer screen'],
  ['⌨️', 'keyboard', 'type'],
  ['🖱️', 'computer mouse', 'mouse click'],
  ['📱', 'mobile phone', 'phone'],
  ['☎️', 'telephone', 'phone'],
  ['📞', 'telephone receiver', 'call phone'],
  ['💾', 'floppy disk', 'save'],
  ['📷', 'camera', 'photo'],
  ['🎥', 'movie camera', 'video film'],
  ['📺', 'television', 'tv'],
  ['🔋', 'battery', 'battery power'],
  ['🔌', 'electric plug', 'plug power'],
  ['🔍', 'magnifying glass tilted left', 'search find zoom'],
  ['🔎', 'magnifying glass tilted right', 'search find zoom'],
  ['🔗', 'link', 'link url chain'],
  ['📎', 'paperclip', 'attachment'],
  ['✂️', 'scissors', 'cut'],
  ['📝', 'memo', 'note write'],
  ['✏️', 'pencil', 'edit write'],
  ['🖊️', 'pen', 'write sign'],
  ['📄', 'page facing up', 'document page'],
  ['📃', 'page with curl', 'document'],
  ['📊', 'bar chart', 'chart stats'],
  ['📈', 'chart increasing', 'growth up trend'],
  ['📉', 'chart decreasing', 'down trend'],
  ['📋', 'clipboard', 'list todo'],
  ['📅', 'calendar', 'date'],
  ['🗓️', 'spiral calendar', 'date schedule'],
  ['📁', 'file folder', 'folder'],
  ['📂', 'open file folder', 'folder open'],
  ['🗂️', 'card index dividers', 'organize'],
  ['🗑️', 'wastebasket', 'trash delete bin'],
  ['📦', 'package', 'box ship release'],
  ['📧', 'e-mail', 'email mail'],
  ['✉️', 'envelope', 'mail letter'],
  ['📫', 'closed mailbox with raised flag', 'mail inbox'],
  ['📚', 'books', 'docs read library'],
  ['📖', 'open book', 'read docs'],
  ['🔖', 'bookmark', 'bookmark save'],
  ['🧾', 'receipt', 'receipt invoice'],
  ['💰', 'money bag', 'money'],
  ['💵', 'dollar banknote', 'cash money'],
  ['💶', 'euro banknote', 'euro cash money'],
  ['💳', 'credit card', 'payment card'],
  ['⏰', 'alarm clock', 'alarm time'],
  ['⏱️', 'stopwatch', 'timer time'],
  ['⏳', 'hourglass not done', 'waiting loading time'],
  ['⌛', 'hourglass done', 'time'],
  ['🔧', 'wrench', 'fix tool'],
  ['🔨', 'hammer', 'build tool'],
  ['🛠️', 'hammer and wrench', 'tools fix build'],
  ['⚙️', 'gear', 'settings config'],
  ['🧰', 'toolbox', 'tools'],
  ['🧪', 'test tube', 'test experiment'],
  ['🔬', 'microscope', 'research science'],
  ['🧯', 'fire extinguisher', 'incident fire'],
  ['🩹', 'adhesive bandage', 'fix patch hotfix'],
  ['🛡️', 'shield', 'security protect'],
  ['🔑', 'key', 'key password access'],
  ['🗝️', 'old key', 'key'],
  ['🔒', 'locked', 'lock private secure'],
  ['🔓', 'unlocked', 'unlock open'],
  ['🔔', 'bell', 'notification alert'],
  ['🔕', 'bell with slash', 'mute quiet'],
  ['📌', 'pushpin', 'pin'],
  ['📍', 'round pushpin', 'location pin'],
  ['🏷️', 'label', 'tag'],
  ['📣', 'megaphone', 'announce'],
  ['📢', 'loudspeaker', 'announcement'],
  ['🪄', 'magic wand', 'magic'],
  ['🏁', 'chequered flag', 'finish done race'],
  ['🚩', 'triangular flag', 'flag red flag'],
];

const SYMBOLS: Row[] = [
  ['❤️', 'red heart', 'love like heart'],
  ['🧡', 'orange heart', 'love'],
  ['💛', 'yellow heart', 'love'],
  ['💚', 'green heart', 'love'],
  ['💙', 'blue heart', 'love'],
  ['💜', 'purple heart', 'love'],
  ['🖤', 'black heart', 'love'],
  ['🤍', 'white heart', 'love'],
  ['🤎', 'brown heart', 'love'],
  ['💔', 'broken heart', 'sad heartbreak'],
  ['❣️', 'heart exclamation', 'love'],
  ['💕', 'two hearts', 'love'],
  ['💖', 'sparkling heart', 'love'],
  ['💯', 'hundred points', '100 perfect score'],
  ['💢', 'anger symbol', 'angry'],
  ['💥', 'collision', 'boom crash'],
  ['💫', 'dizzy', 'star'],
  ['💦', 'sweat droplets', 'water splash'],
  ['💨', 'dashing away', 'fast wind'],
  ['💬', 'speech balloon', 'comment chat talk'],
  ['💭', 'thought balloon', 'think thought'],
  ['💤', 'zzz', 'sleep'],
  ['✅', 'check mark button', 'done yes ok complete'],
  ['☑️', 'check box with check', 'done checked'],
  ['✔️', 'check mark', 'done yes'],
  ['❌', 'cross mark', 'no wrong fail'],
  ['❎', 'cross mark button', 'no'],
  ['➕', 'plus', 'add'],
  ['➖', 'minus', 'subtract remove'],
  ['❓', 'red question mark', 'question'],
  ['❔', 'white question mark', 'question'],
  ['❗', 'red exclamation mark', 'important'],
  ['‼️', 'double exclamation mark', 'important'],
  ['⚠️', 'warning', 'caution alert'],
  ['🚫', 'prohibited', 'no forbidden'],
  ['⛔', 'no entry', 'stop blocked'],
  ['🔴', 'red circle', 'red dot stop'],
  ['🟠', 'orange circle', 'orange dot'],
  ['🟡', 'yellow circle', 'yellow dot'],
  ['🟢', 'green circle', 'green dot go'],
  ['🔵', 'blue circle', 'blue dot'],
  ['⭕', 'hollow red circle', 'circle'],
  ['♻️', 'recycling symbol', 'recycle'],
  ['🔁', 'repeat button', 'loop repeat'],
  ['🔄', 'counterclockwise arrows button', 'refresh sync'],
  ['⬆️', 'up arrow', 'up'],
  ['⬇️', 'down arrow', 'down'],
  ['➡️', 'right arrow', 'right next'],
  ['⬅️', 'left arrow', 'left back'],
  ['🆕', 'new button', 'new'],
  ['🆗', 'ok button', 'ok'],
  ['🆘', 'sos button', 'help emergency'],
];

function rows(group: EmojiGroup, list: readonly Row[]): Emoji[] {
  return list.map(([char, name, keywords]) => ({
    char,
    name,
    keywords: keywords.split(' ').filter(Boolean),
    group,
  }));
}

/** Every emoji in picker order: by group (`EMOJI_GROUPS`), then as listed. */
export const EMOJI: readonly Emoji[] = [
  ...rows('smileys', SMILEYS),
  ...rows('people', PEOPLE),
  ...rows('nature', NATURE),
  ...rows('food', FOOD),
  ...rows('activities', ACTIVITIES),
  ...rows('travel', TRAVEL),
  ...rows('objects', OBJECTS),
  ...rows('symbols', SYMBOLS),
];

const BY_CHAR: ReadonlyMap<string, Emoji> = new Map(EMOJI.map((e) => [e.char, e]));

/** The emoji for a character (a reaction's value), or undefined for text reactions and emoji not in the set. */
export function emojiByChar(char: string): Emoji | undefined {
  return BY_CHAR.get(char);
}

/** The reactions offered first, before the full picker: 👍 ❤️ 😂 🎉 👀 ✅. */
export const QUICK_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

/** Most emoji a client remembers as recently used. */
export const RECENT_EMOJI_MAX = 16;

/** The recent list after using `char`: it moves to the front, no duplicates, at most {@link RECENT_EMOJI_MAX}. */
export function pushRecentEmoji(recent: readonly string[], char: string): string[] {
  return [char, ...recent.filter((c) => c !== char)].slice(0, RECENT_EMOJI_MAX);
}

/**
 * Emoji matching a search, best first: the name starts with the query, then a keyword equals it, then a keyword or a
 * word of the name starts with it, then the name contains it. Case-insensitive; an empty query matches nothing.
 */
export function searchEmoji(query: string, limit = 48): Emoji[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, '');
  if (!q) return [];
  const scored: { e: Emoji; score: number; i: number }[] = [];
  EMOJI.forEach((e, i) => {
    let score = 0;
    if (e.name.startsWith(q)) score = 4;
    else if (e.keywords.includes(q)) score = 3;
    else if (e.keywords.some((k) => k.startsWith(q)) || e.name.split(/[\s-]/).some((w) => w.startsWith(q)))
      score = 2;
    else if (e.name.includes(q)) score = 1;
    if (score > 0) scored.push({ e, score, i });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, Math.max(0, limit))
    .map((s) => s.e);
}
