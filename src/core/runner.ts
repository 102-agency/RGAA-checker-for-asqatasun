import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import { assertSafeSegment, containedPath } from '../security/fs.ts'
import { safeLine, truncate } from '../security/text.ts'
import { newContext, openPage } from './browser.ts'
import { type DecisionStore, judgementKey } from './decisions.ts'
import { errorMessage } from './errors.ts'
import type {
  Check,
  ElementRef,
  Failure,
  Judgement,
  JudgeRequest,
  Outcome,
  PageCheck,
  PageContext,
  PageOptions,
  PageReport,
  SiteCheck,
  SiteContext,
  SiteRecord,
  Status,
  TestResult,
} from './types.ts'

/** Au-delà, les échecs d'un même test sur une page sont comptés mais plus détaillés. */
const MAX_FAILURES = 40
const CHECK_TIMEOUT_MS = 180_000
/** Longueurs maximales des textes issus des pages (messages, sélecteurs, extraits). */
const MAX_MESSAGE = 2_000
const MAX_SELECTOR = 1_000
const MAX_SNIPPET = 1_000
const MAX_NOTES = 50

function failureOf(message: string, ref?: ElementRef): Failure {
  return {
    message: truncate(message, MAX_MESSAGE),
    selector: ref?.selector === undefined ? undefined : truncate(ref.selector, MAX_SELECTOR),
    snippet: ref?.snippet === undefined ? undefined : truncate(ref.snippet, MAX_SNIPPET),
  }
}

export interface AuditOptions {
  browser: Browser
  /** Relance le navigateur s'il plante : la page en cours est alors auditée à nouveau, une fois. */
  relaunch?: () => Promise<Browser>
  /** URL complètes des pages à auditer. */
  urls: string[]
  checks: Check[]
  decisions: DecisionStore
  /** Dossier du rapport : les captures des questions en attente y sont écrites. */
  outDir?: string
  concurrency?: number
  /** Restreint l'audit à certains tests (les vérifications qui n'en couvrent aucun sont sautées). */
  filter?: (test: string) => boolean
  onPage?: (report: PageReport, done: number, total: number) => void
  /** Reçoit la durée des vérifications lentes (diagnostic, `--trace`). */
  trace?: (line: string) => void
}

export interface AuditResult {
  pages: PageReport[]
  /** Questions de jugement en attente, dédoublonnées par empreinte, avec les tests qui en dépendent. */
  pending: (Judgement & { tests: string[]; pages: string[] })[]
}

interface Shared {
  decisions: DecisionStore
  outDir?: string
  pending: Map<string, Judgement & { tests: Set<string>; pages: Set<string> }>
}

class OutcomeState implements Outcome {
  readonly failures: Failure[] = []
  readonly pending: Judgement[] = []
  readonly notes: string[] = []
  private checked = 0
  private failureCount = 0
  error: string | undefined

  constructor(
    private readonly test: string,
    private readonly url: string,
    private readonly shared: Shared,
  ) {}

  applicable(count = 1): void {
    this.checked += count
  }

  fail(message: string, ref?: ElementRef): void {
    this.checked += 1
    this.failureCount += 1
    if (this.failures.length < MAX_FAILURES) this.failures.push(failureOf(message, ref))
  }

  note(text: string): void {
    const line = truncate(text, MAX_MESSAGE)
    if (this.notes.length < MAX_NOTES && !this.notes.includes(line)) this.notes.push(line)
  }

  async judge(request: JudgeRequest): Promise<string | undefined> {
    this.checked += 1
    const answers = request.answers ?? ['pass', 'fail']
    const key = judgementKey(request.topic, request.evidence)
    const decision = this.shared.decisions.get(request.topic, key)
    if (decision && answers.includes(decision.answer)) return decision.answer

    const judgement: Judgement = {
      topic: request.topic,
      key,
      question: request.question,
      answers,
      evidence: request.evidence,
      selector: request.ref?.selector,
      snippet: request.ref?.snippet,
      url: this.url,
    }
    const known = this.shared.pending.get(key)
    if (known) {
      known.tests.add(this.test)
      known.pages.add(this.url)
      judgement.screenshot = known.screenshot
    } else {
      // Inscrit avant la capture : deux pages auditées en parallèle ne capturent pas deux fois.
      const entry = { ...judgement, tests: new Set([this.test]), pages: new Set([this.url]) }
      this.shared.pending.set(key, entry)
      if (request.screenshot && this.shared.outDir) {
        // Le sujet devient un nom de dossier : il ne doit jamais pouvoir sortir de `preuves/`.
        const topic = assertSafeSegment(request.topic, 'Sujet de question')
        const relative = `preuves/${topic}/${key}.png`
        const file = containedPath(this.shared.outDir, 'preuves', topic, `${key}.png`)
        try {
          mkdirSync(dirname(file), { recursive: true })
          await request.screenshot.first().screenshot({ path: file, timeout: 5_000 })
          entry.screenshot = relative
          judgement.screenshot = relative
        } catch {
          // Élément non capturable (hors écran, masqué) : la question reste posée sans image.
        }
      }
    }
    if (decision) {
      this.note(
        `Décision ${key} ignorée : réponse « ${decision.answer} » hors des réponses admises (${answers.join(', ')}).`,
      )
    }
    this.pending.push(judgement)
    return undefined
  }

