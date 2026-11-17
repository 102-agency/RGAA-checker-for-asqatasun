import { ASQATASUN_LABEL } from '../core/asqatasun.ts'
import { type Catalog, compareIds, criterionOf, themeOf } from '../core/catalog.ts'
import type { Failure, Status } from '../core/types.ts'
import { safeLine } from '../security/text.ts'
import {
  type Finding,
  type PageEntry,
  type PageState,
  type ReportDocument,
  type SiteOverview,
  siteOverview,
  type TestEntry,
} from './model.ts'
import {
  badge,
  duration,
  frDate,
  frNumber,
  padEnd,
  padStart,
  paint,
  plural,
  STATUS_MEANING,
  STATUS_SYMBOL,
  STATUS_TEXT,
  STATUS_TONE,
  type Style,
  wrap,
} from './style.ts'

/**
 * Rapport lisible dans un terminal.
 *
 * Trois niveaux de détail :
 * - `synthese`  : bilan et tableau des pages ;
 * - `problemes` : en plus, chaque non-conformité (dédoublonnée entre pages,
 *                 avec l'élément fautif et son code), les questions en attente,
 *                 les erreurs de l'outil et les tests non couverts ;
 * - `tout`      : en plus, le détail de chaque page, test par test, verdicts
 *                 conformes et non applicables compris.
 */
export type Detail = 'synthese' | 'problemes' | 'tout'
export const DETAILS: readonly Detail[] = ['synthese', 'problemes', 'tout']

export interface TextOptions {
  style: Style
  detail: Detail
  /** Restreint le détail par page à ces chemins (implique le détail de ces pages). */
  pages?: string[]
  /** Fichiers écrits, affichés en fin de rapport. */
  files?: { label: string; path: string }[]
  /** Nombre maximal de constats affichés par test en mode `problemes`. */
  maxFindings?: number
}

const STATE_LABEL: Record<PageState, string> = {
  conforme: '100 % confirmé',
  'a-valider': 'à valider',
  'non-conforme': 'non conforme',
  'non-auditee': 'non auditée',
}
const STATE_STATUS: Record<PageState, Status> = {
  conforme: 'C',
  'a-valider': 'AV',
  'non-conforme': 'NC',
  'non-auditee': 'ERR',
}

class Writer {
  readonly lines: string[] = []
  constructor(readonly style: Style) {}

  get width(): number {
    return this.style.width
  }

  line(text = ''): void {
    this.lines.push(text)
  }

  /** Paragraphe coupé à la largeur du terminal. */
  para(text: string, indent = '', first = indent, tone?: Parameters<typeof paint>[1]): void {
    for (const line of wrap(text, this.width, indent, first)) {
      this.lines.push(tone ? paint(this.style, tone, line) : line)
    }
  }

  section(title: string): void {
    const label = ` ${title} `
    const rule = '═'.repeat(Math.max(4, this.width - label.length - 3))
    this.line()
    this.line(paint(this.style, 'bold', `══${label}${rule}`))
  }

  paint(tone: Parameters<typeof paint>[1], text: string): string {
    return paint(this.style, tone, text)
  }
}

function listPages(pages: readonly string[], max = 6): string {
  const shown = pages.slice(0, max).map((page) => safeLine(page, 120))
  return pages.length > max ? `${shown.join(', ')} (+ ${pages.length - max})` : shown.join(', ')
}

function rate(value: number | null): string {
  return value === null ? '—' : `${frNumber(value)} %`
}

// ─── En-tête et bilan ──────────────────────────────────────────────────────

