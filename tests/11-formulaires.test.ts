import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestResult } from '../src/core/types.ts'
import { checks } from '../src/themes/11-formulaires.ts'
import { type Bench, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
}, 60_000)
afterAll(async () => {
  await bench.stop()
})

const DIR = '11-formulaires'
type Page = Record<string, TestResult>

const messages = (page: Page, test: string): string =>
  page[test]?.failures.map((failure) => failure.message).join('\n') ?? ''

/** Décisions « pass » pour toutes les questions en attente d'une page. */
function acceptAll(page: Page) {
  const seen = new Map<
    string,
    { topic: string; evidence: Record<string, string>; answer: string }
  >()
  for (const result of Object.values(page)) {
    for (const question of result.pending) {
      seen.set(question.key, {
        topic: question.topic,
        evidence: question.evidence,
        answer: question.answers.includes('pass') ? 'pass' : (question.answers[0] ?? 'pass'),
      })
    }
  }
  return Array.from(seen.values())
}

const pendingTopics = (page: Page): string[] =>
  Array.from(new Set(Object.values(page).flatMap((r) => r.pending.map((p) => p.topic)))).sort()

describe('Thématique 11 — formulaires : page correcte', () => {
  it('rien n’est en échec, les jugements attendus sont posés', async () => {
    const page = await bench.audit(checks, `${DIR}/ok.html`)
    for (const [test, result] of Object.entries(page)) {
      expect(result.status, `${test} : ${JSON.stringify(result.failures)}`).not.toBe('NC')
      expect(result.status, `${test} : ${result.notes.join(' ')}`).not.toBe('ERR')
    }
    for (const test of [
      '11.1.1',
      '11.1.2',
      '11.2.5',
      '11.4.1',
      '11.4.2',
      '11.4.3',
      '11.6.1',
      '11.8.2',
      '11.10.1',
      '11.10.2',
      '11.10.3',
      '11.10.4',
      '11.10.5',
      '11.10.6',
      '11.10.7',
      '11.11.1',
      '11.11.2',
      '11.13.1',
    ]) {
      expect(page[test]?.status, test).toBe('C')
    }
    expect(page['11.3.1']?.status).toBe('NA')
    expect(page['11.3.2']?.status).toBe('NA')
    expect(pendingTopics(page)).toEqual([
      'form.button',
      'form.button-label',
      'form.consequences',
      'form.group-legend',
      'form.group-needed',
      'form.label',
      'form.optgroup-label',
    ])
  })

  it('une fois les jugements enregistrés, tout est conforme', async () => {
    const first = await bench.audit(checks, `${DIR}/ok.html`)
    const page = await bench.audit(checks, `${DIR}/ok.html`, { decisions: acceptAll(first) })
    for (const [test, result] of Object.entries(page)) {
      expect(
        ['C', 'NA'],
        `${test} : ${result.status} ${JSON.stringify(result.failures)}`,
      ).toContain(result.status)
    }
    expect(page['11.2.6']?.status).toBe('C')
    expect(page['11.1.3']?.status).toBe('C')
  })
})

describe('Thématique 11 — formulaires : page sans formulaire', () => {
  it('tous les tests sont non applicables', async () => {
    const page = await bench.audit(checks, `${DIR}/sans-formulaire.html`)
    const declared = checks.filter((c) => c.kind === 'page').flatMap((c) => c.tests)
    expect(declared.length).toBeGreaterThan(20)
    for (const [test, result] of Object.entries(page)) {
      expect(result.status, `${test} : ${result.notes.join(' ')}`).toBe('NA')
    }
  })
})

