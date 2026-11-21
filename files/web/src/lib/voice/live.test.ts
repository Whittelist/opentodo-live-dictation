// The live recogniser (fork: voice-live) against fakes of WebRTC and the
// server's relay: phrases in speaking order, the states, stopping without
// losing the last phrase, and the errors.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api'
import { flush } from './fakeRecognition'
import { DRAIN_MS, joined, type LiveCallbacks, type LiveState, PREROLL_OVERLAP_MS, startLive } from './live'

class FakeChannel {
  readyState = 'connecting'
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  send(d: string) { this.sent.push(JSON.parse(d)) }
  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
  }
  open() {
    this.readyState = 'open'
    this.onopen?.()
  }
  emit(ev: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(ev) }) }
}

class FakePeer {
  static last: FakePeer
  tracks: unknown[] = []
  channel!: FakeChannel
  label = ''
  remote: { type: string; sdp: string } | null = null
  closed = false
  connectionState = 'new'
  onconnectionstatechange: (() => void) | null = null
  constructor() { FakePeer.last = this }
  addTrack(track: unknown) { this.tracks.push(track) }
  createDataChannel(label: string) {
    this.label = label
    this.channel = new FakeChannel()
    return this.channel
  }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0 offer m=audio' }) }
  setLocalDescription() { return Promise.resolve() }
  setRemoteDescription(d: { type: string; sdp: string }) {
    this.remote = d
    return Promise.resolve()
  }
  close() {
    this.closed = true
    this.channel?.close()
  }
}

function mic() {
  const track = { stopped: false, stop() { this.stopped = true } }
  return { track, stream: { getAudioTracks: () => [track], getTracks: () => [track] } }
}

class FakeRecorder {
  static last: FakeRecorder | null = null
  static isTypeSupported = (t: string) => t === 'audio/webm;codecs=opus'
  state = 'inactive'
  mimeType = 'audio/webm;codecs=opus'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(public stream: unknown, public opts?: { mimeType?: string }) { FakeRecorder.last = this }
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(['opus'.repeat(50)], { type: 'audio/webm' }) })
      this.onstop?.()
    }, 0)
  }
}

function setup(opts: {
  getUserMedia?: () => Promise<unknown>
  connect?: (sdp: string, lang: string) => Promise<{ sdp: string }>
  noRTC?: boolean
  transcribe?: (audio: Blob, lang: string, seconds: number) => Promise<{ text: string }>
} = {}) {
  const m = mic()
  const calls: { sdp: string; lang: string }[] = []
  FakeRecorder.last = null
  const win = {
    RTCPeerConnection: opts.noRTC ? undefined : FakePeer,
    MediaRecorder: opts.transcribe ? FakeRecorder : undefined,
    navigator: { mediaDevices: { getUserMedia: opts.getUserMedia ?? (() => Promise.resolve(m.stream)) } },
  }
  const out = { states: [] as LiveState[], interim: [] as string[], phrases: [] as string[], errors: [] as string[], ended: 0 }
  const cb: LiveCallbacks = {
    onState: (s) => out.states.push(s),
    onInterim: (t) => out.interim.push(t),
    onPhrase: (t) => out.phrases.push(t),
    onError: (k, raw) => out.errors.push(`${k}:${raw}`),
    onEnd: () => { out.ended++ },
  }
  const connect = opts.connect ?? ((sdp: string, lang: string) => { calls.push({ sdp, lang }); return Promise.resolve({ sdp: 'v=0 answer' }) })
  return { m, win, out, cb, calls, connect, deps: { win, connect, transcribe: opts.transcribe } }
}

