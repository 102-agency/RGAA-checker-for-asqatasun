/**
 * Fonctions exécutées DANS la page (via `page.evaluate`) pour la thématique 10.
 *
 * Chacune est autonome : elle est sérialisée vers le navigateur, donc aucune
 * référence à une variable de ce module n'y survit. Les utilitaires communs
 * (`window.__rgaa`) viennent de `src/inpage/helpers.js`.
 */
import type { RgaaElementRef } from '../inpage/types.d.ts'

// ─── Mesure de la mise en page (10.4.1, 10.11.1, 10.12.1) ───────────────────

/** Élément de contenu mesuré : ligne de texte ou boîte (lien, bouton, image…). */
export interface SnapshotItem {
  /** Chemin d'indices dans le DOM : identique d'une page chargée à l'autre. */
  key: string
  kind: 'text' | 'box'
  /** Part de la surface visible (1 = entière). Seuls les éléments rognés (< 0,98) sont renvoyés. */
  ratio: number
  label: string
  ref: RgaaElementRef
}

export interface SnapshotOverlap {
  key: string
  a: string
  b: string
  ref: RgaaElementRef
}

/** Ce qui est visible à l'écran : textes (avec le lien qui les porte), destinations et noms des contrôles. */
export interface Inventory {
  texts: { t: string; href: string | null }[]
  /** Destinations (chemin + requête) des liens visibles. */
  hrefs: string[]
  /** Noms accessibles des contrôles visibles (un bouton réduit à une icône garde son nom). */
  names: string[]
}

export interface LayoutSnapshot extends Inventory {
  items: SnapshotItem[]
  overlaps: SnapshotOverlap[]
  /** Chemins des nœuds de texte visibles : ce qu'une ouverture de menu ajoute s'y repère. */
  keys: string[]
}

/**
 * Photographie la mise en page : texte et boîtes rognés par un ancêtre
 * (`overflow: hidden`, bord de la fenêtre), et chevauchements entre lignes de
 * texte d'éléments différents. Comparée à la photographie de la page de
 * référence, elle révèle ce qu'un changement de largeur, de zoom ou
 * d'espacement a dégradé.
 */
export function layoutSnapshot(): LayoutSnapshot {
  const R = window.__rgaa
  const vw = window.innerWidth
  const rootX = getComputedStyle(document.documentElement).overflowX
  const bodyX = getComputedStyle(document.body).overflowX
  const viewportX = rootX !== 'visible' ? rootX : bodyX
  const clipsViewportX = viewportX === 'hidden' || viewportX === 'clip'

  const visibleCache = new Map<Element, boolean>()
  const visible = (el: Element): boolean => {
    let value = visibleCache.get(el)
    if (value === undefined) {
      value = R.isVisible(el)
      visibleCache.set(el, value)
    }
    return value
  }

  const pathKey = (node: Node): string => {
    const parts: number[] = []
    for (let n: Node | null = node; n && n !== document.documentElement; n = n.parentNode) {
      const parent: Node | null = n.parentNode
      if (!parent) break
      parts.push(Array.prototype.indexOf.call(parent.childNodes, n))
    }
    return parts.reverse().join('.')
  }

  type Box = { left: number; top: number; right: number; bottom: number }
  const isPositioned = (cs: CSSStyleDeclaration) =>
    cs.position !== 'static' || cs.transform !== 'none' || cs.filter !== 'none'

  /** Rogne `rect` par les ancêtres qui coupent (`overflow: hidden|clip`) et par la fenêtre. */
  const clip = (start: Element, rect: Box, withViewport = true): Box | null => {
    let { left, top, right, bottom } = rect
    if (withViewport && left < 0) left = 0
    if (withViewport && clipsViewportX && right > vw) right = vw
    let mode: 'normal' | 'abs' | 'fixed' = 'normal'
    for (
      let n: Element | null = start;
      n && n !== document.body && n !== document.documentElement;
      n = n.parentElement
    ) {
      const cs = getComputedStyle(n)
      const applies = mode === 'normal' || (mode === 'abs' && isPositioned(cs))
      if (mode === 'abs' && isPositioned(cs)) mode = 'normal'
      if (mode === 'fixed') break
      if (applies && (n.clientWidth > 0 || n.clientHeight > 0)) {
        const cutX = cs.overflowX === 'hidden' || cs.overflowX === 'clip'
        const cutY = cs.overflowY === 'hidden' || cs.overflowY === 'clip'
        if (cutX || cutY) {
          const b = n.getBoundingClientRect()
          const l = b.left + n.clientLeft
          const t = b.top + n.clientTop
          if (cutX) {
            left = Math.max(left, l)
            right = Math.min(right, l + n.clientWidth)
          }
          if (cutY) {
            top = Math.max(top, t)
            bottom = Math.min(bottom, t + n.clientHeight)
          }
        }
      }
      if (cs.position === 'fixed') mode = 'fixed'
      else if (cs.position === 'absolute') mode = 'abs'
    }
    return right > left && bottom > top ? { left, top, right, bottom } : null
  }

  const area = (b: Box) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top)
  const items: SnapshotItem[] = []
  const texts: Inventory['texts'] = []
  const keys: string[] = []
  const lines: { box: Box; node: Text; owner: Element }[] = []

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const value = R.norm(text.nodeValue)
    const owner = text.parentElement
    if (!value || !owner) continue
    if (owner.closest('script, style, noscript, template, svg, title')) continue
    if (!visible(owner)) continue
    range.selectNodeContents(text)
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
    if (rects.length === 0) continue
    const anchor = owner.closest('a[href]')
    keys.push(pathKey(text))
    texts.push({
      t: value,
      href: anchor
        ? (anchor as HTMLAnchorElement).pathname + (anchor as HTMLAnchorElement).search
        : null,
    })
    // La zone de contenu de la police dépasse souvent la hauteur de ligne : un conteneur
    // `overflow: hidden` aussi haut que la ligne ne rogne alors aucun glyphe. On mesure la boîte de ligne.
    const lineHeight = Number.parseFloat(getComputedStyle(owner).lineHeight)
    let total = 0
    let shown = 0
    let shownInAncestors = 0
    const found: { box: Box }[] = []
    for (const r of rects) {
      let { top, bottom } = r
      if (Number.isFinite(lineHeight) && r.height > lineHeight + 0.5) {
        const extra = (r.height - lineHeight) / 2
        top += extra
        bottom -= extra
      }
      const box = { left: r.left, top, right: r.right, bottom }
      total += area(box)
      const clipped = clip(owner, box)
      const clippedByAncestors = clip(owner, box, false)
      if (clippedByAncestors) shownInAncestors += area(clippedByAncestors)
      if (clipped) {
        shown += area(clipped)
        found.push({ box: clipped })
      }
    }
    const ratio = total > 0 ? shown / total : 1
    // Calque décoratif (`aria-hidden`) rangé tout entier hors de son conteneur qui coupe : l'état d'attente
    // d'un effet (lettre qui se retourne au survol, diapositive hors champ), pas un texte rogné.
    // Un texte coupé par la fenêtre, ou qui n'est pas masqué aux technologies d'assistance, reste signalé.
    const parkedLayer =
      ratio < 0.98 &&
      total > 0 &&
      shownInAncestors / total < 0.15 &&
      owner.closest('[aria-hidden="true"]') !== null
    // Texte entièrement masqué dans un bouton ou un lien : technique du bouton-icône (« Menu » à côté d'un
    // pictogramme) ou d'un sous-menu replié. Le texte est volontairement absent de l'écran, pas rogné.
    const hiddenInControl =
      ratio < 0.02 && owner.closest('button, a[href], [role="button"]') !== null
    if (!parkedLayer) {
      for (const line of found) lines.push({ box: line.box, node: text, owner })
    }
    if (ratio < 0.98 && !parkedLayer && !hiddenInControl) {
      items.push({
        key: pathKey(text),
        kind: 'text',
        ratio,
        label: value.slice(0, 80),
        ref: R.ref(owner),
      })
    }
  }

  const boxes = document.body.querySelectorAll(
    'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"]',
  )
  for (const el of Array.from(boxes)) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 1 || r.height <= 1) continue
    const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    const clipped = clip(el.parentElement ?? el, box)
    const ratio = clipped ? area(clipped) / area(box) : 0
    if (ratio < 0.98) {
      items.push({
        key: pathKey(el),
        kind: 'box',
        ratio,
        label: (R.accName(el) || el.localName).slice(0, 80),
        ref: R.ref(el),
      })
    }
  }

  // Chevauchements : balayage par le haut, lignes de nœuds de texte différents.
  const overlaps: SnapshotOverlap[] = []
  const seen = new Set<string>()
  lines.sort((a, b) => a.box.top - b.box.top)
  for (let i = 0; i < lines.length && overlaps.length < 60; i++) {
    const a = lines[i]
    if (!a) continue
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j]
      if (!b || b.box.top >= a.box.bottom) break
      if (a.node === b.node) continue
      const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left)
      const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top)
      if (w < 3 || h < 3) continue
      const smaller = Math.min(area(a.box), area(b.box))
      const minHeight = Math.min(a.box.bottom - a.box.top, b.box.bottom - b.box.top)
      if ((w * h) / smaller < 0.25 || h / minHeight < 0.3) continue
      const keys = [pathKey(a.node), pathKey(b.node)].sort()
      const key = keys.join('|')
      if (seen.has(key)) continue
      seen.add(key)
      overlaps.push({
        key,
        a: R.norm(a.node.nodeValue).slice(0, 60),
        b: R.norm(b.node.nodeValue).slice(0, 60),
        ref: R.ref(a.owner),
      })
    }
  }
  const hrefs = new Set<string>()
  const names = new Set<string>()
  for (const el of Array.from(
    document.body.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"]',
    ),
  )) {
    if (!visible(el)) continue
    if (el.localName === 'a')
      hrefs.add((el as HTMLAnchorElement).pathname + (el as HTMLAnchorElement).search)
    const name = R.accName(el)
    if (name) names.add(name)
  }
  return { items, overlaps, texts, keys, hrefs: Array.from(hrefs), names: Array.from(names) }
}

