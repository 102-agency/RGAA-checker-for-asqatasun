import { answerLabel, answerMeaning, DOUBT, isAdmitted } from '../core/answers.ts'
import { type Catalog, compareIds, criterionOf } from '../core/catalog.ts'
import { type Decision, type DecisionStore, LIMITS } from '../core/decisions.ts'
import type { AuditEvent } from '../core/runner.ts'
import type { Doubt, Failure, Judgement } from '../core/types.ts'
import { buildToFix, type QuestionState } from '../report/ai.ts'
import { type PageState, type ReportDocument, summarizePage } from '../report/model.ts'
import { safeLine } from '../security/text.ts'

/**
 * État d'un audit tel que l'affiche l'interface web : alimenté en direct par
 * les événements du runner pendant l'analyse, puis remplacé par le rapport
 * final. Les formes ci-dessous (`Ui…`) sont exactement ce que reçoit le
 * navigateur : uniquement des données, jamais de HTML.
 */

export interface UiOccurrence {
  id: string
  message: string
  selector?: string
  snippet?: string
  screenshot?: string
  pages: string[]
}

export interface UiIssue {
  test: string
  requirement: string
  criterion: string
  criterionTitle: string
  reference: string
  pages: string[]
  occurrences: UiOccurrence[]
}

export interface UiQuestion {
  key: string
  topic: string
  state: QuestionState
  question: string
  tests: { test: string; requirement: string }[]
  answers: { value: string; meaning: 'probleme' | 'ok' | 'neutre' | 'doute'; label: string }[]
  evidence: Record<string, string>
  selector?: string
  snippet?: string
  screenshot?: string
  pages: string[]
  doubt?: Doubt
  decision?: { answer: string; label: string; reason: string; by: string; date: string }
}

export interface UiPage {
  url: string
  path: string
  state: PageState | 'en-cours' | 'en-attente'
  criteriaScore: number | null
  settled: boolean
  nc: number
  av: number
  error?: string
}

export type RunStatus = 'en-attente' | 'en-cours' | 'termine' | 'erreur'

export interface UiSnapshot {
  site: string
  status: RunStatus
  message?: string
  startedAt?: string
  progress: { total: number; done: number; current: string[]; phase: string }
  issues: UiIssue[]
  questions: UiQuestion[]
  pages: UiPage[]
  /** Décisions prises depuis le dernier audit : les verdicts ne les reflètent pas encore. */
  decidedSinceAudit: number
  files: { label: string; name: string }[]
}

export type UiEvent =
  | { type: 'progression'; progress: UiSnapshot['progress']; status: RunStatus }
  | { type: 'constat'; issue: UiIssue }
  | { type: 'question'; question: UiQuestion }
  | { type: 'page'; page: UiPage }
  | { type: 'decision'; question: UiQuestion; decidedSinceAudit: number }
  /** L'état a changé en bloc (fin d'audit, relance) : relire `/api/etat`. */
  | { type: 'recharger' }

const CRITERIA_URL = 'https://accessibilite.numerique.gouv.fr/methode/criteres-et-tests/'

export const REPORT_FILES = [
  { label: 'À corriger (Markdown, pour humain ou IA)', name: 'a-corriger.md' },
  { label: 'À corriger (JSON, pour IA)', name: 'a-corriger.json' },
  { label: 'Résultats complets (tous les tests)', name: 'resultats-complets.md' },
  { label: 'Rapport HTML', name: 'rapport.html' },
  { label: 'Rapport Markdown', name: 'rapport.md' },
  { label: 'Données JSON', name: 'rapport.json' },
]

export interface DecideInput {
  key: string
  answer: string
  reason?: string
  by?: string
}

export class LiveState {
  private status: RunStatus = 'en-attente'
  private message: string | undefined
  private startedAt: string | undefined
  private plan: string[] = []
  private done = 0
  private current = new Set<string>()
  private phase = ''
  private pathOf = new Map<string, string>()
  private issues = new Map<string, UiIssue>()
  private questions = new Map<string, UiQuestion>()
  /** Définition complète des questions (sujet, preuves) pour enregistrer une décision. */
  private judgements = new Map<string, Judgement>()
  private pages = new Map<string, UiPage>()
  private decided = new Set<string>()
  private report: ReportDocument | undefined
  private readonly listeners = new Set<(event: UiEvent) => void>()

