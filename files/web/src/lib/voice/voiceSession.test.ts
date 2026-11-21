// The live dictation (fork: voice-live): phrases become draft tasks or change
// the dictation's own drafts, in speaking order; nothing is saved until Add
// (or "eso es todo"), which saves them in one go through the host; the local
// parser takes a phrase the interpreter cannot read; the session stops itself.
import { describe, expect, it } from 'vitest'
import type { VoiceAction, VoiceInterpretRequest } from '../types'
import type { QuickAddInput } from '../nlp'
import { flush } from './fakeRecognition'
import type { LiveCallbacks, LiveSession } from './live'
import { createVoiceSession, IDLE_MS, LIVE_MESSAGES, type LocalReading, type SessionTask, type VoiceSessionView } from './voiceSession'

const action = (a: Partial<VoiceAction>): VoiceAction => ({
  type: 'create', ref: null, title: null, date: null, time: null, deadline: null, recurrence: null, project: null, labels: null, priority: null, clear: [], ...a,
})

function setup(opts: {
  shareNames?: boolean
  interpret?: (req: VoiceInterpretRequest) => Promise<{ actions: VoiceAction[] }>
  fallback?: (text: string, last: SessionTask | null) => LocalReading | null
  addAll?: (inputs: QuickAddInput[]) => Promise<void>
  /** false: the session hands on a last phrase after stop, and ends when the test says. */
  endOnStop?: boolean
} = {}) {
  const log = { batches: [] as QuickAddInput[][], fallback: [] as [string, string | null][], requests: [] as VoiceInterpretRequest[], added: 0 }
  const views: VoiceSessionView[] = []
  let cb: ({ lang?: string } & LiveCallbacks) | null = null
  let stops = 0
  let epoch = 1
  let clock = new Date(2026, 10, 21, 16, 5)
  let tick: () => void = () => {}
  const replies: VoiceAction[][] = []
  const session = createVoiceSession({
    lang: () => 'es-ES',
    projects: () => [{ id: 'p1', name: 'Trabajo' }, { id: 'p2', name: 'Viejo', archived: true }],
    labels: () => [{ id: 'l1', name: 'llamadas' }],
    shareNames: () => opts.shareNames ?? true,
    addAll: opts.addAll ?? (async (inputs) => { log.batches.push(inputs) }),
    fallback: async (text, last) => {
      log.fallback.push([text, last?.id ?? null])
      return opts.fallback ? opts.fallback(text, last) : { input: { title: text } }
    },
    added: () => { log.added++ },
    show: (v) => views.push(v),
  }, {
    allow: () => Promise.resolve(true),
    live: (o) => {
      cb = o
      const s: LiveSession = { stop: () => { stops++; if (opts.endOnStop !== false) o.onEnd() } }
      return s
    },
    interpret: opts.interpret ?? (async (req) => {
      log.requests.push(req)
      return { actions: replies.shift() ?? [] }
    }),
    now: () => clock,
    setInterval: (fn) => { tick = fn; return 1 as unknown as ReturnType<typeof setInterval> },
    clearInterval: () => {},
    epoch: () => epoch,
  })
  return {
    session, log, views, replies,
    live: () => cb!,
    view: () => views.at(-1)!,
    stops: () => stops,
    signOut: () => { epoch++ },
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); tick() },
  }
}

async function started(t: ReturnType<typeof setup>) {
  t.session.start()
  await flush()
  t.live().onState('listening')
  return t.live()
}

const titles = (v: VoiceSessionView) => v.tasks.filter((x) => !x.deleted).map((x) => x.title)