// ─── Défilement horizontal (10.4.1, 10.11.1) ────────────────────────────────

export interface OverflowOffender {
  /** `page` : fait défiler le document ; `container` : défilement dans un bloc. */
  scope: 'page' | 'container'
  /** Cas particulier du RGAA (tableau de données, média…) : l'élément n'est pas fautif. */
  exception: 'tableau' | 'média' | 'préformaté' | null
  ref: RgaaElementRef
  text: string
  /** Dépassement en pixels du bord droit de la fenêtre ou du conteneur. */
  excess: number
}

export interface HorizontalOverflow {
  docScroll: number
  offenders: OverflowOffender[]
  /** Éléments les plus à droite quand rien n'explique le défilement du document. */
  widest: { ref: RgaaElementRef; right: number }[]
}

/** Éléments qui dépassent à droite de la fenêtre ou d'un conteneur défilant, avec leur cas particulier éventuel. */
export function horizontalOverflow(): HorizontalOverflow {
  const R = window.__rgaa
  const vw = window.innerWidth
  const scroller = document.scrollingElement ?? document.documentElement
  const docScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth)

  const exceptionOf = (el: Element): OverflowOffender['exception'] => {
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      const tag = n.localName
      if (
        ['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed', 'picture', 'map'].includes(
          tag,
        )
      )
        return 'média'
      if (tag === 'table') {
        const role = n.getAttribute('role')
        if (role !== 'presentation' && role !== 'none') return 'tableau'
      }
      if (['table', 'grid', 'treegrid'].includes(n.getAttribute('role') ?? '')) return 'tableau'
      if (tag === 'pre') return 'préformaté'
    }
    return null
  }

  const all = Array.from(document.body.querySelectorAll('*')).filter((el) => {
    if (el.closest('svg') && el.localName !== 'svg') return false
    if (['script', 'style', 'noscript', 'template', 'br', 'wbr'].includes(el.localName))
      return false
    return true
  })
  const hasContent = (el: Element): boolean => {
    if (
      [
        'img',
        'svg',
        'video',
        'canvas',
        'iframe',
        'object',
        'embed',
        'input',
        'select',
        'textarea',
        'button',
        'a',
      ].includes(el.localName)
    )
      return true
    return Array.from(el.childNodes).some((n) => n.nodeType === 3 && R.norm(n.nodeValue) !== '')
  }

  const offenders: OverflowOffender[] = []
  const widest: HorizontalOverflow['widest'] = []

  // Nœuds visibles et vraiment atteints (non coupés par overflow:hidden) dépassant la fenêtre.
  const beyond: { el: Element; right: number }[] = []
  for (const el of all) {
    if (!R.isVisible(el)) continue
    const r = el.getBoundingClientRect()
    if (r.right <= vw + 1) continue
    // Coupé par un ancêtre qui masque ou fait défiler lui-même ?
    let cut = false
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.overflowX !== 'visible' && n.getBoundingClientRect().right <= vw + 1) {
        cut = true
        break
      }
    }
    if (cut) continue
    beyond.push({ el, right: r.right })
  }
  const beyondSet = new Set(beyond.map((b) => b.el))
  for (const { el, right } of beyond) {
    // On ne garde que le plus profond : le conteneur dépasse à cause de son contenu.
    const deeper = Array.from(el.querySelectorAll('*')).some((child) => beyondSet.has(child))
    if (deeper || !hasContent(el)) continue
    offenders.push({
      scope: 'page',
      exception: exceptionOf(el),
      ref: R.ref(el),
      text: R.visibleText(el).slice(0, 60),
      excess: Math.round(right - vw),
    })
  }

  // Défilement à l'intérieur d'un bloc (overflow auto/scroll) : un défilement horizontal de plus.
  for (const el of all) {
    const cs = getComputedStyle(el)
    if (cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') continue
    if (el.scrollWidth <= el.clientWidth + 1 || !R.isVisible(el)) continue
    const box = el.getBoundingClientRect()
    const inner = Array.from(el.querySelectorAll('*')).filter(
      (child) => R.isVisible(child) && child.getBoundingClientRect().right > box.right + 1,
    )
    const innerSet = new Set(inner)
    const causes = inner.filter(
      (child) =>
        !Array.from(child.querySelectorAll('*')).some((c) => innerSet.has(c)) && hasContent(child),
    )
    const targets = causes.length > 0 ? causes : [el]
    for (const target of targets.slice(0, 3)) {
      offenders.push({
        scope: 'container',
        exception: exceptionOf(target) ?? exceptionOf(el),
        ref: R.ref(target),
        text: R.visibleText(target).slice(0, 60),
        excess: Math.round(el.scrollWidth - el.clientWidth),
      })
    }
  }

  if (docScroll > 1 && !offenders.some((o) => o.scope === 'page')) {
    const rights = all
      .filter((el) => R.isRendered(el))
      .map((el) => ({ el, right: el.getBoundingClientRect().right }))
      .filter((x) => x.right > vw + 1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 3)
    for (const x of rights) widest.push({ ref: R.ref(x.el), right: Math.round(x.right) })
  }
  return { docScroll, offenders: offenders.slice(0, 30), widest }
}

// ─── 10.11.2 : contenu à lecture verticale ──────────────────────────────────

export interface VerticalBlock {
  ref: RgaaElementRef
  text: string
  /** Bord bas, en pixels de la fenêtre : au-delà de sa hauteur, il faut défiler. */
  bottom: number
  viewportHeight: number
}

/** Blocs de texte dont le sens de lecture est vertical (`writing-mode: vertical-*`). */
export function verticalBlocks(): VerticalBlock[] {
  const R = window.__rgaa
  const out: VerticalBlock[] = []
  const seen = new Set<Element>()
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const mode = getComputedStyle(el).writingMode
    if (!mode.startsWith('vertical') && !mode.startsWith('sideways')) continue
    if (!R.isVisible(el) || seen.has(el)) continue
    const text = R.visibleText(el)
    if (!text) continue
    for (const inner of Array.from(el.querySelectorAll('*'))) seen.add(inner)
    out.push({
      ref: R.ref(el),
      text: text.slice(0, 60),
      bottom: Math.round(el.getBoundingClientRect().bottom),
      viewportHeight: window.innerHeight,
    })
  }
  return out
}

