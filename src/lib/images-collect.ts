import type { Page } from 'playwright'
import type { ElementRef } from '../core/types.ts'
import { fingerprint, normalizeImageSource } from './images-source.ts'

/**
 * Inventaire des éléments graphiques d'une page (thématique 1) : `<img>`,
 * `[role=img]`, `<area>`, `<input type=image>`, `<svg>`, `<object>`, `<embed>`,
 * `<canvas>`. Tout ce qui se lit dans le DOM est relevé en une seule passe dans
 * le navigateur ; les décisions sont prises côté Node (`themes/01-images.ts`).
 */

export type GraphicType = 'img' | 'area' | 'input' | 'object' | 'embed' | 'svg' | 'canvas'

export interface RawGraphic {
  type: GraphicType
  tag: string
  /** `role="img"` sur une balise qui n'est pas une image (span, div…). */
  roleImgTag: boolean
  ref: ElementRef
  /** Adresse brute (`src`, `data`) ; vide pour svg, canvas et role=img. */
  rawSource: string
  /** svg : viewBox + formes ; role=img : texte contenu. Sert d'empreinte. */
  content: string
  /** Rôle ARIA explicite (minuscule), ou ''. */
  role: string
  ariaHiddenSelf: boolean
  /** Un ancêtre est `aria-hidden="true"` ou `inert`. */
  hiddenByAncestor: boolean
  alt: string | null
  title: string
  ariaLabel: string
  /** Texte résolu de `aria-labelledby` ('' si absent ou vide). */
  labelledbyText: string
  hasLabelledby: boolean
  /** svg : texte du `<title>` enfant direct. */
  svgTitle: string
  /** Texte des balises `<desc>` / `<title>` / attributs `title` / `aria-label` à l'intérieur d'un svg (hors élément lui-même). */
  svgInnerAlternative: string
  /** object, embed, canvas : contenu alternatif entre les balises. */
  fallbackText: string
  fallbackHasChildren: boolean
  longdesc: string
  describedby: { ids: string[]; missing: string[]; text: string } | null
  ismap: boolean
  /** area : l'attribut `href` est présent. */
  hasHref: boolean
  usemap: string
  width: number
  height: number
  /** Lien, bouton ou autre contrôle qui contient l'image. */
  control: { kind: string; otherName: boolean } | null
  /** `<figure>` qui contient l'image. */
  figure: {
    hasCaption: boolean
    role: string
    ariaLabel: string
    captionText: string
    ref: ElementRef
  } | null
  /** Le parent direct porte du texte autre que l'image. */
  textNeighbor: boolean
  /** Lien ou bouton placé immédiatement après l'image (texte du lien, ou '(sans texte)'). */
  adjacentControl: string | null
  captchaHint: boolean
  /** Rang de l'élément dans le DOM au moment de l'inventaire. */
  index: number
}

export interface Graphic extends RawGraphic {
  /** Adresse d'origine normalisée (ou '' sans adresse). */
  source: string
  /** Empreinte du contenu pour svg / role=img / canvas. */
  print: string
  /** Aperçu lisible du contenu (début des formes). */
  preview: string
  /** Page d'où provient l'inventaire (capture d'écran possible seulement sur la page de base). */
  fromBase: boolean
}