describe('createVoiceSession', () => {
  it('drafts the owner’s two phrases as one task, and saves nothing until Add', async () => {
    const t = setup()
    const live = await started(t)
    expect(t.view().status).toBe('listening')
    t.replies.push([action({ type: 'create', title: 'Reunión', date: '2026-11-22', time: '15:00' })])
    t.replies.push([action({ type: 'update', ref: 1, title: 'Reunión con mi amigo Marcos', time: '15:30' })])
    live.onPhrase('Mañana tenemos una reunión a las tres.')
    live.onPhrase('Ah, no, esa reunión es a las tres y media y es con mi amigo Marcos.')
    expect(t.view().status).toBe('thinking')
    await flush()
    await flush()
    expect(t.view().tasks).toHaveLength(1)
    expect(t.view().tasks[0]).toMatchObject({ title: 'Reunión con mi amigo Marcos', due: { date: '2026-11-22', time: '15:30' }, changes: 1 })
    expect(t.view().status).toBe('listening')
    expect(t.log.batches).toEqual([])
    // The second phrase was read with the first draft and phrase in hand.
    const second = t.log.requests[1]
    expect(second).toMatchObject({ text: 'Ah, no, esa reunión es a las tres y media y es con mi amigo Marcos.', language: 'es', now: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T16:05$/),
      previous: ['Mañana tenemos una reunión a las tres.'], projects: ['Trabajo'], labels: ['llamadas'] })
    expect(second.tasks).toEqual([{ title: 'Reunión', date: '2026-11-22', time: '15:00' }])

    await t.session.add()
    expect(t.stops()).toBe(1)
    expect(t.log.batches).toEqual([[{ title: 'Reunión con mi amigo Marcos', due: { date: '2026-11-22', time: '15:30' } }]])
    expect(t.log.added).toBe(1)
    expect(t.view()).toMatchObject({ status: 'idle', tasks: [], heard: '', announcement: '1 task added' })
  })

  it('maps names to ids, keeps the day when only the time changes, and leaves out what was taken back', async () => {
    const t = setup()
    const live = await started(t)
    t.replies.push([action({ title: 'Preparar la presentación', date: '2026-11-26', project: 'trabajo', labels: ['Llamadas', 'nada'], priority: 2 }),
      action({ title: 'Comprar pan' })])
    live.onPhrase('Preparar la presentación del jueves para Trabajo, con la etiqueta llamadas, importante, y comprar pan')
    await flush()
    expect(titles(t.view())).toEqual(['Preparar la presentación', 'Comprar pan'])
    t.replies.push([action({ type: 'update', ref: 1, time: '10:00', clear: ['labels'] }), action({ type: 'delete', ref: 2 })])
    live.onPhrase('A las diez, sin etiqueta, y olvida lo del pan')
    await flush()
    expect(t.view().tasks.map((x) => x.deleted)).toEqual([false, true])
    // A removed draft is still listed to the interpreter, marked, so the numbers do not move.
    live.onPhrase('vale')
    await flush()
    expect(t.log.requests.at(-1)!.tasks).toEqual([
      { title: 'Preparar la presentación', date: '2026-11-26', time: '10:00', project: 'Trabajo', priority: 2 },
      { title: 'Comprar pan', deleted: true },
    ])
    await t.session.add()
    expect(t.log.batches).toEqual([[{ title: 'Preparar la presentación', due: { date: '2026-11-26', time: '10:00' }, project_id: 'p1', priority: 2 }]])
  })

  it('adds the drafts when the person says that is all, after the phrase’s other operations', async () => {
    const t = setup()
    const live = await started(t)
    t.replies.push([action({ title: 'Llamar a Lucía', date: '2026-11-26' })])
    t.replies.push([action({ title: 'Comprar pan' }), action({ type: 'finish' })])
    live.onPhrase('Llamar a Lucía el jueves.')
    live.onPhrase('Y comprar pan. Eso es todo.')
    for (let i = 0; i < 4; i++) await flush()
    expect(t.stops()).toBe(1)
    expect(t.log.batches).toEqual([[{ title: 'Llamar a Lucía', due: { date: '2026-11-26' } }, { title: 'Comprar pan' }]])
    expect(t.view()).toMatchObject({ status: 'idle', tasks: [] })
  })

  it('Add waits for the phrase the microphone hands on as it stops', async () => {
    const t = setup({ endOnStop: false })
    const live = await started(t)
    t.replies.push([action({ title: 'Comprar pan' })])
    t.replies.push([action({ title: 'Comprar leche' })])
    live.onPhrase('Comprar pan')
    await flush()
    const adding = t.session.add()
    await flush()
    expect(t.view().status).toBe('adding')
    expect(t.log.batches).toEqual([])
    live.onPhrase('Y comprar leche')
    live.onEnd()
    await adding
    expect(t.log.batches).toEqual([[{ title: 'Comprar pan' }, { title: 'Comprar leche' }]])
  })

  it('Discard drops the drafts, and the phrases still on their way', async () => {
    let answer: (v: { actions: VoiceAction[] }) => void = () => {}
    const t = setup({ endOnStop: false, interpret: () => new Promise((r) => { answer = r }) })
    const live = await started(t)
    live.onPhrase('Comprar pan')
    await flush()
    t.session.close()
    answer({ actions: [action({ title: 'Comprar pan' })] })
    live.onPhrase('Y leche')
    live.onEnd()
    await flush()
    await flush()
    expect(t.view().tasks).toEqual([])
    expect(t.view().status).toBe('idle')
    await t.session.add()
    expect(t.log.batches).toEqual([])
  })

  it('takes a draft out with the panel’s button', async () => {
    const t = setup()
    const live = await started(t)
    t.replies.push([action({ title: 'Llamar a mamá' }), action({ title: 'Comprar pan' })])
    live.onPhrase('Llamar a mamá y comprar pan')
    await flush()
    t.session.undo(t.view().tasks[0].id)
    expect(titles(t.view())).toEqual(['Comprar pan'])
    await t.session.add()
    expect(t.log.batches).toEqual([[{ title: 'Comprar pan' }]])
  })

  it('leaving the screen adds what was said, but never after a sign-out', async () => {
    const kept = setup()
    kept.replies.push([action({ title: 'Comprar pan' })])
    ;(await started(kept)).onPhrase('Comprar pan')
    await flush()
    kept.session.dispose()
    for (let i = 0; i < 3; i++) await flush()
    expect(kept.log.batches).toEqual([[{ title: 'Comprar pan' }]])
    expect(kept.log.added).toBe(0)

    const gone = setup()
    gone.replies.push([action({ title: 'Comprar pan' })])
    ;(await started(gone)).onPhrase('Comprar pan')
    await flush()
    gone.signOut()
    gone.session.dispose()
    for (let i = 0; i < 3; i++) await flush()
    expect(gone.log.batches).toEqual([])
  })

  it('keeps the drafts and says so when they cannot be added', async () => {
    const t = setup({ addAll: () => Promise.reject(new Error('too long to encrypt')) })
    const live = await started(t)
    t.replies.push([action({ title: 'Comprar pan' })])
    live.onPhrase('Comprar pan')
    await flush()
    await t.session.add()
    expect(t.view()).toMatchObject({ status: 'idle', message: LIVE_MESSAGES.failed })
    expect(titles(t.view())).toEqual(['Comprar pan'])
  })

  it('sends no project or label names under end-to-end encryption', async () => {
    const t = setup({ shareNames: false })
    const live = await started(t)
    live.onPhrase('Comprar pan')
    await flush()
    expect(t.log.requests[0]).toMatchObject({ projects: [], labels: [] })
  })

  it('without an answer the local parser drafts the phrase or corrects the last draft, and says so once', async () => {
    const t = setup({
      interpret: () => Promise.reject(new Error('offline')),
      fallback: (text, last) => (last && text.startsWith('no')) ? { patch: { due: { date: '2026-11-27' } } } : { input: { title: text } },
    })
    const live = await started(t)
    live.onPhrase('Comprar pan')
    await flush()
    live.onPhrase('no, mejor el viernes')
    await flush()
    expect(t.log.fallback).toEqual([['Comprar pan', null], ['no, mejor el viernes', 'd1']])
    expect(t.view().message).toBe(LIVE_MESSAGES.offline)
    expect(t.view().tasks).toHaveLength(1)
    expect(t.view().tasks[0]).toMatchObject({ title: 'Comprar pan', due: { date: '2026-11-27' }, changes: 1 })
  })

  it('pauses itself after a quiet spell, but not while a phrase is being read, and keeps the drafts', async () => {
    let answer: (v: { actions: VoiceAction[] }) => void = () => {}
    const t = setup({ interpret: () => new Promise((r) => { answer = r }) })
    const live = await started(t)
    live.onPhrase('Comprar pan')
    await flush()
    t.advance(IDLE_MS + 1000)
    expect(t.stops()).toBe(0)
    answer({ actions: [action({ title: 'Comprar pan' })] })
    await flush()
    t.advance(IDLE_MS + 1000)
    expect(t.stops()).toBe(1)
    expect(t.view().status).toBe('idle')
    expect(titles(t.view())).toEqual(['Comprar pan'])
    expect(t.log.batches).toEqual([])
  })

  it('shows why the microphone could not start, and is not left listening', async () => {
    const t = setup()
    t.session.start()
    await flush()
    t.live().onError('denied', 'NotAllowedError')
    t.live().onEnd()
    expect(t.view().status).toBe('idle')
    expect(t.view().message).toMatch(/Microphone access is blocked/)
    expect(t.session.status).toBe('idle')
  })
})