// ─── Contenus atteignables par une action (10.4.1, 10.11.1) ──────────────────

/**
 * Inventaire visible après avoir déplié, un à un, les contrôles de divulgation
 * (boutons `aria-expanded`, `<summary>`, `aria-haspopup`, onglets). Modifie la
 * page : à n'appeler que sur `ctx.fresh()`.
 */
export async function reachableInventory(): Promise<Inventory> {
  const R = window.__rgaa
  const texts = new Set<string>()
  const hrefs = new Set<string>()
  const names = new Set<string>()
  const collect = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement
      const value = R.norm(node.nodeValue)
      if (!owner || !value || owner.closest('script, style, noscript, template, svg')) continue
      if (R.isVisible(owner)) texts.add(value)
    }
    for (const el of Array.from(
      document.body.querySelectorAll(
        'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"]',
      ),
    )) {
      if (!R.isVisible(el)) continue
      if (el.localName === 'a')
        hrefs.add((el as HTMLAnchorElement).pathname + (el as HTMLAnchorElement).search)
      const name = R.accName(el)
      if (name) names.add(name)
    }
  }
  collect()
  const togglers = Array.from(
    document.querySelectorAll(
      'summary, [aria-expanded="false"], [aria-haspopup]:not([aria-haspopup="false"]), [role="tab"]',
    ),
  )
    .filter((el) => R.isVisible(el))
    .slice(0, 40)
  // Les clics ne doivent pas changer de page : liens neutralisés.
  document.addEventListener(
    'click',
    (event) => {
      if ((event.target as Element | null)?.closest('a[href]')) event.preventDefault()
    },
    true,
  )
  for (const el of togglers) {
    ;(el as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 60))
    R.resetTree()
    collect()
    if (el.getAttribute('role') !== 'tab') {
      // Referme ce qui vient de s'ouvrir, pour que le contrôle suivant reste atteignable.
      const opened =
        el.localName === 'summary'
          ? el.parentElement?.hasAttribute('open')
          : el.getAttribute('aria-expanded') === 'true'
      if (opened) {
        ;(el as HTMLElement).click()
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
    }
  }
  return {
    texts: Array.from(texts, (t) => ({ t, href: null })),
    hrefs: Array.from(hrefs),
    names: Array.from(names),
  }
}

// ─── 10.1 : balises, attributs et espaces de présentation ───────────────────

export interface MarkupFinding {
  message: string
  ref: RgaaElementRef
}

export interface MarkupReport {
  tags: MarkupFinding[]
  attributes: MarkupFinding[]
  spaces: MarkupFinding[]
  /** Blocs préformatés dont les espaces semblent aligner des colonnes : à juger. */
  preformatted: { text: string; ref: RgaaElementRef }[]
  hasText: boolean
}

/** Relève, dans le DOM généré, les balises et attributs de présentation et les espaces utilisés pour la mise en forme. */
export function markupReport(html5: boolean): MarkupReport {
  const R = window.__rgaa
  const HTML_NS = 'http://www.w3.org/1999/xhtml'
  const tags: MarkupFinding[] = []
  const attributes: MarkupFinding[] = []
  const spaces: MarkupFinding[] = []
  const preformatted: MarkupReport['preformatted'] = []

  const presentationTags = [
    'basefont',
    'big',
    'blink',
    'center',
    'font',
    'marquee',
    's',
    'strike',
    'tt',
  ]
  if (!html5) presentationTags.push('u')
  const presentationAttrs = [
    'align',
    'alink',
    'background',
    'bgcolor',
    'border',
    'cellpadding',
    'cellspacing',
    'char',
    'charoff',
    'clear',
    'color',
    'compact',
    'frameborder',
    'hspace',
    'link',
    'marginheight',
    'marginwidth',
    'text',
    'valign',
    'vlink',
    'vspace',
  ]
  // `width` / `height` : dimensions intrinsèques admises sur les contenus incorporés ; sur le reste (table, td, hr…) ce sont des attributs de mise en forme.
  const dimensionOk = ['img', 'object', 'embed', 'canvas', 'svg', 'iframe', 'video', 'source']

  for (const el of Array.from(document.documentElement.querySelectorAll('*'))) {
    if (el.namespaceURI !== HTML_NS || el.closest('head')) continue
    const tag = el.localName
    if (presentationTags.includes(tag)) {
      tags.push({ message: `Balise de présentation <${tag}>.`, ref: R.ref(el) })
    }
    for (const name of presentationAttrs) {
      if (el.hasAttribute(name)) {
        attributes.push({
          message: `Attribut de présentation « ${name} » sur <${tag}>.`,
          ref: R.ref(el),
        })
      }
    }
    if (el.hasAttribute('size') && tag !== 'select') {
      attributes.push({
        message: `Attribut de présentation « size » sur <${tag}>.`,
        ref: R.ref(el),
      })
    }
    for (const name of ['width', 'height']) {
      if (!el.hasAttribute(name)) continue
      const imageInput = tag === 'input' && el.getAttribute('type') === 'image'
      if (!dimensionOk.includes(tag) && !imageInput) {
        attributes.push({
          message: `Attribut de présentation « ${name} » sur <${tag}>.`,
          ref: R.ref(el),
        })
      }
    }
  }

  let hasText = false
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const seenPre = new Set<Element>()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const owner = node.parentElement
    const raw = node.nodeValue ?? ''
    if (!owner || raw.trim() === '') continue
    if (owner.closest('script, style, noscript, template, svg, textarea')) continue
    if (!R.isRendered(owner)) continue
    hasText = true
    const inCode = owner.closest('pre, code, kbd, samp') !== null
    const flat = raw.replace(/\s+/g, ' ')
    // Lettres séparées par des espaces : « S E R V I C E S ».
    const spaced = /(?<![\p{L}\p{N}])(?:\p{L}[   ]){4,}\p{L}(?![\p{L}\p{N}])/u.exec(flat)
    if (spaced) {
      spaces.push({
        message: `Espaces entre les lettres d’un mot : « ${spaced[0].trim()} ».`,
        ref: R.ref(owner),
      })
    }
    // Espaces insécables en série : marge, retrait ou colonnes simulés.
    if (!inCode) {
      const run = /[    　]{2,}|(?:  |  |  ){2,}/.exec(raw)
      if (run) {
        spaces.push({
          message: `Série d’espaces insécables utilisée pour la mise en forme (${run[0].length} caractères) dans « ${flat.trim().slice(0, 60)} ».`,
          ref: R.ref(owner),
        })
      }
    }
    // Texte préformaté dont des espaces alignent des colonnes.
    const pre = owner.closest('pre')
    if (pre && !seenPre.has(pre) && !pre.querySelector('code') && !pre.closest('code')) {
      seenPre.add(pre)
      if (/\S {2,}\S/.test(pre.textContent ?? '')) {
        preformatted.push({ text: R.norm(pre.textContent).slice(0, 160), ref: R.ref(pre) })
      }
    }
  }
  return {
    tags,
    attributes,
    spaces: spaces.slice(0, 40),
    preformatted: preformatted.slice(0, 10),
    hasText,
  }
}

// ─── 10.5 : feuilles de styles ────────────────────────────────────

export interface CssReport {
  /** Unités absolues dans les styles destinés à l'écran. */
  units: { text: string; selector: string; sheet: string }[]
  unitsCount: number
  /** Déclarations de couleur sans couleur associée (10.5.x), regroupées par règle. */
  colors: {
    test: '10.5.1' | '10.5.2' | '10.5.3'
    rule: string
    count: number
    ref: RgaaElementRef
  }[]
  /** Feuilles de styles lisibles / illisibles (origine différente, sans CORS). */
  sheets: number
  unreadable: string[]
}

/**
 * Parcourt les feuilles de styles (CSSOM) : unités non relatives en média
 * `screen`, puis, élément par élément, la couleur de police, la couleur de
 * fond et l'image de fond déclarées par les règles qui s'y appliquent.
 * `extraSheets` : texte des feuilles que le navigateur ne laisse pas lire.
 */
