import type { Page } from 'playwright'
import type { ElementRef } from '../core/types.ts'

/**
 * Relevés de la thématique 12 (navigation), faits dans la page : repères et
 * fonctionnalités communes aux pages (menu, moteur de recherche, plan du site,
 * lien d'évitement), puis parcours réel à la tabulation. Les décisions sont
 * prises côté Node, dans `themes/12-navigation.ts`.
 */

/** Emplacement d'une fonctionnalité, relatif à l'en-tête si elle s'y trouve (un bandeau d'alerte ne la déplace pas). */
export interface Place {
  x: number
  y: number
  w: number
  h: number
  /** Conteneur de repère : `header`, `footer`, `main`, `aside` ou `page`. */
  container: string
}

export interface Feature {
  ref: ElementRef
  place: Place
  /** Intitulé de la commande qui précède dans le même conteneur : repère d'ordre dans le code source. */
  before: string
  /** La fonctionnalité précède le contenu principal dans le code source. */
  beforeMain: boolean
}

export interface MenuFeature extends Feature {
  /** Intitulés des liens du menu, dans l'ordre du code source. */
  items: string[]
}

export interface Zone {
  kind: string
  ref: ElementRef
  /** Rôle de repère obtenu (`banner`, `navigation`…), ou `null`. */
  role: string | null
  labelled: boolean
}

export interface PageFeatures {
  menu: MenuFeature | null
  search: Feature | null
  sitemap: (Feature & { href: string }) | null
  zones: Zone[]
  /** Formulaire de recherche sans repère `search` ni titre. */
  unlabelledSearch: ElementRef[]
  /** Écouteurs clavier déclarés dans le code (attributs `on…` et scripts de la page). */
  keyListeners: { where: string; excerpt: string }[]
}

