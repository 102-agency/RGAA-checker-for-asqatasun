import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checks } from '../src/themes/07-scripts.ts'
import { type Bench, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
})
afterAll(async () => {
  await bench.stop()
})

const DIR = '07-scripts'
const messages = (failures: { message: string }[] | undefined) =>
  (failures ?? []).map((failure) => failure.message).join('\n')

describe('Thématique 7 — scripts', () => {
  it('des composants corrects n’ont pas d’échec (la restitution reste à valider)', async () => {
    const page = await bench.audit(checks, `${DIR}/ok.html`)
    expect(page['7.1.1']?.status, JSON.stringify(page['7.1.1']?.failures)).toBe('C')
    expect(page['7.1.3']?.status, JSON.stringify(page['7.1.3']?.failures)).toBe('C')
    expect(page['7.1.2']?.status).toBe('AV')
    expect(page['7.3.1']?.status).toBe('NA')
    expect(page['7.3.2']?.status).toBe('C')
    expect(page['7.5.1']?.status, JSON.stringify(page['7.5.1'])).toBe('C')
    expect(page['7.5.2']?.status).toBe('C')
  })

  it('relève les erreurs ARIA et un nom qui omet l’intitulé visible', async () => {
    const page = await bench.audit(checks, `${DIR}/aria-ko.html`)
    expect(page['7.1.1']?.status).toBe('NC')
    const text = messages(page['7.1.1']?.failures)
    expect(text).toContain('aria-required-attr')
    expect(text).toContain('aria-roles')
    expect(text).toContain('aria-valid-attr-value')
    expect(messages(page['7.1.3']?.failures)).toContain('Valider la commande')
  })

  it('un écouteur de clic sans accès clavier est un échec, un simple curseur « main » est jugé', async () => {
    const page = await bench.audit(checks, `${DIR}/clics.html`)
    expect(page['7.3.1']?.status).toBe('NC')
    const failed = messages(page['7.3.1']?.failures)
    expect(failed).toContain('Carte cliquable avec onclick')
    expect(failed).not.toContain('Bouton accessible')
    expect(failed).not.toContain('Carte avec lien')
    expect((page['7.3.1']?.pending ?? []).map((item) => item.evidence.element)).toEqual([
      'Faux lien sans écouteur visible',
    ])
  })

  it('relève le focus retiré par un script', async () => {
    const page = await bench.audit(checks, `${DIR}/focus.html`)
    expect(page['7.3.2']?.status).toBe('NC')
    expect(page['7.3.2']?.failureCount).toBe(1)
    expect(messages(page['7.3.2']?.failures)).toContain('Piège')
  })

  it('soumet au jugement un changement de contexte à la sélection', async () => {
    const page = await bench.audit(checks, `${DIR}/contexte.html`)
    expect(page['7.4.1']?.status).toBe('AV')
    expect(page['7.4.1']?.pending[0]?.evidence.evenement).toBe('onchange')
  })

  it('relève les messages de statut sans rôle ou avec un mauvais rôle', async () => {
    const page = await bench.audit(checks, `${DIR}/statuts.html`)
    expect(page['7.5.2']?.pending[0]?.evidence.texte).toContain('mot de passe')
    expect(page['7.5.1']?.status, JSON.stringify(page['7.5.1'])).toBe('C') // toast aria-live polite
  })

  it('une alternative <noscript> est soumise au jugement', async () => {
    const page = await bench.audit(checks, `${DIR}/noscript.html`)
    expect(page['7.2.1']?.status).toBe('AV')
    expect(page['7.2.1']?.pending[0]?.evidence.noscript).toContain('Activez JavaScript')
  })
})
