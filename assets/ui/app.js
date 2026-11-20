// Interface de suivi d'un audit RGAA : données reçues du serveur local, insérées
// uniquement en texte (jamais en HTML). Aucune dépendance, aucune ressource extérieure.

const token = document.querySelector('meta[name="rgaa-jeton"]')?.getAttribute('content') ?? ''
// Préfixe des appels : vide quand l'audit est servi seul, `/audit/<id>` sous l'accueil.
const root = document.querySelector('meta[name="rgaa-racine"]')?.getAttribute('content') ?? ''

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
  conforme: ['Conforme', 'ok'],
  'a-valider': ['À valider', 'doute'],
  'non-conforme': ['Non conforme', 'probleme'],
  'non-auditee': ['Non auditée', 'neutre'],
  'en-cours': ['En cours', 'accent'],
  'en-attente': ['En attente', 'neutre'],
}
/** Verdict du réaudit sur une modification de l'IA : [libellé, ton, gravité (pour trier)]. */
const CHANGE_STATE = {
  regression: ['Régression', 'probleme', 3],
  persiste: ['Persiste', 'doute', 2],
  'a-verifier': ['À vérifier', 'neutre', 1],
  corrigee: ['Corrigée', 'ok', 0],
}
const CHANGE_ORDER = ['corrigee', 'persiste', 'regression', 'a-verifier']
const CHANGE_FIGURES = {
  corrigee: 'Corrigées',
  persiste: 'Persistantes',
  regression: 'Régressions',
  'a-verifier': 'À vérifier',
}

const model = {
  site: '',
  status: 'en-attente',
  running: false,
  mcp: false,
  questions: new Map(),
  issues: new Map(),
  pages: new Map(),
  changes: [],
  decided: 0,
  files: [],
  themes: [],
}
const cards = new Map()
const issueCards = new Map()
let view = 'questions'
let filter = ''
let changeFilter = 'tout'

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

