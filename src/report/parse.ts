import type { AsqatasunStatus } from '../core/asqatasun.ts'
import { KEY_PATTERN } from '../core/decisions.ts'
import { UserError } from '../core/errors.ts'
import { STATUSES, type Status } from '../core/types.ts'
import { readJsonFile } from '../security/fs.ts'
import { Reader } from '../security/validate.ts'
import {
  type CriteriaCounts,
  type PageEntry,
  type PendingQuestion,
  REPORT_FORMAT,
  type ReportDocument,
  type TestEntry,
} from './model.ts'

/**
 * Relecture validée de `rapport.json`. Le fichier est sur disque, donc
 * modifiable : il est contrôlé champ par champ avant d'être affiché ou
 * utilisé pour enregistrer une décision.
 */

const TEST_ID = /^\d{1,2}\.\d{1,2}\.\d{1,2}$/
const ASQATASUN: readonly AsqatasunStatus[] = ['C', 'NC', 'NA', 'PQ', 'NT']
const PAGE_STATES = ['conforme', 'a-valider', 'non-conforme', 'non-auditee'] as const

function statusCounts(read: Reader, value: unknown, path: string): Record<Status, number> {
  const source = read.record(value, path)
  const out = {} as Record<Status, number>
  for (const status of STATUSES) out[status] = read.number(source[status], `${path}.${status}`)
  return out
}

function criteriaCounts(read: Reader, value: unknown, path: string): CriteriaCounts {
  const source = read.record(value, path)
  return {
    C: read.number(source.C, `${path}.C`),
    NC: read.number(source.NC, `${path}.NC`),
    NA: read.number(source.NA, `${path}.NA`),
    open: read.number(source.open, `${path}.open`),
  }
}

function testEntry(read: Reader, value: unknown, path: string): TestEntry {
  const source = read.record(value, path)
  return {
    test: read.matching(source.test, TEST_ID, `${path}.test`, 'n.n.n'),
    final: read.oneOf(source.final, STATUSES, `${path}.final`),
    tool: read.oneOf(source.tool, STATUSES, `${path}.tool`),
    asqatasun:
      source.asqatasun === undefined || source.asqatasun === null
        ? undefined
        : read.oneOf(source.asqatasun, ASQATASUN, `${path}.asqatasun`),
    disagreement: read.boolean(source.disagreement, `${path}.disagreement`),
    checked: read.number(source.checked, `${path}.checked`),
    failureCount: read.number(source.failureCount, `${path}.failureCount`),
    failures: read.array(source.failures, `${path}.failures`, 1_000).map((item, index) => {
      const failure = read.record(item, `${path}.failures[${index}]`)
      return {
        message: read.string(failure.message, `${path}.failures[${index}].message`),
        selector: read.optionalString(failure.selector, `${path}.failures[${index}].selector`),
        snippet: read.optionalString(failure.snippet, `${path}.failures[${index}].snippet`),
      }
    }),
    pending: read.array(source.pending, `${path}.pending`, 1_000).map((item, index) => {
      const pending = read.record(item, `${path}.pending[${index}]`)
      return {
        key: read.matching(pending.key, KEY_PATTERN, `${path}.pending[${index}].key`, 'empreinte'),
        topic: read.string(pending.topic, `${path}.pending[${index}].topic`, 128),
        question: read.string(pending.question, `${path}.pending[${index}].question`),
      }
    }),
    notes: read.stringList(source.notes, `${path}.notes`, 1_000),
  }
}

function pageEntry(read: Reader, value: unknown, path: string): PageEntry {
  const source = read.record(value, path)
  const asqatasun =
    source.asqatasun === undefined || source.asqatasun === null
      ? undefined
      : read.record(source.asqatasun, `${path}.asqatasun`)
  return {
    url: read.string(source.url, `${path}.url`, 4_000),
    path: read.string(source.path, `${path}.path`, 4_000),
    httpStatus:
      source.httpStatus === null ? null : read.number(source.httpStatus, `${path}.httpStatus`),
    error: read.optionalString(source.error, `${path}.error`),
    state: read.oneOf(source.state, PAGE_STATES, `${path}.state`),
    asqatasun: asqatasun
      ? {
          file: read.string(asqatasun.file, `${path}.asqatasun.file`, 500),
          score: read.string(asqatasun.score, `${path}.asqatasun.score`, 50),
        }
      : undefined,
    counts: statusCounts(read, source.counts, `${path}.counts`),
    criteria: criteriaCounts(read, source.criteria, `${path}.criteria`),
    score: read.nullableNumber(source.score, `${path}.score`),
    criteriaScore: read.nullableNumber(source.criteriaScore, `${path}.criteriaScore`),
    settled: read.boolean(source.settled, `${path}.settled`),
    tests: read
      .array(source.tests, `${path}.tests`, 1_000)
      .map((item, index) => testEntry(read, item, `${path}.tests[${index}]`)),
  }
}

