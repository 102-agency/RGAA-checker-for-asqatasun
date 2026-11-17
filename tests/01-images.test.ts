import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Judgement, TestResult } from '../src/core/types.ts'
import { normalizeImageSource, unworthyAlternative } from '../src/lib/images-source.ts'
import { checks } from '../src/themes/01-images.ts'
import { type Bench, type BenchOptions, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
})
afterAll(async () => {
  await bench.stop()
})

type Results = Record<string, TestResult>

/** Questions en attente d'une page, une par empreinte. */
function pendingOf(results: Results): Judgement[] {
  const byKey = new Map<string, Judgement>()
  for (const result of Object.values(results)) {
    for (const judgement of result.pending) byKey.set(judgement.key, judgement)
  }
  return Array.from(byKey.values())
}

/** Décisions pour toutes les questions en attente, selon `pick(question)` (rien = pas de décision). */
function decisionsFor(
  results: Results,
  pick: (question: Judgement) => string | undefined,
): NonNullable<BenchOptions['decisions']> {
  return pendingOf(results).flatMap((question) => {
    const answer = pick(question)
    return answer ? [{ topic: question.topic, evidence: question.evidence, answer }] : []
  })
}

/**
 * Audite sans décision, puis répond aux questions posées, autant de fois que
 * les réponses en font apparaître de nouvelles (le rôle d'une image conditionne
 * les questions suivantes). `before` : sans décision ; `after` : état final ;
 * `passes` : tous les états intermédiaires.
 */
async function settle(
  fixture: string,
  pick: (question: Judgement) => string | undefined,
  extra: NonNullable<BenchOptions['decisions']> = [],
) {
  const passes: Results[] = [
    await bench.audit(checks, `01-images/${fixture}`, { decisions: extra }),
  ]
  const decisions = [...extra]
  const known = new Set(decisions.map((d) => `${d.topic}|${JSON.stringify(d.evidence)}`))
  for (let pass = 0; pass < 5; pass += 1) {
    const last = passes[passes.length - 1] as Results
    const fresh = decisionsFor(last, pick).filter(
      (d) => !known.has(`${d.topic}|${JSON.stringify(d.evidence)}`),
    )
    if (fresh.length === 0) break
    for (const d of fresh) known.add(`${d.topic}|${JSON.stringify(d.evidence)}`)
    decisions.push(...fresh)
    passes.push(await bench.audit(checks, `01-images/${fixture}`, { decisions }))
  }
  return { before: passes[0] as Results, after: passes[passes.length - 1] as Results, passes }
}

const role = (answer: string) => (question: Judgement) =>
  question.topic === 'image.role' ? answer : 'pass'

const statuses = (results: Results, ...tests: string[]) =>
  Object.fromEntries(tests.map((test) => [test, results[test]?.status]))

describe('Thématique 1 — déclaration', () => {
  it('statue sur les 58 tests de la thématique', () => {
    const declared = new Set(checks.flatMap((check) => check.tests))
    expect(declared.size).toBe(58)
    for (const criterion of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(Array.from(declared).some((test) => test.startsWith(`1.${criterion}.`))).toBe(true)
    }
  })

  it('une page sans image est non applicable partout', async () => {
    const page = await bench.audit(checks, '08-elements-obligatoires/ok.html')
    for (const [test, result] of Object.entries(page)) {
      if (test.startsWith('1.')) expect(result.status, test).toBe('NA')
    }
  })
})