const SVG = 'http://www.w3.org/2000/svg'
/** Petite icône « fichier » (SVG créé par le DOM : pas de HTML injecté). */
function fileIcon() {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'ico')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ['M4 2.5h5l3 3v8H4z', 'M9 2.5v3h3']) {
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

async function api(path, body) {
  const response = await fetch(root + path, {
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
    line.append(href ? h('a', { text: path, attrs: { href, target: '_blank', rel: 'noopener noreferrer' } }) : path)
  })
  if (pages.length > max) line.append(` … (+${pages.length - max})`)
  return line
}

function capture(path, label) {
  if (!path) return h('p', { class: 'sans-capture', text: 'Pas de capture (élément masqué ou hors de la page principale).' })
  const img = h('img', { attrs: { src: `${root}/${path}`, alt: `Capture : ${label}`, loading: 'lazy' } })
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
  img.src = `${root}/${path}`
  img.alt = `Capture agrandie : ${label}`
  dialog.showModal()
}
$('loupe-fermer').addEventListener('click', () => $('loupe').close())
$('loupe').addEventListener('click', (event) => {
  if (event.target === $('loupe')) $('loupe').close()
})

function searchText(parts) {
  return parts.flat().filter(Boolean).join(' ').toLowerCase()
}

function applyFilter(el) {
  el.hidden = Boolean(filter) && !(el.dataset.recherche ?? '').includes(filter)
}

// Sous l'accueil, un lien ramène à la liste des audits.
if (root) $('retour').hidden = false

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

// ─── Ligne dépliable (squelette commun) ─────────────────────────────────────

/**
 * Une ligne de liste : puce d'état, identifiants, titre, informations à droite ;
 * le détail se déplie. `details` natif : clavier et lecteurs d'écran sans effort.
 */
function itemShell({ tone, ids, title, meta }) {
  const li = h('li', { class: 'nouvelle' })
  const details = h('details', { class: 'item' })
  const dot = h('span', { class: `puce ${tone}`, attrs: { 'aria-hidden': 'true' } })
  const idsEl = h('span', { class: 'ids' })
  setIds(idsEl, ids)
  const titleEl = h('span', { class: 'titre', text: title })
  const metaEl = h('span', { class: 'meta' }, meta)
  const body = h('div', { class: 'item-corps grille' })
  details.append(
    h('summary', {}, dot, idsEl, titleEl, metaEl, h('span', { class: 'chevron', attrs: { 'aria-hidden': 'true' } })),
    body,
  )
  li.append(details)
  setTimeout(() => li.classList.remove('nouvelle'), 1300)
  return { li, details, dot, idsEl, titleEl, metaEl, body }
}

function setIds(el, ids) {
  el.replaceChildren(ids[0] ?? '')
  if (ids.length > 1) el.append(h('span', { class: 'plus', text: ` +${ids.length - 1}` }))
  el.title = ids.join(', ')
}

// ─── Questions ──────────────────────────────────────────────────────────────

function groupsOf(question) {
  const groups = { probleme: [], ok: [], neutre: [], doute: [] }
  for (const answer of question.answers) groups[answer.meaning].push(answer)
  return groups
}

function decisionArea(question, card) {
  const groups = groupsOf(question)
  const area = h('div', { class: 'decision col-plein' })
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

  family(groups.probleme, 'C’est un problème', 'probleme', 'p')
  family(groups.ok, 'Ce n’est pas un problème', 'ok', 'o')
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
  family(groups.doute, 'Doute', 'doute', 'd')

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

/**
 * La suite d'une longue question est souvent la légende des réponses : « Réponses : `a` (sens) ; `b` (sens). Consigne ».
 * On la range en liste (code · sens) ; si elle ne ressemble pas à ce format, elle reste un paragraphe.
 */
function answersBlock(rest) {
  const body = rest.match(/^Réponses\s*:\s*(.*)$/su)?.[1]
  if (body) {
    const [list, ...tail] = body.split(/\.\s+(?=[A-ZÀÉÈ])/u)
    const items = list.split(/\s;\s/u).map((item) => item.trim().replace(/\.$/u, '').match(/^`([^`]+)`\s*(?:\((.*)\))?$/su))
    if (items.length > 1 && items.every(Boolean)) {
      return h(
        'details',
        { class: 'plus-de' },
        h('summary', { text: `Réponses possibles (${items.length})` }),
        h('dl', { class: 'reponses' }, ...items.flatMap(([, code, meaning]) => [h('dt', {}, h('code', { text: code })), h('dd', { text: meaning ?? '' })])),
        tail.length ? h('p', { class: 'reponses-note', text: tail.join('. ') }) : null,
      )
    }
  }
  return h('details', { class: 'plus-de' }, h('summary', { text: 'Détail de la question' }), h('p', { text: rest }))
}

/** Exigence réduite à sa question (jusqu'au « ? ») : le texte complet reste en infobulle. */
const brief = (text) => {
  const end = text.indexOf('?')
  return end > 0 && end < 260 ? text.slice(0, end + 1) : text
}

/** Les tests concernés : une ligne par test (numéro · exigence), repliée quand ils sont nombreux. */
function requirementsBlock(tests) {
  const list = h(
    'ul',
    { class: 'exigences' },
    ...tests.map((test) => h('li', {}, h('span', { class: 'pastille', text: test.test }), h('span', { class: 'exigences-texte', text: brief(test.requirement), attrs: { title: test.requirement } }))),
  )
  if (tests.length <= 2) return list
  return h('details', { class: 'plus-de' }, h('summary', { text: `Exigences RGAA (${tests.length} tests)` }), list)
}

function questionCard(question) {
  const [title, rest] = splitQuestion(question.question)
  const state = h('span', { class: 'pastille' })
  const count = h('span')
  const shell = itemShell({
    tone: 'neutre',
    ids: question.tests.map((test) => test.test),
    title,
    meta: [state, count],
  })
  shell.li.classList.add('carte')
  const card = { ...shell, state, count, pages: h('div') }

  const text = h('div', { class: 'col-texte' })
  if (rest) text.append(answersBlock(rest))
  text.append(requirementsBlock(question.tests))
  const evidence = Object.entries(question.evidence ?? {})
  if (evidence.length) {
    text.append(h('dl', { class: 'preuves' }, ...evidence.flatMap(([name, value]) => [h('dt', { text: name }), h('dd', { text: value })])))
  }
  if (question.selector) text.append(h('p', { class: 'selecteur' }, 'Élément : ', h('code', { text: question.selector })))
  if (question.snippet) text.append(h('pre', { class: 'extrait' }, h('code', { text: question.snippet })))
  text.append(card.pages)

  card.capture = capture(question.screenshot, question.selector ?? question.tests.map((test) => test.test).join(', '))
  card.visual = h('div', { class: 'col-visuel' }, card.capture)
  card.body.append(text, card.visual)
  decisionArea(question, card)
  card.body.append(card.decision.area)

  card.li.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLTextAreaElement || event.ctrlKey || event.metaKey || event.altKey) return
    const key = event.key.toLowerCase()
    const button = card.decision.row.querySelector(`[data-touche="${key}"]`)
    if (button) {
      event.preventDefault()
      card.details.open = true
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
  return card
}

function patchQuestion(card, question) {
  const [label, tone] = STATE_LABEL[question.state]
  card.state.className = `pastille ${tone}`
  card.state.textContent = label
  card.dot.className = `puce ${tone}`
  card.count.textContent = `${question.pages.length} page${question.pages.length > 1 ? 's' : ''}`
  card.pages.replaceChildren(pagesLine(question.pages))
  if (question.screenshot && card.capture.classList.contains('sans-capture')) {
    const fresh = capture(question.screenshot, question.selector ?? '')
    card.capture.replaceWith(fresh)
    card.capture = fresh
  }
  patchDecision(card, question)
}

/**
 * Les questions d'une même nature (même sujet, même texte une fois ôté ce qui est propre à
 * l'élément) sont rassemblées, puis réparties par page. Une question vue sur plusieurs pages
 * reste une seule carte : elle est rangée dans « Plusieurs pages ».
 */
const questionGroups = { questions: new Map(), doutes: new Map(), tranchees: new Map() }
const MULTI_PAGES = ''

/** Même sujet de vérification = même groupe, quelles que soient les variantes du texte. */
function questionKind(question) {
  return question.topic
}

function bucketLabel(path) {
  return path === MULTI_PAGES ? 'Plusieurs pages' : path
}

function createQuestionGroup(key) {
  const title = h('span', { class: 'type-titre' })
  const meta = h('span', { class: 'meta' })
  const body = h('div', { class: 'type-corps' })
  const buckets = h('ol', { class: 'pages-blocs' })
  body.append(buckets)
  const details = h('details', { class: 'type-bloc' })
  details.append(h('summary', {}, title, meta, h('span', { class: 'chevron', attrs: { 'aria-hidden': 'true' } })), body)
  return { key, li: h('li', { class: 'type' }, details), details, title, meta, buckets, items: new Map() }
}

function createBucket(path) {
  const meta = h('span', { class: 'meta' })
  const list = h('ol', { class: 'cartes' })
  const details = h('details', { class: 'page-bloc' })
  details.append(
    h('summary', {}, h('span', { class: 'page-chemin', text: bucketLabel(path) }), meta, h('span', { class: 'chevron', attrs: { 'aria-hidden': 'true' } })),
    h('div', { class: 'page-corps' }, list),
  )
  return { path, li: h('li', {}, details), details, meta, list, members: new Set() }
}

function refreshQuestionGroup(group) {
  let count = 0
  const texts = new Set()
  const kinds = new Map()
  const pages = new Set()
  for (const bucket of group.items.values()) {
    bucket.meta.textContent = plural(bucket.members.size, 'question')
    for (const card of bucket.members) {
      const question = model.questions.get(card.questionKey)
      count += 1
      texts.add(question.question)
      const kind = errorKind(question.question)
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
      for (const path of question.pages) pages.add(path)
    }
  }
  // Titre : le texte exact s'il est unique, sinon le modèle le plus fréquent.
  const [common] = Array.from(kinds).sort((a, b) => b[1] - a[1])[0] ?? ['']
  group.title.textContent = splitQuestion(texts.size === 1 ? Array.from(texts)[0] : common)[0]
  const variants = kinds.size > 1 ? ` · ${plural(kinds.size, 'variante')}` : ''
  group.meta.textContent = `${plural(count, 'question')} · ${plural(pages.size, 'page')}${variants}`
}

/** Un groupe ou une page sans carte visible (filtre) disparaît. */
function syncQuestionVisibility(group) {
  let any = false
  for (const bucket of group.items.values()) {
    const visible = Array.from(bucket.members).some((card) => !card.li.hidden)
    bucket.li.hidden = !visible
    any ||= visible
  }
  group.li.hidden = !any
}

function leaveSlot(card) {
  const { group, bucket, view } = card.slot
  bucket.members.delete(card)
  if (bucket.members.size === 0) {
    bucket.li.remove()
    group.items.delete(bucket.path)
  }
  if (group.items.size === 0) {
    group.li.remove()
    questionGroups[view].delete(group.key)
  } else refreshQuestionGroup(group)
  card.slot = null
}

function placeQuestion(card, question) {
  const view = VIEW_OF_STATE[question.state]
  const key = questionKind(question)
  const path = question.pages.length === 1 ? question.pages[0] : MULTI_PAGES
  const known = card.slot
  if (known && known.view === view && known.group.key === key && known.bucket.path === path) {
    refreshQuestionGroup(known.group)
    syncQuestionVisibility(known.group)
    return
  }
  if (known) leaveSlot(card)
  const groups = questionGroups[view]
  let group = groups.get(key)
  if (!group) {
    group = createQuestionGroup(key)
    groups.set(key, group)
    lists[view].append(group.li)
  }
  let bucket = group.items.get(path)
  if (!bucket) {
    bucket = createBucket(path)
    group.items.set(path, bucket)
    // Pages par ordre alphabétique, « Plusieurs pages » en dernier.
    const order = Array.from(group.items.values()).sort((a, b) =>
      a.path === MULTI_PAGES ? 1 : b.path === MULTI_PAGES ? -1 : a.path.localeCompare(b.path, 'fr'),
    )
    for (const item of order) group.buckets.append(item.li)
  }
  bucket.members.add(card)
  bucket.list.append(card.li)
  card.slot = { view, group, bucket }
  refreshQuestionGroup(group)
  syncQuestionVisibility(group)
}

function upsertQuestion(question) {
  model.questions.set(question.key, question)
  let card = cards.get(question.key)
  if (!card) {
    card = questionCard(question)
    card.questionKey = question.key
    card.slot = null
    cards.set(question.key, card)
  }
  patchQuestion(card, question)
  applyFilter(card.li)
  placeQuestion(card, question)
  updateCounts()
}

const countCards = (list) => list.querySelectorAll('li.carte').length

/** Cartes visibles de la vue, dans l'ordre de l'écran. */
function visibleCards(list) {
  return Array.from(list.querySelectorAll('li.carte')).filter((li) => !li.hidden && !li.parentElement.closest('li[hidden]'))
}

function nextCard(li) {
  const all = visibleCards(li.closest('ol.liste') ?? lists.questions)
  const index = all.indexOf(li)
  return index < 0 ? null : (all[index + 1] ?? null)
}

function focusCard(li) {
  const details = li?.querySelector('details')
  for (let parent = li?.closest('details'); parent; parent = parent.parentElement?.closest('details')) parent.open = true
  if (details) details.open = true
  const target = li?.querySelector('.choix button') ?? $(`titre-${view}`)
  if (target) {
    if (!target.hasAttribute('tabindex') && target.tagName === 'H2') target.setAttribute('tabindex', '-1')
    target.focus()
  }
}

// ─── Différences avant / après ──────────────────────────────────────────────

const splitLines = (text) => (text === '' ? [] : text.split('\n'))

/** Différence ligne à ligne (plus longue sous-suite commune). Au-delà d'une taille raisonnable : tout remplacé. */
function lineOps(a, b) {
  const n = a.length
  const m = b.length
  if (n * m > 90_000) return [...a.map((text) => ({ t: 'del', text })), ...b.map((text) => ({ t: 'add', text }))]
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'eq', text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) ops.push({ t: 'del', text: a[i++] })
    else ops.push({ t: 'add', text: b[j++] })
  }
  while (i < n) ops.push({ t: 'del', text: a[i++] })
  while (j < m) ops.push({ t: 'add', text: b[j++] })
  return ops
}

/** Lignes communes, et blocs de lignes retirées / ajoutées. */
function diffRows(before, after) {
  const rows = []
  const ops = lineOps(splitLines(before), splitLines(after))
  for (let i = 0; i < ops.length; ) {
    if (ops[i].t === 'eq') {
      rows.push({ kind: 'eq', text: ops[i].text })
      i++
      continue
    }
    const dels = []
    const adds = []
    while (i < ops.length && ops[i].t !== 'eq') (ops[i].t === 'del' ? dels : adds).push(ops[i++].text)
    rows.push({ kind: 'hunk', dels, adds })
  }
  return rows
}

const tokens = (text) => text.match(/\w+|\s+|[^\w\s]/gu) ?? []

/** Découpe deux lignes en [début commun, partie différente, fin commune], aux frontières de mots. */
function inlineParts(a, b) {
  const ta = tokens(a)
  const tb = tokens(b)
  let start = 0
  while (start < ta.length && start < tb.length && ta[start] === tb[start]) start++
  let end = 0
  while (end < ta.length - start && end < tb.length - start && ta[ta.length - 1 - end] === tb[tb.length - 1 - end]) end++
  const cut = (list) => [list.slice(0, start).join(''), list.slice(start, list.length - end).join(''), list.slice(list.length - end).join('')]
  return { a: cut(ta), b: cut(tb), whole: start === 0 && end === 0 }
}

function codeCell(className, parts) {
  const cell = h('td', { class: `code ${className}` })
  if (typeof parts === 'string') cell.append(parts)
  else {
    cell.append(parts[0])
    if (parts[1]) cell.append(h('mark', { text: parts[1] }))
    cell.append(parts[2])
  }
  return cell
}

function lineCell(number) {
  return h('td', { class: 'ln', text: number === undefined ? '' : String(number), attrs: { 'aria-hidden': 'true' } })
}

/** Deux colonnes, comme l'éditeur de différences d'un IDE : avant à gauche, après à droite. */
function splitDiff(change) {
  const first = change.line
  let a = first ?? 0
  let b = first ?? 0
  const no = (counter) => (first === undefined ? undefined : counter)
  const body = h('tbody')
  for (const row of diffRows(change.before, change.after)) {
    if (row.kind === 'eq') {
      body.append(h('tr', {}, lineCell(no(a++)), codeCell('cote', row.text), lineCell(no(b++)), codeCell('', row.text)))
      continue
    }
    const pairs = Math.max(row.dels.length, row.adds.length)
    for (let k = 0; k < pairs; k++) {
      const old = row.dels[k]
      const next = row.adds[k]
      const inline = old !== undefined && next !== undefined ? inlineParts(old, next) : undefined
      body.append(
        h(
          'tr',
          {},
          lineCell(old === undefined ? undefined : no(a++)),
          old === undefined ? h('td', { class: 'code cote vide-cote' }) : codeCell('cote del', inline && !inline.whole ? inline.a : old),
          lineCell(next === undefined ? undefined : no(b++)),
          next === undefined ? h('td', { class: 'code vide-cote' }) : codeCell('add', inline && !inline.whole ? inline.b : next),
        ),
      )
    }
  }
  return h(
    'table',
    { class: 'diff' },
    h('caption', { class: 'sr-only', text: `Avant et après : ${change.file}` }),
    h('colgroup', {}, h('col', { class: 'c-ln' }), h('col'), h('col', { class: 'c-ln' }), h('col')),
    h('thead', {}, h('tr', {}, h('th', { text: 'Avant', attrs: { colspan: 2 } }), h('th', { text: 'Après', attrs: { colspan: 2 } }))),
    body,
  )
}

/** Une seule colonne : lignes retirées puis ajoutées, comme la vue « en ligne » d'un éditeur. */
function unifiedDiff(change) {
  const first = change.line
  let a = first ?? 0
  let b = first ?? 0
  const no = (counter) => (first === undefined ? undefined : counter)
  const body = h('tbody')
  for (const row of diffRows(change.before, change.after)) {
    if (row.kind === 'eq') {
      body.append(h('tr', {}, lineCell(no(a++)), lineCell(no(b++)), codeCell('', row.text)))
      continue
    }
    const pairs = Math.min(row.dels.length, row.adds.length)
    const inline = Array.from({ length: pairs }, (_, k) => inlineParts(row.dels[k], row.adds[k]))
    row.dels.forEach((text, k) => {
      const parts = inline[k]
      body.append(h('tr', {}, lineCell(no(a++)), lineCell(), codeCell('del', parts && !parts.whole ? parts.a : text)))
    })
    row.adds.forEach((text, k) => {
      const parts = inline[k]
      body.append(h('tr', {}, lineCell(), lineCell(no(b++)), codeCell('add', parts && !parts.whole ? parts.b : text)))
    })
  }
  return h(
    'table',
    { class: 'diff unifie' },
    h('caption', { class: 'sr-only', text: `Modifications de ${change.file}, lignes retirées puis ajoutées` }),
    h('colgroup', {}, h('col', { class: 'c-ln' }), h('col', { class: 'c-ln' }), h('col')),
    body,
  )
}

function readDiffMode() {
  try {
    const saved = localStorage.getItem('rgaa-diff')
    if (saved === 'split' || saved === 'unified') return saved
  } catch {
    // Sans stockage : le choix par défaut ci-dessous.
  }
  return matchMedia('(max-width: 64rem)').matches ? 'unified' : 'split'
}
let diffMode = readDiffMode()

function formatDate(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const today = new Date().toDateString() === date.toDateString()
  return today
    ? date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function verdictChip(state) {
  const [label, tone] = CHANGE_STATE[state]
  return h('span', { class: `pastille ${tone}`, text: label })
}

/** Une modification de l'IA : fichier, auteur, note, différence, verdict du réaudit. */
function changeBlock(change) {
  const state = change.verdict?.state ?? 'a-verifier'
  const head = h(
    'div',
    { class: 'modif-tete' },
    h('span', { class: 'modif-fichier' }, fileIcon(), change.file),
    change.line ? h('span', { class: 'modif-ligne', text: `L${change.line}` }) : null,
    verdictChip(state),
    h('span', { class: 'modif-auteur', text: `${change.by} · ${formatDate(change.at)}` }),
  )
  const block = h('article', { class: 'modif', attrs: { 'aria-label': `Modification de ${change.file}` } }, head)
  if (change.note) block.append(h('p', { class: 'modif-note', text: change.note }))
  block.append(h('div', { class: 'diff-cadre' }, diffMode === 'split' ? splitDiff(change) : unifiedDiff(change)))
  const details = [
    ...(change.verdict?.remaining ?? []).map((item) => `Échec toujours présent : ${item}`),
    ...(change.verdict?.introduced ?? []).map((item) => `Nouvel échec apparu : ${item}`),
  ]
  const where = `Page${change.pages.length > 1 ? 's' : ''} visée${change.pages.length > 1 ? 's' : ''} : ${change.pages.join(', ')}`
  const verdict = h('div', { class: 'modif-verdict' }, where)
  if (!change.verdict) verdict.append(' — en attente d’un réaudit de cette page.')
  else if (details.length === 0) verdict.append(' — le réaudit ne relève plus cet échec.')
  if (details.length) verdict.append(h('ul', {}, ...details.map((item) => h('li', { text: item }))))
  block.append(verdict)
  return block
}

function worstState(changes) {
  return changes.reduce(
    (worst, change) => {
      const state = change.verdict?.state ?? 'a-verifier'
      return CHANGE_STATE[state][2] > CHANGE_STATE[worst][2] ? state : worst
    },
    'corrigee',
  )
}

function changeSearch(change) {
  return searchText([change.test, change.requirement, change.file, change.note, change.pages, change.by, change.before, change.after])
}

// ─── Vue « avant / après » ──────────────────────────────────────────────────

function renderChanges() {
  const counts = { corrigee: 0, persiste: 0, regression: 0, 'a-verifier': 0 }
  for (const change of model.changes) counts[change.verdict?.state ?? 'a-verifier'] += 1

  $('chiffres-modifications').replaceChildren(
    ...CHANGE_ORDER.map((state) =>
      h(
        'button',
        {
          class: `chiffre ${CHANGE_STATE[state][1]}`,
          attrs: { type: 'button', 'aria-pressed': String(changeFilter === state) },
          on: {
            click: () => {
              changeFilter = changeFilter === state ? 'tout' : state
              renderChanges()
            },
          },
        },
        h('span', { class: 'chiffre-nombre', text: counts[state] }),
        h('span', { class: 'chiffre-libelle', text: CHANGE_FIGURES[state] }),
      ),
    ),
  )

  const groups = new Map()
  for (const change of model.changes) {
    if (changeFilter !== 'tout' && (change.verdict?.state ?? 'a-verifier') !== changeFilter) continue
    if (filter && !changeSearch(change).includes(filter)) continue
    const group = groups.get(change.test) ?? []
    group.push(change)
    groups.set(change.test, group)
  }
  const order = Array.from(groups.keys()).sort((x, y) => x.localeCompare(y, 'en', { numeric: true }))
  $('liste-modifications').replaceChildren(
    ...order.map((test) => {
      const changes = groups.get(test).slice().reverse() // plus ancienne d'abord : le fil de la correction
      const all = model.changes.filter((change) => change.test === test)
      const open = model.issues.has(test)
      return h(
        'section',
        { class: 'groupe grille', attrs: { 'aria-label': `Problème ${test}` } },
        h(
          'div',
          { class: 'groupe-tete' },
          h('p', { class: 'groupe-id', text: `Test ${test}` }),
          h('h3', { class: 'groupe-titre', text: changes[0].requirement || `Test ${test}`, attrs: { title: changes[0].requirement || undefined } }),
          h(
            'div',
            { class: 'groupe-chips' },
            verdictChip(worstState(all)),
            h('span', { class: `pastille ${open ? 'probleme' : 'ok'}`, text: open ? 'Toujours dans les non-conformités' : 'Plus en échec' }),
          ),
        ),
        h('div', { class: 'groupe-corps' }, changes.map(changeBlock)),
      )
    }),
  )
  const empty = $('vue-modifications').querySelector('.vide')
  const visible = $('liste-modifications').children.length > 0
  empty.replaceChildren()
  if (model.changes.length === 0) {
    empty.append('Aucune modification consignée. L’IA les enregistre avec l’outil ', h('code', { text: 'consigner_modification' }), ' après chaque correction.')
  } else if (!visible) empty.append('Aucune modification pour ce filtre.')
  empty.hidden = visible
  for (const [test, card] of issueCards) patchIssueChanges(card, test)
  updateCounts()
}

for (const button of document.querySelectorAll('[data-diff]')) {
  button.addEventListener('click', () => {
    diffMode = button.dataset.diff
    try {
      localStorage.setItem('rgaa-diff', diffMode)
    } catch {
      // Préférence non gardée : valable pour cette page.
    }
    for (const other of document.querySelectorAll('[data-diff]')) other.setAttribute('aria-pressed', String(other === button))
    renderChanges()
  })
}
function syncDiffButtons() {
  for (const button of document.querySelectorAll('[data-diff]')) button.setAttribute('aria-pressed', String(button.dataset.diff === diffMode))
}
syncDiffButtons()

let changesSignature = ''
async function loadChanges() {
  try {
    const data = await api('/api/modifications')
    setMcp(data.mcp)
    const signature = JSON.stringify(data.changes)
    if (signature === changesSignature) return
    changesSignature = signature
    model.changes = data.changes
    renderChanges()
  } catch (error) {
    showError(`Modifications indisponibles : ${error.message}`)
  }
}

let changesTimer
function scheduleChanges() {
  clearTimeout(changesTimer)
  changesTimer = setTimeout(loadChanges, 150)
}

function setMcp(connected) {
  model.mcp = connected
  $('groupe-ia').hidden = !connected
  $('mcp').hidden = !connected
  if (!connected && view === 'modifications') showView('bord')
  scheduleDashboard()
}

/** Panneau « Modifications de l'IA » sous une non-conformité, pour le même test. */
function patchIssueChanges(card, test) {
  const related = model.mcp ? model.changes.filter((change) => change.test === test) : []
  card.ia.hidden = related.length === 0
  card.iaChip.replaceChildren()
  if (related.length === 0) {
    card.ia.replaceChildren()
    return
  }
  const [label, tone] = CHANGE_STATE[worstState(related)]
  card.iaChip.append(h('span', { class: `pastille ${tone}`, text: `IA · ${related.length} · ${label}` }))
  card.ia.replaceChildren(
    h('div', { class: 'ia-titre' }, `Modifications de l’IA pour ce problème (${related.length})`),
    h('div', { class: 'ia-liste' }, related.slice().reverse().map(changeBlock)),
  )
}

// ─── Non-conformités ────────────────────────────────────────────────────────

/**
 * Regroupement des occurrences d'un test : par nature d'erreur (message débarrassé de ce qui est
 * propre à l'élément : texte entre « », chiffres), puis par page. Tout est affiché en texte.
 */
function errorKind(message) {
  return message
    .replace(/«[^»]*»/gu, '« … »')
    .replace(/#[\da-f]{3,8}\b/giu, '#…')
    .replace(/\((?:text|email|textarea|password|tel|url|search|number|date|button|select)\)/gu, '(…)')
    .replace(/\d+(?:[.,]\d+)?:1/gu, '…:1')
    .replace(/(?<![\d:])\d+(?:[.,]\d+)?(?!\s?%|\d)/gu, '…')
    .replace(/\s+/gu, ' ')
    .trim()
}

function groupOccurrences(issue) {
  const kinds = new Map()
  for (const occurrence of issue.occurrences) {
    const key = errorKind(occurrence.message)
    let group = kinds.get(key)
    if (!group) kinds.set(key, (group = { key, occurrences: [], messages: new Set() }))
    group.occurrences.push(occurrence)
    group.messages.add(occurrence.message)
  }
  return Array.from(kinds.values())
    .map((group) => {
      const byPage = new Map()
      for (const occurrence of group.occurrences) {
        for (const path of occurrence.pages) {
          if (!byPage.has(path)) byPage.set(path, [])
          byPage.get(path).push(occurrence)
        }
      }
      // Les occurrences identiques partout : le message exact fait office de titre.
      const same = group.messages.size === 1
      return {
        key: group.key,
        title: same ? group.occurrences[0].message : group.key,
        showMessage: !same,
        occurrences: group.occurrences,
        byPage,
        signature: group.occurrences.map((o) => `${o.id}:${o.pages.join('|')}`).join(';'),
      }
    })
    .sort((a, b) => b.occurrences.length - a.occurrences.length || a.key.localeCompare(b.key, 'fr'))
}

const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`

/** Remplit un `<details>` seulement à son ouverture (les listes peuvent être longues). */
function lazyDetails(details, build) {
  let built = false
  const fill = () => {
    if (details.open && !built) {
      built = true
      build()
    }
  }
  details.addEventListener('toggle', fill)
  fill()
  return { rebuild: () => { built = false; fill() } }
}

function elementRow(occurrence, showMessage) {
  const text = h('div', { class: 'element-texte' })
  if (showMessage) text.append(h('p', { class: 'element-message', text: occurrence.message }))
  if (occurrence.selector) text.append(h('p', { class: 'selecteur' }, 'Élément : ', h('code', { text: occurrence.selector })))
  if (occurrence.snippet) {
    text.append(
      h('details', { class: 'code-source' }, h('summary', { text: 'Code de l’élément' }), h('pre', { class: 'extrait' }, h('code', { text: occurrence.snippet }))),
    )
  }
  if (!showMessage && !occurrence.selector && !occurrence.snippet) text.append(h('p', { class: 'selecteur', text: 'Élément non localisé.' }))
  const shared = occurrence.pages.length > 1 ? h('p', { class: 'element-pages', text: `Aussi sur ${plural(occurrence.pages.length - 1, 'autre page')}.` }) : null
  if (shared) text.append(shared)
  return h('li', { class: 'element' }, text, h('div', { class: 'element-visuel' }, capture(occurrence.screenshot, occurrence.selector ?? occurrence.message)))
}

const PAGE_CHUNK = 20

/** Une page dans un type d'erreur : ses éléments fautifs, ouverts à la demande. */
function pageBlock(group, path, occurrences, state) {
  const href = pageUrl(path)
  const details = h('details', { class: 'page-bloc' })
  details.open = state.open.has(path)
  const link = href ? h('a', { class: 'page-lien', text: 'Ouvrir ↗', attrs: { href, target: '_blank', rel: 'noopener noreferrer' } }) : null
  details.append(
    h(
      'summary',
      {},
      h('span', { class: 'page-chemin', text: path }),
      h('span', { class: 'meta', text: plural(occurrences.length, 'élément') }),
      h('span', { class: 'chevron', attrs: { 'aria-hidden': 'true' } }),
    ),
  )
  const body = h('div', { class: 'page-corps' })
  details.append(body)
  lazyDetails(details, () => {
    const list = h('ol', { class: 'elements' })
    occurrences.slice(0, PAGE_CHUNK).forEach((occurrence) => list.append(elementRow(occurrence, group.showMessage)))
    body.replaceChildren(list)
    if (occurrences.length > PAGE_CHUNK) {
      const rest = occurrences.length - PAGE_CHUNK
      const more = h('button', {
        class: 'bouton secondaire',
        text: `Afficher les ${rest} autres`,
        attrs: { type: 'button' },
        on: {
          click: () => {
            occurrences.slice(PAGE_CHUNK).forEach((occurrence) => list.append(elementRow(occurrence, group.showMessage)))
            more.remove()
          },
        },
      })
      body.append(h('div', { class: 'page-suite' }, more))
    }
    if (link) body.append(h('p', { class: 'page-ouvrir' }, link))
  })
  details.addEventListener('toggle', () => {
    if (details.open) state.open.add(path)
    else state.open.delete(path)
  })
  return details
}

/** Un type d'erreur : titre + comptes, puis les pages qui le portent. */
function createKind() {
  const title = h('span', { class: 'type-titre' })
  const meta = h('span', { class: 'meta' })
  const details = h('details', { class: 'type-bloc' })
  const body = h('div', { class: 'type-corps' })
  details.append(h('summary', {}, title, meta, h('span', { class: 'chevron', attrs: { 'aria-hidden': 'true' } })), body)
  const li = h('li', { class: 'type' }, details)
  const kind = { li, details, title, meta, body, signature: '', group: null, open: new Set(), lazy: null }
  kind.lazy = lazyDetails(details, () => renderKindBody(kind))
  return kind
}

function renderKindBody(kind) {
  const { group } = kind
  const pages = Array.from(group.byPage)
  if (pages.length === 1 && kind.open.size === 0) kind.open.add(pages[0][0])
  const list = h('ol', { class: 'pages-blocs' })
  for (const [path, occurrences] of pages) list.append(h('li', {}, pageBlock(group, path, occurrences, kind)))
  kind.body.replaceChildren(list)
}

function updateKind(kind, group) {
  kind.title.textContent = group.title
  kind.meta.textContent = `${plural(group.occurrences.length, 'élément')} · ${plural(group.byPage.size, 'page')}`
  if (kind.signature === group.signature) return
  kind.signature = group.signature
  kind.group = group
  if (kind.details.open) kind.lazy.rebuild()
}

function upsertIssue(issue) {
  model.issues.set(issue.test, issue)
  let card = issueCards.get(issue.test)
  if (!card) {
    const summary = h('span')
    const iaChip = h('span')
    const pageCount = h('span')
    const shell = itemShell({
      tone: 'probleme',
      ids: [issue.test],
      title: issue.requirement,
      meta: [iaChip, summary, pageCount],
    })
    const pages = h('div')
    const types = h('ol', { class: 'types col-plein' })
    const typesTitle = h('h3', { class: 'types-titre col-plein' })
    const ia = h('section', { class: 'ia col-plein', attrs: { hidden: true } })
    const head = h(
      'div',
      { class: 'col-texte col-plein' },
      h(
        'p',
        { class: 'exigence' },
        `Critère ${issue.criterion} : ${issue.criterionTitle} · `,
        h('a', { text: `test ${issue.test} sur le site du RGAA`, attrs: { href: issue.reference, target: '_blank', rel: 'noopener noreferrer' } }),
      ),
      pages,
    )
    shell.body.append(head, ia, typesTitle, types)
    card = { ...shell, summary, iaChip, pageCount, pages, types, typesTitle, ia, kinds: new Map() }
    issueCards.set(issue.test, card)
    lists.constats.append(card.li)
  }
  const groups = groupOccurrences(issue)
  card.summary.textContent = plural(issue.occurrences.length, 'élément')
  card.pageCount.textContent = plural(issue.pages.length, 'page')
  card.typesTitle.textContent = `${plural(groups.length, 'type d’erreur', 'types d’erreur')} · ${plural(issue.occurrences.length, 'élément')}`
  card.pages.replaceChildren(pagesLine(issue.pages))
  const seen = new Set()
  for (const group of groups) {
    seen.add(group.key)
    let kind = card.kinds.get(group.key)
    if (!kind) card.kinds.set(group.key, (kind = createKind()))
    updateKind(kind, group)
    card.types.append(kind.li) // replace dans l'ordre : le plus fréquent en premier
  }
  for (const [key, kind] of card.kinds) {
    if (seen.has(key)) continue
    kind.li.remove()
    card.kinds.delete(key)
  }
  card.li.dataset.recherche = searchText([
    issue.test,
    issue.requirement,
    issue.criterionTitle,
    issue.pages,
    issue.occurrences.map((occurrence) => [occurrence.message, occurrence.selector]),
    model.changes.filter((change) => change.test === issue.test).map(changeSearch),
  ])
  patchIssueChanges(card, issue.test)
  applyFilter(card.li)
  updateCounts()
}

// ─── Pages, compteurs, état ─────────────────────────────────────────────────

function renderPages() {
  const rows = Array.from(model.pages.values()).map((page) => {
    const href = pageUrl(page.path)
    const [label, tone] = PAGE_STATE[page.state] ?? [page.state, 'neutre']
    const again = h('button', {
      class: 'bouton secondaire',
      text: 'Réauditer',
      attrs: { type: 'button', 'aria-label': `Réauditer ${page.path}`, disabled: model.running || !page.state || undefined },
      on: { click: () => rerun({ mode: 'pages', pages: [page.path] }) },
    })
    return h(
      'tr',
      {},
      h('td', {}, href ? h('a', { text: page.path, attrs: { href, target: '_blank', rel: 'noopener noreferrer' } }) : page.path),
      h('td', {}, h('span', { class: `pastille ${tone}`, text: label })),
      h('td', { class: 'nombre', text: page.criteriaScore === null ? '—' : `${String(page.criteriaScore).replace('.', ',')} %${page.settled ? '' : ' *'}` }),
      h('td', { class: 'nombre', text: page.nc }),
      h('td', { class: 'nombre', text: page.av }),
      h('td', {}, again),
    )
  })
  $('liste-pages').replaceChildren(...rows)
}

function updateCounts() {
  const counts = {
    questions: countCards(lists.questions),
    doutes: countCards(lists.doutes),
    constats: lists.constats.children.length,
    tranchees: countCards(lists.tranchees),
    modifications: model.changes.length,
    pages: model.pages.size,
  }
  for (const [name, value] of Object.entries(counts)) {
    const badge = document.querySelector(`[data-compte="${name}"]`)
    if (badge) badge.textContent = String(value)
    if (name === 'modifications') continue
    const empty = $(`vue-${name}`)?.querySelector('.vide')
    if (empty) empty.hidden = value > 0
  }
  if (!model.running) renderStatus()
  scheduleDashboard()
}

let lastProgress = { total: 0, done: 0, current: [], phase: '' }
function renderStatus(progress = lastProgress) {
  lastProgress = progress
  const bar = $('progression')
  bar.max = Math.max(1, progress.total)
  bar.value = progress.done
  $('barre').classList.toggle('repos', !model.running)
  const issues = model.issues.size
  const open = countCards(lists.questions)
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
    ...model.files.map((file) =>
      h('li', {}, h('a', { text: file.label, attrs: { href: `${root}/${file.name}`, target: '_blank', rel: 'noopener' } }), h('code', { text: file.name })),
    ),
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
    model.themes = snapshot.themes ?? []
    $('site').textContent = snapshot.site
    for (const list of Object.values(lists)) list.replaceChildren()
    cards.clear()
    issueCards.clear()
    for (const groups of Object.values(questionGroups)) groups.clear()
    model.questions.clear()
    model.issues.clear()
    model.pages = new Map(snapshot.pages.map((page) => [page.url, page]))
    setMcp(snapshot.mcp)
    for (const issue of snapshot.issues) upsertIssue(issue)
    for (const question of snapshot.questions) upsertQuestion(question)
    changesSignature = ''
    if (snapshot.mcp) await loadChanges()
    for (const card of [...cards.values(), ...issueCards.values()]) card.li.classList.remove('nouvelle')
    // Premier groupe, première page et première question ouverts : on voit tout de suite quoi faire.
    for (const details of lists.questions.querySelectorAll(':scope > li:first-child details:not(.plus-de), :scope > li:first-child details:not(.plus-de) li:first-child details:not(.plus-de)')) details.open = true
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
  const stream = new EventSource(`${root}/api/flux?jeton=${encodeURIComponent(token)}`)
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
      case 'modifications':
        setMcp(event.mcp)
        if (event.mcp) scheduleChanges()
        break
    }
  }
  stream.onerror = () => {
    $('etat').textContent = 'Connexion au serveur perdue, nouvelle tentative…'
    // Serveur relancé : le flux est refusé (jeton périmé) ; on vérifie, la page se recharge si besoin.
    setTimeout(() => api('/api/etat').catch(() => {}), 2000)
  }
}

// ─── Tableau de bord ────────────────────────────────────────────────────────

const number = new Intl.NumberFormat('fr-FR')
const rate = (value) => `${String(Math.round(value * 10) / 10).replace('.', ',')} %`
const MATRIX_ROWS = 8
const TYPE_ROWS = 4
const SHARED_ROWS = 4
const HEAT_LEVELS = 5

/**
 * Mesures tirées de ce que l'interface connaît déjà (non-conformités, pages, questions,
 * modifications de l'IA) : elles suivent donc l'audit en direct, sans requête de plus.
 */
function measure() {
  const known = model.themes.length
    ? model.themes
    : Array.from(new Set(Array.from(model.issues.keys(), (test) => Number(test.split('.')[0]))))
        .sort((a, b) => a - b)
        .map((id) => ({ id, label: `Thématique ${id}`, criteria: 0, tests: 0 }))
  const themes = known.map((theme) => ({ ...theme, elements: 0, failing: new Set(), pages: new Set() }))
  const themeById = new Map(themes.map((theme) => [theme.id, theme]))
  const matrix = new Map()
  const kinds = []
  const shared = []
  const criteria = new Set()
  let elements = 0

  for (const issue of model.issues.values()) {
    const id = Number(issue.test.split('.')[0])
    const theme = themeById.get(id)
    criteria.add(issue.criterion)
    theme?.failing.add(issue.test)
    for (const group of groupOccurrences(issue)) {
      kinds.push({ test: issue.test, title: group.title, elements: group.occurrences.length, pages: group.byPage.size })
    }
    for (const occurrence of issue.occurrences) {
      elements += 1
      if (theme) theme.elements += 1
      for (const path of occurrence.pages) {
        theme?.pages.add(path)
        const row = matrix.get(path) ?? { path, total: 0, themes: new Map() }
        row.total += 1
        row.themes.set(id, (row.themes.get(id) ?? 0) + 1)
        matrix.set(path, row)
      }
      if (occurrence.pages.length > 1) shared.push({ test: issue.test, occurrence, pages: occurrence.pages.length })
    }
  }

  const scores = Array.from(model.pages.values(), (page) => page.criteriaScore).filter((value) => typeof value === 'number')
  const pages = Array.from(model.pages.values())
  return {
    themes,
    matrix: Array.from(matrix.values()).sort((a, b) => b.total - a.total || a.path.localeCompare(b.path, 'fr')),
    kinds: kinds.sort((a, b) => b.elements - a.elements || b.pages - a.pages || a.title.localeCompare(b.title, 'fr')),
    shared: shared.sort((a, b) => b.pages - a.pages || a.test.localeCompare(b.test, 'en', { numeric: true })),
    elements,
    failingTests: model.issues.size,
    failingCriteria: criteria.size,
    totalCriteria: model.themes.reduce((sum, theme) => sum + theme.criteria, 0),
    pages,
    average: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
    provisional: pages.some((page) => typeof page.criteriaScore === 'number' && !page.settled),
  }
}

/** Mène à une non-conformité : la vue s'ouvre sur elle, sans filtre qui la masquerait. */
function openIssue(test) {
  if (filter) {
    $('filtre').value = ''
    filter = ''
    refilter()
    renderChanges()
  }
  showView('constats')
  const card = issueCards.get(test)
  if (!card) return
  card.details.open = true
  card.li.scrollIntoView({ block: 'start' })
  card.details.querySelector('summary')?.focus({ preventScroll: true })
}

/** Mène aux non-conformités d'une page, par le filtre. */
function filterByPage(path) {
  $('filtre').value = path
  filter = path.toLowerCase()
  showView('constats')
  refilter()
  renderChanges()
  announce(`Non-conformités filtrées sur ${path}.`)
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG, tag)
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value))
  return el
}

