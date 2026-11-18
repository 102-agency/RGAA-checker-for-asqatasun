import type { ReportDocument } from './model.ts'

/**
 * Différence entre deux rapports du même site : ce qu'une correction a réglé,
 * ce qui reste, et surtout ce qu'elle a cassé. Comparaison au grain
 * « test × page » : un test non conforme sur une page est un couple.
 *
 * Seules les pages auditées dans les deux rapports sont comparées : une page
 * ajoutée, retirée ou en erreur n'est ni une correction ni une régression.
 */

export interface DiffEntry {
  test: string
  page: string
  /** Échecs avant / après (0 quand le test n'est plus en échec). */
  before: number
  after: number
}

export interface ReportDiff {
  /** Non conformes avant, plus en échec maintenant. */
  fixed: DiffEntry[]
  /** Toujours non conformes, avec moins d'occurrences. */
  reduced: DiffEntry[]
  /** Toujours non conformes, autant d'occurrences ou davantage. */
  persisting: DiffEntry[]
  /** Conformes (ou autres) avant, non conformes maintenant : régressions. */
  introduced: DiffEntry[]
  comparedPages: number
}

function failures(report: ReportDocument): Map<string, Map<string, number>> {
  const pages = new Map<string, Map<string, number>>()
  for (const page of report.pages) {
    if (page.error) continue
    const tests = new Map<string, number>()
    for (const entry of page.tests) {
      if (entry.final === 'NC') tests.set(entry.test, Math.max(1, entry.failureCount))
    }
    pages.set(page.path, tests)
  }
  return pages
}

export function diffReports(before: ReportDocument, after: ReportDocument): ReportDiff {
  const previous = failures(before)
  const current = failures(after)
  const diff: ReportDiff = {
    fixed: [],
    reduced: [],
    persisting: [],
    introduced: [],
    comparedPages: 0,
  }
  for (const [page, now] of current) {
    const was = previous.get(page)
    if (!was) continue
    diff.comparedPages += 1
    for (const test of new Set([...was.keys(), ...now.keys()])) {
      const entry: DiffEntry = { test, page, before: was.get(test) ?? 0, after: now.get(test) ?? 0 }
      if (entry.before > 0 && entry.after === 0) diff.fixed.push(entry)
      else if (entry.before === 0 && entry.after > 0) diff.introduced.push(entry)
      else if (entry.after < entry.before) diff.reduced.push(entry)
      else if (entry.before > 0) diff.persisting.push(entry)
    }
  }
  return diff
}

const byTest = (a: DiffEntry, b: DiffEntry) =>
  a.test.localeCompare(b.test, 'en', { numeric: true }) || a.page.localeCompare(b.page)

function lines(
  label: string,
  entries: DiffEntry[],
  detail: (entry: DiffEntry) => string,
): string[] {
  if (entries.length === 0) return []
  const shown = entries
    .slice()
    .sort(byTest)
    .slice(0, 25)
    .map((entry) => `  - ${entry.test} sur ${entry.page}${detail(entry)}`)
  if (entries.length > 25) shown.push(`  - … (+${entries.length - 25})`)
  return [`${label} (${entries.length}) :`, ...shown]
}

/** Résumé lisible, vide quand rien n'a changé. */
export function renderDiff(diff: ReportDiff): string {
  const changed =
    diff.fixed.length + diff.reduced.length + diff.persisting.length + diff.introduced.length
  if (diff.comparedPages === 0) return 'Différence : aucune page commune avec le rapport précédent.'
  if (changed === 0) {
    return `Différence avec le rapport précédent (${diff.comparedPages} page(s) comparée(s)) : aucune non-conformité avant ni après.`
  }
  return [
    `Différence avec le rapport précédent (${diff.comparedPages} page(s) comparée(s)) :`,
    ...lines('✓ Corrigées', diff.fixed, (e) => ` (${e.before} échec(s) avant)`),
    ...lines('↘ Réduites', diff.reduced, (e) => ` (${e.before} → ${e.after})`),
    ...lines('✗ Persistantes', diff.persisting, (e) => ` (${e.after} échec(s))`),
    ...lines(
      '⚠ NOUVELLES non-conformités (régressions)',
      diff.introduced,
      (e) => ` (${e.after} échec(s))`,
    ),
  ].join('\n')
}
