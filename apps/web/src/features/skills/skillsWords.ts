/**
 * The web's own words of Settings → Skills (app hermes-skills.md AP-5530…AP-5545; was AP-5230…AP-5234, all-skills.md
 * AP-2306…AP-2314); the words shared with the phone are the client's `SKILL_LIBRARY_TEXT` and `SKILL_HUB_TEXT`. Plain
 * and short, the product's curly quotes and middle dots; the agent's name always comes from data.
 */
export const SKILLS_WORDS = {
  show: 'Show',
  switchLabel: (skill: string, agent: string) => `${skill} for ${agent}`,
  loadError: (agent: string) => `Couldn’t load ${agent}’s skills. Try again in a moment.`,
  notChanged: 'That didn’t change. Try again in a moment.',

  /* The open skill. */
  close: 'Close',
  edit: 'Edit',
  files: 'FILES',
  cancel: 'Cancel',
  openError: 'Couldn’t open this skill. Try again in a moment.',
  fileError: 'Couldn’t open this file. Try again in a moment.',

  /* Edit. */
  description: 'DESCRIPTION',
  instructions: 'SKILL.md',
  write: 'Write',
  preview: 'Preview',
  editMode: 'Edit or preview',
  save: 'Save',
  saved: 'Saved.',
  marksChanged: 'Once saved, it shows as Changed; Restore Hermes’s brings the original back.',
  emptyBody: 'Write what the skill says first.',

  /* Compare: Hermes's against this one. */
  compareLegend: { del: 'Red: only in Hermes’s', add: 'green: only in this one' },
  same: 'They say the same.',
  otherFiles: 'OTHER FILES',
} as const;
