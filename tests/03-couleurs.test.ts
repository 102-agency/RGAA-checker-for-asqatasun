import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestResult } from '../src/core/types.ts'
import { checks, classifyText } from '../src/themes/03-couleurs.ts'
import { type Bench, type BenchOptions, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
})
afterAll(async () => {
  await bench.stop()
})

const DIR = '03-couleurs'
const messages = (result: TestResult | undefined): string =>
  result?.failures.map((failure) => failure.message).join('\n') ?? ''

/** Décisions reprenant les questions en attente d'un premier audit, avec la réponse voulue par sujet. */
function decisions(
  pending: TestResult[],
  answers: Record<string, string>,
): NonNullable<BenchOptions['decisions']> {
  const seen = new Map<
    string,
    { topic: string; evidence: Record<string, string>; answer: string }
  >()
  for (const result of pending) {
    for (const question of result.pending) {
      const answer = answers[question.topic]
      if (answer) {
        seen.set(question.key, { topic: question.topic, evidence: question.evidence, answer })
      }
    }
  }
  return Array.from(seen.values())
}

describe('Seuils du RGAA (3.2)', () => {
  it('classe le texte selon sa taille restituée et sa graisse', () => {
    expect(classifyText(16, 400)).toEqual({ test: '3.2.1', threshold: 4.5 })
    expect(classifyText(23.9, 400)).toEqual({ test: '3.2.1', threshold: 4.5 })
    expect(classifyText(24, 400)).toEqual({ test: '3.2.3', threshold: 3 })
    expect(classifyText(18.4, 700)).toEqual({ test: '3.2.2', threshold: 4.5 })
    expect(classifyText(18.5, 700)).toEqual({ test: '3.2.4', threshold: 3 })
    // 600 n'est pas « en gras » : un texte de 20 px de graisse 600 reste soumis à 4,5:1.
    expect(classifyText(20, 600)).toEqual({ test: '3.2.1', threshold: 4.5 })
  })
})

