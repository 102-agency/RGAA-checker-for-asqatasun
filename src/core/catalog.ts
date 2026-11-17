import { readJsonFile } from '../security/fs.ts'
import { Reader } from '../security/validate.ts'
import { ASSETS } from './paths.ts'
import type { CatalogTest } from './types.ts'

/**
 * Référentiel RGAA 4.1.2 (généré depuis le PDF officiel par `scripts/build-catalog.py`).
 * Chargé une fois, validé, puis indexé par test, critère et thématique.
 */
export interface Catalog {
  tests: readonly CatalogTest[]
  byTest: ReadonlyMap<string, CatalogTest>
  /** Intitulé de chaque critère (`1.1` → « Chaque image porteuse… »). */
  criteria: ReadonlyMap<string, { title: string; level: string; theme: number }>
  themes: ReadonlyMap<number, string>
}

const TEST_ID = /^\d{1,2}\.\d{1,2}\.\d{1,2}$/
const CRITERION_ID = /^\d{1,2}\.\d{1,2}$/

let cached: Catalog | undefined

export function parseCatalog(data: unknown, where = 'référentiel RGAA'): Catalog {
  const read = new Reader(where)
  const tests = read.array(data, 'racine', 1_000).map((item, index): CatalogTest => {
    const path = `[${index}]`
    const entry = read.record(item, path)
    return {
      theme: read.number(entry.theme, `${path}.theme`),
      themeLabel: read.string(entry.themeLabel, `${path}.themeLabel`, 200),
      criterion: read.matching(entry.criterion, CRITERION_ID, `${path}.criterion`, 'n.n'),
      criterionTitle: read.optionalString(entry.criterionTitle, `${path}.criterionTitle`),
      test: read.matching(entry.test, TEST_ID, `${path}.test`, 'n.n.n'),
      level: read.string(entry.level, `${path}.level`, 10),
      title: read.string(entry.title, `${path}.title`),
      particularCases: read.optionalString(
        entry.particularCases,
        `${path}.particularCases`,
        50_000,
      ),
      technicalNotes: read.optionalString(entry.technicalNotes, `${path}.technicalNotes`, 50_000),
    }
  })

  const byTest = new Map<string, CatalogTest>()
  const criteria = new Map<string, { title: string; level: string; theme: number }>()
  const themes = new Map<number, string>()
  for (const test of tests) {
    if (byTest.has(test.test)) read.fail(`test ${test.test} en double.`)
    byTest.set(test.test, test)
    if (!criteria.has(test.criterion)) {
      criteria.set(test.criterion, {
        title: test.criterionTitle ?? '',
        level: test.level,
        theme: test.theme,
      })
    }
    if (!themes.has(test.theme)) themes.set(test.theme, test.themeLabel)
  }
  return { tests, byTest, criteria, themes }
}

export function loadCatalog(): Catalog {
  cached ??= parseCatalog(readJsonFile(ASSETS.catalog), ASSETS.catalog)
  return cached
}

/** Ordre naturel des identifiants RGAA (`1.10.2` après `1.9.1`). */
export function compareIds(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/** Numéro du critère d'un test (`10.7.1` → `10.7`). */
export function criterionOf(test: string): string {
  return test.split('.').slice(0, 2).join('.')
}

/** Numéro de thématique d'un test ou d'un critère. */
export function themeOf(id: string): number {
  return Number(id.split('.')[0])
}
