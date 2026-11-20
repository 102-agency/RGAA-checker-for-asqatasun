import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import type { DiffEntry, ReportDiff } from '../report/diff.ts'
import { diffReports } from '../report/diff.ts'
import type { ReportDocument } from '../report/model.ts'
import { containedPath, readJsonFile, writeJsonAtomic } from '../security/fs.ts'
import { safeLine, safeText } from '../security/text.ts'
import { Reader } from '../security/validate.ts'

/**
 * Journal des modifications qu'une IA (connectée en MCP) a faites au code du
 * site pour corriger une non-conformité : fichier, texte avant, texte après.
 * L'interface web les montre en « avant / après », comme la revue des
 * modifications d'un éditeur, et indique si l'audit suivant confirme la correction.
 *
 * Le journal est un simple fichier du dossier du rapport (`corrections.json`) :
 * le disque fait foi, car le serveur MCP qui écrit et l'interface qui lit
 * peuvent être deux processus. Ce que l'IA y inscrit est une donnée : il
 * n'est jamais exécuté, jamais lu comme un chemin, et n'est affiché qu'en texte.
 */

export const CHANGES_FILE = 'corrections.json'
export const CHANGES_FORMAT = 'rgaa-corrections/1'

export const CHANGE_LIMITS = {
  /** Texte avant ou après, en caractères. */
  code: 8_000,
  file: 300,
  note: 600,
  by: 100,
  pages: 20,
  /** Nombre d'entrées gardées : les plus anciennes sont retirées. */
  entries: 300,
} as const

const MAX_FILE_BYTES = 8 * 1024 * 1024
const TEST_PATTERN = /^\d{1,2}\.\d{1,2}\.\d{1,2}$/
const OCCURRENCE_PATTERN = /^[0-9a-f]{12}$/

/**
 * Verdict du dernier audit sur une modification :
 * - `a-verifier`  : aucun audit n'a encore revu les pages concernées ;
 * - `corrigee`    : le test n'est plus en échec sur ces pages ;
 * - `persiste`    : le test échoue toujours sur au moins une de ces pages ;
 * - `regression`  : la correction a fait apparaître un autre échec sur ces pages.
 */
export const CHANGE_STATES = ['a-verifier', 'corrigee', 'persiste', 'regression'] as const
export type ChangeState = (typeof CHANGE_STATES)[number]

export interface ChangeVerdict {
  state: ChangeState
  /** Date de l'audit qui a rendu ce verdict. */
  date: string
  /** Échecs restants, « 1.1.1 sur /contact ». */
  remaining: string[]
  /** Nouveaux échecs sur les pages concernées, « 1.3.1 sur /contact ». */
  introduced: string[]
}

export interface Change {
  id: string
  /** Horodatage ISO de la modification. */
  at: string
  by: string
  /** Test RGAA dont la modification vise l'échec (« 1.1.1 »). */
  test: string
  /** Pages concernées (chemins). */
  pages: string[]
  /** Fichier modifié, tel que l'IA le désigne (affiché seulement). */
  file: string
  /** Première ligne du texte avant dans le fichier, si l'IA la donne. */
  line?: number
  before: string
  after: string
  /** Empreinte de l'occurrence visée (donnée par `lire_a_corriger`). */
  occurrence?: string
  note?: string
  verdict?: ChangeVerdict
}

export interface ChangeInput {
  test: string
  pages: string[]
  file: string
  line?: number
  before: string
  after: string
  occurrence?: string
  note?: string
  by: string
}

export class ChangeError extends Error {}

