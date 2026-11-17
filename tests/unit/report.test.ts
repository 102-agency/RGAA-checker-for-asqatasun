import { describe, expect, it } from 'vitest'
import { loadCatalog } from '../../src/core/catalog.ts'
import type { AuditResult } from '../../src/core/runner.ts'
import type { PageReport, TestResult } from '../../src/core/types.ts'
import { renderHtml } from '../../src/report/html.ts'
import { renderMarkdown } from '../../src/report/markdown.ts'
import {
  auditFailed,
  buildReport,
  criterionStatus,
  type ReportDocument,
  siteOverview,
} from '../../src/report/model.ts'
import { parseReport } from '../../src/report/parse.ts'
import { renderText } from '../../src/report/text.ts'

const catalog = loadCatalog()
const style = { color: false, width: 100 }

function result(test: string, partial: Partial<TestResult>): TestResult {
  return {
    test,
    status: 'C',
    failures: [],
    failureCount: 0,
    pending: [],
    notes: [],
    checked: 1,
    ...partial,
  }
}

const HOSTILE =
  '\u001b[2J\u001b]0;pwned\u0007<script>alert(1)</script> [x](javascript:alert(1)) `a`'

const failing = (path: string): PageReport => ({
  url: `https://exemple.fr${path}`,
  path,
  httpStatus: 200,
  results: {
    '1.1.1': result('1.1.1', {
      status: 'NC',
      failureCount: 1,
      checked: 4,
      failures: [
        {
          message: `Image sans alternative ${HOSTILE}`,
          selector: 'body > header > img',
          snippet: `<img src="logo.png" onerror="${HOSTILE}">`,
        },
      ],
    }),
    '2.1.1': result('2.1.1', { status: 'C' }),
    '2.2.1': result('2.2.1', {
      status: 'AV',
      pending: [
        {
          topic: 'frame.title',
          key: 'aaaaaaaaaaaa',
          question: 'Ce titre est-il pertinent ?',
          answers: ['pass', 'fail'],
          evidence: { title: 'Carte' },
        },
      ],
    }),
    '8.5.1': result('8.5.1', { status: 'NA', checked: 0 }),
  },
})

function makeReport(strict = false): ReportDocument {
  const audit: AuditResult = {
    pages: [
      failing('/'),
      failing('/contact'),
      {
        url: 'https://exemple.fr/cassee',
        path: '/cassee',
        httpStatus: 500,
        error: "La page répond 500 : elle n'est pas auditée.",
        results: {},
      },
    ],
    pending: [
      {
        topic: 'frame.title',
        key: 'aaaaaaaaaaaa',
        question: 'Ce titre est-il pertinent ?',
        answers: ['pass', 'fail'],
        evidence: { title: HOSTILE },
        tests: ['2.2.1'],
        pages: ['https://exemple.fr/', 'https://exemple.fr/contact'],
        screenshot: '../../etc/passwd',
      },
    ],
  }
  return buildReport({
    audit,
    catalog,
    asqatasun: new Map(),
    filter: (test) => ['1.1.1', '2.1.1', '2.2.1', '8.5.1'].includes(test),
    tool: { name: 'rgaa-checker', version: '1.0.0' },
    meta: {
      baseUrl: 'https://exemple.fr/',
      startedAt: '2026-11-17T10:00:00.000Z',
      durationMs: 65_000,
      pagesSource: 'sitemap',
      pagesDropped: 0,
      scope: { themes: [], criteria: [], tests: ['1.1.1'] },
      decisionsDir: '/tmp/decisions',
      decisionsCount: 0,
      unusedDecisions: null,
      asqatasunDir: null,
      asqatasunReports: 0,
      strict,
    },
  })
}