describe('Thématique 11 — formulaires : défauts statiques', () => {
  let page: Page
  beforeAll(async () => {
    page = await bench.audit(checks, `${DIR}/ko.html`)
  }, 120_000)

  it('aucune vérification ne plante', () => {
    for (const [test, result] of Object.entries(page)) {
      expect(result.status, `${test} : ${result.notes.join(' ')}`).not.toBe('ERR')
    }
  })

  it('11.1 : champ sans étiquette, étiquette implicite, placeholder seul, étiquette vide', () => {
    expect(page['11.1.1']?.status).toBe('NC')
    const text = messages(page, '11.1.1')
    expect(text).toContain('Aucune étiquette')
    expect(text).toContain('implicite')
    expect(text).toContain('placeholder')
    expect(text).toContain('est vide')
  })

  it('11.1.2 : for sans cible, for vers un élément qui n’est pas un champ, id en double', () => {
    expect(page['11.1.2']?.status).toBe('NC')
    const text = messages(page, '11.1.2')
    expect(text).toContain('for="fantome"')
    expect(text).toContain('<div>')
    expect(text).toContain('id="dup"')
  })

  it('11.1.3 : étiquette non visible ou non accolée, sans title ni texte accolé', () => {
    expect(page['11.1.3']?.status).toBe('NC')
    const text = messages(page, '11.1.3')
    expect(text).toContain('Terme à rechercher')
    expect(text).toContain('n’est pas visible')
    expect(text).toContain('Étiquette éloignée')
    expect(text).toContain('n’est pas accolée')
  })

  it('11.2.1 à 11.2.4 : étiquettes sans signification, par technique d’étiquetage', () => {
    expect(messages(page, '11.2.1')).toContain('« Champ »')
    expect(messages(page, '11.2.2')).toContain('« Saisie »')
    expect(messages(page, '11.2.3')).toContain('« Champ »')
    expect(messages(page, '11.2.4')).toContain('« Input 3 »')
    for (const test of ['11.2.1', '11.2.2', '11.2.3', '11.2.4'])
      expect(page[test]?.status).toBe('NC')
  })

  it('11.2.5 : l’intitulé visible n’est pas repris dans le nom accessible', () => {
    expect(page['11.2.5']?.status).toBe('NC')
    expect(messages(page, '11.2.5')).toContain('« Prénom » n’est pas repris dans aria-label')
  })

  it('11.4 : étiquette sous le champ, éloignée, ou du mauvais côté d’une case', () => {
    expect(page['11.4.1']?.status).toBe('NC')
    expect(messages(page, '11.4.1')).toContain('Étiquette éloignée')
    expect(page['11.4.2']?.status).toBe('NC')
    expect(messages(page, '11.4.2')).toContain('Étiquette sous le champ')
    expect(page['11.4.3']?.status).toBe('NC')
    expect(messages(page, '11.4.3')).toContain('Case à droite de son étiquette')
  })

  it('11.5 et 11.6 : radios sans regroupement, fieldset sans légende, role=group sans nom', () => {
    expect(page['11.5.1']?.status).toBe('NC')
    expect(messages(page, '11.5.1')).toContain('boutons radio « choix »')
    expect(page['11.6.1']?.status).toBe('NC')
    expect(messages(page, '11.6.1')).toContain('<fieldset> n’a pas de <legend>')
    expect(messages(page, '11.6.1')).toContain('role="group"')
  })

  it('11.8.2 : optgroup sans label ou au label vide', () => {
    expect(page['11.8.2']?.status).toBe('NC')
    const text = messages(page, '11.8.2')
    expect(text).toContain('n’a pas d’attribut label')
    expect(text).toContain('est vide')
  })

  it('11.9 : bouton vide, intitulé générique, nom accessible sans l’intitulé visible', () => {
    expect(page['11.9.1']?.status).toBe('NC')
    expect(messages(page, '11.9.1')).toContain('n’a pas d’intitulé')
    expect(messages(page, '11.9.1')).toContain('« Bouton »')
    expect(page['11.9.2']?.status).toBe('NC')
    expect(messages(page, '11.9.2')).toContain(
      '« Valider la saisie » mais son aria-label est « Confirmer »',
    )
  })

  it('11.10.1, 11.10.2 et 11.10.5 : obligatoire non indiqué, astérisque inexpliqué, format caché', () => {
    expect(page['11.10.1']?.status).toBe('NC')
    expect(messages(page, '11.10.1')).toContain('astérisque')
    expect(page['11.10.2']?.status).toBe('NC')
    expect(messages(page, '11.10.2')).toContain('Téléphone fixe')
    expect(page['11.10.5']?.status).toBe('NC')
    const text = messages(page, '11.10.5')
    expect(text).toContain('placeholder')
    expect(text).toContain('pattern')
    expect(text).toContain('n’est pas visible')
  })

  it('11.13.1 : autocomplete absent, invalide ou « off »', () => {
    expect(page['11.13.1']?.status).toBe('NC')
    const text = messages(page, '11.13.1')
    expect(text).toContain('Prénom de l’usager')
    expect(text).toContain('autocomplete="cp"')
    expect(text).toContain('autocomplete="off"')
  })
})

