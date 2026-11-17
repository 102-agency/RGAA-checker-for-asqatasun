/**
 * Sonde d'interaction injectée dans une page neuve (`ctx.fresh()`) pour les
 * contrôles du focus (10.7), des liens (10.6) et des contenus additionnels au
 * survol ou au focus (10.13, 10.14).
 *
 * `installProbe` fabrique toute l'API dans la page (`window.__probe`) : les
 * fonctions de ce module sont sérialisées vers le navigateur, elles ne peuvent
 * donc pas partager de code entre elles. Le côté Node (`presentation-scan.ts`)
 * appelle ensuite `window.__probe.méthode(...)` par `page.evaluate`.
 */
import type { RgaaElementRef } from '../inpage/types.d.ts'

/** Valeurs de style qui peuvent matérialiser (ou dégrader) un indicateur de focus ou de survol. */
export type Digest = Record<string, string>

export interface ProbeReveal {
  index: number
  ref: RgaaElementRef
  text: string
  /** Le contenu apparu recouvre d'autres contenus (texte, liens, images). */
  obscures: boolean
  /** Le DOM a changé autour du déclencheur ou du contenu : l'apparition passe par un script. */
  mutated: boolean
}

export interface HoverTarget {
  x: number
  y: number
  ref: RgaaElementRef
  tag: string
  before: number[]
  mark: number
  digest: Digest
}

export interface FocusInfo {
  ref: RgaaElementRef
  tag: string
  name: string
  href: string | null
  /** Zone où chercher l'indicateur (le contrôle, ou son conteneur s'il n'a pas de boîte visible). */
  area: { x: number; y: number; width: number; height: number } | null
  /** `true` si l'élément n'a aucune boîte visible à l'écran (même par son conteneur). */
  boxless: boolean
  before: Digest
  after: Digest
  backdrop: string
  reveals: ProbeReveal[]
  shown: number[]
  mark: number
}

export interface ProbeApi {
  shown(): number[]
  buildPool(limit: number): number
  prepareHover(index: number): HoverTarget | null
  afterHover(
    index: number,
    before: number[],
    mark: number,
  ): Promise<{ reveals: ProbeReveal[]; digest: Digest }>
  focusStep(previous: number[], mark: number): Promise<FocusInfo | null>
  focusNext(): boolean
  /** Contrôles atteignables à la tabulation que le parcours n'a pas visités (sélecteurs). */
  unvisited(): string[]
  /** Tous les contrôles atteignables à la tabulation maintenant (sélecteurs). */
  tabbableSelectors(): string[]
  isShown(selector: string): boolean
  refocus(selector: string): boolean
  rootCount(): number
  /** Fait défiler jusqu'à l'élément et renvoie le centre de sa boîte et son style. */
  prepareSelector(selector: string): { x: number; y: number; digest: Digest } | null
  digestOf(selector: string): Digest | null
  /** Contenu masqué au chargement mais visible maintenant, par sélecteur. */
  isRevealed(selector: string): boolean
  hiddenFromAT(selector: string): boolean
}

declare global {
  interface Window {
    __probe?: ProbeApi
  }
}

