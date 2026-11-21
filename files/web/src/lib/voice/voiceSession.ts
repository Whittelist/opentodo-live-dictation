// The live dictation of quick add (fork: voice-live, the Todoist Ramble
// behaviour). The phrases of the live recogniser become draft tasks, one
// phrase at a time and in speaking order: each phrase goes to the interpreter
// (POST /api/v1/voice/interpret) with the drafts so far, so "no, a las tres y
// media y con mi amigo Marcos" changes the meeting it just drafted instead of
// adding another. Nothing is saved while the person talks: the panel shows the
// drafts, and Add (or saying "eso es todo") saves them as one batch through
// quick add's own add, with the view's defaults. When the interpreter cannot
// answer, a phrase still becomes a draft through the local parser.
// Framework-free so it can be unit tested.
import type { LabelRef, ProjectRef, QuickAddInput } from '../nlp'
import type { Due, Priority, Task, VoiceAction, VoiceInterpretRequest, VoiceTaskWire } from '../types'
import { api } from '../api'
import { localEpoch } from '../db'
import { logicalToday } from '../dates'
import { t } from '../i18n'
import { allowMicrophone } from '../shell'
import { MESSAGES } from './dictation'
import type { VoiceErrorKind } from './recognition'
import { DRAIN_MS, type LiveCallbacks, type LiveSession, type LiveState, startLive } from './live'

/** A dictation stops itself after this long without speech, and at this length. */
export const IDLE_MS = 30_000
export const MAX_MS = 10 * 60_000

/** What quick add's input carries besides the fields the dictation reads and changes. */
type Extra = Omit<QuickAddInput, 'title' | 'due' | 'deadline' | 'recurrence' | 'project_id' | 'labels' | 'priority'>

/** A task of the dictation: a draft until the person adds them. */
export interface SessionTask {
  id: string
  title: string
  due: Due | null
  deadline: string | null
  recurrence: string | null
  projectId: string | null
  labelIds: string[]
  priority: Priority
  /** Taken out by voice or with the panel's button; kept so the interpreter's numbers do not move. */
  deleted: boolean
  /** How many times the dictation changed it after drafting it. */
  changes: number
  /** What the local parser read besides those fields (an estimate, "someday"…). */
  extra?: Extra
}

export type SessionStatus = 'idle' | 'starting' | 'connecting' | 'listening' | 'speaking' | 'thinking' | 'adding'

export interface VoiceSessionView {
  status: SessionStatus
  /** The words of the phrase being transcribed right now. */
  interim: string
  /** The last phrase heard. */
  heard: string
  /** The drafts of this dictation, in the order they were made. */
  tasks: SessionTask[]
  message: string | null
  /** Text for the polite live region. */
  announcement: string
}

export type TaskPatch = Partial<Pick<Task, 'title' | 'due' | 'deadline' | 'recurrence' | 'project_id' | 'labels' | 'priority'>>

/** The local parser's reading of a phrase: a new task, or a change to the latest draft. */
export type LocalReading = { input: QuickAddInput } | { patch: TaskPatch }

export interface VoiceSessionHost {
  lang(): string | undefined
  projects(): readonly ProjectRef[]
  labels(): readonly LabelRef[]
  /** Whether project and label names may go to the interpreter (not under end-to-end encryption). */
  shareNames(): boolean
  /** Saves the tasks the person confirmed: quick add's own add, with the view's defaults, as one batch where it can. */
  addAll(inputs: QuickAddInput[]): Promise<void>
  /** The local parser's reading of a phrase the interpreter could not read; `last` is the latest draft. */
  fallback(text: string, last: SessionTask | null): Promise<LocalReading | null>
  /** After the drafts were saved (the phone's sheet closes). */
  added?(): void
  show(view: VoiceSessionView): void
}

export interface VoiceSessionDeps {
  live: (opts: { lang?: string } & LiveCallbacks) => LiveSession
  interpret: (req: VoiceInterpretRequest) => Promise<{ actions: VoiceAction[] }>
  allow?: () => Promise<boolean>
  now?: () => Date
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval?: (id: ReturnType<typeof setInterval>) => void
  /** The local data's generation: a sign-out moves it on, and drafts made before it are never saved after. */
  epoch?: () => number
}

export const LIVE_MESSAGES = {
  get offline() { return t('The assistant did not answer, so the phrase was added as said. Corrections need it back.') },
  get limit() { return t('Stopped after 10 minutes. Tap the microphone to go on.') },
  get failed() { return t('The tasks could not be added. Try again.') },
}

