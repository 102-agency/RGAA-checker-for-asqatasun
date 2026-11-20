import { EXIT, errorMessage, UserError } from '../core/errors.ts'
import { paint, shouldColor, terminalWidth } from '../report/style.ts'
import { safeText } from '../security/text.ts'
import { commandAudit } from './commands/audit.ts'
import { commandDecide } from './commands/decide.ts'
import { commandExplain } from './commands/explain.ts'
import { commandMcp } from './commands/mcp.ts'
import { commandPending } from './commands/pending.ts'
import { commandReport } from './commands/report.ts'
import { commandServe } from './commands/serve.ts'
import { commandWeb } from './commands/web.ts'
import { MAIN_HELP } from './help.ts'
import { toolVersion } from './options.ts'

const COMMANDS: Record<string, (args: string[]) => number | Promise<number>> = {
  audit: commandAudit,
  report: commandReport,
  pending: commandPending,
  decide: commandDecide,
  explain: commandExplain,
  serve: commandServe,
  web: commandWeb,
  mcp: commandMcp,
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(MAIN_HELP)
    return command ? EXIT.OK : EXIT.USAGE
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${toolVersion()}\n`)
    return EXIT.OK
  }
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined
  if (!run) {
    const hint = /^https?:\/\//.test(command) ? ` Pour auditer ce site : rgaa audit ${command}` : ''
    throw new UserError(
      `Commande inconnue « ${command.slice(0, 40)} ».${hint}\n  Aide : rgaa --help`,
    )
  }
  return run(rest)
}

/** Affiche une erreur sur la sortie d'erreur et renvoie le code de sortie correspondant. */
export function reportError(error: unknown): number {
  const style = {
    color: shouldColor(process.stderr, process.env),
    width: terminalWidth(process.stderr),
  }
  if (error instanceof UserError) {
    process.stderr.write(`${paint(style, 'red', '✗')} ${safeText(error.message)}\n`)
    return EXIT.USAGE
  }
  process.stderr.write(
    `${paint(style, 'red', '✗ Erreur inattendue :')} ${safeText(errorMessage(error))}\n`,
  )
  if (process.env.RGAA_DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${safeText(error.stack)}\n`)
  } else {
    process.stderr.write('  (RGAA_DEBUG=1 pour la pile d’appels)\n')
  }
  return EXIT.FAILURE
}
