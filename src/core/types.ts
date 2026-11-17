import type { Locator, Page } from 'playwright'

/**
 * Verdict d'un test RGAA sur une page.
 *
 * - `C`   conforme
 * - `NC`  non conforme (au moins un échec constaté)
 * - `NA`  non applicable (la page n'a pas le contenu visé par le test)
 * - `AV`  à valider : le test dépend d'un jugement qui n'est pas encore
 *         enregistré dans `decisions/`
 * - `ERR` la vérification a planté (à traiter comme un échec de l'outil)
 * - `NT`  aucune vérification n'est écrite pour ce test
 */
export type Status = 'C' | 'NC' | 'NA' | 'AV' | 'ERR' | 'NT'

export const STATUSES: readonly Status[] = ['C', 'NC', 'NA', 'AV', 'ERR', 'NT']

export const STATUS_LABEL: Record<Status, string> = {
  C: 'Conforme',
  NC: 'Non-conforme',
  NA: 'Non-Applicable',
  AV: 'À valider',
  ERR: 'Erreur outil',
  NT: 'Non testé',
}

export interface CatalogTest {
  theme: number
  themeLabel: string
  criterion: string
  /** Intitulé du critère (RGAA 4.1.2). */
  criterionTitle?: string
  test: string
  level: string
  title: string
  /** « Cas particuliers » du critère : exceptions à connaître avant de conclure. */
  particularCases?: string
  /** « Notes techniques » du critère. */
  technicalNotes?: string
}

/** Repère d'un élément dans la page, produit par `window.__rgaa.ref(el)`. */
export interface ElementRef {
  selector: string
  snippet: string
}

export interface Failure {
  message: string
  selector?: string
  snippet?: string
}

/** Question de jugement posée par une vérification, résolue par `decisions/`. */
export interface Judgement {
  /** Espace de noms de la question, ex. `image.role`. Un fichier de décisions par sujet. */
  topic: string
  /** Empreinte stable de `topic` + `evidence` : la même question sur 60 pages n'est tranchée qu'une fois. */
  key: string
  question: string
  /** Réponses admises (par défaut `pass` / `fail`). */
  answers: string[]
  /** Ce sur quoi porte le jugement, lisible par un humain. Doit être stable d'une page à l'autre. */
  evidence: Record<string, string>
  selector?: string
  snippet?: string
  /** Capture de l'élément, chemin relatif au dossier du rapport. */
  screenshot?: string
  /** Page où la question a été rencontrée en premier. */
  url?: string
}

export interface JudgeRequest {
  topic: string
  question: string
  evidence: Record<string, string>
  answers?: string[]
  ref?: ElementRef
  /** Élément à capturer pour aider le jugement (seulement si la question est en attente). */
  screenshot?: Locator
}

export interface TestResult {
  test: string
  status: Status
  /** Échecs détaillés (plafonnés : voir `failureCount` pour le total). */
  failures: Failure[]
  /** Nombre total d'échecs constatés, détaillés ou non. */
  failureCount: number
  pending: Judgement[]
  notes: string[]
  /** Nombre d'éléments ou de cas contrôlés (0 = non applicable). */
  checked: number
}

/** Accumulateur de résultat d'un test sur une page. */
export interface Outcome {
  /** Signale que le test a de la matière sur cette page (sinon il sort `NA`). */
  applicable(count?: number): void
  /** Enregistre un échec : le test sort `NC`. */
  fail(message: string, ref?: ElementRef): void
  /** Remarque affichée dans le rapport, sans effet sur le verdict. */
  note(text: string): void
  /**
   * Pose une question de jugement. Renvoie la réponse enregistrée, ou `undefined`
   * si elle est en attente (le test sort alors `AV`). Marque le test applicable.
   */
  judge(request: JudgeRequest): Promise<string | undefined>
  /**
   * Raccourci pour un jugement binaire : `pass` valide, `fail` enregistre un échec,
   * pas de réponse laisse le test `AV`.
   */
  judgePass(request: Omit<JudgeRequest, 'answers'>): Promise<void>
}

export interface PageOptions {
  viewport?: { width: number; height: number }
  /** `dark` force `prefers-color-scheme: dark`. */
  colorScheme?: 'light' | 'dark'
  reducedMotion?: 'reduce' | 'no-preference'
  /** Désactive JavaScript (contenu sans script). */
  javaScriptEnabled?: boolean
}

export interface PageContext {
  /** URL auditée, et son chemin (`/contact`). */
  url: string
  path: string
  /**
   * Page chargée en 1280×900, partagée par toutes les vérifications :
   * **lecture seule**. Ne pas cliquer, redimensionner, déplacer le focus ni
   * modifier le DOM dessus : passer par `fresh()` ou `shared()`.
   */
  page: Page
  /** Code source HTML tel que servi (avant l'exécution des scripts), pour les contrôles de syntaxe. */
  source: string
  /** Nouvelle page sur la même URL, à manipuler librement. Fermée à la fin de l'audit de la page. */
  fresh(options?: PageOptions): Promise<Page>
  /**
   * Page dérivée mise en cache par `name` (ex. `reflow320`, `zoom200`, `sans-css`) :
   * `setup` n'est exécuté qu'une fois, la page est ensuite partagée en lecture seule.
   */
  shared(name: string, options: PageOptions, setup?: (page: Page) => Promise<void>): Promise<Page>
  /** Calcul mis en cache pour la page courante, partagé entre vérifications. */
  memo<T>(key: string, compute: () => Promise<T>): Promise<T>
  /** Dépose un fait pour les vérifications inter-pages (`defineSiteCheck`). */
  record(topic: string, value: unknown): void
}

export type OutcomeFor = (test: string) => Outcome

export interface PageCheck {
  kind: 'page'
  tests: string[]
  run(ctx: PageContext, t: OutcomeFor): Promise<void>
}

export interface SiteRecord {
  url: string
  path: string
  value: unknown
}

export interface SiteContext {
  /** Pages auditées. */
  pages: { url: string; path: string }[]
  /** Faits déposés par `ctx.record(topic, …)`, dans l'ordre des pages. */
  records(topic: string): SiteRecord[]
}

export interface SiteCheck {
  kind: 'site'
  tests: string[]
  run(site: SiteContext, t: (url: string, test: string) => Outcome): Promise<void>
}

export type Check = PageCheck | SiteCheck

/** Vérification exécutée sur chaque page. `tests` liste les tests RGAA qu'elle statue. */
export function defineCheck(tests: string[], run: PageCheck['run']): PageCheck {
  return { kind: 'page', tests, run }
}

/**
 * Vérification inter-pages (cohérence de la navigation, etc.), exécutée une fois
 * toutes les pages auditées, à partir des faits déposés par `ctx.record`.
 */
export function defineSiteCheck(tests: string[], run: SiteCheck['run']): SiteCheck {
  return { kind: 'site', tests, run }
}

export interface PageReport {
  url: string
  path: string
  /** Statut HTTP de la page ; une page en erreur n'est pas auditée. */
  httpStatus: number | null
  error?: string
  results: Record<string, TestResult>
}