/** Installe la sonde ; renvoie le nombre de contenus masqués repérés au chargement. */
export function installProbe(options: { transitions: boolean }): number {
  const R = window.__rgaa
  if (window.__probe) return window.__probe.rootCount()

  if (!options.transitions) {
    const style = document.createElement('style')
    style.textContent = '*, *::before, *::after { transition: none !important; }'
    document.head.append(style)
  }

  const CONTENT = 'img, svg, input, button, a[href], select, textarea, iframe, video, canvas'
  const hasContent = (el: Element): boolean =>
    R.norm(el.textContent) !== '' || el.matches(CONTENT) || el.querySelector(CONTENT) !== null
  const SKIP = 'script, style, noscript, template, head, title, meta, link'

  /** Visible à l'écran et dans les limites de la page. */
  const shownNow = (el: Element): boolean => {
    if (!el.isConnected || !R.isVisible(el)) return false
    const r = el.getBoundingClientRect()
    const x = r.left + window.scrollX
    const y = r.top + window.scrollY
    const width = Math.max(document.documentElement.scrollWidth, window.innerWidth)
    return r.right + window.scrollX > 0 && x < width && r.bottom + window.scrollY > 0 && y >= -1
  }

  // Contenus masqués au chargement : racines (le parent est visible).
  const roots: Element[] = []
  const rootSet = new Set<Element>()
  const addRoot = (el: Element) => {
    if (rootSet.has(el)) return
    rootSet.add(el)
    roots.push(el)
  }
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (el.matches(SKIP) || el.closest('svg') || el.closest(SKIP)) continue
    if (!hasContent(el)) continue
    const parent = el.parentElement
    if (!shownNow(el) && (!parent || parent === document.body || shownNow(parent))) addRoot(el)
  }

  const mutations: Node[] = []
  new MutationObserver((records) => {
    for (const record of records) {
      if (mutations.length < 20000) mutations.push(record.target)
      if (record.type === 'childList') {
        for (const node of Array.from(record.addedNodes)) {
          if (
            node.nodeType === 1 &&
            !(node as Element).matches(SKIP) &&
            hasContent(node as Element)
          ) {
            addRoot(node as Element)
          }
        }
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })

  const shown = (): number[] => {
    const out: number[] = []
    roots.forEach((el, index) => {
      if (shownNow(el)) out.push(index)
    })
    return out
  }

  const DIGEST_PROPS = [
    'outlineStyle',
    'outlineWidth',
    'outlineColor',
    'outlineOffset',
    'boxShadow',
    'borderTopColor',
    'borderRightColor',
    'borderBottomColor',
    'borderLeftColor',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'borderTopStyle',
    'borderBottomStyle',
    'backgroundColor',
    'backgroundImage',
    'color',
    'textDecorationLine',
    'textDecorationColor',
    'textDecorationThickness',
    'opacity',
    'transform',
    'filter',
    'fontWeight',
    'fontStyle',
  ] as const
  const digest = (el: Element): Digest => {
    const cs = getComputedStyle(el)
    const out: Digest = {}
    for (const prop of DIGEST_PROPS) out[prop] = String(cs[prop])
    return out
  }
  /** Couleur de fond effective derrière l'élément (premier ancêtre opaque, sinon blanc). */
  const backdropOf = (el: Element): string => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const color = getComputedStyle(n).backgroundColor
      const [r, g, b, a] = R.rgba(color)
      if (a >= 0.95) return `rgb(${r}, ${g}, ${b})`
    }
    return 'rgb(255, 255, 255)'
  }

  const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

  const related = (a: Node, b: Node): boolean => a === b || a.contains(b) || b.contains(a)

  /** Le contenu apparu recouvre-t-il d'autres contenus de la page ? */
  const obscures = (root: Element, trigger: Element): boolean => {
    const box = root.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return false
    const hit = (r: DOMRect) =>
      Math.min(r.right, box.right) - Math.max(r.left, box.left) > 2 &&
      Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top) > 2
    const range = document.createRange()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement
      if (!owner || R.norm(node.nodeValue) === '') continue
      if (
        root.contains(owner) ||
        trigger.contains(owner) ||
        owner.closest(SKIP) ||
        owner.closest('svg')
      )
        continue
      if (!R.isVisible(owner)) continue
      range.selectNodeContents(node)
      if (Array.from(range.getClientRects()).some(hit)) return true
    }
    for (const el of Array.from(
      document.body.querySelectorAll('a[href], button, input, select, textarea, img'),
    )) {
      if (root.contains(el) || trigger.contains(el) || el.contains(root) || !R.isVisible(el))
        continue
      if (hit(el.getBoundingClientRect())) return true
    }
    return false
  }

  const revealsSince = (
    before: number[],
    trigger: Element,
    mark: number,
    ignore: number[],
  ): ProbeReveal[] => {
    const known = new Set([...before, ...ignore])
    const out: ProbeReveal[] = []
    for (const index of shown()) {
      if (known.has(index)) continue
      const root = roots[index]
      if (!root || root === trigger || root.contains(trigger)) continue
      // Contenu apparu au sein d'un contenu déjà apparu : on ne garde que le plus haut.
      if (out.some((o) => roots[o.index]?.contains(root))) continue
      const changed = mutations.slice(mark).some((target) => {
        if (target === document.body || target === document.documentElement) return false
        return related(target, trigger) || related(target, root)
      })
      out.push({
        index,
        ref: R.ref(root),
        text: R.visibleText(root).slice(0, 80),
        obscures: obscures(root, trigger),
        mutated: changed,
      })
    }
    return out
  }

  // ─ Survol ─
  let pool: Element[] = []
  const hovered = new Set<Element>()
  const buildPool = (limit: number): number => {
    const chosen = new Set<Element>()
    for (const el of R.tabbables()) chosen.add(el)
    // Parents et frères précédents des contenus masqués : déclencheurs probables d'un survol CSS.
    for (const root of roots) {
      let node: Element | null = root
      for (let depth = 0; depth < 4 && node && node !== document.body; depth++) {
        const previous = node.previousElementSibling
        if (previous && R.isVisible(previous)) chosen.add(previous)
        node = node.parentElement
        if (node && node !== document.body && R.isVisible(node)) chosen.add(node)
      }
    }
    pool = Array.from(chosen)
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 1 && r.height > 1 && r.width < window.innerWidth * 0.95
      })
      .slice(0, limit)
    return pool.length
  }

  const prepareHover = (index: number): HoverTarget | null => {
    const el = pool[index]
    if (!el?.isConnected) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1)
    const y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1)
    const under = document.elementFromPoint(x, y)
    if (!under || !related(el, under) || hovered.has(under)) return null
    hovered.add(under)
    return {
      x,
      y,
      ref: R.ref(under),
      tag: el.localName,
      before: shown(),
      mark: mutations.length,
      digest: digest(el),
    }
  }
  const afterHover = async (index: number, before: number[], mark: number) => {
    await raf()
    const el = pool[index]
    if (!el) return { reveals: [], digest: {} }
    return { reveals: revealsSince(before, el, mark, []), digest: digest(el) }
  }

  // ─ Focus ─
  /**
   * Zone où chercher l'indicateur : le contrôle, étendu à ses conteneurs proches
   * (carte entière dont le lien est étiré par un pseudo-élément, libellé d'une
   * case à cocher masquée, anneau posé sur un parent). Bornée pour rester lisible.
   */
  const indicatorArea = (el: Element) => {
    const limit = window.innerWidth * window.innerHeight * 0.4
    let best: DOMRect | null = null
    let node: Element | null = el
    for (
      let depth = 0;
      node && node !== document.body && depth < 7;
      depth++, node = node.parentElement
    ) {
      const r = node.getBoundingClientRect()
      const usable = r.width >= 12 && r.height >= 12 && R.isRendered(node)
      const tooBig = r.width * r.height > limit || r.height > 600
      if (tooBig) {
        // Le contrôle lui-même est grand : on le garde tel quel ; un conteneur trop grand ne sert à rien.
        if (depth === 0 && usable) best = r
        break
      }
      if (usable) best = r
    }
    return best ? { x: best.left, y: best.top, width: best.width, height: best.height } : null
  }
  let visited = new Set<Element>()
  const focusStep = async (previous: number[], mark: number): Promise<FocusInfo | null> => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body || el === document.documentElement) return null
    await raf()
    const reveals = revealsSince([], el, mark, previous)
    const now = shown()
    const after = digest(el)
    const area = indicatorArea(el)
    const info: FocusInfo = {
      ref: R.ref(el),
      tag: el.localName,
      name: R.accName(el).slice(0, 80),
      href:
        el.localName === 'a'
          ? (el as HTMLAnchorElement).pathname + (el as HTMLAnchorElement).search
          : null,
      area,
      boxless: area === null,
      before: {},
      after,
      backdrop: backdropOf(el),
      reveals,
      shown: now,
      mark: mutations.length,
    }
    visited.add(el)
    el.blur()
    info.before = digest(el)
    el.focus({ preventScroll: true, focusVisible: true } as FocusOptions)
    return info
  }
  /** Avance à la main au contrôle suivant quand la tabulation ne bouge plus (cadre incorporé…). */
  const focusNext = (): boolean => {
    const tabbables = R.tabbables()
    const current = document.activeElement
    const index = current ? tabbables.indexOf(current as HTMLElement) : -1
    const next = tabbables.slice(index + 1).find((el) => !visited.has(el))
    if (!next) return false
    next.focus({ focusVisible: true } as FocusOptions)
    return true
  }
  const unvisited = (): string[] =>
    R.tabbables()
      .filter((el) => !visited.has(el))
      .map((el) => R.selector(el))
  const refocus = (selector: string): boolean => {
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return false
    el.focus({ focusVisible: true } as FocusOptions)
    return document.activeElement === el
  }
  const isShown = (selector: string): boolean => {
    const el = document.querySelector(selector)
    return el ? shownNow(el) : false
  }

  const prepareSelector = (selector: string) => {
    const el = document.querySelector(selector)
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    return {
      x: Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1),
      y: Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1),
      digest: digest(el),
    }
  }
  const digestOf = (selector: string) => {
    const el = document.querySelector(selector)
    return el ? digest(el) : null
  }

  window.__probe = {
    prepareSelector,
    digestOf,
    isRevealed: (selector: string) => {
      const el = document.querySelector(selector)
      return el ? shownNow(el) : false
    },
    hiddenFromAT: (selector: string) => {
      const el = document.querySelector(selector)
      return el ? R.isHiddenFromAT(el) : true
    },
    shown,
    buildPool,
    prepareHover,
    afterHover,
    focusStep,
    focusNext,
    unvisited,
    tabbableSelectors: () => R.tabbables().map((el) => R.selector(el)),
    isShown,
    refocus,
    rootCount: () => roots.length,
  }
  visited = new Set()
  return roots.length
}
