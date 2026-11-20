import { compareIds } from '../core/catalog.ts'
import { type PageEntry, type PendingQuestion, type ReportDocument, recountPage } from './model.ts'

/**
 * Fusion d'un audit partiel (quelques pages, ou quelques thématiques) dans le
 * rapport précédent du même site : c'est la boucle « corriger, relancer la
 * page, relire » sans réauditer tout le site.
 *
 * - les pages réauditées remplacent leurs anciens résultats, test par test ;
 * - les tests inter-pages (`siteTests`, ex. cohérence de la navigation) ne
 *   sont pas recalculés sur un sous-ensemble de pages : l'ancien verdict est
 *   conservé, jusqu'au prochain audit complet ;
 * - les pages absentes de l'audit partiel restent telles quelles ;
 * - la liste des questions est reconstruite à partir des tests retenus.
 */
export function mergeReports(
  previous: ReportDocument,
  partial: ReportDocument,
  siteTests: ReadonlySet<string>,
): ReportDocument {
  const fresh = new Map(partial.pages.map((page) => [page.url, page]))
  const pages: PageEntry[] = previous.pages.map((old) => {
    const update = fresh.get(old.url)
    if (!update) return old
    fresh.delete(old.url)
    if (update.error) return update
    const replaced = new Map(update.tests.map((entry) => [entry.test, entry]))
    const tests = old.error ? [...update.tests] : [...old.tests]
    for (const [index, entry] of tests.entries()) {
      const next = replaced.get(entry.test)
      if (next && !(siteTests.has(entry.test) && !old.error)) tests[index] = next
      replaced.delete(entry.test)
    }
    tests.push(...replaced.values())
    tests.sort((a, b) => compareIds(a.test, b.test))
    return recountPage({ ...update, tests })
  })
  pages.push(...fresh.values())

  return {
    ...previous,
    tool: partial.tool,
    meta: {
      ...previous.meta,
      decisionsCount: partial.meta.decisionsCount,
      unusedDecisions: null,
    },
    pages,
    pending: rebuildPending(pages, [...partial.pending, ...previous.pending]),
  }
}

/** Questions encore référencées par les tests des pages, avec leurs tests et leurs pages. */
function rebuildPending(
  pages: readonly PageEntry[],
  known: readonly PendingQuestion[],
): PendingQuestion[] {
  const definitions = new Map<string, PendingQuestion>()
  for (const item of known) if (!definitions.has(item.key)) definitions.set(item.key, item)
  const uses = new Map<string, { tests: Set<string>; pages: Set<string> }>()
  for (const page of pages) {
    for (const entry of page.tests) {
      for (const question of entry.pending) {
        const use = uses.get(question.key) ?? { tests: new Set(), pages: new Set() }
        use.tests.add(entry.test)
        use.pages.add(page.url)
        uses.set(question.key, use)
      }
    }
  }
  const out: PendingQuestion[] = []
  for (const [key, use] of uses) {
    const definition = definitions.get(key)
    if (!definition) continue
    out.push({
      ...definition,
      tests: Array.from(use.tests).sort(compareIds),
      pages: Array.from(use.pages),
    })
  }
  return out
}