describe('Aides : source et alternatives indignes', () => {
  it('normalise les images Next et les adresses redimensionnées', () => {
    const base = 'http://localhost:3000/contact'
    expect(
      normalizeImageSource('/_next/image?url=%2Fapi%2Fmedia%2Ffile%2Fa.png&w=3840&q=75', base),
    ).toBe('/api/media/file/a.png')
    expect(
      normalizeImageSource('/_next/image?url=%2Fapi%2Fmedia%2Ffile%2Fa.png&w=640&q=90', base),
    ).toBe('/api/media/file/a.png')
    expect(
      normalizeImageSource(
        '/_next/image?url=https%3A%2F%2Fcdn.exemple.fr%2Fa.png%3Fv%3D2&w=640&q=75',
        base,
      ),
    ).toBe('/a.png?v=2')
    expect(normalizeImageSource('https://cdn.exemple.fr/a.png?w=300&v=2', base)).toBe('/a.png?v=2')
    expect(normalizeImageSource('', base)).toBe('')
  })

  it('reconnaît noms de fichier, mots génériques, numéros d’appareil photo', () => {
    expect(unworthyAlternative('photo.jpg', '')).toContain('nom de fichier')
    expect(unworthyAlternative('Image', '')).toContain('générique')
    expect(unworthyAlternative('logo', '')).toContain('générique')
    expect(unworthyAlternative('IMG_2041', '')).toContain('numéro')
    expect(unworthyAlternative('vue-aerienne', '/img/vue-aerienne.png')).toContain('nom du fichier')
    expect(unworthyAlternative('Logo de la mairie', '/logo.png')).toBeUndefined()
    expect(unworthyAlternative('Plan du centre-ville', '/img/plan.png')).toBeUndefined()
  })
})

describe('1.2 — décoration', () => {
  it('icône doublant le nom d’un bouton, image dans un lien nommé, pixel : conformes sans question', async () => {
    const page = await bench.audit(checks, '01-images/decoratif-ok.html')
    expect(statuses(page, '1.2.1', '1.2.4')).toEqual({ '1.2.1': 'C', '1.2.4': 'C' })
    expect(pendingOf(page)).toEqual([])
    expect(page['1.1.1']?.status).toBe('NA')
    expect(page['1.1.5']?.status).toBe('NA')
  })

  it('décoration sans marquage : échec mécanique, sans question', async () => {
    const page = await bench.audit(checks, '01-images/decoratif-ko.html')
    expect(page['1.1.5']?.status).toBe('NC')
    expect(page['1.1.5']?.failures[0]?.message).toContain('sans marquage')
    expect(page['1.1.1']?.status).toBe('NC')
    expect(page['1.2.2']?.status).toBe('NC')
  })

  it('décisions « décorative » : marquage fautif relevé par type d’élément', async () => {
    const { before, after } = await settle('decoratif-juge.html', role('decorative'))
    expect(before['1.2.1']?.status).toBe('AV')
    expect(pendingOf(before).every((question) => question.topic === 'image.role')).toBe(true)
    expect(pendingOf(before)).toHaveLength(7)
    expect(statuses(after, '1.2.1', '1.2.3', '1.2.4', '1.2.5', '1.2.6')).toEqual({
      '1.2.1': 'NC',
      '1.2.3': 'NC',
      '1.2.4': 'NC',
      '1.2.5': 'NC',
      '1.2.6': 'NC',
    })
    // img alt non vide, alt="" + title, role=img non masqué.
    expect(after['1.2.1']?.failures).toHaveLength(3)
    expect(pendingOf(after)).toEqual([])
  })

  it('décisions « décorative » : éléments correctement masqués conformes', async () => {
    const { before, after } = await settle('decoratif-juge-ok.html', role('decorative'))
    expect(before['1.2.4']?.status).toBe('AV')
    expect(statuses(after, '1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.2.5', '1.2.6')).toEqual({
      '1.2.1': 'C',
      '1.2.2': 'C',
      '1.2.3': 'C',
      '1.2.4': 'C',
      '1.2.5': 'C',
      '1.2.6': 'C',
    })
    // L'image décorée n'est pas porteuse d'information.
    expect(after['1.1.1']?.status).toBe('NA')
    expect(after['1.3.1']?.status).toBe('NA')
  })
})

