// Interface de suivi d'un audit RGAA : données reçues du serveur local, insérées
// uniquement en texte (jamais en HTML). Aucune dépendance, aucune ressource extérieure.

const token = document.querySelector('meta[name="rgaa-jeton"]')?.getAttribute('content') ?? ''

const VIEW_OF_STATE = {
  'a-trancher': 'questions',
  'doute-maintenu': 'doutes',
  'probleme-confirme': 'tranchees',
  'tranchee-a-appliquer': 'tranchees',
}
const STATE_LABEL = {
  'a-trancher': ['À trancher', 'neutre'],
  'doute-maintenu': ['Doute maintenu', 'doute'],
  'probleme-confirme': ['Problème confirmé', 'probleme'],
  'tranchee-a-appliquer': ['Tranchée', 'ok'],
}
const PAGE_STATE = {
  conforme: '✓ 100 % confirmé',
  'a-valider': '? À valider',
  'non-conforme': '✗ Non conforme',
  'non-auditee': '⚠ Non auditée',
  'en-cours': '… En cours',
  'en-attente': '· En attente',
}

const model = {
  site: '',
  status: 'en-attente',
  running: false,
  questions: new Map(),
  issues: new Map(),
  pages: new Map(),
  decided: 0,
  files: [],
}
const cards = new Map()
const issueCards = new Map()
let view = 'questions'
let filter = ''

const $ = (id) => document.getElementById(id)
const lists = {
  questions: $('liste-questions'),
  doutes: $('liste-doutes'),
  constats: $('liste-constats'),
  tranchees: $('liste-tranchees'),
}

