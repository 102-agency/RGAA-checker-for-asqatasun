import type { Page } from 'playwright'
import { type Check, defineCheck, type ElementRef } from '../core/types.ts'

/**
 * Thématique 7 — Scripts.
 *
 * Un audit automatique ne lit pas les scripts : il observe ce qu'ils ont produit dans la page.
 * - 7.1 : le moteur de règles ARIA d'axe-core (rôles, états, propriétés, noms des composants) ;
 *   la restitution par une vraie technologie d'assistance reste un jugement.
 * - 7.3.1 : éléments qui écoutent un événement (relevé des `addEventListener`, attributs `on…`,
 *   curseur « main ») mais que le clavier n'atteint pas.
 * - 7.3.2 : focus retiré par un script, mesuré en donnant le focus à chaque contrôle.
 * - 7.2, 7.4, 7.5 : repères dans le code et la page, puis jugement.
 *
 * Limite assumée : une interface qui délègue tous ses clics à un seul écouteur (React, Vue)
 * ne trahit pas ses éléments « cliquables » par leurs écouteurs ; le curseur « main » sur un
 * élément non interactif sert alors d'indice et la décision revient à un jugement.
 */

interface Violation {
  rule: string
  help: string
  ref: ElementRef
}

const ARIA_RULES = {
  // Nom, rôle, valeur, états : l'API d'accessibilité reçoit-elle ce qu'il faut ?
  '7.1.1': [
    'aria-valid-attr',
    'aria-valid-attr-value',
    'aria-roles',
    'aria-required-attr',
    'aria-required-children',
    'aria-required-parent',
    'aria-allowed-attr',
    'aria-prohibited-attr',
    'aria-conditional-attr',
    'aria-deprecated-role',
  ],
  // Restitution : l'arbre d'accessibilité est-il cohérent ?
  '7.1.2': [
    'nested-interactive',
    'aria-hidden-focus',
    'aria-hidden-body',
    'presentation-role-conflict',
  ],
  // Noms pertinents.
  '7.1.3': [
    'aria-command-name',
    'aria-input-field-name',
    'aria-toggle-field-name',
    'aria-dialog-name',
    'aria-meter-name',
    'aria-progressbar-name',
    'aria-tooltip-name',
    'aria-treeitem-name',
  ],
} as const

type AriaTest = keyof typeof ARIA_RULES

/** Exécute les règles axe-core demandées sur la page (lecture seule). */
async function runAxe(page: Page, rules: readonly string[]): Promise<Violation[]> {
  return page.evaluate(async (wanted) => {
    const axe = window.axe
    if (!axe) throw new Error('axe-core n’est pas injecté dans la page')
    const known = new Set(axe.getRules().map((rule: { ruleId: string }) => rule.ruleId))
    const result = await axe.run(document, {
      runOnly: { type: 'rule', values: wanted.filter((id) => known.has(id)) },
      resultTypes: ['violations'],
    })
    window.__rgaa.resetTree()
    const out: { rule: string; help: string; ref: { selector: string; snippet: string } }[] = []
    for (const violation of result.violations) {
      for (const node of violation.nodes.slice(0, 20)) {
        out.push({
          rule: violation.id,
          help: violation.help,
          ref: { selector: node.target.join(' '), snippet: String(node.html).slice(0, 220) },
        })
      }
    }
    return out
  }, rules)
}

// ─── 7.1 : composants d'interface compatibles avec les technologies d'assistance ──

const WIDGET_ROLES =
  '[role="button"], [role="tab"], [role="tablist"], [role="menu"], [role="menuitem"], [role="dialog"], [role="alertdialog"], [role="combobox"], [role="listbox"], [role="option"], [role="slider"], [role="switch"], [role="checkbox"], [role="radio"], [role="tree"], [role="treeitem"], [role="grid"], [role="tooltip"], [role="progressbar"], [role="spinbutton"], [role="searchbox"], [role="textbox"], [aria-expanded], [aria-haspopup], [aria-pressed], [aria-checked], [aria-selected], [aria-controls]'

