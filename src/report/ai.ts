import { answerLabel, answerMeaning, DOUBT } from '../core/answers.ts'
import { type Catalog, compareIds, criterionOf, themeOf } from '../core/catalog.ts'
import type { Decision } from '../core/decisions.ts'
import type { Doubt, Status } from '../core/types.ts'
import { escapeInline, markdownBlock, markdownCode, safeLine } from '../security/text.ts'
import { type ReportDocument, siteOverview } from './model.ts'
import { frDate, STATUS_SYMBOL, STATUS_TEXT } from './style.ts'

/**
 * Fichiers « à corriger » (`a-corriger.json`, `a-corriger.md`) et « résultats
 * complets » (`resultats-complets.md`).
 *
 * Le fichier « à corriger » est écrit pour être lu seul, par une personne ou
 * par une IA, sans connaître l'outil : chaque non-conformité porte l'exigence
 * RGAA, l'élément (sélecteur, extrait de code, capture), les pages, et chaque
 * doute la question à trancher, les réponses admises et leur sens. Il dit
 * aussi comment vérifier une correction (relancer une page) et comment
 * enregistrer une réponse.
 */

export const TO_FIX_FORMAT = 'rgaa-checker/a-corriger@1'
export const TO_FIX_JSON = 'a-corriger.json'
export const TO_FIX_MARKDOWN = 'a-corriger.md'
export const FULL_RESULTS_MARKDOWN = 'resultats-complets.md'

const CRITERIA_URL = 'https://accessibilite.numerique.gouv.fr/methode/criteres-et-tests/'

/** Lecture des décisions enregistrées depuis l'audit (sans effet sur l'audit). */
export type DecisionLookup = (topic: string, key: string) => Decision | undefined

export interface Occurrence {
  id?: string
  message: string
  selector?: string
  snippet?: string
  screenshot?: string
  pages: string[]
}

export interface NonConformity {
  test: string
  criterion: string
  level: string
  theme: number
  themeLabel: string
  criterionTitle: string
  /** Intitulé du test RGAA : l'exigence à satisfaire. */
  requirement: string
  reference: string
  pages: string[]
  occurrences: Occurrence[]
  /** Échecs comptés au-delà du plafond de détail. */
  undetailed: number
  /** Pages où seul Asqatasun conclut à la non-conformité (détail dans son export). */
  asqatasunOnly: string[]
  notes: string[]
  particularCases?: string
  technicalNotes?: string
}

/**
 * - `a-trancher`          : question posée, personne n'y a encore répondu ;
 * - `doute-maintenu`      : examinée, laissée en doute ;
 * - `probleme-confirme`   : tranchée « problème » depuis l'audit (à corriger, puis relancer) ;
 * - `tranchee-a-appliquer`: tranchée sans problème, ou classée : relancer l'audit pour l'appliquer.
 */
export type QuestionState =
  | 'a-trancher'
  | 'doute-maintenu'
  | 'probleme-confirme'
  | 'tranchee-a-appliquer'

export interface QuestionItem {
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
  decision?: { answer: string; reason: string; by: string; date: string }
  decideCommand: string
}

export interface ToFixDocument {
  format: typeof TO_FIX_FORMAT
  site: string
  auditedAt: string
  tool: string
  summary: {
    pages: number
    nonConformities: number
    occurrences: number
    questions: number
    doubts: number
    confirmedProblems: number
    decidedSinceAudit: number
    toolErrors: number
  }
  /** Mode d'emploi, pour qui lit le fichier sans connaître l'outil. */
  howTo: { text: string; command?: string }[]
  nonConformities: NonConformity[]
  questions: QuestionItem[]
  toolErrors: { test: string; pages: string[]; messages: string[] }[]
}