  constructor(
    public site: string,
    private readonly catalog: Catalog,
    private decisions: DecisionStore,
    /** Appelé après chaque décision (réécriture des fichiers « à corriger »). */
    private readonly afterDecision?: () => void,
  ) {}

  get running(): boolean {
    return this.status === 'en-cours'
  }

  /** Change de site (serveur MCP auditant plusieurs sites) : l'état repart de zéro. */
  retarget(site: string, decisions: DecisionStore): void {
    if (this.running) throw new Error('Un audit est en cours.')
    this.site = site
    this.decisions = decisions
    this.status = 'en-attente'
    this.report = undefined
    this.plan = []
    this.done = 0
    this.pathOf.clear()
    this.issues.clear()
    this.questions.clear()
    this.judgements.clear()
    this.pages.clear()
    this.decided.clear()
    this.emit({ type: 'recharger' })
  }

  get lastReport(): ReportDocument | undefined {
    return this.report
  }

  get decisionStore(): DecisionStore {
    return this.decisions
  }

  subscribe(listener: (event: UiEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: UiEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Un client déconnecté ne doit pas gêner les autres.
      }
    }
  }

  private progress(): UiSnapshot['progress'] {
    return {
      total: this.plan.length,
      done: this.done,
      current: Array.from(this.current, (url) => this.path(url)),
      phase: this.phase,
    }
  }

  private path(url: string): string {
    const known = this.pathOf.get(url)
    if (known) return known
    try {
      return new URL(url).pathname
    } catch {
      return url
    }
  }

  /**
   * Nouvelle analyse. `decisions` est le magasin qu'utilise l'audit : une décision
   * prise pendant l'analyse vaut aussitôt pour les pages qui restent à auditer.
   */
  begin(decisions: DecisionStore, label = 'Découverte des pages'): void {
    this.decisions = decisions
    this.status = 'en-cours'
    this.message = undefined
    this.startedAt = new Date().toISOString()
    this.plan = []
    this.done = 0
    this.current.clear()
    this.phase = label
    this.issues.clear()
    this.questions.clear()
    this.judgements.clear()
    this.pages.clear()
    this.decided.clear()
    this.emit({ type: 'recharger' })
  }

  /** Événement du runner. */
  apply(event: AuditEvent): void {
    switch (event.type) {
      case 'audit-debut': {
        this.plan = event.urls
        this.phase = 'Analyse des pages'
        for (const url of event.urls) {
          const path = this.path(url)
          this.pathOf.set(url, path)
          this.pages.set(url, {
            url,
            path,
            state: 'en-attente',
            criteriaScore: null,
            settled: false,
            nc: 0,
            av: 0,
          })
        }
        this.emit({ type: 'recharger' })
        return
      }
      case 'page-debut': {
        this.current.add(event.url)
        const page = this.pages.get(event.url)
        if (page) {
          page.state = 'en-cours'
          this.emit({ type: 'page', page })
        }
        this.emit({ type: 'progression', progress: this.progress(), status: this.status })
        return
      }
      case 'constat':
        this.emit({ type: 'constat', issue: this.addFailure(event.test, event.url, event.failure) })
        return
      case 'question': {
        const question = this.addQuestion(event.test, event.url, event.judgement)
        if (question) this.emit({ type: 'question', question })
        return
      }
      case 'page-fin': {
        this.current.delete(event.report.url)
        this.done = event.done
        const entry = summarizePage(event.report, this.catalog, undefined)
        const page: UiPage = {
          url: entry.url,
          path: entry.path,
          state: entry.state,
          criteriaScore: entry.criteriaScore,
          settled: entry.settled,
          nc: entry.counts.NC,
          av: entry.counts.AV,
          error: entry.error,
        }
        this.pages.set(entry.url, page)
        this.emit({ type: 'page', page })
        this.emit({ type: 'progression', progress: this.progress(), status: this.status })
        return
      }
      case 'inter-pages':
        this.phase = 'Vérifications inter-pages (navigation, cohérence)'
        this.emit({ type: 'progression', progress: this.progress(), status: this.status })
        return
    }
  }

  private addFailure(test: string, url: string, failure: Failure): UiIssue {
    const info = this.catalog.byTest.get(test)
    const criterion = criterionOf(test)
    let issue = this.issues.get(test)
    if (!issue) {
      issue = {
        test,
        requirement: info?.title ?? '',
        criterion,
        criterionTitle: this.catalog.criteria.get(criterion)?.title ?? '',
        reference: `${CRITERIA_URL}#${test}`,
        pages: [],
        occurrences: [],
      }
      this.issues.set(test, issue)
    }
    const path = this.path(url)
    if (!issue.pages.includes(path)) issue.pages.push(path)
    const id = failure.id ?? `${test}-${issue.occurrences.length}`
    const known = issue.occurrences.find((occurrence) => occurrence.id === id)
    if (known) {
      if (!known.pages.includes(path)) known.pages.push(path)
      known.screenshot ??= failure.screenshot
    } else {
      issue.occurrences.push({
        id,
        message: failure.message,
        selector: failure.selector,
        snippet: failure.snippet,
        screenshot: failure.screenshot,
        pages: [path],
      })
    }
    return issue
  }

  private addQuestion(test: string, url: string, judgement: Judgement): UiQuestion | undefined {
    if (!this.judgements.has(judgement.key)) this.judgements.set(judgement.key, judgement)
    const path = this.path(url)
    let question = this.questions.get(judgement.key)
    if (!question) {
      question = {
        key: judgement.key,
        topic: judgement.topic,
        state: judgement.doubt ? 'doute-maintenu' : 'a-trancher',
        question: judgement.question,
        tests: [],
        answers: answersOf(judgement.answers),
        evidence: judgement.evidence,
        selector: judgement.selector,
        snippet: judgement.snippet,
        screenshot: judgement.screenshot,
        pages: [],
        doubt: judgement.doubt,
      }
      this.questions.set(judgement.key, question)
      this.applyDecision(question)
    }
    if (!question.tests.some((item) => item.test === test)) {
      question.tests.push({ test, requirement: this.catalog.byTest.get(test)?.title ?? '' })
      question.tests.sort((a, b) => compareIds(a.test, b.test))
    }
    if (!question.pages.includes(path)) question.pages.push(path)
    question.screenshot ??= judgement.screenshot
    return question
  }

  /** Reflète sur la question une décision enregistrée depuis l'audit. */
  private applyDecision(question: UiQuestion): void {
    const decision = this.decisions.peek(question.topic, question.key)
    if (!decision) return
    if (decision.answer === DOUBT) {
      question.state = 'doute-maintenu'
      question.doubt = { reason: decision.reason, by: decision.by, date: decision.date }
      question.decision = undefined
      return
    }
    if (!question.answers.some((answer) => answer.value === decision.answer)) return
    question.state =
      answerMeaning(decision.answer) === 'probleme' ? 'probleme-confirme' : 'tranchee-a-appliquer'
    question.decision = {
      answer: decision.answer,
      label: answerLabel(decision.answer),
      reason: decision.reason,
      by: decision.by,
      date: decision.date,
    }
  }

  /** Fin d'analyse : le rapport final remplace l'état reconstitué en direct. */
  finish(report: ReportDocument): void {
    this.status = 'termine'
    this.current.clear()
    this.phase = 'Terminé'
    this.load(report)
    this.emit({ type: 'recharger' })
  }

  fail(message: string): void {
    this.status = 'erreur'
    this.message = safeLine(message, 2_000)
    this.current.clear()
    this.phase = 'Interrompu'
    this.emit({ type: 'recharger' })
  }

  /** Charge un rapport existant (commande `serve`, ou fin d'audit). */
  load(report: ReportDocument): void {
    this.report = report
    if (this.status === 'en-attente') this.status = 'termine'
    this.startedAt = report.meta.startedAt
    this.plan = report.pages.map((page) => page.url)
    this.done = report.pages.length
    this.issues.clear()
    this.questions.clear()
    this.judgements.clear()
    this.pages.clear()
    this.decided.clear()
    for (const page of report.pages) {
      this.pathOf.set(page.url, page.path)
      this.pages.set(page.url, {
        url: page.url,
        path: page.path,
        state: page.state,
        criteriaScore: page.criteriaScore,
        settled: page.settled,
        nc: page.counts.NC,
        av: page.counts.AV,
        error: page.error,
      })
    }
    const doc = buildToFix(report, this.catalog)
    for (const item of doc.nonConformities) {
      this.issues.set(item.test, {
        test: item.test,
        requirement: item.requirement,
        criterion: item.criterion,
        criterionTitle: item.criterionTitle,
        reference: item.reference,
        pages: item.pages,
        occurrences: item.occurrences.map((occurrence, index) => ({
          ...occurrence,
          id: occurrence.id ?? `${item.test}-${index}`,
        })),
      })
    }
    for (const item of report.pending) {
      this.judgements.set(item.key, item)
      const question: UiQuestion = {
        key: item.key,
        topic: item.topic,
        state: item.doubt ? 'doute-maintenu' : 'a-trancher',
        question: item.question,
        tests: item.tests.map((test) => ({
          test,
          requirement: this.catalog.byTest.get(test)?.title ?? '',
        })),
        answers: answersOf(item.answers),
        evidence: item.evidence,
        selector: item.selector,
        snippet: item.snippet,
        screenshot: item.screenshot,
        pages: item.pages.map((url) => this.path(url)),
        doubt: item.doubt,
      }
      this.applyDecision(question)
      if (question.decision) this.decided.add(question.key)
      this.questions.set(item.key, question)
    }
  }

  snapshot(): UiSnapshot {
    const order: Record<QuestionState, number> = {
      'a-trancher': 0,
      'doute-maintenu': 1,
      'probleme-confirme': 2,
      'tranchee-a-appliquer': 3,
    }
    return {
      site: this.site,
      status: this.status,
      message: this.message,
      startedAt: this.startedAt,
      progress: this.progress(),
      issues: Array.from(this.issues.values()).sort((a, b) => compareIds(a.test, b.test)),
      questions: Array.from(this.questions.values()).sort(
        (a, b) =>
          order[a.state] - order[b.state] ||
          b.pages.length - a.pages.length ||
          compareIds(a.tests[0]?.test ?? '0.0.0', b.tests[0]?.test ?? '0.0.0'),
      ),
      pages: Array.from(this.pages.values()),
      decidedSinceAudit: this.decided.size,
      files: this.report ? REPORT_FILES : [],
    }
  }

  /** Pages concernées par les questions tranchées depuis l'audit (pour les réauditer). */
  pagesToRecheck(): string[] {
    const paths = new Set<string>()
    for (const key of this.decided) {
      for (const path of this.questions.get(key)?.pages ?? []) paths.add(path)
    }
    return Array.from(paths)
  }

  /** Enregistre une décision (bouton de l'interface ou outil MCP). */
  decide(input: DecideInput): UiQuestion {
    const judgement = this.judgements.get(input.key)
    const question = this.questions.get(input.key)
    if (!judgement || !question) {
      throw new DecisionError('Aucune question en attente avec cette empreinte.')
    }
    if (!isAdmitted(input.answer, judgement.answers)) {
      throw new DecisionError(
        `Réponse refusée (admises : ${[...judgement.answers, DOUBT].join(', ')}).`,
      )
    }
    const reason =
      safeLine(input.reason ?? '', LIMITS.reason) ||
      (input.answer === DOUBT ? 'Doute maintenu, sans commentaire.' : 'Tranché sans commentaire.')
    const decision: Decision = {
      answer: input.answer,
      evidence: judgement.evidence,
      question: judgement.question,
      reason,
      by: safeLine(input.by ?? '', LIMITS.by) || 'humain',
      date: new Date().toISOString().slice(0, 10),
    }
    this.decisions.set(judgement.topic, judgement.key, decision)
    question.decision = undefined
    question.doubt = judgement.doubt
    question.state = judgement.doubt ? 'doute-maintenu' : 'a-trancher'
    this.applyDecision(question)
    if (input.answer === DOUBT) this.decided.delete(question.key)
    else this.decided.add(question.key)
    this.afterDecision?.()
    this.emit({ type: 'decision', question, decidedSinceAudit: this.decided.size })
    return question
  }
}

export class DecisionError extends Error {}

function answersOf(answers: readonly string[]): UiQuestion['answers'] {
  return [
    ...answers.map((value) => ({
      value,
      meaning: answerMeaning(value),
      label: answerLabel(value),
    })),
    { value: DOUBT, meaning: 'doute' as const, label: answerLabel(DOUBT) },
  ]
}