export interface VoiceSession {
  start(): void
  /** Pauses: the microphone stops, the drafts stay. */
  stop(): void
  toggle(): void
  /** Takes a draft out (the panel's remove button). */
  undo(id: string): void
  /** Stops listening, waits for the last phrase and saves the drafts (Add, or "eso es todo"). */
  add(): Promise<void>
  /** Stops and drops the drafts (Discard). */
  close(): void
  readonly status: SessionStatus
  /** Unmounting: what was said is saved, not dropped, unless the account signed out since. */
  dispose(): void
}

const pad = (n: number) => String(n).padStart(2, '0')

function timeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

/** Resolves when `p` does, or after `ms` at the latest. */
function within(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms)
    void p.then(() => {
      clearTimeout(id)
      resolve()
    })
  })
}

/** The person's projects and labels: names to ids and back (live ones only). */
export interface Names {
  projectId(name: string | null): string | null
  labelIds(names: readonly string[] | null): string[]
  projectName(id: string | null): string | undefined
  labelName(id: string): string | undefined
  projects: string[]
  labels: string[]
}

export function namesOf(projects: readonly ProjectRef[], labels: readonly LabelRef[]): Names {
  const ps = projects.filter((p) => !p.deleted_at && !p.archived)
  const ls = labels.filter((l) => !l.deleted_at)
  const key = (s: string) => s.trim().toLowerCase()
  return {
    projectId: (name) => (name ? ps.find((p) => key(p.name) === key(name))?.id ?? null : null),
    labelIds: (names) => {
      const out: string[] = []
      for (const n of names ?? []) {
        const id = ls.find((l) => key(l.name) === key(n))?.id
        if (id && !out.includes(id)) out.push(id)
      }
      return out
    },
    projectName: (id) => (id ? ps.find((p) => p.id === id)?.name : undefined),
    labelName: (id) => ls.find((l) => l.id === id)?.name,
    projects: ps.map((p) => p.name),
    labels: ls.map((l) => l.name),
  }
}

/** A task as the interpreter reads it; names only when they may leave the device. */
export function wireOf(task: SessionTask, names: Names | null): VoiceTaskWire {
  const w: VoiceTaskWire = { title: task.title }
  if (task.due?.date) w.date = task.due.date
  if (task.due?.time) w.time = task.due.time
  if (task.deadline) w.deadline = task.deadline
  if (task.recurrence) w.recurrence = task.recurrence
  const project = names?.projectName(task.projectId)
  if (project) w.project = project
  const labels = names ? task.labelIds.map((id) => names.labelName(id)).filter((n): n is string => !!n) : []
  if (labels.length) w.labels = labels
  if (task.priority >= 1 && task.priority <= 3) w.priority = task.priority
  if (task.deleted) w.deleted = true
  return w
}

/** A create as quick add's input: only what the phrase set, so the view's defaults fill the rest. */
export function inputOf(a: VoiceAction, names: Names): QuickAddInput | null {
  if (!a.title) return null
  const input: QuickAddInput = { title: a.title }
  if (a.date) input.due = { date: a.date, ...(a.time ? { time: a.time } : {}) }
  if (a.deadline) input.deadline = a.deadline
  if (a.recurrence && input.due) input.recurrence = a.recurrence
  const pid = names.projectId(a.project)
  if (pid) input.project_id = pid
  const lids = names.labelIds(a.labels)
  if (lids.length) input.labels = lids
  if (a.priority && a.priority >= 1 && a.priority <= 3) input.priority = a.priority as Priority
  return input
}

/** A draft from quick add's input. */
export function draftOf(input: QuickAddInput, id: string): SessionTask {
  const { title, due, deadline, recurrence, project_id, labels, priority, ...extra } = input
  return {
    id, title, due: due ?? null, deadline: deadline ?? null, recurrence: recurrence ?? null,
    projectId: project_id ?? null, labelIds: labels ?? [], priority: priority ?? 4, deleted: false, changes: 0,
    ...(Object.keys(extra).length ? { extra } : {}),
  }
}

/** A draft as quick add's input: only what it has, so the view's defaults fill the rest. */
export function inputOfDraft(d: SessionTask): QuickAddInput {
  const input: QuickAddInput = { ...d.extra, title: d.title }
  if (d.due) input.due = d.due
  if (d.deadline) input.deadline = d.deadline
  if (d.recurrence && d.due) input.recurrence = d.recurrence
  if (d.projectId) input.project_id = d.projectId
  if (d.labelIds.length) input.labels = d.labelIds
  if (d.priority >= 1 && d.priority <= 3) input.priority = d.priority
  return input
}