describe('3.2 — contraste du texte', () => {
  it('une page contrastée est conforme, sans question ni mécanisme', async () => {
    const page = await bench.audit(checks, `${DIR}/texte-ok.html`)
    for (const test of ['3.2.1', '3.2.2', '3.2.3', '3.2.4']) {
      expect(page[test]?.status, `${test} : ${messages(page[test])}`).toBe('C')
      expect(page[test]?.pending).toEqual([])
    }
    expect(page['3.2.5']?.status).toBe('NA')
    // Le site ne réagit pas à prefers-color-scheme : la limite est dite.
    expect(page['3.2.1']?.notes.join('\n')).toContain('prefers-color-scheme')
  })

  it('relève chaque texte pâle dans la catégorie du RGAA qui lui revient', async () => {
    const page = await bench.audit(checks, `${DIR}/texte-ko.html`)
    const m1 = messages(page['3.2.1'])
    expect(page['3.2.1']?.status).toBe('NC')
    expect(m1).toContain('Gris clair normal')
    expect(m1).toContain('Graisse intermédiaire') // 600 : pas « en gras »
    expect(m1).toContain('Presque grand texte') // 23,9 px : sous le seuil des 24 px
    expect(m1).toContain('Texte foncé noyé') // opacité du conteneur
    expect(m1).toContain('Couleur oklch pâle')
    expect(m1).toContain('dégradé du blanc au noir') // pire zone d'un fond non uni
    expect(m1).toContain('image à moitié blanche') // pixels d'une image
    expect(m1).toContain('30 %') // couleur de texte translucide
    expect(m1).toContain('Placeholder pâle')
    expect(m1).toContain('Texte saisi dans le champ')
    expect(m1).toContain('Texte SVG pâle') // texte d'un SVG, taille restituée comprise
    expect(page['3.2.2']?.status).toBe('NC')
    expect(messages(page['3.2.2'])).toContain('Gris clair gras')
    expect(page['3.2.3']?.status).toBe('NC')
    expect(messages(page['3.2.3'])).toContain('Très pâle agrandi')
    expect(page['3.2.4']?.status).toBe('NC')
    expect(messages(page['3.2.4'])).toContain('Pâle gras agrandi')
    // Chaque échec annonce le rapport mesuré et celui attendu.
    expect(m1).toMatch(/contraste de \d,\d:1 au lieu de 4,5:1/)
    expect(m1).toContain('23,9 px')
    expect(messages(page['3.2.3'])).toMatch(/au lieu de 3:1/)
  })

  it('mesure aussi le texte au survol, au focus, dans un panneau replié et dans une erreur de formulaire', async () => {
    const ko = await bench.audit(checks, `${DIR}/etats-ko.html`)
    const m = messages(ko['3.2.1'])
    expect(ko['3.2.1']?.status).toBe('NC')
    expect(m).toContain('Lien pâle au survol')
    expect(m).toContain('survol')
    expect(m).toContain('Lien pâle au focus')
    expect(m).toContain('focus')
    expect(m).toContain('Contenu replié au texte pâle')
    expect(m).toContain('Panneau ouvert au texte pâle')
    expect(m).toContain('Ce champ est obligatoire, texte pâle')
    expect(m).toContain('erreurs de formulaire')
    // Un champ qui devient invalide change de bordure : mesurée aussi.
    expect(messages(ko['3.3.1'])).toContain('erreurs de formulaire')

    const ok = await bench.audit(checks, `${DIR}/etats-ok.html`)
    expect(ok['3.2.1']?.status, messages(ok['3.2.1'])).toBe('C')
    expect(ok['3.3.1']?.status, messages(ok['3.3.1'])).toBe('C')
  })

  it('mesure un en-tête fixe à plusieurs positions de défilement', async () => {
    const ko = await bench.audit(checks, `${DIR}/epingle-ko.html`)
    expect(ko['3.2.1']?.status).toBe('NC')
    expect(messages(ko['3.2.1'])).toContain('Retour à l’accueil')
    expect(messages(ko['3.2.1'])).toContain('défilement')
    const ok = await bench.audit(checks, `${DIR}/epingle-ok.html`)
    expect(ok['3.2.1']?.status, messages(ok['3.2.1'])).toBe('C')
  })

  it('exempte le texte des composants inactifs et pose une question sur les cas particuliers', async () => {
    const pending = await bench.audit(checks, `${DIR}/exemptions.html`)
    // Le bouton `disabled` n'est pas mesuré ; filigrane, logo, ombre et dégradé attendent un jugement.
    expect(messages(pending['3.2.1'])).not.toContain('Action indisponible')
    const topics = new Set(
      Object.values(pending).flatMap((result) => result.pending.map((question) => question.topic)),
    )
    expect(topics).toEqual(
      new Set(['couleurs.texte-exempte', 'couleurs.texte-ombre', 'couleurs.texte-degrade']),
    )
    expect(pending['3.2.3']?.status).toBe('AV') // filigrane de 40 px
    expect(pending['3.2.2']?.status).toBe('AV') // nom de la ville en gras
    expect(pending['3.2.1']?.status).toBe('AV') // ombre
    expect(pending['3.2.4']?.status).toBe('AV') // dégradé

    const exempt = await bench.audit(checks, `${DIR}/exemptions.html`, {
      decisions: decisions(Object.values(pending), {
        'couleurs.texte-exempte': 'exempte',
        'couleurs.texte-ombre': 'lisible',
        'couleurs.texte-degrade': 'pass',
      }),
    })
    for (const test of ['3.2.1', '3.2.2', '3.2.3', '3.2.4']) {
      expect(exempt[test]?.status, `${test} : ${messages(exempt[test])}`).toBe('C')
    }

    const refused = await bench.audit(checks, `${DIR}/exemptions.html`, {
      decisions: decisions(Object.values(pending), {
        'couleurs.texte-exempte': 'non-exempte',
        'couleurs.texte-ombre': 'illisible',
        'couleurs.texte-degrade': 'fail',
      }),
    })
    for (const test of ['3.2.1', '3.2.2', '3.2.3', '3.2.4']) {
      expect(refused[test]?.status, test).toBe('NC')
    }
  })

  it('audite le thème sombre quand le site y réagit', async () => {
    const ko = await bench.audit(checks, `${DIR}/sombre-ko.html`)
    expect(ko['3.2.1']?.status).toBe('NC')
    expect(messages(ko['3.2.1'])).toContain('mode sombre')
    expect(ko['3.2.1']?.notes.join('\n')).not.toContain('prefers-color-scheme')

    const ok = await bench.audit(checks, `${DIR}/sombre-ok.html`)
    expect(ok['3.2.1']?.status, messages(ok['3.2.1'])).toBe('C')
  })

  it('un mécanisme de contraste ne dispense pas du jugement : question, puis 3.2.5', async () => {
    const pending = await bench.audit(checks, `${DIR}/mecanisme.html`)
    expect(pending['3.2.1']?.status).toBe('AV')
    expect(pending['3.2.1']?.pending[0]?.topic).toBe('couleurs.mecanisme')

    const valid = await bench.audit(checks, `${DIR}/mecanisme.html`, {
      decisions: decisions([pending['3.2.1'] as TestResult], {
        'couleurs.mecanisme': 'mecanisme-valide',
      }),
    })
    expect(valid['3.2.1']?.status).toBe('C')
    expect(valid['3.2.5']?.status).toBe('AV')

    const none = await bench.audit(checks, `${DIR}/mecanisme.html`, {
      decisions: decisions([pending['3.2.1'] as TestResult], {
        'couleurs.mecanisme': 'aucun-mecanisme',
      }),
    })
    expect(none['3.2.1']?.status).toBe('NC')
  })
})