function header(w: Writer, report: ReportDocument): void {
  const { meta } = report
  w.line(w.paint('bold', `Audit RGAA 4.1.2 — niveau AA`))
  const rows: [string, string][] = [
    ['Site', safeLine(meta.baseUrl, 300)],
    ['Date', `${frDate(meta.startedAt)} · durée ${duration(meta.durationMs)}`],
    [
      'Pages',
      `${report.pages.length} (${meta.pagesSource === 'sitemap' ? 'sitemap' : 'chemins donnés'})${
        meta.pagesDropped ? `, ${meta.pagesDropped} autres écartées par --limit` : ''
      }`,
    ],
  ]
  const scope = [
    meta.scope.themes.length ? `thématiques ${meta.scope.themes.join(', ')}` : '',
    meta.scope.criteria.length ? `critères ${meta.scope.criteria.join(', ')}` : '',
    meta.scope.tests.length ? `tests ${meta.scope.tests.join(', ')}` : '',
  ].filter(Boolean)
  rows.push(['Périmètre', scope.length ? scope.join(' · ') : 'tout le référentiel (258 tests)'])
  rows.push([
    'Asqatasun',
    meta.asqatasunDir
      ? `${plural(meta.asqatasunReports, 'export fusionné', 'exports fusionnés')} (le plus récent par page)`
      : 'aucun export fusionné (--asqatasun)',
  ])
  rows.push([
    'Décisions',
    `${plural(meta.decisionsCount, 'jugement enregistré', 'jugements enregistrés')}`,
  ])
  for (const [label, value] of rows) w.para(value, ' '.repeat(14), `  ${padEnd(label, 12)}`)
}

function headline(w: Writer, overview: SiteOverview): void {
  const failing = overview.issues.length
  const broken = overview.states['non-auditee']
  if (failing > 0) {
    w.line(
      `  ${w.paint('red', `✗ NON CONFORME`)} — ${plural(failing, 'test en échec', 'tests en échec')} sur ${plural(
        overview.states['non-conforme'],
        'page',
      )}`,
    )
  } else if (broken > 0 || overview.openTests > 0) {
    w.line(
      `  ${w.paint('yellow', '? CONFORMITÉ NON DÉMONTRÉE')} — aucun échec constaté, mais ${plural(
        overview.openTests,
        'test reste ouvert',
        'tests restent ouverts',
      )}${broken ? ` et ${plural(broken, 'page n’a pu être auditée', 'pages n’ont pu être auditées')}` : ''}`,
    )
  } else {
    w.line(`  ${w.paint('green', '✓ CONFORME')} — toutes les pages auditées sont à 100 % confirmé`)
  }
  if (broken > 0 && failing > 0) {
    w.line(
      `  ${w.paint('magenta', '⚠')} ${plural(broken, 'page non auditée', 'pages non auditées')} : audit incomplet`,
    )
  }
}

function summary(w: Writer, overview: SiteOverview): void {
  w.section('Bilan')
  headline(w, overview)
  w.line()
  const provisional = overview.openTests > 0 ? w.paint('yellow', ' (provisoire)') : ''
  w.line(
    `  Taux de conformité du site (critères)  ${w.paint('bold', rate(overview.globalRate))}${provisional}`,
  )
  w.line(`  Taux moyen des pages                   ${rate(overview.averageRate)}`)
  if (overview.openTests > 0) {
    w.para(
      `Provisoire : ${plural(overview.openTests, 'test reste ouvert', 'tests restent ouverts')} (à valider, en erreur ou non testé). Un taux n'est définitif que lorsque plus aucun test n'est ouvert.`,
      '    ',
      '    ',
      'dim',
    )
  }
  w.line()
  w.line('  Pages')
  const rows: [PageState, string][] = [
    ['conforme', 'à 100 % confirmé (aucun échec, rien d’ouvert)'],
    ['a-valider', 'sans échec, mais des tests restent ouverts'],
    ['non-conforme', 'avec au moins une non-conformité'],
    ['non-auditee', 'non auditées (erreur de chargement)'],
  ]
  for (const [state, label] of rows) {
    if (state === 'non-auditee' && overview.states[state] === 0) continue
    w.line(
      `    ${badge(w.style, STATE_STATUS[state], padStart(String(overview.states[state]), 4))}  ${label}`,
    )
  }
  w.line()
  const c = overview.criteria
  w.line('  Critères (sur tout le site)')
  w.line(
    `    ${w.paint('green', `✓ ${plural(c.C, 'conforme')}`)} · ${w.paint('red', `✗ ${plural(c.NC, 'non conforme')}`)} · ${w.paint('gray', `– ${plural(c.NA, 'non applicable')}`)} · ${w.paint('yellow', `? ${plural(c.open, 'ouvert')}`)}`,
  )
  w.line(`  Questions de jugement en attente  ${overview.pending}`)
}