/** Crée un élément : `props.text` en texte, `props.attrs` en attributs, `props.on` en écouteurs. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  if (props.class) el.className = props.class
  if (props.text !== undefined) el.textContent = props.text
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value !== undefined && value !== null && value !== false) el.setAttribute(name, String(value))
  }
  for (const [name, handler] of Object.entries(props.on ?? {})) el.addEventListener(name, handler)
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
  if (!response.ok) throw new Error(data.error ?? `Erreur ${response.status}`)
  return data
}

function announce(text) {
  const region = $('annonces')
  region.textContent = ''
  setTimeout(() => {
    region.textContent = text
  }, 50)
}

function showError(text) {
  const box = $('alerte')
  box.textContent = text
  box.hidden = !text
}

function pageUrl(path) {
  try {
    return new URL(path, model.site).href
  } catch {
    return undefined
  }
}

function pagesLine(pages, max = 8) {
  const line = h('p', { class: 'pages-liste' }, pages.length > 1 ? `${pages.length} pages : ` : 'Page : ')
  pages.slice(0, max).forEach((path, index) => {
    if (index) line.append(', ')
    const href = pageUrl(path)
    line.append(
      href
        ? h('a', { text: path, attrs: { href, target: '_blank', rel: 'noopener noreferrer' } })
        : path,
    )
  })
  if (pages.length > max) line.append(` … (+${pages.length - max})`)
  return line
}

function capture(path, label) {
  if (!path) return h('p', { class: 'sans-capture', text: 'Pas de capture (élément masqué ou hors de la page principale).' })
  const img = h('img', { attrs: { src: `/${path}`, alt: `Capture : ${label}`, loading: 'lazy' } })
  return h(
    'figure',
    { class: 'capture' },
    h('button', { attrs: { type: 'button', 'aria-label': `Agrandir la capture : ${label}` }, on: { click: () => zoom(path, label) } }, img),
    h('figcaption', { text: 'Zone concernée encadrée en rouge' }),
  )
}

function zoom(path, label) {
  const dialog = $('loupe')
  $('loupe-titre').textContent = label
  const img = $('loupe-image')
  img.src = `/${path}`
  img.alt = `Capture agrandie : ${label}`
  dialog.showModal()
}
$('loupe-fermer').addEventListener('click', () => $('loupe').close())
$('loupe').addEventListener('click', (event) => {
  if (event.target === $('loupe')) $('loupe').close()
})

function searchText(parts) {
  return parts
    .flat()
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function applyFilter(el) {
  el.hidden = Boolean(filter) && !(el.dataset.recherche ?? '').includes(filter)
}

// ─── Questions ──────────────────────────────────────────────────────────────

function groupsOf(question) {
  const groups = { probleme: [], ok: [], neutre: [], doute: [] }
  for (const answer of question.answers) groups[answer.meaning].push(answer)
  return groups
}

function decisionArea(question, card) {
  const groups = groupsOf(question)
  const area = h('div', { class: 'decision' })
  const row = h('div', { class: 'choix', attrs: { role: 'group', 'aria-label': 'Votre réponse' } })
  const sub = h('div', { class: 'sous-choix', attrs: { hidden: true } })
  const comment = h('textarea', { attrs: { id: `commentaire-${question.key}`, rows: 1 } })
  const decided = h('p', { class: 'decision-faite', attrs: { 'aria-live': 'polite' } })

  const send = async (answer, button) => {
    for (const item of area.querySelectorAll('button')) item.disabled = true
    // Carte suivante repérée avant l'envoi : l'événement temps réel peut déplacer celle-ci entre-temps.
    const next = nextCard(card.li)
    try {
      const result = await api('/api/decision', { key: question.key, answer: answer.value, reason: comment.value.trim() || undefined })
      announce(`Réponse « ${answer.label} » enregistrée pour ${question.tests.map((test) => test.test).join(', ')}.`)
      upsertQuestion(result.question)
      if (!card.li.isConnected || card.li.closest('.vue')?.hidden) focusCard(next)
      else button?.focus()
    } catch (error) {
      showError(`Décision non enregistrée : ${error.message}`)
    } finally {
      for (const item of area.querySelectorAll('button')) item.disabled = false
    }
  }

  const family = (answers, label, tone, key) => {
    if (answers.length === 0) return
    const button = h('button', {
      class: tone,
      text: label,
      attrs: { type: 'button', 'data-touche': key, 'data-famille': tone, 'aria-pressed': 'false' },
    })
    if (answers.length === 1) {
      button.addEventListener('click', () => send(answers[0], button))
    } else {
      button.setAttribute('aria-expanded', 'false')
      button.addEventListener('click', () => {
        const open = button.getAttribute('aria-expanded') !== 'true'
        for (const other of row.querySelectorAll('[aria-expanded]')) other.setAttribute('aria-expanded', 'false')
        button.setAttribute('aria-expanded', String(open))
        sub.replaceChildren(
          ...answers.map((answer) =>
            h('button', { class: tone, text: answer.label, attrs: { type: 'button', 'data-reponse': answer.value }, on: { click: (event) => send(answer, event.currentTarget) } }),
          ),
        )
        sub.hidden = !open
        if (open) sub.querySelector('button')?.focus()
      })
    }
    row.append(button)
  }

  family(groups.probleme, '✗ C’est un problème', 'probleme', 'p')
  family(groups.ok, '✓ Ce n’est pas un problème', 'ok', 'o')
  for (const answer of groups.neutre) {
    row.append(
      h('button', {
        class: 'neutre',
        text: answer.label,
        attrs: { type: 'button', 'data-reponse': answer.value, 'aria-pressed': 'false' },
        on: { click: (event) => send(answer, event.currentTarget) },
      }),
    )
  }
  family(groups.doute, '? Doute', 'doute', 'd')

  const field = h(
    'div',
    { class: 'commentaire' },
    h('label', { text: 'Commentaire (facultatif, gardé avec la décision)', attrs: { for: comment.id } }),
    comment,
  )
  area.append(row, sub, field, decided)

  card.decision = { area, row, decided, comment }
}

function patchDecision(card, question) {
  const { row, decided } = card.decision
  const answer = question.decision?.answer
  const meaning = question.state === 'doute-maintenu' ? 'doute' : question.answers.find((item) => item.value === answer)?.meaning
  for (const button of row.querySelectorAll('button')) {
    const pressed =
      button.dataset.reponse !== undefined ? button.dataset.reponse === answer : Boolean(meaning) && button.dataset.famille === meaning
    button.setAttribute('aria-pressed', String(pressed))
  }
  if (question.decision) {
    decided.textContent = `Réponse enregistrée : ${question.decision.label} (${question.decision.by}, ${question.decision.date}) — ${question.decision.reason}`
  } else if (question.doubt) {
    decided.textContent = `Doute de ${question.doubt.by} le ${question.doubt.date} : ${question.doubt.reason}`
  } else {
    decided.textContent = ''
  }
}

/** Titre court (jusqu'au premier « ? ») et suite de la question, pour les questions longues. */
function splitQuestion(text) {
  if (text.length <= 180) return [text, '']
  const end = text.indexOf('?')
  if (end < 0 || end > 240) return [text, '']
  return [text.slice(0, end + 1), text.slice(end + 1).trim()]
}