/** Anneau : un arc par part, proportionnel à `total` ; le centre porte la valeur lisible. */
function ring(parts, { total, rounded = false }, ...center) {
  const radius = 45
  const length = 2 * Math.PI * radius
  const sum = total ?? parts.reduce((acc, part) => acc + part.value, 0)
  const drawn = parts.filter((part) => part.value > 0)
  const gap = drawn.length > 1 ? 3 : 0
  const svg = svgEl('svg', { viewBox: '0 0 110 110', 'aria-hidden': 'true' })
  svg.append(svgEl('circle', { class: 'arc-piste', cx: 55, cy: 55, r: radius }))
  let offset = 0
  for (const part of drawn) {
    if (sum <= 0) break
    const share = (part.value / sum) * length
    const arc = Math.max(0, share - gap)
    svg.append(
      svgEl('circle', {
        class: `arc ${part.tone}${rounded ? ' rond' : ''}`,
        cx: 55,
        cy: 55,
        r: radius,
        'stroke-dasharray': `${arc} ${length - arc}`,
        'stroke-dashoffset': -offset,
      }),
    )
    offset += share
  }
  return h('div', { class: 'anneau' }, svg, h('div', { class: 'anneau-centre' }, ...center))
}

/** Carte : titre, description, puis le contenu. L'identifiant du titre nomme la région. */
function setCard(id, title, description, ...body) {
  $(id).replaceChildren(
    h(
      'header',
      { class: 'panneau-tete' },
      h('h3', { class: 'panneau-titre', text: title, attrs: { id: `${id}-titre` } }),
      description ? h('p', { class: 'panneau-desc', text: description }) : null,
    ),
    ...body,
  )
}

