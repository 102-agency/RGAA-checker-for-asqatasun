import { ASQATASUN_LABEL } from '../core/asqatasun.ts'
import { type Catalog, compareIds, criterionOf, themeOf } from '../core/catalog.ts'
import type { Status } from '../core/types.ts'
import { escapeMarkdown, markdownBlock, markdownCode, safeLine } from '../security/text.ts'
import {
  type PageEntry,
  type PageState,
  type ReportDocument,
  siteOverview,
  type TestEntry,
} from './model.ts'
import {
  duration,
  frDate,
  frNumber,
  plural,
  STATUS_MEANING,
  STATUS_SYMBOL,
  STATUS_TEXT,
} from './style.ts'

/**
 * Rapport Markdown (`rapport.md`) : lisible tel quel, versionnable, et rendu
 * proprement par les forges (GitLab, GitHub…). Tout texte issu des pages est
 * échappé : il ne peut ni injecter de HTML, ni casser la mise en page.
 */

const STATE_LABEL: Record<PageState, string> = {
  conforme: '✓ 100 % confirmé',
  'a-valider': '? à valider',
  'non-conforme': '✗ non conforme',
  'non-auditee': '⚠ non auditée',
}

function rate(value: number | null): string {
  return value === null ? '—' : `${frNumber(value)} %`
}

function verdict(status: Status): string {
  return `${STATUS_SYMBOL[status]} ${STATUS_TEXT[status]}`
}

function pagesList(pages: readonly string[], max = 10): string {
  const shown = pages.slice(0, max).map((page) => markdownCode(page))
  return pages.length > max ? `${shown.join(', ')} (+ ${pages.length - max})` : shown.join(', ')
}

function grouped<T extends { test: string }>(items: readonly T[]): Map<number, Map<string, T[]>> {
  const out = new Map<number, Map<string, T[]>>()
  for (const item of [...items].sort((a, b) => compareIds(a.test, b.test))) {
    const criteria = out.get(themeOf(item.test)) ?? new Map<string, T[]>()
    const list = criteria.get(criterionOf(item.test)) ?? []
    list.push(item)
    criteria.set(criterionOf(item.test), list)
    out.set(themeOf(item.test), criteria)
  }
  return out
}

function criterionTitle(catalog: Catalog, criterion: string): string {
  const info = catalog.criteria.get(criterion)
  return `Critère ${criterion}${info?.level ? ` (niveau ${info.level})` : ''} — ${escapeMarkdown(info?.title ?? '')}`
}

function failureBlock(
  out: string[],
  failure: { message: string; selector?: string; snippet?: string; pages?: string[] },
  index: number,
): void {
  out.push(`${index}. ${escapeMarkdown(failure.message)}`)
  if (failure.selector) out.push(`   - Élément : ${markdownCode(failure.selector)}`)
  if (failure.pages && failure.pages.length > 0)
    out.push(`   - Pages : ${pagesList(failure.pages)}`)
  if (failure.snippet) {
    out.push('')
    out.push(
      markdownBlock(failure.snippet, 'html')
        .split('\n')
        .map((line) => `   ${line}`)
        .join('\n'),
    )
  }
}

function testDetail(out: string[], entry: TestEntry, catalog: Catalog): void {
  let summary = STATUS_MEANING[entry.final]
  if (entry.final === 'C') summary = plural(entry.checked, 'élément contrôlé', 'éléments contrôlés')
  if (entry.final === 'NC') summary = plural(entry.failureCount, 'échec')
  if (entry.final === 'AV') summary = `${plural(entry.pending.length, 'question')} en attente`
  out.push(`- **${entry.test}** — ${verdict(entry.final)} : ${summary}`)
  if (!['C', 'NA', 'NT'].includes(entry.final)) {
    out.push(`  <br>*${escapeMarkdown(catalog.byTest.get(entry.test)?.title ?? '')}*`)
  }
  const nested: string[] = []
  entry.failures.forEach((failure, index) => {
    failureBlock(nested, failure, index + 1)
  })
  if (entry.failureCount > entry.failures.length) {
    nested.push(`- ${entry.failureCount - entry.failures.length} échecs non détaillés.`)
  }
  for (const pending of entry.pending) {
    nested.push(`- ? ${markdownCode(pending.key)} ${escapeMarkdown(pending.question)}`)
  }
  if (entry.asqatasun === 'NC' && entry.tool !== 'NC') {
    nested.push('- Non conforme selon Asqatasun (voir le détail dans son export).')
  }
  if (entry.disagreement && entry.asqatasun) {
    nested.push(
      `- ≠ Divergence : l’outil dit « ${STATUS_TEXT[entry.tool]} », Asqatasun « ${ASQATASUN_LABEL[entry.asqatasun]} ».`,
    )
  }
  for (const note of entry.notes) nested.push(`- ⓘ ${escapeMarkdown(note)}`)
  if (nested.length) {
    out.push('')
    for (const line of nested) out.push(line ? `  ${line}` : '')
    out.push('')
  }
}

