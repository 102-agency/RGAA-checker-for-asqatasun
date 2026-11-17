import { AuditController } from '../../app/controller.ts'
import { runAuditSession, type SessionConfig, type SessionResult } from '../../app/session.ts'
import { loadCatalog } from '../../core/catalog.ts'
import { EXIT, UserError } from '../../core/errors.ts'
import { CAPTURE_MODES } from '../../core/runner.ts'
import type { PageReport } from '../../core/types.ts'
import { auditFailed } from '../../report/model.ts'
import { paint } from '../../report/style.ts'
import { DETAILS, progressLine, renderText } from '../../report/text.ts'
import { canonicalPath, parseSiteUrl } from '../../security/url.ts'
import { DEFAULT_PORT, startUiServer, type UiServer } from '../../server/http.ts'
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
    merge: { type: 'boolean', default: false },
    captures: { type: 'string' },
    serve: { type: 'boolean', default: false },
    port: { type: 'string' },
    by: { type: 'string' },
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

  const captures = choiceOption(values.captures, 'captures', CAPTURE_MODES, 'tout')
  const port = integerOption(values.port, 'port', DEFAULT_PORT, 0, 65_535)
  const config: SessionConfig = {
    base,
    paths,
    limit,
    concurrency,
    scope,
    outDir,
    decisionsDir,
    asqatasunDir,
    browserLibs,
    sandbox: values.sandbox !== false,
    strict: values.strict,
    captures,
    merge: values.merge,
  }
  const hooks = {
    log: (line: string) => log(paint(err, 'bold', line)),
    warn: (line: string) => log(paint(err, 'yellow', `  ⚠ ${line}`)),
    onPage: (page: PageReport, done: number, total: number) =>
      log(progressLine(err, page, done, total)),
    trace: values.trace ? (line: string) => process.stderr.write(`    ${line}\n`) : undefined,
  }

  let result: SessionResult
  let server: UiServer | undefined
  let controller: AuditController | undefined
  if (values.serve) {
    controller = new AuditController(config, hooks)
    server = await startUiServer({
      state: controller.state,
      outDir,
      port,
      by: values.by ?? 'interface web',
      rerun: (next) => controller?.rerun(next),
    })
    process.stderr.write(
      `${paint(err, 'bold', 'Interface en direct :')} ${server.url}  (Ctrl+C pour quitter)\n`,
    )
    result = await controller.run()
  } else {
    result = await runAuditSession(config, hooks)
  }
  const { report, written } = result
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
          { label: 'À corriger (IA)', path: written.toFixMarkdown },
          { label: 'Résultats complets', path: written.fullResults },
          { label: 'Décisions', path: decisionsDir },
        ],
      }),
    )
  }
  if (result.merged) {
    process.stdout.write(
      `${paint(out, 'dim', '  Rapport fusionné avec le précédent (pages réauditées seulement).')}\n`,
    )
  }
  if (server) {
    process.stderr.write(
      `\n${paint(err, 'bold', 'Interface toujours ouverte :')} ${server.url}  — trancher les questions, relancer, puis Ctrl+C pour quitter.\n`,
    )
    await waitForInterrupt()
    await server.close()
    const last = controller?.state.lastReport ?? report
    return auditFailed(last) ? EXIT.ISSUES : EXIT.OK
  }
  return auditFailed(report) ? EXIT.ISSUES : EXIT.OK
}

/** Attend Ctrl+C (ou un arrêt demandé) pour fermer l'interface proprement. */
export function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}