function questionCard(question) {
  const card = { li: h('li', { class: 'carte nouvelle' }) }
  card.state = h('span', { class: 'pastille' })
  card.pages = h('div')
  const header = h(
    'div',
    { class: 'carte-entete' },
    ...question.tests.map((test) => h('span', { class: 'pastille test', text: test.test })),
    card.state,
  )
  const [title, rest] = splitQuestion(question.question)
  const body = [header, h('h3', { text: title })]
  if (rest) {
    body.push(h('details', { class: 'question-longue' }, h('summary', { text: 'Détail de la question et des réponses' }), h('p', { text: rest })))
  }
  const requirements = question.tests.map((test) => h('p', { class: 'exigence' }, `Test ${test.test} : ${test.requirement}`))
  if (requirements.length > 2) {
    body.push(h('details', { class: 'question-longue' }, h('summary', { text: `Exigences RGAA des ${requirements.length} tests concernés` }), ...requirements))
  } else body.push(...requirements)
  const evidence = Object.entries(question.evidence ?? {})
  if (evidence.length) {
    body.push(h('dl', { class: 'preuves' }, ...evidence.flatMap(([name, value]) => [h('dt', { text: name }), h('dd', { text: value })])))
  }
  if (question.selector) body.push(h('p', { class: 'selecteur' }, 'Élément : ', h('code', { text: question.selector })))
  if (question.snippet) body.push(h('pre', { class: 'extrait' }, h('code', { text: question.snippet })))
  body.push(card.pages)
  card.capture = capture(question.screenshot, question.selector ?? question.tests.map((test) => test.test).join(', '))
  if (question.screenshot) card.li.classList.add('avec-capture')
  card.li.append(card.capture, ...body)
  decisionArea(question, card)
  card.li.append(card.decision.area)
  card.li.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLTextAreaElement || event.ctrlKey || event.metaKey || event.altKey) return
    const key = event.key.toLowerCase()
    const button = card.decision.row.querySelector(`[data-touche="${key}"]`)
    if (button) {
      event.preventDefault()
      button.click()
    }
  })
  card.li.dataset.recherche = searchText([
    question.key,
    question.topic,
    question.question,
    question.tests.map((test) => [test.test, test.requirement]),
    Object.values(question.evidence ?? {}),
    question.selector,
    question.pages,
  ])
  setTimeout(() => card.li.classList.remove('nouvelle'), 700)
  return card
}

function patchQuestion(card, question) {
  const [label, tone] = STATE_LABEL[question.state]
  card.state.className = `pastille ${tone}`
  card.state.textContent = label
  card.pages.replaceChildren(pagesLine(question.pages))
  if (question.screenshot && card.capture.classList.contains('sans-capture')) {
    const fresh = capture(question.screenshot, question.selector ?? '')
    card.capture.replaceWith(fresh)
    card.capture = fresh
    card.li.classList.add('avec-capture')
  }
  patchDecision(card, question)
}

function upsertQuestion(question) {
  model.questions.set(question.key, question)
  let card = cards.get(question.key)
  if (!card) {
    card = questionCard(question)
    cards.set(question.key, card)
  }
  patchQuestion(card, question)
  const target = lists[VIEW_OF_STATE[question.state]]
  if (card.li.parentElement !== target) target.append(card.li)
  applyFilter(card.li)
  updateCounts()
}

function nextCard(li) {
  let next = li.nextElementSibling
  while (next?.hidden) next = next.nextElementSibling
  return next
}

function focusCard(li) {
  const target = li?.querySelector('.choix button') ?? $(`titre-${view}`)
  if (target) {
    if (!target.hasAttribute('tabindex') && target.tagName === 'H2') target.setAttribute('tabindex', '-1')
    target.focus()
  }
}

// ─── Non-conformités ────────────────────────────────────────────────────────

function occurrenceItem(occurrence) {
  const li = h('li', { class: `occurrence${occurrence.screenshot ? ' avec-capture' : ''}` })
  li.append(
    capture(occurrence.screenshot, occurrence.selector ?? occurrence.message),
    h('p', { text: occurrence.message }),
  )
  if (occurrence.selector) li.append(h('p', { class: 'selecteur' }, 'Élément : ', h('code', { text: occurrence.selector })))
  if (occurrence.snippet) li.append(h('pre', { class: 'extrait' }, h('code', { text: occurrence.snippet })))
  const pages = h('div', {}, pagesLine(occurrence.pages))
  li.append(pages)
  return { li, pages }
}