describe('3.3 — composants et éléments graphiques', () => {
  it('des composants contrastés sont conformes ; les exemptions du RGAA sont respectées', async () => {
    const page = await bench.audit(checks, `${DIR}/composants-ok.html`)
    expect(page['3.3.1']?.status, messages(page['3.3.1'])).toBe('C')
    expect(page['3.3.2']?.status, messages(page['3.3.2'])).toBe('C')
    expect(page['3.3.3']?.status, messages(page['3.3.3'])).toBe('C')
    expect(page['3.3.4']?.status).toBe('NA')
    expect(page['3.3.1']?.checked).toBeGreaterThan(3)
  })

  it('relève contour de champ, case, focus, icône et formes contiguës trop pâles', async () => {
    const page = await bench.audit(checks, `${DIR}/composants-ko.html`)
    const m1 = messages(page['3.3.1'])
    expect(page['3.3.1']?.status).toBe('NC')
    expect(m1).toContain('Nom')
    expect(m1).toContain('Message') // fond pâle sans contour
    expect(m1).toContain('Recevoir la lettre')
    expect(m1).toContain('indicateur de focus')
    expect(m1).toMatch(/\d,\d:1/)
    expect(page['3.3.2']?.status).toBe('NC')
    expect(messages(page['3.3.2'])).toContain('Rechercher')
    expect(page['3.3.3']?.status).toBe('NC')
    expect(messages(page['3.3.3'])).toContain('Valider')
    // Icône en CSS : non mesurable, jugée.
    expect(page['3.3.2']?.pending.map((question) => question.topic)).toContain('couleurs.icone-css')
  })

  it('un mécanisme de contraste des composants : question, puis 3.3.4', async () => {
    const pending = await bench.audit(checks, `${DIR}/composants-mecanisme.html`)
    expect(pending['3.3.1']?.status).toBe('AV')
    expect(pending['3.3.1']?.pending[0]?.topic).toBe('couleurs.mecanisme-composants')
    const valid = await bench.audit(checks, `${DIR}/composants-mecanisme.html`, {
      decisions: decisions(Object.values(pending), {
        'couleurs.mecanisme-composants': 'mecanisme-valide',
      }),
    })
    expect(valid['3.3.1']?.status).toBe('C')
    expect(valid['3.3.4']?.status).toBe('AV')
    const none = await bench.audit(checks, `${DIR}/composants-mecanisme.html`, {
      decisions: decisions(Object.values(pending), {
        'couleurs.mecanisme-composants': 'aucun-mecanisme',
      }),
    })
    expect(none['3.3.1']?.status).toBe('NC')
    expect(none['3.3.2']?.status).toBe('NC')
  })

  it('sans composant ni graphique, les critères 3.3 sont non applicables', async () => {
    const page = await bench.audit(checks, `${DIR}/sans-matiere.html`)
    for (const test of ['3.3.1', '3.3.2', '3.3.3', '3.3.4']) {
      expect(page[test]?.status, test).toBe('NA')
    }
    expect(page['3.2.1']?.status).toBe('C')
  })
})

