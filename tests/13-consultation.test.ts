import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseGif } from '../src/lib/consultation.ts'
import { checks } from '../src/themes/13-consultation.ts'
import { type Bench, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
})
afterAll(async () => {
  await bench.stop()
})

const DIR = '13-consultation'
const messages = (failures: { message: string }[] | undefined) =>
  (failures ?? []).map((failure) => failure.message).join('\n')

describe('Thématique 13 — consultation', () => {
  it('une page sans animation ni limite de temps est conforme', async () => {
    const page = await bench.audit(checks, `${DIR}/ok.html`)
    expect(page['13.2.1']?.status).toBe('C')
    expect(page['13.9.1']?.status).toBe('C')
    for (const test of ['13.1.1', '13.1.2', '13.3.1', '13.5.1', '13.7.3', '13.8.1']) {
      expect(page[test]?.status, test).toBe('NA')
    }
  })

  it('relève un rafraîchissement et une redirection retardée', async () => {
    const refresh = await bench.audit(checks, `${DIR}/meta-refresh.html`)
    expect(refresh['13.1.1']?.status).toBe('NC')
    expect(messages(refresh['13.1.1']?.failures)).toContain('600 s')
    const redirect = await bench.audit(checks, `${DIR}/meta-redirect.html`)
    expect(redirect['13.1.2']?.status).toBe('NC')
    expect(messages(redirect['13.1.2']?.failures)).toContain('immédiate')
  })

  it('un effet de flash n’est fautif que sur une grande surface', async () => {
    const page = await bench.audit(checks, `${DIR}/flash.html`)
    expect(page['13.7.3']?.status).toBe('NC')
    expect(page['13.7.3']?.failureCount).toBe(1)
    expect(messages(page['13.7.3']?.failures)).toContain('px²')
  })

  it('soumet au jugement les mouvements et clignotements, et refuse <marquee>', async () => {
    const page = await bench.audit(checks, `${DIR}/mouvement.html`)
    const asked = (page['13.8.1']?.pending ?? []).map((item) => item.evidence.animation)
    expect(asked).toContain('s')
    expect((page['13.8.2']?.pending ?? []).map((item) => item.evidence.animation)).toContain('b')
    expect(page['13.8.1']?.status).toBe('NC')
    expect(messages(page['13.8.1']?.failures)).toContain('<marquee>')
  })

  it('lit un GIF animé et soumet son arrêt au jugement', async () => {
    const page = await bench.audit(checks, `${DIR}/gif.html`)
    expect(page['13.8.1']?.pending[0]?.evidence.boucle).toBe('oui')
    expect(
      parseGif(new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0, 0x3b]))?.frames,
    ).toBe(0)
  })

  it('soumet les documents au jugement avec l’état du balisage PDF', async () => {
    const page = await bench.audit(checks, `${DIR}/documents.html`)
    const asked = page['13.3.1']?.pending ?? []
    expect(asked).toHaveLength(2)
    const tagging = Object.fromEntries(
      asked.map((item) => [item.evidence.fichier, item.evidence.balisage]),
    )
    expect(tagging[`/${DIR}/balise.pdf`]).toBe('balisé')
    expect(tagging[`/${DIR}/non-balise.pdf`]).toBe('balisage non repéré')
    expect(page['13.4.1']?.pending).toHaveLength(1)
  })

  it('contenus cryptiques : un title est jugé, sans title il faut un contexte', async () => {
    const page = await bench.audit(checks, `${DIR}/cryptique.html`)
    expect(page['13.5.1']?.pending[0]?.evidence.contenu).toBe(':-)')
    expect(page['13.6.1']?.pending[0]?.evidence.title).toBe('sourire')
    const refused = await bench.audit(checks, `${DIR}/cryptique.html`, {
      decisions: [
        { topic: 'cryptic.context', evidence: { contenu: ':-)' }, answer: 'sans-definition' },
      ],
    })
    expect(messages(refused['13.5.1']?.failures)).toContain(':-)')
  })

  it('refuse une page qui n’affiche qu’une consigne en paysage', async () => {
    const page = await bench.audit(checks, `${DIR}/orientation.html`)
    expect(page['13.9.1']?.status).toBe('NC')
    expect(messages(page['13.9.1']?.failures)).toContain('tourner votre appareil')
  })

  it('relève les gestes, appuis et mouvements déclarés dans le code', async () => {
    const page = await bench.audit(checks, `${DIR}/gestes.html`)
    expect(page['13.10.2']?.status).toBe('AV')
    expect(page['13.11.1']?.status).toBe('AV')
    expect(page['13.12.1']?.status).toBe('AV')
    expect(page['13.12.3']?.status).toBe('AV')
  })

  it('relève une fenêtre ouverte sans action', async () => {
    const page = await bench.audit(checks, `${DIR}/popup.html`)
    expect(page['13.2.1']?.status).toBe('NC')
  })
})
