import {
  type AsqatasunReport,
  type AsqatasunStatus,
  disagrees,
  mergeStatus,
} from '../core/asqatasun.ts'
import type { Catalog } from '../core/catalog.ts'
import type { AuditResult } from '../core/runner.ts'
import type { Failure, Judgement, PageReport, Status } from '../core/types.ts'

/**
 * Modèle du rapport d'audit : un document unique, sérialisé dans `rapport.json`,
 * dont dérivent toutes les présentations (terminal, Markdown, HTML) et que
 * relisent les commandes `report`, `pending` et `decide`.
 */
export const REPORT_FORMAT = 'rgaa-checker/rapport@1'

/** Verdicts qui laissent un test ouvert : la page ne peut pas être déclarée à 100 %. */
export const OPEN_STATUSES: readonly Status[] = ['AV', 'ERR', 'NT']

export type PageState = 'conforme' | 'a-valider' | 'non-conforme' | 'non-auditee'

export interface PendingQuestion extends Judgement {
  /** Tests qui dépendent de cette question. */
  tests: string[]
  /** Pages où la question se pose. */
  pages: string[]
}

export interface TestEntry {
  test: string
  /** Verdict retenu : le plus sévère entre l'outil et Asqatasun. */
  final: Status
  /** Verdict de l'outil seul. */
  tool: Status
  asqatasun?: AsqatasunStatus
  /** Les deux outils statuent et se contredisent. */
  disagreement: boolean
  /** Éléments ou cas contrôlés sur la page. */
  checked: number
  failureCount: number
  failures: Failure[]
  pending: { key: string; topic: string; question: string }[]
  notes: string[]
}

export interface CriteriaCounts {
  C: number
  NC: number
  NA: number
  /** Critères dont au moins un test reste ouvert (à valider, erreur, non testé). */
  open: number
}

export interface PageEntry {
  url: string
  path: string
  httpStatus: number | null
  error?: string
  state: PageState
  asqatasun?: { file: string; score: string }
  counts: Record<Status, number>
  criteria: CriteriaCounts
  /** Taux au niveau des tests, comme Asqatasun : C / (C + NC), en %. */
  score: number | null
  /** Taux RGAA officiel, au niveau des critères : C / (C + NC), en %. */
  criteriaScore: number | null
  /** Plus aucun test ouvert : les taux sont définitifs. */
  settled: boolean
  tests: TestEntry[]
}

export interface ReportScope {
  themes: string[]
  criteria: string[]
  tests: string[]
}

export interface ReportMeta {
  baseUrl: string
  startedAt: string
  durationMs: number
  pagesSource: 'sitemap' | 'arguments'
  /** Pages du sitemap écartées par `--limit`. */
  pagesDropped: number
  scope: ReportScope
  decisionsDir: string
  decisionsCount: number
  /** Décisions qui ne correspondent plus à aucun contenu (`null` si l'audit est partiel). */
  unusedDecisions: number | null
  asqatasunDir: string | null
  asqatasunReports: number
  strict: boolean
}

export interface ReportDocument {
  format: typeof REPORT_FORMAT
  tool: { name: string; version: string }
  meta: ReportMeta
  pages: PageEntry[]
  pending: PendingQuestion[]
}

export function emptyCounts(): Record<Status, number> {
  return { C: 0, NC: 0, NA: 0, AV: 0, ERR: 0, NT: 0 }
}

export function percent(conform: number, failing: number): number | null {
  return conform + failing === 0 ? null : Math.round((conform / (conform + failing)) * 1000) / 10
}

/**
 * Statut d'un critère à partir de ceux de ses tests (méthode RGAA) : non conforme
 * si un test l'est ; ouvert si un test reste ouvert ; conforme si un test l'est ;
 * sinon non applicable.
 */
export function criterionStatus(statuses: readonly Status[]): keyof CriteriaCounts {
  if (statuses.includes('NC')) return 'NC'
  if (statuses.some((status) => OPEN_STATUSES.includes(status))) return 'open'
  if (statuses.includes('C')) return 'C'
  return 'NA'
}

