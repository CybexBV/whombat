import { MEMORY_TEXT } from '@whombat/client';
import { useAgentNotes, useBootstrap, useSetAgentNotes } from '@whombat/client/react';
import { formatDate, memoryUsageText, notesCopy } from '@whombat/core';
import { AGENT_NOTES_MAX } from '@whombat/core/domain';
import { useEffect, useId, useState } from 'react';
import { writeProblem } from '../../app/problem';
import { LoadErrorNote } from '../../app/runtime';
import { SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import type { SettingsTabProps } from '../agent/settings/AgentTab';
import settings from '../agent/settings/AgentTab.module.css';
import { SaveBar } from '../agent/settings/SaveBar';
import { useDraft } from '../agent/settings/useDraft';
import own from './MemoryEntries.module.css';

/**
 * Settings → Agent → **Notes** (Whombat hermes-engine.md HE-39; contracts 0.125 CT-1205, 3.0 CT-1581; app AP-5225,
 * one-person.md AP-5697; was the agent's own notes, RA-21, AP-682): one text the person writes — how things are set up,
 * what to keep in mind — that the agent reads in every chat. The contracts' intro, NOTES with the characters used of
 * 1,500 beside it, then the text in the page's textarea, saved with the part's sticky save bar (an empty text clears
 * it); under it when it changed last. Not in the mocks: the settings page's rows.
 */
export function NotesTab({ burrow, profile, onDirtyChange }: SettingsTabProps) {
  const ids = useId();
  const { agent } = profile;
  const copy = notesCopy(agent.name);
  const toast = useToast();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const { data, error, refetch } = useAgentNotes({ params: { burrow } });
  const save = useSetAgentNotes(burrow);
  const [notice, setNotice] = useState<string | null>(null);
  const form = useDraft<{ text: string }>(data ? { text: data.text } : null);
  const timeZone = bootstrap?.preferences.timeZone ?? bootstrap?.burrow.timeZone ?? 'Europe/Amsterdam';
  useEffect(() => onDirtyChange(form.dirty), [form.dirty, onDirtyChange]);

  const text = form.draft?.text ?? '';
  const used = [...text.replace(/\r\n?/g, '\n').trim()].length;
  const over = used > AGENT_NOTES_MAX;
  const changed = data?.updatedAt != null ? formatDate(data.updatedAt, timeZone, { now: Date.now() }) : null;

  async function onSave() {
    if (!form.draft || over) return;
    setNotice(null);
    try {
      const result = await save.mutateAsync({ params: { burrow }, body: { text: form.draft.text } });
      if (result.status !== 'ok') return setNotice(MEMORY_TEXT.failed);
      form.saved(() => ({ text: result.data.text }));
      form.edit(() => ({ text: result.data.text }));
      toast.show(MEMORY_TEXT.notesSaved);
    } catch (e) {
      setNotice(writeProblem(e));
    }
  }

  return (
    <>
      <p className={own.tabIntro}>{copy.intro}</p>
      <div className={settings.group}>
        <div className={own.groupHead}>
          <SectionLabel id={`${ids}-label`}>{copy.title}</SectionLabel>
          {data && (
            <span className={own.usage} id={`${ids}-usage`}>
              {memoryUsageText(used, data.limit)}
            </span>
          )}
        </div>
        {!data ? (
          error ? (
            <LoadErrorNote error={error} message={MEMORY_TEXT.loadFailed} onRetry={() => void refetch()} />
          ) : (
            <SkeletonRows count={2} lines={1} />
          )
        ) : (
          <div className={settings.field}>
            <textarea
              className={settings.textarea}
              aria-labelledby={`${ids}-label`}
              aria-describedby={changed ? `${ids}-usage ${ids}-changed` : `${ids}-usage`}
              aria-invalid={over ? true : undefined}
              rows={6}
              value={text}
              placeholder={copy.placeholder}
              onChange={(e) => form.edit(() => ({ text: e.target.value }))}
            />
            {changed ? (
              <p className={settings.hint} id={`${ids}-changed`}>
                <span className={own.notesMeta}>{`Changed ${changed}`}</span>
              </p>
            ) : null}
          </div>
        )}
      </div>
      <SaveBar
        dirty={form.dirty}
        saving={save.isPending}
        notice={notice}
        onSave={onSave}
        onDiscard={() => {
          setNotice(null);
          form.discard();
        }}
      />
    </>
  );
}