const components = defineCheck(['7.1.1', '7.1.2', '7.1.3'], async (ctx, t) => {
  const widgets = await ctx.page.evaluate((selector) => {
    const { isHiddenFromAT } = window.__rgaa
    const roles = new Set<string>()
    let count = 0
    for (const el of document.querySelectorAll(selector)) {
      if (isHiddenFromAT(el)) continue
      count += 1
      roles.add(
        el.getAttribute('role') ??
          [...el.getAttributeNames()].find((n) => n.startsWith('aria-')) ??
          '',
      )
    }
    return { count, roles: [...roles].filter(Boolean).sort() }
  }, WIDGET_ROLES)
  if (widgets.count === 0) return // aucun composant scripté repérable : tests non applicables.

  for (const test of Object.keys(ARIA_RULES) as AriaTest[]) {
    const o = t(test)
    o.applicable(widgets.count)
    for (const violation of await runAxe(ctx.page, ARIA_RULES[test])) {
      o.fail(`${violation.help} (règle axe « ${violation.rule} »).`, violation.ref)
    }
  }

  // 7.1.3 — le nom accessible contient l'intitulé visible, pour les composants à rôle ARIA.
  const mismatch = await ctx.page.evaluate(() => {
    const { ref, accName, isHiddenFromAT, isVisible, readableText } = window.__rgaa
    const compact = (text: string) =>
      text
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/\p{Co}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '')
    const found: { name: string; label: string; ref: { selector: string; snippet: string } }[] = []
    const NATIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary'])
    for (const el of document.querySelectorAll(
      '[role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [role="link"]',
    )) {
      // Les éléments natifs sont déjà contrôlés par 6.1.5 et par la thématique 11.
      if (NATIVE.has(el.localName) || isHiddenFromAT(el) || !isVisible(el)) continue
      const label = readableText(el)
      const wanted = compact(label)
      const name = accName(el)
      if (wanted === '' || name === '') continue
      if (!compact(name).includes(wanted)) found.push({ name, label, ref: ref(el) })
    }
    return found
  })
  for (const item of mismatch) {
    t('7.1.3').fail(
      `Le nom accessible « ${item.name} » ne contient pas l’intitulé visible « ${item.label} ».`,
      item.ref,
    )
  }

  // 7.1.2 — la restitution réelle se vérifie avec une technologie d'assistance.
  if (widgets.roles.length > 0) {
    await t('7.1.2').judgePass({
      topic: 'widget.restitution',
      question: `La page contient des composants scriptés (${widgets.roles.join(', ')}). Testés avec un lecteur d’écran, sont-ils correctement restitués (nom, rôle, état annoncés et mis à jour) ?`,
      evidence: { composants: widgets.roles.join(', ') },
    })
  }
  t('7.1.2').note(
    'Les règles automatiques vérifient la cohérence de l’arbre d’accessibilité, pas ce qu’un lecteur d’écran annonce réellement.',
  )
})

// ─── 7.2 : alternatives aux scripts ─────────────────────────────────────────