export function cssReport(extraSheets: { href: string; text: string }[]): CssReport {
  const R = window.__rgaa
  type Flags = { print: boolean; matches: boolean }
  const report: CssReport = { units: [], unitsCount: 0, colors: [], sheets: 0, unreadable: [] }

  const sheets: { sheet: CSSStyleSheet; name: string }[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    const name = sheet.href ?? (sheet.ownerNode as Element | null)?.localName ?? 'style'
    try {
      void sheet.cssRules.length
      sheets.push({ sheet, name })
    } catch {
      const text = extraSheets.find((extra) => extra.href === sheet.href)?.text
      if (text === undefined) {
        report.unreadable.push(name)
        continue
      }
      const copy = new CSSStyleSheet()
      copy.replaceSync(text)
      sheets.push({ sheet: copy, name })
    }
  }
  report.sheets = sheets.length

  const printOnly = (rule: CSSMediaRule): boolean => {
    const queries = Array.from(rule.media)
    return (
      queries.length > 0 &&
      queries.every((q) => /^\s*(only\s+)?(print|speech|braille|embossed|aural)\b/i.test(q))
    )
  }

  const visit = (
    rules: CSSRuleList,
    flags: Flags,
    sheetName: string,
    callback: (rule: CSSStyleRule | CSSKeyframeRule, flags: Flags, sheetName: string) => void,
  ) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule || rule instanceof CSSKeyframeRule) {
        callback(rule, flags, sheetName)
        if (rule instanceof CSSStyleRule && rule.cssRules.length > 0)
          visit(rule.cssRules, flags, sheetName, callback)
      } else if (rule instanceof CSSMediaRule) {
        visit(
          rule.cssRules,
          {
            print: flags.print || printOnly(rule),
            matches: flags.matches && window.matchMedia(rule.media.mediaText).matches,
          },
          sheetName,
          callback,
        )
      } else if (rule instanceof CSSSupportsRule) {
        const ok = CSS.supports(rule.conditionText)
        visit(rule.cssRules, { ...flags, matches: flags.matches && ok }, sheetName, callback)
      } else if (rule instanceof CSSImportRule) {
        try {
          if (rule.styleSheet) visit(rule.styleSheet.cssRules, flags, sheetName, callback)
        } catch {
          report.unreadable.push(rule.href)
        }
      } else if ('cssRules' in rule && rule.cssRules && !(rule instanceof CSSFontFaceRule)) {
        // @layer, @container, @scope… : on descend sans évaluer la condition.
        visit(rule.cssRules as CSSRuleList, flags, sheetName, callback)
      }
    }
  }

  // 10.4.1 — unités absolues.
  const UNIT = /(?<![\w.])-?(?:\d+\.?\d*|\.\d+)(pt|pc|mm|cm|in)(?![\w%-])/gi
  const strip = (value: string) =>
    value.replace(/url\([^)]*\)/gi, '').replace(/"[^"]*"|'[^']*'/g, '')
  for (const { sheet, name } of sheets) {
    visit(sheet.cssRules, { print: false, matches: true }, name, (rule, flags) => {
      if (flags.print) return
      const style = rule.style
      for (let i = 0; i < style.length; i++) {
        const property = style.item(i)
        const value = strip(style.getPropertyValue(property))
        const found = value.match(UNIT)
        if (found) {
          report.unitsCount += 1
          if (report.units.length < 30) {
            report.units.push({
              text: `${property}: ${style.getPropertyValue(property).slice(0, 80)}`,
              selector:
                rule instanceof CSSStyleRule ? rule.selectorText.slice(0, 120) : rule.keyText,
              sheet: name,
            })
          }
        }
      }
    })
  }
  for (const el of Array.from(document.querySelectorAll('[style]'))) {
    const style = (el as HTMLElement).style
    for (let i = 0; i < style.length; i++) {
      const property = style.item(i)
      if (strip(style.getPropertyValue(property)).match(UNIT)) {
        report.unitsCount += 1
        if (report.units.length < 30) {
          report.units.push({
            text: `${property}: ${style.getPropertyValue(property).slice(0, 80)}`,
            selector: R.selector(el),
            sheet: 'attribut style',
          })
        }
      }
    }
  }

  // 10.5 — déclarations par élément.
  type Declared = { color: string[]; background: string[]; image: string[] }
  const rules: {
    selector: string
    text: string
    color: boolean
    background: boolean
    image: boolean
  }[] = []
  const IGNORED = /^(inherit|initial|unset|revert|revert-layer|currentcolor|transparent)$/i
  const isTransparent = (value: string) => {
    const v = value.trim()
    if (v === '' || /^(inherit|initial|unset|revert|revert-layer|transparent)$/i.test(v))
      return true
    if (/var\(/.test(v)) return false
    return R.rgba(v)[3] === 0
  }
  const STATES =
    /:(hover|focus|focus-visible|focus-within|active|visited|target|target-within)(?![\w-])/g
  const PSEUDO_ELEMENTS =
    /::?(before|after|marker|placeholder|first-line|first-letter|file-selector-button)\s*$/i
  for (const { sheet, name } of sheets) {
    visit(sheet.cssRules, { print: false, matches: true }, name, (rule, flags) => {
      if (!(rule instanceof CSSStyleRule) || flags.print || !flags.matches) return
      const style = rule.style
      const color = style.getPropertyValue('color')
      const bgColor = style.getPropertyValue('background-color')
      const bgImage = style.getPropertyValue('background-image')
      const declaresColor = color !== '' && !IGNORED.test(color.trim())
      const declaresBg = bgColor !== '' && !isTransparent(bgColor)
      const declaresImage =
        bgImage !== '' && !/^(none|initial|inherit|unset)$/i.test(bgImage.trim())
      if (!declaresColor && !declaresBg && !declaresImage) return
      for (const part of splitSelectors(rule.selectorText)) {
        const selector = part.replace(PSEUDO_ELEMENTS, '').replace(STATES, '').trim()
        if (selector === '' || /::/.test(selector)) continue
        rules.push({
          selector,
          text: rule.selectorText.slice(0, 100),
          color: declaresColor,
          background: declaresBg,
          image: declaresImage,
        })
      }
    })
  }
  function splitSelectors(text: string): string[] {
    const out: string[] = []
    let depth = 0
    let current = ''
    for (const ch of text) {
      if (ch === '(' || ch === '[') depth++
      if (ch === ')' || ch === ']') depth--
      if (ch === ',' && depth === 0) {
        out.push(current)
        current = ''
      } else current += ch
    }
    if (current.trim()) out.push(current)
    return out
  }

  const declared = new Map<Element, Declared>()
  const add = (el: Element, key: keyof Declared, rule: string) => {
    let entry = declared.get(el)
    if (!entry) {
      entry = { color: [], background: [], image: [] }
      declared.set(el, entry)
    }
    entry[key].push(rule)
  }
  const scope = Array.from(document.querySelectorAll('html, body, body *'))
  for (const rule of rules) {
    let matched: Element[]
    try {
      matched = scope.filter((el) => el.matches(rule.selector))
    } catch {
      continue
    }
    for (const el of matched) {
      if (rule.color) add(el, 'color', rule.text)
      if (rule.background) add(el, 'background', rule.text)
      if (rule.image) add(el, 'image', rule.text)
    }
  }
  for (const el of scope) {
    const style = (el as HTMLElement).style
    if (!style) continue
    if (style.color && !IGNORED.test(style.color)) add(el, 'color', 'attribut style')
    if (style.backgroundColor && !isTransparent(style.backgroundColor))
      add(el, 'background', 'attribut style')
    if (style.backgroundImage && style.backgroundImage !== 'none')
      add(el, 'image', 'attribut style')
  }

  const NO_TEXT = [
    'img',
    'svg',
    'video',
    'canvas',
    'iframe',
    'object',
    'embed',
    'br',
    'hr',
    'source',
    'track',
    'picture',
    'map',
    'area',
  ]
  const chainHas = (el: Element, key: keyof Declared): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      if ((declared.get(n)?.[key].length ?? 0) > 0) return true
    }
    return false
  }
  const groups = new Map<string, CssReport['colors'][number]>()
  const flag = (test: CssReport['colors'][number]['test'], rule: string, el: Element) => {
    const key = `${test}|${rule}`
    const group = groups.get(key)
    if (group) group.count += 1
    else groups.set(key, { test, rule, count: 1, ref: R.ref(el) })
  }
  for (const el of scope) {
    if (NO_TEXT.includes(el.localName) || el.closest('svg')) continue
    const own = declared.get(el)
    if (!own) continue
    if (own.color.length > 0 && !chainHas(el, 'background')) flag('10.5.1', own.color[0] ?? '', el)
    if (own.background.length > 0 && !chainHas(el, 'color'))
      flag('10.5.2', own.background[0] ?? '', el)
    if (own.image.length > 0 && !chainHas(el, 'background')) flag('10.5.3', own.image[0] ?? '', el)
  }
  report.colors = Array.from(groups.values()).slice(0, 40)
  return report
}

