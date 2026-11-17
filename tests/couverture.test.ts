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

  it('aucune vérification ne déclare un test hors référentiel', () => {
    expect(Array.from(declared).filter((test) => !catalog.byTest.has(test))).toEqual([])
  })
})
