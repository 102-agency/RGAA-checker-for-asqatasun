import { type Catalog, loadCatalog } from '../core/catalog.ts'
import { DecisionStore } from '../core/decisions.ts'
import { errorMessage, UserError } from '../core/errors.ts'
import type { PageReport } from '../core/types.ts'
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
    readonly config: SessionConfig,
    private readonly hooks: SessionHooks = {},
  ) {
    this.catalog = loadCatalog()
    this.state = new LiveState(
      config.base.href,
      this.catalog,
      new DecisionStore(config.decisionsDir),
      () => this.rewriteToFix(),
    )
  }

  get running(): boolean {
    return this.current !== undefined
  }

  /** Après une décision : les fichiers « à corriger » la reflètent sans attendre la relance. */
  private rewriteToFix(): void {
    const report = this.state.lastReport
    if (!report) return
    const store = this.state.decisionStore
    try {
      writeToFix(this.config.outDir, report, this.catalog, {
        decisions: (topic, key) => store.peek(topic, key),
      })
    } catch (error) {
      this.hooks.warn?.(`Fichiers « à corriger » non réécrits : ${errorMessage(error)}`)
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
    } = {},
  ): Promise<SessionResult> {
    if (this.current) throw new UserError('Un audit est déjà en cours : attendre sa fin.')
    const decisionStore = new DecisionStore(this.config.decisionsDir)
    this.state.begin(decisionStore)
    const partial = options.paths !== undefined
    const config: SessionConfig = {
      ...this.config,
      paths: partial ? (options.paths ?? []) : this.config.paths,
      merge: partial ? true : this.config.merge,
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