/**
 * An update as a task patch: only the fields that change. A new time keeps the
 * task's day, a new day keeps its time; clearing the day clears the time.
 */
export function patchOf(task: SessionTask, a: VoiceAction, names: Names): TaskPatch {
  const patch: TaskPatch = {}
  if (a.title && a.title !== task.title) patch.title = a.title
  let date = task.due?.date ?? null
  let time = task.due?.time ?? null
  if (a.date) date = a.date
  if (a.time) time = a.time
  if (a.clear.includes('date')) { date = null; time = null }
  if (a.clear.includes('time')) time = null
  if (date !== (task.due?.date ?? null) || time !== (task.due?.time ?? null)) {
    patch.due = date ? { date, ...(time ? { time } : {}), ...(time && task.due?.tz ? { tz: task.due.tz } : {}) } : null
  }
  if (a.deadline) patch.deadline = a.deadline
  else if (a.clear.includes('deadline')) patch.deadline = null
  const due = 'due' in patch ? patch.due : task.due
  if (a.recurrence && due) patch.recurrence = a.recurrence
  else if (a.clear.includes('recurrence')) patch.recurrence = null
  const pid = names.projectId(a.project)
  if (pid && pid !== task.projectId) patch.project_id = pid
  else if (a.clear.includes('project') && task.projectId) patch.project_id = null
  if (a.labels) patch.labels = names.labelIds(a.labels)
  else if (a.clear.includes('labels')) patch.labels = []
  if (a.priority && a.priority >= 1 && a.priority <= 4) patch.priority = a.priority as Priority
  else if (a.clear.includes('priority')) patch.priority = 4
  return patch
}

/** The draft after a patch. */
function patched(task: SessionTask, patch: TaskPatch): SessionTask {
  return {
    ...task,
    title: patch.title ?? task.title,
    due: 'due' in patch ? patch.due ?? null : task.due,
    deadline: 'deadline' in patch ? patch.deadline ?? null : task.deadline,
    recurrence: 'recurrence' in patch ? patch.recurrence ?? null : task.recurrence,
    projectId: 'project_id' in patch ? patch.project_id ?? null : task.projectId,
    labelIds: patch.labels ?? task.labelIds,
    priority: patch.priority ?? task.priority,
    changes: task.changes + 1,
  }
}

/** The drafts after an operation, and what the live region says; null when nothing changes. */
type Drafted = { tasks: SessionTask[]; announce: string } | null

/** Draft `i` changed by `patch`. */
export function changeDraft(tasks: SessionTask[], i: number, patch: TaskPatch): Drafted {
  const task = tasks[i]
  if (!task || task.deleted || Object.keys(patch).length === 0) return null
  const next = patched(task, patch)
  return { tasks: tasks.map((x, j) => (j === i ? next : x)), announce: `${t('Changed')}: ${next.title}` }
}

/** The drafts after one operation of the interpreter (a finish changes none). */
export function applyAction(tasks: SessionTask[], a: VoiceAction, names: Names, id: () => string): Drafted {
  const i = (a.ref ?? 0) - 1
  if (a.type === 'create') {
    const input = inputOf(a, names)
    return input ? { tasks: [...tasks, draftOf(input, id())], announce: input.title } : null
  }
  if (a.type === 'update') return tasks[i] ? changeDraft(tasks, i, patchOf(tasks[i], a, names)) : null
  if (a.type === 'delete' && tasks[i] && !tasks[i].deleted) return { tasks: tasks.map((x, j) => (j === i ? { ...x, deleted: true } : x)), announce: '' }
  return null
}