function pagesTable(w: Writer, report: ReportDocument): void {
  w.section(`Pages (${report.pages.length})`)
  const pathWidth = Math.min(
    40,
    Math.max(6, ...report.pages.map((page) => Array.from(safeLine(page.path)).length)),
  )
  w.line(
    w.paint(
      'dim',
      `  ${padEnd('Page', pathWidth)}  ${padEnd('État', 18)}  ${padStart('Critères', 9)}  ${padStart('NC', 4)}  ${padStart('À valider', 9)}  ${padStart('Erreur', 6)}  ${padStart('Non testé', 9)}`,
    ),
  )
  for (const page of report.pages) {
    const path = safeLine(page.path, pathWidth)
    const state = badge(w.style, STATE_STATUS[page.state], STATE_LABEL[page.state])
    const provisional = page.settled ? ' ' : '*'
    const nc = page.counts.NC ? w.paint('red', String(page.counts.NC)) : '0'
    const av = page.counts.AV ? w.paint('yellow', String(page.counts.AV)) : '0'
    const err = page.counts.ERR ? w.paint('magenta', String(page.counts.ERR)) : '0'
    w.line(
      `  ${padEnd(path, pathWidth)}  ${padEnd(state, 18)}  ${padStart(rate(page.criteriaScore) + provisional, 9)}  ${padStart(nc, 4)}  ${padStart(av, 9)}  ${padStart(err, 6)}  ${padStart(String(page.counts.NT), 9)}`,
    )
    if (page.error)
      w.para(page.error, `  ${' '.repeat(pathWidth)}  `, `  ${' '.repeat(pathWidth)}  `, 'magenta')
  }
  w.line(w.paint('dim', '  * taux provisoire : des tests restent ouverts sur la page.'))
}

// ─── Constats ──────────────────────────────────────────────────────────────

/** Regroupe des identifiants de tests par thématique puis par critère, dans l'ordre du RGAA. */
function groupByCriterion<T extends { test: string }>(
  items: readonly T[],
): Map<number, Map<string, T[]>> {
  const out = new Map<number, Map<string, T[]>>()
  for (const item of [...items].sort((a, b) => compareIds(a.test, b.test))) {
    const theme = themeOf(item.test)
    const criteria = out.get(theme) ?? new Map<string, T[]>()
    const criterion = criterionOf(item.test)
    const list = criteria.get(criterion) ?? []
    list.push(item)
    criteria.set(criterion, list)
    out.set(theme, criteria)
  }
  return out
}

function themeHeading(w: Writer, catalog: Catalog, theme: number): void {
  w.line()
  w.line(`  ${w.paint('bold', `Thématique ${theme} — ${catalog.themes.get(theme) ?? ''}`)}`)
}

function criterionHeading(w: Writer, catalog: Catalog, criterion: string): void {
  const info = catalog.criteria.get(criterion)
  w.para(
    `${info?.title ?? ''}${info?.level ? ` [niveau ${info.level}]` : ''}`,
    '              ',
    `    ${w.paint('bold', `Critère ${criterion}`)}  `,
  )
}

function failureLines(
  w: Writer,
  failure: Failure | Finding,
  index: number,
  indent: string,
  showPages: boolean,
): void {
  const marker = `${indent}${w.paint('red', `${index}.`)} `
  w.para(failure.message, `${indent}   `, marker)
  const sub = `${indent}   `
  if (failure.selector)
    w.para(failure.selector, `${sub}${' '.repeat(10)}`, `${sub}${w.paint('dim', 'Élément ')}  `)
  if (failure.snippet) {
    for (const line of wrap(
      failure.snippet,
      w.width,
      `${sub}${' '.repeat(10)}`,
      `${sub}${'Code'.padEnd(10)}`,
    )) {
      w.line(w.paint('dim', line))
    }
  }
  if (showPages && 'pages' in failure) {
    w.para(
      listPages(failure.pages),
      `${sub}${' '.repeat(10)}`,
      `${sub}${w.paint('dim', 'Pages   ')}  `,
    )
  }
}