/** S'exécute dans le navigateur : ne rien y référencer d'extérieur. */
export function collectInPage(): RawGraphic[] {
  const R = window.__rgaa
  const norm = R.norm
  const out: RawGraphic[] = []
  const GRAPHIC_TAGS = new Set(['img', 'svg', 'canvas', 'object', 'embed'])

  const resolveIds = (el: Element, attribute: string) => {
    const ids = norm(el.getAttribute(attribute)).split(' ').filter(Boolean)
    const nodes = ids.map((id) => document.getElementById(id))
    return {
      ids,
      missing: ids.filter((_, i) => !nodes[i]),
      text: norm(
        nodes
          .filter((node): node is HTMLElement => !!node)
          .map((node) => node.textContent ?? '')
          .join(' '),
      ),
    }
  }

  const isGraphicNode = (node: Element) =>
    GRAPHIC_TAGS.has(node.localName) || (node.getAttribute('role') ?? '').toLowerCase() === 'img'

  /** Texte accessible propre d'un conteneur, sans l'image `skip` ni les contenus masqués. */
  const ownText = (container: Element, skip: Element): string => {
    let text = ''
    const walk = (node: Node) => {
      if (node.nodeType === 3) {
        text += ` ${node.nodeValue ?? ''}`
        return
      }
      if (node.nodeType !== 1) return
      const el = node as Element
      if (el === skip) return
      const tag = el.localName
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return
      if (R.isHiddenFromAT(el)) return
      if (isGraphicNode(el)) {
        const own = norm(
          el.getAttribute('aria-label') ||
            (el.localName === 'img' ? el.getAttribute('alt') : '') ||
            (el.localName === 'svg' ? (el.querySelector(':scope > title')?.textContent ?? '') : ''),
        )
        if (own) text += ` ${own}`
        return
      }
      for (const child of Array.from(el.childNodes)) walk(child)
    }
    for (const child of Array.from(container.childNodes)) walk(child)
    return norm(text)
  }

  const shapes = (svg: Element): string => {
    const parts: string[] = [svg.getAttribute('viewBox') ?? '']
    const attrs = [
      'd',
      'cx',
      'cy',
      'r',
      'rx',
      'ry',
      'x',
      'y',
      'width',
      'height',
      'points',
      'x1',
      'y1',
      'x2',
      'y2',
    ]
    for (const node of Array.from(svg.querySelectorAll('*'))) {
      if (['title', 'desc', 'style', 'metadata'].includes(node.localName)) continue
      let part = `${node.localName}:${attrs
        .map((name) => node.getAttribute(name))
        .filter((value) => value !== null)
        .join(',')}`
      if (node.localName === 'use') {
        const href = node.getAttribute('href') ?? node.getAttribute('xlink:href') ?? ''
        const target = href.startsWith('#') ? document.getElementById(href.slice(1)) : null
        part += `→${target ? norm(target.innerHTML) : href}`
      }
      if (node.localName === 'text') part += `«${norm(node.textContent)}»`
      parts.push(part)
    }
    return parts.join('|')
  }

  const ROLE_CONTROL =
    'a[href], button, [role="link"], [role="button"], summary, [role="menuitem"], [role="tab"]'

  const controlOf = (el: Element): RawGraphic['control'] => {
    const control = el.parentElement?.closest(ROLE_CONTROL)
    if (!control) return null
    const kind = control.matches('a, [role="link"]')
      ? 'lien'
      : control.matches('button, [role="button"], summary')
        ? 'bouton'
        : 'contrôle'
    const labelled =
      norm(control.getAttribute('aria-label')) !== '' ||
      resolveIds(control, 'aria-labelledby').text !== '' ||
      norm(control.getAttribute('title')) !== ''
    return { kind, otherName: labelled || ownText(control, el) !== '' }
  }

  const nextControl = (el: Element): string | null => {
    let sibling = el.nextElementSibling
    if (!sibling && el.parentElement && el.parentElement.children.length === 1) {
      sibling = el.parentElement.nextElementSibling
    }
    if (!sibling) return null
    const selector = 'a[href], button, [role="button"], [role="link"]'
    const control = sibling.matches(selector)
      ? sibling
      : sibling.querySelector(`:scope > ${selector}`)
    if (!control) return null
    return norm(R.visibleText(control)).slice(0, 80) || '(sans texte)'
  }

  const imageAddress = (el: Element, tag: string): string => {
    if (tag === 'img') return el.getAttribute('src') || (el as HTMLImageElement).currentSrc || ''
    if (tag === 'object') return el.getAttribute('data') ?? ''
    if (tag === 'embed' || tag === 'input') return el.getAttribute('src') ?? ''
    return ''
  }

  const isImageType = (value: string | null) => /^image\//i.test(value ?? '')

  const all = Array.from(
    document.querySelectorAll(
      'img, svg, canvas, object, embed, area, input[type="image" i], [role="img" i]',
    ),
  )
  let index = -1
  for (const el of all) {
    index += 1
    const tag = el.localName
    // Intérieur d'un svg : seul le svg le plus extérieur est une image.
    if (tag === 'svg' ? el.parentElement?.closest('svg') : el.closest('svg')) continue
    const role = (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? ''
    let type: GraphicType
    let roleImgTag = false
    if (tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'area') {
      type = tag
    } else if (tag === 'input') {
      type = 'input'
    } else if (tag === 'object' || tag === 'embed') {
      const address = imageAddress(el, tag)
      if (
        !isImageType(el.getAttribute('type')) &&
        !/\.(png|jpe?g|gif|svg|webp|avif|bmp)(\?|#|$)/i.test(address) &&
        role !== 'img'
      ) {
        continue
      }
      type = tag
    } else if (role === 'img') {
      type = 'img'
      roleImgTag = true
    } else {
      continue
    }

    let rect = { width: 0, height: 0 }
    if (type === 'area') {
      const map = el.closest('map')
      const name = map?.getAttribute('name') ?? map?.id ?? ''
      const owner = name
        ? Array.from(document.querySelectorAll('[usemap]')).find(
            (node) => node.getAttribute('usemap') === `#${name}`,
          )
        : null
      if (!owner || !R.isRendered(owner)) continue
      const box = owner.getBoundingClientRect()
      rect = { width: box.width, height: box.height }
    } else {
      if (!R.isRendered(el)) continue
      const box = el.getBoundingClientRect()
      rect = { width: box.width, height: box.height }
      // Coquille sans boîte (sprite svg de largeur 0) : rien n'est affiché.
      if (box.width === 0 && box.height === 0) continue
    }

    const alt = el.getAttribute('alt')
    const labelled = resolveIds(el, 'aria-labelledby')
    const describedby = el.hasAttribute('aria-describedby')
      ? resolveIds(el, 'aria-describedby')
      : null
    const svgTitleNode = type === 'svg' ? el.querySelector(':scope > title') : null

    let svgInnerAlternative = ''
    if (type === 'svg') {
      const parts: string[] = []
      for (const node of Array.from(el.querySelectorAll('*'))) {
        if (node.localName === 'title' || node.localName === 'desc') {
          parts.push(norm(node.textContent))
        }
        parts.push(norm(node.getAttribute('title')), norm(node.getAttribute('aria-label')))
      }
      svgInnerAlternative = norm(parts.filter(Boolean).join(' '))
    }

    let fallbackText = ''
    let fallbackHasChildren = false
    if (type === 'object' || type === 'canvas' || type === 'embed') {
      fallbackText = norm(el.textContent)
      fallbackHasChildren = el.children.length > 0 || fallbackText !== ''
    }

    const fig = el.closest('figure')
    let figure: RawGraphic['figure'] = null
    if (fig) {
      const caption = Array.from(fig.children).find((child) => child.localName === 'figcaption')
      figure = {
        hasCaption: !!caption,
        role: (fig.getAttribute('role') ?? '').trim().toLowerCase(),
        ariaLabel: norm(fig.getAttribute('aria-label')),
        captionText: caption ? R.visibleText(caption) : '',
        ref: R.ref(fig),
      }
    }

    const hintSource = [
      el.getAttribute('src'),
      el.getAttribute('data'),
      alt,
      el.id,
      el.getAttribute('name'),
      el.getAttribute('class'),
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.parentElement?.id,
    ].join(' ')

    out.push({
      type,
      tag,
      roleImgTag,
      ref: R.ref(el),
      rawSource: imageAddress(el, tag),
      content:
        type === 'svg'
          ? shapes(el)
          : roleImgTag || type === 'canvas'
            ? `${tag}|${norm(el.textContent)}|${el.getAttribute('width') ?? ''}x${el.getAttribute('height') ?? ''}`
            : '',
      role,
      ariaHiddenSelf: el.getAttribute('aria-hidden') === 'true',
      hiddenByAncestor: !!el.parentElement?.closest('[aria-hidden="true"], [inert]'),
      alt,
      title: norm(el.getAttribute('title')),
      ariaLabel: norm(el.getAttribute('aria-label')),
      labelledbyText: labelled.text,
      hasLabelledby: el.hasAttribute('aria-labelledby'),
      svgTitle: svgTitleNode ? norm(svgTitleNode.textContent) : '',
      svgInnerAlternative,
      fallbackText,
      fallbackHasChildren,
      longdesc: norm(el.getAttribute('longdesc')),
      describedby,
      ismap: el.hasAttribute('ismap'),
      hasHref: el.hasAttribute('href'),
      usemap: el.getAttribute('usemap') ?? '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      control: type === 'input' || type === 'area' ? null : controlOf(el),
      figure,
      textNeighbor: (() => {
        // Le texte voisin est cherché dans le parent, puis dans le grand-parent (icône dans une pastille).
        let container = el.parentElement
        for (
          let depth = 0;
          container && depth < 2;
          depth += 1, container = container.parentElement
        ) {
          if (ownText(container, el) !== '') return true
        }
        return false
      })(),
      adjacentControl: nextControl(el),
      captchaHint: /captcha/i.test(hintSource),
      index,
    })
  }
  return out
}

/** Passe d'inventaire sur une page, avec normalisation des sources côté Node. */
export async function collectGraphics(page: Page, fromBase: boolean): Promise<Graphic[]> {
  const raw = await page.evaluate(collectInPage)
  const base = page.url()
  return raw.map((graphic) => {
    const source = normalizeImageSource(graphic.rawSource, base)
    const print = graphic.content ? fingerprint(graphic.content) : ''
    const preview = graphic.content.replace(/\s+/g, ' ').slice(0, 70)
    return { ...graphic, source, print, preview, fromBase }
  })
}

/** Signature d'un élément : deux éléments de même signature reçoivent le même verdict. */
export function graphicSignature(graphic: Graphic): string {
  return JSON.stringify([
    graphic.type,
    graphic.roleImgTag,
    graphic.source,
    graphic.print,
    graphic.role,
    graphic.ariaHiddenSelf,
    graphic.hiddenByAncestor,
    graphic.alt,
    graphic.title,
    graphic.ariaLabel,
    graphic.labelledbyText,
    graphic.svgTitle,
    graphic.fallbackText,
    graphic.control,
    graphic.figure && [
      graphic.figure.hasCaption,
      graphic.figure.role,
      graphic.figure.ariaLabel,
      graphic.figure.captionText,
    ],
    graphic.textNeighbor,
    graphic.adjacentControl,
    graphic.longdesc,
    graphic.describedby?.text,
  ])
}

/** Éléments à cliquer pour révéler du contenu masqué : disclosures, onglets, menus. */
const OPENERS =
  'button[aria-expanded="false"], [role="button"][aria-expanded="false"], summary, [role="tab"][aria-selected="false"], [aria-haspopup="menu"]:not([aria-expanded="true"])'

/**
 * Ouvre, sur une page à usage libre, les panneaux repliés (details, accordéons,
 * onglets, menus) et renvoie les éléments graphiques qui n'existent pas sur la
 * page de base. Les clics sont plafonnés et chacun est protégé : un contrôle
 * qui ne répond pas n'interrompt pas l'inventaire.
 */
export async function collectOpenedGraphics(
  fresh: Page,
  known: Set<string>,
  limit = 24,
): Promise<Graphic[]> {
  const found: Graphic[] = []
  const take = async () => {
    for (const graphic of await collectGraphics(fresh, false)) {
      const signature = graphicSignature(graphic)
      if (known.has(signature)) continue
      known.add(signature)
      found.push(graphic)
    }
  }
  try {
    await fresh.evaluate(() => {
      for (const details of Array.from(document.querySelectorAll('details:not([open])'))) {
        ;(details as HTMLDetailsElement).open = true
      }
    })
    await take()
    for (let clicks = 0; clicks < limit; clicks += 1) {
      const selector = await fresh.evaluate((openers) => {
        for (const el of Array.from(document.querySelectorAll(openers))) {
          if (el.hasAttribute('data-rgaa-tried')) continue
          if (!window.__rgaa.isVisible(el)) continue
          if ((el as HTMLButtonElement).disabled) continue
          // Un `summary` de details déjà ouvert est ignoré.
          if (el.localName === 'summary' && el.parentElement?.hasAttribute('open')) continue
          el.setAttribute('data-rgaa-tried', '1')
          el.setAttribute('data-rgaa-click', 'now')
          return '[data-rgaa-click="now"]'
        }
        return null
      }, OPENERS)
      if (!selector) break
      try {
        await fresh.click(selector, { timeout: 1_500, noWaitAfter: true })
        await fresh.waitForTimeout(120)
        await take()
      } catch {
        // Contrôle masqué, recouvert ou détaché : on passe au suivant.
      } finally {
        await fresh
          .evaluate(() => {
            for (const el of Array.from(document.querySelectorAll('[data-rgaa-click]'))) {
              el.removeAttribute('data-rgaa-click')
            }
          })
          .catch(() => undefined)
      }
    }
  } catch {
    // Page fermée ou navigation inattendue : on garde ce qui a été relevé.
  }
  return found
}

/** Éléments portant une image CSS (hors dégradés) sans texte : porteurs d'information possibles, non audités. */
export async function countCssImages(page: Page): Promise<number> {
  return page.evaluate(() => {
    let count = 0
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (!window.__rgaa.isRendered(el)) continue
      const background = getComputedStyle(el).backgroundImage
      if (!/url\(/.test(background)) continue
      const box = el.getBoundingClientRect()
      if (box.width < 24 || box.height < 24) continue
      if (window.__rgaa.visibleText(el) !== '') continue
      count += 1
    }
    return count
  })
}