describe('modèle de rapport', () => {
  const report = makeReport()

  it('classe les pages et calcule les taux', () => {
    expect(report.pages.map((page) => page.state)).toEqual([
      'non-conforme',
      'non-conforme',
      'non-auditee',
    ])
    const home = report.pages[0]
    expect(home?.counts).toMatchObject({ C: 1, NC: 1, AV: 1, NA: 1, NT: 0 })
    // 3 critères : 1.1 NC, 2.1 C, 2.2 ouvert (AV) ; 8.5 NA → taux = 1 / (1 + 1)
    expect(home?.criteriaScore).toBe(50)
    expect(home?.settled).toBe(false)
  })

  it('une page non auditée n’a ni taux ni verdict inventé', () => {
    const broken = report.pages[2]
    expect(broken?.score).toBeNull()
    expect(broken?.criteriaScore).toBeNull()
    expect(broken?.tests.every((entry) => entry.final === 'NT')).toBe(true)
  })

  it('critère : non conforme > ouvert > conforme > non applicable', () => {
    expect(criterionStatus(['C', 'NC', 'AV'])).toBe('NC')
    expect(criterionStatus(['C', 'AV'])).toBe('open')
    expect(criterionStatus(['C', 'ERR'])).toBe('open')
    expect(criterionStatus(['C', 'NA'])).toBe('C')
    expect(criterionStatus(['NA', 'NA'])).toBe('NA')
  })

  it('dédoublonne un même échec répété sur plusieurs pages', () => {
    const overview = siteOverview(report)
    const issue = overview.issues.find((item) => item.test === '1.1.1')
    expect(issue?.pages).toEqual(['/', '/contact'])
    expect(issue?.findings).toHaveLength(1)
    expect(issue?.findings[0]?.pages).toEqual(['/', '/contact'])
  })

  it('code de sortie : un échec ou une page non auditée font échouer l’audit', () => {
    expect(auditFailed(report)).toBe(true)
  })

  it('--strict : des tests à valider font échouer un audit sans autre échec', () => {
    const open = makeReport(true)
    for (const page of open.pages) {
      page.counts.NC = 0
      page.counts.NT = 0
      page.error = undefined
    }
    expect(auditFailed(open)).toBe(true)
    open.meta.strict = false
    expect(auditFailed(open)).toBe(false)
  })

  it('s’aller-retour JSON → parseReport conserve le document', () => {
    const copy = parseReport(JSON.parse(JSON.stringify(report)), 'test')
    expect(copy.pages).toHaveLength(3)
    expect(copy.pending[0]?.key).toBe('aaaaaaaaaaaa')
  })

  it('parseReport refuse un document altéré', () => {
    const data = JSON.parse(JSON.stringify(report))
    data.pages[0].counts.NC = 'beaucoup'
    expect(() => parseReport(data, 'rapport.json')).toThrow(/counts\.NC doit être un nombre/)
    const bad = JSON.parse(JSON.stringify(report))
    bad.pending[0].key = '../../x'
    expect(() => parseReport(bad, 'rapport.json')).toThrow(/key invalide/)
    expect(() => parseReport({ format: 'autre' }, 'rapport.json')).toThrow(/format inconnu/)
  })
})