function issuesSection(
  w: Writer,
  report: ReportDocument,
  overview: SiteOverview,
  catalog: Catalog,
  maxFindings: number,
): void {
  w.section(`Non-conformités (${plural(overview.issues.length, 'test', 'tests')})`)
  if (overview.issues.length === 0) {
    w.line(`  ${w.paint('green', '✓')} Aucune non-conformité constatée.`)
    return
  }
  w.para(
    'Chaque échec n’est listé qu’une fois, avec les pages où il se répète. « Élément » est le sélecteur CSS de l’élément fautif, « Code » son extrait HTML.',
    '  ',
    '  ',
    'dim',
  )
  const multiPage = report.pages.length > 1
  for (const [theme, criteria] of groupByCriterion(overview.issues)) {
    themeHeading(w, catalog, theme)
    for (const [criterion, issues] of criteria) {
      criterionHeading(w, catalog, criterion)
      for (const issue of issues) {
        const where = multiPage
          ? ` — ${plural(issue.pages.length, 'page')} : ${listPages(issue.pages, 4)}`
          : ''
        w.line(`      ${badge(w.style, 'NC', `Test ${issue.test}`)}${where}`)
        w.para(catalog.byTest.get(issue.test)?.title ?? '', '        ', '        ', 'dim')
        const shown = issue.findings.slice(0, maxFindings)
        shown.forEach((finding, index) => {
          failureLines(w, finding, index + 1, '        ', multiPage)
        })
        const hidden = issue.findings.length - shown.length
        if (hidden > 0) {
          w.line(
            w.paint(
              'dim',
              `        … et ${plural(hidden, 'autre constat', 'autres constats')} (--detail tout, ou le rapport HTML).`,
            ),
          )
        }
        if (issue.undetailed > 0) {
          w.line(
            w.paint(
              'dim',
              `        + ${plural(issue.undetailed, 'échec compté', 'échecs comptés')} au-delà du plafond de détail par page.`,
            ),
          )
        }
        if (issue.asqatasunOnly.length > 0) {
          w.para(
            `Non conforme selon Asqatasun seulement, sur ${listPages(issue.asqatasunOnly, 4)} : voir le détail dans son export.`,
            '           ',
            `        ${w.paint('red', '•')}  `,
          )
        }
      }
    }
  }
}

function pendingSection(w: Writer, report: ReportDocument): void {
  w.section(`Questions à trancher (${report.pending.length})`)
  if (report.pending.length === 0) {
    w.line(`  ${w.paint('green', '✓')} Aucune question en attente.`)
    return
  }
  w.para(
    'Ces tests dépendent d’un jugement humain (pertinence d’une alternative, image décorative…). Chaque réponse est enregistrée une fois et vaut pour toutes les pages qui présentent le même contenu.',
    '  ',
  )
  const shown = report.pending.slice(0, 5)
  for (const item of shown) {
    w.para(item.question, '                    ', `  ${w.paint('yellow', `? ${item.key}`)}  `)
    w.line(
      w.paint(
        'dim',
        `                    tests ${item.tests.join(', ')} · ${plural(item.pages.length, 'page')}`,
      ),
    )
  }
  if (report.pending.length > shown.length) {
    w.line(w.paint('dim', `  … et ${report.pending.length - shown.length} autres.`))
  }
  w.line()
  w.line(`  Pour les voir en détail       ${w.paint('cyan', 'rgaa pending')}`)
  w.line(`  Pour y répondre une à une     ${w.paint('cyan', 'rgaa decide')}`)
}

function errorsSection(w: Writer, overview: SiteOverview): void {
  if (overview.errors.length === 0) return
  w.section(`Erreurs de l’outil (${overview.errors.length})`)
  w.para(
    'Ces vérifications ont planté : leur résultat est inconnu, ce qui n’est ni un succès ni un échec. Relancer l’audit ; si l’erreur persiste, c’est un défaut de l’outil.',
    '  ',
    '  ',
    'dim',
  )
  for (const error of overview.errors) {
    w.line(`  ${badge(w.style, 'ERR', `Test ${error.test}`)} — ${listPages(error.pages, 4)}`)
    for (const message of error.messages.slice(0, 3)) w.para(message, '      ', '      ', 'magenta')
  }
}

