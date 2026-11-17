/*
 * Utilitaires injectés dans chaque page auditée, exposés sous `window.__rgaa`.
 * Fichier JavaScript brut, chargé tel quel par `addInitScript` (pas de
 * transpilation) : rester en syntaxe navigateur, sans import.
 *
 * axe-core est injecté juste avant : il fournit le calcul du nom accessible et
 * du rôle (algorithme accname), que l'on ne réécrit pas.
 */
;(() => {
  // esbuild (tsx) enveloppe les fonctions nommées dans `__name(fn, 'nom')` ;
  // sérialisées vers la page par `page.evaluate`, elles y cherchent ce global.
  if (!window.__name) window.__name = (fn) => fn

  const norm = (value) => (value || '').replace(/\s+/g, ' ').trim()

  const escapeIdent = (value) => (window.CSS?.escape ? CSS.escape(value) : value)

  /** Sélecteur CSS unique, court quand un id existe, sinon un chemin `:nth-of-type`. */
  function selector(el) {
    if (!(el instanceof Element)) return ''
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && document.querySelectorAll(`#${escapeIdent(node.id)}`).length === 1) {
        parts.unshift(`#${escapeIdent(node.id)}`)
        return parts.join(' > ')
      }
      const tag = node.localName
      const parent = node.parentElement
      if (!parent) {
        parts.unshift(tag)
        break
      }
      const sameTag = Array.from(parent.children).filter((child) => child.localName === tag)
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag)
      node = parent
    }
    if (node === document.documentElement) parts.unshift('html')
    return parts.join(' > ')
  }

  /** Balise ouvrante + début du contenu, pour situer l'élément dans le rapport. */
  function snippet(el, max = 220) {
    if (!(el instanceof Element)) return ''
    const html = norm(el.outerHTML)
    return html.length > max ? `${html.slice(0, max)}…` : html
  }

  function ref(el) {
    return { selector: selector(el), snippet: snippet(el) }
  }

  /** L'élément est-il rendu (ni `display:none`, ni `visibility:hidden`, ni hors arbre) ? */
  function isRendered(el) {
    if (!(el instanceof Element) || !el.isConnected) return false
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
    }
    const style = getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }

  /**
   * L'élément est-il visible à l'écran : rendu, boîte non nulle, non masqué par
   * `opacity:0` ni par un rognage à 1 px (technique `sr-only`) ?
   */
  function isVisible(el) {
    if (!isRendered(el)) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 1 || rect.height <= 1) {
      // Un conteneur sans boîte propre peut avoir des enfants visibles.
      return Array.from(el.children).some((child) => isVisible(child))
    }
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (Number(style.opacity) === 0) return false
      if (style.clipPath === 'inset(50%)' || style.clip === 'rect(0px, 0px, 0px, 0px)') return false
    }
    return true
  }

  /** L'élément est-il retiré de l'arbre d'accessibilité (non rendu, `aria-hidden`, `inert`) ? */
  function isHiddenFromAT(el) {
    if (!isRendered(el)) return true
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.getAttribute('aria-hidden') === 'true') return true
      if (node.hasAttribute('inert')) return true
    }
    return false
  }

  function withAxe(el, compute) {
    const axe = window.axe
    if (!axe) throw new Error('axe-core n’est pas injecté dans la page')
    if (!axe._tree) axe.setup(document.documentElement)
    const node = axe.utils.getNodeFromTree(el)
    if (!node) {
      // Élément ajouté au DOM après la construction de l'arbre virtuel : on le reconstruit.
      axe.teardown()
      axe.setup(document.documentElement)
      return compute(axe, axe.utils.getNodeFromTree(el))
    }
    return compute(axe, node)
  }

  /** Force la reconstruction de l'arbre virtuel d'axe (après une modification du DOM). */
  function resetTree() {
    if (window.axe?._tree) window.axe.teardown()
  }

  /** Nom accessible calculé (aria-labelledby, aria-label, contenu, alt, title, label…). */
  function accName(el) {
    return withAxe(el, (axe, node) =>
      node ? norm(axe.commons.text.accessibleTextVirtual(node)) : '',
    )
  }

  /** Rôle ARIA effectif (explicite, sinon implicite), ou `null`. */
  function role(el) {
    return withAxe(el, (axe, node) => (node ? axe.commons.aria.getRole(node) : null))
  }

  /** Texte visible de l'élément, sans les contenus masqués, espaces normalisés. */
  function visibleText(el) {
    let out = ''
    const walk = (node) => {
      if (node.nodeType === 3) {
        out += node.nodeValue
        return
      }
      if (node.nodeType !== 1 || !isRendered(node)) return
      const tag = node.localName
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return
      const block = getComputedStyle(node).display !== 'inline'
      if (block) out += ' '
      for (const child of node.childNodes) walk(child)
      if (block) out += ' '
    }
    walk(el)
    return norm(out)
  }

  let canvasContext = null
  /**
   * Convertit n'importe quelle couleur CSS (oklch, oklab, color-mix, hsl, nom…)
   * en sRGB 8 bits : `[r, g, b, a]`, `a` entre 0 et 1. Le navigateur fait la
   * conversion en peignant un pixel.
   */
  function rgba(color) {
    if (!canvasContext) {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      canvasContext = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
    }
    canvasContext.clearRect(0, 0, 1, 1)
    canvasContext.fillStyle = '#000'
    canvasContext.fillStyle = color
    canvasContext.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = canvasContext.getImageData(0, 0, 1, 1).data
    if (a === 0) return [0, 0, 0, 0]
    // Le canvas stocke des couleurs prémultipliées : on retrouve la couleur d'origine.
    const alpha = a / 255
    return [
      Math.min(255, Math.round(r / alpha)),
      Math.min(255, Math.round(g / alpha)),
      Math.min(255, Math.round(b / alpha)),
      Math.round(alpha * 1000) / 1000,
    ]
  }

  /** Superpose une couleur `[r,g,b,a]` sur un fond opaque `[r,g,b]`. */
  function blend(front, back) {
    const alpha = front[3] ?? 1
    return [0, 1, 2].map((i) => Math.round(front[i] * alpha + back[i] * (1 - alpha)))
  }

  /** Luminance relative WCAG d'une couleur sRGB `[r,g,b]`. */
  function luminance(rgb) {
    const channel = (value) => {
      const c = value / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
  }

  /** Rapport de contraste WCAG entre deux couleurs opaques `[r,g,b]` (1 à 21). */
  function contrast(a, b) {
    const la = luminance(a)
    const lb = luminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }

  const FOCUSABLE =
    'a[href], area[href], button, input, select, textarea, summary, iframe, audio[controls], video[controls], [contenteditable=""], [contenteditable="true"], [tabindex]'

  /** Éléments atteignables à la tabulation, dans l'ordre du DOM (tabindex ≥ 0, rendus, non désactivés). */
  function tabbables(root = document) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => {
      if (el.tabIndex < 0) return false
      if (el.disabled) return false
      if (el.localName === 'input' && el.type === 'hidden') return false
      if (!isRendered(el)) return false
      if (el.closest('[inert]')) return false
      return true
    })
  }

  window.__rgaa = {
    norm,
    selector,
    snippet,
    ref,
    isRendered,
    isVisible,
    isHiddenFromAT,
    accName,
    role,
    visibleText,
    rgba,
    blend,
    luminance,
    contrast,
    tabbables,
    resetTree,
  }
})()