const alternatives = defineCheck(['7.2.1', '7.2.2'], async (ctx, t) => {
  const noscript = await ctx.page.evaluate(() => {
    const { norm } = window.__rgaa
    return Array.from(document.querySelectorAll('noscript'))
      .filter((el) => !el.closest('head'))
      .map((el) => norm(el.textContent).slice(0, 200))
      .filter((text) => text.length > 0)
  })
  if (noscript.length > 0) {
    // Page chargée sans JavaScript : la comparer au rendu normal éclaire le jugement.
    const bare = await ctx.fresh({ javaScriptEnabled: false })
    // Sans JavaScript, `window.__rgaa` n'est pas injecté : on compte le texte à la main
    // (le contenu de <noscript> y est du balisage ordinaire).
    const bareChars = await bare.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let total = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.parentElement?.closest('script, style, template')) {
          total += (node.nodeValue ?? '').trim().length
        }
      }
      return total
    })
    const fullChars = await ctx.page.evaluate(() => window.__rgaa.visibleText(document.body).length)
    await t('7.2.1').judgePass({
      topic: 'noscript.alternative',
      question:
        'Cette page propose une alternative <noscript> (ou un rendu sans JavaScript). Donne-t-elle accès à des contenus et fonctionnalités similaires ?',
      evidence: {
        noscript: noscript[0] ?? '',
        texteSansJs: String(bareChars),
        texteAvecJs: String(fullChars),
      },
    })
  }

  // 7.2.2 — éléments non textuels mis à jour par un script : l'alternative suit-elle ?
  const page = await ctx.fresh()
  const changed = await page.evaluate(async () => {
    const { ref, norm } = window.__rgaa
    const seen = new Map<
      Element,
      { alt: string; src: string; ref: { selector: string; snippet: string } }
    >()
    const watched = new Map<Element, { alt: string; src: string }>()
    for (const img of document.querySelectorAll('img')) {
      watched.set(img, { alt: img.getAttribute('alt') ?? '', src: img.getAttribute('src') ?? '' })
    }
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target = mutation.target
        if (!(target instanceof HTMLImageElement) || !watched.has(target)) continue
        const before = watched.get(target)
        if (!before) continue
        if (mutation.attributeName === 'src' || mutation.attributeName === 'srcset') {
          if (norm(target.getAttribute('alt')) === norm(before.alt)) {
            seen.set(target, {
              alt: before.alt,
              src: target.getAttribute('src') ?? '',
              ref: ref(target),
            })
          }
        }
      }
    })
    observer.observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ['src', 'srcset', 'alt'],
    })
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    observer.disconnect()
    return Array.from(seen.values())
  })
  for (const image of changed.slice(0, 5)) {
    await t('7.2.2').judgePass({
      topic: 'script.alt',
      question:
        'Un script a changé l’image sans modifier son texte alternatif. L’alternative reste-t-elle pertinente pour la nouvelle image ?',
      evidence: { alt: image.alt, source: image.src.split('/').pop()?.slice(0, 60) ?? '' },
      ref: image.ref,
    })
  }
  t('7.2.2').note(
    'Observation de 3 secondes après le chargement : une image remplacée plus tard ou après une action n’est pas repérée.',
  )
})

// ─── 7.3 : clavier et pointeur ──────────────────────────────────────────────

interface Clickable {
  ref: ElementRef
  name: string
  evidence: string[]
  /** Un écouteur confirmé (attribut, propriété ou addEventListener), pas seulement le curseur « main ». */
  confirmed: boolean
}

const MAX_QUESTIONS = 10

const handlers = defineCheck(['7.3.1'], async (ctx, t) => {
  const candidates: Clickable[] = await ctx.page.evaluate(() => {
    const { ref, norm, isHiddenFromAT, isVisible, listenersOf, accName } = window.__rgaa
    const INTERACTIVE =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="radio"], [role="option"], [role="combobox"], [role="slider"]'
    const FOCUSABLE =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"]'
    const POINTER = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart']
    const found: {
      ref: { selector: string; snippet: string }
      name: string
      evidence: string[]
      confirmed: boolean
    }[] = []
    for (const el of document.body.querySelectorAll('*')) {
      if (found.length >= 40) break
      if (el.localName === 'body' || el.localName === 'html') continue
      // Test peu coûteux d'abord : la plupart des éléments n'écoutent rien et n'ont pas le curseur « main ».
      const types = listenersOf(el).filter((type) => POINTER.includes(type))
      const hand = getComputedStyle(el).cursor === 'pointer'
      if (types.length === 0 && !hand) continue
      if (
        el.matches(INTERACTIVE) ||
        el.closest(INTERACTIVE) ||
        isHiddenFromAT(el) ||
        !isVisible(el)
      )
        continue
      // Le clavier atteint l'élément, ou un contrôle qu'il contient ou qui l'entoure agit à sa place.
      if (el.matches(FOCUSABLE) || el.querySelector(FOCUSABLE) || el.closest(FOCUSABLE)) continue
      // `cursor: pointer` est hérité : seul l'élément le plus profond qui porte du contenu compte.
      if (
        types.length === 0 &&
        el.parentElement &&
        getComputedStyle(el.parentElement).cursor === 'pointer'
      )
        continue
      if (!el.textContent?.trim() && !el.querySelector('img, svg')) continue
      found.push({
        ref: ref(el),
        name: norm(accName(el) || el.textContent).slice(0, 60),
        evidence: types.length > 0 ? types : ['curseur « main » sans écouteur repéré'],
        // Seul `click` est une action certaine : mousedown, pointerdown ou touchstart servent aussi à des effets.
        confirmed: types.includes('click'),
      })
    }
    return found
  })

  const o = t('7.3.1')
  let asked = 0
  for (const item of candidates) {
    o.applicable()
    if (item.confirmed) {
      o.fail(
        `Élément qui réagit à ${item.evidence.join(', ')} mais que le clavier n’atteint pas (ni tabindex, ni élément interactif) : « ${item.name} ».`,
        item.ref,
      )
      continue
    }
    if (asked >= MAX_QUESTIONS) continue
    asked += 1
    await o.judgePass({
      topic: 'handler.keyboard',
      question: `« ${item.name} » a le curseur « main » mais n’est pas atteignable au clavier. Réagit-il à un clic ? Si oui, une action équivalente existe-t-elle au clavier ?`,
      evidence: { page: ctx.path, element: item.name },
      ref: item.ref,
    })
  }
  if (candidates.length > 0 && asked >= MAX_QUESTIONS) {
    o.note(
      `Plafond de ${MAX_QUESTIONS} questions par page atteint : d’autres éléments « main » ne sont pas soumis.`,
    )
  }
  o.note(
    'Les écouteurs délégués à un parent (React, Vue) ne sont pas visibles : seul le curseur « main » les trahit.',
  )
})