describe('rapport texte (terminal)', () => {
  const report = makeReport()

  it('donne le verdict, les taux et le tableau des pages', () => {
    const text = renderText(report, catalog, { style, detail: 'problemes' })
    expect(text).toContain('✗ NON CONFORME')
    expect(text).toContain('Taux de conformité du site')
    expect(text).toContain('/contact')
    expect(text).toContain('non auditée')
  })

  it('explique chaque non-conformité : critère, test, élément fautif, code, pages', () => {
    const text = renderText(report, catalog, { style, detail: 'problemes' })
    expect(text).toContain('Thématique 1 — Images')
    expect(text).toContain('Critère 1.1')
    expect(text).toContain('Test 1.1.1')
    expect(text).toContain('Image sans alternative')
    expect(text).toContain('body > header > img')
    expect(text).toContain('<img src="logo.png"')
    expect(text).toContain('Pages')
  })

  it('n’émet aucune séquence d’échappement venue de la page, même en couleur', () => {
    const text = renderText(report, catalog, { style: { color: true, width: 100 }, detail: 'tout' })
    // Les seules séquences ESC présentes sont les couleurs de l'outil (CSI … m).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: vérifie précisément cela.
    const foreign = text.replace(/\u001b\[\d+m/g, '').match(/[\u0000-\u0008\u000b-\u001f\u007f]/g)
    expect(foreign).toBeNull()
    expect(text).not.toContain('pwned\u0007')
  })

  it('les questions en attente disent ce qui est jugé, pas seulement la question générique', () => {
    const text = renderText(report, catalog, { style, detail: 'problemes' })
    expect(text).toContain('Par sujet')
    expect(text).toContain('frame.title')
    expect(text).toContain('Ce titre est-il pertinent ?')
    expect(text).toContain('title')
    expect(text).not.toContain('Réponses :')
  })

  it('--detail synthese ne détaille pas les constats', () => {
    const text = renderText(report, catalog, { style, detail: 'synthese' })
    expect(text).not.toContain('Test 1.1.1')
    expect(text).toContain('Pages (3)')
  })

  it('--detail tout détaille chaque page, test par test', () => {
    const text = renderText(report, catalog, { style, detail: 'tout' })
    expect(text).toContain('Page /contact')
    expect(text).toContain('2.2.1  À valider')
    expect(text).toContain('2.1.1  Conforme')
  })

  it('--page limite le détail aux pages demandées', () => {
    const text = renderText(report, catalog, { style, detail: 'problemes', pages: ['/contact'] })
    expect(text).toContain('Page /contact')
    expect(text).not.toMatch(/^══ Page \/ ═/m)
  })

  it('ne dépasse pas la largeur demandée', () => {
    const text = renderText(report, catalog, {
      style: { color: false, width: 80 },
      detail: 'problemes',
    })
    const wide = text.split('\n').filter((line) => Array.from(line).length > 82)
    expect(wide).toEqual([])
  })

  it('n’affiche pas de verdict « conforme » quand des tests restent ouverts', () => {
    const open = makeReport()
    const only = open.pages[0]
    if (!only) throw new Error('page absente')
    only.counts = { C: 3, NC: 0, NA: 1, AV: 1, ERR: 0, NT: 0 }
    only.tests = only.tests.filter((entry) => entry.final !== 'NC')
    open.pages = [only]
    const text = renderText(open, catalog, { style, detail: 'problemes' })
    expect(text).not.toContain('✓ CONFORME')
    expect(text).toContain('CONFORMITÉ NON DÉMONTRÉE')
  })
})

describe('rapport Markdown', () => {
  const markdown = renderMarkdown(makeReport(), catalog)

  it('est structuré et lisible', () => {
    expect(markdown).toContain('# Audit RGAA 4.1.2')
    expect(markdown).toContain('## Non-conformités (1)')
    expect(markdown).toContain('Test 1.1.1')
    expect(markdown).toContain('```html')
  })

  it('neutralise le contenu hostile hors des blocs de code', () => {
    // Dans un bloc de code délimité, le contenu est littéral pour tout moteur Markdown :
    // c'est l'endroit prévu pour afficher un extrait de HTML.
    const outsideFences = markdown.replace(/^[ \t]*(`{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*$/gm, '')
    expect(outsideFences).not.toContain('<script>')
    expect(outsideFences).not.toContain('](javascript:')
    expect(markdown).not.toContain('\u001b')
    expect(markdown).not.toContain('\u0007')
  })

  it('un extrait de code ne peut pas refermer son bloc', () => {
    const fences = markdown.match(/^[ \t]*`{3,}html$/gm) ?? []
    expect(fences.length).toBeGreaterThan(0)
  })
})

describe('rapport HTML', () => {
  const html = renderHtml(makeReport(), catalog)

  it('échappe tout contenu de page', () => {
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('onerror="\u001b')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('\u001b')
  })

  it('n’autorise aucun script (CSP) ni référencement externe', () => {
    expect(html).toContain("default-src 'none'")
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<(link|iframe|object|embed)\b/i)
    // Un gestionnaire d'événement dans une vraie balise (le texte échappé d'un <pre> n'en est pas un).
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i)
  })

  it('ne charge aucune capture dont le chemin sort de preuves/', () => {
    expect(html).not.toContain('etc/passwd')
    expect(html).not.toContain('<img')
  })

  it('est un document de langue française', () => {
    expect(html).toContain('<html lang="fr">')
  })
})