function pageSection(out: string[], page: PageEntry, catalog: Catalog): void {
  out.push(`### ${escapeMarkdown(page.path)}`, '')
  out.push(`${markdownCode(page.url)}`, '')
  out.push(
    `${STATE_LABEL[page.state]} · taux critères ${rate(page.criteriaScore)}${page.settled ? '' : ' (provisoire)'} · taux tests ${rate(page.score)}`,
    '',
  )
  if (page.error) {
    out.push(`> ⚠ ${escapeMarkdown(page.error)}`, '')
    return
  }
  out.push(
    (['C', 'NC', 'AV', 'NA', 'ERR', 'NT'] as const)
      .map(
        (status) =>
          `${STATUS_SYMBOL[status]} ${page.counts[status]} ${STATUS_TEXT[status].toLowerCase()}`,
      )
      .join(' · '),
    '',
  )
  if (page.asqatasun) {
    out.push(
      `Asqatasun : ${markdownCode(page.asqatasun.file)}, note ${escapeMarkdown(page.asqatasun.score || '—')}`,
      '',
    )
  }
  const shown = page.tests.filter((entry) => entry.final !== 'NT' || entry.asqatasun)
  for (const [theme, criteria] of grouped(shown)) {
    out.push(`#### Thématique ${theme} — ${escapeMarkdown(catalog.themes.get(theme) ?? '')}`, '')
    for (const [criterion, entries] of criteria) {
      out.push(`**${criterionTitle(catalog, criterion)}**`, '')
      for (const entry of entries) testDetail(out, entry, catalog)
      out.push('')
    }
  }
  const untested = page.tests.filter((entry) => entry.final === 'NT' && !entry.asqatasun)
  if (untested.length) {
    out.push(
      `<details><summary>${untested.length} tests non testés</summary>`,
      '',
      untested.map((entry) => entry.test).join(' '),
      '',
      '</details>',
      '',
    )
  }
}

