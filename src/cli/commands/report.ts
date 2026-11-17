import { loadCatalog } from '../../core/catalog.ts'
import { EXIT } from '../../core/errors.ts'
import { renderMarkdown } from '../../report/markdown.ts'
import { auditFailed } from '../../report/model.ts'
import { REPORT_JSON, readReport } from '../../report/parse.ts'
import { DETAILS, renderText } from '../../report/text.ts'
import { containedPath } from '../../security/fs.ts'
import { REPORT_HELP } from '../help.ts'
import {
  absolute,
  choiceOption,
  DEFAULTS,
  listOption,
  outputStyle,
  parseCommand,
} from '../options.ts'

/** Normalise un chemin donné par l'utilisateur comme ceux du rapport (`/contact/` → `/contact`). */
function normalizePath(path: string): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`
  return withSlash.replace(/\/+$/, '') || '/'
}

export function commandReport(args: string[]): number {
  const { values } = parseCommand('report', args, {
    out: { type: 'string' },
    detail: { type: 'string' },
    page: { type: 'string', multiple: true },
    format: { type: 'string' },
    color: { type: 'boolean' },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) {
    process.stdout.write(REPORT_HELP)
    return EXIT.OK
  }
  const detail = choiceOption(values.detail, 'detail', DETAILS, 'problemes')
  const format = choiceOption(
    values.format,
    'format',
    ['texte', 'markdown', 'json'] as const,
    'texte',
  )
  const outDir = absolute(values.out ?? DEFAULTS.out)
  const report = readReport(containedPath(outDir, REPORT_JSON))
  const catalog = loadCatalog()

  if (format === 'json') process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else if (format === 'markdown') process.stdout.write(renderMarkdown(report, catalog))
  else {
    const pages = listOption(values.page).map(normalizePath)
    const unknown = pages.filter((path) => !report.pages.some((page) => page.path === path))
    if (unknown.length) {
      process.stderr.write(
        `Page(s) absente(s) du rapport : ${unknown.join(', ')}. Pages auditées : ${report.pages
          .slice(0, 20)
          .map((page) => page.path)
          .join(', ')}${report.pages.length > 20 ? '…' : ''}\n`,
      )
      return EXIT.USAGE
    }
    process.stdout.write(
      renderText(report, catalog, {
        style: outputStyle(process.stdout, values.color),
        detail,
        pages,
      }),
    )
  }
  return auditFailed(report) ? EXIT.ISSUES : EXIT.OK
}