describe('startLive pre-roll (what is said while the connection opens)', () => {
  const spoken = (text: string) => {
    let answer: (v: { text: string }) => void = () => {}
    const calls: { type: string; lang: string; seconds: number }[] = []
    const transcribe = (audio: Blob, lang: string, seconds: number) => {
      calls.push({ type: audio.type, lang, seconds })
      return new Promise<{ text: string }>((r) => { answer = r })
    }
    return { transcribe, calls, answer: () => answer({ text }) }
  }

  it('goes before the first phrase when the person was still talking as it connected', async () => {
    vi.useFakeTimers()
    const said = spoken('Mañana tenemos una')
    const t = setup({ transcribe: said.transcribe })
    startLive({ lang: 'es-ES', ...t.cb }, t.deps)
    await vi.advanceTimersByTimeAsync(1500)
    expect(FakeRecorder.last?.state).toBe('recording')
    const ch = FakePeer.last.channel
    ch.open()
    ch.emit({ type: 'input_audio_buffer.speech_started', item_id: 'a', audio_start_ms: 120 })
    await vi.advanceTimersByTimeAsync(PREROLL_OVERLAP_MS + 10)
    expect(said.calls).toEqual([{ type: 'audio/webm', lang: 'es', seconds: expect.any(Number) }])
    expect(said.calls[0].seconds).toBeGreaterThan(1)
    ch.emit({ type: 'input_audio_buffer.committed', item_id: 'a' })
    ch.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'reunión a las tres.' })
    // The live phrase waits for what was said before it.
    expect(t.out.phrases).toEqual([])
    said.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.out.phrases).toEqual(['Mañana tenemos una reunión a las tres.'])
  })

  it('is a phrase of its own when the person had finished, and nothing when it says nothing', async () => {
    vi.useFakeTimers()
    const said = spoken('Comprar pan.')
    const t = setup({ transcribe: said.transcribe })
    startLive({ ...t.cb }, t.deps)
    await vi.advanceTimersByTimeAsync(1500)
    const ch = FakePeer.last.channel
    ch.open()
    await vi.advanceTimersByTimeAsync(PREROLL_OVERLAP_MS + 10)
    said.answer()
    await vi.advanceTimersByTimeAsync(0)
    ch.emit({ type: 'input_audio_buffer.speech_started', item_id: 'a', audio_start_ms: 2500 })
    ch.emit({ type: 'input_audio_buffer.committed', item_id: 'a' })
    ch.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Llamar a mamá.' })
    expect(t.out.phrases).toEqual(['Comprar pan.', 'Llamar a mamá.'])

    const quiet = spoken('')
    const q = setup({ transcribe: quiet.transcribe })
    startLive({ ...q.cb }, q.deps)
    await vi.advanceTimersByTimeAsync(1500)
    const ch2 = FakePeer.last.channel
    ch2.open()
    ch2.emit({ type: 'input_audio_buffer.speech_started', item_id: 'b', audio_start_ms: 50 })
    await vi.advanceTimersByTimeAsync(PREROLL_OVERLAP_MS + 10)
    quiet.answer()
    await vi.advanceTimersByTimeAsync(0)
    ch2.emit({ type: 'input_audio_buffer.committed', item_id: 'b' })
    ch2.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: 'Regar las plantas.' })
    expect(q.out.phrases).toEqual(['Regar las plantas.'])
  })

  it('keeps the words both heard at the seam once', () => {
    expect(joined('Mañana tenemos', 'Tenemos una reunión a las tres.')).toBe('Mañana tenemos una reunión a las tres.')
    expect(joined('El martes tengo...', 'Tengo una reunión con Miguel.')).toBe('El martes tengo una reunión con Miguel.')
    expect(joined('Llamar a mamá, y', 'y también comprar pan')).toBe('Llamar a mamá, y también comprar pan')
    expect(joined('Vale, a ver, el lunes', 'el lunes tengo que llamar')).toBe('Vale, a ver, el lunes tengo que llamar')
    expect(joined('Mañana tenemos una', 'reunión a las tres.')).toBe('Mañana tenemos una reunión a las tres.')
    expect(joined('Comprar pan', '')).toBe('Comprar pan')
    // A last word the pre-roll cut short, after a whole word in common.
    expect(joined('Mañana tenemos un', 'Tenemos una reunión a las tres.')).toBe('Mañana tenemos una reunión a las tres.')
    // A short word that only begins the next one is not a repeat.
    expect(joined('Llamar a la', 'lavandería mañana')).toBe('Llamar a la lavandería mañana')
    expect(joined('Comprar pan y', 'yogur')).toBe('Comprar pan y yogur')
  })

  it('a stop while connecting still delivers what was said, then ends', async () => {
    vi.useFakeTimers()
    const said = spoken('Llamar al dentista')
    const t = setup({ transcribe: said.transcribe, connect: () => new Promise(() => {}) })
    const s = startLive({ ...t.cb }, t.deps)
    await vi.advanceTimersByTimeAsync(1200)
    s.stop()
    expect(t.out.ended).toBe(0)
    await vi.advanceTimersByTimeAsync(0)
    said.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.out.phrases).toEqual(['Llamar al dentista'])
    expect(t.out.ended).toBe(1)
    expect(t.m.track.stopped).toBe(true)
  })
})

afterEach(() => vi.useRealTimers())

