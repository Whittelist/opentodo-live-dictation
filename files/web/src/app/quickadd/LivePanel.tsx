// The live dictation's panel (fork: voice-live, the Todoist Ramble behaviour):
// what it hears, and the tasks it drafted, each with a way to take it out.
// Nothing is saved until Add (or saying "eso es todo"); Discard drops them.
// Shown under the quick add field while the microphone is on and while drafts
// wait. Loaded lazily with the first dictation, so the first load of the app
// carries none of it.
import { useEffect, useRef } from 'react'
import { t } from '../../lib/i18n'
import { describeDue } from '../../lib/dates'
import { priorityShort } from '../../lib/priority'
import type { LabelRef, ProjectRef } from '../../lib/nlp'
import type { SessionTask, VoiceSessionView } from '../../lib/voice/voiceSession'
import { Button, Icon } from '../../ui'

/** What the panel needs from the dictation: its state and its actions. */
export interface LivePanelVoice {
  live: VoiceSessionView
  closeLive: () => void
  undo: (id: string) => void
  add: () => Promise<void>
}

/** The status line's words and dot for each state of the live dictation. */
function liveStatus(status: VoiceSessionView['status'], drafts: number): { label: string; dot: string } {
  switch (status) {
    case 'starting':
    case 'connecting':
      return { label: t('Connecting…'), dot: 'bg-faint' }
    case 'listening':
      return { label: t('Listening'), dot: 'bg-accent' }
    case 'speaking':
      return { label: t('Hearing you…'), dot: 'bg-danger animate-pulse motion-reduce:animate-none' }
    case 'thinking':
      return { label: t('Thinking…'), dot: 'bg-warning animate-pulse motion-reduce:animate-none' }
    case 'adding':
      return { label: t('Saving…'), dot: 'bg-accent animate-pulse motion-reduce:animate-none' }
    default:
      return { label: drafts > 0 ? t('Paused') : t('Dictation stopped'), dot: 'bg-faint' }
  }
}

export default function LivePanel({ voice, projects, labels }: { voice: LivePanelVoice; projects: readonly ProjectRef[]; labels: readonly LabelRef[] }) {
  const { live } = voice
  const drafts = live.tasks.filter((task) => !task.deleted)
  const active = live.status !== 'idle'
  // A long dictation scrolls inside the panel, so Add stays on screen (the phone's
  // sheet, the pinned quick add row); the newest draft is the one in view.
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight
  }, [drafts.length])
  if (!active && drafts.length === 0 && !live.message) {
    return <span className="sr-only" role="status" aria-live="polite" data-voice-status>{live.announcement}</span>
  }
  const { label, dot } = liveStatus(live.status, drafts.length)
  const words = live.interim || live.heard
  const adding = live.status === 'adding'
  return (
    <section className="mx-1 mt-1.5 mb-2 rounded-card border border-default bg-sunken px-3 py-2 text-meta" aria-label={t('Live dictation')} data-voice-live data-voice-live-status={live.status}>
      <span className="sr-only" role="status" aria-live="polite" data-voice-status>{live.announcement}</span>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <span className="flex-1 font-medium text-default" data-voice-state>{label}</span>
        {drafts.length === 0 && (
          <button type="button" className="touch-target inline-flex items-center justify-center rounded-control p-1 text-muted hover:bg-raised" aria-label={active ? t('Stop dictation') : t('Close')} onClick={voice.closeLive} data-voice-close>
            <Icon name="x" size="xs" />
          </button>
        )}
      </div>
      {words && <p className={`mt-1 line-clamp-2 italic ${live.interim ? 'text-default' : 'text-muted'}`} data-voice-heard>«{words}»</p>}
      {active && drafts.length === 0 && !words && (
        <p className="mt-1 text-muted" data-voice-hint>{t('Say your tasks one after another; to change one, just say so. Say “that’s all” to add them.')}</p>
      )}
      {drafts.length > 0 && (
        <ul ref={list} className="mt-2 max-h-[40dvh] space-y-1 overflow-y-auto overscroll-contain" data-voice-tasks data-scroll-y>
          {drafts.map((task) => <LiveTaskRow key={task.id} task={task} projects={projects} labels={labels} onRemove={adding ? undefined : () => voice.undo(task.id)} />)}
        </ul>
      )}
      {live.message && <p className="mt-1.5 text-on-warning-soft" data-voice-message>{live.message}</p>}
      {drafts.length > 0 && (
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={adding} onClick={voice.closeLive} data-voice-discard>{t('Discard')}</Button>
          <Button variant="primary" size="sm" busy={adding} onClick={voice.add} data-voice-add>
            {t('{n, plural, one {Add # task} other {Add # tasks}}', { n: drafts.length })}
          </Button>
        </div>
      )}
    </section>
  )
}

function LiveTaskRow({ task, projects, labels, onRemove }: { task: SessionTask; projects: readonly ProjectRef[]; labels: readonly LabelRef[]; onRemove?: () => void }) {
  const due = describeDue(task.due)
  const project = task.projectId ? projects.find((p) => p.id === task.projectId)?.name : undefined
  const names = task.labelIds.map((id) => labels.find((l) => l.id === id)?.name).filter((n): n is string => !!n)
  const meta = !!due || !!task.recurrence || !!task.deadline || !!project || names.length > 0 || task.priority < 4 || task.changes > 0
  return (
    <li className="flex items-start gap-2 rounded-control bg-surface px-2 py-1.5" data-voice-task>
      <Icon name="circle" size="xs" className="mt-0.5 shrink-0 text-faint" />
      <span className="min-w-0 flex-1">
        <span className="block text-body text-default" data-voice-task-title>{task.title}</span>
        {meta && <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted">
          {due && <span data-voice-task-due>{due.label}</span>}
          {task.recurrence && <span className="inline-flex items-center gap-0.5"><Icon name="repeat" size="xs" />{t('Repeats')}</span>}
          {task.deadline && <span>{t('Deadline')} {describeDue({ date: task.deadline })?.day}</span>}
          {project && <span className="inline-flex items-center gap-0.5"><Icon name="folder" size="xs" />{project}</span>}
          {names.map((n) => <span key={n}>@{n}</span>)}
          {task.priority < 4 && <span className="inline-flex items-center gap-0.5"><Icon name="flag" size="xs" />{priorityShort(task.priority)}</span>}
          {task.changes > 0 && <span className="font-medium text-accent" data-voice-task-changed>{t('Changed')}</span>}
        </span>}
      </span>
      {onRemove && (
        <button type="button" className="touch-target inline-flex shrink-0 items-center justify-center rounded-control p-1 text-faint hover:bg-raised hover:text-muted" aria-label={t('Remove')} onClick={onRemove} data-voice-task-remove>
          <Icon name="x" size="xs" />
        </button>
      )}
    </li>
  )
}
