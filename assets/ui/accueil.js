// Page d'accueil : audits déjà faits et formulaire « Nouvelle analyse ».
// Données reçues du serveur local, insérées uniquement en texte (jamais en HTML).

const token = document.querySelector('meta[name="rgaa-jeton"]')?.getAttribute('content') ?? ''
const $ = (id) => document.getElementById(id)

const number = new Intl.NumberFormat('fr-FR')
const rate = (value) => `${String(Math.round(value * 10) / 10).replace('.', ',')} %`
const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' })
const plural = (n, one, many) => `${number.format(n)} ${n > 1 ? many : one}`

const model = { audits: [], running: null, themes: [], loaded: false }
let filter = ''
let timer

/** Crée un élément : `props.text` en texte, `props.attrs` en attributs, `props.on` en écouteurs. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  if (props.class) el.className = props.class
  if (props.text !== undefined) el.textContent = props.text
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value !== undefined && value !== null && value !== false) el.setAttribute(name, String(value))
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-rgaa-jeton': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json().catch(() => ({}))
  if (response.status === 403 && /jeton/i.test(data.error ?? '')) staleSession()
  if (!response.ok) throw new Error(data.error ?? `Erreur ${response.status}`)
  try {
    sessionStorage.removeItem('rgaa-rechargement')
  } catch {
    // Stockage indisponible : sans conséquence.
  }
  return data
}

/** Le serveur a redémarré (nouveau jeton) : on recharge la page, une seule fois de suite. */
function staleSession() {
  try {
    if (sessionStorage.getItem('rgaa-rechargement')) return
    sessionStorage.setItem('rgaa-rechargement', '1')
  } catch {
    return
  }
  location.reload()
}

function showError(text) {
  const box = $('alerte')
  box.textContent = text
  box.hidden = !text
}

// ─── Thème ──────────────────────────────────────────────────────────────────