describe('1.1 — alternative des images porteuses d’information', () => {
  it('chaque type sans alternative est non conforme', async () => {
    const { before, after } = await settle('info-ko.html', (q) =>
      q.topic === 'image.role' ? 'informative' : undefined,
    )
    expect(before['1.1.1']?.status).toBe('NC')
    expect(statuses(after, '1.1.1', '1.1.2', '1.1.3', '1.1.5')).toEqual({
      '1.1.1': 'NC',
      '1.1.2': 'NC',
      '1.1.3': 'NC',
      '1.1.5': 'NC',
    })
    // Objet, embed et canvas sans alternative : un contenu alternatif externe reste possible, on pose la question.
    expect(statuses(after, '1.1.6', '1.1.7', '1.1.8')).toEqual({
      '1.1.6': 'AV',
      '1.1.7': 'AV',
      '1.1.8': 'AV',
    })
    const messages = (after['1.1.1']?.failures ?? []).map((failure) => failure.message)
    expect(messages.some((message) => message.includes('alt=""'))).toBe(true)
    expect(messages.some((message) => message.includes('role="img"'))).toBe(true)
    expect(messages.some((message) => message.includes('masquée'))).toBe(true)
    expect(after['1.1.5']?.failures.map((failure) => failure.message).join(' ')).toContain(
      'role="img"',
    )
  })

  it('un contenu alternatif externe (objet, embed, canvas) est une question', async () => {
    const before = await bench.audit(checks, '01-images/info-ko.html')
    const external = pendingOf(before).filter((q) => q.topic === 'image.role')
    expect(external.length).toBeGreaterThan(0)
    const decisions = decisionsFor(before, (question) =>
      question.topic === 'image.role' ? 'informative' : undefined,
    )
    const middle = await bench.audit(checks, '01-images/info-ko.html', { decisions })
    expect(pendingOf(middle).map((question) => question.topic)).toContain(
      'image.alternative-externe',
    )
    const accepted = await bench.audit(checks, '01-images/info-ko.html', {
      decisions: [
        ...decisions,
        ...decisionsFor(middle, (question) =>
          question.topic === 'image.alternative-externe' ? 'pass' : undefined,
        ),
      ],
    })
    expect(statuses(accepted, '1.1.6', '1.1.7', '1.1.8')).toEqual({
      '1.1.6': 'C',
      '1.1.7': 'C',
      '1.1.8': 'C',
    })
    const refused = await bench.audit(checks, '01-images/info-ko.html', {
      decisions: [
        ...decisions,
        ...decisionsFor(middle, (question) =>
          question.topic === 'image.alternative-externe' ? 'fail' : undefined,
        ),
      ],
    })
    expect(statuses(refused, '1.1.6', '1.1.7', '1.1.8')).toEqual({
      '1.1.6': 'NC',
      '1.1.7': 'NC',
      '1.1.8': 'NC',
    })
  })

  it('alternatives présentes : conformes une fois les images jugées pertinentes', async () => {
    const { before, after } = await settle('info-ok.html', role('informative'))
    expect(before['1.1.1']?.status).toBe('AV')
    const roles = pendingOf(before).filter((question) => question.topic === 'image.role')
    // Image Next normalisée : l'origine, sans hôte ni taille.
    expect(roles.some((question) => question.evidence.source === '/a.png')).toBe(true)
    expect(
      statuses(
        after,
        '1.1.1',
        '1.1.2',
        '1.1.3',
        '1.1.5',
        '1.1.6',
        '1.1.7',
        '1.1.8',
        '1.3.1',
        '1.3.9',
      ),
    ).toEqual({
      '1.1.1': 'C',
      '1.1.2': 'C',
      '1.1.3': 'C',
      '1.1.5': 'C',
      '1.1.6': 'C',
      '1.1.7': 'C',
      '1.1.8': 'C',
      '1.3.1': 'C',
      '1.3.9': 'C',
    })
    expect(statuses(after, '1.3.2', '1.3.3', '1.3.4', '1.3.5', '1.3.6', '1.3.7', '1.3.8')).toEqual({
      '1.3.2': 'C',
      '1.3.3': 'C',
      '1.3.4': 'C',
      '1.3.5': 'C',
      '1.3.6': 'C',
      '1.3.7': 'C',
      '1.3.8': 'C',
    })
  })
})

