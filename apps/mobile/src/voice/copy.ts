import { fillVoiceWords, VOICE_TEXT, type VoiceSectionView, voiceSectionView } from '@whombat/client/voice';
import { type VoiceTyping, voiceWords } from '@whombat/core/domain';
import { mobileTranslator } from '../i18n/translate';

const extraErrors = [
  'changed',
  'elsewhere',
  'interrupted',
  'inUse',
  'needsUpdate',
  'notSaved',
  'setting',
] as const;

export function localizedVoiceError(message: string, locale: string): string {
  const words = voiceWords(locale);
  const key = (Object.keys(words.errors) as Array<keyof typeof words.errors>).find(
    (name) => VOICE_TEXT.errors[name] === message,
  );
  if (key) return words.errors[key];
  const extra = extraErrors.find((name) => VOICE_TEXT.errors[name] === message);
  return extra ? mobileTranslator(locale).t(`voice.error.${extra}`) : message;
}

export function localizedVoiceView(voice: VoiceTyping, locale: string): VoiceSectionView {
  const view = voiceSectionView(voice);
  const words = voiceWords(locale);
  const status = (state: keyof typeof words.states, progress: number | null) =>
    fillVoiceWords(words.states[state], { percent: Math.floor((progress ?? 0) * 100) });
  const dutch = view.dutchVoice;
  const rawDutch = voice.dutchVoice;
  return {
    ...view,
    on: { ...view.on, title: words.on.label, meta: words.on.meta },
    model: {
      ...view.model,
      title: words.model.label,
      options: view.model.options.map((option) => ({
        ...option,
        label: words.model.choices[option.value],
      })),
      uses: view.model.uses && voice.uses ? words.model.uses[voice.uses] : null,
      warning: view.model.warning ? words.model.slow : null,
    },
    language: {
      ...view.language,
      title: words.language.label,
      options: view.language.options.map((option) => ({
        ...option,
        label: words.language.choices[option.value],
      })),
    },
    models: {
      title: words.models.label,
      rows: view.models.rows.map((row) => {
        const model = voice.models.find((item) => item.id === row.id);
        return {
          ...row,
          ...words.models[row.id],
          status: status(row.state, row.progress),
          problem: row.problem && model?.problem ? words.problems[model.problem] : null,
          action: row.action ? { ...row.action, label: words.actions[row.action.kind] } : null,
        };
      }),
    },
    dutchVoice:
      dutch && rawDutch
        ? {
            ...dutch,
            title: words.dutchVoice.label,
            meta: fillVoiceWords(words.dutchVoice.meta, { size: dutch.size }),
            status:
              dutch.state === 'removing' ? words.dutchVoice.removing : status(dutch.state, dutch.progress),
            problem: dutch.problem && rawDutch.problem ? words.problems[rawDutch.problem] : null,
            retryLabel: dutch.retryLabel ? words.actions.retry : null,
            dialog: {
              ...words.dutchVoice.dialog,
              intro: fillVoiceWords(words.dutchVoice.dialog.intro, { size: dutch.size }),
            },
          }
        : null,
    gpu: voice.gpu ? fillVoiceWords(words.gpu.found, { name: voice.gpu.name }) : words.gpu.none,
  };
}
