import { type Check, defineCheck, type ElementRef, type OutcomeFor } from '../core/types.ts'

/**
 * Thématique 5 — Tableaux.
 *
 * Chaque `<table>` visible est d'abord classé : tableau de données ou tableau de mise en
 * forme. `role="presentation"` ou `role="none"` tranche pour la mise en forme ; la
 * présence d'un `<th>`, d'un `<caption>`, d'un `<thead>`, d'un `summary`, d'un `scope` ou d'un
 * `headers` tranche pour les données ; un tableau qui n'a aucun de ces indices est soumis au
 * jugement. Les en-têtes sont ensuite classés selon leur portée : toute la colonne, toute la
 * ligne, ou une partie seulement (cellules fusionnées, en-têtes de groupe).
 */

/** Portée d'une cellule d'en-tête. */
type Scope = 'col' | 'row' | 'partial'

interface CellInfo {
  tag: string
  role: string
  scope: string
  id: string
  headers: string
  /** `col`, `row`, `partial` pour un en-tête (th ou rôle), `null` pour une cellule de données. */
  header: Scope | null
  text: string
  ref: ElementRef
}

interface TableInfo {
  ref: ElementRef
  role: string
  rows: number
  columns: number
  nestedTable: boolean
  hasTh: boolean
  hasThead: boolean
  hasTfoot: boolean
  hasCaption: boolean
  captionText: string
  summary: string
  /** Résumé porté par aria-describedby, un `<figcaption>`/`<p>` du `<figure>` ou un `<details>` du `<caption>`. */
  otherSummary: string
  /** Titre par aria-label / aria-labelledby ; `missing` : l'attribut renvoie vers un id qui n'existe pas. */
  ariaTitle: string
  ariaTitleMissing: boolean
  figureTitle: string
  headerRoles: boolean
  cells: CellInfo[]
  /** Première ligne / première colonne en `<td>` tous en gras : en-têtes simulés. */
  fakeColumnHeaders: boolean
  fakeRowHeaders: boolean
  firstRowText: string
}

const GENERIC_TITLES = new Set([
  'tableau',
  'table',
  'donnees',
  'tableau de donnees',
  'titre',
  'title',
  'legende',
])

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Plafond de questions « données ou mise en forme ? » par page. */
const MAX_KIND_QUESTIONS = 12

