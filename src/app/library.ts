import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { resolveScope } from '../cli/options.ts'
import { resolveAuth } from '../core/auth.ts'
import { type Catalog, loadCatalog } from '../core/catalog.ts'
import { UserError } from '../core/errors.ts'
import { CAPTURE_MODES, type CaptureMode } from '../core/runner.ts'
import { type PageState, type ReportDocument, siteOverview } from '../report/model.ts'
import { REPORT_JSON, readReport } from '../report/parse.ts'
import { canonicalPath, parseSiteUrl, resolvePageUrl } from '../security/url.ts'
import type { RunStatus } from '../server/state.ts'
import { AuditController } from './controller.ts'
import { configFromReport, type SessionConfig, type SessionHooks } from './session.ts'

/**
 * Bibliothèque des audits d'un dossier de travail (`audits/` par défaut) : un
 * dossier par audit, daté. Elle reconnaît les deux dispositions qui existent
 * (`<audit>/rapport.json`, ou `<audit>/rapport/rapport.json` avec
 * `<audit>/decisions/`), crée de nouveaux audits et ouvre à la demande le
 * contrôleur de chacun, pour que l'interface travaille sur n'importe lequel.
 */

/** Ce que la page d'accueil montre d'un audit : uniquement des données. */
export interface AuditSummary {
  id: string
  /** Adresse du site audité. */
  site: string
  /** Hôte (avec le port s'il y en a un), pour regrouper les audits d'un même site. */
  host: string
  status: RunStatus | 'illisible'
  message?: string
  startedAt: string | null
  durationMs: number | null
  pages: number
  states: Record<PageState, number>
  /** Taux moyen des critères, en % ; `null` tant qu'aucune page n'est mesurée. */
  averageRate: number | null
  globalRate: number | null
  /** Questions qui attendent une réponse. */
  pending: number
  decisions: number
  /** Audit d'une partie du site (pages ou thématiques choisies). */
  partial: boolean
  progress?: { done: number; total: number }
  /** Dossier du rapport, relatif au dossier de travail quand c'est possible. */
  location: string
}

export interface LibraryOptions {
  /** Dossier qui contient les audits. */
  root: string
  /** Dossiers de rapport hors du dossier de travail à lister aussi (`./rgaa-report`). */
  extra?: { id: string; reportDir: string; decisionsDir: string }[]
  /** Réglages locaux (navigateur, concurrence…) communs à tous les audits lancés d'ici. */
  defaults: Pick<SessionConfig, 'concurrency' | 'browserLibs' | 'sandbox' | 'captures' | 'limit'>
  hooks?: SessionHooks
}

/** Formulaire « nouvelle analyse », une fois validé. */
export interface NewAudit {
  url: string
  pages: string[]
  themes: number[]
  limit: number
  captures: CaptureMode
  asqatasunDir?: string
  storageState?: string
  cookies: string[]
  /** Reprend les décisions du dernier audit du même site. */
  reuseDecisions: boolean
}

interface Entry {
  id: string
  reportDir: string
  decisionsDir: string
}

interface Active {
  controller: AuditController
  reportDir: string
}

const MAX_PAGES_TEXT = 8_000
const MAX_PATHS = 200
const MAX_COOKIES_TEXT = 8_000

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/** Identifiant lisible d'un site : son hôte, sans caractère douteux. */
export function siteSlug(url: URL): string {
  return (
    url.host
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'site'
  )
}

function today(now: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

function text(value: unknown, name: string, max: number): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > max) {
    throw new UserError(`Champ « ${name} » invalide ou trop long.`)
  }
  return value
}