  async judgePass(request: Omit<JudgeRequest, 'answers'>): Promise<void> {
    const answer = await this.judge({ ...request, answers: ['pass', 'fail'] })
    if (answer === 'fail') {
      const key = judgementKey(request.topic, request.evidence)
      const reason = this.shared.decisions.get(request.topic, key)?.reason
      this.failureCount += 1
      if (this.failures.length < MAX_FAILURES) {
        this.failures.push(
          failureOf(
            `${request.question} → non (décision ${key}${reason ? ` : ${reason}` : ''})`,
            request.ref,
          ),
        )
      }
    }
  }

  result(): TestResult {
    let status: Status
    if (this.error) status = 'ERR'
    else if (this.failureCount > 0) status = 'NC'
    else if (this.pending.length > 0) status = 'AV'
    else if (this.checked === 0) status = 'NA'
    else status = 'C'

    const notes = [...this.notes]
    if (this.error) notes.unshift(`Erreur de la vérification : ${this.error}`)
    if (this.failureCount > this.failures.length) {
      notes.push(`${this.failureCount} échecs au total, ${this.failures.length} détaillés.`)
    }
    return {
      test: this.test,
      status,
      failures: this.failures,
      failureCount: this.failureCount,
      pending: this.pending,
      notes,
      checked: this.checked,
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`délai dépassé (${ms / 1000} s) : ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function auditPage(
  browser: Browser,
  url: string,
  checks: PageCheck[],
  shared: Shared,
  records: Map<string, SiteRecord[]>,
  trace?: (line: string) => void,
): Promise<{ report: PageReport; outcomes: Map<string, OutcomeState> }> {
  const path = new URL(url).pathname
  const outcomes = new Map<string, OutcomeState>()
  const report: PageReport = { url, path, httpStatus: null, results: {} }
  const contexts: BrowserContext[] = []
  const sharedPages = new Map<string, Promise<Page>>()
  const memos = new Map<string, Promise<unknown>>()

  const open = async (options: PageOptions = {}): Promise<Page> => {
    const context = await newContext(browser, options)
    contexts.push(context)
    const { page } = await openPage(context, url)
    return page
  }

  try {
    const context = await newContext(browser)
    contexts.push(context)
    const { page, response } = await openPage(context, url)
    report.httpStatus = response?.status() ?? null
    if (!response || response.status() >= 400) {
      report.error = `La page répond ${report.httpStatus ?? 'sans réponse'} : elle n'est pas auditée.`
      return { report, outcomes }
    }

    const source = await response.text().catch(() => '')
    const ctx: PageContext = {
      url,
      path,
      page,
      source,
      fresh: open,
      shared(name, options, setup) {
        let pending = sharedPages.get(name)
        if (!pending) {
          pending = open(options).then(async (variant) => {
            if (setup) await setup(variant)
            return variant
          })
          sharedPages.set(name, pending)
        }
        return pending
      },
      memo<T>(key: string, compute: () => Promise<T>): Promise<T> {
        let pending = memos.get(key)
        if (!pending) {
          pending = compute()
          memos.set(key, pending)
        }
        return pending as Promise<T>
      },
      record(topic, value) {
        const list = records.get(topic) ?? []
        list.push({ url, path, value })
        records.set(topic, list)
      },
    }

    for (const check of checks) {
      const forTest = (test: string): OutcomeState => {
        if (!check.tests.includes(test)) {
          throw new Error(
            `La vérification [${check.tests.join(', ')}] ne déclare pas le test ${test}`,
          )
        }
        let outcome = outcomes.get(test)
        if (!outcome) {
          outcome = new OutcomeState(test, url, shared)
          outcomes.set(test, outcome)
        }
        return outcome
      }
      for (const test of check.tests) forTest(test)
      const started = Date.now()
      try {
        await withTimeout(check.run(ctx, forTest), CHECK_TIMEOUT_MS, check.tests.join(', '))
      } catch (error) {
        for (const test of check.tests) forTest(test).error = errorMessage(error)
      }
      const seconds = (Date.now() - started) / 1000
      if (trace && seconds >= 1) {
        trace(`${seconds.toFixed(1)} s  ${path}  [${check.tests.slice(0, 4).join(' ')}]`)
      }
    }
  } catch (error) {
    report.error = `Chargement impossible : ${safeLine(errorMessage(error), 500)}`
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})))
  }
  return { report, outcomes }
}