async function collectTables(page: import('playwright').Page): Promise<TableInfo[]> {
  return page.evaluate(() => {
    const { ref, norm, isHiddenFromAT } = window.__rgaa

    const textOfIds = (ids: string): { text: string; missing: boolean } => {
      const parts: string[] = []
      let missing = false
      for (const id of ids.split(/\s+/).filter(Boolean)) {
        const target = document.getElementById(id)
        if (target) parts.push(norm(target.textContent))
        else missing = true
      }
      return { text: norm(parts.join(' ')), missing }
    }

    const tables: TableInfo[] = []
    for (const table of document.querySelectorAll('table')) {
      if (isHiddenFromAT(table)) continue
      const role = (table.getAttribute('role') ?? '').trim().toLowerCase()
      if (['grid', 'treegrid'].includes(role)) continue // composants interactifs, hors périmètre du critère

      const isHeader = (cell: Element) =>
        cell.localName === 'th' ||
        ['columnheader', 'rowheader'].includes(cell.getAttribute('role') ?? '')
      const cells: CellInfo[] = []
      let columns = 0
      for (const row of Array.from(table.rows)) {
        const rowCells = Array.from(row.cells)
        columns = Math.max(columns, rowCells.length)
        const allHeaders = rowCells.length > 0 && rowCells.every(isHeader)
        rowCells.forEach((cell, index) => {
          let header: Scope | null = null
          if (isHeader(cell)) {
            if (
              Number.parseInt(cell.getAttribute('colspan') ?? '1', 10) > 1 ||
              Number.parseInt(cell.getAttribute('rowspan') ?? '1', 10) > 1
            ) {
              header = 'partial'
            } else if (allHeaders) {
              header = 'col'
            } else if (rowCells.slice(0, index).every(isHeader)) {
              header = 'row'
            } else {
              header = 'partial'
            }
          }
          cells.push({
            tag: cell.localName,
            role: cell.getAttribute('role') ?? '',
            scope: cell.getAttribute('scope') ?? '',
            id: cell.id,
            headers: cell.getAttribute('headers') ?? '',
            header,
            text: norm(cell.textContent).slice(0, 60),
            ref: ref(cell),
          })
        })
      }

      const caption = table.querySelector(':scope > caption')
      const labelled = table.getAttribute('aria-labelledby')
      const labelledText = labelled ? textOfIds(labelled) : { text: '', missing: false }
      const describedBy = table.getAttribute('aria-describedby')
      const described = describedBy ? textOfIds(describedBy) : { text: '', missing: false }
      const figure = table.closest('figure')
      const figureOnlyTable =
        figure && figure.querySelectorAll('table').length === 1 ? figure : null
      const figcaption = figureOnlyTable?.querySelector('figcaption')
      const captionDetails = caption?.querySelector('details')

      const bold = (cell: Element | undefined) =>
        !!cell && Number.parseInt(getComputedStyle(cell).fontWeight, 10) >= 600
      const rows = Array.from(table.rows)
      const firstRow = rows[0] ? Array.from(rows[0].cells) : []
      const fakeColumnHeaders =
        firstRow.length >= 2 &&
        rows.length >= 2 &&
        firstRow.every(
          (cell) => cell.localName === 'td' && !cell.hasAttribute('role') && bold(cell),
        ) &&
        !rows.slice(1).every((row) => Array.from(row.cells).every((cell) => bold(cell)))
      const firstColumn = rows.slice(1).map((row) => row.cells[0])
      const fakeRowHeaders =
        firstColumn.length >= 2 &&
        firstColumn.every(
          (cell) => cell?.localName === 'td' && !cell.hasAttribute('role') && bold(cell),
        ) &&
        rows.slice(1).some((row) => row.cells.length > 1 && !bold(row.cells[1]))

      tables.push({
        ref: ref(table),
        role,
        rows: rows.length,
        columns,
        nestedTable: table.querySelector('table') !== null,
        hasTh: table.querySelector('th') !== null,
        hasThead: table.querySelector('thead') !== null,
        hasTfoot: table.querySelector('tfoot') !== null,
        hasCaption: caption !== null,
        captionText: caption ? norm(caption.textContent) : '',
        summary: norm(table.getAttribute('summary')),
        otherSummary: norm(
          [
            described.text,
            figcaption ? norm(figcaption.textContent) : '',
            ...Array.from(figureOnlyTable?.querySelectorAll(':scope > p') ?? []).map((p) =>
              norm(p.textContent),
            ),
            captionDetails ? norm(captionDetails.textContent) : '',
          ].join(' '),
        ),
        ariaTitle: norm(table.getAttribute('aria-label')) || labelledText.text,
        ariaTitleMissing: labelled !== null && (labelledText.missing || labelledText.text === ''),
        figureTitle: figcaption ? norm(figcaption.textContent) : '',
        headerRoles: table.querySelector('[role="columnheader"], [role="rowheader"]') !== null,
        cells,
        fakeColumnHeaders,
        fakeRowHeaders,
        firstRowText: norm(firstRow.map((cell) => cell.textContent).join(' | ')).slice(0, 120),
      })
    }
    return tables
  })
}

type Kind = 'donnees' | 'mise-en-forme'

const tableaux = defineCheck(
  [
    '5.1.1',
    '5.2.1',
    '5.3.1',
    '5.4.1',
    '5.5.1',
    '5.6.1',
    '5.6.2',
    '5.6.3',
    '5.6.4',
    '5.7.1',
    '5.7.2',
    '5.7.3',
    '5.7.4',
    '5.7.5',
    '5.8.1',
  ],
  async (ctx, t) => {
    const tables = await ctx.memo('tableaux', () => collectTables(ctx.page))
    let asked = 0
    let unasked = 0

    for (const table of tables) {
      // ─── Classement : données ou mise en forme ───────────────────────────
      let kind: Kind
      const dataSignals =
        table.hasTh ||
        table.hasCaption ||
        table.hasThead ||
        table.hasTfoot ||
        table.summary !== '' ||
        table.headerRoles ||
        table.cells.some((cell) => cell.scope !== '' || cell.headers !== '')
      if (table.role === 'presentation' || table.role === 'none') {
        kind = 'mise-en-forme'
      } else if (dataSignals || table.role === 'table') {
        kind = 'donnees'
      } else if (table.rows <= 1 || table.columns <= 1) {
        // Une seule ligne ou une seule colonne : aucune relation entre en-têtes et cellules à décrire.
        kind = 'mise-en-forme'
      } else if (asked < MAX_KIND_QUESTIONS) {
        asked += 1
        const answer = await t('5.3.1').judge({
          topic: 'table.kind',
          question:
            'Ce tableau n’a ni en-tête <th>, ni titre, ni résumé. Est-ce un tableau de données (information rangée en lignes et colonnes) ou un tableau de mise en forme (mise en page) ?',
          answers: ['donnees', 'mise-en-forme'],
          evidence: {
            lignes: String(table.rows),
            colonnes: String(table.columns),
            debut: table.firstRowText,
          },
          ref: table.ref,
        })
        if (!answer) continue
        kind = answer as Kind
      } else {
        unasked += 1
        continue
      }

      if (kind === 'mise-en-forme') {
        layoutTable(table, t)
        continue
      }
      await dataTable(table, ctx.path, t)
    }

    if (unasked > 0) {
      t('5.3.1').note(
        `${unasked} tableau(x) de plus n’ont pas été classés : plafond de ${MAX_KIND_QUESTIONS} questions par page.`,
      )
    }
  },
)