function setTheme(mode) {
  try {
    if (mode === 'auto') localStorage.removeItem('rgaa-theme')
    else localStorage.setItem('rgaa-theme', mode)
  } catch {
    // Stockage indisponible : le choix vaut pour cette page seulement.
  }
  if (mode === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = mode
  for (const button of document.querySelectorAll('[data-theme-choix]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoix === mode))
  }
}
for (const button of document.querySelectorAll('[data-theme-choix]')) {
  button.addEventListener('click', () => setTheme(button.dataset.themeChoix))
}
setTheme(document.documentElement.dataset.theme ?? 'auto')

// ─── Liste des audits ───────────────────────────────────────────────────────

const STATUS = {
  'en-cours': ['En cours', 'accent'],
  erreur: ['Interrompu', 'probleme'],
  illisible: ['Illisible', 'probleme'],
}

function pill(text, tone) {
  return h('span', { class: `pastille${tone ? ` ${tone}` : ''}`, text })
}

function auditUrl(audit) {
  return `/audit/${encodeURIComponent(audit.id)}/`
}

function auditRow(audit) {
  const openable = audit.status !== 'illisible'
  const when = audit.startedAt ? dateFormat.format(new Date(audit.startedAt)) : audit.id
  const states = audit.states
  const pills = []
  const state = STATUS[audit.status]
  if (state) pills.push(pill(state[0], state[1]))
  if (audit.status === 'termine' || audit.progress?.done) {
    if (states['non-conforme'] > 0) pills.push(pill(plural(states['non-conforme'], 'page non conforme', 'pages non conformes'), 'probleme'))
    if (states['a-valider'] > 0) pills.push(pill(`${number.format(states['a-valider'])} à valider`, 'doute'))
    if (audit.pending > 0) pills.push(pill(`${number.format(audit.pending)} à trancher`, 'accent'))
    if (states['non-conforme'] + states['a-valider'] + audit.pending === 0 && audit.pages > 0 && audit.status === 'termine') {
      pills.push(pill('Toutes les pages conformes', 'ok'))
    }
  }
  if (audit.partial) pills.push(pill('Partiel'))

  const detail = []
  if (audit.status === 'en-cours' && audit.progress) {
    detail.push(audit.progress.total ? `${audit.progress.done} / ${audit.progress.total} pages analysées` : 'Découverte des pages…')
  } else if (audit.pages > 0) {
    detail.push(plural(audit.pages, 'page', 'pages'))
  }
  if (audit.decisions > 0) detail.push(plural(audit.decisions, 'décision', 'décisions'))
  if (audit.message && audit.status !== 'termine') detail.push(audit.message)

  const body = [
    h('div', {},
      h('p', { class: 'audit-date', text: when }),
      detail.length ? h('p', { class: 'audit-detail', text: detail.join(' · ') }) : null,
      pills.length ? h('div', { class: 'audit-pastilles' }, pills) : null,
    ),
    audit.averageRate !== null && audit.status !== 'illisible'
      ? h('p', { class: 'audit-taux' }, h('strong', { text: rate(audit.averageRate) }), h('span', { text: 'taux moyen des critères' }))
      : null,
  ]
  if (audit.status === 'en-cours' && audit.progress?.total) {
    body.push(h('progress', { attrs: { max: audit.progress.total, value: audit.progress.done, 'aria-label': 'Avancement de l’analyse' } }))
  }
  const row = openable
    ? h('a', { class: 'audit-ligne', attrs: { href: auditUrl(audit) } }, body)
    : h('div', { class: 'audit-ligne inerte' }, body)
  return h('li', {}, row)
}

/** Écart de taux entre le dernier audit complet d'un site et le précédent. */
function evolution(audits) {
  const full = audits.filter((audit) => audit.status === 'termine' && !audit.partial && audit.averageRate !== null)
  if (full.length < 2) return null
  const delta = full[0].averageRate - full[1].averageRate
  return Math.round(delta * 10) / 10
}

function siteCard(host, audits) {
  const latest = audits.find((audit) => audit.startedAt) ?? audits[0]
  const delta = evolution(audits)
  const head = h('div', { class: 'site-tete' },
    h('h3', { class: 'site-nom', text: host }),
    h('p', { class: 'site-meta', text: `${plural(audits.length, 'audit', 'audits')}${latest?.startedAt ? ` · dernier le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(new Date(latest.startedAt))}` : ''}` }),
  )
  if (delta !== null) {
    const tone = delta > 0 ? 'hausse' : delta < 0 ? 'baisse' : ''
    const sign = delta > 0 ? '+' : '−'
    head.append(
      h('p', { class: 'site-evolution' },
        h('span', { text: 'Depuis l’audit précédent' }),
        h('span', { class: `tendance ${tone}`, text: delta === 0 ? 'inchangé' : `${sign}${String(Math.abs(delta)).replace('.', ',')} pt` })),
    )
  }
  return h('article', { class: 'site', attrs: { 'aria-label': host } }, head, h('ol', { class: 'audits-liste' }, audits.map(auditRow)))
}

function matches(audit) {
  if (!filter) return true
  const when = audit.startedAt ? dateFormat.format(new Date(audit.startedAt)) : ''
  return `${audit.host} ${audit.id} ${when}`.toLowerCase().includes(filter)
}

function renderAudits() {
  const shown = model.audits.filter(matches)
  const groups = new Map()
  for (const audit of shown) {
    const list = groups.get(audit.host) ?? []
    list.push(audit)
    groups.set(audit.host, list)
  }
  // Le site de l'audit le plus récent d'abord.
  $('sites').replaceChildren(...Array.from(groups, ([host, audits]) => siteCard(host, audits)))
  $('filtre-zone').hidden = model.audits.length < 4
  $('vide').hidden = !model.loaded || model.audits.length > 0
  $('vide-filtre').hidden = !(model.audits.length > 0 && shown.length === 0)

  const live = model.audits.find((audit) => audit.id === model.running)
  const banner = $('en-cours')
  banner.hidden = !live
  if (live) {
    $('en-cours-titre').textContent = `Analyse en cours : ${live.host}`
    $('en-cours-texte').textContent = live.progress?.total
      ? `${live.progress.done} / ${live.progress.total} pages analysées.`
      : 'Découverte des pages…'
    $('en-cours-lien').setAttribute('href', auditUrl(live))
  }
  $('lancer').disabled = Boolean(live)
  const note = $('note-lancer')
  note.hidden = !live
  note.textContent = live ? 'Une seule analyse à la fois : attendre la fin de celle-ci.' : ''
  refreshDecisionsOption()
  refreshSites()
}

function refreshSites() {
  const list = $('sites-connus')
  const origins = Array.from(new Set(model.audits.map((audit) => audit.site).filter(Boolean).map((site) => {
    try {
      return new URL(site).origin
    } catch {
      return ''
    }
  }).filter(Boolean)))
  if (list.dataset.signature === origins.join('|')) return
  list.dataset.signature = origins.join('|')
  list.replaceChildren(...origins.map((origin) => h('option', { attrs: { value: origin } })))
}

async function load() {
  clearTimeout(timer)
  try {
    const data = await api('/api/audits')
    model.audits = data.audits
    model.running = data.running
    model.loaded = true
    if (!model.themes.length) setupForm(data)
    showError('')
    renderAudits()
  } catch (error) {
    showError(`Liste des audits indisponible : ${error.message}`)
  }
  // Pendant une analyse, l'avancement est relu souvent ; sinon, de temps en temps.
  timer = setTimeout(load, model.running ? 2000 : 15000)
}

$('filtre').addEventListener('input', (event) => {
  filter = event.target.value.trim().toLowerCase()
  renderAudits()
})
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load()
})

