// Spoken corrections of the last task (voice-ramble-parity): what makes
// "no, a las tres y media y con Marcos" fix the previous task instead of creating
// another. Pure functions, no DOM, so they can be tested.
//
// It leaves the shared parser alone (web and Go share its vectors): it
// normalises the spoken text before it is parsed.

const NUMBER_WORDS: Record<string, number> = {
  una: 1, uno: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
}

/** Lower case and without accents, for comparing. */
export function plain(text: string): string {
  return text.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase()
}

/**
 * Spoken text ready for the parser: numbers as digits, and "y media", "y cuarto"
 * and "menos cuarto" as clock times.
 *
 *   "a las tres y media"  -> "a las 3:30"
 *   "a las cinco menos cuarto" -> "a las 4:45"
 */
export function normalizeSpokenClock(text: string): string {
  let out = text

  // "menos cuarto" before "y cuarto": it takes away, it does not add.
  out = out.replace(
    /\b(una|uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|\d{1,2})\s+menos\s+cuarto\b/gi,
    (_m, h: string) => {
      const hour = NUMBER_WORDS[plain(h)] ?? Number(h)
      if (!Number.isFinite(hour) || hour < 1) return _m
      const prev = hour === 1 ? 12 : hour - 1
      return `${prev}:45`
    },
  )

  out = out.replace(
    /\b(una|uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|\d{1,2})\s+y\s+(media|cuarto)\b/gi,
    (_m, h: string, part: string) => {
      const hour = NUMBER_WORDS[plain(h)] ?? Number(h)
      if (!Number.isFinite(hour)) return _m
      return `${hour}:${plain(part) === 'media' ? '30' : '15'}`
    },
  )

  // Number words still left ("a las tres", "el día tres").
  out = out.replace(/\b(una|uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/gi, (m) => {
    const n = NUMBER_WORDS[plain(m)]
    return n === undefined ? m : String(n)
  })

  return out
}

const MORNING = /\b(de la manana|por la manana|am|a\.m\.|madrugada)\b/
const EVENING = /\b(de la tarde|por la tarde|de la noche|por la noche|pm|p\.m\.)\b/

/**
 * "a las 3" in a spoken task is usually the afternoon: 15:00, not 03:00.
 * Only for the hours 1–7 without a morning or afternoon marker.
 */
export function inferAfternoon(hour: number, text: string): number {
  const t = plain(text)
  if (hour < 1 || hour > 7) return hour
  if (MORNING.test(t)) return hour
  if (EVENING.test(t)) return hour
  return hour + 12
}

/** `inferAfternoon` applied to an "HH:MM" time. */
export function shiftHour(time: string, text: string): string {
  const [h, m] = time.split(':').map(Number)
  if (!Number.isFinite(h)) return time
  const shifted = inferAfternoon(h, text)
  return `${String(shifted).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Words that open a correction of what was just said. */
const CORRECTION_MARKERS = [
  /^\s*no\b\s*,?\s*/,
  /^\s*no\s+es\s+asi\b\s*,?\s*/,
  /^\s*mejor\s+(dicho\s+)?/,
  /^\s*en\s+realidad\b\s*,?\s*/,
  /^\s*perdon\b\s*,?\s*/i,
  /^\s*perdona\b\s*,?\s*/,
  /^\s*espera\b\s*,?\s*/,
  /^\s*corrige\b\s*,?\s*/,
  /^\s*rectifica\b\s*,?\s*/,
  /^\s*cambia\b\s*/,
  /^\s*cambialo\b\s*,?\s*/,
  /^\s*quise\s+decir\b\s*,?\s*/,
]

/** Whether the phrase corrects the previous task. */
export function isCorrection(text: string): boolean {
  const t = plain(text)
  if (!t.trim()) return false
  // "no" counts as a correction only when something more than a yes follows.
  return CORRECTION_MARKERS.some((re) => re.test(t))
}

/** The phrase without the words that open the correction ("no, ..." -> "..."). */
export function stripCorrection(text: string): string {
  let out = text
  for (const re of CORRECTION_MARKERS) {
    const next = out.replace(re, '')
    if (next !== out) {
      out = next
      break
    }
  }
  return out.trim()
}

/** The old title joined with what the phrase adds ("y con Marcos" -> "… con Marcos"). */
export function mergeTitle(base: string, extra: string): string {
  const add = extra.replace(/^\s*(y|e|ademas|tambien|que)\b[\s,]*/i, '').trim()
  const clean = add.replace(/^[,.;:]+|[,.;:]+$/g, '').trim()
  if (!clean) return base
  if (!base) return clean
  // "es con X" -> "con X": the verb is not part of the title.
  const tail = clean.replace(/^(es|era|sera|son)\s+/i, '')
  return `${base.replace(/[.\s]+$/, '')} ${tail}`
}

/** The first character in upper case, the rest as it is. */
export function capitalize(text: string): string {
  const t = text.trim()
  if (!t) return t
  return t.charAt(0).toLocaleUpperCase() + t.slice(1)
}

const DATE_WORDS =
  /\b(hoy|manana|pasado|lunes|martes|miercoles|jueves|viernes|sabado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|el\s+\d{1,2})\b/

/**
 * Whether the phrase changes the day. If not, a correction of the time keeps the
 * date the task already had ("no, a las tres y media" does not move it to today).
 */
export function mentionsDate(text: string): boolean {
  return DATE_WORDS.test(plain(text))
}