function upsertIssue(issue) {
  model.issues.set(issue.test, issue)
  let card = issueCards.get(issue.test)
  if (!card) {
    const li = h('li', { class: 'carte nouvelle' })
    const pages = h('div')
    const list = h('ol', { class: 'occurrences' })
    li.append(
      h('div', { class: 'carte-entete' }, h('span', { class: 'pastille test', text: issue.test }), h('span', { class: 'pastille probleme', text: 'Non conforme' })),
      h('h3', { text: issue.requirement }),
      h(
        'p',
        { class: 'exigence' },
        `Critère ${issue.criterion} : ${issue.criterionTitle} · `,
        h('a', { text: `test ${issue.test} sur le site du RGAA`, attrs: { href: issue.reference, target: '_blank', rel: 'noopener noreferrer' } }),
      ),
      pages,
      list,
    )
    const more = h('ol', { class: 'occurrences' })
    const moreSummary = h('summary')
    const fold = h('details', { class: 'question-longue', attrs: { hidden: true } }, moreSummary, more)
    li.append(fold)
    card = { li, pages, list, more, fold, moreSummary, items: new Map() }
    issueCards.set(issue.test, card)
    lists.constats.append(li)
    setTimeout(() => li.classList.remove('nouvelle'), 700)
  }
  card.pages.replaceChildren(pagesLine(issue.pages))
  for (const occurrence of issue.occurrences) {
    const known = card.items.get(occurrence.id)
    if (known) known.pages.replaceChildren(pagesLine(occurrence.pages))
    else {
      const item = occurrenceItem(occurrence)
      card.items.set(occurrence.id, item)
      // Au-delà de 5 occurrences, la suite est repliée pour garder la liste parcourable.
      ;(card.items.size > 5 ? card.more : card.list).append(item.li)
    }
  }
  const hiddenCount = card.more.children.length
  card.fold.hidden = hiddenCount === 0
  card.moreSummary.textContent = `${hiddenCount} autre${hiddenCount > 1 ? 's' : ''} occurrence${hiddenCount > 1 ? 's' : ''}`
  card.li.dataset.recherche = searchText([
    issue.test,
    issue.requirement,
    issue.criterionTitle,
    issue.pages,
    issue.occurrences.map((occurrence) => [occurrence.message, occurrence.selector]),
  ])
  applyFilter(card.li)
  updateCounts()
}

// ─── Pages, compteurs, état ─────────────────────────────────────────────────

function renderPages() {
  const rows = Array.from(model.pages.values()).map((page) => {
    const href = pageUrl(page.path)
    const rerun = h('button', {
      class: 'bouton secondaire',
      text: 'Réauditer',
      attrs: { type: 'button', 'aria-label': `Réauditer ${page.path}`, disabled: model.running || !page.state || undefined },
      on: { click: () => rerun({ mode: 'pages', pages: [page.path] }) },
    })
    return h(
      'tr',
      {},
      h('td', {}, href ? h('a', { text: page.path, attrs: { href, target: '_blank', rel: 'noopener noreferrer' } }) : page.path),
      h('td', {}, h('span', { class: `etat-page ${page.state}`, text: PAGE_STATE[page.state] ?? page.state })),
      h('td', { class: 'nombre', text: page.criteriaScore === null ? '—' : `${String(page.criteriaScore).replace('.', ',')} %${page.settled ? '' : ' *'}` }),
      h('td', { class: 'nombre', text: page.nc }),
      h('td', { class: 'nombre', text: page.av }),
      h('td', {}, rerun),
    )
  })
  $('liste-pages').replaceChildren(...rows)
}

function updateCounts() {
  const counts = {
    questions: lists.questions.children.length,
    doutes: lists.doutes.children.length,
    constats: lists.constats.children.length,
    tranchees: lists.tranchees.children.length,
    pages: model.pages.size,
  }
  for (const [name, value] of Object.entries(counts)) {
    const badge = document.querySelector(`[data-compte="${name}"]`)
    if (badge) badge.textContent = String(value)
    const section = $(`vue-${name}`)
    const empty = section?.querySelector('.vide')
    if (empty) empty.hidden = value > 0
  }
  if (!model.running) renderStatus()
}