/** Valide l'entrée d'un enregistrement (arguments d'outil) et la nettoie. */
export function cleanChangeInput(input: ChangeInput, knownTests: ReadonlySet<string>): ChangeInput {
  if (!TEST_PATTERN.test(input.test) || !knownTests.has(input.test)) {
    throw new ChangeError(
      `Test inconnu « ${safeLine(input.test, 20)} » (attendu : 1.1.1 à 13.12.3).`,
    )
  }
  const pages = [...new Set(input.pages.map((page) => safeLine(page, 2_000)))]
  if (pages.length === 0 || pages.length > CHANGE_LIMITS.pages) {
    throw new ChangeError(`Il faut de 1 à ${CHANGE_LIMITS.pages} pages (chemins commençant par /).`)
  }
  for (const page of pages) {
    if (!page.startsWith('/'))
      throw new ChangeError(
        `Chemin de page invalide « ${page.slice(0, 80)} » : il doit commencer par /.`,
      )
  }
  const file = safeLine(input.file, CHANGE_LIMITS.file)
  if (!file) throw new ChangeError('Le fichier modifié est obligatoire.')
  const before = safeText(input.before)
  const after = safeText(input.after)
  if (before.length > CHANGE_LIMITS.code || after.length > CHANGE_LIMITS.code) {
    throw new ChangeError(
      `Texte avant ou après trop long (maximum ${CHANGE_LIMITS.code} caractères) : ne consigner que le passage modifié.`,
    )
  }
  if (before === after) throw new ChangeError('Le texte avant et le texte après sont identiques.')
  if (before === '' && after === '')
    throw new ChangeError('Rien à consigner : avant et après sont vides.')
  if (
    input.line !== undefined &&
    (!Number.isInteger(input.line) || input.line < 1 || input.line > 10_000_000)
  ) {
    throw new ChangeError('« ligne » doit être un entier positif.')
  }
  if (input.occurrence !== undefined && !OCCURRENCE_PATTERN.test(input.occurrence)) {
    throw new ChangeError(
      '« occurrence » doit être l’empreinte de 12 caractères hexadécimaux donnée par lire_a_corriger.',
    )
  }
  const note =
    input.note === undefined ? undefined : safeLine(input.note, CHANGE_LIMITS.note) || undefined
  return {
    test: input.test,
    pages,
    file,
    line: input.line,
    before,
    after,
    occurrence: input.occurrence,
    note,
    by: safeLine(input.by, CHANGE_LIMITS.by) || 'IA (MCP)',
  }
}

function parseVerdict(read: Reader, value: unknown, path: string): ChangeVerdict {
  const entry = read.record(value, path)
  return {
    state: read.oneOf(entry.state, CHANGE_STATES, `${path}.state`),
    date: read.string(entry.date, `${path}.date`, 40),
    remaining: read.stringList(entry.remaining, `${path}.remaining`, 200),
    introduced: read.stringList(entry.introduced, `${path}.introduced`, 200),
  }
}

function parseChange(read: Reader, value: unknown, path: string): Change {
  const entry = read.record(value, path)
  return {
    id: read.matching(entry.id, OCCURRENCE_PATTERN, `${path}.id`, '12 caractères hexadécimaux'),
    at: read.string(entry.at, `${path}.at`, 40),
    by: read.string(entry.by, `${path}.by`, CHANGE_LIMITS.by),
    test: read.matching(entry.test, TEST_PATTERN, `${path}.test`, 'numéro de test'),
    pages: read.stringList(entry.pages, `${path}.pages`, CHANGE_LIMITS.pages),
    file: read.string(entry.file, `${path}.file`, CHANGE_LIMITS.file),
    line: entry.line === undefined ? undefined : read.number(entry.line, `${path}.line`),
    before: read.string(entry.before, `${path}.before`, CHANGE_LIMITS.code),
    after: read.string(entry.after, `${path}.after`, CHANGE_LIMITS.code),
    occurrence:
      entry.occurrence === undefined
        ? undefined
        : read.matching(
            entry.occurrence,
            OCCURRENCE_PATTERN,
            `${path}.occurrence`,
            '12 caractères hexadécimaux',
          ),
    note: read.optionalString(entry.note, `${path}.note`, CHANGE_LIMITS.note),
    verdict:
      entry.verdict === undefined
        ? undefined
        : parseVerdict(read, entry.verdict, `${path}.verdict`),
  }
}

/**
 * Verdict de chaque modification d'après le rapport qui vient d'être écrit.
 * Seules les modifications faites avant le début de l'audit, sur des pages
 * réellement auditées, reçoivent un verdict (les autres gardent le leur).
 */