function shellQuote(value: string): string {
  return /^[\w./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

const STATE_ORDER: Record<QuestionState, number> = {
  'probleme-confirme': 0,
  'doute-maintenu': 1,
  'a-trancher': 2,
  'tranchee-a-appliquer': 3,
}

export function buildToFix(
  report: ReportDocument,
  catalog: Catalog,
  options: { outDir?: string; decisions?: DecisionLookup } = {},
): ToFixDocument {
  const overview = siteOverview(report)
  const pathOf = new Map(report.pages.map((page) => [page.url, page.path]))
  const base = report.meta.baseUrl
  const out = options.outDir ? ` --out ${shellQuote(options.outDir)}` : ''

  const nonConformities: NonConformity[] = overview.issues.map((issue) => {
    const info = catalog.byTest.get(issue.test)
    const criterion = criterionOf(issue.test)
    const notes = new Set<string>()
    for (const page of report.pages) {
      const entry = page.tests.find((item) => item.test === issue.test && item.final === 'NC')
      for (const note of entry?.notes ?? []) notes.add(note)
    }
    return {
      test: issue.test,
      criterion,
      level: info?.level ?? catalog.criteria.get(criterion)?.level ?? '',
      theme: themeOf(issue.test),
      themeLabel: catalog.themes.get(themeOf(issue.test)) ?? '',
      criterionTitle: catalog.criteria.get(criterion)?.title ?? '',
      requirement: info?.title ?? '',
      reference: `${CRITERIA_URL}#${issue.test}`,
      pages: issue.pages,
      occurrences: issue.findings.map((finding) => ({
        id: finding.id,
        message: finding.message,
        selector: finding.selector,
        snippet: finding.snippet,
        screenshot: finding.screenshot,
        pages: finding.pages,
      })),
      undetailed: issue.undetailed,
      asqatasunOnly: issue.asqatasunOnly,
      notes: Array.from(notes).slice(0, 20),
      particularCases: info?.particularCases,
      technicalNotes: info?.technicalNotes,
    }
  })

  let decidedSinceAudit = 0
  const questions: QuestionItem[] = report.pending.map((item) => {
    const recent = options.decisions?.(item.topic, item.key)
    let state: QuestionState = 'a-trancher'
    let doubt = item.doubt
    if (recent?.answer === DOUBT) {
      state = 'doute-maintenu'
      doubt = { reason: recent.reason, by: recent.by, date: recent.date }
    } else if (recent && item.answers.includes(recent.answer)) {
      decidedSinceAudit += 1
      state =
        answerMeaning(recent.answer) === 'probleme' ? 'probleme-confirme' : 'tranchee-a-appliquer'
    } else if (doubt) {
      state = 'doute-maintenu'
    }
    return {
      key: item.key,
      topic: item.topic,
      state,
      question: item.question,
      tests: item.tests.map((test) => ({
        test,
        requirement: catalog.byTest.get(test)?.title ?? '',
      })),
      answers: [
        ...item.answers.map((value) => ({
          value,
          meaning: answerMeaning(value),
          label: answerLabel(value),
        })),
        { value: DOUBT, meaning: 'doute' as const, label: answerLabel(DOUBT) },
      ],
      evidence: item.evidence,
      selector: item.selector,
      snippet: item.snippet,
      screenshot: item.screenshot,
      pages: item.pages.map((url) => pathOf.get(url) ?? url),
      doubt,
      decision:
        recent && recent.answer !== DOUBT
          ? { answer: recent.answer, reason: recent.reason, by: recent.by, date: recent.date }
          : undefined,
      decideCommand: `rgaa decide ${item.key} <réponse> --reason "…"${out}`,
    }
  })
  questions.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      b.pages.length - a.pages.length ||
      compareIds(a.tests[0]?.test ?? '0.0.0', b.tests[0]?.test ?? '0.0.0'),
  )

  return {
    format: TO_FIX_FORMAT,
    site: base,
    auditedAt: report.meta.startedAt,
    tool: `${report.tool.name} ${report.tool.version}`,
    summary: {
      pages: report.pages.length,
      nonConformities: nonConformities.length,
      occurrences: nonConformities.reduce((sum, item) => sum + item.occurrences.length, 0),
      questions: questions.filter((item) => item.state === 'a-trancher').length,
      doubts: questions.filter((item) => item.state === 'doute-maintenu').length,
      confirmedProblems: questions.filter((item) => item.state === 'probleme-confirme').length,
      decidedSinceAudit,
      toolErrors: overview.errors.length,
    },
    howTo: [
      {
        text: 'Chaque non-conformité cite l’exigence RGAA (requirement), l’élément fautif (selector, snippet), une capture où il est encadré en rouge (screenshot, chemin relatif au dossier du rapport) et les pages concernées.',
      },
      {
        text: 'Chaque question est un doute que l’outil ne peut pas lever seul : la lire avec ses preuves (evidence) et sa capture, puis répondre par une des réponses admises. Sens des réponses : « probleme » rend le test non conforme, « ok » lève le soupçon, « neutre » classe l’élément, « doute » laisse la question ouverte.',
      },
      {
        text: 'Vérifier une correction sur une page (réaudite la page et met à jour ce fichier) :',
        command: `rgaa audit ${shellQuote(base)} <chemin> --merge${out}`,
      },
      { text: 'Réauditer tout le site :', command: `rgaa audit ${shellQuote(base)}${out}` },
      {
        text: 'Enregistrer une réponse, puis relancer l’audit pour l’appliquer :',
        command: `rgaa decide <empreinte> <réponse> --reason "…"${out}`,
      },
      {
        text: 'Depuis une IA : le serveur MCP « rgaa mcp » expose les mêmes opérations (auditer le site ou une page, lire ce fichier, trancher une question, voir une capture).',
      },
    ],
    nonConformities,
    questions,
    toolErrors: overview.errors,
  }
}

const STATE_TITLE: Record<QuestionState, string> = {
  'probleme-confirme': 'Problème confirmé (à corriger)',
  'doute-maintenu': 'Doute maintenu',
  'a-trancher': 'À trancher',
  'tranchee-a-appliquer': 'Tranchée depuis l’audit (relancer pour appliquer)',
}

function list(items: readonly string[], max = 12): string {
  const shown = items.slice(0, max).map((item) => markdownCode(item))
  return items.length > max ? `${shown.join(', ')} … (+${items.length - max})` : shown.join(', ')
}

function indentBlock(text: string, language: string): string {
  return markdownBlock(text, language)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

export function renderToFixMarkdown(doc: ToFixDocument): string {
  const out: string[] = []
  out.push('# À corriger — audit RGAA 4.1.2', '')
  out.push(
    `Site ${markdownCode(doc.site)} · audité le ${escapeInline(frDate(doc.auditedAt))} · ${escapeInline(doc.tool)}`,
    '',
  )
  out.push(
    `- **${doc.summary.nonConformities}** non-conformités (${doc.summary.occurrences} occurrences détaillées)`,
    `- **${doc.summary.confirmedProblems}** problèmes confirmés depuis l’audit`,
    `- **${doc.summary.doubts}** doutes maintenus, **${doc.summary.questions}** questions à trancher`,
    `- ${doc.summary.pages} pages auditées${doc.summary.toolErrors ? ` · ${doc.summary.toolErrors} tests en erreur de l’outil` : ''}`,
    '',
    '## Mode d’emploi',
    '',
    ...doc.howTo.map(
      (step) =>
        `- ${escapeInline(step.text)}${step.command ? ` ${markdownCode(step.command)}` : ''}`,
    ),
    '',
  )

  out.push(`## Non-conformités (${doc.nonConformities.length})`, '')
  if (doc.nonConformities.length === 0) out.push('Aucune non-conformité constatée.', '')
  for (const item of doc.nonConformities) {
    out.push(`### ✗ ${item.test} — ${escapeInline(item.requirement)}`, '')
    out.push(
      `- Critère ${item.criterion} (niveau ${escapeInline(item.level)}) : ${escapeInline(item.criterionTitle)}`,
      `- Thématique ${item.theme} : ${escapeInline(item.themeLabel)}`,
      `- Référence : ${item.reference}`,
      `- Pages (${item.pages.length}) : ${list(item.pages)}`,
    )
    if (item.asqatasunOnly.length) {
      out.push(`- Non conforme selon Asqatasun seulement : ${list(item.asqatasunOnly)}`)
    }
    out.push('')
    item.occurrences.forEach((occurrence, index) => {
      out.push(`${index + 1}. ${escapeInline(occurrence.message)}`)
      if (occurrence.selector) out.push(`   - Élément : ${markdownCode(occurrence.selector)}`)
      out.push(`   - Pages : ${list(occurrence.pages)}`)
      if (occurrence.screenshot) out.push(`   - Capture : ${markdownCode(occurrence.screenshot)}`)
      if (occurrence.snippet)
        out.push('', indentBlock(occurrence.snippet, 'html').replace(/^/gm, ' '))
    })
    if (item.undetailed)
      out.push('', `${item.undetailed} autres occurrences comptées, non détaillées.`)
    if (item.notes.length) {
      out.push('', 'Remarques de l’outil :', ...item.notes.map((note) => `- ${escapeInline(note)}`))
    }
    if (item.particularCases) {
      out.push('', `<details><summary>Cas particuliers du critère</summary>`, '')
      out.push(escapeInline(item.particularCases), '', '</details>')
    }
    out.push('')
  }

  const open = doc.questions.filter((item) => item.state !== 'tranchee-a-appliquer')
  out.push(`## Doutes et questions (${open.length})`, '')
  if (open.length === 0) out.push('Aucune question ouverte.', '')
  for (const item of open) {
    out.push(
      `### ? ${markdownCode(item.key)} — ${STATE_TITLE[item.state]} — ${item.tests.map((test) => test.test).join(', ')}`,
      '',
    )
    out.push(escapeInline(item.question), '')
    for (const test of item.tests) {
      out.push(`- Test ${test.test} : ${escapeInline(test.requirement)}`)
    }
    out.push(`- Pages (${item.pages.length}) : ${list(item.pages)}`)
    for (const [name, value] of Object.entries(item.evidence)) {
      out.push(`- ${escapeInline(name)} : ${escapeInline(safeLine(value, 500))}`)
    }
    if (item.selector) out.push(`- Élément : ${markdownCode(item.selector)}`)
    if (item.screenshot) out.push(`- Capture : ${markdownCode(item.screenshot)}`)
    out.push(
      `- Réponses : ${item.answers
        .map((answer) => `${markdownCode(answer.value)} (${answer.meaning})`)
        .join(', ')}`,
    )
    if (item.doubt) {
      out.push(
        `- Doute de ${escapeInline(item.doubt.by)} le ${escapeInline(item.doubt.date)} : ${escapeInline(item.doubt.reason)}`,
      )
    }
    if (item.decision) {
      out.push(
        `- Décision « ${escapeInline(item.decision.answer)} » de ${escapeInline(item.decision.by)} : ${escapeInline(item.decision.reason)}`,
      )
    }
    out.push(`- Trancher : ${markdownCode(item.decideCommand)}`)
    if (item.snippet) out.push('', indentBlock(item.snippet, 'html'))
    out.push('')
  }

  const applied = doc.questions.filter((item) => item.state === 'tranchee-a-appliquer')
  if (applied.length) {
    out.push(`## Tranchées depuis l’audit, à appliquer (${applied.length})`, '')
    for (const item of applied) {
      out.push(
        `- ${markdownCode(item.key)} « ${escapeInline(item.decision?.answer ?? '')} » — ${escapeInline(safeLine(item.question, 160))}`,
      )
    }
    out.push('')
  }

  if (doc.toolErrors.length) {
    out.push(`## Erreurs de l’outil (${doc.toolErrors.length})`, '')
    out.push('Ces tests n’ont pas pu être vérifiés : ce ne sont pas des défauts du site.', '')
    for (const error of doc.toolErrors) {
      out.push(`- ${error.test} sur ${list(error.pages)}`)
      for (const message of error.messages) out.push(`  - ${escapeInline(message)}`)
    }
    out.push('')
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}

/** Tous les tests, tous les verdicts (positifs, négatifs, doutes), test par test sur l'ensemble des pages. */
export function renderFullResults(report: ReportDocument, catalog: Catalog): string {
  const audited = report.pages.filter((page) => !page.error)
  const byTest = new Map<string, Map<Status, string[]>>()
  for (const page of audited) {
    for (const entry of page.tests) {
      const statuses = byTest.get(entry.test) ?? new Map<Status, string[]>()
      const pages = statuses.get(entry.final) ?? []
      pages.push(page.path)
      statuses.set(entry.final, pages)
      byTest.set(entry.test, statuses)
    }
  }
  const totals: Record<Status, number> = { C: 0, NC: 0, NA: 0, AV: 0, ERR: 0, NT: 0 }
  for (const statuses of byTest.values()) {
    for (const [status, pages] of statuses) totals[status] += pages.length
  }

  const out: string[] = []
  out.push('# Résultats complets — audit RGAA 4.1.2', '')
  out.push(
    `Site ${markdownCode(report.meta.baseUrl)} · ${audited.length} pages auditées · ${byTest.size} tests`,
    '',
    'Chaque test du référentiel, avec son verdict sur chaque page : ✓ conforme (positif), ✗ non conforme (négatif), ? à valider (doute), – non applicable, ⚠ erreur de l’outil, · non testé.',
    'Le détail des non-conformités et des doutes est dans `a-corriger.md`.',
    '',
    `Verdicts (page × test) : ${(['C', 'NC', 'AV', 'NA', 'ERR', 'NT'] as const)
      .map(
        (status) =>
          `${STATUS_SYMBOL[status]} ${totals[status]} ${STATUS_TEXT[status].toLowerCase()}`,
      )
      .join(' · ')}`,
    '',
  )
  if (report.pages.length > audited.length) {
    out.push(
      `Pages non auditées : ${list(report.pages.filter((page) => page.error).map((page) => page.path))}`,
      '',
    )
  }

  let theme = 0
  let criterion = ''
  for (const test of Array.from(byTest.keys()).sort(compareIds)) {
    const info = catalog.byTest.get(test)
    if (themeOf(test) !== theme) {
      theme = themeOf(test)
      out.push(`## ${theme}. ${escapeInline(catalog.themes.get(theme) ?? '')}`, '')
    }
    if (criterionOf(test) !== criterion) {
      criterion = criterionOf(test)
      out.push(
        `### Critère ${criterion} — ${escapeInline(catalog.criteria.get(criterion)?.title ?? '')}`,
        '',
      )
    }
    const statuses = byTest.get(test) ?? new Map()
    const parts = (['NC', 'AV', 'ERR', 'C', 'NA', 'NT'] as const)
      .filter((status) => statuses.has(status))
      .map((status) => {
        const pages = statuses.get(status) ?? []
        const where =
          pages.length === audited.length
            ? 'toutes les pages'
            : list(pages, status === 'NC' || status === 'AV' ? 12 : 5)
        return `${STATUS_SYMBOL[status]} ${STATUS_TEXT[status]} : ${where}`
      })
    out.push(`- **${test}** ${escapeInline(info?.title ?? '')}`)
    for (const part of parts) out.push(`  - ${part}`)
  }
  out.push('')
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}
