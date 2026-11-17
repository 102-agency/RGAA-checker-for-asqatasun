import { resolve } from 'node:path'
import { type Catalog, loadCatalog } from '../../core/catalog.ts'
import { EXIT } from '../../core/errors.ts'
import type { PendingQuestion } from '../../report/model.ts'
import { REPORT_JSON, readReport } from '../../report/parse.ts'
import { paint, plural, type Style, wrap } from '../../report/style.ts'
import { containedPath } from '../../security/fs.ts'
import { safeLine } from '../../security/text.ts'
import { PENDING_HELP } from '../help.ts'
import {
  absolute,
  choiceOption,
  DEFAULTS,
  listOption,
  outputStyle,
  parseCommand,
} from '../options.ts'

const SCREENSHOT = /^preuves\/[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}\/[0-9a-f]{12}\.png$/u

/** Bloc lisible décrivant une question : utilisé par `pending` et par `decide` interactif. */
export function describeQuestion(
  item: PendingQuestion,
  catalog: Catalog,
  style: Style,
  outDir: string,
  index?: { position: number; total: number },
): string {
  const lines: string[] = []
  const width = style.width
  const counter = index ? paint(style, 'dim', `[${index.position}/${index.total}] `) : ''
  lines.push(
    `${counter}${paint(style, 'yellow', `? ${item.key}`)}  ${paint(style, 'dim', `sujet ${safeLine(item.topic, 128)}`)}`,
  )
  lines.push(
    ...wrap(item.question, width, '    ', '    ').map((line) => paint(style, 'bold', line)),
  )
  lines.push('')
  const label = (text: string) => `    ${paint(style, 'dim', text.padEnd(10))}  `
  const indent = ' '.repeat(16)
  for (const test of item.tests) {
    lines.push(
      ...wrap(
        `${test} — ${catalog.byTest.get(test)?.title ?? ''}`,
        width,
        indent,
        label(test === item.tests[0] ? 'Tests' : ''),
      ),
    )
  }
  lines.push(
    ...wrap(
      `${plural(item.pages.length, 'page')} : ${item.pages
        .slice(0, 6)
        .map((page) => safeLine(page, 200))
        .join(', ')}${item.pages.length > 6 ? ' …' : ''}`,
      width,
      indent,
      label('Pages'),
    ),
  )
  lines.push('')
  lines.push(`    ${paint(style, 'bold', 'Ce qui est jugé')}`)
  for (const [name, value] of Object.entries(item.evidence)) {
    lines.push(...wrap(value || '(vide)', width, indent, label(safeLine(name, 10))))
  }
  if (item.selector) lines.push(...wrap(item.selector, width, indent, label('Élément')))
  if (item.snippet)
    lines.push(
      ...wrap(item.snippet, width, indent, label('Code')).map((line) => paint(style, 'dim', line)),
    )
  if (item.screenshot && SCREENSHOT.test(item.screenshot)) {
    lines.push(...wrap(resolve(outDir, item.screenshot), width, indent, label('Capture')))
  }
  lines.push('')
  lines.push(
    `    Réponses admises : ${item.answers.map((answer) => paint(style, 'cyan', safeLine(answer, 100))).join(' | ')}`,
  )
  return lines.join('\n')
}

export function commandPending(args: string[]): number {
  const { values } = parseCommand('pending', args, {
    out: { type: 'string' },
    topic: { type: 'string', multiple: true },
    format: { type: 'string' },
    color: { type: 'boolean' },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) {
    process.stdout.write(PENDING_HELP)
    return EXIT.OK
  }
  const format = choiceOption(values.format, 'format', ['texte', 'json'] as const, 'texte')
  const outDir = absolute(values.out ?? DEFAULTS.out)
  const report = readReport(containedPath(outDir, REPORT_JSON))
  const topics = listOption(values.topic)
  const pending = topics.length
    ? report.pending.filter((item) => topics.includes(item.topic))
    : report.pending

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`)
    return EXIT.OK
  }
  const style = outputStyle(process.stdout, values.color)
  if (pending.length === 0) {
    process.stdout.write(`${paint(style, 'green', '✓')} Aucune question en attente.\n`)
    return EXIT.OK
  }
  const catalog = loadCatalog()
  const blocks = pending.map((item, index) =>
    describeQuestion(item, catalog, style, outDir, { position: index + 1, total: pending.length }),
  )
  process.stdout.write(
    `${blocks.join(`\n\n${paint(style, 'dim', '─'.repeat(Math.min(style.width, 80)))}\n\n`)}\n`,
  )
  process.stdout.write(
    `\n${plural(pending.length, 'question', 'questions')} en attente. Pour répondre :\n  ${paint(style, 'cyan', 'rgaa decide')}                                   une à une (interactif)\n  ${paint(style, 'cyan', 'rgaa decide <empreinte> <réponse> --reason "…"')}\n`,
  )
  return EXIT.OK
}