function legendList(rows) {
  return h(
    'ul',
    { class: 'legende-liste' },
    ...rows.map((row) =>
      h(
        'li',
        { class: row.value === 0 ? 'nulle' : '' },
        row.tone ? h('span', { class: `puce ${row.tone}`, attrs: { 'aria-hidden': 'true' } }) : null,
        h('span', { class: 'legende-nom', text: row.label }),
        h('strong', { text: row.text ?? number.format(row.value) }),
      ),
    ),
  )
}

function bar(value, max, tone = '', thin = false) {
  const fill = h('span', { class: `piste-val ${tone}` })
  fill.style.setProperty('--v', max > 0 ? String(Math.min(1, value / max)) : '0')
  return h('span', { class: thin ? 'piste fine' : 'piste', attrs: { 'aria-hidden': 'true' } }, fill)
}

function renderScore(m) {
  const scores = m.pages.map((page) => page.criteriaScore).filter((value) => typeof value === 'number')
  const best = scores.length ? Math.max(...scores) : null
  const worst = scores.length ? Math.min(...scores) : null
  const perfect = scores.filter((value) => value >= 100).length
  const shown = m.average === null ? '—' : String(Math.round(m.average * 10) / 10).replace('.', ',')
  setCard(
    'carte-score',
    'Conformité',
    m.provisional ? 'Provisoire : des tests restent à valider' : 'Moyenne des pages, critères RGAA',
    ring([{ value: m.average ?? 0, tone: 'accent' }], { total: 100, rounded: true }, h('span', { class: 'anneau-nombre' }, shown, m.average === null ? null : h('small', { text: ' %' }))),
    legendList([
      { label: 'Meilleure', text: best === null ? '—' : rate(best), value: 1 },
      { label: 'Plus faible', text: worst === null ? '—' : rate(worst), value: 1 },
      { label: 'À 100 %', value: perfect },
    ]),
  )
}

