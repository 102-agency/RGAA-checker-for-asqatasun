import { type Catalog, compareIds, loadCatalog } from '../../core/catalog.ts'
import { EXIT, UserError } from '../../core/errors.ts'
import type { CatalogTest } from '../../core/types.ts'
import { paint, type Style, wrap } from '../../report/style.ts'
import { allChecks } from '../../themes/index.ts'
import { EXPLAIN_HELP } from '../help.ts'
import { outputStyle, parseCommand } from '../options.ts'

const GLOSSARY = 'https://accessibilite.numerique.gouv.fr/methode/glossaire/'
const CRITERIA_URL = 'https://accessibilite.numerique.gouv.fr/methode/criteres-et-tests/'

function automated(): Set<string> {
  return new Set(allChecks.flatMap((check) => check.tests))
}

function criterionBlock(
  catalog: Catalog,
  criterion: string,
  style: Style,
  covered: Set<string>,
): string[] {
  const tests = catalog.tests.filter((test) => test.criterion === criterion)
  const first = tests[0] as CatalogTest
  const lines: string[] = []
  const w = style.width
  lines.push(
    paint(
      style,
      'bold',
      `Critère ${criterion} — niveau ${first.level} — thématique ${first.theme}. ${first.themeLabel}`,
    ),
  )
  lines.push(...wrap(first.criterionTitle ?? '', w, '  ', '  '))
  lines.push('')
  for (const test of tests) {
    const auto = covered.has(test.test)
      ? paint(style, 'green', 'vérifié automatiquement')
      : paint(style, 'yellow', 'à vérifier à la main (ou par Asqatasun)')
    lines.push(`  ${paint(style, 'bold', `Test ${test.test}`)}  ${auto}`)
    lines.push(...wrap(test.title, w, '    ', '    '))
    lines.push('')
  }
  if (first.particularCases) {
    lines.push(paint(style, 'bold', '  Cas particuliers'))
    lines.push(...wrap(first.particularCases, w, '    ', '    '))
    lines.push('')
  }
  if (first.technicalNotes) {
    lines.push(paint(style, 'bold', '  Notes techniques'))
    lines.push(...wrap(first.technicalNotes, w, '    ', '    '))
    lines.push('')
  }
  return lines
}

export function commandExplain(args: string[]): number {
  const { values, positionals } = parseCommand('explain', args, {
    color: { type: 'boolean' },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help || positionals.length === 0) {
    process.stdout.write(EXPLAIN_HELP)
    return values.help ? EXIT.OK : EXIT.USAGE
  }
  const catalog = loadCatalog()
  const style = outputStyle(process.stdout, values.color)
  const covered = automated()
  const lines: string[] = []

  for (const id of positionals) {
    if (/^\d{1,2}\.\d{1,2}\.\d{1,2}$/.test(id) && catalog.byTest.has(id)) {
      const test = catalog.byTest.get(id) as CatalogTest
      lines.push(...criterionBlock(catalog, test.criterion, style, covered).filter(Boolean))
      lines.push(paint(style, 'dim', `  (le test ${id} est l'un des tests de ce critère)`), '')
    } else if (/^\d{1,2}\.\d{1,2}$/.test(id) && catalog.criteria.has(id)) {
      lines.push(...criterionBlock(catalog, id, style, covered))
    } else if (/^\d{1,2}$/.test(id) && catalog.themes.has(Number(id))) {
      const theme = Number(id)
      lines.push(paint(style, 'bold', `Thématique ${theme} — ${catalog.themes.get(theme)}`), '')
      const criteria = Array.from(catalog.criteria)
        .filter(([, info]) => info.theme === theme)
        .sort(([a], [b]) => compareIds(a, b))
      for (const [criterion, info] of criteria) {
        const tests = catalog.tests.filter((test) => test.criterion === criterion)
        const auto = tests.filter((test) => covered.has(test.test)).length
        lines.push(
          ...wrap(
            info.title,
            style.width,
            '                 ',
            `  ${paint(style, 'bold', criterion.padEnd(6))} [${info.level.padEnd(2)}]  `,
          ),
          paint(
            style,
            'dim',
            `                 ${auto}/${tests.length} test(s) vérifié(s) automatiquement`,
          ),
        )
      }
      lines.push('')
    } else {
      throw new UserError(
        `« ${id.slice(0, 20)} » n'est ni un test (1.1.1), ni un critère (1.1), ni une thématique (1 à 13) du RGAA 4.1.2.`,
      )
    }
  }
  lines.push(paint(style, 'dim', `Référentiel : ${CRITERIA_URL}`))
  lines.push(paint(style, 'dim', `Glossaire   : ${GLOSSARY}`))
  process.stdout.write(`${lines.join('\n')}\n`)
  return EXIT.OK
}