describe('Thématique 11 — formulaires : contrôle de saisie', () => {
  it('message sans lien avec le champ, aria-invalid sans message, aucune réaction au format invalide', async () => {
    const page = await bench.audit(checks, `${DIR}/erreurs-ko.html`)
    expect(page['11.10.3']?.status).toBe('NC')
    expect(messages(page, '11.10.3')).toContain('Nom')
    expect(page['11.10.4']?.status).toBe('NC')
    expect(messages(page, '11.10.4')).toContain('Champ requis')
    expect(page['11.10.6']?.status).toBe('NC')
    expect(messages(page, '11.10.6')).toContain('Code de suivi')
    expect(page['11.11.1']?.status).toBe('NC')
    expect(page['11.11.2']?.status).toBe('NC')
    expect(messages(page, '11.11.1')).toContain('sans aucun message')
    // L'instruction de format d'un champ en erreur sans texte d'aide est une question de jugement.
    expect(page['11.10.7']?.status).toBe('AV')
    expect(page['11.10.7']?.pending[0]?.topic).toBe('form.error.instruction')
  })

  it('un formulaire vide accepté malgré des champs obligatoires est en échec', async () => {
    const page = await bench.audit(checks, `${DIR}/envoi-accepte.html`)
    expect(page['11.10.3']?.status).toBe('NC')
    expect(messages(page, '11.10.3')).toContain('est accepté')
  })

  it('un script de formulaire actif tardivement n’est pas pris pour un envoi à vide accepté', async () => {
    const page = await bench.audit(checks, `${DIR}/hydratation-tardive.html`)
    expect(page['11.10.3']?.status, JSON.stringify(page['11.10.3']?.failures)).toBe('C')
    expect(page['11.10.4']?.status).toBe('C')
  })

  it('la validation native du navigateur satisfait le contrôle de saisie', async () => {
    const page = await bench.audit(checks, `${DIR}/natif.html`)
    for (const test of ['11.10.3', '11.10.6', '11.11.1', '11.11.2']) {
      expect(page[test]?.status, `${test} : ${JSON.stringify(page[test]?.failures)}`).toBe('C')
    }
    expect(page['11.10.4']?.status).toBe('NA')
    expect(page['11.10.7']?.status).toBe('NA')
  })
})

describe('Thématique 11 — formulaires : jugements', () => {
  it('la pertinence d’une étiquette attend un jugement, puis suit la décision', async () => {
    const evidence = { étiquette: 'Prénom', champ: 'text' }
    const pending = await bench.audit(checks, `${DIR}/ok.html`)
    expect(pending['11.2.1']?.status).toBe('AV')
    expect(pending['11.2.1']?.pending.map((p) => p.evidence)).toContainEqual(evidence)

    const refused = await bench.audit(checks, `${DIR}/ok.html`, {
      decisions: [{ topic: 'form.label', evidence, answer: 'fail' }],
    })
    expect(refused['11.2.1']?.status).toBe('NC')
    expect(messages(refused, '11.2.1')).toContain('Prénom')

    const accepted = await bench.audit(checks, `${DIR}/ok.html`, { decisions: acceptAll(pending) })
    expect(accepted['11.2.1']?.status).toBe('C')
  })

  it('un formulaire à conséquences et une légende de groupe suivent leur décision', async () => {
    const first = await bench.audit(checks, `${DIR}/ok.html`)
    const all = acceptAll(first)
    const consequences = all.find(
      (d) => d.topic === 'form.consequences' && d.evidence.champs?.includes('Prénom'),
    )
    expect(consequences).toBeDefined()
    expect(first['11.12.1']?.status).toBe('AV')
    expect(first['11.12.2']?.status).toBe('AV')
    const refused = await bench.audit(checks, `${DIR}/ok.html`, {
      decisions: all.map((d) => (d === consequences ? { ...d, answer: 'fail' } : d)),
    })
    expect(refused['11.12.1']?.status).toBe('NC')
    expect(refused['11.12.2']?.status).toBe('NC')

    const legend = all.find((d) => d.topic === 'form.group-legend')
    const refusedLegend = await bench.audit(checks, `${DIR}/ok.html`, {
      decisions: all.map((d) => (d === legend ? { ...d, answer: 'fail' } : d)),
    })
    expect(refusedLegend['11.7.1']?.status).toBe('NC')
  })

  it('un bouton adjacent qui porte l’étiquette : une seule décision pour 11.1.3 et 11.2.6', async () => {
    const first = await bench.audit(checks, `${DIR}/ok.html`)
    expect(first['11.1.3']?.status).toBe('AV')
    expect(first['11.2.6']?.status).toBe('AV')
    const keys = (test: string) => first[test]?.pending.map((p) => p.key)
    expect(keys('11.1.3')).toEqual(keys('11.2.6'))
    const all = acceptAll(first)
    const button = all.find((d) => d.topic === 'form.button-label')
    expect(button).toBeDefined()
    const refused = await bench.audit(checks, `${DIR}/ok.html`, {
      decisions: all.map((d) => (d === button ? { ...d, answer: 'fail' } : d)),
    })
    expect(refused['11.1.3']?.status).toBe('NC')
    expect(refused['11.2.6']?.status).toBe('NC')
  })

  it('intitulé de bouton, groupement de champs d’identité et optgroup attendent un jugement', async () => {
    const page = await bench.audit(checks, `${DIR}/ok.html`)
    expect(page['11.9.1']?.pending[0]?.evidence).toEqual({
      intitulé: 'Envoyer le message',
      bouton: 'button',
    })
    expect(page['11.5.1']?.pending[0]?.evidence).toEqual({
      famille: 'identité',
      champs: 'Nom | Prénom',
    })
    expect(page['11.8.3']?.pending.map((p) => p.evidence)).toContainEqual({
      libellé: 'Famille',
      options: 'État civil | Petite enfance',
    })
  })
})