// ─── 7.3.2 : le focus n'est pas retiré ──────────────────────────────────────

const focusLoss = defineCheck(['7.3.2'], async (ctx, t) => {
  const page = await ctx.fresh({ reducedMotion: 'reduce' })
  const lost = await page.evaluate(async () => {
    const { ref, tabbables, isVisible, accName, norm } = window.__rgaa
    const out: { ref: { selector: string; snippet: string }; name: string }[] = []
    const items = tabbables()
      .filter((el) => isVisible(el) && !(el as HTMLInputElement).disabled)
      .slice(0, 150)
    for (const el of items) {
      el.focus({ preventScroll: true })
      await new Promise((resolve) => setTimeout(resolve, 25))
      if (document.activeElement !== el && !el.contains(document.activeElement)) {
        out.push({ ref: ref(el), name: norm(accName(el) || el.textContent).slice(0, 60) })
      }
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
    return { out, tested: items.length }
  })
  const o = t('7.3.2')
  if (lost.tested === 0) return
  o.applicable(lost.tested)
  for (const item of lost.out) {
    o.fail(
      `Le focus est retiré de « ${item.name || 'cet élément'} » dès qu’il le reçoit (script qui appelle blur() ou déplace le focus).`,
      item.ref,
    )
  }
})

// ─── 7.4 : changements de contexte ──────────────────────────────────────────

const contextChanges = defineCheck(['7.4.1'], async (ctx, t) => {
  const found = await ctx.page.evaluate(() => {
    const { ref, norm, isHiddenFromAT } = window.__rgaa
    const CHANGE =
      /(submit\s*\(|location(\.href|\.assign|\.replace)?\s*=|window\.open|document\.location)/i
    const out: {
      handler: string
      excerpt: string
      ref: { selector: string; snippet: string }
      name: string
    }[] = []
    for (const el of document.querySelectorAll(
      'select[onchange], input[onchange], [onfocus], [onblur], [onchange]',
    )) {
      if (isHiddenFromAT(el)) continue
      for (const handler of ['onchange', 'onfocus', 'onblur']) {
        const code = el.getAttribute(handler)
        if (code && CHANGE.test(code)) {
          out.push({
            handler,
            excerpt: norm(code).slice(0, 100),
            ref: ref(el),
            name: norm(el.getAttribute('aria-label') ?? el.getAttribute('name') ?? el.localName),
          })
        }
      }
    }
    return out
  })
  for (const item of found.slice(0, MAX_QUESTIONS)) {
    t('7.4.1').applicable()
    await t('7.4.1').judgePass({
      topic: 'context.change',
      question: `Le champ « ${item.name} » déclenche un changement de contexte (envoi, navigation) sur l’événement ${item.handler}. L’utilisateur en est-il averti par un texte avant qu’il se produise ?`,
      evidence: { evenement: item.handler, code: item.excerpt },
      ref: item.ref,
    })
  }
  t('7.4.1').note(
    'Seuls les changements de contexte déclarés par attribut (onchange, onfocus…) sont repérés ; ceux d’un fichier script externe ne le sont pas.',
  )
})

// ─── 7.5 : messages de statut ───────────────────────────────────────────────

const STATUS_NEEDED: Record<
  string,
  { test: '7.5.1' | '7.5.2' | '7.5.3'; roles: string[]; label: string }
> = {
  succes: { test: '7.5.1', roles: ['status'], label: 'de réussite' },
  erreur: { test: '7.5.2', roles: ['alert'], label: 'd’erreur ou de suggestion' },
  progression: { test: '7.5.3', roles: ['log', 'progressbar', 'status'], label: 'de progression' },
}

const statusMessages = defineCheck(['7.5.1', '7.5.2', '7.5.3'], async (ctx, t) => {
  const items = await ctx.page.evaluate(() => {
    const { ref, norm, isVisible, isHiddenFromAT } = window.__rgaa
    const KIND: [string, RegExp][] = [
      ['erreur', /(^|[\s_-])(error|erreur|invalid|danger|warning|alert|avertissement)($|[\s_-])/i],
      [
        'succes',
        /(^|[\s_-])(success|succes|valid|confirm\w*|toast|snackbar|notice|notification|flash)($|[\s_-])/i,
      ],
      ['progression', /(^|[\s_-])(progress|loading|spinner|chargement)($|[\s_-])/i],
    ]
    const out: {
      kind: string
      text: string
      role: string
      live: string
      ref: { selector: string; snippet: string }
    }[] = []
    const seen: Element[] = []
    for (const el of document.body.querySelectorAll(
      '[class], [id], [role], [aria-live], output, progress',
    )) {
      if (out.length >= 30) break
      const role = el.getAttribute('role') ?? ''
      const live = el.getAttribute('aria-live') ?? (el.localName === 'output' ? 'polite' : '')
      const text = norm(el.textContent)
      const token = `${el.id} ${typeof el.className === 'string' ? el.className : ''}`
      let kind = ''
      if (['alert', 'status', 'log', 'progressbar'].includes(role))
        kind = role === 'alert' ? 'erreur' : role === 'status' ? 'succes' : 'progression'
      else if (el.localName === 'progress') kind = 'progression'
      else if (text.length >= 4 && text.length <= 300)
        kind = KIND.find(([, pattern]) => pattern.test(token))?.[0] ?? ''
      if (!kind || isHiddenFromAT(el) || !isVisible(el)) continue
      // Un descendant d'une région déjà retenue est le même message.
      if (seen.some((other) => other.contains(el))) continue
      seen.push(el)
      out.push({ kind, text: text.slice(0, 120), role, live, ref: ref(el) })
    }
    return out
  })

  for (const item of items) {
    const need = STATUS_NEEDED[item.kind]
    if (!need) continue
    const o = t(need.test)
    o.applicable()
    // `aria-live` équivaut au rôle quand il en a l'effet : assertive pour une alerte, polite pour un statut.
    const equivalent =
      item.role === '' &&
      (item.kind === 'erreur' ? item.live === 'assertive' : item.live === 'polite')
    if (need.roles.includes(item.role) || equivalent) continue
    if (item.role !== '' || item.live !== '') {
      o.fail(
        `Message ${need.label} (« ${item.text.slice(0, 60)} ») avec ${item.role ? `le rôle « ${item.role} »` : `aria-live="${item.live}"`} : attendu ${need.roles.map((r) => `role="${r}"`).join(' ou ')}.`,
        item.ref,
      )
      continue
    }
    const answer = await o.judge({
      topic: 'status.message',
      question: `Cet élément ressemble à un message ${need.label} (« ${item.text.slice(0, 80)} ») mais n’a ni rôle ni aria-live. Est-ce un message de statut qui apparaît sans déplacer le focus ?`,
      answers: ['pas-un-message', 'message-sans-role'],
      evidence: { type: item.kind, texte: item.text.slice(0, 120) },
      ref: item.ref,
    })
    if (answer === 'message-sans-role') {
      o.fail(
        `Message ${need.label} (« ${item.text.slice(0, 60)} ») sans ${need.roles.map((r) => `role="${r}"`).join(' ni ')}.`,
        item.ref,
      )
    }
  }
  t('7.5.1').note(
    'Seuls les messages présents dans la page chargée sont repérés : un message qui apparaît après une action (envoi de formulaire) demande un essai manuel.',
  )
})

export const checks: Check[] = [
  components,
  alternatives,
  handlers,
  focusLoss,
  contextChanges,
  statusMessages,
]