function untestedSection(w: Writer, overview: SiteOverview, catalog: Catalog): void {
  if (overview.untested.length === 0) return
  w.section(`Non testés (${overview.untested.length})`)
  w.para(
    'Aucune vérification automatique n’existe pour ces tests : ils doivent être audités à la main (ou couverts par Asqatasun) avant de déclarer une page conforme.',
    '  ',
    '  ',
    'dim',
  )
  const byTheme = new Map<number, string[]>()
  for (const test of overview.untested) {
    const list = byTheme.get(themeOf(test)) ?? []
    list.push(test)
    byTheme.set(themeOf(test), list)
  }
  for (const [theme, tests] of byTheme) {
    const label = `${theme}. ${catalog.themes.get(theme) ?? ''}`
    w.para(tests.join(' '), `  ${' '.repeat(34)}`, `  ${padEnd(safeLine(label, 32), 32)}  `)
  }
}

// ─── Détail d'une page ─────────────────────────────────────────────────────

function testLine(w: Writer, entry: TestEntry, catalog: Catalog): void {
  const head = badge(w.style, entry.final, `${entry.test}  ${STATUS_TEXT[entry.final]}`)
  let extra = ''
  if (entry.final === 'C')
    extra = entry.checked
      ? ` — ${plural(entry.checked, 'élément contrôlé', 'éléments contrôlés')}`
      : ''
  else if (entry.final === 'NC' && entry.failureCount > 0) {
    extra = ` — ${plural(entry.failureCount, 'échec')}${entry.checked > entry.failureCount ? ` sur ${entry.checked} cas contrôlés` : ''}`
  } else if (entry.final === 'AV')
    extra = ` — ${plural(entry.pending.length, 'question', 'questions')} en attente`
  else extra = ` — ${STATUS_MEANING[entry.final]}`
  w.line(`      ${head}${w.paint('dim', extra)}`)
  if (entry.final === 'C' || entry.final === 'NA' || entry.final === 'NT') {
    if (entry.notes.length === 0 && !entry.asqatasun) return
  } else {
    w.para(catalog.byTest.get(entry.test)?.title ?? '', '        ', '        ', 'dim')
  }
  entry.failures.forEach((failure, index) => {
    failureLines(w, failure, index + 1, '        ', false)
  })
  if (entry.failureCount > entry.failures.length) {
    w.line(
      w.paint(
        'dim',
        `        + ${entry.failureCount - entry.failures.length} échecs non détaillés.`,
      ),
    )
  }
  for (const pending of entry.pending) {
    w.para(
      pending.question,
      '                       ',
      `        ${w.paint('yellow', `? ${pending.key}`)}  `,
    )
  }
  if (entry.asqatasun === 'NC' && entry.tool !== 'NC') {
    w.para(
      'Non conforme selon Asqatasun (voir le détail dans son export).',
      '           ',
      `        ${w.paint('red', '•')}  `,
    )
  }
  if (entry.disagreement) {
    w.para(
      `Divergence : l’outil dit « ${STATUS_TEXT[entry.tool]} », Asqatasun « ${entry.asqatasun ? ASQATASUN_LABEL[entry.asqatasun] : ''} ».`,
      '           ',
      `        ${w.paint('yellow', '≠')}  `,
    )
  }
  for (const note of entry.notes)
    w.para(note, '           ', `        ${w.paint('blue', 'ⓘ')}  `, undefined)
}