// ─── 10.2 : information portée par le CSS seul ──────────────────────────────

export interface GeneratedContent {
  /** Texte porté par un pseudo-élément (`::before`, `::after`). */
  value: string
  pseudo: string
  /** `true` si la valeur contient des lettres, des chiffres, un compteur ou un attribut. */
  textual: boolean
  ref: RgaaElementRef
}

export interface BackgroundImage {
  /** Adresse sans requête, ou début d'une image intégrée (data:). */
  source: string
  /** L'élément porte déjà du texte ou un nom accessible. */
  hasText: boolean
  ref: RgaaElementRef
}

/** Contenu généré par le CSS (`content:`) et images d'arrière-plan : ce qui disparaît quand les styles sont désactivés. */
export function cssOnlyInformation(): { generated: GeneratedContent[]; images: BackgroundImage[] } {
  const R = window.__rgaa
  const generated: GeneratedContent[] = []
  const images: BackgroundImage[] = []
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (el.closest('svg, script, style, noscript, template') || el.localName === 'q') continue
    if (!R.isRendered(el)) continue
    for (const pseudo of ['::before', '::after']) {
      const style = getComputedStyle(el, pseudo)
      const content = style.content
      if (!content || content === 'none' || content === 'normal') continue
      if (style.display === 'none') continue
      // Valeur textuelle entre guillemets, ou fonction (counter, attr).
      const text = content.replace(/^"|"$/g, '').replace(/\\(["\\])/g, '$1')
      if (text.trim() === '' || /^(open|close|no-open|no-close)-quote$/.test(content)) continue
      const textual = /[\p{L}\p{N}]/u.test(text) || /(counter|counters|attr)\(/.test(content)
      generated.push({ value: text.slice(0, 40), pseudo, textual, ref: R.ref(el) })
    }
    const background = getComputedStyle(el).backgroundImage
    if (background && background !== 'none' && /url\(/.test(background) && R.isVisible(el)) {
      for (const match of background.matchAll(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/g)) {
        const raw = match[1] ?? match[2] ?? match[3] ?? ''
        let source = raw
        if (!raw.startsWith('data:')) {
          try {
            source = new URL(raw, location.href).pathname
          } catch {
            source = raw
          }
        } else {
          // Image intégrée : empreinte courte du contenu, stable d'un chargement à l'autre.
          let hash = 5381
          for (let i = 0; i < raw.length; i++) hash = ((hash * 33) ^ raw.charCodeAt(i)) >>> 0
          source = `${raw.slice(0, raw.indexOf(',') > 0 ? raw.indexOf(',') : 30)}#${hash.toString(16)}`
        }
        images.push({
          source,
          hasText: R.visibleText(el) !== '' || R.accName(el) !== '',
          ref: R.ref(el),
        })
      }
    }
  }
  return { generated: generated.slice(0, 60), images: images.slice(0, 60) }
}

// ─── 10.3 : ordre de lecture ────────────────────────────────────────────────

export interface OrderCase {
  kinds: string[]
  /** Contenus concernés, dans l'ordre du code source (celui sans CSS). */
  items: string[]
  /** Le conteneur. */
  ref: RgaaElementRef
}

/**
 * Cas où l'ordre visuel contredit l'ordre du code source (celui que l'on
 * retrouve sans CSS) : empilement ou rangée inversés (`order`, `*-reverse`,
 * flottants), grille à placement explicite, éléments hors flux.
 */
export function readingOrder(): OrderCase[] {
  const R = window.__rgaa
  const cases: OrderCase[] = []
  type Kind = 'pile inversée' | 'rangée inversée' | 'grille réordonnée' | 'hors flux'
  const labelOf = (el: Element): string => {
    const text = R.visibleText(el)
    if (text) return text.slice(0, 50)
    const name = R.accName(el)
    return name ? `[${el.localName}] ${name.slice(0, 40)}` : `[${el.localName}]`
  }
  const hasContent = (el: Element): boolean => {
    if (!R.isVisible(el)) return false
    if (R.visibleText(el) !== '') return true
    return (
      el.matches('a[href], button, input, select, textarea, img, svg, video, canvas, iframe') ||
      el.querySelector(
        'a[href], button, input, select, textarea, img, svg, video, canvas, iframe',
      ) !== null
    )
  }
  type Rect = { left: number; top: number; right: number; bottom: number }
  const rectOf = (el: Element): Rect => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }
  const overlap = (a0: number, a1: number, b0: number, b1: number) =>
    Math.min(a1, b1) - Math.max(a0, b0)
  /** `second` suit `first` dans le code : s'affiche-t-il avant lui ? */
  const inverted = (first: Rect, second: Rect, rtl: boolean): Kind | null => {
    const h = overlap(first.left, first.right, second.left, second.right)
    const v = overlap(first.top, first.bottom, second.top, second.bottom)
    const minW = Math.min(first.right - first.left, second.right - second.left)
    const minH = Math.min(first.bottom - first.top, second.bottom - second.top)
    if (second.bottom <= first.top + 1 && h > minW * 0.3) return 'pile inversée'
    if (v > minH * 0.5 && (rtl ? second.left >= first.right - 1 : second.right <= first.left + 1)) {
      return 'rangée inversée'
    }
    return null
  }

  for (const container of Array.from(document.body.querySelectorAll('*'))) {
    if (cases.length >= 30) break
    if (!R.isVisible(container) || container.closest('svg')) continue
    const cs = getComputedStyle(container)
    const rtl = cs.direction === 'rtl'
    const children = Array.from(container.children).filter((child) => {
      const style = getComputedStyle(child)
      return style.display !== 'contents' && style.display !== 'none' && hasContent(child)
    })
    if (children.length < 2) continue
    const flow = children.filter((child) => {
      const position = getComputedStyle(child).position
      return position !== 'absolute' && position !== 'fixed'
    })
    const rects = new Map(children.map((child) => [child, rectOf(child)]))

    // Ordre entre frères en flux : toutes les paires (au plus 40 frères), sinon les voisins.
    const pairs: [Element, Element][] = []
    if (flow.length <= 40) {
      for (let i = 0; i < flow.length; i++) {
        for (let j = i + 1; j < flow.length; j++) {
          const a = flow[i]
          const b = flow[j]
          if (a && b) pairs.push([a, b])
        }
      }
    } else {
      for (let i = 0; i + 1 < flow.length; i++) {
        const a = flow[i]
        const b = flow[i + 1]
        if (a && b) pairs.push([a, b])
      }
    }
    const kinds = new Set<Kind>()
    const involved = new Set<Element>()
    for (const [a, b] of pairs) {
      const ra = rects.get(a)
      const rb = rects.get(b)
      if (!ra || !rb) continue
      const kind = inverted(ra, rb, rtl)
      if (kind) {
        kinds.add(kind)
        involved.add(a)
        involved.add(b)
      }
    }

    // Grille à placement explicite : l'ordre (haut puis gauche) doit suivre le code.
    if (cs.display.includes('grid') && flow.length > 1) {
      const explicit = flow.some((child) => {
        const style = getComputedStyle(child)
        return style.gridRowStart !== 'auto' || style.gridColumnStart !== 'auto'
      })
      if (explicit) {
        const sorted = [...flow].sort((a, b) => {
          const ra = rects.get(a)
          const rb = rects.get(b)
          if (!ra || !rb) return 0
          return Math.abs(ra.top - rb.top) > 4
            ? ra.top - rb.top
            : rtl
              ? rb.left - ra.left
              : ra.left - rb.left
        })
        const moved = flow.findIndex((child, index) => sorted[index] !== child)
        if (moved >= 0) {
          kinds.add('grille réordonnée')
          for (const child of flow) involved.add(child)
        }
      }
    }

    // Éléments hors flux : comparés à leurs voisins en flux dans le code.
    for (const out of children.filter((child) => !flow.includes(child))) {
      if (getComputedStyle(out).position === 'fixed' && out === children[0]) continue
      const index = Array.from(container.children).indexOf(out)
      const siblings = Array.from(container.children)
      const before = siblings
        .slice(0, index)
        .reverse()
        .find((s) => flow.includes(s))
      const after = siblings.slice(index + 1).find((s) => flow.includes(s))
      const ro = rects.get(out)
      if (!ro) continue
      const rb = before ? rects.get(before) : undefined
      const ra = after ? rects.get(after) : undefined
      if (before && rb && inverted(rb, ro, rtl)) {
        kinds.add('hors flux')
        involved.add(before)
        involved.add(out)
      }
      if (after && ra && inverted(ro, ra, rtl)) {
        kinds.add('hors flux')
        involved.add(out)
        involved.add(after)
      }
    }
    if (kinds.size > 0) {
      const inOrder = Array.from(container.children).filter((child) => involved.has(child))
      cases.push({
        kinds: Array.from(kinds),
        items: inOrder.slice(0, 12).map(labelOf),
        ref: R.ref(container),
      })
    }
  }
  return cases
}

/** Retire toutes les feuilles de styles de la page : liens, <style>, attributs `style`. */
export function stripStyles(): void {
  for (const el of Array.from(document.querySelectorAll('link[rel~="stylesheet" i], style')))
    el.remove()
  for (const el of Array.from(document.querySelectorAll('[style]'))) el.removeAttribute('style')
  document.adoptedStyleSheets = []
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (el.shadowRoot) el.shadowRoot.adoptedStyleSheets = []
  }
}

// ─── 10.8 : contenus cachés ─────────────────────────────────────────────────

export interface HiddenContent {
  /** Retiré de l'arbre d'accessibilité par `aria-hidden` mais visible à l'écran. */
  ariaHiddenVisible: {
    ref: RgaaElementRef
    text: string
    /** Contient des éléments atteignables au clavier. */
    focusable: boolean
    tag: string
    /** Le même texte (ou ses initiales) est donné par ailleurs aux technologies d'assistance, à côté. */
    redundant: boolean
  }[]
  /** Masqué à l'écran (et donc aux technologies d'assistance) alors qu'il porte du contenu. */
  hidden: {
    ref: RgaaElementRef
    text: string
    tag: string
    how: string
    /** Éléments qui le référencent : `aria-controls`, `aria-labelledby`, `aria-describedby`… */
    referencedBy: string[]
    /** Sélecteurs des contrôles (`aria-controls`) censés le révéler. */
    controllers: string[]
    /** Déclarations natives de divulgation : <details>, [popover], <dialog>. */
    native: string | null
    /** Quelques nœuds de texte du contenu, pour le retrouver à une autre largeur. */
    nodes: string[]
  }[]
}

/** Contenus masqués, et contenus visibles retirés de l'arbre d'accessibilité. */
export function hiddenContent(): HiddenContent {
  const R = window.__rgaa
  const report: HiddenContent = { ariaHiddenVisible: [], hidden: [] }
  const SKIP =
    'script, style, noscript, template, head, title, meta, link, svg, datalist, option, optgroup, source, track'
  const words = (text: string) => /[\p{L}\p{N}]/u.test(text)

  // Éléments qui référencent des identifiants.
  const refs = new Map<string, { kind: string; el: Element }[]>()
  for (const [attr, kind] of [
    ['aria-controls', 'controls'],
    ['aria-labelledby', 'labelledby'],
    ['aria-describedby', 'describedby'],
    ['aria-owns', 'owns'],
    ['aria-details', 'details'],
    ['aria-errormessage', 'errormessage'],
    ['for', 'for'],
    ['list', 'list'],
  ] as const) {
    for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) {
      for (const id of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) {
        const list = refs.get(id) ?? []
        list.push({ kind, el })
        refs.set(id, list)
      }
    }
  }

  const textNodes = (root: Element): string[] => {
    const out: string[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node && out.length < 6; node = walker.nextNode()) {
      const value = R.norm(node.nodeValue)
      if (value) out.push(value)
    }
    return out
  }
  /** Texte restitué aux technologies d'assistance autour de `el` (jusqu'à trois niveaux), hors `el` et hors contenus masqués. */
  const assistiveAround = (el: Element): string => {
    let out = ''
    let scope: Element | null = el.parentElement
    for (let depth = 0; scope && depth < 3; depth++, scope = scope.parentElement) {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
      let text = ''
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const owner = node.parentElement
        if (!owner || el.contains(owner) || owner.closest('[aria-hidden="true"], script, style'))
          continue
        text += ` ${node.nodeValue ?? ''}`
      }
      out = R.norm(text)
      if (out) break
    }
    return out
  }
  const redundantWith = (el: Element, text: string): boolean => {
    const around = assistiveAround(el).toLowerCase()
    if (!around) return false
    const lower = text.toLowerCase()
    if (lower.length >= 2 && around.includes(lower)) return true
    // Initiales d'un nom (« VB » pour « Valérie Bernard ») : pastille décorative.
    const letters = text.replace(/[^\p{L}]/gu, '')
    if (letters.length >= 1 && letters.length <= 4 && text === text.toUpperCase()) {
      const initials = around
        .split(/\s+/)
        .map((w) => w.charAt(0))
        .join('')
      return initials.includes(letters.toLowerCase())
    }
    return false
  }
  const seenHidden = new Set<Element>()
  const seenAria = new Set<Element>()
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (el.matches(SKIP) || el.closest(SKIP)) continue
    // 1. aria-hidden="true" sur du contenu visible.
    if (
      el.getAttribute('aria-hidden') === 'true' &&
      !el.parentElement?.closest('[aria-hidden="true"]')
    ) {
      if (R.isVisible(el) && !seenAria.has(el)) {
        seenAria.add(el)
        const text = R.visibleText(el)
        const focusable =
          R.tabbables(el).length > 0 ||
          (el.matches('a[href], button, input, select, textarea, [tabindex]') &&
            (el as HTMLElement).tabIndex >= 0)
        if (focusable || words(text)) {
          report.ariaHiddenVisible.push({
            ref: R.ref(el),
            text: text.slice(0, 120),
            focusable,
            tag: el.localName,
            redundant: !focusable && redundantWith(el, text),
          })
        }
      }
    }
    // 2. Contenu masqué à l'écran (racine seulement : le parent est visible).
    if (R.isRendered(el)) continue
    const parent = el.parentElement
    if (parent && !R.isRendered(parent) && !parent.matches('body')) continue
    if (seenHidden.has(el)) continue
    seenHidden.add(el)
    const text = R.norm(el.textContent)
    const media =
      el.matches('img, video, audio, iframe, canvas, object, embed') ||
      el.querySelector(
        'img, video, audio, iframe, canvas, object, embed, input, button, a[href]',
      ) !== null
    if (!words(text) && !media) continue
    const style = getComputedStyle(el)
    const how = el.hasAttribute('hidden')
      ? 'attribut hidden'
      : style.display === 'none'
        ? 'display: none'
        : style.visibility === 'hidden' || style.visibility === 'collapse'
          ? 'visibility: hidden'
          : 'masqué par un ancêtre'
    const ids = [el.id, ...Array.from(el.querySelectorAll('[id]')).map((n) => n.id)].filter(Boolean)
    const referencedBy: string[] = []
    const controllers: string[] = []
    for (const id of ids) {
      for (const { kind, el: from } of refs.get(id) ?? []) {
        if (!referencedBy.includes(kind)) referencedBy.push(kind)
        if (kind === 'controls') controllers.push(R.selector(from))
      }
    }
    const native = el.closest('details')
      ? 'details'
      : el.closest('[popover]')
        ? 'popover'
        : el.closest('dialog')
          ? 'dialog'
          : null
    report.hidden.push({
      ref: R.ref(el),
      text: text.slice(0, 120),
      tag: el.localName,
      how,
      referencedBy,
      controllers,
      native,
      nodes: textNodes(el),
    })
  }
  report.ariaHiddenVisible = report.ariaHiddenVisible.slice(0, 60)
  report.hidden = report.hidden.slice(0, 80)
  return report
}

