import { describe, expect, it } from 'vitest'
import { loadCatalog } from '../src/core/catalog.ts'
import { allChecks } from '../src/themes/index.ts'

describe('Couverture du référentiel', () => {
  const catalog = loadCatalog()
  const declared = new Set(allChecks.flatMap((check) => check.tests))

  it('le référentiel compte les 258 tests du RGAA 4.1.2', () => {
    expect(catalog.tests).toHaveLength(258)
    expect(catalog.themes.size).toBe(13)
    expect(catalog.criteria.size).toBe(106)
  })

  it('chacun des 258 tests du référentiel est pris en charge par une vérification', () => {
    expect(
      catalog.tests.filter((test) => !declared.has(test.test)).map((test) => test.test),
    ).toEqual([])
  })

  it('aucune vérification ne déclare un test hors référentiel', () => {
    expect(Array.from(declared).filter((test) => !catalog.byTest.has(test))).toEqual([])
  })

  it('le catalogue n’a ni césure cassée (« sous- titres ») ni espace insécable parasite', () => {
    for (const test of catalog.tests) {
      for (const field of [
        test.title,
        test.criterionTitle,
        test.particularCases,
        test.technicalNotes,
      ]) {
        expect(field ?? '').not.toMatch(/\w- \w/)
      }
    }
  })

  it('chaque critère a un seul niveau, et les critères AA sont les 24 attendus', () => {
    const levels = new Map<string, Set<string>>()
    for (const test of catalog.tests) {
      levels.set(test.criterion, (levels.get(test.criterion) ?? new Set()).add(test.level))
    }
    expect(Array.from(levels.values()).every((set) => set.size === 1)).toBe(true)
    expect(Array.from(catalog.criteria.values()).filter((c) => c.level === 'AA')).toHaveLength(24)
    expect(catalog.criteria.get('11.4')?.level).toBe('AA')
    expect(catalog.criteria.get('7.3')?.level).toBe('A')
  })
})
