import { ASQATASUN_LABEL } from '../core/asqatasun.ts'
import { type Catalog, compareIds, criterionOf, themeOf } from '../core/catalog.ts'
import type { Status } from '../core/types.ts'
import { escapeHtml as esc } from '../security/text.ts'
import {
  type Finding,
  OPEN_STATUSES,
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
 * Rapport HTML autonome (`rapport.html`).
 *
 * Sécurité : tout texte est échappé ; la page n'exécute aucun script (CSP
 * `default-src 'none'`, styles en ligne seulement) ; un lien n'est émis que vers
 * une adresse http(s) ; une image n'est émise que si son chemin est celui d'une
 * capture produite par l'outil (`preuves/<sujet>/<empreinte>.png`).
 */

const CSP =
  // `file:` : le rapport est ouvert depuis le disque, et `'self'` n'y couvre pas toujours les captures.
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' file: data:; base-uri 'none'; form-action 'none'"

const STATE_LABEL: Record<PageState, string> = {
  conforme: '100 % confirmé',
  'a-valider': 'à valider',
  'non-conforme': 'non conforme',
  'non-auditee': 'non auditée',
}
const STATE_STATUS: Record<PageState, Status> = {
  conforme: 'C',
  'a-valider': 'AV',
  'non-conforme': 'NC',
  'non-auditee': 'ERR',
}

const SCREENSHOT = /^preuves\/[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}\/[0-9a-f]{12}\.png$/u

function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

function link(url: string, text = url): string {
  const href = safeHref(url)
  return href ? `<a href="${esc(href)}" rel="noopener noreferrer">${esc(text)}</a>` : esc(text)
}

function rate(value: number | null): string {
  return value === null ? '—' : `${frNumber(value)} %`
}

function badge(status: Status, label = STATUS_TEXT[status]): string {
  return `<span class="badge b-${status}"><span aria-hidden="true">${STATUS_SYMBOL[status]}</span> ${esc(label)}</span>`
}