describe('3.1 — information donnée par la couleur', () => {
  it('une page où la couleur n’est jamais seule est conforme ou non applicable', async () => {
    const page = await bench.audit(checks, `${DIR}/couleur-ok.html`)
    expect(page['3.1.1']?.status, messages(page['3.1.1'])).toBe('C')
    expect(page['3.1.4']?.status, messages(page['3.1.4'])).toBe('C')
    for (const test of ['3.1.2', '3.1.3', '3.1.5', '3.1.6']) {
      expect(page[test]?.status, test).toBe('NA')
    }
  })

  it('relève les liens et états distingués par la seule couleur', async () => {
    const page = await bench.audit(checks, `${DIR}/couleur-ko.html`)
    const links = messages(page['3.1.1'])
    expect(page['3.1.1']?.status).toBe('NC')
    expect(links).toContain('un lien presque noir') // contraste trop faible avec le texte
    expect(links).toContain('un lien rouge sans repère') // aucun repère au survol ni au focus
    expect(links).not.toContain('un lien souligné au survol') // G183 : repère au survol et au focus
    expect(links).not.toContain('un lien toujours souligné')
    expect(page['3.1.4']?.status).toBe('NC')
    const states = messages(page['3.1.4'])
    expect(states).toContain('Accueil')
    expect(states.match(/Accueil/g)?.length).toBe(1) // la barre où l'état est en gras est conforme
  })

  it('contrôle aussi l’état courant d’un menu replié, ouvert par la vérification', async () => {
    const page = await bench.audit(checks, `${DIR}/panneau-etat.html`)
    expect(page['3.1.4']?.status).toBe('NC')
    expect(messages(page['3.1.4'])).toContain('Accueil')
  })

  it('pose une question pour mots colorés, indications de couleur, pastilles, médias et images', async () => {
    const page = await bench.audit(checks, `${DIR}/couleur-ko.html`)
    const asked = (test: string) => page[test]?.pending.map((question) => question.topic) ?? []
    expect(asked('3.1.1')).toContain('couleurs.mot-colore')
    expect(page['3.1.1']?.pending.map((question) => question.evidence.mot)).toContain('Annulé') // cellule colorée
    expect(new Set(asked('3.1.2'))).toEqual(new Set(['couleurs.indication-couleur']))
    expect(page['3.1.2']?.pending.map((question) => question.evidence.phrase).join('\n')).toContain(
      'indiqués en rouge',
    )
    expect(asked('3.1.4')).toContain('couleurs.pastille')
    expect(asked('3.1.5')).toEqual(['couleurs.media'])
    expect(asked('3.1.6')).toEqual(['couleurs.media'])
    // Une image de graphique est jugée ; la photographie n'est pas soumise à question.
    expect(asked('3.1.3')).toEqual(['couleurs.image'])
    expect(page['3.1.3']?.pending[0]?.evidence.source).toContain('graphique.svg')
    expect(page['3.2.1']?.pending.map((question) => question.topic)).toContain('couleurs.image')
    expect(page['3.3.2']?.pending.map((question) => question.topic)).toContain('couleurs.image')
  })

  it('les décisions enregistrées lèvent ou confirment les échecs', async () => {
    const first = await bench.audit(checks, `${DIR}/couleur-ko.html`)
    const all = Object.values(first)
    const accepted = await bench.audit(checks, `${DIR}/couleur-ko.html`, {
      decisions: decisions(all, {
        'couleurs.mot-colore': 'sans-information',
        'couleurs.indication-couleur': 'pass',
        'couleurs.pastille': 'pass',
        'couleurs.media': 'pass',
        'couleurs.image': 'conforme',
      }),
    })
    expect(accepted['3.1.2']?.status).toBe('C')
    expect(accepted['3.1.3']?.status).toBe('C')
    expect(accepted['3.1.5']?.status).toBe('C')
    expect(accepted['3.1.6']?.status).toBe('C')
    expect(accepted['3.2.1']?.pending.map((question) => question.topic)).not.toContain(
      'couleurs.image',
    )

    const refused = await bench.audit(checks, `${DIR}/couleur-ko.html`, {
      decisions: decisions(all, {
        'couleurs.indication-couleur': 'fail',
        'couleurs.mot-colore': 'information-par-la-couleur-seule',
        'couleurs.media': 'fail',
        'couleurs.image': 'couleur-seule',
      }),
    })
    expect(refused['3.1.2']?.status).toBe('NC')
    expect(messages(refused['3.1.1'])).toContain('transmet une information par la seule couleur')
    expect(refused['3.1.5']?.status).toBe('NC')
    expect(refused['3.1.3']?.status).toBe('NC')
  })

  it('sans lien, mot coloré, image ni média, les critères 3.1 sont non applicables', async () => {
    const page = await bench.audit(checks, `${DIR}/sans-matiere.html`)
    for (const test of ['3.1.1', '3.1.2', '3.1.3', '3.1.4', '3.1.5', '3.1.6']) {
      expect(page[test]?.status, test).toBe('NA')
    }
  })
})