function countCriteria(tests: readonly TestEntry[]): CriteriaCounts {
  const byCriterion = new Map<string, Status[]>()
  for (const entry of tests) {
    const criterion = entry.test.split('.').slice(0, 2).join('.')
    const list = byCriterion.get(criterion) ?? []
    list.push(entry.final)
    byCriterion.set(criterion, list)
  }
  const criteria: CriteriaCounts = { C: 0, NC: 0, NA: 0, open: 0 }
  for (const statuses of byCriterion.values()) criteria[criterionStatus(statuses)] += 1
  return criteria
}

export function pageState(page: Pick<PageEntry, 'error' | 'counts' | 'settled'>): PageState {
  if (page.error) return 'non-auditee'
  if (page.counts.NC > 0) return 'non-conforme'
  return page.settled ? 'conforme' : 'a-valider'
}

/** Résumé d'une page : verdicts de l'outil fusionnés avec le dernier export Asqatasun. */
export function summarizePage(
  page: PageReport,
  catalog: Catalog,
  asqatasun: AsqatasunReport | undefined,
  filter: (test: string) => boolean = () => true,
): PageEntry {
  const tests: TestEntry[] = []
  for (const item of catalog.tests) {
    if (!filter(item.test)) continue
    const result = page.error ? undefined : page.results[item.test]
    const tool: Status = result?.status ?? 'NT'
    const external = page.error ? undefined : asqatasun?.results[item.test]
    const final = mergeStatus(tool, external)
    tests.push({
      test: item.test,
      final,
      tool,
      asqatasun: external,
      disagreement: disagrees(tool, external),
      checked: result?.checked ?? 0,
      failureCount: result?.failureCount ?? result?.failures.length ?? 0,
      failures: result?.failures ?? [],
      pending: (result?.pending ?? []).map(({ key, topic, question }) => ({
        key,
        topic,
        question,
      })),
      notes: result?.notes ?? [],
    })
  }

  return recountPage({
    url: page.url,
    path: page.path,
    httpStatus: page.httpStatus,
    error: page.error,
    state: 'a-valider',
    asqatasun: asqatasun ? { file: asqatasun.file, score: asqatasun.score } : undefined,
    counts: emptyCounts(),
    criteria: { C: 0, NC: 0, NA: 0, open: 0 },
    score: null,
    criteriaScore: null,
    settled: false,
    tests,
  })
}

/** Recalcule décomptes, taux et état d'une page à partir de ses tests (après une fusion, par exemple). */
export function recountPage(entry: PageEntry): PageEntry {
  const counts = emptyCounts()
  for (const test of entry.tests) counts[test.final] += 1
  const criteria = countCriteria(entry.tests)
  const settled = !entry.error && OPEN_STATUSES.every((status) => counts[status] === 0)
  const page: PageEntry = {
    ...entry,
    counts,
    criteria,
    score: entry.error ? null : percent(counts.C, counts.NC),
    criteriaScore: entry.error ? null : percent(criteria.C, criteria.NC),
    settled,
  }
  page.state = pageState(page)
  return page
}

export function buildReport(input: {
  audit: AuditResult
  catalog: Catalog
  asqatasun: ReadonlyMap<string, AsqatasunReport>
  filter: (test: string) => boolean
  tool: { name: string; version: string }
  meta: ReportMeta
}): ReportDocument {
  return {
    format: REPORT_FORMAT,
    tool: input.tool,
    meta: input.meta,
    pages: input.audit.pages.map((page) =>
      summarizePage(page, input.catalog, input.asqatasun.get(page.path), input.filter),
    ),
    pending: input.audit.pending,
  }
}

// ─── Vue d'ensemble du site ────────────────────────────────────────────────

/** Un échec, dédoublonné entre les pages où il se répète (en-tête, pied de page…). */
export interface Finding extends Failure {
  pages: string[]
}

export interface TestIssue {
  test: string
  /** Pages où le test est non conforme. */
  pages: string[]
  findings: Finding[]
  /** Pages où seul Asqatasun conclut à la non-conformité. */
  asqatasunOnly: string[]
  /** Échecs comptés mais non détaillés (au-delà du plafond par page). */
  undetailed: number
}

export interface ToolError {
  test: string
  pages: string[]
  messages: string[]
}

