// Live recogniser (fork: voice-live, the Todoist Ramble behaviour). The
// microphone stays open to OpenAI's realtime API over WebRTC for the whole
// dictation; OpenAI cuts the speech into phrases where the person pauses
// (semantic turn detection) and transcribes each one, and this module hands
// the phrases on in the order they were spoken.
//
// Unlike the recorder in serverRecognition.ts there is no AudioContext, no
// volume threshold and no gap between phrases: the phone's own WebRTC stack
// (echo cancellation, noise suppression, automatic gain) carries the audio and
// the end of a phrase is decided by OpenAI's detector, which works the same
// with background noise and on iOS. The session descriptions go through the
// OpenTodo server (POST /api/v1/voice/live), which adds the key; the audio
// goes from this browser to OpenAI and nowhere else.
//
// Opening the connection takes a second or two, and people start talking as
// soon as they tap. What they say meanwhile is recorded here (the pre-roll) and
// transcribed once through the server's speech route when the connection is
// up: it goes before the first phrase when they were still talking, or as a
// phrase of its own when they had finished. The live phrases wait for it.
import { api, ApiError, isNetworkError } from '../api'
import type { VoiceErrorKind } from './recognition'
import { recordingType } from './serverRecognition'

export type LiveState = 'connecting' | 'listening' | 'speaking' | 'transcribing'

export interface LiveCallbacks {
  onState(state: LiveState): void
  /** The words of the phrase being transcribed, as they arrive. */
  onInterim(text: string): void
  /** A finished phrase (never empty), in speaking order. */
  onPhrase(text: string): void
  onError(kind: VoiceErrorKind, raw: string): void
  /** Called once when the session is over, after the last phrase. */
  onEnd(): void
}

export interface LiveSession {
  /**
   * Turn the microphone off. A phrase still being said is closed and its text
   * is delivered before onEnd (within a few seconds).
   */
  stop(): void
}

/** How long a stopped session waits for the text of its last phrases. */
export const DRAIN_MS = 6000
/** The pre-roll goes on this long after the connection opens, so no word falls between the two. */
export const PREROLL_OVERLAP_MS = 250
/** The longest wait for the pre-roll's text. */
export const PREROLL_WAIT_MS = 6000
/** Speech that OpenAI hears starting this early in the stream was going on when it connected. */
export const CONTINUED_MS = 700

export interface LiveDeps {
  win?: unknown
  connect?: (sdp: string, language: string) => Promise<{ sdp: string }>
  /** Transcribes the pre-roll (POST /api/v1/voice/transcribe). */
  transcribe?: (audio: Blob, language: string, seconds: number) => Promise<{ text: string }>
}

interface ServerEvent {
  type: string
  item_id?: string
  delta?: string
  transcript?: string
  audio_start_ms?: number
  error?: { code?: string; message?: string }
}

type PeerLike = Pick<RTCPeerConnection, 'addTrack' | 'createDataChannel' | 'createOffer' | 'setLocalDescription' | 'setRemoteDescription' | 'close' | 'connectionState'> & {
  onconnectionstatechange: ((ev: Event) => void) | null
}

interface RecorderLike {
  state: string
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstop: (() => void) | null
  start(): void
  stop(): void
}
type RecorderCtor = (new (stream: MediaStream, opts?: { mimeType?: string }) => RecorderLike) & { isTypeSupported?: (t: string) => boolean }

/** What a failed exchange means for the person: the service refused, or there is no connection. */
function connectError(err: unknown): [VoiceErrorKind, string] {
  if (err instanceof ApiError) return ['service', err.code]
  if (isNetworkError(err)) return ['unavailable', 'network']
  return ['unavailable', err instanceof Error ? err.name : String(err)]
}

/** Whether a transcript says anything (two letters or digits at least). */
const says = (text: string) => /[\p{L}\p{N}]{2,}/u.test(text)

const bare = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/**
 * The pre-roll and the first live phrase as one. Both heard the moment the
 * connection opened, so the words at the seam may come twice ("Mañana tenemos"
 * + "Tenemos una reunión"): they are kept once, as the pre-roll wrote them. The
 * pre-roll may also cut its last word short ("tenemos un" + "Tenemos una"): after
 * a whole word in common, the live phrase's full word wins.
 */