export async function audit(options: AuditOptions): Promise<AuditResult> {
  const filter = options.filter ?? (() => true)
  const selected = options.checks.filter((check) => check.tests.some(filter))
  const pageChecks = selected.filter((check): check is PageCheck => check.kind === 'page')
  const siteChecks = selected.filter((check): check is SiteCheck => check.kind === 'site')

  const shared: Shared = {
    decisions: options.decisions,
    outDir: options.outDir,
    pending: new Map(),
  }
  const records = new Map<string, SiteRecord[]>()
  const audited = new Array<{ report: PageReport; outcomes: Map<string, OutcomeState> }>(
    options.urls.length,
  )

  let next = 0
  let done = 0
  let browser = options.browser
  let relaunching: Promise<void> | undefined
  const recover = async (dead: Browser): Promise<void> => {
    if (!options.relaunch || browser !== dead) return
    relaunching ??= options.relaunch().then((fresh) => {
      browser = fresh
      relaunching = undefined
    })
    await relaunching
  }
  const crashed = (report: PageReport) =>
    Boolean(report.error) && /crash|closed|disconnected|Target/i.test(report.error ?? '')
  const worker = async () => {
    while (next < options.urls.length) {
      const index = next++
      const url = options.urls[index]
      if (!url) continue
      const used = browser
      let result = await auditPage(used, url, pageChecks, shared, records, options.trace)
      if (crashed(result.report) && options.relaunch) {
        // Le navigateur (ou la page) a planté : on repart d'un navigateur neuf, une seule fois.
        if (!used.isConnected()) await recover(used)
        // Les faits déposés par la tentative avortée ne doivent pas compter deux fois.
        for (const [topic, list] of records) {
          records.set(
            topic,
            list.filter((record) => record.url !== url),
          )
        }
        result = await auditPage(browser, url, pageChecks, shared, records, options.trace)
      }
      audited[index] = result
      done += 1
      options.onPage?.(result.report, done, options.urls.length)
    }
  }
  const workers = Math.max(1, Math.min(options.concurrency ?? 4, options.urls.length))
  await Promise.all(Array.from({ length: workers }, worker))

  // Vérifications inter-pages : uniquement sur les pages réellement auditées.
  const live = audited.filter((entry) => !entry.report.error)
  const byUrl = new Map(live.map((entry) => [entry.report.url, entry]))
  const site: SiteContext = {
    pages: live.map((entry) => ({ url: entry.report.url, path: entry.report.path })),
    records: (topic) => (records.get(topic) ?? []).filter((record) => byUrl.has(record.url)),
  }
  for (const check of siteChecks) {
    const forTest = (url: string, test: string): OutcomeState => {
      const entry = byUrl.get(url)
      if (!entry) throw new Error(`Page inconnue pour une vérification inter-pages : ${url}`)
      if (!check.tests.includes(test)) {
        throw new Error(
          `La vérification [${check.tests.join(', ')}] ne déclare pas le test ${test}`,
        )
      }
      let outcome = entry.outcomes.get(test)
      if (!outcome) {
        outcome = new OutcomeState(test, url, shared)
        entry.outcomes.set(test, outcome)
      }
      return outcome
    }
    for (const entry of live) for (const test of check.tests) forTest(entry.report.url, test)
    try {
      await check.run(site, forTest)
    } catch (error) {
      for (const entry of live) {
        for (const test of check.tests) forTest(entry.report.url, test).error = errorMessage(error)
      }
    }
  }

  for (const entry of audited) {
    for (const [test, outcome] of entry.outcomes) {
      if (filter(test)) entry.report.results[test] = outcome.result()
    }
  }

  return {
    pages: audited.map((entry) => entry.report),
    pending: Array.from(shared.pending.values()).map((entry) => ({
      ...entry,
      tests: Array.from(entry.tests).sort(),
      pages: Array.from(entry.pages),
    })),
  }
}
