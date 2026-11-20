import { type Catalog, loadCatalog } from '../core/catalog.ts'
import { ChangeStore } from '../core/changes.ts'
import { DecisionStore } from '../core/decisions.ts'
import { errorMessage, UserError } from '../core/errors.ts'
import type { PageReport } from '../core/types.ts'
import type { ReportDocument } from '../report/model.ts'
import { writeToFix } from '../report/write.ts'
import { LiveState } from '../server/state.ts'
import {
  runAuditSession,
  type SessionConfig,
  type SessionHooks,
  type SessionResult,
} from './session.ts'

/**
 * Pilote des audits successifs d'un même site, avec un état « en direct »
 * partagé : l'interface web le lit, le serveur MCP et l'interface peuvent
 * relancer un audit (complet, ou de quelques pages fusionnées au rapport).
 * Un seul audit à la fois.
 */
export class AuditController {
  readonly state: LiveState
  readonly catalog: Catalog
  private current: Promise<SessionResult> | undefined

  constructor(
    private settings: SessionConfig,
    private readonly hooks: SessionHooks = {},
  ) {
    this.catalog = loadCatalog()
    this.state = new LiveState(
      settings.base.href,
      this.catalog,
      new DecisionStore(settings.decisionsDir),
      () => this.rewriteToFix(),
    )
    this.state.attachChanges(new ChangeStore(settings.outDir))
  }

  get running(): boolean {
    return this.current !== undefined
  }

  get config(): SessionConfig {
    return this.settings
  }

  /**
   * Change la configuration entre deux audits (serveur MCP). Un autre site, ou
   * un autre dossier de décisions, remet l'état en direct à zéro.
   */
  reconfigure(config: SessionConfig): void {
    if (this.current) throw new UserError('Un audit est déjà en cours : attendre sa fin.')
    const retarget =
      config.base.origin !== this.settings.base.origin ||
      config.decisionsDir !== this.settings.decisionsDir ||
      config.outDir !== this.settings.outDir
    this.settings = config
    if (retarget) {
      this.state.retarget(config.base.href, new DecisionStore(config.decisionsDir))
      this.state.attachChanges(new ChangeStore(config.outDir))
    }
  }

  /** Après une décision : les fichiers « à corriger » la reflètent sans attendre la relance. */
  private rewriteToFix(): void {
    const report = this.state.lastReport
    if (!report) return
    const store = this.state.decisionStore
    try {
      writeToFix(this.settings.outDir, report, this.catalog, {
        decisions: (topic, key) => store.peek(topic, key),
      })
    } catch (error) {
      this.hooks.warn?.(`Fichiers « à corriger » non réécrits : ${errorMessage(error)}`)
    }
  }

  /** Les pages revues par cet audit disent si les modifications de l'IA ont corrigé, pas assez corrigé ou cassé quelque chose. */
  private verifyChanges(
    report: ReportDocument,
    audited: string[] | null,
    since: string,
    before: ReportDocument | undefined,
  ): void {
    try {
      const sameSite = before && new URL(before.meta.baseUrl).origin === this.settings.base.origin
      new ChangeStore(this.settings.outDir).verify(report, {
        audited,
        since,
        before: sameSite ? before : undefined,
        date: new Date().toISOString(),
      })
      this.state.refreshChanges()
    } catch (error) {
      this.hooks.warn?.(`Modifications de l'IA non vérifiées : ${errorMessage(error)}`)
    }
  }

  /**
   * Lance un audit. `paths` absent : le périmètre de départ (tout le sitemap,
   * ou les chemins donnés au lancement). `paths` donné : ces pages seulement,
   * fusionnées au rapport existant.
   */
  run(
    options: {
      paths?: string[]
      onPage?: (report: PageReport, done: number, total: number) => void
      /** Rapport d'avant l'audit (sinon le dernier de l'état en direct), pour repérer les régressions. */
      before?: ReportDocument
    } = {},
  ): Promise<SessionResult> {
    if (this.current) throw new UserError('Un audit est déjà en cours : attendre sa fin.')
    const startedAt = new Date().toISOString()
    const before = options.before ?? this.state.lastReport
    const decisionStore = new DecisionStore(this.settings.decisionsDir)
    this.state.begin(decisionStore)
    const partial = options.paths !== undefined
    const config: SessionConfig = {
      ...this.settings,
      paths: partial ? (options.paths ?? []) : this.settings.paths,
      merge: partial ? true : this.settings.merge,
      decisionStore,
    }
    const run = runAuditSession(config, {
      ...this.hooks,
      onEvent: (event) => {
        this.state.apply(event)
        this.hooks.onEvent?.(event)
      },
      onPage: (report, done, total) => {
        this.hooks.onPage?.(report, done, total)
        options.onPage?.(report, done, total)
      },
    })
      .then((result) => {
        this.state.finish(result.report)
        this.verifyChanges(result.report, partial ? (options.paths ?? []) : null, startedAt, before)
        return result
      })
      .catch((error: unknown) => {
        this.state.fail(errorMessage(error))
        throw error
      })
      .finally(() => {
        this.current = undefined
      })
    this.current = run
    return run
  }

  /** Relance demandée par l'interface : les erreurs sont affichées dans l'interface, pas levées. */
  rerun(paths: string[] | null): void {
    this.run(paths ? { paths } : {}).catch((error: unknown) => {
      this.hooks.warn?.(`Audit relancé interrompu : ${errorMessage(error)}`)
    })
  }
}
