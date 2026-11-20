import { AuditLibrary } from '../../app/library.ts'
import { EXIT } from '../../core/errors.ts'
import { CAPTURE_MODES } from '../../core/runner.ts'
import { paint } from '../../report/style.ts'
import { progressLine } from '../../report/text.ts'
import { DEFAULT_PORT } from '../../server/http.ts'
import { startHub } from '../../server/hub.ts'
import { WEB_HELP } from '../help.ts'
import {
  absolute,
  choiceOption,
  DEFAULTS,
  integerOption,
  outputStyle,
  parseCommand,
} from '../options.ts'
import { waitForInterrupt } from './audit.ts'

/** Dossier des audits : `--dir`, sinon `RGAA_AUDITS_DIR`, sinon `./audits`. */
export const DEFAULT_AUDITS_DIR = 'audits'

export async function commandWeb(args: string[]): Promise<number> {
  const { values } = parseCommand('web', args, {
    dir: { type: 'string' },
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
    process.stdout.write(WEB_HELP)
    return EXIT.OK
  }
  const root = absolute(values.dir ?? process.env.RGAA_AUDITS_DIR ?? DEFAULT_AUDITS_DIR)
  const port = integerOption(values.port ?? process.env.PORT, 'port', DEFAULT_PORT, 0, 65_535)
  const err = outputStyle(process.stderr, values.color)
  const library = new AuditLibrary({
    root,
    // Le dossier du CLI (`rgaa audit` sans --out) reste consultable depuis l'accueil.
    extra: [
      {
        id: 'rgaa-report',
        reportDir: absolute(DEFAULTS.out),
        decisionsDir: absolute(DEFAULTS.decisions),
      },
    ],
    defaults: {
      concurrency: integerOption(values.concurrency, 'concurrency', 2, 1, 8),
      captures: choiceOption(values.captures, 'captures', CAPTURE_MODES, 'tout'),
      browserLibs: values['browser-libs'] ?? process.env.RGAA_BROWSER_LIBS,
      sandbox: values.sandbox !== false,
      limit: 500,
    },
    hooks: {
      log: (line) => process.stderr.write(`${paint(err, 'bold', line)}\n`),
      warn: (line) => process.stderr.write(`${paint(err, 'yellow', `  ⚠ ${line}`)}\n`),
      onPage: (page, done, total) =>
        process.stderr.write(`${progressLine(err, page, done, total)}\n`),
    },
  })
  const server = await startHub({ library, port, by: values.by ?? 'interface web' })
  process.stderr.write(
    `${paint(err, 'bold', 'RGAA checker :')} ${server.url}  — audits dans ${root} (Ctrl+C pour quitter)\n`,
  )
  await waitForInterrupt()
  await server.close()
  return EXIT.OK
}
