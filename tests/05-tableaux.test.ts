import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checks } from '../src/themes/05-tableaux.ts'
import { type Bench, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
})
afterAll(async () => {
  await bench.stop()
})

const DIR = '05-tableaux'
const messages = (failures: { message: string }[] | undefined) =>
  (failures ?? []).map((failure) => failure.message).join('\n')

describe('Thématique 5 — tableaux', () => {
  it('des tableaux corrects sont conformes', async () => {
    const page = await bench.audit(checks, `${DIR}/ok.html`)
    for (const test of [
      '5.3.1',
      '5.4.1',
      '5.5.1',
      '5.6.1',
      '5.6.2',
      '5.7.1',
      '5.7.2',
      '5.7.3',
      '5.7.4',
      '5.8.1',
    ]) {
      expect(page[test]?.status, `${test} : ${JSON.stringify(page[test])}`).toBe('C')
    }
    // Le tableau complexe a un résumé : sa pertinence reste à juger.
    expect(page['5.1.1']?.status).toBe('C')
    expect(page['5.2.1']?.status).toBe('AV')
  })

  it('relève les tableaux de données mal structurés', async () => {
    const page = await bench.audit(checks, `${DIR}/ko.html`)
    expect(messages(page['5.6.1']?.failures)).toContain('sans aucun en-tête')
    expect(messages(page['5.6.1']?.failures)).toContain('mis en gras')
    expect(page['5.4.1']?.status).toBe('NC')
    expect(messages(page['5.4.1']?.failures)).toContain('<caption> du tableau est vide')
    expect(messages(page['5.4.1']?.failures)).toContain('aria-labelledby')
    expect(messages(page['5.7.1']?.failures)).toContain('« Léa »')
    expect(messages(page['5.7.2']?.failures)).toContain('« Max »')
    expect(messages(page['5.7.3']?.failures)).toContain('Trimestre 1')
    expect(messages(page['5.1.1']?.failures)).toContain('sans résumé')
  })

  it('relève les tableaux de mise en forme fautifs', async () => {
    const page = await bench.audit(checks, `${DIR}/ko.html`)
    expect(page['5.3.1']?.status).toBe('NC')
    expect(messages(page['5.3.1']?.failures)).toContain('role="presentation"')
  })

  it('soumet au jugement un tableau sans aucun indice, puis suit la décision', async () => {
    const page = await bench.audit(checks, `${DIR}/ko.html`)
    const asked = (page['5.3.1']?.pending ?? []).map((item) => item.evidence.debut)
    expect(asked).toContain('Cellule un | Cellule deux')
    // Une réponse « données » fait sortir le tableau sans en-tête en échec 5.6.1.
    const data = await bench.audit(checks, `${DIR}/ko.html`, {
      decisions: [
        {
          topic: 'table.kind',
          evidence: { lignes: '2', colonnes: '2', debut: 'Cellule un | Cellule deux' },
          answer: 'donnees',
        },
      ],
    })
    expect(data['5.6.1']?.failureCount).toBeGreaterThan(page['5.6.1']?.failureCount ?? 0)
  })
})
