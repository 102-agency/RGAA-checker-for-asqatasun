import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checks } from '../src/themes/04-multimedia.ts'
import { type Bench, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
})
afterAll(async () => {
  await bench.stop()
})

const DIR = '04-multimedia'
const messages = (failures: { message: string }[] | undefined) =>
  (failures ?? []).map((failure) => failure.message).join('\n')

describe('Thématique 4 — multimédia', () => {
  it('une page sans média rend tous les tests non applicables', async () => {
    const page = await bench.audit(checks, '08-elements-obligatoires/ok.html')
    for (const test of ['4.1.1', '4.3.1', '4.7.1', '4.10.1', '4.11.1', '4.8.1']) {
      expect(page[test]?.status, test).toBe('NA')
    }
  })

  it('des médias avec sous-titres, audiodescription, légende et commandes ne laissent que des jugements', async () => {
    const page = await bench.audit(checks, `${DIR}/ok.html`)
    for (const test of [
      '4.1.3',
      '4.1.1',
      '4.3.1',
      '4.3.2',
      '4.5.2',
      '4.11.1',
      '4.11.2',
      '4.11.3',
    ]) {
      expect(page[test]?.status, `${test} ${JSON.stringify(page[test])}`).toBe('C')
    }
    expect(page['4.10.1']?.status).toBe('NA') // aucun son automatique
    // Contenu des sous-titres, audiodescription, transcriptions, légendes : à juger.
    expect(page['4.4.1']?.pending[0]?.evidence.repliques).toBe('1')
    expect(page['4.4.1']?.pending[0]?.evidence.debut).toContain('Bonjour')
    expect(page['4.6.2']?.status).toBe('AV')
    expect(page['4.2.3']?.status).toBe('AV')
    expect(page['4.7.1']?.status).toBe('AV')
  })

  it('relève médias sans commandes, sous-titres vides ou mal déclarés, son automatique', async () => {
    const page = await bench.audit(checks, `${DIR}/ko.html`)
    expect(messages(page['4.11.1']?.failures)).toContain('a.mp4')
    expect(page['4.3.2']?.status).toBe('NC')
    expect(messages(page['4.3.2']?.failures)).toContain('kind="captions"')
    expect(messages(page['4.4.1']?.failures)).toContain('vide.vtt')
    expect(page['4.10.1']?.status).toBe('NC')
    expect(messages(page['4.10.1']?.failures)).toContain('musique.mp3')
  })

  it('un média sans aucun texte adjacent n’est pas identifié', async () => {
    const page = await bench.audit(checks, `${DIR}/nu.html`)
    expect(page['4.7.1']?.status).toBe('NC')
    expect(messages(page['4.7.1']?.failures)).toContain('nu.mp4')
  })

  it('soumet au jugement les alternatives absentes et les médias non temporels', async () => {
    const page = await bench.audit(checks, `${DIR}/ko.html`)
    expect(page['4.1.3']?.pending.length).toBeGreaterThan(0)
    expect(page['4.8.1']?.pending[0]?.evidence.page).toContain('ko.html')
    expect(page['4.12.1']?.status).toBe('AV')
    // Le lecteur YouTube : sous-titres et clavier se jugent, ils ne se lisent pas dans la page.
    const subtitles = (page['4.3.1']?.pending ?? []).map((item) => item.evidence.fournisseur)
    expect(subtitles).toContain('www.youtube.com')
  })

  it('suit une décision « alternative absente »', async () => {
    const refused = await bench.audit(checks, `${DIR}/ko.html`, {
      decisions: [
        {
          topic: 'media.alternative',
          evidence: { page: `/${DIR}/ko.html`, media: `/${DIR}/a.mp4`, type: 'video' },
          answer: 'alternative-absente',
        },
      ],
    })
    expect(messages(refused['4.1.3']?.failures)).toContain('a.mp4')
  })
})