// ─── 10.6 : liens signalés par la couleur seule ─────────────────────────────

export interface InlineLink {
  ref: RgaaElementRef
  text: string
  /** Distinctions autres que la couleur (soulignement, graisse, bordure, icône…). */
  indicators: string[]
  /** Contraste entre la couleur du lien et celle du texte qui l'entoure. */
  contrast: number
  linkColor: string
  textColor: string
  /** Texte qui entoure le lien (extrait). */
  around: string
}

/**
 * Liens placés dans du texte courant (le bloc contient d'autres mots que le
 * lien) : ce qui les distingue du texte environnant, et le contraste des couleurs.
 * Les liens de navigation, de menu et de barre d'outils sont d'une nature évidente.
 */
export function inlineLinks(): InlineLink[] {
  const R = window.__rgaa
  const out: InlineLink[] = []
  const backdropOf = (el: Element): number[] => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = R.rgba(getComputedStyle(n).backgroundColor)
      if (c[3] >= 0.95) return [c[0], c[1], c[2]]
    }
    return [255, 255, 255]
  }
  const flat = (el: Element, back: number[]) => R.blend(R.rgba(getComputedStyle(el).color), back)
  const hasPseudoIcon = (el: Element) =>
    ['::before', '::after'].some((pseudo) => {
      const content = getComputedStyle(el, pseudo).content
      return content !== 'none' && content !== 'normal' && content !== '""' && content !== "''"
    })

  for (const a of Array.from(document.body.querySelectorAll('a[href]'))) {
    if (
      !R.isVisible(a) ||
      a.closest(
        'nav, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"], [role="toolbar"], [role="button"]',
      )
    )
      continue
    const linkText = R.visibleText(a)
    if (!linkText) continue
    // Un lien de texte est en ligne : un lien qui forme son propre bloc (logo, carte, bouton) n'est pas « dans » un texte.
    if (!getComputedStyle(a).display.startsWith('inline')) continue
    // Bloc de texte : premier ancêtre qui n'est pas en ligne.
    let block: Element | null = a.parentElement
    while (block && ['inline', 'contents'].includes(getComputedStyle(block).display))
      block = block.parentElement
    if (!block) continue
    // Texte environnant : nœuds de texte du bloc hors de tout lien.
    let around = ''
    let owner: Element | null = null
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (
        !parent ||
        parent.closest('a[href], button, script, style, [aria-hidden="true"]') ||
        !R.isVisible(parent)
      )
        continue
      // Même flux de texte que le lien : pas d'ancêtre de type bloc entre le texte et le bloc commun.
      let sameFlow = true
      for (let n: Element | null = parent; n && n !== block; n = n.parentElement) {
        if (
          !getComputedStyle(n).display.startsWith('inline') &&
          getComputedStyle(n).display !== 'contents'
        )
          sameFlow = false
      }
      if (!sameFlow) continue
      const value = R.norm(node.nodeValue)
      if (!/[\p{L}\p{N}]{2}/u.test(value)) continue
      around += ` ${value}`
      owner ??= parent
    }
    around = R.norm(around)
    if (!owner || !/[\p{L}]{2,}/u.test(around)) continue

    const back = backdropOf(a)
    const own = getComputedStyle(a)
    const surround = getComputedStyle(owner)
    const indicators: string[] = []
    let decorated = false
    for (let n: Element | null = a.parentElement; n; n = n.parentElement) {
      if (getComputedStyle(n).textDecorationLine.includes('underline')) decorated = true
      if (n === block) break
    }
    if (own.textDecorationLine.includes('underline') && !decorated) indicators.push('soulignement')
    if (Number.parseInt(own.fontWeight, 10) - Number.parseInt(surround.fontWeight, 10) >= 100)
      indicators.push('graisse')
    if (own.fontStyle !== surround.fontStyle) indicators.push('italique')
    if (own.fontFamily !== surround.fontFamily) indicators.push('police')
    if (Math.abs(Number.parseFloat(own.fontSize) - Number.parseFloat(surround.fontSize)) > 1)
      indicators.push('taille')
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      if (
        own[`border${side}Style`] !== 'none' &&
        Number.parseFloat(own[`border${side}Width`]) > 0
      ) {
        indicators.push('bordure')
        break
      }
    }
    if (R.rgba(own.backgroundColor)[3] > 0.1 || own.backgroundImage !== 'none')
      indicators.push('fond')
    if (own.boxShadow !== 'none') indicators.push('ombre')
    if (a.querySelector('svg, img') || hasPseudoIcon(a)) indicators.push('icône')

    const linkRgb = flat(a, back)
    const textRgb = flat(owner, back)
    out.push({
      ref: R.ref(a),
      text: linkText.slice(0, 80),
      indicators,
      contrast: Math.round(R.contrast(linkRgb, textRgb) * 100) / 100,
      linkColor: `rgb(${linkRgb.join(', ')})`,
      textColor: `rgb(${textRgb.join(', ')})`,
      around: around.slice(0, 80),
    })
  }
  return out.slice(0, 200)
}