export function judgeChanges(
  changes: Change[],
  report: ReportDocument,
  options: {
    /** Chemins réauditées ; `null` = toutes les pages du rapport. */
    audited: string[] | null
    /** Début de l'audit (ISO) : une modification postérieure n'a pas pu être vérifiée par lui. */
    since: string
    /** Rapport d'avant, pour repérer les régressions. */
    before?: ReportDocument
    date: string
  },
): Change[] {
  const reported = new Map(report.pages.map((page) => [page.path, page]))
  const diff: ReportDiff | undefined = options.before
    ? diffReports(options.before, report)
    : undefined
  const introduced = new Map<string, DiffEntry[]>()
  for (const entry of diff?.introduced ?? []) {
    introduced.set(entry.page, [...(introduced.get(entry.page) ?? []), entry])
  }
  const audited = options.audited ? new Set(options.audited) : null
  return changes.map((change) => {
    if (change.at > options.since) return change
    const pages = change.pages.filter(
      (path) =>
        (audited === null || audited.has(path)) && reported.get(path) && !reported.get(path)?.error,
    )
    // Toutes les pages visées doivent avoir été revues pour conclure.
    if (pages.length === 0 || pages.length < change.pages.length) return change
    const remaining: string[] = []
    const fresh: string[] = []
    for (const path of pages) {
      const entry = reported.get(path)?.tests.find((item) => item.test === change.test)
      if (entry?.final === 'NC') remaining.push(`${change.test} sur ${path}`)
      for (const added of introduced.get(path) ?? []) {
        if (added.test !== change.test) fresh.push(`${added.test} sur ${path}`)
      }
    }
    const state: ChangeState =
      fresh.length > 0 ? 'regression' : remaining.length > 0 ? 'persiste' : 'corrigee'
    const same =
      change.verdict?.state === state &&
      change.verdict.remaining.join('\n') === remaining.join('\n') &&
      change.verdict.introduced.join('\n') === fresh.join('\n')
    // Verdict inchangé : on garde l'ancien (et sa date) pour ne rien réécrire ni réafficher.
    if (same) return change
    return { ...change, verdict: { state, date: options.date, remaining, introduced: fresh } }
  })
}

/** Fichier `corrections.json` d'un dossier de rapport. */
export class ChangeStore {
  constructor(readonly outDir: string) {}

  private get file(): string {
    return containedPath(this.outDir, CHANGES_FILE)
  }

  exists(): boolean {
    try {
      return lstatSync(this.file).isFile()
    } catch {
      return false
    }
  }

  /** Empreinte du contenu du fichier (taille + date), pour savoir s'il a changé. */
  version(): string {
    try {
      const stat = lstatSync(this.file)
      return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : ''
    } catch {
      return ''
    }
  }

  list(): Change[] {
    if (!existsSync(this.file)) return []
    const file = this.file
    const read = new Reader(file)
    const root = read.record(readJsonFile(file, MAX_FILE_BYTES), 'racine')
    return read
      .array(root.changes, 'changes', CHANGE_LIMITS.entries * 2)
      .map((item, index) => parseChange(read, item, `changes[${index}]`))
  }

  private save(changes: Change[]): void {
    writeJsonAtomic(this.file, {
      format: CHANGES_FORMAT,
      changes: changes.slice(-CHANGE_LIMITS.entries),
    })
  }

  add(input: ChangeInput, now = new Date()): Change {
    const at = now.toISOString()
    const id = createHash('sha1')
      .update(`${at}\n${input.test}\n${input.file}\n${randomBytes(8).toString('hex')}`)
      .digest('hex')
      .slice(0, 12)
    const change: Change = { id, at, ...input }
    this.save([...this.list(), change])
    return change
  }

  /** Attribue un verdict aux modifications que l'audit qui vient de finir a pu vérifier. */
  verify(report: ReportDocument, options: Parameters<typeof judgeChanges>[2]): Change[] {
    const before = this.list()
    if (before.length === 0) return before
    const after = judgeChanges(before, report, options)
    if (after.some((change, index) => change !== before[index])) this.save(after)
    return after
  }
}

const STATE_TEXT: Record<ChangeState, string> = {
  'a-verifier': 'à vérifier',
  corrigee: 'corrigée',
  persiste: 'PERSISTE',
  regression: 'RÉGRESSION',
}

/** Bilan des modifications consignées, pour l'IA : ce que le dernier audit en dit. */
export function renderChangeVerdicts(changes: Change[]): string {
  if (changes.length === 0) return ''
  const lines = changes
    .slice(-25)
    .reverse()
    .map((change) => {
      const verdict = change.verdict
      const detail = verdict
        ? [
            ...verdict.remaining.map((item) => `échec restant : ${item}`),
            ...verdict.introduced.map((item) => `nouvel échec : ${item}`),
          ]
        : []
      return `  - ${change.id} · test ${change.test} · ${change.file} → ${STATE_TEXT[verdict?.state ?? 'a-verifier']}${detail.length ? ` (${detail.join(' ; ')})` : ''}`
    })
  const count = (state: ChangeState) =>
    changes.filter((change) => (change.verdict?.state ?? 'a-verifier') === state).length
  return [
    `Modifications consignées (${changes.length}) : ${count('corrigee')} corrigée(s), ${count('persiste')} persistante(s), ${count('regression')} régression(s), ${count('a-verifier')} à vérifier :`,
    ...lines,
  ].join('\n')
}