export function renderMarkdown(report: ReportDocument, catalog: Catalog): string {
  const overview = siteOverview(report)
  const { meta } = report
  const out: string[] = []
  out.push(`# Audit RGAA 4.1.2 — niveau AA`, '')
  out.push(
    `| | |`,
    `|---|---|`,
    `| Site | ${markdownCode(meta.baseUrl)} |`,
    `| Date | ${escapeMarkdown(frDate(meta.startedAt))} (durée ${duration(meta.durationMs)}) |`,
    `| Pages | ${report.pages.length} (${meta.pagesSource === 'sitemap' ? 'sitemap' : 'chemins donnés'}) |`,
    `| Asqatasun | ${meta.asqatasunDir ? `${meta.asqatasunReports} export(s) fusionné(s)` : 'non fusionné'} |`,
    `| Décisions enregistrées | ${meta.decisionsCount} |`,
    `| Outil | ${escapeMarkdown(report.tool.name)} ${escapeMarkdown(report.tool.version)} |`,
    '',
  )

  out.push('## Bilan', '')
  if (overview.issues.length > 0) {
    out.push(
      `**✗ Non conforme** — ${plural(overview.issues.length, 'test en échec', 'tests en échec')}.`,
      '',
    )
  } else if (overview.openTests > 0 || overview.states['non-auditee'] > 0) {
    out.push(
      `**? Conformité non démontrée** — aucun échec constaté, mais ${plural(overview.openTests, 'test reste ouvert', 'tests restent ouverts')}.`,
      '',
    )
  } else {
    out.push('**✓ Conforme** — toutes les pages auditées sont à 100 % confirmé.', '')
  }
  out.push(
    `- Taux de conformité du site (critères) : **${rate(overview.globalRate)}**${overview.openTests ? ' (provisoire)' : ''}`,
    `- Taux moyen des pages : ${rate(overview.averageRate)}`,
    `- Critères sur le site : ${overview.criteria.C} conformes, ${overview.criteria.NC} non conformes, ${overview.criteria.NA} non applicables, ${overview.criteria.open} ouverts`,
    `- Pages : ${overview.states.conforme} à 100 % confirmé, ${overview.states['a-valider']} à valider, ${overview.states['non-conforme']} non conformes${overview.states['non-auditee'] ? `, ${overview.states['non-auditee']} non auditées` : ''}`,
    `- Questions de jugement en attente : ${overview.pending}`,
    '',
    '> Une page n’est « à 100 % confirmé » que si aucun test n’est en échec **et** qu’aucun ne reste ouvert (à valider, en erreur ou non testé).',
    '',
  )

  out.push('## Pages', '')
  out.push('| Page | État | Taux critères | Non conformes | À valider | Erreurs | Non testés |')
  out.push('|---|---|---:|---:|---:|---:|---:|')
  for (const page of report.pages) {
    out.push(
      `| ${markdownCode(page.path)} | ${STATE_LABEL[page.state]} | ${rate(page.criteriaScore)}${page.settled ? '' : ' *'} | ${page.counts.NC} | ${page.counts.AV} | ${page.counts.ERR} | ${page.counts.NT} |`,
    )
  }
  out.push('', '\\* provisoire : des tests restent ouverts.', '')

  out.push(`## Non-conformités (${overview.issues.length})`, '')
  if (overview.issues.length === 0) out.push('Aucune non-conformité constatée.', '')
  for (const [theme, criteria] of grouped(overview.issues)) {
    out.push(`### Thématique ${theme} — ${escapeMarkdown(catalog.themes.get(theme) ?? '')}`, '')
    for (const [criterion, issues] of criteria) {
      out.push(`#### ${criterionTitle(catalog, criterion)}`, '')
      for (const issue of issues) {
        out.push(
          `**✗ Test ${issue.test}** — ${plural(issue.pages.length, 'page')} : ${pagesList(issue.pages)}`,
          '',
        )
        out.push(`*${escapeMarkdown(catalog.byTest.get(issue.test)?.title ?? '')}*`, '')
        issue.findings.forEach((finding, index) => {
          failureBlock(out, finding, index + 1)
        })
        if (issue.undetailed)
          out.push('', `${issue.undetailed} autres échecs comptés mais non détaillés.`)
        if (issue.asqatasunOnly.length) {
          out.push(
            '',
            `Non conforme selon Asqatasun seulement sur ${pagesList(issue.asqatasunOnly)}.`,
          )
        }
        out.push('')
      }
    }
  }

  out.push(`## Questions à trancher (${report.pending.length})`, '')
  if (report.pending.length === 0) out.push('Aucune question en attente.', '')
  else
    out.push(
      'Répondre avec `rgaa decide` (mode interactif) ou `rgaa decide <empreinte> <réponse> --reason "…"`.',
      '',
    )
  for (const item of report.pending) {
    out.push(`- **${markdownCode(item.key)}** ${escapeMarkdown(item.question)}`)
    out.push(
      `  <br>Sujet ${markdownCode(item.topic)} · tests ${item.tests.join(', ')} · ${plural(item.pages.length, 'page')} · réponses : ${item.answers.map((answer) => markdownCode(answer)).join(', ')}`,
    )
    for (const [name, value] of Object.entries(item.evidence)) {
      out.push(`  - ${escapeMarkdown(name)} : ${escapeMarkdown(safeLine(value, 500))}`)
    }
  }
  out.push('')

  if (overview.errors.length) {
    out.push(`## Erreurs de l’outil (${overview.errors.length})`, '')
    for (const error of overview.errors) {
      out.push(`- **${error.test}** sur ${pagesList(error.pages)}`)
      for (const message of error.messages) out.push(`  - ${escapeMarkdown(message)}`)
    }
    out.push('')
  }
  if (overview.untested.length) {
    out.push(`## Non testés (${overview.untested.length})`, '')
    out.push(
      'Sans vérification automatique : à auditer à la main.',
      '',
      overview.untested.join(' '),
      '',
    )
  }

  out.push('## Détail par page', '')
  for (const page of report.pages) pageSection(out, page, catalog)
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}