// ─── 10.9 et 10.10 : information donnée par la forme, la taille ou la position ──

export interface ShapeCandidate {
  kind: 'texte' | 'image' | 'média temporel' | 'média non temporel'
  /** Ce qui est jugé : phrase, groupe de contrôles, source du média. */
  evidence: Record<string, string>
  /** Ce qui suggère l'indication visuelle. */
  reason: string
  ref: RgaaElementRef
}

/**
 * Repère les endroits où une information peut n'être donnée que par la forme, la
 * taille ou la position : consignes qui désignent par la position ou la forme,
 * état actif signalé par le seul style, séries d'icônes sans alternative, médias.
 */
export function shapeCandidates(): ShapeCandidate[] {
  const R = window.__rgaa
  const out: ShapeCandidate[] = []
  const NOUN =
    'bouton|boutons|lien|liens|menu|image|images|icône|icônes|pictogramme|formulaire|champ|zone|colonne|tableau|case|onglet|encadré|bloc|texte|illustration|photo|carte|plan|vidéo|schéma|graphique|barre|flèche|logo|cadre|liste|panneau'
  const POSITION =
    'en haut|en bas|à droite|à gauche|sur la droite|sur la gauche|de droite|de gauche|ci-contre|à côté|au-dessus|au-dessous|ci-dessus|ci-dessous|en dessous'
  // `\b` ne connaît pas les lettres accentuées : bornes par lookarounds Unicode.
  const L = '(?<![\\p{L}])'
  const R_ = '(?![\\p{L}])'
  const positional = new RegExp(
    `${L}(?:${NOUN})${R_}[^.!?;:]{0,40}${L}(?:${POSITION})${R_}|${L}(?:${POSITION})${R_}[^.!?;:]{0,40}${L}(?:${NOUN})${R_}`,
    'iu',
  )
  const shape = new RegExp(
    `${L}(?:bouton|icône|pictogramme|picto|symbole|cercle|carré|rond|triangle|flèche|étoile|losange|case)s?\\s+(?:rond|ronde|carré|carrée|triangulaire|rectangulaire|ovale)s?${R_}|${L}(?:grand|grande|petit|petite|gros|grosse)s?\\s+(?:${NOUN})${R_}`,
    'iu',
  )

  // 1. Consignes qui désignent un élément par sa position, sa forme ou sa taille.
  const seen = new Set<string>()
  for (const block of Array.from(
    document.body.querySelectorAll(
      'p, li, td, th, dd, dt, label, legend, figcaption, h1, h2, h3, h4, h5, h6, summary, div, span',
    ),
  )) {
    if (
      block.closest('script, style, noscript, template, svg, nav[aria-label], [aria-hidden="true"]')
    )
      continue
    // Seulement les blocs qui portent eux-mêmes du texte.
    const own = Array.from(block.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.nodeValue ?? '')
      .join(' ')
    if (R.norm(own).length < 12 || !R.isVisible(block)) continue
    const text = R.visibleText(block)
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const reason = positional.test(sentence)
        ? 'position'
        : shape.test(sentence)
          ? 'forme ou taille'
          : null
      if (!reason || seen.has(sentence)) continue
      seen.add(sentence)
      out.push({
        kind: 'texte',
        evidence: { phrase: sentence.slice(0, 200) },
        reason: `désigne un élément par sa ${reason}`,
        ref: R.ref(block),
      })
    }
  }

  // 2. État actif signalé par le style seul : un contrôle du groupe se distingue sans aria-current/selected/pressed.
  const STATE = ['aria-current', 'aria-selected', 'aria-pressed', 'aria-checked', 'aria-expanded']
  const styleOf = (el: Element) => {
    const cs = getComputedStyle(el)
    return [
      cs.fontWeight,
      cs.textDecorationLine,
      cs.backgroundColor,
      cs.borderBottomWidth,
      cs.borderTopWidth,
      cs.fontStyle,
      cs.boxShadow,
    ].join('|')
  }
  for (const group of Array.from(
    document.body.querySelectorAll(
      'ul, ol, [role="tablist"], [role="menubar"], [role="toolbar"], nav',
    ),
  )) {
    if (!R.isVisible(group)) continue
    const items = Array.from(group.children)
      .map((li) =>
        li.matches('a[href], button, [role]')
          ? li
          : li.querySelector('a[href], button, [role="tab"], [role="menuitem"]'),
      )
      .filter((el): el is Element => el !== null && R.isVisible(el) && R.visibleText(el) !== '')
    if (items.length < 3) continue
    const signatures = items.map(styleOf)
    const counts = new Map<string, number>()
    for (const sig of signatures) counts.set(sig, (counts.get(sig) ?? 0) + 1)
    if (counts.size !== 2) continue
    const outlierSig = Array.from(counts.entries()).find(([, n]) => n === 1)?.[0]
    if (!outlierSig) continue
    const index = signatures.indexOf(outlierSig)
    const outlier = items[index]
    if (!outlier) continue
    if (
      STATE.some((attr) => outlier.hasAttribute(attr) || outlier.closest(`[${attr}]`) === outlier)
    )
      continue
    if (items.some((el) => STATE.some((attr) => el.hasAttribute(attr)))) continue
    // Un texte masqué ou visible dans le contrôle qui dit l'état (« page actuelle ») est une alternative.
    out.push({
      kind: 'texte',
      evidence: {
        groupe: items.map((el) => R.visibleText(el).slice(0, 30)).join(' | '),
        distinct: R.visibleText(outlier).slice(0, 40),
      },
      reason:
        'un contrôle du groupe se distingue par le style seul (sans aria-current, aria-selected ou équivalent)',
      ref: R.ref(outlier),
    })
  }

  // 3. Série d'icônes ou d'images sans texte ni alternative commune (notes, jauges, niveaux).
  for (const parent of Array.from(document.body.querySelectorAll('*'))) {
    if (!R.isVisible(parent)) continue
    const icons = Array.from(parent.children).filter(
      (c) => c.matches('svg, img, [role="img"]') && R.isVisible(c),
    )
    if (icons.length < 3 || icons.length !== parent.children.length) continue
    if (
      R.norm(parent.textContent) !== '' ||
      parent.hasAttribute('aria-label') ||
      parent.hasAttribute('aria-labelledby') ||
      parent.getAttribute('role') === 'img'
    )
      continue
    if (parent.closest('[aria-hidden="true"]')) continue
    const alts = icons.map((c) => R.accName(c))
    // Des alternatives toutes différentes décrivent chaque image ; vides ou identiques, seul le nombre ou la forme informe.
    if (new Set(alts).size === icons.length && alts.every((a) => a !== '')) continue
    out.push({
      kind: 'image',
      evidence: {
        motif: `${icons.length} ${icons[0]?.localName ?? 'image'} consécutifs sans texte`,
        alternatives: Array.from(new Set(alts)).join(' | ').slice(0, 80),
      },
      reason: 'série d’images ou d’icônes dont seul le nombre ou la forme renseigne',
      ref: R.ref(parent),
    })
  }

  // 4. Médias : le contenu d'un média ne se juge qu'à la vue ou à l'écoute.
  const TEMPORAL_HOSTS = /(youtube|youtu\.be|vimeo|dailymotion|peertube|canal-u|player\.)/i
  for (const el of Array.from(
    document.body.querySelectorAll('video, audio, object, embed, canvas, iframe'),
  )) {
    if (!R.isVisible(el)) continue
    const raw =
      el.getAttribute('src') ??
      el.getAttribute('data') ??
      el.querySelector('source')?.getAttribute('src') ??
      ''
    let source = raw
    try {
      const url = new URL(raw, location.href)
      source = url.host === location.host ? url.pathname : `${url.host}${url.pathname}`
    } catch {
      // adresse brute conservée
    }
    const temporal =
      el.matches('video, audio') || (el.localName === 'iframe' && TEMPORAL_HOSTS.test(raw))
    out.push({
      kind: temporal ? 'média temporel' : 'média non temporel',
      evidence: { balise: el.localName, source: source || R.accName(el) || '(sans source)' },
      reason: temporal ? 'média temporel' : 'média non temporel',
      ref: R.ref(el),
    })
  }
  return out.slice(0, 80)
}