type Tester = OutcomeFor

// ─── Tableaux de mise en forme : 5.3.1, 5.8.1 ──────────────────────────────

function layoutTable(table: TableInfo, t: Tester): void {
  t('5.3.1').applicable()
  if (table.role !== 'presentation' && table.role !== 'none') {
    t('5.3.1').fail('Tableau de mise en forme sans attribut role="presentation".', table.ref)
  }

  t('5.8.1').applicable()
  const found: string[] = []
  if (table.summary !== '') found.push('un attribut summary')
  if (table.hasCaption) found.push('un <caption>')
  if (table.hasTh) found.push('des <th>')
  if (table.hasThead) found.push('un <thead>')
  if (table.hasTfoot) found.push('un <tfoot>')
  if (table.headerRoles) found.push('des rôles rowheader/columnheader')
  if (table.cells.some((cell) => cell.scope !== '' || cell.headers !== '')) {
    found.push('des attributs scope, headers ou axis sur les cellules')
  }
  if (found.length > 0) {
    t('5.8.1').fail(`Tableau de mise en forme qui comporte ${found.join(', ')}.`, table.ref)
  }
}

// ─── Tableaux de données ────────────────────────────────────────────────────

async function dataTable(table: TableInfo, path: string, t: Tester): Promise<void> {
  const headers = table.cells.filter((cell) => cell.header !== null)
  const partial = headers.filter((cell) => cell.header === 'partial')
  const wholeLine = headers.filter((cell) => cell.header !== 'partial')
  const hasColumns = headers.some((cell) => cell.header === 'col')
  const hasRows = headers.some((cell) => cell.header === 'row')
  const complex = partial.length > 0 || table.cells.some((cell) => cell.headers !== '')
  const title = table.captionText || table.ariaTitle || table.figureTitle // titre, quelle que soit la façon de l'associer
  const where = table.ref

  // 5.1.1 / 5.2.1 — résumé des tableaux complexes.
  if (complex) {
    t('5.1.1').applicable()
    const summary = table.summary || table.otherSummary
    if (summary === '') {
      t('5.1.1').fail(
        'Tableau de données complexe sans résumé (summary, aria-describedby, figcaption ou details).',
        where,
      )
    } else {
      await t('5.2.1').judgePass({
        topic: 'table.summary',
        question:
          'Ce résumé décrit-il pertinemment la structure et le contenu du tableau complexe ?',
        evidence: { page: path, titre: title, resume: summary.slice(0, 300) },
        ref: where,
      })
    }
  }

  // 5.4.1 / 5.5.1 — titre.
  if (table.hasCaption && table.captionText === '') {
    t('5.4.1').fail('Le <caption> du tableau est vide.', where)
  } else if (table.ariaTitleMissing) {
    t('5.4.1').fail('aria-labelledby du tableau renvoie vers un élément absent ou vide.', where)
  } else if (title !== '') {
    t('5.4.1').applicable()
    const key = fold(title)
    if (GENERIC_TITLES.has(key) || key.length < 3 || title.length > 150) {
      await t('5.5.1').judgePass({
        topic: 'table.title',
        question: `Le titre « ${title} » permet-il d’identifier le contenu du tableau de manière claire et concise ?`,
        evidence: { titre: title },
        ref: where,
      })
    } else {
      t('5.5.1').applicable()
    }
  }

  // 5.6 — structure des en-têtes.
  t('5.6.1').applicable()
  if (table.fakeColumnHeaders && !hasColumns) {
    t('5.6.1').fail('Les en-têtes de colonnes sont des <td> mis en gras au lieu de <th>.', where)
  } else if (!table.hasTh && !table.headerRoles && !table.fakeRowHeaders) {
    t('5.6.1').fail(
      'Tableau de données sans aucun en-tête : ni <th>, ni role="columnheader" ou "rowheader".',
      where,
    )
  }
  if (hasRows || table.fakeRowHeaders) {
    t('5.6.2').applicable()
    if (table.fakeRowHeaders && !hasRows) {
      t('5.6.2').fail('Les en-têtes de lignes sont des <td> mis en gras au lieu de <th>.', where)
    }
  }
  if (partial.length > 0) t('5.6.3').applicable(partial.length)
  if (complex) t('5.6.4').applicable()

  // 5.7.1 / 5.7.2 — en-têtes qui s'appliquent à toute la ligne ou colonne.
  // Cas particulier : avec des en-têtes sur une seule dimension, `<th>` seul suffit.
  const bothDimensions = hasColumns && hasRows
  for (const cell of wholeLine) {
    t('5.7.1').applicable()
    const roled = cell.role === 'columnheader' || cell.role === 'rowheader'
    if (bothDimensions && cell.scope === '' && cell.id === '' && !roled) {
      t('5.7.1').fail(
        `L’en-tête « ${cell.text} » n’a ni id, ni scope, ni rôle : il n’est pas relié à ses cellules.`,
        cell.ref,
      )
    }
    if (cell.scope !== '') {
      t('5.7.2').applicable()
      if (cell.scope !== cell.header) {
        t('5.7.2').fail(
          `L’en-tête « ${cell.text} » porte scope="${cell.scope}" alors qu’il s’applique à ${cell.header === 'col' ? 'une colonne (scope="col")' : 'une ligne (scope="row")'}.`,
          cell.ref,
        )
      }
    }
  }

  // 5.7.3 — en-têtes partiels : un id, ni scope ni rôle.
  const ids = new Set(headers.map((cell) => cell.id).filter(Boolean))
  for (const cell of partial) {
    t('5.7.3').applicable()
    const problems: string[] = []
    if (cell.scope !== '') problems.push(`un attribut scope="${cell.scope}"`)
    if (cell.role === 'columnheader' || cell.role === 'rowheader')
      problems.push(`un rôle ${cell.role}`)
    if (cell.id === '') problems.push('aucun id')
    if (problems.length > 0) {
      t('5.7.3').fail(`L’en-tête partiel « ${cell.text} » a ${problems.join(' et ')}.`, cell.ref)
    }
  }

  // 5.7.4 — cellules rattachées à des en-têtes qui portent un id : attribut headers.
  if (ids.size > 0) {
    t('5.7.4').applicable()
    // Les cellules vides (coin du tableau) n'ont rien à rattacher.
    for (const cell of table.cells.filter((c) => c.header === null && c.text !== '')) {
      const listed = cell.headers.split(/\s+/).filter(Boolean)
      if (listed.length === 0) {
        t('5.7.4').fail(
          `La cellule « ${cell.text} » n’a pas d’attribut headers alors que le tableau porte des en-têtes avec id.`,
          cell.ref,
        )
      } else if (listed.some((id) => !ids.has(id))) {
        t('5.7.4').fail(
          `L’attribut headers de la cellule « ${cell.text} » cite un id absent des en-têtes (${listed.filter((id) => !ids.has(id)).join(', ')}).`,
          cell.ref,
        )
      }
    }
  }

  // 5.7.5 — rôles rowheader / columnheader cohérents avec la position.
  for (const cell of headers.filter((c) => c.role === 'columnheader' || c.role === 'rowheader')) {
    t('5.7.5').applicable()
    if (cell.header === 'col' && cell.role === 'rowheader') {
      t('5.7.5').fail(`L’en-tête de colonne « ${cell.text} » porte role="rowheader".`, cell.ref)
    } else if (cell.header === 'row' && cell.role === 'columnheader') {
      t('5.7.5').fail(`L’en-tête de ligne « ${cell.text} » porte role="columnheader".`, cell.ref)
    }
  }
}

export const checks: Check[] = [tableaux]
