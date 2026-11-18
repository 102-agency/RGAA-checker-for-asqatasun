import { readFileSync } from 'node:fs'
import { AuditController } from '../app/controller.ts'
import type { SessionConfig, SessionHooks, SessionResult } from '../app/session.ts'
import { explainLines } from '../cli/commands/explain.ts'
import { resolveScope, TOOL_NAME, toolVersion } from '../cli/options.ts'
import { DOUBT } from '../core/answers.ts'
import type { AuthSettings } from '../core/auth.ts'
import { SCREENSHOT_PATH } from '../core/capture.ts'
import { type Catalog, loadCatalog } from '../core/catalog.ts'
import { DecisionStore } from '../core/decisions.ts'
import type { CaptureMode } from '../core/runner.ts'
import {
  buildToFix,
  renderFullResults,
  renderToFixCompact,
  renderToFixMarkdown,
  type ToFixDocument,
} from '../report/ai.ts'
import { diffReports, renderDiff } from '../report/diff.ts'
import { type ReportDocument, siteOverview } from '../report/model.ts'
import { REPORT_JSON, readReport } from '../report/parse.ts'
import { containedPath } from '../security/fs.ts'
import { safeLine } from '../security/text.ts'
import { parseSiteUrl } from '../security/url.ts'
import { Reader } from '../security/validate.ts'
import { startUiServer, type UiServer } from '../server/http.ts'
import { DecisionError } from '../server/state.ts'
import {
  type CallContext,
  type McpHandlers,
  type ToolDefinition,
  ToolError,
  type ToolResult,
} from './protocol.ts'

/**
 * Outils MCP : une IA peut auditer un site ou quelques pages, lire ce qu'il
 * faut corriger, trancher les questions, voir les captures, puis relancer
 * l'audit des pages corrigées. L'outil reste autonome : aucun modèle n'est
 * appelé, le serveur MCP ne fait que l'exposer.
 */

/**
 * Ce que ce serveur laisse faire de `trancher_question` :
 * - `tout`   : toute réponse admise par la question (rôle « juge ») ;
 * - `doute`  : seulement « doute » (consigner une hésitation sans rien décider) ;
 * - `aucune` : l'outil n'est même pas proposé (rôle « correcteur »).
 * C'est le serveur qui l'impose : une consigne donnée au modèle ne suffirait pas.
 */
export const DECIDE_MODES = ['tout', 'doute', 'aucune'] as const
export type DecideMode = (typeof DECIDE_MODES)[number]

export interface McpOptions {
  outDir: string
  decisionsDir: string
  concurrency: number
  captures: CaptureMode
  browserLibs?: string
  sandbox: boolean
  /** Origines autorisées (`https://exemple.fr`) ; `null` = tout site http(s). */
  sites: string[] | null
  /** Auteur inscrit dans les décisions prises par l'IA. */
  by: string
  /** Ce que l'IA peut faire de `trancher_question`. */
  decide: DecideMode
  /** Pages derrière une connexion (jamais écrites dans le rapport). */
  auth?: AuthSettings
  /** Ouvre aussi l'interface web locale, pour suivre ce que fait l'IA. */
  serve: boolean
  port: number
  log: (line: string) => void
}

