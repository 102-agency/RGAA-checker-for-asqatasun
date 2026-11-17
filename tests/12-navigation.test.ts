import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checks } from '../src/themes/12-navigation.ts'
import { type Bench, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
})
afterAll(async () => {
  await bench.stop()
})

const DIR = '12-navigation'
const messages = (failures: { message: string }[] | undefined) =>
  (failures ?? []).map((failure) => failure.message).join('\n')

describe('Thématique 12 — navigation (par page)', () => {
  it('une page avec lien d’évitement, repères et clavier cohérent est conforme', async () => {
    const page = await bench.audit(checks, `${DIR}/ok-a.html`)
    for (const test of ['12.6.1', '12.7.1', '12.8.1', '12.9.1']) {
      expect(page[test]?.status, `${test} : ${JSON.stringify(page[test])}`).toBe('C')
    }
  })

  it('relève l’absence de lien d’évitement et de repères', async () => {
    const page = await bench.audit(checks, `${DIR}/div-sans-reperes.html`)
    expect(page['12.6.1']?.status).toBe('NC')
    expect(messages(page['12.6.1']?.failures)).toContain('en-tête')
    expect(messages(page['12.6.1']?.failures)).toContain('pied de page')
  })

  it('détecte un piège au clavier', async () => {
    const page = await bench.audit(checks, `${DIR}/piege.html`)
    expect(page['12.9.1']?.status).toBe('NC')
    expect(messages(page['12.9.1']?.failures)).toContain('Piège au clavier')
  })

  it('soumet au jugement un menu qui ne s’ouvre qu’au survol, et accepte celui qui s’ouvre au focus', async () => {
    const ko = await bench.audit(checks, `${DIR}/survol.html`)
    expect(ko['12.11.1']?.status).toBe('AV')
    expect(ko['12.11.1']?.pending[0]?.evidence.declencheur).toBe('Rubrique')
    const ok = await bench.audit(checks, `${DIR}/survol-ok.html`)
    expect(ok['12.11.1']?.status, JSON.stringify(ok['12.11.1'])).toBe('C')
  })

  it('un plan du site dont un lien est mort est non conforme, et un intitulé douteux est soumis au jugement', async () => {
    const page = await bench.audit(checks, `${DIR}/plan-du-site.html`)
    expect(page['12.3.1']?.status).toBe('AV')
    expect(page['12.3.2']?.status).toBe('NC')
    expect(messages(page['12.3.2']?.failures)).toContain('« Mairie »')
    expect(page['12.3.3']?.pending.map((item) => item.evidence.intitule)).toContain('Contact')
  })

  it('les pages qui ne sont pas un plan du site sont sans objet pour 12.3', async () => {
    const page = await bench.audit(checks, `${DIR}/ok-a.html`)
    expect(page['12.3.1']?.status).toBe('NA')
  })
})

describe('Thématique 12 — navigation (ensemble de pages)', () => {
  it('deux pages cohérentes sont conformes', async () => {
    const pages = await bench.auditSite(checks, [`${DIR}/ok-a.html`, `${DIR}/ok-b.html`])
    for (const page of Object.values(pages)) {
      for (const test of [
        '12.1.1',
        '12.2.1',
        '12.4.1',
        '12.4.2',
        '12.4.3',
        '12.5.1',
        '12.5.2',
        '12.5.3',
        '12.7.2',
      ]) {
        expect(page[test]?.status, `${test} : ${JSON.stringify(page[test])}`).toBe('C')
      }
    }
  })

  it('relève un menu déplacé, une recherche et un plan du site absents, un lien d’évitement absent', async () => {
    const pages = await bench.auditSite(checks, [`${DIR}/ok-a.html`, `${DIR}/ko-b.html`])
    const ko = pages[`${DIR}/ko-b.html`] ?? {}
    expect(ko['12.2.1']?.status).toBe('NC')
    expect(messages(ko['12.2.1']?.failures)).toContain('pas à la même place')
    expect(messages(ko['12.2.1']?.failures)).toContain('ordre')
    expect(ko['12.4.1']?.status).toBe('NC')
    expect(ko['12.5.1']?.status).toBe('NC')
    expect(ko['12.7.1']?.status).toBe('NC')
    // La page de référence reste conforme : c'est l'autre qui s'écarte.
    expect(pages[`${DIR}/ok-a.html`]?.['12.2.1']?.status).toBe('C')
  })

  it('un seul page : les tests d’ensemble sont non applicables', async () => {
    const page = await bench.audit(checks, `${DIR}/ok-a.html`)
    expect(page['12.1.1']?.status).toBe('NA')
    expect(page['12.2.1']?.status).toBe('NA')
  })
})