export function collectFeatures(page: Page): Promise<PageFeatures> {
  return page.evaluate(() => {
    const { ref, norm, isHiddenFromAT, isRendered, accName, role } = window.__rgaa

    const shown = (el: Element) => !isHiddenFromAT(el) && !el.hasAttribute('hidden')
    const SECTIONING = 'article, aside, main, nav, section'
    const LANDMARK =
      'header, [role="banner"], footer, [role="contentinfo"], main, [role="main"], aside, nav, [role="navigation"]'

    const mainElement =
      Array.from(document.querySelectorAll('main, [role="main"]')).find(shown) ?? null

    const place = (el: Element): Place => {
      const rect = el.getBoundingClientRect()
      // Les coordonnées se prennent dans l'en-tête ou le pied de page qui contient l'élément : ni un bandeau
      // d'alerte au-dessus, ni la longueur de la page (pied de page) ne le déplacent.
      const anchor = el.closest('header, [role="banner"], footer, [role="contentinfo"]')
      const base = anchor
        ? anchor.getBoundingClientRect()
        : { left: -window.scrollX, top: -window.scrollY }
      const holder = el.closest(
        'header, [role="banner"], footer, [role="contentinfo"], main, [role="main"], aside',
      )
      let container = 'page'
      if (holder) {
        const tag = holder.localName
        const roleAttr = holder.getAttribute('role')
        container =
          tag === 'header' || roleAttr === 'banner'
            ? 'header'
            : tag === 'footer' || roleAttr === 'contentinfo'
              ? 'footer'
              : tag === 'aside'
                ? 'aside'
                : 'main'
      }
      return {
        x: Math.round(rect.left - base.left),
        y: Math.round(rect.top - base.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        container,
      }
    }

    /** Intitulé de la commande qui précède `el` dans son conteneur. */
    const before = (el: Element): string => {
      const holder =
        el.closest('header, footer, main, aside, nav, [role="banner"], [role="contentinfo"]') ??
        document.body
      const controls = Array.from(
        holder.querySelectorAll('a[href], button, input, select, textarea'),
      )
      let previous: Element | null = null
      for (const control of controls) {
        if (control === el || el.contains(control) || control.contains(el)) break
        if (control.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
          previous = control
        else break
      }
      return previous ? norm(accName(previous) || previous.textContent).slice(0, 30) : ''
    }

    const feature = (el: Element): Feature => ({
      ref: ref(el),
      place: place(el),
      before: before(el),
      beforeMain: mainElement
        ? Boolean(el.compareDocumentPosition(mainElement) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false,
    })

    // Menu : le repère de navigation le plus fourni, de préférence dans l'en-tête.
    const navs = Array.from(document.querySelectorAll('nav, [role="navigation"]'))
      .filter(shown)
      .map((el) => ({ el, links: Array.from(el.querySelectorAll('a[href]')).filter(shown) }))
      .filter((entry) => entry.links.length >= 2)
    // Pages sans balise <nav> : une liste de liens dans un conteneur nommé « nav » ou « menu ».
    if (navs.length === 0) {
      const NAV_NAME = /(^|[\s_-])(nav|navigation|menu|mainnav|main-menu|topnav)($|[\s_-])/i
      for (const list of document.querySelectorAll('ul, ol')) {
        if (!shown(list)) continue
        let named = false
        for (
          let node: Element | null = list;
          node && node !== document.body;
          node = node.parentElement
        ) {
          if (
            NAV_NAME.test(`${node.id} ${typeof node.className === 'string' ? node.className : ''}`)
          )
            named = true
        }
        const links = Array.from(list.querySelectorAll('a[href]')).filter(shown)
        if (named && links.length >= 2 && !list.parentElement?.closest('ul, ol'))
          navs.push({ el: list, links })
      }
    }
    navs.sort((a, b) => {
      const inHeader = (entry: { el: Element }) =>
        entry.el.closest('header, [role="banner"]') ? 1 : 0
      return inHeader(b) - inHeader(a) || b.links.length - a.links.length
    })
    const primary = navs[0]
    const menu: MenuFeature | null = primary
      ? {
          ...feature(primary.el),
          items: primary.links.map((link) => norm(accName(link)).slice(0, 40)).filter(Boolean),
        }
      : null

    // Moteur de recherche.
    const searchEl =
      Array.from(document.querySelectorAll('[role="search"], search')).find(shown) ??
      Array.from(document.querySelectorAll('form')).find(
        (form) =>
          shown(form) &&
          (form.querySelector('input[type="search"]') !== null ||
            /(search|recherche)/i.test(form.getAttribute('action') ?? '') ||
            Array.from(form.querySelectorAll('input[name]')).some((input) =>
              /^(q|s|search|recherche|query|keywords?|mots?cles?)$/i.test(
                input.getAttribute('name') ?? '',
              ),
            )),
      ) ??
      null
    const unlabelledSearch: ElementRef[] = []
    for (const form of document.querySelectorAll('form')) {
      if (!shown(form) || form.closest('[role="search"], search')) continue
      const isSearch =
        form.querySelector('input[type="search"]') !== null ||
        /(search|recherche)/i.test(form.getAttribute('action') ?? '')
      const hasName = form.hasAttribute('aria-label') || form.hasAttribute('aria-labelledby')
      if (
        isSearch &&
        form.getAttribute('role') !== 'search' &&
        !hasName &&
        !form.querySelector('h1, h2, h3, h4, h5, h6')
      ) {
        unlabelledSearch.push(ref(form))
      }
    }

    // Plan du site : un lien dont l'intitulé le nomme.
    const sitemapLink =
      Array.from(document.querySelectorAll('a[href]')).find(
        (link) =>
          shown(link) && /plan\s+(du|de)\s+site|sitemap|plan\s+du\s+web/i.test(norm(accName(link))),
      ) ?? null

    // Zones de regroupement : repère sémantique, ou conteneur nommé « header », « footer »… sans repère.
    const zones: Zone[] = []
    const zoneKinds: [string, string][] = [
      ['header, [role="banner"]', 'en-tête'],
      ['nav, [role="navigation"]', 'navigation'],
      ['main, [role="main"]', 'contenu principal'],
      ['footer, [role="contentinfo"]', 'pied de page'],
    ]
    for (const [selector, kind] of zoneKinds) {
      for (const el of document.querySelectorAll(selector)) {
        if (!shown(el)) continue
        // Un en-tête ou pied de page dans un article n'est pas celui de la page.
        if (
          (el.localName === 'header' || el.localName === 'footer') &&
          el.parentElement?.closest(SECTIONING)
        )
          continue
        zones.push({ kind, ref: ref(el), role: role(el), labelled: true })
      }
    }
    const NAMED =
      /(^|[\s_-])(header|footer|navigation|nav|menu|main-?content|site-?header|site-?footer|search|recherche)($|[\s_-])/i
    const kindOf = (token: string) =>
      /header/i.test(token)
        ? 'en-tête'
        : /footer/i.test(token)
          ? 'pied de page'
          : /search|recherche/i.test(token)
            ? 'moteur de recherche'
            : /main/i.test(token)
              ? 'contenu principal'
              : 'navigation'
    const claimed: Element[] = []
    for (const el of document.body.querySelectorAll('div, section, ul, form, span')) {
      const token = `${el.id} ${typeof el.className === 'string' ? el.className : ''}`
      const found = NAMED.exec(token)
      if (!found || !shown(el) || !isRendered(el)) continue
      const resolved = role(el)
      if (
        resolved &&
        resolved !== 'generic' &&
        resolved !== 'none' &&
        resolved !== 'presentation' &&
        resolved !== 'list'
      )
        continue
      if (el.closest(LANDMARK) || el.querySelector(LANDMARK)) continue
      if (claimed.some((other) => other.contains(el) || el.contains(other))) continue
      if (el.textContent && norm(el.textContent).length < 3) continue
      claimed.push(el)
      const titled =
        el.hasAttribute('aria-label') ||
        el.hasAttribute('aria-labelledby') ||
        el.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]') !== null
      zones.push({ kind: kindOf(found[2] ?? ''), ref: ref(el), role: null, labelled: titled })
    }

    // Écouteurs clavier déclarés dans le code.
    const keyListeners: { where: string; excerpt: string }[] = []
    for (const el of document.querySelectorAll('[onkeydown], [onkeypress], [onkeyup]')) {
      const attribute = (
        el.getAttribute('onkeydown') ??
        el.getAttribute('onkeypress') ??
        el.getAttribute('onkeyup') ??
        ''
      ).slice(0, 120)
      keyListeners.push({ where: ref(el).selector, excerpt: attribute })
    }
    for (const script of document.querySelectorAll('script:not([src])')) {
      const text = script.textContent ?? ''
      const found =
        /(addEventListener\(\s*['"]key(down|press|up)['"]|\.onkey(down|press|up)\s*=|\$\([^)]*\)\.key(down|press|up)\()/.exec(
          text,
        )
      if (found) {
        keyListeners.push({
          where: 'script',
          excerpt: norm(text.slice(Math.max(0, found.index - 40), found.index + 120)),
        })
      }
    }

    return {
      menu,
      search: searchEl ? feature(searchEl) : null,
      sitemap: sitemapLink
        ? { ...feature(sitemapLink), href: sitemapLink.getAttribute('href') ?? '' }
        : null,
      zones,
      unlabelledSearch,
      keyListeners,
    }
  })
}

// ─── Parcours à la tabulation ───────────────────────────────────────────────

export interface TabStop {
  ref: ElementRef
  tag: string
  name: string
  href: string
  /** Position dans le document (pas dans la fenêtre). */
  x: number
  y: number
  /** Visible avant de recevoir le focus ? */
  visibleBefore: boolean
  visibleFocused: boolean
  inMain: boolean
  /** Rang dans l'ordre du code source parmi les éléments tabulables. */
  domIndex: number
  tabindex: number
  container: string
}

export interface TabWalk {
  stops: TabStop[]
  /** Nombre d'éléments tabulables et visibles annoncés par le DOM. */
  expected: number
  /** Le focus est resté sur le même élément malgré la tabulation. */
  stuck: TabStop | null
  /** Le parcours est revenu sur un élément déjà visité avant d'avoir parcouru la page. */
  cycledEarly: boolean
  /** Éléments avec un `tabindex` positif. */
  positive: ElementRef[]
}

const MAX_STOPS = 200

interface InitialSurvey {
  items: { selector: string; visibleBefore: boolean; domIndex: number }[]
  positive: ElementRef[]
}

/** Parcourt la page à la touche Tab sur une page neuve, jusqu'à retour au début ou plafond. */
export async function walkTabs(page: Page): Promise<TabWalk> {
  const survey: InitialSurvey = await page.evaluate(() => {
    const { ref, tabbables, isVisible } = window.__rgaa
    const items = tabbables().map((el, domIndex) => ({
      selector: ref(el).selector,
      visibleBefore:
        isVisible(el) &&
        el.getBoundingClientRect().bottom > 0 &&
        el.getBoundingClientRect().right > 0 &&
        el.getBoundingClientRect().left < window.innerWidth,
      domIndex,
    }))
    const positive = Array.from(document.querySelectorAll('[tabindex]'))
      .filter((el) => (el as HTMLElement).tabIndex > 0)
      .map((el) => ref(el))
    return { items, positive }
  })
  const byIndex = new Map(survey.items.map((item) => [item.selector, item]))
  const expected = survey.items.length

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(0, 0)

  const stops: TabStop[] = []
  const seen = new Set<string>()
  let stuck: TabStop | null = null
  let cycledEarly = false
  let repeated = 0
  let lastSelector = ''

  for (let n = 0; n < Math.min(MAX_STOPS, expected + 5); n++) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(() => {
      const { ref, isVisible, accName } = window.__rgaa
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body || el === document.documentElement) return null
      const rect = el.getBoundingClientRect()
      const holder = el.closest(
        'header, [role="banner"], nav, main, [role="main"], footer, [role="contentinfo"], aside',
      )
      return {
        ref: ref(el),
        tag: el.localName,
        name: accName(el).slice(0, 60),
        href: el.getAttribute('href') ?? '',
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        visibleFocused: isVisible(el) && rect.width > 1 && rect.height > 1,
        inMain: el.closest('main, [role="main"]') !== null,
        tabindex: el.tabIndex,
        container: holder ? holder.localName : 'page',
      }
    })
    if (!stop) {
      // Retour au début du document (ou au navigateur) : le tour est fait.
      if (stops.length > 0) break
      continue
    }
    const known = byIndex.get(stop.ref.selector)
    const entry: TabStop = {
      ...stop,
      visibleBefore: known?.visibleBefore ?? false,
      domIndex: known?.domIndex ?? -1,
    }
    if (stop.ref.selector === lastSelector) {
      repeated += 1
      if (repeated >= 2) {
        stuck = entry
        break
      }
      continue
    }
    repeated = 0
    lastSelector = stop.ref.selector
    if (seen.has(stop.ref.selector)) {
      cycledEarly = stops.length < expected * 0.5
      break
    }
    seen.add(stop.ref.selector)
    stops.push(entry)
  }
  return { stops, expected, stuck, cycledEarly, positive: survey.positive }
}