function pageDetail(w: Writer, page: PageEntry, catalog: Catalog, all: boolean): void {
  w.section(`Page ${safeLine(page.path, 80)}`)
  w.line(`  ${safeLine(page.url, 300)}`)
  w.line(
    `  ${badge(w.style, STATE_STATUS[page.state], STATE_LABEL[page.state])} · taux critères ${rate(page.criteriaScore)}${page.settled ? '' : ' (provisoire)'} · taux tests ${rate(page.score)}`,
  )
  if (page.error) {
    w.para(page.error, '  ', '  ', 'magenta')
    return
  }
  const counts = (['C', 'NC', 'AV', 'NA', 'ERR', 'NT'] as const)
    .map((status) =>
      paint(
        w.style,
        STATUS_TONE[status],
        `${STATUS_SYMBOL[status]} ${page.counts[status]} ${STATUS_TEXT[status].toLowerCase()}`,
      ),
    )
    .join(' · ')
  w.para(counts, '  ')
  if (page.asqatasun) {
    w.line(
      w.paint(
        'dim',
        `  Asqatasun : ${safeLine(page.asqatasun.file, 100)}, note ${safeLine(page.asqatasun.score, 20) || '—'}`,
      ),
    )
  }
  const shown = all
    ? page.tests.filter((entry) => entry.final !== 'NT' || entry.asqatasun)
    : page.tests.filter((entry) => !['C', 'NA', 'NT'].includes(entry.final) || entry.disagreement)
  if (shown.length === 0) {
    w.line()
    w.line(`  ${w.paint('green', '✓')} Rien à traiter sur cette page (hors tests non testés).`)
  }
  for (const [theme, criteria] of groupByCriterion(shown)) {
    themeHeading(w, catalog, theme)
    for (const [criterion, entries] of criteria) {
      criterionHeading(w, catalog, criterion)
      for (const entry of entries) testLine(w, entry, catalog)
    }
  }
  const untested = page.tests.filter((entry) => entry.final === 'NT' && !entry.asqatasun)
  if (untested.length > 0) {
    w.line()
    w.para(
      `${untested.length} tests non testés sur cette page : ${untested.map((entry) => entry.test).join(' ')}`,
      '    ',
      `  ${w.paint('gray', '·')} `,
      'dim',
    )
  }
  if (!all) {
    const hidden = page.tests.filter((entry) => entry.final === 'C' || entry.final === 'NA').length
    if (hidden > 0) {
      w.line(
        w.paint(
          'dim',
          `  ${hidden} tests conformes ou non applicables masqués (--detail tout pour les voir).`,
        ),
      )
    }
  }
}

// ─── Assemblage ────────────────────────────────────────────────────────────

function legend(w: Writer): void {
  const label = (status: Status) => `${STATUS_SYMBOL[status]} ${STATUS_TEXT[status].toLowerCase()}`
  w.line()
  w.line(w.paint('dim', `  Légende : ${(['C', 'NC', 'AV'] as const).map(label).join(' · ')}`))
  w.line(w.paint('dim', `            ${(['NA', 'ERR', 'NT'] as const).map(label).join(' · ')}`))
}

export function renderText(report: ReportDocument, catalog: Catalog, options: TextOptions): string {
  const w = new Writer(options.style)
  const overview = siteOverview(report)
  header(w, report)
  summary(w, overview)
  pagesTable(w, report)

  if (options.detail !== 'synthese') {
    issuesSection(
      w,
      report,
      overview,
      catalog,
      options.detail === 'tout' ? Number.POSITIVE_INFINITY : (options.maxFindings ?? 8),
    )
    pendingSection(w, report)
    errorsSection(w, overview)
    untestedSection(w, overview, catalog)
  }

  const selected = options.pages?.length
    ? report.pages.filter((page) => options.pages?.includes(page.path))
    : options.detail === 'tout'
      ? report.pages
      : []
  for (const page of selected) pageDetail(w, page, catalog, options.detail === 'tout')

  legend(w)
  if (options.files?.length) {
    w.section('Fichiers')
    const width = Math.max(...options.files.map((file) => file.label.length))
    for (const file of options.files) w.line(`  ${padEnd(file.label, width)}  ${file.path}`)
  }
  return `${w.lines.join('\n')}\n`
}

/** Une ligne de progression par page auditée (sur la sortie d'erreur). */
export function progressLine(
  style: Style,
  page: { path: string; error?: string; results: Record<string, { status: Status }> },
  done: number,
  total: number,
): string {
  const counter = paint(style, 'dim', `[${String(done).padStart(String(total).length)}/${total}]`)
  const path = safeLine(page.path, 60)
  if (page.error)
    return `  ${counter} ${path}  ${paint(style, 'magenta', `⚠ ${safeLine(page.error, 200)}`)}`
  const results = Object.values(page.results)
  const count = (status: Status) => results.filter((result) => result.status === status).length
  const parts = [
    count('NC')
      ? paint(style, 'red', `✗ ${count('NC')} non conforme(s)`)
      : paint(style, 'green', '✓ aucun échec'),
    count('AV') ? paint(style, 'yellow', `? ${count('AV')} à valider`) : '',
    count('ERR') ? paint(style, 'magenta', `⚠ ${count('ERR')} erreur(s)`) : '',
  ].filter(Boolean)
  return `  ${counter} ${path}  ${parts.join(' · ')}`
}
