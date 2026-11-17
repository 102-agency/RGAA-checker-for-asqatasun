import { AuditController } from '../../app/controller.ts'
import type { SessionConfig } from '../../app/session.ts'
import { EXIT } from '../../core/errors.ts'
import { CAPTURE_MODES } from '../../core/runner.ts'
import { REPORT_JSON, readReport } from '../../report/parse.ts'
import { paint } from '../../report/style.ts'
import { progressLine } from '../../report/text.ts'
import { containedPath } from '../../security/fs.ts'
import { parseSiteUrl } from '../../security/url.ts'
import { DEFAULT_PORT, startUiServer } from '../../server/http.ts'
import { SERVE_HELP } from '../help.ts'
import {
  absolute,
  choiceOption,
  DEFAULTS,
  integerOption,
  outputStyle,
  parseCommand,
} from '../options.ts'
import { waitForInterrupt } from './audit.ts'

/** Configuration d'audit reconstituée d'après un rapport (pour relancer depuis l'interface ou le MCP). */
export function configFromReport(
  report: ReturnType<typeof readReport>,
  outDir: string,
  local: Pick<SessionConfig, 'concurrency' | 'browserLibs' | 'sandbox' | 'captures' | 'limit'>,
): SessionConfig {
  return {
    ...local,
    base: parseSiteUrl(report.meta.baseUrl),
    paths: report.meta.pagesSource === 'arguments' ? report.pages.map((page) => page.path) : [],
    scope: report.meta.scope,
    outDir,
    decisionsDir: report.meta.decisionsDir,
    asqatasunDir: report.meta.asqatasunDir,
    strict: report.meta.strict,
    merge: false,
  }
}

export async function commandServe(args: string[]): Promise<number> {
  const { values } = parseCommand('serve', args, {
    out: { type: 'string' },
    port: { type: 'string' },
    by: { type: 'string' },
    concurrency: { type: 'string' },
    captures: { type: 'string' },
    'browser-libs': { type: 'string' },
    sandbox: { type: 'boolean', default: true },
    color: { type: 'boolean' },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) {
    process.stdout.write(SERVE_HELP)
    return EXIT.OK
  }
  const outDir = absolute(values.out ?? DEFAULTS.out)
  const port = integerOption(values.port, 'port', DEFAULT_PORT, 0, 65_535)
  const report = readReport(containedPath(outDir, REPORT_JSON))
  const config = configFromReport(report, outDir, {
    concurrency: integerOption(values.concurrency, 'concurrency', 2, 1, 8),
    captures: choiceOption(values.captures, 'captures', CAPTURE_MODES, 'tout'),
    browserLibs: values['browser-libs'] ?? process.env.RGAA_BROWSER_LIBS,
    sandbox: values.sandbox !== false,
    limit: 500,
  })
  const err = outputStyle(process.stderr, values.color)
  const controller = new AuditController(config, {
    log: (line) => process.stderr.write(`${line}\n`),
    warn: (line) => process.stderr.write(`${paint(err, 'yellow', `  ⚠ ${line}`)}\n`),
    onPage: (page, done, total) =>
      process.stderr.write(`${progressLine(err, page, done, total)}\n`),
  })
  controller.state.load(report)
  const server = await startUiServer({
    state: controller.state,
    outDir,
    port,
    by: values.by ?? 'interface web',
    rerun: (paths) => controller.rerun(paths),
  })
  process.stderr.write(
    `${paint(err, 'bold', 'Interface :')} ${server.url}  — rapport ${outDir} (Ctrl+C pour quitter)\n`,
  )
  await waitForInterrupt()
  await server.close()
  return EXIT.OK
}