const TEXT_LIMIT = 200_000
const SCOPE_PROPERTIES = {
  themes: {
    type: 'array',
    items: { type: 'string' },
    description: 'Limite à ces thématiques (« 1 » à « 13 »).',
  },
  criteres: {
    type: 'array',
    items: { type: 'string' },
    description: 'Limite à ces critères (« 1.1 »).',
  },
  tests: {
    type: 'array',
    items: { type: 'string' },
    description: 'Limite à ces tests (« 1.1.1 »).',
  },
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'auditer_site',
    title: 'Auditer un site (RGAA 4.1.2)',
    description:
      'Audite toutes les pages du sitemap d’un site (ou les premières, avec « limite ») dans un vrai navigateur, selon les 258 tests du RGAA 4.1.2. Écrit le rapport (a-corriger.md/json, resultats-complets.md, captures) et renvoie un bilan. Long : plusieurs minutes pour quelques dizaines de pages. Pour vérifier une correction, préférer auditer_pages.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Adresse du site (http ou https), ex. http://localhost:3000',
        },
        limite: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Nombre maximal de pages (défaut 500).',
        },
        ...SCOPE_PROPERTIES,
        attendre: {
          type: 'boolean',
          description:
            'true (défaut) : attend la fin et renvoie le bilan. false : lance l’audit en arrière-plan ; suivre avec etat_audit.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'auditer_pages',
    title: 'Auditer quelques pages',
    description:
      'Audite seulement les chemins donnés (ex. ["/", "/contact"]) et, par défaut, fusionne le résultat dans le rapport existant du site : c’est la boucle « corriger, réauditer la page, relire a-corriger ». Les tests inter-pages (navigation cohérente…) gardent leur verdict jusqu’au prochain audit complet.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Adresse du site (http ou https).' },
        chemins: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 50,
          description: 'Chemins des pages, ex. ["/contact"].',
        },
        fusionner: {
          type: 'boolean',
          description:
            'true (défaut) : met à jour le rapport existant. false : rapport limité à ces pages.',
        },
        ...SCOPE_PROPERTIES,
        attendre: { type: 'boolean', description: 'true (défaut) : attend la fin.' },
      },
      required: ['url', 'chemins'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'etat_audit',
    title: 'État de l’audit',
    description:
      'Indique si un audit est en cours (pages faites / total) et résume le dernier rapport.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lire_a_corriger',
    title: 'Lire ce qu’il faut corriger',
    description:
      'Renvoie les non-conformités (critère RGAA, piste de correction, élément, extrait HTML, capture, pages) et les questions/doutes à trancher (réponses admises et leur sens) du dernier audit. Filtrable par page, par test ou par type de correction. Format « compact » (défaut, le plus économe en tokens), « markdown » (énoncés officiels complets) ou « json ».',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['compact', 'markdown', 'json'],
          description: 'Défaut : compact.',
        },
        correction: {
          type: 'string',
          enum: ['mecanique', 'a-concevoir'],
          description:
            'Seulement les non-conformités dont la correction est mécanique (changement connu d’avance : lang, alt, label…) ou à concevoir (couleur, libellé, mise en page). Sans piste connue : à concevoir.',
        },
        contenu: {
          type: 'string',
          enum: ['tout', 'non-conformites', 'questions'],
          description: 'Défaut : tout.',
        },
        page: { type: 'string', description: 'Seulement ce chemin, ex. /contact.' },
        test: {
          type: 'string',
          description: 'Seulement ce test, critère ou thématique (« 1.1.1 », « 11.10 », « 3 »).',
        },
        max_caracteres: {
          type: 'integer',
          minimum: 1000,
          maximum: 200000,
          description: 'Défaut 40000.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'resultats_complets',
    title: 'Résultats complets',
    description:
      'Tous les tests RGAA avec leur verdict sur chaque page : conforme, non conforme, à valider (doute), non applicable.',
    inputSchema: {
      type: 'object',
      properties: {
        test: { type: 'string', description: 'Seulement ce test, critère ou thématique.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'trancher_question',
    title: 'Trancher une question',
    description:
      'Enregistre la réponse à une question de jugement (empreinte donnée par lire_a_corriger). Réponses admises : celles de la question, plus « doute » (la question reste ouverte). Une justification est obligatoire. Relancer ensuite auditer_pages pour appliquer la décision.',
    inputSchema: {
      type: 'object',
      properties: {
        empreinte: { type: 'string', description: '12 caractères hexadécimaux.' },
        reponse: { type: 'string' },
        justification: { type: 'string' },
      },
      required: ['empreinte', 'reponse', 'justification'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'voir_capture',
    title: 'Voir une capture',
    description:
      'Renvoie l’image PNG d’une capture du rapport (chemin « preuves/… » cité par lire_a_corriger) : la zone concernée y est encadrée en rouge.',
    inputSchema: {
      type: 'object',
      properties: {
        chemin: { type: 'string', description: 'ex. preuves/echecs/3f2a9c81d0e4.png' },
      },
      required: ['chemin'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'expliquer_rgaa',
    title: 'Expliquer un test du RGAA',
    description:
      'Intitulé officiel, cas particuliers et notes techniques d’un test (« 1.1.1 »), d’un critère (« 1.1 ») ou d’une thématique (« 1 ») du RGAA 4.1.2.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } },
      required: ['ids'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
]

const BASE_INSTRUCTIONS = `Audit d'accessibilité RGAA 4.1.2 (niveau AA) en vrai navigateur.
Boucle de travail : auditer_site (ou auditer_pages) → lire_a_corriger → corriger le code du site → auditer_pages sur les chemins corrigés → relire.
Les non-conformités sont mesurées. Chacune porte, quand elle existe, une « piste de correction » de type mécanique (changement connu d'avance) ou à concevoir (choix à faire).
Après auditer_pages, le bilan donne la différence avec le rapport précédent : ce qui est corrigé, ce qui reste, et les NOUVELLES non-conformités que la correction a introduites (à défaire ou à corriger avant d'aller plus loin).
Les chemins de captures (preuves/…) sont relatifs au dossier du rapport.`

const DECIDE_INSTRUCTIONS: Record<DecideMode, string> = {
  tout: `Les questions sont des doutes que l'outil ne peut pas lever seul : les trancher avec trancher_question (réponse justifiée par ce que montrent les preuves et la capture, « doute » si l'on ne sait pas), en s'aidant de voir_capture. Ne jamais répondre « ok » ou « neutre » pour faire disparaître une question : une réponse à tort produit un faux « conforme ».`,
  doute: `Les questions sont des doutes que ce serveur ne vous laisse pas trancher : trancher_question n'accepte que « doute » (avec justification), pour consigner une hésitation. La décision revient à une personne ou au rôle « juge ».`,
  aucune: `Les questions de jugement ne sont pas de votre ressort sur ce serveur : ne les traiter pas, ne pas corriger à leur place. Corrigez les non-conformités qui vous sont confiées ; les questions restent à trancher par le rôle « juge ».`,
}

/** Le texte dépasse-t-il la limite ? On coupe proprement et on le dit. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n… (tronqué à ${max} caractères sur ${text.length} : filtrer par page ou par test, ou augmenter max_caracteres)`
}

function matchesTest(test: string, filter: string): boolean {
  return test === filter || test.startsWith(`${filter}.`)
}

function filterToFix(
  doc: ToFixDocument,
  options: { page?: string; test?: string; content: string; correction?: string },
): ToFixDocument {
  const { page, test } = options
  const nonConformities =
    options.content === 'questions'
      ? []
      : doc.nonConformities
          .filter((item) => !test || matchesTest(item.test, test))
          .filter(
            (item) =>
              !options.correction ||
              (item.remediation?.kind ?? 'a-concevoir') === options.correction,
          )
          .filter((item) => !page || item.pages.includes(page))
          .map((item) =>
            page
              ? { ...item, occurrences: item.occurrences.filter((o) => o.pages.includes(page)) }
              : item,
          )
  const questions =
    options.content === 'non-conformites'
      ? []
      : doc.questions
          .filter((item) => !test || item.tests.some((entry) => matchesTest(entry.test, test)))
          .filter((item) => !page || item.pages.includes(page))
  return { ...doc, nonConformities, questions }
}

function summaryText(
  report: ReportDocument,
  result?: SessionResult,
  url?: string,
  before?: ReportDocument,
): string {
  const overview = siteOverview(report)
  const doc = buildToFix(report, loadCatalog())
  const lines = [
    `${result ? 'Audit terminé' : 'Dernier rapport'} : ${report.meta.baseUrl} — ${report.pages.length} page(s)${result?.merged ? ' (pages réauditées fusionnées au rapport existant)' : ''}.`,
    `Bilan : ${overview.issues.length} test(s) non conforme(s) (${doc.summary.occurrences} occurrence(s) détaillée(s)), ${doc.summary.questions} question(s) à trancher, ${doc.summary.doubts} doute(s) maintenu(s).`,
    `Taux de conformité des critères : ${overview.globalRate === null ? '—' : `${String(overview.globalRate).replace('.', ',')} %`}${overview.openTests ? ' (provisoire : des tests restent à valider)' : ''}.`,
    '',
    'Pages :',
    ...report.pages.map(
      (page) =>
        `- ${page.path} : ${page.error ? `non auditée (${page.error})` : `${page.counts.NC} non conforme(s), ${page.counts.AV} à valider`}`,
    ),
  ]
  if (result) {
    lines.push(
      '',
      'Fichiers :',
      `- ${result.written.toFixMarkdown}`,
      `- ${result.written.toFixJson}`,
      `- ${result.written.fullResults}`,
    )
  }
  if (before) lines.push('', renderDiff(diffReports(before, report)))
  if (url) lines.push('', `Interface web en direct : ${url}`)
  lines.push(
    '',
    'Suite : lire_a_corriger pour le détail, corriger, puis auditer_pages sur les chemins corrigés.',
  )
  return lines.join('\n')
}

/** Les outils proposés selon ce que le serveur laisse trancher. */
export function toolsFor(decide: DecideMode): ToolDefinition[] {
  if (decide === 'aucune') return TOOLS.filter((tool) => tool.name !== 'trancher_question')
  if (decide === 'tout') return TOOLS
  return TOOLS.map((tool) =>
    tool.name === 'trancher_question'
      ? {
          ...tool,
          description:
            'Consigne un doute sur une question de jugement (empreinte donnée par lire_a_corriger) : seule la réponse « doute » est admise, avec une justification. La question reste ouverte.',
        }
      : tool,
  )
}

export class RgaaTools {
  private controller: AuditController | undefined
  private server: UiServer | undefined
  private readonly catalog: Catalog = loadCatalog()
  private lastRun: Promise<SessionResult> | undefined

  constructor(private readonly options: McpOptions) {}

  handlers(): McpHandlers {
    return {
      serverInfo: { name: TOOL_NAME, version: toolVersion() },
      instructions: `${BASE_INSTRUCTIONS}\n${DECIDE_INSTRUCTIONS[this.options.decide]}`,
      tools: toolsFor(this.options.decide),
      call: (name, args, context) => this.call(name, args, context),
    }
  }

  async close(): Promise<void> {
    await this.server?.close()
  }

  private site(input: unknown): URL {
    const read = new Reader('argument url')
    const base = parseSiteUrl(read.string(input, 'url', 2_000))
    if (this.options.sites && !this.options.sites.includes(base.origin)) {
      throw new ToolError(
        `Site non autorisé : ${base.origin}. Sites admis par ce serveur MCP (--sites) : ${this.options.sites.join(', ')}.`,
      )
    }
    return base
  }

  private config(base: URL, args: Record<string, unknown>, paths: string[], merge: boolean) {
    const read = new Reader('arguments')
    const list = (value: unknown, name: string) =>
      value === undefined ? [] : read.stringList(value, name, 300).map((item) => item.trim())
    const scope = resolveScope(this.catalog, {
      themes: list(args.themes, 'themes'),
      criteria: list(args.criteres, 'criteres'),
      tests: list(args.tests, 'tests'),
    })
    const limit = args.limite === undefined ? 500 : read.number(args.limite, 'limite')
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ToolError('« limite » doit être un entier entre 1 et 500.')
    }
    const config: SessionConfig = {
      base,
      paths,
      limit,
      concurrency: this.options.concurrency,
      scope,
      outDir: this.options.outDir,
      decisionsDir: this.options.decisionsDir,
      asqatasunDir: null,
      browserLibs: this.options.browserLibs,
      sandbox: this.options.sandbox,
      strict: false,
      captures: this.options.captures,
      merge,
      auth: this.options.auth,
    }
    return config
  }

  private async start(
    config: SessionConfig,
    context: CallContext,
    wait: boolean,
    paths?: string[],
  ): Promise<ToolResult> {
    const hooks: SessionHooks = {
      log: this.options.log,
      warn: (line) => this.options.log(`⚠ ${line}`),
    }
    if (!this.controller) this.controller = new AuditController(config, hooks)
    else this.controller.reconfigure(config)
    if (this.options.serve && !this.server) {
      const controller = this.controller
      this.server = await startUiServer({
        state: controller.state,
        outDir: this.options.outDir,
        port: this.options.port,
        by: this.options.by,
        rerun: (next) => controller.rerun(next),
      })
      this.options.log(`Interface web : ${this.server.url}`)
    }
    const before = this.previousReport(config.base)
    const run = this.controller.run({
      paths,
      onPage: (page, done, total) => context.progress(done, total, `Page ${page.path} auditée`),
    })
    this.lastRun = run
    if (!wait) {
      run.catch(() => {})
      return text(
        `Audit lancé en arrière-plan sur ${config.base.origin}. Suivre avec etat_audit.${this.server ? `\nInterface web : ${this.server.url}` : ''}`,
      )
    }
    const result = await run
    return text(summaryText(result.report, result, this.server?.url, before))
  }

  /** Rapport d'avant l'audit, pour en montrer la différence (absent s'il n'y en a pas, ou d'un autre site). */
  private previousReport(base: URL): ReportDocument | undefined {
    try {
      const report = this.report()
      return new URL(report.meta.baseUrl).origin === base.origin ? report : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Dernier rapport écrit. Le disque fait foi, pas la mémoire : deux serveurs
   * (juge et correcteur) partagent le même dossier, et l'un réaudite pendant
   * que l'autre lit. L'état en mémoire ne sert que si rien n'est écrit.
   */
  private report(): ReportDocument {
    try {
      return readReport(containedPath(this.options.outDir, REPORT_JSON))
    } catch (error) {
      const live = this.controller?.state.lastReport
      if (live) return live
      throw error
    }
  }

  /** Décisions relues sur le disque à chaque appel : l'autre serveur a pu en écrire. */
  private decisions(report: ReportDocument): DecisionStore {
    return new DecisionStore(report.meta.decisionsDir)
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    context: CallContext,
  ): Promise<ToolResult> {
    const read = new Reader('arguments')
    switch (name) {
      case 'auditer_site': {
        const base = this.site(args.url)
        const wait = args.attendre === undefined ? true : read.boolean(args.attendre, 'attendre')
        return this.start(this.config(base, args, [], false), context, wait)
      }
      case 'auditer_pages': {
        const base = this.site(args.url)
        const paths = read.stringList(args.chemins, 'chemins', 50).map((path) => {
          const clean = path.trim()
          if (!clean.startsWith('/'))
            throw new ToolError(
              `Chemin invalide « ${safeLine(clean, 80)} » : il doit commencer par /.`,
            )
          return clean
        })
        if (paths.length === 0) throw new ToolError('Aucun chemin donné.')
        const merge =
          args.fusionner === undefined ? true : read.boolean(args.fusionner, 'fusionner')
        const wait = args.attendre === undefined ? true : read.boolean(args.attendre, 'attendre')
        const config = this.config(base, args, merge ? [] : paths, false)
        return this.start(config, context, wait, merge ? paths : undefined)
      }
      case 'etat_audit': {
        const snapshot = this.controller?.state.snapshot()
        const lines: string[] = []
        if (snapshot?.status === 'en-cours') {
          lines.push(
            `Audit en cours sur ${snapshot.site} : ${snapshot.progress.done} / ${snapshot.progress.total} pages — ${snapshot.progress.phase}.`,
            `En cours : ${snapshot.progress.current.join(', ') || '—'}`,
            `Constaté jusqu’ici : ${snapshot.issues.length} test(s) non conforme(s), ${snapshot.questions.length} question(s).`,
          )
        } else if (snapshot?.status === 'erreur') {
          lines.push(`Dernier audit interrompu : ${snapshot.message ?? ''}`)
        } else {
          lines.push('Aucun audit en cours.')
        }
        try {
          lines.push('', summaryText(this.report()))
        } catch {
          lines.push('Aucun rapport encore écrit.')
        }
        if (this.server) lines.push('', `Interface web : ${this.server.url}`)
        return text(lines.join('\n'))
      }
      case 'lire_a_corriger': {
        const format =
          args.format === undefined
            ? 'compact'
            : read.oneOf(args.format, ['compact', 'markdown', 'json'] as const, 'format')
        const correction =
          args.correction === undefined
            ? undefined
            : read.oneOf(args.correction, ['mecanique', 'a-concevoir'] as const, 'correction')
        const content =
          args.contenu === undefined
            ? 'tout'
            : read.oneOf(args.contenu, ['tout', 'non-conformites', 'questions'] as const, 'contenu')
        const page = read.optionalString(args.page, 'page', 2_000)
        const test = read.optionalString(args.test, 'test', 20)
        const max =
          args.max_caracteres === undefined
            ? 40_000
            : Math.min(TEXT_LIMIT, read.number(args.max_caracteres, 'max_caracteres'))
        const report = this.report()
        const store = this.decisions(report)
        const doc = filterToFix(
          buildToFix(report, this.catalog, {
            outDir: this.options.outDir,
            decisions: (topic, key) => store.peek(topic, key),
          }),
          { page, test, content, correction },
        )
        const body =
          format === 'json'
            ? JSON.stringify(doc, null, 1)
            : format === 'compact'
              ? renderToFixCompact(doc)
              : renderToFixMarkdown(doc)
        return text(clip(`Dossier du rapport : ${this.options.outDir}\n\n${body}`, max))
      }
      case 'resultats_complets': {
        const test = read.optionalString(args.test, 'test', 20)
        const report = this.report()
        const filtered = test
          ? {
              ...report,
              pages: report.pages.map((page) => ({
                ...page,
                tests: page.tests.filter((entry) => matchesTest(entry.test, test)),
              })),
            }
          : report
        return text(clip(renderFullResults(filtered, this.catalog), TEXT_LIMIT))
      }
      case 'trancher_question': {
        if (this.options.decide === 'aucune') {
          throw new ToolError(
            'Ce serveur ne permet pas de trancher les questions (--decide aucune).',
          )
        }
        const key = read.matching(
          args.empreinte,
          /^[0-9a-f]{12}$/,
          'empreinte',
          '12 caractères hexadécimaux',
        )
        const answer = read.string(args.reponse, 'reponse', 100)
        if (this.options.decide === 'doute' && answer !== DOUBT) {
          throw new ToolError(
            'Ce serveur n’admet que la réponse « doute » (--decide doute) : consigner l’hésitation avec une justification ; la décision revient au rôle « juge » ou à une personne.',
          )
        }
        const reason = safeLine(read.string(args.justification, 'justification', 2_000), 2_000)
        if (!reason) throw new ToolError('Une justification est obligatoire.')
        if (this.controller) {
          try {
            const question = this.controller.state.decide({
              key,
              answer,
              reason,
              by: this.options.by,
            })
            return text(
              answer === DOUBT
                ? `Doute enregistré pour ${key} (${question.topic}) : la question reste ouverte et figure dans a-corriger.`
                : `Décision « ${answer} » enregistrée pour ${key} (${question.topic}). Relancer auditer_pages sur ${question.pages.join(', ')} pour l’appliquer.`,
            )
          } catch (error) {
            // Question absente de l'état en direct (audit en cours…) : on passe par le rapport écrit.
            if (!(error instanceof DecisionError)) throw error
          }
        }
        const report = this.report()
        const item = report.pending.find((entry) => entry.key === key)
        if (!item)
          throw new ToolError(
            'Aucune question en attente avec cette empreinte dans le dernier rapport.',
          )
        if (answer !== DOUBT && !item.answers.includes(answer)) {
          throw new ToolError(`Réponse refusée (admises : ${[...item.answers, DOUBT].join(', ')}).`)
        }
        const store = new DecisionStore(report.meta.decisionsDir)
        store.set(item.topic, key, {
          answer,
          evidence: item.evidence,
          question: item.question,
          reason,
          by: this.options.by,
          date: new Date().toISOString().slice(0, 10),
        })
        return text(
          `Décision « ${answer} » enregistrée pour ${key} (${item.topic}). Relancer l’audit des pages concernées pour l’appliquer.`,
        )
      }
      case 'voir_capture': {
        const path = read.string(args.chemin, 'chemin', 300)
        if (!SCREENSHOT_PATH.test(path)) {
          throw new ToolError(
            'Chemin de capture invalide : attendu preuves/<dossier>/<empreinte>.png',
          )
        }
        const data = readFileSync(containedPath(this.options.outDir, ...path.split('/')))
        return {
          content: [{ type: 'image', data: data.toString('base64'), mimeType: 'image/png' }],
        }
      }
      case 'expliquer_rgaa': {
        const ids = read.stringList(args.ids, 'ids', 20).map((id) => id.trim())
        return text(explainLines(ids, { color: false, width: 100 }).join('\n'))
      }
      default:
        throw new ToolError(`Outil inconnu : ${name}`)
    }
  }

  /** Attend la fin d'un audit lancé en arrière-plan (fermeture propre). */
  async settle(): Promise<void> {
    await this.lastRun?.catch(() => {})
  }
}

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] }
}
