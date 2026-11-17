import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checks } from '../src/themes/09-structuration.ts'
import { type Bench, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
})
afterAll(async () => {
  await bench.stop()
})

const DIR = '09-structuration'
const messages = (failures: { message: string }[] | undefined) =>
  (failures ?? []).map((failure) => failure.message).join('\n')

describe('Thématique 9 — structuration de l’information', () => {
  it('une page bien structurée est conforme, sans jugement en attente', async () => {
    const page = await bench.audit(checks, `${DIR}/ok.html`)
    for (const test of ['9.1.1', '9.1.2', '9.2.1', '9.3.1', '9.3.2', '9.3.3']) {
      expect(page[test]?.status, `${test} : ${JSON.stringify(page[test])}`).toBe('C')
    }
    expect(page['9.1.3']?.status).toBe('NA')
    expect(page['9.4.1']?.status).toBe('C')
    expect(page['9.4.2']?.status).toBe('C')
  })

  it('relève sauts de niveau, titres vides, repères manquants et listes mal construites', async () => {
    const page = await bench.audit(checks, `${DIR}/ko.html`)
    expect(page['9.1.1']?.status).toBe('NC')
    expect(messages(page['9.1.1']?.failures)).toContain('niveau 4')
    expect(page['9.1.2']?.status).toBe('NC')
    expect(messages(page['9.1.2']?.failures)).toContain('Titre vide')

    const structure = messages(page['9.2.1']?.failures)
    expect(structure).toContain('<header>')
    expect(structure).toContain('<footer>')
    expect(structure).toContain('<nav>')
    expect(structure).toContain('Plusieurs balises <main>')

    expect(page['9.3.2']?.status).toBe('NC')
    expect(messages(page['9.3.2']?.failures)).toContain('<ol>')
    expect(page['9.3.3']?.status).toBe('NC')
    expect(messages(page['9.3.3']?.failures)).toContain('sans description')
  })

  it('soumet au jugement titre factice, liste à puces et citation écrits à la main', async () => {
    const page = await bench.audit(checks, `${DIR}/ko.html`)
    expect(page['9.1.3']?.pending[0]?.evidence.texte).toBe('Un faux titre énorme')
    expect(page['9.3.1']?.pending[0]?.evidence.lignes).toContain('- premier point')
    expect(page['9.3.2']?.pending[0]?.evidence.lignes).toContain('1. première étape')
    expect(page['9.4.1']?.pending[0]?.evidence.texte).toContain('nous ferons tout')
  })

  it('suit les décisions enregistrées', async () => {
    const refused = await bench.audit(checks, `${DIR}/ko.html`, {
      decisions: [
        {
          topic: 'heading.missing',
          evidence: { texte: 'Un faux titre énorme', taille: '2', gras: 'true' },
          answer: 'titre-non-balise',
        },
      ],
    })
    expect(messages(refused['9.1.3']?.failures)).toContain('Un faux titre énorme')
  })

  it('un doctype hérité rend le critère 9.2 non applicable', async () => {
    const page = await bench.audit(checks, `${DIR}/ancien-doctype.html`)
    expect(page['9.2.1']?.status).toBe('NA')
  })
})
