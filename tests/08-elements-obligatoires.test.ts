import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checks } from '../src/themes/08-elements-obligatoires.ts'
import { type Bench, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
})
afterAll(async () => {
  await bench.stop()
})

const DIR = '08-elements-obligatoires'

describe('Thématique 8 — éléments obligatoires', () => {
  it('une page correcte est conforme, sans jugement en attente', async () => {
    const page = await bench.audit(checks, `${DIR}/ok.html`)
    for (const test of [
      '8.1.1',
      '8.1.2',
      '8.1.3',
      '8.2.1',
      '8.3.1',
      '8.4.1',
      '8.5.1',
      '8.6.1',
      '8.8.1',
      '8.9.1',
    ]) {
      expect(page[test]?.status, `${test} : ${JSON.stringify(page[test]?.failures)}`).toBe('C')
    }
    expect(page['8.7.1']?.status).toBe('C')
    expect(page['8.10.1']?.status).toBe('NA')
    expect(page['8.10.2']?.status).toBe('NA')
  })

  it('relève chaque défaut de la page fautive', async () => {
    const page = await bench.audit(checks, `${DIR}/ko.html`)
    expect(page['8.1.1']?.status).toBe('NC')
    expect(page['8.1.2']?.status).toBe('NA')
    expect(page['8.3.1']?.status).toBe('NC')
    expect(page['8.4.1']?.status).toBe('NA')
    expect(page['8.5.1']?.status).toBe('NC')
    expect(page['8.6.1']?.status).toBe('NA')
    expect(page['8.9.1']?.status).toBe('NC')
    expect(page['8.10.1']?.status).toBe('NC')
    expect(page['8.10.2']?.status).toBe('NC')

    const validity = page['8.2.1']?.failures.map((failure) => failure.message).join('\n') ?? ''
    expect(validity).toContain('id="titre"')
    expect(validity).toContain('duplicate-attribute')
    expect(validity).toContain('élément interactif <button>')

    const presentation = page['8.9.1']?.failures.map((failure) => failure.message).join('\n') ?? ''
    expect(presentation).toContain('<p> vide')
    expect(presentation).toContain('<br> consécutifs')
    expect(presentation).toContain('<center>')

    const changes = page['8.8.1']?.failures.map((failure) => failure.message).join('\n') ?? ''
    expect(changes).toContain('zz-invalide!')
    expect(changes).toContain('semble rédigé en « fr »')
  })

  it('un titre sans rapport avec le h1 attend un jugement, puis suit la décision', async () => {
    const evidence = { page: `/${DIR}/titre-a.html`, title: 'Ville témoin', h1: 'Première page' }
    const pending = await bench.audit(checks, `${DIR}/titre-a.html`)
    expect(pending['8.6.1']?.status).toBe('AV')
    expect(pending['8.6.1']?.pending[0]?.evidence).toEqual(evidence)

    const refused = await bench.audit(checks, `${DIR}/titre-a.html`, {
      decisions: [{ topic: 'page.title', evidence, answer: 'fail' }],
    })
    expect(refused['8.6.1']?.status).toBe('NC')

    const accepted = await bench.audit(checks, `${DIR}/titre-a.html`, {
      decisions: [{ topic: 'page.title', evidence, answer: 'pass' }],
    })
    expect(accepted['8.6.1']?.status).toBe('C')
  })

  it('deux pages qui partagent le même titre sont en échec', async () => {
    const site = await bench.auditSite(checks, [`${DIR}/titre-a.html`, `${DIR}/titre-b.html`])
    expect(site[`${DIR}/titre-a.html`]?.['8.6.1']?.status).toBe('NC')
    expect(site[`${DIR}/titre-b.html`]?.['8.6.1']?.status).toBe('NC')
  })
})