function renderErrors(m) {
  setCard(
    'carte-erreurs',
    'Éléments fautifs',
    'Comptés une fois, même répétés sur plusieurs pages',
    h('p', { class: 'nombre-grand' }, number.format(m.elements)),
    h(
      'div',
      { class: 'progression' },
      h('p', { class: 'progression-texte' }, h('span', { text: 'Critères' }), h('strong', { text: m.totalCriteria ? `${m.failingCriteria} / ${m.totalCriteria}` : String(m.failingCriteria) })),
      bar(m.failingCriteria, m.totalCriteria),
    ),
    legendList([
      { label: 'Tests non conformes', value: m.failingTests },
      { label: 'Types d’erreur', value: m.kinds.length },
    ]),
  )
}

function donutCard(id, title, description, parts, unit) {
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  setCard(
    id,
    title,
    description,
    ring(parts, {}, h('span', { class: 'anneau-nombre', text: number.format(total) }), h('span', { class: 'anneau-legende', text: unit })),
    legendList(parts.map((part) => ({ ...part, tone: part.tone }))),
  )
}

function renderPageStates(m) {
  const count = (state) => m.pages.filter((page) => page.state === state).length
  donutCard(
    'carte-pages',
    'Pages',
    'Verdict par page',
    [
      { label: PAGE_STATE.conforme[0], tone: 'ok', value: count('conforme') },
      { label: PAGE_STATE['a-valider'][0], tone: 'doute', value: count('a-valider') },
      { label: PAGE_STATE['non-conforme'][0], tone: 'probleme', value: count('non-conforme') },
      { label: 'Autres', tone: 'neutre', value: count('non-auditee') + count('en-cours') + count('en-attente') },
    ],
    'pages',
  )
}

