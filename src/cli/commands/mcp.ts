import { cookieInputs } from '../../core/auth.ts'
import { EXIT } from '../../core/errors.ts'
import { CAPTURE_MODES } from '../../core/runner.ts'
import { serveMcp } from '../../mcp/protocol.ts'
import { DECIDE_MODES, RgaaTools } from '../../mcp/tools.ts'
import { safeLine } from '../../security/text.ts'
import { parseSiteUrl } from '../../security/url.ts'
import { DEFAULT_PORT } from '../../server/http.ts'
import { MCP_HELP } from '../help.ts'
import {
  absolute,
  choiceOption,
  DEFAULTS,
  integerOption,
  listOption,
  parseCommand,
} from '../options.ts'

/**
 * Serveur MCP sur l'entrée et la sortie standard : une IA (Claude Code, un
 * autre client MCP) pilote l'outil. La sortie standard est réservée au
 * protocole ; les journaux vont sur la sortie d'erreur.
 */
export async function commandMcp(args: string[]): Promise<number> {
  const { values } = parseCommand('mcp', args, {
    out: { type: 'string' },
    decisions: { type: 'string' },
    sites: { type: 'string', multiple: true },
    concurrency: { type: 'string' },
    captures: { type: 'string' },
    by: { type: 'string' },
    decide: { type: 'string' },
    cookie: { type: 'string', multiple: true },
    'storage-state': { type: 'string' },
    serve: { type: 'boolean', default: false },
    port: { type: 'string' },
    'browser-libs': { type: 'string' },
    sandbox: { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) {
    process.stdout.write(MCP_HELP)
    return EXIT.OK
  }
  const sites = listOption(values.sites).map((site) => parseSiteUrl(site).origin)
  const tools = new RgaaTools({
    outDir: absolute(values.out ?? DEFAULTS.out),
    decisionsDir: absolute(values.decisions ?? DEFAULTS.decisions),
    concurrency: integerOption(values.concurrency, 'concurrency', 2, 1, 8),
    captures: choiceOption(values.captures, 'captures', CAPTURE_MODES, 'tout'),
    browserLibs: values['browser-libs'] ?? process.env.RGAA_BROWSER_LIBS,
    sandbox: values.sandbox !== false,
    sites: sites.length ? sites : null,
    by: safeLine(values.by ?? 'IA (MCP)', 100) || 'IA (MCP)',
    decide: choiceOption(values.decide, 'decide', DECIDE_MODES, 'tout'),
    auth: {
      storageState: values['storage-state'] ? absolute(values['storage-state']) : undefined,
      cookies: cookieInputs(values.cookie, process.env.RGAA_COOKIES),
    },
    serve: values.serve,
    port: integerOption(values.port, 'port', DEFAULT_PORT, 0, 65_535),
    log: (line) => process.stderr.write(`[rgaa] ${line}\n`),
  })
  process.stderr.write('[rgaa] Serveur MCP prêt (stdio).\n')
  await serveMcp(tools.handlers())
  await tools.settle()
  await tools.close()
  return EXIT.OK
}