// ─── Formulaire ─────────────────────────────────────────────────────────────

function setupForm(data) {
  model.themes = data.themes
  $('champ-themes').replaceChildren(
    ...data.themes.map((theme) =>
      h('label', { class: 'case' },
        h('input', { attrs: { type: 'checkbox', name: 'theme', value: theme.id } }),
        h('span', {}, h('span', { class: 'case-numero', text: `${theme.id}. ` }), theme.label)),
    ),
  )
  $('champ-captures').replaceChildren(
    ...data.defaults.captureModes.map((mode) =>
      h('option', { text: { tout: 'Toutes', doutes: 'Doutes seulement', aucune: 'Aucune' }[mode] ?? mode, attrs: { value: mode, selected: mode === data.defaults.captures } })),
  )
  $('champ-limite').value = String(data.defaults.limit)
}

/** Le dernier audit du site saisi : sert à proposer la reprise de ses décisions. */
function previousFor(value) {
  let host
  try {
    host = new URL(value.trim()).host
  } catch {
    return undefined
  }
  return model.audits.find((audit) => audit.host === host && audit.status === 'termine' && audit.decisions > 0)
}

function refreshDecisionsOption() {
  const previous = previousFor($('champ-url').value)
  $('case-decisions').hidden = !previous
  if (previous) {
    $('libelle-decisions').textContent = `Reprendre les ${plural(previous.decisions, 'décision', 'décisions')} du dernier audit de ce site`
  }
}
$('champ-url').addEventListener('input', refreshDecisionsOption)

function fieldError(id, text) {
  const input = $(`champ-${id}`)
  const box = $(`erreur-${id}`)
  box.textContent = text
  box.hidden = !text
  if (text) input.setAttribute('aria-invalid', 'true')
  else input.removeAttribute('aria-invalid')
}

$('formulaire').addEventListener('submit', async (event) => {
  event.preventDefault()
  fieldError('url', '')
  $('erreur-formulaire').hidden = true
  const url = $('champ-url').value.trim()
  if (!url) {
    fieldError('url', 'Indiquez l’adresse du site à analyser.')
    $('champ-url').focus()
    return
  }
  if (!/^https?:\/\//i.test(url)) {
    fieldError('url', 'L’adresse doit commencer par http:// ou https://.')
    $('champ-url').focus()
    return
  }
  const button = $('lancer')
  button.disabled = true
  button.textContent = 'Lancement…'
  try {
    const result = await api('/api/audits', {
      url,
      pages: $('champ-pages').value,
      themes: Array.from(document.querySelectorAll('input[name="theme"]:checked'), (box) => Number(box.value)),
      limit: $('champ-limite').value || undefined,
      captures: $('champ-captures').value,
      asqatasunDir: $('champ-asqatasun').value,
      storageState: $('champ-session').value,
      cookies: $('champ-cookies').value,
      reuseDecisions: $('case-decisions').hidden ? false : $('champ-decisions').checked,
    })
    location.assign(result.url)
  } catch (error) {
    const box = $('erreur-formulaire')
    box.textContent = error.message
    box.hidden = false
    button.disabled = Boolean(model.running)
    button.textContent = 'Lancer l’analyse'
  }
})

load()