function renderQuestionStates() {
  const questions = Array.from(model.questions.values())
  donutCard(
    'carte-questions',
    'Questions',
    'Jugements demandés par l’outil',
    Object.entries(STATE_LABEL).map(([state, [label, tone]]) => ({ label, tone, value: questions.filter((question) => question.state === state).length })),
    'questions',
  )
}

function renderThemes(m) {
  const failing = m.themes.filter((theme) => theme.elements > 0).sort((a, b) => b.elements - a.elements)
  const max = failing[0]?.elements ?? 0
  const clean = m.themes.length - failing.length
  setCard(
    'carte-themes',
    'Erreurs par thématique',
    'Éléments fautifs dans chaque thématique du RGAA',
    failing.length === 0
      ? h('p', { class: 'panneau-vide', text: 'Aucune erreur détectée pour l’instant.' })
      : h(
          'ul',
          { class: 'barres' },
          ...failing.map((theme) =>
            h('li', { class: 'barre-ligne' }, h('span', { class: 'barre-libelle', text: theme.label, attrs: { title: theme.label } }), bar(theme.elements, max), h('span', { class: 'barre-valeur', text: number.format(theme.elements) })),
          ),
        ),
    clean > 0 && failing.length > 0 ? h('p', { class: 'panneau-note', text: `${plural(clean, 'thématique')} sans erreur sur ${m.themes.length}.` }) : null,
  )
}

