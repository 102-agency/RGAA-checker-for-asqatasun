import type { Browser } from 'playwright'
import { loadAsqatasunReports } from '../../core/asqatasun.ts'
import { launchBrowser } from '../../core/browser.ts'
import { loadCatalog } from '../../core/catalog.ts'
import { DecisionStore } from '../../core/decisions.ts'
import { EXIT, UserError } from '../../core/errors.ts'
import { audit } from '../../core/runner.ts'
import { discoverPages } from '../../core/sitemap.ts'
import { auditFailed, buildReport, type ReportDocument } from '../../report/model.ts'
import { paint } from '../../report/style.ts'
import { DETAILS, progressLine, renderText } from '../../report/text.ts'
import { writeReport } from '../../report/write.ts'
import { safeLine } from '../../security/text.ts'
import { canonicalPath, parseSiteUrl } from '../../security/url.ts'
import { allChecks } from '../../themes/index.ts'
import { AUDIT_HELP } from '../help.ts'
import {
  absolute,
  choiceOption,
  DEFAULTS,
  integerOption,
  listOption,
  outputStyle,
  parseCommand,
  resolveScope,
  scopeFilter,
  TOOL_NAME,
  toolVersion,
} from '../options.ts'

export async function commandAudit(args: string[]): Promise<number> {
  const { values, positionals } = parseCommand('audit', args, {
    theme: { type: 'string', multiple: true },
    criterion: { type: 'string', multiple: true },
    test: { type: 'string', multiple: true },
    limit: { type: 'string' },
    concurrency: { type: 'string' },
    asqatasun: { type: 'string' },
    decisions: { type: 'string' },
    out: { type: 'string' },
    detail: { type: 'string' },
    page: { type: 'string', multiple: true },
    format: { type: 'string' },
    quiet: { type: 'boolean', default: false },
    color: { type: 'boolean' },
    strict: { type: 'boolean', default: false },
    'browser-libs': { type: 'string' },
    sandbox: { type: 'boolean', default: true },
    trace: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) {
    process.stdout.write(AUDIT_HELP)
    return EXIT.OK
  }

  // ── Validation de toutes les entrées avant le moindre effet de bord ──
  const [target, ...paths] = positionals
  if (!target) throw new UserError('Adresse du site manquante : rgaa audit <url> [chemins…]')
  const base = parseSiteUrl(target)
  const catalog = loadCatalog()
  const scope = resolveScope(catalog, {
    themes: listOption(values.theme),
    criteria: listOption(values.criterion),
    tests: listOption(values.test),
  })
  const filter = scopeFilter(scope)
  const restricted = scope.themes.length + scope.criteria.length + scope.tests.length > 0
  const limit = integerOption(values.limit, 'limit', 500, 1, 10_000)
  const concurrency = integerOption(values.concurrency, 'concurrency', 2, 1, 8)
  const detail = choiceOption(values.detail, 'detail', DETAILS, 'problemes')
  const format = choiceOption(values.format, 'format', ['texte', 'json'] as const, 'texte')
  const outDir = absolute(values.out ?? DEFAULTS.out)
  const decisionsDir = absolute(values.decisions ?? DEFAULTS.decisions)
  const asqatasunInput = values.asqatasun ?? process.env.RGAA_ASQATASUN_DIR
  const asqatasunDir = asqatasunInput ? absolute(asqatasunInput) : null
  const browserLibs = values['browser-libs'] ?? process.env.RGAA_BROWSER_LIBS
  const pageFilter = listOption(values.page).map((path) => canonicalPath(new URL(path, base)))

  const out = outputStyle(process.stdout, values.color)
  const err = outputStyle(process.stderr, values.color)
  const log = (line: string) => {
    if (!values.quiet) process.stderr.write(`${line}\n`)
  }

  const decisions = new DecisionStore(decisionsDir)
  const asqatasun = asqatasunDir ? loadAsqatasunReports(asqatasunDir) : new Map()
  if (asqatasunDir && asqatasun.size === 0) {
    log(paint(err, 'yellow', `  ⚠ Aucun export Asqatasun lisible dans ${asqatasunDir}.`))
  }
  if (values.sandbox === false) {
    log(
      paint(
        err,
        'yellow',
        '  ⚠ Bac à sable de Chromium désactivé : les pages auditées ne sont plus isolées du système.',
      ),
    )
  }

  const pages = await discoverPages(base, paths, { maxPages: limit })
  const urls = pages.source === 'arguments' ? pages.urls.slice(0, limit) : pages.urls
  const dropped = pages.dropped + (pages.urls.length - urls.length)
  if (urls.length === 0) throw new UserError('Aucune page à auditer.')

  log(
    `${paint(err, 'bold', 'Audit RGAA')} de ${urls.length} page(s) sur ${safeLine(base.origin)}${
      dropped ? ` (${dropped} écartée(s) par --limit)` : ''
    }…`,
  )

  const launchOptions = { sandbox: values.sandbox !== false, libraries: browserLibs }
  const browsers: Browser[] = [await launchBrowser(launchOptions)]
  const started = new Date()
  let report: ReportDocument
  try {
    const result = await audit({
      browser: browsers[0] as Browser,
      relaunch: async () => {
        log(paint(err, 'yellow', '  ⚠ Chromium a planté : relance du navigateur.'))
        const fresh = await launchBrowser(launchOptions)
        browsers.push(fresh)
        return fresh
      },
      urls,
      checks: allChecks,
      decisions,
      outDir,
      concurrency,
      filter,
      onPage: (page, done, total) => log(progressLine(err, page, done, total)),
      trace: values.trace ? (line) => process.stderr.write(`    ${line}\n`) : undefined,
    })

    report = buildReport({
      audit: result,
      catalog,
      asqatasun,
      filter,
      tool: { name: TOOL_NAME, version: toolVersion() },
      meta: {
        baseUrl: base.href,
        startedAt: started.toISOString(),
        durationMs: Date.now() - started.getTime(),
        pagesSource: pages.source,
        pagesDropped: dropped,
        scope,
        decisionsDir,
        decisionsCount: decisions.size,
        // Un audit partiel ne sollicite pas toutes les décisions : le décompte n'aurait pas de sens.
        unusedDecisions:
          restricted || pages.source === 'arguments' ? null : decisions.unused().length,
        asqatasunDir,
        asqatasunReports: asqatasun.size,
        strict: values.strict,
      },
    })
  } finally {
    await Promise.all(browsers.map((browser) => browser.close().catch(() => {})))
  }

  const written = writeReport(outDir, report, catalog)
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write('\n')
    process.stdout.write(
      renderText(report, catalog, {
        style: out,
        detail,
        pages: pageFilter,
        files: [
          { label: 'Rapport HTML', path: written.html },
          { label: 'Rapport Markdown', path: written.markdown },
          { label: 'Données JSON', path: written.json },
          { label: 'Décisions', path: decisionsDir },
        ],
      }),
    )
  }
  return auditFailed(report) ? EXIT.ISSUES : EXIT.OK
}
