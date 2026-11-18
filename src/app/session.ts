import { existsSync } from 'node:fs'
import type { Browser } from 'playwright'
import { type Scope, scopeFilter, TOOL_NAME, toolVersion } from '../cli/options.ts'
import { loadAsqatasunReports } from '../core/asqatasun.ts'
import { type AuthSettings, resolveAuth } from '../core/auth.ts'
import { launchBrowser } from '../core/browser.ts'
import { type Catalog, loadCatalog } from '../core/catalog.ts'
import { DecisionStore } from '../core/decisions.ts'
import { UserError } from '../core/errors.ts'
import { type AuditEvent, audit, type CaptureMode } from '../core/runner.ts'
import { discoverPages } from '../core/sitemap.ts'
import type { PageReport } from '../core/types.ts'
import { mergeReports } from '../report/merge.ts'
import { buildReport, type ReportDocument } from '../report/model.ts'
import { REPORT_JSON, readReport } from '../report/parse.ts'
import { type WrittenReport, writeReport } from '../report/write.ts'
import { containedPath } from '../security/fs.ts'
import { safeLine } from '../security/text.ts'
import { allChecks } from '../themes/index.ts'

/**
 * Une session d'audit complète : découverte des pages, audit en navigateur,
 * construction et écriture du rapport. Partagée par la ligne de commande,
 * l'interface web et le serveur MCP, pour qu'ils produisent exactement les
 * mêmes fichiers.
 */
export interface SessionConfig {
  base: URL
  /** Chemins à auditer ; vide = toutes les pages du sitemap. */
  paths: string[]
  limit: number
  concurrency: number
  scope: Scope
  outDir: string
  decisionsDir: string
  asqatasunDir: string | null
  browserLibs?: string
  sandbox: boolean
  strict: boolean
  captures: CaptureMode
  /**
   * Fusionne le résultat dans le rapport existant de `outDir` (même site) au
   * lieu de le remplacer : pour réauditer une page après correction.
   */
  merge: boolean
  /** Magasin de décisions à utiliser (sinon relu depuis `decisionsDir`). */
  decisionStore?: DecisionStore
  /** Pages derrière une connexion : cookies ou état de session (jamais écrits dans le rapport). */
  auth?: AuthSettings
}

export interface SessionHooks {
  log?: (line: string) => void
  warn?: (line: string) => void
  onPage?: (report: PageReport, done: number, total: number) => void
  onEvent?: (event: AuditEvent) => void
  trace?: (line: string) => void
  /** Pages retenues, avant le lancement du navigateur. */
  onPlan?: (urls: string[], dropped: number) => void
}

export interface SessionResult {
  report: ReportDocument
  written: WrittenReport
  urls: string[]
  dropped: number
  /** Le rapport a été fusionné avec le précédent. */
  merged: boolean
  decisions: DecisionStore
  catalog: Catalog
}

/** Tests statués par les vérifications inter-pages (non recalculés lors d'une fusion). */
export const SITE_TESTS: ReadonlySet<string> = new Set(
  allChecks.filter((check) => check.kind === 'site').flatMap((check) => check.tests),
)

/** Rapport précédent du même site dans `outDir`, s'il existe et se relit. */
export function previousReport(outDir: string, base: URL): ReportDocument | undefined {
  const file = containedPath(outDir, REPORT_JSON)
  if (!existsSync(file)) return undefined
  const report = readReport(file)
  return new URL(report.meta.baseUrl).origin === base.origin ? report : undefined
}

export async function runAuditSession(
  config: SessionConfig,
  hooks: SessionHooks = {},
): Promise<SessionResult> {
  const catalog = loadCatalog()
  const filter = scopeFilter(config.scope)
  const restricted =
    config.scope.themes.length + config.scope.criteria.length + config.scope.tests.length > 0
  const decisions = config.decisionStore ?? new DecisionStore(config.decisionsDir)
  const asqatasun = config.asqatasunDir ? loadAsqatasunReports(config.asqatasunDir) : new Map()
  if (config.asqatasunDir && asqatasun.size === 0) {
    hooks.warn?.(`Aucun export Asqatasun lisible dans ${config.asqatasunDir}.`)
  }
  if (!config.sandbox) {
    hooks.warn?.(
      'Bac à sable de Chromium désactivé : les pages auditées ne sont plus isolées du système.',
    )
  }
  const auth = resolveAuth(config.auth, config.base)
  if (auth) hooks.log?.(auth.summary)
  const previous = config.merge ? previousReport(config.outDir, config.base) : undefined
  if (config.merge && !previous) {
    hooks.warn?.('Aucun rapport précédent de ce site : le rapport est écrit sans fusion.')
  }

  const pages = await discoverPages(config.base, config.paths, { maxPages: config.limit })
  const urls = pages.source === 'arguments' ? pages.urls.slice(0, config.limit) : pages.urls
  const dropped = pages.dropped + (pages.urls.length - urls.length)
  if (urls.length === 0) throw new UserError('Aucune page à auditer.')
  hooks.onPlan?.(urls, dropped)
  hooks.log?.(
    `Audit RGAA de ${urls.length} page(s) sur ${safeLine(config.base.origin)}${
      dropped ? ` (${dropped} écartée(s) par --limit)` : ''
    }…`,
  )

  const launchOptions = { sandbox: config.sandbox, libraries: config.browserLibs }
  const browsers: Browser[] = [await launchBrowser(launchOptions)]
  const started = new Date()
  let report: ReportDocument
  try {
    const result = await audit({
      browser: browsers[0] as Browser,
      relaunch: async () => {
        hooks.warn?.('Chromium a planté : relance du navigateur.')
        const fresh = await launchBrowser(launchOptions)
        browsers.push(fresh)
        return fresh
      },
      urls,
      auth,
      checks: allChecks,
      decisions,
      outDir: config.outDir,
      captures: config.captures,
      concurrency: config.concurrency,
      filter,
      onPage: hooks.onPage,
      onEvent: hooks.onEvent,
      trace: hooks.trace,
    })
    report = buildReport({
      audit: result,
      catalog,
      asqatasun,
      filter,
      tool: { name: TOOL_NAME, version: toolVersion() },
      meta: {
        baseUrl: config.base.href,
        startedAt: started.toISOString(),
        durationMs: Date.now() - started.getTime(),
        pagesSource: pages.source,
        pagesDropped: dropped,
        scope: config.scope,
        decisionsDir: config.decisionsDir,
        decisionsCount: decisions.size,
        // Un audit partiel ne sollicite pas toutes les décisions : le décompte n'aurait pas de sens.
        unusedDecisions:
          restricted || pages.source === 'arguments' ? null : decisions.unused().length,
        asqatasunDir: config.asqatasunDir,
        asqatasunReports: asqatasun.size,
        strict: config.strict,
      },
    })
  } finally {
    await Promise.all(browsers.map((browser) => browser.close().catch(() => {})))
  }

  if (previous) report = mergeReports(previous, report, SITE_TESTS)
  const written = writeReport(config.outDir, report, catalog, {
    decisions: (topic, key) => decisions.peek(topic, key),
  })
  return { report, written, urls, dropped, merged: Boolean(previous), decisions, catalog }
}