function renderKinds(m) {
  const rows = m.kinds.slice(0, TYPE_ROWS)
  setCard(
    'carte-types',
    'Erreurs les plus fréquentes',
    'Nombre d’éléments concernés',
    rows.length === 0
      ? h('p', { class: 'panneau-vide', text: 'Aucune non-conformité pour l’instant.' })
      : h(
          'ol',
          { class: 'rangs' },
          ...rows.map((kind) =>
            h(
              'li',
              { class: 'rang' },
              h(
                'button',
                { class: 'rang-corps', attrs: { type: 'button' }, on: { click: () => openIssue(kind.test) } },
                h('span', { class: 'rang-nombre', text: number.format(kind.elements) }),
                h('span', { class: 'rang-texte' }, h('span', { class: 'rang-message', text: kind.title }), h('span', { class: 'rang-meta' }, h('span', { class: 'pastille', text: kind.test }), h('span', { text: plural(kind.pages, 'page') }))),
              ),
            ),
          ),
        ),
  )
}

/** Intitulé de colonne : le premier mot suffit quand la thématique a un nom long (le survol donne le nom entier). */
const shortLabel = (label) => (label.length > 20 ? label.split(' ')[0] : label)

function renderMatrix(m) {
  const columns = m.themes.filter((theme) => theme.elements > 0)
  const rows = m.matrix.slice(0, MATRIX_ROWS)
  if (rows.length === 0) {
    setCard('carte-matrice', 'Pages les plus touchées', null, h('p', { class: 'panneau-vide', text: 'Aucune page n’a d’élément fautif.' }))
    return
  }
  const max = Math.max(...rows.flatMap((row) => Array.from(row.themes.values())))
  const head = h(
    'tr',
    {},
    h('th', { class: 'matrice-page', text: 'Page', attrs: { scope: 'col' } }),
    ...columns.map((theme) => h('th', { text: shortLabel(theme.label), attrs: { scope: 'col', title: theme.label } })),
    h('th', { class: 'matrice-total', text: 'Total', attrs: { scope: 'col' } }),
  )
  const body = rows.map((row) =>
    h(
      'tr',
      {},
      h('th', { class: 'matrice-page', attrs: { scope: 'row' } }, h('button', { class: 'lien', text: row.path, attrs: { type: 'button', title: `Voir les non-conformités de ${row.path}` }, on: { click: () => filterByPage(row.path) } })),
      ...columns.map((theme) => {
        const n = row.themes.get(theme.id) ?? 0
        const level = n === 0 ? 0 : 1 + Math.min(HEAT_LEVELS - 1, Math.floor((n / max) * HEAT_LEVELS * 0.999))
        const cell = h('td', { class: 'matrice-case', attrs: { 'data-niveau': level, title: `${theme.label} : ${plural(n, 'élément')}` } })
        if (n === 0) cell.append(h('span', { class: 'sr-only', text: '0' }))
        else cell.textContent = String(n)
        return cell
      }),
      h('td', { class: 'matrice-total', text: number.format(row.total) }),
    ),
  )
  setCard(
    'carte-matrice',
    'Pages les plus touchées',
    'Plus la case est foncée, plus la page compte d’éléments fautifs dans la thématique',
    h(
      'div',
      { class: 'matrice-cadre' },
      h('table', { class: 'matrice' }, h('caption', { class: 'sr-only', text: 'Éléments fautifs par page et par thématique du RGAA' }), h('thead', {}, head), h('tbody', {}, ...body)),
    ),
    m.matrix.length > MATRIX_ROWS ? h('p', { class: 'panneau-note', text: `${MATRIX_ROWS} pages sur ${m.matrix.length}.` }) : null,
  )
}