describe('1.3 — pertinence', () => {
  it('nom de fichier, mot générique, numéro : échec sans question', async () => {
    const before = await bench.audit(checks, '01-images/pertinence.html')
    const { after } = await settle('pertinence.html', role('informative'))
    expect(before['1.3.1']?.status).toBe('AV')
    expect(after['1.3.1']?.status).toBe('NC')
    const reasons = (after['1.3.1']?.failures ?? []).map((failure) => failure.message).join('\n')
    expect(reasons).toContain('nom de fichier')
    expect(reasons).toContain('générique')
    expect(reasons).toContain('numéro')
    expect(reasons).toContain('nom du fichier image')
    expect(after['1.3.6']?.status).toBe('NC') // svg « Logo »
  })

  it('une même image redimensionnée ou répétée n’est jugée qu’une fois', async () => {
    const before = await bench.audit(checks, '01-images/pertinence.html')
    const place = pendingOf(before).filter((q) => q.evidence.source === '/img/place.png')
    expect(place.filter((q) => q.topic === 'image.role')).toHaveLength(1)
    const calendrier = pendingOf(before).filter(
      (q) =>
        q.topic === 'image.role' &&
        q.evidence.apercu?.includes('M3 3h6') &&
        q.evidence.alternative === 'Calendrier',
    )
    expect(calendrier).toHaveLength(1)
    expect(calendrier[0]?.evidence.empreinte).toMatch(/^[0-9a-f]{10}$/)
  })

  it('alternative longue : concision à juger', async () => {
    const { passes } = await settle('pertinence.html', role('informative'))
    const withRoles = passes[1] as Results
    expect(withRoles['1.3.9']?.status).toBe('AV')
    const concision = pendingOf(withRoles).filter(
      (question) => question.topic === 'image.alt-courte',
    )
    expect(concision).toHaveLength(1)
    const { after } = await settle('pertinence.html', (question) =>
      question.topic === 'image.role'
        ? 'informative'
        : question.topic === 'image.alt-courte'
          ? 'fail'
          : 'pass',
    )
    expect(after['1.3.9']?.status).toBe('NC')
    expect(after['1.3.9']?.failures[0]?.message).toContain('trop longue')
  })

  it('« non pertinente » enregistré : 1.3.1 non conforme', async () => {
    const before = await bench.audit(checks, '01-images/info-ok.html')
    const withRoles = decisionsFor(before, role('informative'))
    const middle = await bench.audit(checks, '01-images/info-ok.html', { decisions: withRoles })
    const refused = await bench.audit(checks, '01-images/info-ok.html', {
      decisions: withRoles.concat(
        decisionsFor(middle, (question) => (question.topic === 'image.alt' ? 'fail' : undefined)),
      ),
    })
    expect(refused['1.3.1']?.status).toBe('NC')
    expect(refused['1.3.1']?.failures[0]?.message).toContain('non pertinente')
  })
})

describe('1.4 et 1.5 — CAPTCHA et image-test', () => {
  it('image nommée captcha : alternative exigée, pertinence et accès alternatif jugés', async () => {
    const before = await bench.audit(checks, '01-images/captcha.html')
    expect(before['1.1.1']?.status).toBe('NC') // captcha.png sans alternative
    expect(before['1.4.1']?.status).toBe('AV')
    expect(before['1.5.1']?.status).toBe('AV')
    const topics = pendingOf(before).map((question) => question.topic)
    expect(topics).toContain('image.alt-captcha')
    expect(topics).toContain('image.captcha-acces')
    const { after } = await settle('captcha.html', (question) =>
      question.topic === 'image.role' ? 'captcha' : 'fail',
    )
    expect(after['1.4.1']?.status).toBe('NC')
    expect(after['1.5.1']?.status).toBe('NC')
    // Un CAPTCHA n'est pas jugé sur 1.3 (pertinence ordinaire) ni 1.8 (image texte).
    expect(after['1.3.1']?.status).toBe('NA')
    expect(after['1.8.1']?.status).toBe('NA')
  })

  it('alternative pertinente et accès alternatif acceptés : conformes', async () => {
    const { after } = await settle('captcha.html', (question) =>
      question.topic === 'image.role' ? 'captcha' : 'pass',
    )
    // L'image sans alternative reste fautive en 1.1.1 ; 1.4.1 et 1.5.1 sont conformes.
    expect(after['1.1.1']?.status).toBe('NC')
    expect(statuses(after, '1.4.1', '1.5.1')).toEqual({ '1.4.1': 'C', '1.5.1': 'C' })
  })
})