export function parsePending(read: Reader, value: unknown, path: string): PendingQuestion {
  const source = read.record(value, path)
  return {
    topic: read.string(source.topic, `${path}.topic`, 128),
    key: read.matching(source.key, KEY_PATTERN, `${path}.key`, 'empreinte'),
    question: read.string(source.question, `${path}.question`),
    answers: read.stringList(source.answers, `${path}.answers`, 20),
    evidence: read.stringMap(source.evidence, `${path}.evidence`),
    selector: read.optionalString(source.selector, `${path}.selector`),
    snippet: read.optionalString(source.snippet, `${path}.snippet`),
    screenshot: read.optionalString(source.screenshot, `${path}.screenshot`, 500),
    url: read.optionalString(source.url, `${path}.url`, 4_000),
    tests: read.stringList(source.tests, `${path}.tests`, 300),
    pages: read.stringList(source.pages, `${path}.pages`),
  }
}

export function parseReport(data: unknown, where: string): ReportDocument {
  const read = new Reader(where)
  const root = read.record(data, 'racine')
  if (root.format !== REPORT_FORMAT) {
    read.fail(
      `format inconnu (${String(root.format).slice(0, 60)}) : relancer un audit avec cette version de l'outil.`,
    )
  }
  const tool = read.record(root.tool, 'tool')
  const meta = read.record(root.meta, 'meta')
  const scope = read.record(meta.scope, 'meta.scope')
  return {
    format: REPORT_FORMAT,
    tool: {
      name: read.string(tool.name, 'tool.name', 100),
      version: read.string(tool.version, 'tool.version', 50),
    },
    meta: {
      baseUrl: read.string(meta.baseUrl, 'meta.baseUrl', 4_000),
      startedAt: read.string(meta.startedAt, 'meta.startedAt', 50),
      durationMs: read.number(meta.durationMs, 'meta.durationMs'),
      pagesSource: read.oneOf(
        meta.pagesSource,
        ['sitemap', 'arguments'] as const,
        'meta.pagesSource',
      ),
      pagesDropped: read.number(meta.pagesDropped, 'meta.pagesDropped'),
      scope: {
        themes: read.stringList(scope.themes, 'meta.scope.themes', 100),
        criteria: read.stringList(scope.criteria, 'meta.scope.criteria', 200),
        tests: read.stringList(scope.tests, 'meta.scope.tests', 300),
      },
      decisionsDir: read.string(meta.decisionsDir, 'meta.decisionsDir', 4_000),
      decisionsCount: read.number(meta.decisionsCount, 'meta.decisionsCount'),
      unusedDecisions: read.nullableNumber(meta.unusedDecisions, 'meta.unusedDecisions'),
      asqatasunDir:
        meta.asqatasunDir === null
          ? null
          : read.string(meta.asqatasunDir, 'meta.asqatasunDir', 4_000),
      asqatasunReports: read.number(meta.asqatasunReports, 'meta.asqatasunReports'),
      strict: read.boolean(meta.strict, 'meta.strict'),
    },
    pages: read
      .array(root.pages, 'pages', 100_000)
      .map((item, index) => pageEntry(read, item, `pages[${index}]`)),
    pending: read
      .array(root.pending, 'pending', 100_000)
      .map((item, index) => parsePending(read, item, `pending[${index}]`)),
  }
}

/** Nom du fichier JSON dans le dossier du rapport. */
export const REPORT_JSON = 'rapport.json'

export function readReport(file: string): ReportDocument {
  let data: unknown
  try {
    data = readJsonFile(file, 200 * 1024 * 1024)
  } catch (error) {
    if (error instanceof UserError && error.message.startsWith('Fichier introuvable')) {
      throw new UserError(
        `Aucun rapport dans ${file} : lancer d'abord un audit (rgaa audit <url>).`,
      )
    }
    throw error
  }
  return parseReport(data, file)
}