/** What the interpreter reads for one phrase. */
function requestFor(text: string, tasks: SessionTask[], previous: string[], host: VoiceSessionHost, d: Date): VoiceInterpretRequest {
  const shared = host.shareNames() ? namesOf(host.projects(), host.labels()) : null
  return {
    text,
    language: (host.lang() ?? '').split('-')[0].toLowerCase(),
    now: `${logicalToday()}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
    timeZone: timeZone(),
    tasks: tasks.map((task) => wireOf(task, shared)),
    previous: previous.slice(-6),
    projects: shared?.projects ?? [],
    labels: shared?.labels ?? [],
  }
}

/** The panel's status from the microphone's state and the work in hand. */
function statusOf(s: { committing: boolean; listening: boolean; pending: number; live: LiveState | null }): SessionStatus {
  if (s.committing) return 'adding'
  if (!s.listening) return s.pending > 0 ? 'thinking' : 'idle'
  if (s.live === 'connecting') return 'connecting'
  if (s.live === 'speaking') return 'speaking'
  if (s.pending > 0 || s.live === 'transcribing') return 'thinking'
  return 'listening'
}

function errorMessage(e: { kind: VoiceErrorKind; raw: string }): string | null {
  switch (e.kind) {
    case 'no-speech':
    case 'aborted':
      return null
    case 'denied':
      return MESSAGES.denied
    case 'no-microphone':
      return MESSAGES.noMicrophone
    case 'service':
      return e.raw === 'stt_not_configured' ? MESSAGES.unavailable : MESSAGES.service
    default:
      return MESSAGES.unavailable
  }
}

export function createVoiceSession(host: VoiceSessionHost, given: Partial<VoiceSessionDeps> = {}): VoiceSession {
  const deps: VoiceSessionDeps = { live: startLive, interpret: api.voiceInterpret, ...given }
  const now = deps.now ?? (() => new Date())
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const cancel = deps.clearInterval ?? ((id) => clearInterval(id))
  const epochNow = deps.epoch ?? localEpoch
  let view: VoiceSessionView = { status: 'idle', interim: '', heard: '', tasks: [], message: null, announcement: '' }
  let session: LiveSession | null = null
  let liveState: LiveState | null = null
  // Resolves when the current session has ended: Add waits for its last phrase.
  let ending: Promise<void> = Promise.resolve()
  let pending = 0
  let chain: Promise<void> = Promise.resolve()
  let previous: string[] = []
  let disposed = false
  let round = 0
  let fellBack = false
  let ticker: ReturnType<typeof setInterval> | undefined
  let drafted = 0
  // Discard moves it on: the phrases said before are dropped, even those still on their way.
  let generation = 0
  // The local data's epoch when the first draft was made.
  let since: number | null = null
  let committing = false
  let adding: Promise<void> | null = null

  const set = (patch: Partial<VoiceSessionView>) => {
    view = { ...view, ...patch }
    if (!disposed) host.show(view)
  }
  const status = () => statusOf({ committing, listening: session !== null, pending, live: liveState })
  const refresh = () => set({ status: status() })
  const nextId = () => `d${++drafted}`

  /** The drafts after a change; the first draft notes the local data's epoch. */
  function put(next: Drafted) {
    if (!next) return
    if (since === null && next.tasks.some((x) => !x.deleted)) since = epochNow()
    set({ tasks: next.tasks, ...(next.announce ? { announcement: next.announce } : {}) })
  }

  function apply(a: VoiceAction) {
    // "Eso es todo" is Add. Not awaited: Add waits for this phrase to be applied.
    if (a.type === 'finish') void add()
    else put(applyAction(view.tasks, a, namesOf(host.projects(), host.labels()), nextId))
  }

  async function fallback(text: string, heardIn: number) {
    const i = view.tasks.map((x) => !x.deleted).lastIndexOf(true)
    const reading = await host.fallback(text, i >= 0 ? view.tasks[i] : null)
    if (heardIn !== generation) return
    if (reading && 'input' in reading && reading.input.title) put({ tasks: [...view.tasks, draftOf(reading.input, nextId())], announce: reading.input.title })
    else if (reading && 'patch' in reading) put(changeDraft(view.tasks, i, reading.patch))
    if (!fellBack) {
      fellBack = true
      set({ message: LIVE_MESSAGES.offline })
    }
  }

  async function handle(text: string, heardIn: number) {
    let actions: VoiceAction[] | null
    try {
      actions = (await deps.interpret(requestFor(text, view.tasks, previous, host, now()))).actions
    } catch {
      actions = null
    }
    if (heardIn !== generation) return
    previous = [...previous, text].slice(-12)
    if (actions === null) {
      await fallback(text, heardIn)
      return
    }
    for (const a of actions) apply(a)
  }

  function enqueue(text: string) {
    const heardIn = generation
    pending++
    set({ heard: text, interim: '', status: status() })
    chain = chain
      .then(() => (heardIn === generation ? handle(text, heardIn) : undefined))
      .catch(() => undefined)
      .finally(() => {
        pending--
        refresh()
      })
  }

  function listen() {
    let error: { kind: VoiceErrorKind; raw: string } | null = null
    let capped = false
    let ended = false
    // Set once deps.live returns: the recogniser may end before that (no WebRTC).
    let mine: LiveSession | null = null
    let tick: ReturnType<typeof setInterval> | undefined
    let endNow: () => void = () => {}
    const end = new Promise<void>((resolve) => { endNow = resolve })
    const heardIn = generation
    const startedAt = now().getTime()
    let lastActivity = startedAt
    // An older session still handing on its last phrases after a restart.
    const replaced = () => mine !== null && session !== mine
    liveState = 'connecting'
    const s = deps.live({
      lang: host.lang(),
      onState: (st) => {
        if (ended || replaced()) return
        const first = liveState === 'connecting' && st === 'listening'
        liveState = st
        if (st === 'speaking') lastActivity = now().getTime()
        if (first) set({ announcement: t('Listening') })
        refresh()
      },
      onInterim: (text) => { if (!replaced() && heardIn === generation) set({ interim: text }) },
      // A phrase counts even from a session that was replaced: it was said. Not after Discard.
      onPhrase: (text) => {
        if (heardIn !== generation) return
        lastActivity = now().getTime()
        enqueue(text)
      },
      onError: (kind, raw) => {
        if (!error) error = { kind, raw }
      },
      onEnd: () => {
        ended = true
        endNow()
        if (tick !== undefined) cancel(tick)
        if (replaced()) return
        session = null
        liveState = null
        const failure = error ? errorMessage(error) : null
        set({ status: status(), interim: '', message: failure ?? (capped ? LIVE_MESSAGES.limit : view.message), announcement: failure ?? t('Dictation stopped') })
      },
    })
    if (ended) return
    mine = s
    session = s
    ending = end
    tick = every(() => {
      if (session !== s) return
      const at = now().getTime()
      if (at - startedAt >= MAX_MS) {
        capped = true
        s.stop()
      } else if (liveState === 'listening' && pending === 0 && at - lastActivity >= IDLE_MS) {
        s.stop()
      }
    }, 1000)
    ticker = tick
    refresh()
  }

  function start() {
    if (session || disposed || committing || view.status === 'starting') return
    const mine = ++round
    set({ status: 'starting', message: null, interim: '' })
    void (deps.allow ?? allowMicrophone)().then((ok) => {
      if (disposed || mine !== round) return
      if (!ok) {
        set({ status: 'idle', message: MESSAGES.denied, announcement: MESSAGES.denied })
        return
      }
      listen()
    })
  }

  function stop() {
    round++
    if (session) session.stop()
    else if (view.status === 'starting') set({ status: 'idle' })
  }

  /** Empties the panel; `added` drafts were just saved. */
  function forget(added = 0) {
    previous = []
    fellBack = false
    since = null
    set({ tasks: [], heard: '', interim: '', message: null, ...(added ? { announcement: t('{n, plural, one {# task added} other {# tasks added}}', { n: added }) } : {}) })
  }

  async function commit() {
    refresh()
    const listening = session !== null
    const end = ending
    stop()
    // The last phrase may still be on its way: the session hands it on before it ends.
    if (listening) await within(end, DRAIN_MS + 2000)
    // Every phrase said before the end is read and applied first.
    for (let seen = chain; ; seen = chain) {
      await seen
      if (seen === chain) break
    }
    const ready = view.tasks.filter((x) => !x.deleted)
    // Signed out since: never written into the next account's data.
    if (ready.length && since !== null && epochNow() !== since) return forget()
    if (ready.length) {
      try {
        await host.addAll(ready.map(inputOfDraft))
      } catch {
        set({ message: LIVE_MESSAGES.failed })
        return
      }
    }
    forget(ready.length)
    if (ready.length && !disposed) host.added?.()
  }

  function add(): Promise<void> {
    if (adding) return adding
    committing = true
    adding = commit().finally(() => {
      committing = false
      adding = null
      refresh()
    })
    return adding
  }

  return {
    start,
    stop,
    toggle() {
      if (session || view.status === 'starting') stop()
      else start()
    },
    undo(id: string) {
      const i = view.tasks.findIndex((x) => x.id === id)
      if (i >= 0 && !committing) put({ tasks: view.tasks.map((x, j) => (j === i ? { ...x, deleted: true } : x)), announce: '' })
    },
    add,
    close() {
      if (committing) return
      generation++
      stop()
      forget()
    },
    get status() {
      return view.status
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (ticker !== undefined) cancel(ticker)
      // Unmounted (the sheet closed, another screen): what was said is saved, not dropped.
      if (session || pending > 0 || view.tasks.some((x) => !x.deleted)) void add()
    },
  }
}