describe('1.9 — légendes', () => {
  it('figure sans rôle, aria-label différent de la légende, légende non balisée', async () => {
    const { before, after } = await settle('legende.html', (question) =>
      question.topic === 'image.role'
        ? question.evidence.source === '/archives.png' ||
          question.evidence.alternative === 'Armoiries'
          ? 'legend-unstructured'
          : 'informative'
        : 'pass',
    )
    expect(before['1.9.1']?.status).toBe('NC')
    const messages = (after['1.9.1']?.failures ?? []).map((failure) => failure.message).join('\n')
    expect(messages).toContain('role="figure" ou role="group"')
    expect(messages).toContain('n’est pas identique à la légende')
    expect(messages).toContain('<figure> / <figcaption>')
    // Figure correcte (svg, role=group, libellé identique) : seule la figure fautive échoue.
    expect(after['1.9.4']?.status).toBe('C')
    expect(after['1.9.1']?.failures).toHaveLength(4)
  })
})

describe('1.6, 1.7, 1.8 — description détaillée et images texte', () => {
  it('image texte remplaçable : échec ; logo : exemption ; description détaillée jugée', async () => {
    const answers = (question: Judgement): string | undefined => {
      if (question.topic !== 'image.role') return 'pass'
      const alt = question.evidence.alternative ?? ''
      if (alt.startsWith('Évolution')) return 'informative-detail'
      if (alt === 'Organigramme') return 'informative-detail'
      if (alt.startsWith('Logo')) return 'text-exempt'
      if (alt.startsWith('Horaires')) return 'text-replaceable'
      return 'informative'
    }
    const { before, after } = await settle('detail-texte.html', answers)
    expect(before['1.8.1']?.status).toBe('AV')
    expect(before['1.6.1']?.status).toBe('AV')
    expect(before['1.1.4']?.status).toBe('AV')
    expect(after['1.8.1']?.status).toBe('NC')
    expect(after['1.8.1']?.failures).toHaveLength(1)
    expect(after['1.6.1']?.status).toBe('C')
    expect(after['1.7.1']?.status).toBe('C')
    expect(after['1.1.4']?.status).toBe('C')
    // aria-describedby : l'identifiant absent est un échec, la description présente est jugée.
    expect(after['1.6.9']?.status).toBe('NC')
    expect(after['1.6.9']?.failures[0]?.message).toContain('absent')
    const signals = pendingOf(before).filter((question) => question.topic === 'image.role').length
    expect(signals).toBeGreaterThan(0)
  })

  it('description détaillée refusée ou ismap non doublé : non conforme', async () => {
    const before = await bench.audit(checks, '01-images/detail-texte.html')
    const answers = (question: Judgement) => {
      if (question.topic === 'image.role') {
        return (question.evidence.alternative ?? '').startsWith('Évolution')
          ? 'informative-detail'
          : 'informative'
      }
      return 'fail'
    }
    const middle = await bench.audit(checks, '01-images/detail-texte.html', {
      decisions: decisionsFor(before, answers),
    })
    const after = await bench.audit(checks, '01-images/detail-texte.html', {
      decisions: decisionsFor(before, answers).concat(decisionsFor(middle, answers)),
    })
    expect(after['1.6.1']?.status).toBe('NC')
    expect(after['1.1.4']?.status).toBe('NC')
  })
})