describe('startLive', () => {
  it('connects through the server with the offer and the language, and listens once the channel opens', async () => {
    const { m, win, out, cb, calls, connect } = setup()
    startLive({ lang: 'es-ES', ...cb }, { win, connect })
    await flush()
    const peer = FakePeer.last
    expect(calls).toEqual([{ sdp: 'v=0 offer m=audio', lang: 'es' }])
    expect(peer.remote).toEqual({ type: 'answer', sdp: 'v=0 answer' })
    expect(peer.tracks).toEqual([m.track])
    expect(peer.label).toBe('oai-events')
    peer.channel.open()
    expect(out.states).toEqual(['connecting', 'listening'])
  })

  it('hands on phrases in speaking order, skipping empty and failed ones', async () => {
    const { win, out, cb, connect } = setup()
    startLive({ lang: 'es', ...cb }, { win, connect })
    await flush()
    const ch = FakePeer.last.channel
    ch.open()
    ch.emit({ type: 'input_audio_buffer.speech_started', item_id: 'a' })
    ch.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'a' })
    ch.emit({ type: 'input_audio_buffer.committed', item_id: 'a' })
    ch.emit({ type: 'input_audio_buffer.committed', item_id: 'b' })
    ch.emit({ type: 'input_audio_buffer.committed', item_id: 'c' })
    ch.emit({ type: 'input_audio_buffer.committed', item_id: 'd' })
    // The second phrase is written down first; it waits for the first.
    ch.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: 'Y comprar' })
    ch.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: 'Y comprar pan.' })
    expect(out.phrases).toEqual([])
    ch.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: ' Mañana reunión a las tres. ' })
    expect(out.phrases).toEqual(['Mañana reunión a las tres.', 'Y comprar pan.'])
    ch.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'c', transcript: '' })
    ch.emit({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'd', error: { code: 'x' } })
    expect(out.phrases).toHaveLength(2)
    expect(out.interim).toEqual(['Y comprar'])
    expect(out.states).toEqual(['connecting', 'listening', 'speaking', 'transcribing', 'listening'])
    expect(out.errors).toEqual([])
  })

  it('stopping while speaking closes the phrase, turns the microphone off and waits for its text', async () => {
    const { m, win, out, cb, connect } = setup()
    const s = startLive({ ...cb }, { win, connect })
    await flush()
    const ch = FakePeer.last.channel
    ch.open()
    ch.emit({ type: 'input_audio_buffer.speech_started', item_id: 'a' })
    s.stop()
    expect(m.track.stopped).toBe(true)
    expect(ch.sent).toEqual([{ type: 'input_audio_buffer.commit' }])
    expect(out.ended).toBe(0)
    ch.emit({ type: 'input_audio_buffer.committed', item_id: 'a' })
    ch.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Llamar a mamá' })
    expect(out.phrases).toEqual(['Llamar a mamá'])
    expect(out.ended).toBe(1)
    expect(FakePeer.last.closed).toBe(true)
    expect(out.errors).toEqual([])
  })

  it('a stop whose commit finds nothing to close (OpenAI had closed the phrase) still ends after its text', async () => {
    const { win, out, cb, connect } = setup()
    const s = startLive({ ...cb }, { win, connect })
    await flush()
    const ch = FakePeer.last.channel
    ch.open()
    ch.emit({ type: 'input_audio_buffer.speech_started', item_id: 'a' })
    s.stop()
    ch.emit({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer too small' } })
    expect(out.ended).toBe(1)
    expect(out.errors).toEqual([])
  })

  it('a stop with nothing pending ends at once; a phrase that never comes ends after the wait', async () => {
    vi.useFakeTimers()
    const quiet = setup()
    const s1 = startLive({ ...quiet.cb }, { win: quiet.win, connect: quiet.connect })
    await vi.advanceTimersByTimeAsync(0)
    FakePeer.last.channel.open()
    s1.stop()
    expect(quiet.out.ended).toBe(1)

    const late = setup()
    const s2 = startLive({ ...late.cb }, { win: late.win, connect: late.connect })
    await vi.advanceTimersByTimeAsync(0)
    const ch = FakePeer.last.channel
    ch.open()
    ch.emit({ type: 'input_audio_buffer.committed', item_id: 'a' })
    s2.stop()
    expect(late.out.ended).toBe(0)
    await vi.advanceTimersByTimeAsync(DRAIN_MS)
    expect(late.out.ended).toBe(1)
  })

  it('reports a refused microphone, a refused relay and a dropped connection', async () => {
    const denied = setup({ getUserMedia: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })) })
    startLive({ ...denied.cb }, { win: denied.win, connect: denied.connect })
    await flush()
    expect(denied.out.errors).toEqual(['denied:NotAllowedError'])
    expect(denied.out.ended).toBe(1)

    const refused = setup({ connect: () => Promise.reject(new ApiError(409, 'stt_not_configured', 'no')) })
    startLive({ ...refused.cb }, { win: refused.win, connect: refused.connect })
    await flush()
    expect(refused.out.errors).toEqual(['service:stt_not_configured'])
    expect(refused.out.ended).toBe(1)
    expect(refused.m.track.stopped).toBe(true)

    const dropped = setup()
    startLive({ ...dropped.cb }, { win: dropped.win, connect: dropped.connect })
    await flush()
    FakePeer.last.channel.open()
    FakePeer.last.channel.close()
    expect(dropped.out.errors).toEqual(['unavailable:closed'])
    expect(dropped.out.ended).toBe(1)
  })

  it('without WebRTC it ends at once, and a stop while the browser asks for the microphone releases it', async () => {
    const none = setup({ noRTC: true })
    startLive({ ...none.cb }, { win: none.win, connect: none.connect })
    expect(none.out.errors).toEqual(['unavailable:unsupported'])
    expect(none.out.ended).toBe(1)

    let grant: (s: unknown) => void = () => {}
    const asking = setup({ getUserMedia: () => new Promise((r) => { grant = r }) })
    const s = startLive({ ...asking.cb }, { win: asking.win, connect: asking.connect })
    s.stop()
    expect(asking.out.ended).toBe(1)
    grant(asking.m.stream)
    await flush()
    expect(asking.m.track.stopped).toBe(true)
    expect(asking.calls).toEqual([])
  })
})
