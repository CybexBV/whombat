import { splitPairs } from './pairs.js';

/**
 * A recipe automation's words as they are read (`automations/recipes.ts`): the stored definition stays in English, these
 * are drawn at render time. Dutch puts the verb before the agent after a “when” clause (`inverted`).
 */
export const RECIPES = splitPairs({
  'recipe.job.assess.label': ['Assess it', 'Beoordelen'],
  'recipe.job.assess.does': ['{agent} assesses it', '{agent} beoordeelt het'],
  'recipe.job.assess.inverted': ['{agent} assesses it', 'beoordeelt {agent} het'],
  'recipe.job.review.label': ['Review it', 'Reviewen'],
  'recipe.job.review.does': ['{agent} reviews it', '{agent} reviewt het'],
  'recipe.job.review.inverted': ['{agent} reviews it', 'reviewt {agent} het'],
  'recipe.job.answer.label': ['Answer it', 'Beantwoorden'],
  'recipe.job.answer.does': ['{agent} answers it', '{agent} beantwoordt het'],
  'recipe.job.answer.inverted': ['{agent} answers it', 'beantwoordt {agent} het'],
  'recipe.job.check.label': ['Check a repository', 'Een repository controleren'],
  'recipe.job.check.does': ['{agent} checks the repository', '{agent} controleert de repository'],
  'recipe.job.check.inverted': ['{agent} checks the repository', 'controleert {agent} de repository'],
  'recipe.job.custom.label': ['Your own instructions', 'Je eigen instructies'],
  'recipe.job.custom.does': ['{agent} follows your instructions', '{agent} volgt je instructies'],
  'recipe.job.custom.inverted': ['{agent} follows your instructions', 'volgt {agent} je instructies'],
  'recipe.or': ['{items} or {last}', '{items} of {last}'],
  'recipe.and': ['{items} and {last}', '{items} en {last}'],
  'recipe.github.issue': ['issue', 'issue'],
  'recipe.github.pr': ['pull request', 'pull request'],
  'recipe.github.opened': ['a new {what} is opened', 'er een nieuwe {what} wordt geopend'],
  'recipe.github.updated': ['a pull request gets new commits', 'een pull request nieuwe commits krijgt'],
  'recipe.github.checksFailed': ['checks fail on a pull request', 'controles mislukken op een pull request'],
  'recipe.github.comments': [' and comments on GitHub', ' en reageert op GitHub'],
  'recipe.github': [
    'When {when} on {repo}, {does} in {room}{comments}{fix}.',
    'Als {when} in {repo}, {does} in {room}{comments}{fix}.',
  ],
  'recipe.fix': [' and fixes what it found', ' en lost op wat hij vond'],
  'recipe.message.words': [' with {words}', ' met {words}'],
  'recipe.message': [
    'When someone posts{words} in {room}, {does} in a thread.',
    'Als iemand iets plaatst{words} in {room}, {does} in een thread.',
  ],
  'recipe.schedule': ['{schedule}: {does} in {room}.', '{schedule}: {does} in {room}.'],
  'recipe.manual': ['When someone starts it, {does} in {room}.', 'Als iemand het start, {does} in {room}.'],
  'recipe.tracker.item.report': ['report', 'melding'],
  'recipe.tracker.item.bug': ['bug report', 'bugmelding'],
  'recipe.tracker.item.feature': ['feature request', 'functieverzoek'],
  'recipe.tracker.writesBack': [
    'writes the assessment back to {product}',
    'schrijft de beoordeling terug naar {product}',
  ],
  'recipe.tracker.replies': ['replies to the customer', 'antwoordt de klant'],
  'recipe.tracker.features': ['asks you about feature requests', 'vraagt je naar functieverzoeken'],
  'recipe.tracker': [
    'When a new {item} arrives in {connection}, {does} in {room}{also}{fix}.',
    'Als er een nieuwe {item} binnenkomt in {connection}, {does} in {room}{also}{fix}.',
  ],
  'recipe.tracker.unknown': ['a tracker connection', 'een trackerkoppeling'],
  'recipe.mail': [
    'When mail arrives in {mailbox}, {does} in {room}.',
    'Als er mail binnenkomt in {mailbox}, {does} in {room}.',
  ],
  'recipe.mail.yours': ['your inbox', 'je inbox'],
});