export function joined(prefix: string, text: string): string {
  const a = prefix.trim().split(/\s+/)
  const b = text.trim().split(/\s+/)
  if (!text.trim()) return prefix.trim()
  for (let n = Math.min(4, a.length, b.length); n > 0; n--) {
    const tail = a.slice(-n).map(bare)
    const head = b.slice(0, n).map(bare)
    const same = tail.slice(0, -1).every((w, i) => w !== '' && w === head[i])
    const whole = tail[n - 1] !== '' && tail[n - 1] === head[n - 1]
    const cut = n > 1 && tail[n - 1].length >= 2 && head[n - 1].startsWith(tail[n - 1])
    if (same && (whole || cut)) {
      const seam = whole ? a[a.length - 1].replace(/[.,;:…]+$/u, '') : b[n - 1]
      return [...a.slice(0, -1), seam, ...b.slice(n)].join(' ')
    }
  }
  return `${prefix.trim()} ${text.trim()}`
}

export function startLive(opts: { lang?: string } & LiveCallbacks, deps: LiveDeps = {}): LiveSession {
  const w = (deps.win ?? globalThis) as { RTCPeerConnection?: new () => PeerLike; MediaRecorder?: RecorderCtor; navigator?: Navigator }
  const connect = deps.connect ?? api.voiceLive
  const transcribe = deps.transcribe ?? api.transcribe
  const language = (opts.lang ?? '').split('-')[0].toLowerCase()
  let pc: PeerLike | null = null
  let channel: RTCDataChannel | null = null
  let stream: MediaStream | null = null
  let ended = false
  let stopping = false
  let speaking = false
  // A stop in mid-phrase asked OpenAI to close that phrase; its commit is still to come.
  let closing = false
  let drain: ReturnType<typeof setTimeout> | undefined
  // Committed phrases in speaking order, and the text of each once known (null: nothing usable).
  const order: string[] = []
  const texts = new Map<string, string | null>()
  const partial = new Map<string, string>()
  // The pre-roll: what was said while the connection opened.
  let recorder: RecorderLike | null = null
  let preroll: 'off' | 'recording' | 'transcribing' | 'ready' = 'off'
  let prerollText = ''
  let prefix = ''
  let firstSpeech: number | null = null

  const end = () => {
    if (ended) return
    ended = true
    clearTimeout(drain)
    if (recorder?.state === 'recording') {
      recorder.onstop = null
      try { recorder.stop() } catch { /* gone */ }
    }
    try { channel?.close() } catch { /* already closed */ }
    try { pc?.close() } catch { /* already closed */ }
    stream?.getTracks().forEach((tr) => tr.stop())
    opts.onEnd()
  }
  const fail = (kind: VoiceErrorKind, raw: string) => {
    if (ended) return
    opts.onError(kind, raw)
    end()
  }
  const settled = () => stopping && !speaking && !closing && order.length === 0 && preroll === 'off'
  /** Hands on every phrase whose text is known and that no earlier phrase is waiting for. */
  const flush = () => {
    if (ended) return
    // What was said while connecting comes first.
    if (preroll === 'recording' || preroll === 'transcribing') return
    if (preroll === 'ready') {
      preroll = 'off'
      if (says(prerollText)) {
        const continued = firstSpeech !== null && firstSpeech <= CONTINUED_MS && (speaking || closing || order.length > 0)
        if (continued) prefix = prerollText
        else opts.onPhrase(prerollText)
      }
    }
    while (order.length && texts.has(order[0])) {
      const id = order.shift()!
      let text = texts.get(id)?.trim() ?? ''
      texts.delete(id)
      partial.delete(id)
      if (prefix) {
        text = joined(prefix, text)
        prefix = ''
      }
      if (text) opts.onPhrase(text)
    }
    if (prefix && stopping && !speaking && !closing && order.length === 0) {
      opts.onPhrase(prefix)
      prefix = ''
    }
    if (settled()) end()
    else if (!speaking && order.length === 0 && preroll === 'off') opts.onState('listening')
  }
  const remember = (id: string | undefined) => {
    if (id && !order.includes(id) && !texts.has(id)) order.push(id)
  }
  const onEvent = (ev: ServerEvent) => {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        speaking = true
        if (firstSpeech === null) firstSpeech = ev.audio_start_ms ?? 0
        if (!stopping) opts.onState('speaking')
        break
      case 'input_audio_buffer.speech_stopped':
        speaking = false
        opts.onState('transcribing')
        break
      case 'input_audio_buffer.committed':
        speaking = false
        closing = false
        remember(ev.item_id)
        break
      case 'conversation.item.input_audio_transcription.delta':
        if (ev.item_id && ev.delta) {
          const next = (partial.get(ev.item_id) ?? '') + ev.delta
          partial.set(ev.item_id, next)
          opts.onInterim(next)
        }
        break
      case 'conversation.item.input_audio_transcription.completed':
        remember(ev.item_id)
        if (ev.item_id) texts.set(ev.item_id, ev.transcript ?? '')
        flush()
        break
      case 'conversation.item.input_audio_transcription.failed':
        remember(ev.item_id)
        if (ev.item_id) texts.set(ev.item_id, null)
        flush()
        break
      case 'error':
        // Most errors leave the session open; a session that cannot go on
        // closes its channel. The commit of a stop with nothing left to close
        // (OpenAI had closed the phrase already) answers with one.
        if (ev.error?.code === 'session_expired') fail('service', 'session_expired')
        else if (closing) {
          closing = false
          flush()
        }
        break
    }
  }

  /** Starts recording what is said until the connection is up. */
  const startPreroll = (mic: MediaStream) => {
    const Rec = w.MediaRecorder
    if (!Rec) return
    try {
      const type = recordingType(Rec)
      const rec = new Rec(mic, type ? { mimeType: type } : undefined)
      const chunks: Blob[] = []
      const startedAt = Date.now()
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      rec.onstop = () => {
        const seconds = (Date.now() - startedAt) / 1000
        const audio = new Blob(chunks, { type: (rec.mimeType || type || 'audio/webm').split(';')[0] })
        if (!audio.size || seconds < 0.3) {
          preroll = 'off'
          flush()
          return
        }
        preroll = 'transcribing'
        const settle = (text: string) => {
          if (preroll !== 'transcribing') return
          clearTimeout(wait)
          prerollText = text.trim()
          preroll = 'ready'
          flush()
        }
        const wait = setTimeout(() => settle(''), PREROLL_WAIT_MS)
        transcribe(audio, language, seconds).then((r) => settle(r.text ?? ''), () => settle(''))
      }
      rec.start()
      recorder = rec
      preroll = 'recording'
    } catch {
      recorder = null
      preroll = 'off'
    }
  }
  const stopPreroll = () => {
    if (recorder?.state !== 'recording') return
    try {
      recorder.stop()
    } catch {
      preroll = 'off'
      flush()
    }
  }

  const session: LiveSession = {
    stop() {
      if (ended || stopping) return
      stopping = true
      // The microphone goes off now; what was already said is still transcribed.
      stopPreroll()
      stream?.getTracks().forEach((tr) => tr.stop())
      const open = channel?.readyState === 'open'
      if (!open && preroll === 'off') { end(); return }
      if (open && speaking) {
        try {
          channel!.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
          closing = true
        } catch { /* closing anyway */ }
        speaking = false
      }
      drain = setTimeout(end, DRAIN_MS)
      flush()
    },
  }

  const Ctor = w.RTCPeerConnection
  const media = w.navigator?.mediaDevices
  if (!Ctor || !media?.getUserMedia) {
    opts.onError('unavailable', 'unsupported')
    end()
    return session
  }
  opts.onState('connecting')
  void (async () => {
    let mic: MediaStream
    try {
      mic = await media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch (err) {
      const name = (err as { name?: string })?.name ?? 'error'
      fail(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'no-microphone' : 'unavailable', name)
      return
    }
    // Stopped while the browser asked for the microphone: let it go at once.
    if (stopping || ended) {
      mic.getTracks().forEach((tr) => tr.stop())
      end()
      return
    }
    stream = mic
    startPreroll(mic)
    try {
      const peer = new Ctor()
      pc = peer
      for (const track of mic.getAudioTracks()) peer.addTrack(track, mic)
      const dc = peer.createDataChannel('oai-events')
      channel = dc
      dc.onopen = () => {
        if (ended || stopping) return
        opts.onState('listening')
        setTimeout(stopPreroll, PREROLL_OVERLAP_MS)
      }
      dc.onmessage = (e: MessageEvent) => {
        let ev: ServerEvent
        try { ev = JSON.parse(String(e.data)) as ServerEvent } catch { return }
        onEvent(ev)
      }
      dc.onclose = () => { if (stopping) end(); else fail('unavailable', 'closed') }
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed') fail('unavailable', 'connection_failed')
      }
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      const { sdp } = await connect(offer.sdp ?? '', language)
      if (ended) return
      await peer.setRemoteDescription({ type: 'answer', sdp })
    } catch (err) {
      fail(...connectError(err))
    }
  })()
  return session
}