describe('Thématique 11 — formulaires : cohérence des étiquettes', () => {
  it('11.3.1 : deux champs de même fonction aux étiquettes différentes attendent un jugement', async () => {
    const evidence = { fonction: 'email', étiquettes: 'Courriel | E-mail' }
    const pending = await bench.audit(checks, `${DIR}/coherence-a.html`)
    expect(pending['11.3.1']?.status).toBe('AV')
    expect(pending['11.3.1']?.pending[0]?.evidence).toEqual(evidence)
    const refused = await bench.audit(checks, `${DIR}/coherence-a.html`, {
      decisions: [{ topic: 'form.label.coherence', evidence, answer: 'fail' }],
    })
    expect(refused['11.3.1']?.status).toBe('NC')
    const accepted = await bench.audit(checks, `${DIR}/coherence-a.html`, {
      decisions: [{ topic: 'form.label.coherence', evidence, answer: 'pass' }],
    })
    expect(accepted['11.3.1']?.status).toBe('C')
  })

  it('11.3.2 : étiquettes différentes pour une même fonction sur deux pages', async () => {
    const pages = [`${DIR}/coherence-b.html`, `${DIR}/coherence-c.html`]
    const same = await bench.auditSite(checks, pages)
    for (const fixture of pages) expect(same[fixture]?.['11.3.2']?.status).toBe('C')

    const evidence = { fonction: 'email', étiquettes: 'Courriel | E-mail' }
    const mixed = [`${DIR}/coherence-a.html`, `${DIR}/coherence-b.html`]
    const site = await bench.auditSite(checks, mixed)
    for (const fixture of mixed) expect(site[fixture]?.['11.3.2']?.status).toBe('AV')
    const refused = await bench.auditSite(checks, mixed, {
      decisions: [{ topic: 'form.label.coherence', evidence, answer: 'fail' }],
    })
    for (const fixture of mixed) expect(refused[fixture]?.['11.3.2']?.status).toBe('NC')
  })

  it('11.3.2 : une fonction qui n’apparaît que sur une page n’est pas applicable', async () => {
    const site = await bench.auditSite(checks, [
      `${DIR}/coherence-b.html`,
      `${DIR}/sans-formulaire.html`,
    ])
    expect(site[`${DIR}/coherence-b.html`]?.['11.3.2']?.status).toBe('NA')
  })
})

describe('Thématique 11 — formulaires : listes de choix', () => {
  it('liste longue sans optgroup, ou mêlant options groupées et non groupées : jugement', async () => {
    const page = await bench.audit(checks, `${DIR}/selects.html`)
    expect(page['11.8.1']?.status).toBe('AV')
    const topics = page['11.8.1']?.pending.map((p) => p.evidence.liste) ?? []
    expect(topics.some((l) => l?.startsWith('Choisir | Alès'))).toBe(true)
    expect(topics).toContain('Autre')
    expect(page['11.8.2']?.status).toBe('C')
    expect(page['11.8.3']?.status).toBe('AV')

    const refused = await bench.audit(checks, `${DIR}/selects.html`, {
      decisions: acceptAll(page).map((d) =>
        d.topic === 'form.select-grouping' && d.evidence.liste?.startsWith('Choisir')
          ? { ...d, answer: 'fail' }
          : d,
      ),
    })
    expect(refused['11.8.1']?.status).toBe('NC')
    const accepted = await bench.audit(checks, `${DIR}/selects.html`, {
      decisions: acceptAll(page),
    })
    expect(accepted['11.8.1']?.status).toBe('C')
    expect(accepted['11.8.3']?.status).toBe('C')
  })

  it('liste personnalisée : role=group dans role=listbox en échec, liste simple conforme', async () => {
    const grouped = await bench.audit(checks, `${DIR}/liste-groupes.html`)
    expect(grouped['11.8.1']?.status).toBe('NC')
    expect(messages(grouped, '11.8.1')).toContain('role="group"')
    const simple = await bench.audit(checks, `${DIR}/liste-simple.html`)
    expect(simple['11.8.1']?.status).toBe('C')
  })
})
