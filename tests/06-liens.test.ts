import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checks } from '../src/themes/06-liens.ts'
import { type Bench, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
})
afterAll(async () => {
  await bench.stop()
})

const DIR = '06-liens'
const messages = (failures: { message: string }[] | undefined) =>
  (failures ?? []).map((failure) => failure.message).join('\n')

describe('Thématique 6 — liens', () => {
  it('des liens explicites sont conformes, sans jugement en attente', async () => {
    const page = await bench.audit(checks, `${DIR}/ok.html`)
    for (const test of ['6.1.1', '6.1.2', '6.1.3', '6.1.4', '6.1.5', '6.2.1']) {
      expect(page[test]?.status, `${test} : ${JSON.stringify(page[test])}`).toBe('C')
    }
  })

  it('relève les liens sans intitulé et les noms qui omettent l’intitulé visible', async () => {
    const page = await bench.audit(checks, `${DIR}/ko.html`)
    expect(page['6.2.1']?.status).toBe('NC')
    expect(page['6.2.1']?.failureCount).toBe(2)
    expect(page['6.1.5']?.status).toBe('NC')
    // « Produit X : commander maintenant » contient l'intitulé ; « Commander produit X maintenant » non.
    const text = messages(page['6.1.5']?.failures)
    expect(text).toContain('Commander produit X maintenant')
    expect(text).toContain('Voir le tarif')
    expect(text).not.toContain('Produit X : commander maintenant')
  })

  it('soumet au jugement les intitulés génériques, bruts, homonymes ou symboliques', async () => {
    const page = await bench.audit(checks, `${DIR}/ko.html`)
    const asked = (page['6.1.1']?.pending ?? []).map((item) => item.evidence.intitule)
    expect(asked).toContain('Cliquez ici')
    expect(asked).toContain('https://example.org/page')
    expect(asked.filter((name) => name === 'Lire la suite')).toHaveLength(2)
    expect(page['6.1.1']?.status).toBe('AV')
    const symbol = (page['6.1.5']?.pending ?? []).map((item) => item.evidence.label)
    expect(symbol).toContain('×')
  })

  it('suit la décision enregistrée pour un lien générique', async () => {
    const evidence = {
      type: 'texte',
      intitule: 'Cliquez ici',
      destination: '/ici.html',
      contexte: '',
    }
    const refused = await bench.audit(checks, `${DIR}/ko.html`, {
      decisions: [{ topic: 'link.explicit', evidence, answer: 'fail' }],
    })
    expect(messages(refused['6.1.1']?.failures)).toContain('Cliquez ici')
  })

  it('les lettres doublées d’un effet (aria-hidden) ne se comparent pas au nom accessible', async () => {
    const page = await bench.audit(checks, `${DIR}/lettres-doublees.html`)
    expect(page['6.1.5']?.status, JSON.stringify(page['6.1.5'])).toBe('NA')
    expect(page['6.1.1']?.status).toBe('C')
  })
})