/**
 * Fait défiler la page de haut en bas puis revient en haut : les contenus qui
 * n'apparaissent qu'à l'approche (révélation au défilement) sont alors en place,
 * quelle que soit la charge de la machine. Modifie la position de défilement :
 * à n'appeler que sur une page neuve.
 */
export async function revealOnScroll(): Promise<void> {
  const step = Math.max(200, window.innerHeight - 100)
  for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
    window.scrollTo(0, y)
    await new Promise((resolve) => setTimeout(resolve, 70))
  }
  window.scrollTo(0, 0)
  await new Promise((resolve) => setTimeout(resolve, 450))
}

// ─── États ouverts : menus, panneaux, accordéons ────────────────────────────

/**
 * Contrôles qui déplient quelque chose (boutons `aria-expanded="false"`, `<summary>`,
 * `aria-haspopup`) et ne mènent pas ailleurs : sélecteurs des premiers visibles.
 */
export function disclosureTogglers(limit: number): string[] {
  const R = window.__rgaa
  const seen = new Set<string>()
  const out: string[] = []
  for (const el of Array.from(
    document.body.querySelectorAll(
      'summary, button[aria-expanded="false"], [role="button"][aria-expanded="false"], button[aria-haspopup]:not([aria-haspopup="false"])',
    ),
  )) {
    if (!R.isVisible(el) || el.closest('[aria-hidden="true"], [inert]')) continue
    // Un groupe de contrôles qui ouvrent le même type de panneau : le premier de chaque `aria-controls` suffit.
    const group = el.getAttribute('aria-controls') ?? R.selector(el)
    if (seen.has(group)) continue
    seen.add(group)
    out.push(R.selector(el))
    if (out.length >= limit) break
  }
  return out
}

/** Ouvre ou referme un contrôle de divulgation (clic scripté : un lien n'est jamais suivi). Renvoie son nom accessible, ou `null` s'il a disparu. */
export function setToggle(arg: { selector: string; open: boolean }): string | null {
  const R = window.__rgaa
  const el = document.querySelector(arg.selector) as HTMLElement | null
  if (!el) return null
  const isOpen =
    el.localName === 'summary'
      ? (el.parentElement?.hasAttribute('open') ?? false)
      : el.getAttribute('aria-expanded') === 'true'
  const label = R.accName(el) || R.visibleText(el) || el.localName
  if (isOpen !== arg.open) el.click()
  return label.slice(0, 60)
}
