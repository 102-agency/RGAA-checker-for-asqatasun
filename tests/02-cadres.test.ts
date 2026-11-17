import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checks } from '../src/themes/02-cadres.ts'
import { type Bench, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
})
afterAll(async () => {
  await bench.stop()
})

describe('Thématique 2 — cadres', () => {
  it('sans cadre, les deux tests sont non applicables', async () => {
    const page = await bench.audit(checks, '08-elements-obligatoires/ok.html')
    expect(page['2.1.1']?.status).toBe('NA')
    expect(page['2.2.1']?.status).toBe('NA')
  })

  it('cadre sans title, title vide, title à juger', async () => {
    const page = await bench.audit(checks, '02-cadres/ko.html')
    expect(page['2.1.1']?.status).toBe('NC')
    expect(page['2.1.1']?.failures).toHaveLength(1)
    expect(page['2.2.1']?.status).toBe('NC')
    expect(page['2.2.1']?.failures[0]?.message).toContain('vide')
    // L'empreinte ignore la chaîne de requête du src.
    expect(page['2.2.1']?.pending[0]?.evidence).toEqual({
      title: 'Carte des mairies annexes',
      source: '/02-cadres/carte.html',
    })
  })
})