describe('Tous les types d’éléments', () => {
  const informative = (question: Judgement) =>
    question.topic === 'image.role' ? 'informative' : undefined

  it('alternative indigne : échec 1.3.2 à 1.3.7 sans question', async () => {
    const { after } = await settle('pertinence-types.html', informative)
    expect(statuses(after, '1.3.2', '1.3.3', '1.3.4', '1.3.5', '1.3.6', '1.3.7')).toEqual({
      '1.3.2': 'NC',
      '1.3.3': 'NC',
      '1.3.4': 'NC',
      '1.3.5': 'NC',
      '1.3.6': 'NC',
      '1.3.7': 'NC',
    })
  })

  it('canvas : contenu alternatif non restitué (1.3.8)', async () => {
    const { before, after } = await settle('pertinence-types.html', (question) =>
      question.topic === 'image.role'
        ? 'informative'
        : question.topic === 'image.restitution'
          ? 'fail'
          : 'pass',
    )
    expect(before['1.3.8']?.status).toBe('NA')
    expect(after['1.3.8']?.status).toBe('NC')
  })

  it('CAPTCHA de chaque type : pertinence 1.4.x et accès alternatif 1.5.x', async () => {
    const { before, after } = await settle('captcha-types.html', () => 'fail')
    // Aucune question de rôle : tous sont nommés CAPTCHA.
    expect(pendingOf(before).some((question) => question.topic === 'image.role')).toBe(false)
    expect(
      statuses(
        after,
        '1.4.1',
        '1.4.2',
        '1.4.3',
        '1.4.4',
        '1.4.5',
        '1.4.6',
        '1.4.7',
        '1.5.1',
        '1.5.2',
      ),
    ).toEqual({
      '1.4.1': 'NC',
      '1.4.2': 'NC',
      '1.4.3': 'NC',
      '1.4.4': 'NC',
      '1.4.5': 'NC',
      '1.4.6': 'NC',
      '1.4.7': 'NC',
      '1.5.1': 'NC',
      '1.5.2': 'NC',
    })
    const accepted = await settle('captcha-types.html', () => 'pass')
    expect(statuses(accepted.after, '1.4.1', '1.4.4', '1.4.7', '1.5.1', '1.5.2')).toEqual({
      '1.4.1': 'C',
      '1.4.4': 'C',
      '1.4.7': 'C',
      '1.5.1': 'C',
      '1.5.2': 'C',
    })
  })

  it('description détaillée absente ou non pertinente, par type (1.6.x et 1.7.x)', async () => {
    const detail = (answer: string) => (question: Judgement) =>
      question.topic === 'image.role'
        ? 'informative-detail'
        : question.topic === 'image.detail'
          ? answer
          : 'pass'
    const absent = await settle('detail-types.html', detail('fail'))
    expect(absent.before['1.6.1']?.status).toBe('AV')
    expect(
      statuses(absent.after, '1.6.1', '1.6.2', '1.6.3', '1.6.4', '1.6.5', '1.6.7', '1.6.10'),
    ).toEqual({
      '1.6.1': 'NC',
      '1.6.2': 'NC',
      '1.6.3': 'NC',
      '1.6.4': 'NC',
      '1.6.5': 'NC',
      '1.6.7': 'NC',
      '1.6.10': 'NC',
    })
    const irrelevant = await settle('detail-types.html', (question) =>
      question.topic === 'image.detail-pertinence' || question.topic === 'image.restitution'
        ? 'fail'
        : detail('pass')(question),
    )
    expect(
      statuses(
        irrelevant.after,
        '1.6.1',
        '1.6.2',
        '1.7.1',
        '1.7.2',
        '1.7.3',
        '1.7.4',
        '1.7.5',
        '1.7.6',
        '1.6.6',
        '1.6.8',
      ),
    ).toEqual({
      '1.6.1': 'C',
      '1.6.2': 'C',
      '1.7.1': 'NC',
      '1.7.2': 'NC',
      '1.7.3': 'NC',
      '1.7.4': 'NC',
      '1.7.5': 'NC',
      '1.7.6': 'NC',
      '1.6.6': 'NC',
      '1.6.8': 'NC',
    })
    const good = await settle('detail-types.html', detail('pass'))
    expect(
      statuses(good.after, '1.6.1', '1.6.4', '1.6.10', '1.7.1', '1.7.6', '1.6.6', '1.6.8'),
    ).toEqual({
      '1.6.1': 'C',
      '1.6.4': 'C',
      '1.6.10': 'C',
      '1.7.1': 'C',
      '1.7.6': 'C',
      '1.6.6': 'C',
      '1.6.8': 'C',
    })
  })

  it('images texte de chaque type : remplaçable = échec, exemption = conforme (1.8.2 à 1.8.5)', async () => {
    const answer = (value: string) => (question: Judgement) =>
      question.topic === 'image.role' ? value : 'pass'
    const replaceable = await settle('texte-types.html', answer('text-replaceable'))
    expect(statuses(replaceable.after, '1.8.2', '1.8.3', '1.8.4', '1.8.5')).toEqual({
      '1.8.2': 'NC',
      '1.8.3': 'NC',
      '1.8.4': 'NC',
      '1.8.5': 'NC',
    })
    const exempt = await settle('texte-types.html', answer('text-exempt'))
    expect(statuses(exempt.after, '1.8.2', '1.8.3', '1.8.4', '1.8.5')).toEqual({
      '1.8.2': 'C',
      '1.8.3': 'C',
      '1.8.4': 'C',
      '1.8.5': 'C',
    })
    // Sans texte dans l'image : 1.8.x non applicable.
    const plain = await settle('texte-types.html', answer('informative'))
    expect(statuses(plain.after, '1.8.2', '1.8.5')).toEqual({ '1.8.2': 'NA', '1.8.5': 'NA' })
  })

  it('légendes de chaque type : 1.9.2, 1.9.3, 1.9.5', async () => {
    const ok = await settle('legende-types-ok.html', (question) =>
      question.topic === 'image.role' ? 'informative' : 'pass',
    )
    expect(statuses(ok.after, '1.9.1', '1.9.2', '1.9.3', '1.9.5')).toEqual({
      '1.9.1': 'C',
      '1.9.2': 'C',
      '1.9.3': 'C',
      '1.9.5': 'C',
    })
    const ko = await settle('legende-types-ko.html', (question) =>
      question.topic === 'image.role' ? 'informative' : 'pass',
    )
    expect(statuses(ko.after, '1.9.2', '1.9.3', '1.9.5')).toEqual({
      '1.9.2': 'NC',
      '1.9.3': 'NC',
      '1.9.5': 'NC',
    })
  })

  it('aria-describedby valide : conforme une fois la description jugée', async () => {
    const { before, after } = await settle('info-ok.html', (question) =>
      question.topic === 'image.role' ? 'informative' : 'pass',
    )
    expect(before['1.6.9']?.status).toBe('AV')
    expect(after['1.6.9']?.status).toBe('C')
  })
})

describe('États non visibles au chargement', () => {
  it('audite les images d’un panneau replié ou d’un détail fermé', async () => {
    const before = await bench.audit(checks, '01-images/replie.html')
    const sources = pendingOf(before).map((question) => question.evidence.source)
    expect(sources).toContain('/01-images/a.png')
    expect(sources).toContain('/01-images/b.png')
    const after = await bench.audit(checks, '01-images/replie.html', {
      decisions: decisionsFor(before, role('informative')),
    })
    // « photo.jpg » dans le details, « image » dans le panneau : deux échecs de pertinence.
    expect(after['1.3.1']?.status).toBe('NC')
    expect(after['1.3.1']?.failures).toHaveLength(2)
  })
})