/** Valide le formulaire « nouvelle analyse » : rien n'est lancé tant que tout n'est pas bon. */
export function parseNewAudit(body: unknown, catalog: Catalog): NewAudit {
  if (typeof body !== 'object' || body === null) throw new UserError('Formulaire invalide.')
  const form = body as Record<string, unknown>
  const url = text(form.url, 'adresse', 2_000).trim()
  if (!url) throw new UserError('Indiquer l’adresse du site à analyser.')
  parseSiteUrl(url)

  const pages = Array.from(
    new Set(
      text(form.pages, 'pages', MAX_PAGES_TEXT)
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  )
  if (pages.length > MAX_PATHS) throw new UserError(`Au plus ${MAX_PATHS} pages à la fois.`)

  const rawThemes = form.themes ?? []
  if (!Array.isArray(rawThemes)) throw new UserError('Champ « thématiques » invalide.')
  const themes = Array.from(new Set(rawThemes.map((item) => Number(item)))).sort((a, b) => a - b)
  for (const theme of themes) {
    if (!Number.isInteger(theme) || !catalog.themes.has(theme)) {
      throw new UserError('Thématique inconnue : elles vont de 1 à 13.')
    }
  }

  const limit = form.limit === undefined || form.limit === '' ? 500 : Number(form.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new UserError('Le nombre maximal de pages doit être compris entre 1 et 10 000.')
  }
  const captures = (form.captures ?? 'tout') as CaptureMode
  if (!CAPTURE_MODES.includes(captures)) {
    throw new UserError(`Captures : ${CAPTURE_MODES.join(', ')}.`)
  }

  const cookies = text(form.cookies, 'cookies', MAX_COOKIES_TEXT)
    .split(/\r?\n|;/)
    .map((item) => item.trim())
    .filter(Boolean)
  return {
    url,
    pages,
    themes,
    limit,
    captures,
    asqatasunDir: text(form.asqatasunDir, 'dossier Asqatasun', 1_000).trim() || undefined,
    storageState: text(form.storageState, 'état de session', 1_000).trim() || undefined,
    cookies,
    reuseDecisions: form.reuseDecisions !== false,
  }
}

export class AuditLibrary {
  readonly catalog = loadCatalog()
  private readonly active = new Map<string, Active>()
  private readonly cache = new Map<string, { key: string; report: ReportDocument | Error }>()

  constructor(private readonly options: LibraryOptions) {}

  get root(): string {
    return this.options.root
  }

  get defaults(): LibraryOptions['defaults'] {
    return this.options.defaults
  }

  /** Une analyse tourne en ce moment (une seule à la fois : le navigateur est lourd). */
  get running(): string | null {
    for (const [id, active] of this.active) if (active.controller.running) return id
    return null
  }

  private readCached(file: string): ReportDocument | Error {
    try {
      const stat = statSync(file)
      const key = `${stat.mtimeMs}:${stat.size}`
      const known = this.cache.get(file)
      if (known?.key === key) return known.report
      let report: ReportDocument | Error
      try {
        report = readReport(file)
      } catch (error) {
        report = error instanceof Error ? error : new Error(String(error))
      }
      this.cache.set(file, { key, report })
      return report
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  /** Dossiers d'audit du dossier de travail, plus les rapports hors dossier. */
  private scan(): Entry[] {
    const entries: Entry[] = []
    let names: string[] = []
    try {
      names = readdirSync(this.options.root).sort()
    } catch {
      names = []
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const dir = join(this.options.root, name)
      if (!isDirectory(dir)) continue
      const reportDir = [dir, join(dir, 'rapport')].find((candidate) =>
        isFile(join(candidate, REPORT_JSON)),
      )
      if (!reportDir) continue
      entries.push({ id: name, reportDir, decisionsDir: this.decisionsFor(dir, reportDir) })
    }
    const known = new Set(entries.map((entry) => entry.reportDir))
    for (const extra of this.options.extra ?? []) {
      if (known.has(extra.reportDir) || !isFile(join(extra.reportDir, REPORT_JSON))) continue
      if (entries.some((entry) => entry.id === extra.id)) continue
      entries.push(extra)
    }
    return entries
  }

  /** `<audit>/decisions` s'il existe, sinon le dossier noté dans le rapport, sinon `<audit>/decisions`. */
  private decisionsFor(dir: string, reportDir: string): string {
    const own = join(dir, 'decisions')
    if (isDirectory(own)) return own
    const report = this.readCached(join(reportDir, REPORT_JSON))
    if (!(report instanceof Error) && isDirectory(report.meta.decisionsDir)) {
      return report.meta.decisionsDir
    }
    return own
  }

  /** Chemin affiché : relatif au dossier courant quand l'audit s'y trouve. */
  private place(path: string): string {
    const shown = relative(process.cwd(), path)
    return shown && !shown.startsWith('..') ? shown : path
  }

  private summarize(id: string, reportDir: string, report: ReportDocument): AuditSummary {
    const overview = siteOverview(report)
    const url = new URL(report.meta.baseUrl)
    const scope = report.meta.scope
    return {
      id,
      site: report.meta.baseUrl,
      host: url.host,
      status: 'termine',
      startedAt: report.meta.startedAt,
      durationMs: report.meta.durationMs,
      pages: report.pages.length,
      states: overview.states,
      averageRate: overview.averageRate,
      globalRate: overview.globalRate,
      pending: report.pending.length,
      decisions: report.meta.decisionsCount,
      partial:
        report.meta.pagesSource === 'arguments' ||
        scope.themes.length + scope.criteria.length + scope.tests.length > 0,
      location: this.place(reportDir),
    }
  }

  /** Les audits, du plus récent au plus ancien ; ceux qui tournent en tête. */
  list(): AuditSummary[] {
    const out: AuditSummary[] = []
    const seen = new Set<string>()
    for (const entry of this.scan()) {
      seen.add(entry.id)
      out.push(this.describe(entry.id, entry.reportDir))
    }
    for (const [id, active] of this.active) {
      if (seen.has(id)) continue
      out.push(this.describe(id, active.reportDir))
    }
    const time = (item: AuditSummary) => (item.startedAt ? Date.parse(item.startedAt) : 0)
    return out.sort((a, b) => {
      const live = Number(b.status === 'en-cours') - Number(a.status === 'en-cours')
      return live || time(b) - time(a) || a.id.localeCompare(b.id)
    })
  }

  private describe(id: string, reportDir: string): AuditSummary {
    const active = this.active.get(id)
    const report = this.readCached(join(reportDir, REPORT_JSON))
    const live = active?.controller.state.brief()
    const empty: AuditSummary = {
      id,
      site: active?.controller.config.base.href ?? '',
      host: active?.controller.config.base.host ?? id,
      status: 'illisible',
      startedAt: null,
      durationMs: null,
      pages: 0,
      states: { conforme: 0, 'a-valider': 0, 'non-conforme': 0, 'non-auditee': 0 },
      averageRate: null,
      globalRate: null,
      pending: 0,
      decisions: 0,
      partial: false,
      location: this.place(reportDir),
    }
    if (report instanceof Error) {
      if (!live) return { ...empty, message: report.message.split('\n')[0]?.slice(0, 300) }
      return {
        ...empty,
        status: live.status,
        message: live.message,
        startedAt: new Date().toISOString(),
        progress: { done: live.done, total: live.total },
      }
    }
    const summary = this.summarize(id, reportDir, report)
    if (!live || live.status === 'termine' || live.status === 'en-attente') return summary
    return {
      ...summary,
      status: live.status,
      message: live.message,
      progress: { done: live.done, total: live.total },
    }
  }

  /** Contrôleur d'un audit (ouvert à la demande, gardé tant que le serveur tourne). */
  open(id: string): AuditController {
    const known = this.active.get(id)
    if (known) return known.controller
    const entry = this.scan().find((item) => item.id === id)
    if (!entry) throw new UserError('Audit introuvable.')
    const report = this.readCached(join(entry.reportDir, REPORT_JSON))
    if (report instanceof Error) {
      throw new UserError(`Rapport illisible : ${report.message.split('\n')[0]}`)
    }
    const config: SessionConfig = {
      ...configFromReport(report, entry.reportDir, this.options.defaults),
      decisionsDir: entry.decisionsDir,
    }
    const controller = new AuditController(config, this.options.hooks)
    controller.state.load(report)
    this.active.set(id, { controller, reportDir: entry.reportDir })
    return controller
  }

  /** Identifiant libre : `<hôte>-<date>`, suivi de `-2`, `-3`… si le jour compte déjà un audit. */
  private freeId(slug: string): string {
    const base = `${slug}-${today(new Date())}`
    const taken = new Set([...this.scan().map((entry) => entry.id), ...this.active.keys()])
    let id = base
    for (let n = 2; taken.has(id) || existsSync(join(this.options.root, id)); n++) {
      id = `${base}-${n}`
    }
    return id
  }

  /** Dernier audit du même site (même origine) dont les décisions existent. */
  private previousDecisions(base: URL): string | undefined {
    let best: { time: number; dir: string } | undefined
    for (const entry of this.scan()) {
      const report = this.readCached(join(entry.reportDir, REPORT_JSON))
      if (report instanceof Error || !isDirectory(entry.decisionsDir)) continue
      if (new URL(report.meta.baseUrl).origin !== base.origin) continue
      const time = Date.parse(report.meta.startedAt) || 0
      if (!best || time > best.time) best = { time, dir: entry.decisionsDir }
    }
    return best?.dir
  }

  /** Copie les décisions (fichiers `.json` seulement) : l'audit garde les siennes, sans toucher à celles du précédent. */
  private seedDecisions(from: string, to: string): number {
    let copied = 0
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) {
      if (!name.endsWith('.json') || !isFile(join(from, name))) continue
      copyFileSync(join(from, name), join(to, name))
      copied += 1
    }
    return copied
  }

  /** Crée un audit daté et lance l'analyse en arrière-plan. Renvoie son identifiant. */
  create(input: NewAudit): { id: string; reused: number } {
    const running = this.running
    if (running) {
      throw new UserError(
        'Une analyse est déjà en cours : attendre sa fin avant d’en lancer une autre.',
      )
    }
    const base = parseSiteUrl(input.url)
    const paths = input.pages.map((page) => canonicalPath(resolvePageUrl(base, page)))
    const scope = resolveScope(this.catalog, {
      themes: input.themes.map(String),
      criteria: [],
      tests: [],
    })
    if (input.asqatasunDir && !isDirectory(input.asqatasunDir)) {
      throw new UserError('Le dossier des exports Asqatasun est introuvable.')
    }
    const auth = { storageState: input.storageState, cookies: input.cookies }
    // Validation anticipée : fichier de session lisible, cookies bien formés (jamais répétés dans l'erreur).
    resolveAuth(auth, base)

    const id = this.freeId(siteSlug(base))
    const dir = join(this.options.root, id)
    const reportDir = join(dir, 'rapport')
    const decisionsDir = join(dir, 'decisions')
    mkdirSync(dir, { recursive: true })
    let reused = 0
    const previous = input.reuseDecisions ? this.previousDecisions(base) : undefined
    if (previous) reused = this.seedDecisions(previous, decisionsDir)

    const config: SessionConfig = {
      ...this.options.defaults,
      base,
      paths,
      limit: input.limit,
      captures: input.captures,
      scope,
      outDir: reportDir,
      decisionsDir,
      asqatasunDir: input.asqatasunDir ?? null,
      strict: false,
      merge: false,
      auth: input.storageState || input.cookies.length > 0 ? auth : undefined,
    }
    const controller = new AuditController(config, this.options.hooks)
    this.active.set(id, { controller, reportDir })
    controller.run().catch((error: unknown) => {
      this.options.hooks?.warn?.(
        `Analyse de ${base.origin} interrompue : ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    return { id, reused }
  }
}
