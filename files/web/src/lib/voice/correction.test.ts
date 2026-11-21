import { describe, expect, it } from 'vitest'
import {
  capitalize,
  inferAfternoon,
  isCorrection,
  mentionsDate,
  mergeTitle,
  normalizeSpokenClock,
  shiftHour,
  stripCorrection,
} from './correction'

describe('normalizeSpokenClock', () => {
  it('turns "y media" into a clock time', () => {
    expect(normalizeSpokenClock('a las tres y media')).toBe('a las 3:30')
  })
  it('turns "y cuarto" into a clock time', () => {
    expect(normalizeSpokenClock('a las cinco y cuarto')).toBe('a las 5:15')
  })
  it('turns "menos cuarto" into the previous hour', () => {
    expect(normalizeSpokenClock('a las cinco menos cuarto')).toBe('a las 4:45')
  })
  it('leaves digits and plain words alone', () => {
    expect(normalizeSpokenClock('a las 3')).toBe('a las 3')
    expect(normalizeSpokenClock('reunion manana a las tres')).toBe('reunion manana a las 3')
  })
})

describe('inferAfternoon', () => {
  it('reads a bare 3 as the afternoon', () => {
    expect(inferAfternoon(3, 'a las 3')).toBe(15)
  })
  it('keeps the morning when the phrase says so', () => {
    expect(inferAfternoon(3, 'a las 3 de la manana')).toBe(3)
  })
  it('keeps 8 and later alone', () => {
    expect(inferAfternoon(8, 'a las 8')).toBe(8)
  })
  it('shifts a clock string', () => {
    expect(shiftHour('03:30', 'a las 3:30')).toBe('15:30')
  })
})

describe('isCorrection', () => {
  it('recognises "no"', () => {
    expect(isCorrection('no, a las tres y media')).toBe(true)
  })
  it('recognises other openers', () => {
    expect(isCorrection('mejor el jueves')).toBe(true)
    expect(isCorrection('en realidad es con Marcos')).toBe(true)
  })
  it('does not treat a new task as a correction', () => {
    expect(isCorrection('comprar pan el viernes')).toBe(false)
  })
  it('strips the opener', () => {
    expect(stripCorrection('no, a las tres y media')).toBe('a las tres y media')
    expect(stripCorrection('perdona, el jueves')).toBe('el jueves')
  })
})

describe('mergeTitle', () => {
  it('adds the spoken tail without the leading "y"', () => {
    expect(mergeTitle('Reunion', 'y con mi amigo Marcos')).toBe('Reunion con mi amigo Marcos')
  })
  it('drops the verb "es"', () => {
    expect(mergeTitle('Reunion', 'es con Marcos')).toBe('Reunion con Marcos')
  })
  it('keeps the title when nothing is added', () => {
    expect(mergeTitle('Reunion', '')).toBe('Reunion')
  })
})

describe('mentionsDate', () => {
  it('is false for a time-only correction', () => {
    expect(mentionsDate('a las tres y media')).toBe(false)
  })
  it('is true when a day is named', () => {
    expect(mentionsDate('mejor el jueves')).toBe(true)
    expect(mentionsDate('pasado manana')).toBe(true)
  })
})

describe('capitalize', () => {
  it('uppercases the first letter only', () => {
    expect(capitalize('reunion con marcos')).toBe('Reunion con marcos')
  })
})