function renderShared(m) {
  // Un seul rang par test (le plus répandu) : plusieurs lignes du même test n'apprendraient rien de plus.
  const byTest = new Map()
  for (const item of m.shared) {
    const known = byTest.get(item.test)
    if (known) known.others += 1
    else byTest.set(item.test, { ...item, others: 0 })
  }
  const rows = Array.from(byTest.values()).slice(0, SHARED_ROWS)
  setCard(
    'carte-gabarit',
    'À corriger une seule fois',
    'Éléments présents sur plusieurs pages, sans doute dans un gabarit commun',
    rows.length === 0
      ? h('p', { class: 'panneau-vide', text: 'Aucun élément fautif n’est partagé entre plusieurs pages.' })
      : h(
          'ol',
          { class: 'rangs' },
          ...rows.map((item) =>
            h(
              'li',
              { class: 'rang' },
              h(
                'button',
                { class: 'rang-corps', attrs: { type: 'button' }, on: { click: () => openIssue(item.test) } },
                h('span', { class: 'rang-nombre', text: number.format(item.pages) }),
                h(
                  'span',
                  { class: 'rang-texte' },
                  h('span', { class: 'rang-message', text: item.occurrence.message }),
                  h('span', { class: 'rang-meta' }, h('span', { class: 'pastille', text: item.test }), h('span', { text: `${item.pages} pages` }), item.others ? h('span', { text: `+ ${plural(item.others, 'autre élément')}` }) : null, item.occurrence.selector ? h('code', { class: 'rang-selecteur', text: item.occurrence.selector }) : null),
                ),
              ),
            ),
          ),
        ),
  )
}

function renderChangesCard() {
  const card = $('carte-ia')
  card.hidden = !(model.mcp && model.changes.length > 0)
  if (card.hidden) return
  const counts = { corrigee: 0, persiste: 0, regression: 0, 'a-verifier': 0 }
  for (const change of model.changes) counts[change.verdict?.state ?? 'a-verifier'] += 1
  const bar = h('div', { class: 'pile', attrs: { 'aria-hidden': 'true' } })
  for (const state of CHANGE_ORDER) {
    if (counts[state] === 0) continue
    const segment = h('span', { class: `pile-segment ${CHANGE_STATE[state][1]}` })
    segment.style.flexGrow = String(counts[state])
    bar.append(segment)
  }
  setCard(
    'carte-ia',
    'Corrections de l’IA',
    'Verdict du dernier réaudit',
    bar,
    h('div', { class: 'pile-chiffres' }, ...CHANGE_ORDER.map((state) => h('p', { class: 'pile-chiffre' }, h('strong', { text: counts[state] }), h('span', { text: CHANGE_FIGURES[state] })))),
  )
}

function renderDashboard() {
  if (view !== 'bord') return
  const m = measure()
  const empty = m.pages.length === 0 && m.elements === 0
  $('bord-vide').hidden = !empty
  $('bord').hidden = empty
  if (empty) return
  renderScore(m)
  renderErrors(m)
  renderPageStates(m)
  renderQuestionStates()
  renderThemes(m)
  renderKinds(m)
  renderMatrix(m)
  renderShared(m)
  renderChangesCard()
}

let dashboardTimer
/** Les événements arrivent en rafale pendant l'audit : on ne redessine qu'une fois la rafale passée. */
function scheduleDashboard() {
  if (view !== 'bord') return
  clearTimeout(dashboardTimer)
  dashboardTimer = setTimeout(renderDashboard, 200)
}

// ─── Navigation entre vues, filtre, raccourcis, relances ────────────────────

function showView(name) {
  view = name
  for (const other of document.querySelectorAll('[data-vue]')) {
    if (other.dataset.vue === name) other.setAttribute('aria-current', 'page')
    else other.removeAttribute('aria-current')
  }
  for (const section of document.querySelectorAll('.vue')) section.hidden = section.id !== `vue-${name}`
  $('filtre').closest('.outils').hidden = name === 'bord' || name === 'pages' || name === 'fichiers'
  if (name === 'bord') renderDashboard()
}
for (const button of document.querySelectorAll('[data-vue]')) {
  button.addEventListener('click', () => showView(button.dataset.vue))
}

/** Applique le filtre aux lignes, puis masque les groupes et pages devenus vides. */
function refilter() {
  for (const li of lists.constats.children) applyFilter(li)
  for (const [name, groups] of Object.entries(questionGroups)) {
    for (const card of cards.values()) if (card.slot?.view === name) applyFilter(card.li)
    for (const group of groups.values()) {
      syncQuestionVisibility(group)
      // Une recherche en cours déplie ce qui correspond.
      if (filter && !group.li.hidden) {
        group.details.open = true
        for (const bucket of group.items.values()) if (!bucket.li.hidden) bucket.details.open = true
      }
    }
  }
}

let filterTimer
$('filtre').addEventListener('input', (event) => {
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    filter = event.target.value.trim().toLowerCase()
    refilter()
    renderChanges()
  }, 120)
})

for (const button of document.querySelectorAll('[data-relancer="tout"]')) {
  button.addEventListener('click', () => rerun({ mode: 'tout' }))
}
$('relancer-decisions').addEventListener('click', () => rerun({ mode: 'decisions' }))

/** « / » filtre ; « J » et « K » passent d'une ligne à l'autre dans la vue courante. */
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement
  if (typing || $('loupe').open) return
  if (event.key === '/') {
    event.preventDefault()
    $('filtre').focus()
    return
  }
  if (event.key !== 'j' && event.key !== 'k') return
  const rows = Array.from(
    document.querySelectorAll(`#vue-${view} details.item > summary, #vue-${view} details.type-bloc > summary, #vue-${view} details.page-bloc > summary`),
  ).filter((row) => !row.closest('li[hidden]') && row.checkVisibility())
  if (rows.length === 0) return
  const current = rows.indexOf(document.activeElement?.closest('summary'))
  const next = event.key === 'j' ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1)
  event.preventDefault()
  rows[next].focus()
})

showView('bord')
connect()