export interface SiteOverview {
  pages: number
  states: Record<PageState, number>
  /** Statut de chaque critère sur l'ensemble du site. */
  criteria: CriteriaCounts
  /** Taux global : critères conformes ÷ (conformes + non conformes), tous pages confondues. */
  globalRate: number | null
  /** Moyenne des taux (critères) des pages auditées. */
  averageRate: number | null
  /** Tests encore ouverts sur au moins une page. */
  openTests: number
  issues: TestIssue[]
  errors: ToolError[]
  /** Tests sans vérification automatique (Non testé sur toutes les pages auditées). */
  untested: string[]
  pending: number
}

function compareTestIds(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

export function siteOverview(report: ReportDocument): SiteOverview {
  const states: Record<PageState, number> = {
    conforme: 0,
    'a-valider': 0,
    'non-conforme': 0,
    'non-auditee': 0,
  }
  for (const page of report.pages) states[page.state] += 1
  const audited = report.pages.filter((page) => !page.error)

  const byTest = new Map<string, { page: string; entry: TestEntry }[]>()
  for (const page of audited) {
    for (const entry of page.tests) {
      const list = byTest.get(entry.test) ?? []
      list.push({ page: page.path, entry })
      byTest.set(entry.test, list)
    }
  }

  const byCriterion = new Map<string, Status[]>()
  const issues: TestIssue[] = []
  const errors: ToolError[] = []
  const untested: string[] = []
  let openTests = 0
  for (const [test, list] of byTest) {
    const criterion = test.split('.').slice(0, 2).join('.')
    const statuses = byCriterion.get(criterion) ?? []
    statuses.push(...list.map(({ entry }) => entry.final))
    byCriterion.set(criterion, statuses)
    if (list.some(({ entry }) => OPEN_STATUSES.includes(entry.final))) openTests += 1

    const failing = list.filter(({ entry }) => entry.final === 'NC')
    if (failing.length > 0) {
      const findings = new Map<string, Finding>()
      let undetailed = 0
      const asqatasunOnly: string[] = []
      for (const { page, entry } of failing) {
        if (entry.tool !== 'NC' && entry.asqatasun === 'NC') asqatasunOnly.push(page)
        undetailed += Math.max(0, entry.failureCount - entry.failures.length)
        for (const failure of entry.failures) {
          const key = `${failure.message}\u0000${failure.selector ?? ''}\u0000${failure.snippet ?? ''}`
          const known = findings.get(key)
          if (known) {
            if (!known.pages.includes(page)) known.pages.push(page)
          } else {
            findings.set(key, { ...failure, pages: [page] })
          }
        }
      }
      issues.push({
        test,
        pages: failing.map(({ page }) => page),
        findings: Array.from(findings.values()).sort((a, b) => b.pages.length - a.pages.length),
        asqatasunOnly,
        undetailed,
      })
    }

    const crashed = list.filter(({ entry }) => entry.final === 'ERR')
    if (crashed.length > 0) {
      const messages = new Set<string>()
      for (const { entry } of crashed) {
        for (const note of entry.notes)
          if (note.startsWith('Erreur de la vérification')) messages.add(note)
      }
      errors.push({ test, pages: crashed.map(({ page }) => page), messages: Array.from(messages) })
    }

    if (list.length > 0 && list.every(({ entry }) => entry.final === 'NT')) untested.push(test)
  }

  const criteria: CriteriaCounts = { C: 0, NC: 0, NA: 0, open: 0 }
  for (const statuses of byCriterion.values()) criteria[criterionStatus(statuses)] += 1
  const rates = audited.map((page) => page.criteriaScore).filter((rate) => rate !== null)

  return {
    pages: report.pages.length,
    states,
    criteria,
    globalRate: percent(criteria.C, criteria.NC),
    averageRate:
      rates.length === 0
        ? null
        : Math.round((rates.reduce((sum, rate) => sum + rate, 0) / rates.length) * 10) / 10,
    openTests,
    issues: issues.sort((a, b) => compareTestIds(a.test, b.test)),
    errors: errors.sort((a, b) => compareTestIds(a.test, b.test)),
    untested: untested.sort(compareTestIds),
    pending: report.pending.length,
  }
}

/** Code de sortie d'un audit : 1 s'il reste un échec ou un test ouvert (AV seulement en strict). */
export function auditFailed(report: ReportDocument): boolean {
  return report.pages.some(
    (page) =>
      page.error ||
      page.counts.NC > 0 ||
      page.counts.ERR > 0 ||
      page.counts.NT > 0 ||
      (report.meta.strict && page.counts.AV > 0),
  )
}