function anchor(path: string): string {
  return `p-${Buffer.from(path).toString('hex').slice(0, 64)}`
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

function criterionHeading(catalog: Catalog, criterion: string, level: string): string {
  const info = catalog.criteria.get(criterion)
  return `<${level} class="criterion">Critère ${esc(criterion)}${info?.level ? ` <span class="level">niveau ${esc(info.level)}</span>` : ''}<span class="ctitle">${esc(info?.title ?? '')}</span></${level}>`
}

function failureItem(
  failure: Finding | { message: string; selector?: string; snippet?: string },
): string {
  const pages =
    'pages' in failure && failure.pages.length
      ? `<p class="where">Pages : ${failure.pages.map((page) => `<code>${esc(page)}</code>`).join(', ')}</p>`
      : ''
  return `<li class="fail"><p>${esc(failure.message)}</p>${
    failure.selector ? `<p class="where">Élément : <code>${esc(failure.selector)}</code></p>` : ''
  }${failure.snippet ? `<pre>${esc(failure.snippet)}</pre>` : ''}${pages}</li>`
}

function testRow(entry: TestEntry, catalog: Catalog): string {
  const parts: string[] = []
  for (const failure of entry.failures) parts.push(failureItem(failure))
  if (entry.failureCount > entry.failures.length) {
    parts.push(
      `<li class="note">${entry.failureCount - entry.failures.length} échecs non détaillés.</li>`,
    )
  }
  for (const pending of entry.pending) {
    parts.push(
      `<li class="pending">À valider <code>${esc(pending.key)}</code> (${esc(pending.topic)}) : ${esc(pending.question)}</li>`,
    )
  }
  for (const note of entry.notes) parts.push(`<li class="note">${esc(note)}</li>`)
  if (entry.asqatasun === 'NC' && entry.tool !== 'NC') {
    parts.push(
      '<li class="fail">Non conforme selon Asqatasun (voir le détail dans son export).</li>',
    )
  }
  if (entry.disagreement && entry.asqatasun) {
    parts.push(
      `<li class="note">Divergence : l’outil dit « ${STATUS_TEXT[entry.tool]} », Asqatasun « ${ASQATASUN_LABEL[entry.asqatasun]} ».</li>`,
    )
  }
  const detail =
    entry.final === 'C'
      ? plural(entry.checked, 'élément contrôlé', 'éléments contrôlés')
      : entry.final === 'NC'
        ? plural(entry.failureCount, 'échec')
        : STATUS_MEANING[entry.final]
  return `<tr class="s-${entry.final}">
<th scope="row">${esc(entry.test)}</th>
<td>${badge(entry.final)}<br><small>${esc(detail)}</small></td>
<td>${entry.asqatasun ? esc(ASQATASUN_LABEL[entry.asqatasun]) : '—'}</td>
<td><p class="title">${esc(catalog.byTest.get(entry.test)?.title ?? '')}</p>${parts.length ? `<ul>${parts.join('')}</ul>` : ''}</td>
</tr>`
}

function testsTable(entries: readonly TestEntry[], catalog: Catalog): string {
  const sections: string[] = []
  for (const [theme, criteria] of grouped(entries)) {
    sections.push(`<h4>Thématique ${theme} — ${esc(catalog.themes.get(theme) ?? '')}</h4>`)
    for (const [criterion, list] of criteria) {
      sections.push(criterionHeading(catalog, criterion, 'h5'))
      sections.push(
        `<div class="scroll"><table><thead><tr><th scope="col">Test</th><th scope="col">Verdict</th><th scope="col">Asqatasun</th><th scope="col">Intitulé et constats</th></tr></thead><tbody>${list
          .map((entry) => testRow(entry, catalog))
          .join('\n')}</tbody></table></div>`,
      )
    }
  }
  return sections.join('\n')
}

function pageDetail(page: PageEntry, catalog: Catalog): string {
  const toHandle = page.tests.filter(
    (entry) =>
      entry.final === 'NC' ||
      (OPEN_STATUSES.includes(entry.final) && entry.final !== 'NT') ||
      entry.disagreement,
  )
  const rest = page.tests.filter((entry) => !toHandle.includes(entry) && entry.final !== 'NT')
  const untested = page.tests.filter((entry) => entry.final === 'NT')
  return `<details id="${anchor(page.path)}"><summary>${esc(page.path)} — ${badge(STATE_STATUS[page.state], STATE_LABEL[page.state])} · critères ${rate(page.criteriaScore)}${page.settled ? '' : ' (provisoire)'} · ${page.counts.NC} non conforme(s), ${page.counts.AV} à valider</summary>
<p>${link(page.url)}${page.asqatasun ? ` · Asqatasun : <code>${esc(page.asqatasun.file)}</code>, note ${esc(page.asqatasun.score || '—')}` : ''}</p>
${page.error ? `<p class="ko">${esc(page.error)}</p>` : ''}
${toHandle.length ? `<h3>À traiter</h3>${testsTable(toHandle, catalog)}` : page.error ? '' : '<p class="ok">Rien à traiter sur cette page.</p>'}
${rest.length ? `<details><summary>Tests conformes et non applicables (${rest.length})</summary>${testsTable(rest, catalog)}</details>` : ''}
${untested.length && !page.error ? `<details><summary>Tests non testés (${untested.length})</summary><p>${untested.map((entry) => esc(entry.test)).join(' ')}</p></details>` : ''}
</details>`
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1f;--muted:#5a5a66;--line:#d9d9e0;--card:#f6f6f9;
--c:#12703a;--nc:#b3261e;--na:#5a5a66;--av:#8a5300;--err:#7a1fa2}
@media (prefers-color-scheme:dark){:root{--bg:#141418;--fg:#ececf1;--muted:#a3a3b2;--line:#34343f;--card:#1d1d24;
--c:#6fd49a;--nc:#ff8a80;--na:#a3a3b2;--av:#f2b866;--err:#d9a4f2}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px 64px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto}h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.3rem;margin:40px 0 12px}
h3{font-size:1.1rem;margin:20px 0 8px}h4{font-size:1rem;margin:22px 0 6px}
.criterion{font-size:.95rem;margin:14px 0 6px;font-weight:600}.criterion .ctitle{display:block;font-weight:400;color:var(--muted)}
.level{font-weight:400;font-size:.8rem;border:1px solid var(--line);border-radius:6px;padding:0 6px;margin-left:6px}
p{margin:0 0 8px}.lead{color:var(--muted)}
.verdict{font-size:1.15rem;font-weight:600;margin:16px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tile b{display:block;font-size:1.5rem}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
thead th{background:var(--bg)}td.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid currentColor;font-size:.82rem;white-space:nowrap}
.b-C{color:var(--c)}.b-NC{color:var(--nc)}.b-NA{color:var(--na)}.b-AV{color:var(--av)}.b-ERR,.b-NT{color:var(--err)}
details{border:1px solid var(--line);border-radius:10px;margin:10px 0;padding:0 14px}summary{cursor:pointer;padding:10px 0;font-weight:600}
.title{color:var(--muted);font-size:.88rem}ul,ol{margin:4px 0 8px;padding-left:22px}
li{margin:4px 0}li.fail{color:var(--nc)}li.pending{color:var(--av)}li.note{color:var(--muted)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--card);padding:6px 8px;border-radius:6px;margin:4px 0;font-size:.8rem;color:var(--fg)}
code{font-size:.85em;word-break:break-word}.where{margin:0;color:var(--fg)}
.issue{border-left:3px solid var(--nc);padding:4px 0 4px 12px;margin:12px 0}
.question{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
.question img{max-width:100%;border:1px solid var(--line);border-radius:6px;margin-top:8px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:8px 0}dt{color:var(--muted)}dd{margin:0;word-break:break-word}
.ok{color:var(--c)}.ko{color:var(--nc)}.wait{color:var(--av)}
`

export function renderHtml(report: ReportDocument, catalog: Catalog): string {
  const overview = siteOverview(report)
  const { meta } = report

  const verdict =
    overview.issues.length > 0
      ? `<p class="verdict ko">✗ Non conforme — ${plural(overview.issues.length, 'test en échec', 'tests en échec')}</p>`
      : overview.openTests > 0 || overview.states['non-auditee'] > 0
        ? `<p class="verdict wait">? Conformité non démontrée — aucun échec constaté, ${plural(overview.openTests, 'test reste ouvert', 'tests restent ouverts')}</p>`
        : '<p class="verdict ok">✓ Conforme — toutes les pages auditées sont à 100 % confirmé</p>'

  const rows = report.pages
    .map(
      (page) => `<tr><th scope="row"><a href="#${anchor(page.path)}">${esc(page.path)}</a></th>
<td>${badge(STATE_STATUS[page.state], STATE_LABEL[page.state])}</td>
<td class="num">${rate(page.criteriaScore)}${page.settled ? '' : ' *'}</td><td class="num">${rate(page.score)}</td>
<td class="num">${page.counts.C}</td><td class="num">${page.counts.NC}</td><td class="num">${page.counts.AV}</td>
<td class="num">${page.counts.NA}</td><td class="num">${page.counts.ERR}</td><td class="num">${page.counts.NT}</td>
<td>${page.asqatasun ? `${esc(page.asqatasun.score)} (<code>${esc(page.asqatasun.file)}</code>)` : '—'}</td></tr>`,
    )
    .join('\n')

  const issues: string[] = []
  for (const [theme, criteria] of grouped(overview.issues)) {
    issues.push(`<h3>Thématique ${theme} — ${esc(catalog.themes.get(theme) ?? '')}</h3>`)
    for (const [criterion, list] of criteria) {
      issues.push(criterionHeading(catalog, criterion, 'h4'))
      for (const issue of list) {
        issues.push(`<div class="issue"><p>${badge('NC', `Test ${issue.test}`)} — ${plural(issue.pages.length, 'page')} : ${issue.pages
          .slice(0, 12)
          .map((page) => `<a href="#${anchor(page)}"><code>${esc(page)}</code></a>`)
          .join(', ')}${issue.pages.length > 12 ? ` (+ ${issue.pages.length - 12})` : ''}</p>
<p class="title">${esc(catalog.byTest.get(issue.test)?.title ?? '')}</p>
<ol>${issue.findings.map((finding) => failureItem(finding)).join('')}</ol>
${issue.undetailed ? `<p class="lead">${issue.undetailed} autres échecs comptés mais non détaillés.</p>` : ''}
${issue.asqatasunOnly.length ? `<p class="ko">Non conforme selon Asqatasun seulement sur ${issue.asqatasunOnly.map((page) => `<code>${esc(page)}</code>`).join(', ')}.</p>` : ''}</div>`)
      }
    }
  }

  const pending = report.pending
    .map((item) => {
      const evidence = Object.entries(item.evidence)
        .map(([name, value]) => `<dt>${esc(name)}</dt><dd>${esc(value)}</dd>`)
        .join('')
      const image =
        item.screenshot && SCREENSHOT.test(item.screenshot)
          ? `<img src="${esc(item.screenshot)}" alt="Capture de l’élément concerné" loading="lazy">`
          : ''
      return `<div class="question"><p><strong>${esc(item.question)}</strong></p>
<p>Empreinte <code>${esc(item.key)}</code> · sujet <code>${esc(item.topic)}</code> · tests ${esc(item.tests.join(', '))} · ${plural(item.pages.length, 'page')}, dont ${link(item.pages[0] ?? '')}</p>
<dl>${evidence}</dl>
${item.selector ? `<p class="where">Élément : <code>${esc(item.selector)}</code></p>` : ''}
${item.snippet ? `<pre>${esc(item.snippet)}</pre>` : ''}
<p>Réponses admises : ${item.answers.map((answer) => `<code>${esc(answer)}</code>`).join(', ')}.
Trancher : <code>rgaa decide ${esc(item.key)} ${esc(item.answers[0] ?? 'pass')} --reason "…"</code></p>
${image}</div>`
    })
    .join('\n')

  const errors = overview.errors
    .map(
      (error) =>
        `<li>${badge('ERR', `Test ${error.test}`)} sur ${error.pages.map((page) => `<code>${esc(page)}</code>`).join(', ')}${error.messages.length ? `<ul>${error.messages.map((message) => `<li class="note">${esc(message)}</li>`).join('')}</ul>` : ''}</li>`,
    )
    .join('')

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Audit RGAA — ${esc(meta.baseUrl)}</title><style>${STYLE}</style></head>
<body><main>
<h1>Audit RGAA 4.1.2, niveau AA</h1>
<p class="lead">${link(meta.baseUrl)} · ${esc(frDate(meta.startedAt))} · durée ${esc(duration(meta.durationMs))} · ${esc(report.tool.name)} ${esc(report.tool.version)}</p>
${verdict}
<div class="tiles">
<div class="tile"><b>${rate(overview.globalRate)}</b>taux du site (critères)${overview.openTests ? ', provisoire' : ''}</div>
<div class="tile"><b>${report.pages.length}</b>pages</div>
<div class="tile"><b class="ok">${overview.states.conforme}</b>à 100 % confirmé</div>
<div class="tile"><b class="wait">${overview.states['a-valider']}</b>sans échec, tests ouverts</div>
<div class="tile"><b class="ko">${overview.states['non-conforme']}</b>avec des non-conformités</div>
<div class="tile"><b>${report.pending.length}</b>questions à trancher</div>
${overview.states['non-auditee'] ? `<div class="tile"><b class="ko">${overview.states['non-auditee']}</b>pages non auditées</div>` : ''}
</div>
<p class="lead">Verdict retenu pour chaque test : le plus sévère entre cet outil et le dernier export Asqatasun de la page.
Une page n’est « à 100 % confirmé » que si aucun test n’est en échec <em>et</em> qu’aucun ne reste ouvert (à valider, en erreur, non testé).
Le taux « critères » est le taux RGAA officiel ; le taux « tests » se calcule comme celui d’Asqatasun.</p>
<h2>Pages</h2>
<div class="scroll"><table><thead><tr><th scope="col">Page</th><th scope="col">État</th><th scope="col">Taux critères</th><th scope="col">Taux tests</th>
<th scope="col">C</th><th scope="col">NC</th><th scope="col">À valider</th><th scope="col">NA</th><th scope="col">Erreur</th><th scope="col">Non testé</th><th scope="col">Asqatasun</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<p class="lead">* taux provisoire : des tests restent ouverts sur la page.</p>
<h2>Non-conformités (${overview.issues.length})</h2>
${issues.join('\n') || '<p class="ok">Aucune non-conformité constatée.</p>'}
<h2>Questions à trancher (${report.pending.length})</h2>
<p class="lead">Ces tests dépendent d’un jugement. Chaque réponse est enregistrée dans le dossier des décisions et vaut pour toutes les pages qui présentent le même contenu.${
    meta.unusedDecisions
      ? ` ${meta.unusedDecisions} décision(s) enregistrée(s) ne correspondent plus à aucun contenu audité.`
      : ''
  }</p>
${pending || '<p class="ok">Aucune question en attente.</p>'}
${errors ? `<h2>Erreurs de l’outil (${overview.errors.length})</h2><ul>${errors}</ul>` : ''}
${overview.untested.length ? `<h2>Non testés (${overview.untested.length})</h2><p class="lead">Sans vérification automatique : à auditer à la main.</p><p>${overview.untested.map((test) => esc(test)).join(' ')}</p>` : ''}
<h2>Détail par page</h2>
${report.pages.map((page) => pageDetail(page, catalog)).join('\n')}
</main></body></html>
`
}