let lastProgress = { total: 0, done: 0, current: [], phase: '' }
function renderStatus(progress = lastProgress) {
  lastProgress = progress
  const bar = $('progression')
  bar.max = Math.max(1, progress.total)
  bar.value = progress.done
  const issues = model.issues.size
  const open = lists.questions.children.length
  const texts = {
    'en-attente': 'En attente d’une analyse.',
    'en-cours': `Analyse en cours : ${progress.done} / ${progress.total} pages — ${progress.phase}`,
    termine: `Analyse terminée : ${progress.total} pages, ${issues} tests non conformes, ${open} questions à trancher.`,
    erreur: `Analyse interrompue : ${model.message ?? 'erreur inconnue'}`,
  }
  $('etat').textContent = texts[model.status] ?? ''
  $('en-cours').textContent = progress.current.length ? `En cours : ${progress.current.join(', ')}` : ''
  for (const button of document.querySelectorAll('[data-relancer], #relancer-decisions')) button.disabled = model.running
  renderBanner()
}

function renderBanner() {
  const banner = $('bandeau')
  banner.hidden = model.decided === 0 || model.running
  $('bandeau-titre').textContent =
    model.decided === 1 ? '1 question tranchée depuis l’audit' : `${model.decided} questions tranchées depuis l’audit`
}

function renderFiles() {
  const list = $('liste-fichiers')
  list.replaceChildren(
    ...model.files.map((file) => h('li', {}, h('a', { text: file.label, attrs: { href: `/${file.name}`, target: '_blank', rel: 'noopener' } }), ` — ${file.name}`)),
  )
  const empty = $('vue-fichiers').querySelector('.vide')
  empty.hidden = model.files.length > 0
}

async function load() {
  try {
    const snapshot = await api('/api/etat')
    model.site = snapshot.site
    model.status = snapshot.status
    model.running = snapshot.status === 'en-cours'
    model.message = snapshot.message
    model.decided = snapshot.decidedSinceAudit
    model.files = snapshot.files
    $('site').textContent = snapshot.site
    for (const list of Object.values(lists)) list.replaceChildren()
    cards.clear()
    issueCards.clear()
    model.questions.clear()
    model.issues.clear()
    model.pages = new Map(snapshot.pages.map((page) => [page.url, page]))
    for (const issue of snapshot.issues) upsertIssue(issue)
    for (const question of snapshot.questions) upsertQuestion(question)
    for (const card of [...cards.values(), ...issueCards.values()]) card.li.classList.remove('nouvelle')
    renderPages()
    renderFiles()
    updateCounts()
    renderStatus(snapshot.progress)
    showError(snapshot.status === 'erreur' ? `Analyse interrompue : ${snapshot.message ?? ''}` : '')
  } catch (error) {
    showError(`État indisponible : ${error.message}`)
  }
}

let reloadTimer
function scheduleLoad() {
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(load, 150)
}

async function rerun(body) {
  try {
    await api('/api/relancer', body)
    announce('Analyse relancée.')
  } catch (error) {
    showError(`Relance impossible : ${error.message}`)
  }
}

function connect() {
  const stream = new EventSource(`/api/flux?jeton=${encodeURIComponent(token)}`)
  stream.onmessage = (message) => {
    const event = JSON.parse(message.data)
    switch (event.type) {
      case 'recharger':
        scheduleLoad()
        break
      case 'progression':
        model.status = event.status
        model.running = event.status === 'en-cours'
        renderStatus(event.progress)
        break
      case 'constat':
        upsertIssue(event.issue)
        break
      case 'question':
        upsertQuestion(event.question)
        break
      case 'page':
        model.pages.set(event.page.url, event.page)
        renderPages()
        updateCounts()
        break
      case 'decision':
        model.decided = event.decidedSinceAudit
        upsertQuestion(event.question)
        renderBanner()
        break
    }
  }
  stream.onerror = () => {
    $('etat').textContent = 'Connexion au serveur perdue, nouvelle tentative…'
  }
}

// ─── Navigation entre vues, filtre, relances ────────────────────────────────

for (const button of document.querySelectorAll('[data-vue]')) {
  button.addEventListener('click', () => {
    view = button.dataset.vue
    for (const other of document.querySelectorAll('[data-vue]')) other.setAttribute('aria-pressed', String(other === button))
    for (const section of document.querySelectorAll('.vue')) section.hidden = section.id !== `vue-${view}`
  })
}

let filterTimer
$('filtre').addEventListener('input', (event) => {
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    filter = event.target.value.trim().toLowerCase()
    for (const list of Object.values(lists)) for (const li of list.children) applyFilter(li)
  }, 120)
})

for (const button of document.querySelectorAll('[data-relancer="tout"]')) {
  button.addEventListener('click', () => rerun({ mode: 'tout' }))
}
$('relancer-decisions').addEventListener('click', () => rerun({ mode: 'decisions' }))

connect()
