/**
 * The skill library's wire shapes (Whombat hermes-skills.md HSK-01…HSK-13, hermes-engine.md HE-41; contracts 3.0
 * CT-1570…CT-1572, `api.skills.library*` and Hermes's hub: `hubSearch`, `hubPreview`, `hubInstall`, `hubUpdates`,
 * `hubUpdate`), under the names this client and the phone use (app hermes-skills.md AP-5520). Core's schemas,
 * re-exported; nothing is defined here.
 *
 * Every call is burrow-scoped. One skills list (the person's Hermes profile's `skills/`, CT-1570): a skill is keyed by
 * its name. Writes answer the row as it is now (`item`, null when none remains); an install or an update answers the
 * hub skill's row.
 */
import { api } from '@whombat/core/contracts';

export {
  LibrarySkillResponse as SkillLibrarySkill,
  SKILL_FILE_CHANGES,
  SkillCan,
  SkillFileChange,
  SkillFileSize as SkillLibraryFile,
  SkillHubInfo,
  SkillHubPreview,
  SkillHubResult,
  SkillHubSearchResponse,
  SkillHubUpdatesResponse,
  SkillLibraryItem,
  SkillLibraryResponse as SkillLibrary,
  SkillScan,
  SkillStatus,
} from '@whombat/core/contracts';
export {
  ScanFinding,
  ScanVerdict,
  SKILL_HUB_SOURCES,
  SKILL_TRUST_TEXT,
  SkillCategoryInfo,
  SkillHubSource,
  SkillNeeds,
  SkillOrigin,
  SkillTrust,
} from '@whombat/core/skills';

/** The library's endpoints under the client's short names. */
export const skillLibraryEndpoints = {
  library: api.skills.library,
  skill: api.skills.librarySkill,
  file: api.skills.librarySkillFile,
  edit: api.skills.libraryEdit,
  switch: api.skills.librarySwitch,
  remove: api.skills.libraryRemove,
  restore: api.skills.libraryRestore,
  hubSearch: api.skills.hubSearch,
  hubPreview: api.skills.hubPreview,
  hubInstall: api.skills.hubInstall,
  hubUpdates: api.skills.hubUpdates,
  hubUpdate: api.skills.hubUpdate,
} as const;
