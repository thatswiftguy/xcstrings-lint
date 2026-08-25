import type { CatalogAssessment } from './assess.js'
import type { LanguageCode, LanguageCoverage } from './types.js'

/**
 * Translated share per language, and the gate that compares it to a threshold.
 *
 * Two rules run this file, and both exist because of the same failure: a
 * percentage that says 100 when the catalog is not complete.
 *
 * 1. The percentage rounds *down*. 2999 of 3000 strings is 99.9666...%, and
 *    rounding that to the nearest tenth gives 100.0 -- a number no reader can
 *    distinguish from a finished translation.
 * 2. The gate never looks at the percentage at all. It compares the counts, so
 *    `threshold: 100` means "every string", not "a figure that rounds to 100".
 */

export function computeCoverage(
  assessments: CatalogAssessment[],
): Record<LanguageCode, LanguageCoverage> {
  const tally = new Map<LanguageCode, { translatable: number; translated: number }>()

  for (const assessment of assessments) {
    for (const language of assessment.targets) {
      if (!tally.has(language)) tally.set(language, { translatable: 0, translated: 0 })
    }
    for (const { pairs } of assessment.entries) {
      for (const pair of pairs) {
        const counts = tally.get(pair.language)
        if (!counts) continue
        counts.translatable++
        if (pair.complete) counts.translated++
      }
    }
  }

  const coverage: Record<LanguageCode, LanguageCoverage> = {}
  for (const [language, counts] of tally) {
    coverage[language] = {
      language,
      translatable: counts.translatable,
      translated: counts.translated,
      percent: percentOf(counts.translated, counts.translatable),
    }
  }
  return coverage
}

/** 0-100 to one decimal, rounded down. 100 only when nothing is outstanding. */
export function percentOf(translated: number, translatable: number): number {
  if (translatable === 0) return 100
  if (translated >= translatable) return 100
  return Math.floor((translated / translatable) * 1000) / 10
}

export interface ThresholdShortfall {
  language: string
  percent: number
  threshold: number
  translatable: number
  translated: number
}

export interface ThresholdOptions {
  /** Languages to gate on. Undefined means "every language we assessed". */
  required?: string[] | undefined
  /**
   * Every language that is a source language somewhere. A required language
   * that is only ever a source language has nothing to translate into, so
   * gating it would fail the run at 0% forever.
   */
  sourceLanguages?: Iterable<string>
}

/** Languages that do not reach the threshold. */
export function belowThreshold(
  coverage: Record<string, LanguageCoverage>,
  threshold: number,
  options: ThresholdOptions = {},
): ThresholdShortfall[] {
  const sourceLanguages = new Set(options.sourceLanguages ?? [])
  const languages = options.required ?? Object.keys(coverage)
  const shortfalls: ThresholdShortfall[] = []

  for (const language of languages) {
    const entry = coverage[language]

    if (!entry) {
      // Never assessed. Either it is the source language -- in which case there
      // is nothing to translate and nothing to report -- or the user named a
      // language no catalog has, which is worth saying out loud.
      if (sourceLanguages.has(language)) continue
      shortfalls.push({ language, percent: 0, threshold, translatable: 0, translated: 0 })
      continue
    }

    // Counts, not the rounded percentage. See the note at the top of the file.
    const meets =
      entry.translatable === 0 || (entry.translated / entry.translatable) * 100 >= threshold
    if (meets) continue

    shortfalls.push({
      language,
      percent: entry.percent,
      threshold,
      translatable: entry.translatable,
      translated: entry.translated,
    })
  }

  return shortfalls.sort((a, b) => a.percent - b.percent || a.language.localeCompare(b.language))
}
