/**
 * Thématique 3 : bibliothèque exécutée dans la page (`page.evaluate(installCouleurs)`).
 *
 * Elle inventorie ce qui porte une couleur (textes, champs, icônes, images) et
 * dit, pour une position de défilement donnée, où ces éléments sont peints et
 * s'ils sont recouverts. Les pixels eux-mêmes sont lus côté Node, sur une
 * capture d'écran où le texte est rendu transparent (voir `couleurs-mesure.ts`).
 *
 * Tout ce fichier doit rester autonome : la fonction est sérialisée vers la
 * page, elle n'a accès à aucune variable du module.
 */

export type RgbaTuple = [number, number, number, number]
export type BoxTuple = [number, number, number, number]
export interface RefTuple {
  selector: string
  snippet: string
}

export interface TextDesc {
  id: number
  kind: 'texte' | 'valeur' | 'placeholder'
  text: string
  size: number
  weight: number
  /** Couleur du texte, alpha = alpha de la couleur × opacité des ancêtres. */
  color: RgbaTuple
  shadow: boolean
  /** `background-clip: text` : le texte est peint par un dégradé ou une image. */
  clipText: boolean
  disabled: boolean
  /** `aria-hidden`, `role="presentation"` : texte candidat à l'exemption « décoratif ». */
  decorative: boolean
  /** Dans un lien vers l'accueil du site (en-tête, pied) : candidat à l'exemption « logo ». */
  logo: boolean
}

export interface BorderDesc {
  side: string
  width: number
  color: RgbaTuple
}
export interface ShadowDesc {
  color: RgbaTuple
  spread: number
  blur: number
  inset: boolean
}
export interface FieldDesc {
  id: number
  /** `champ` : saisie ou liste ; `case` : case à cocher, bouton radio, interrupteur personnalisés. */
  kind: 'champ' | 'case'
  label: string
  tag: string
  role: string
  borders: BorderDesc[]
  shadows: ShadowDesc[]
  /** Distance (px) jusqu'où l'élément déborde de sa boîte (ombres, contour). */
  extent: number
  invalid: boolean
  checked: boolean
}

export interface PaintDesc {
  /** `null` : pas de peinture ; `'complexe'` : dégradé, motif ou image. */
  fill: RgbaTuple | null | 'complexe'
  stroke: RgbaTuple | null | 'complexe'
  /** Boîte de la forme en coordonnées du document. */
  box: BoxTuple
}
export interface IconDesc {
  id: number
  name: string
  /** `controle` : icône seule d'un composant sans texte visible ; `nomme` : graphique nommé. */
  role: 'controle' | 'nomme'
  paints: PaintDesc[]
  usesUse: boolean
  shapes: number
  box: BoxTuple
}

export interface ImageDesc {
  id: number
  kind: 'img' | 'svg'
  /** Source stable (sans paramètres de redimensionnement) ou résumé du graphique. */
  source: string
  name: string
  width: number
  height: number
  logo: boolean
}

export interface MediaDesc {
  kind: 'video' | 'audio' | 'canvas' | 'object' | 'embed' | 'iframe'
  source: string
  title: string
  ref: RefTuple
}

export interface ProbeResult {
  id: number
  /** `ok` mesurable ; `hors` hors du cadre ; `masque` recouvert ; `invisible` non peint. */
  status: 'ok' | 'hors' | 'masque' | 'invisible'
  boxes: BoxTuple[]
  full: boolean
  /** Texte : couleur courante, taille, graisse et signature du fond (pour comparer deux états). */
  color?: RgbaTuple
  size?: number
  weight?: number
  sig?: string
  /** Fond à pixels (image, vidéo) sous la cible. */
  media?: boolean
  /** Champs et icônes : distance (px) jusqu'où contour de focus ou ombre débordent de la boîte. */
  ringExtra?: number
}

export interface CouleursLib {
  collectText(): TextDesc[]
  collectFields(): FieldDesc[]
  /** Champs invalides (aria-invalid) déjà connus, décrits dans leur état courant. */
  invalidFields(): FieldDesc[]
  collectIcons(): IconDesc[]
  collectImages(): ImageDesc[]
  collectMedia(): MediaDesc[]
  probe(ids: number[]): ProbeResult[]
  /** Défilement à appliquer pour mesurer la première cible en attente, `null` si elle est fixe. */
  plan(ids: number[], attempts: Record<number, number>): { y: number | null; head: number } | null
  scrollTo(y: number): Promise<void>
  /** Cibles de texte dont un ancêtre est fixe ou collant : leur fond change avec le défilement. */
  pinnedTargets(): number[]
  scrollMax(): number
  ref(id: number): RefTuple | null
  /** Cibles de texte dans (ou sous) l'élément. */
  scope(element: Element): number[]
  /** Dresse la liste des éléments à explorer (`survol`, `panneau`, `envoi`), renvoie leur nombre. */
  list(kind: 'survol' | 'panneau' | 'envoi' | 'lien'): number
  /** Repère non coloré d'un lien de la liste `lien`, dans son état courant. */
  cueNow(index: number): string | null
  /** Donne le focus clavier à un élément de la liste. */
  focusIndex(index: number): void
  /** Amène l'élément `index` de la liste au centre de la fenêtre et renvoie son centre. */
  reveal(index: number): { x: number; y: number; label: string } | null
  /** Observe l'état courant autour d'un élément de la liste (`index`) ou de l'élément ayant le focus (`-1`). */
  observe(index: number): Observation
  /** Mémorise l'apparence au repos des éléments atteignables au clavier. */
  snapshotRest(): number
  /** Libellé d'un élément de la liste. */
  label(index: number): string
  isOpen(index: number): boolean
  stylesheetsReactToDark(): boolean
  mechanismCandidates(): { name: string; ref: RefTuple }[]
  linkCues(): LinkCue[]
  colorWords(): { sentence: string; ref: RefTuple }[]
  coloredInline(): ColoredInline[]
  /** Commandes sans libellé visible ni SVG ni image : l'icône est en CSS ou en police. */
  iconControls(): { name: string; ref: RefTuple }[]
  shadowHostCount(): number
  stateGroups(): StateGroup[]
  swatches(): Swatch[]
  disabledTextCount(): number
  pseudoTextCount(): number
}

export interface FocusInfo {
  ref: RefTuple
  tag: string
  /** `auto` : contour natif du navigateur, laissé tel quel. */
  nativeOutline: boolean
  outline: { color: RgbaTuple; width: number; offset: number } | null
  shadows: ShadowDesc[]
  border: { color: RgbaTuple; width: number } | null
  borderChanged: boolean
  backgroundChanged: boolean
  background: RgbaTuple
  borderColor: RgbaTuple
  /** Distance du contour de focus à la boîte (px). */
  extent: number
  box: BoxTuple
  /** Signature du fond : même signature = même fond (sans image). */
  backdrop: string
  media: boolean
}

export interface Observation {
  focus: FocusInfo | null
  texts: TextDesc[]
  fields: FieldDesc[]
  icons: IconDesc[]
  images: ImageDesc[]
  /** Mesure de chaque cible de texte à proximité de l'élément (état courant). */
  probes: ProbeResult[]
  moved: boolean
}

export interface LinkCue {
  ref: RefTuple
  text: string
  /** Repère visuel autre que la couleur au repos (soulignement, graisse, icône, fond…). */
  cue: string | null
  linkColor: RgbaTuple
  textColor: RgbaTuple
  block: string
}

export interface ColoredInline {
  ref: RefTuple
  text: string
  tag: string
  context: string
  color: string
  parentColor: string
}

export interface StateGroup {
  ref: RefTuple
  attribute: string
  name: string
  /** Propriétés CSS qui diffèrent entre l'élément actif et ses frères. */
  differences: string[]
  /** Parmi elles, celles qui ne sont pas des couleurs. */
  structural: string[]
}

export interface Swatch {
  ref: RefTuple
  color: string
  context: string
}

declare global {
  interface Window {
    __couleurs: CouleursLib
  }
}

export function installCouleurs(): void {
  const rgaa = window.__rgaa
  const COLOR_CACHE = new Map<string, RgbaTuple>()
  const toRgba = (value: string): RgbaTuple => {
    const cached = COLOR_CACHE.get(value)
    if (cached) return cached
    const out = rgaa.rgba(value)
    COLOR_CACHE.set(value, out)
    return out
  }

  // ─── Registre des cibles ──────────────────────────────────────────────────
  interface Target {
    id: number
    kind: 'texte' | 'valeur' | 'placeholder' | 'champ' | 'icone' | 'image'
    el: Element
    /** Couleur relevée à l'inventaire, pour les textes SVG : la feuille de mesure en neutralise le `fill`. */
    base?: RgbaTuple
  }
  const targets = new Map<number, Target>()
  const known = new Map<string, WeakSet<Element>>()
  let nextId = 1
  const register = (kind: Target['kind'], el: Element): Target | null => {
    let set = known.get(kind)
    if (!set) {
      set = new WeakSet()
      known.set(kind, set)
    }
    if (set.has(el)) return null
    set.add(el)
    const target = { id: nextId++, kind, el }
    targets.set(target.id, target)
    return target
  }

  const norm = (value: string | null | undefined): string =>
    (value ?? '').replace(/\s+/g, ' ').trim()

  const opacityChain = (el: Element): number => {
    let opacity = 1
    for (let node: Element | null = el; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity)
    }
    return opacity
  }

  const hasLetters = (text: string): boolean => /[\p{L}\p{N}]/u.test(text)

  /** Rectangles d'une cible en coordonnées de la fenêtre, avant rognage. */
  const rawBoxes = (target: Target): DOMRect[] => {
    const el = target.el
    if (target.kind === 'texte') {
      const rects: DOMRect[] = []
      const range = document.createRange()
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType !== 3 || !hasLetters(node.nodeValue ?? '')) continue
        range.selectNodeContents(node)
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width > 0 && rect.height > 0) rects.push(rect)
        }
      }
      return rects
    }
    if (target.kind === 'valeur' || target.kind === 'placeholder') {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      const px = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0
      const left = rect.left + px('border-left-width') + px('padding-left')
      const top = rect.top + px('border-top-width') + px('padding-top')
      const width =
        rect.width -
        px('border-left-width') -
        px('border-right-width') -
        px('padding-left') -
        px('padding-right')
      const height =
        rect.height -
        px('border-top-width') -
        px('border-bottom-width') -
        px('padding-top') -
        px('padding-bottom')
      return width > 0 && height > 0 ? [new DOMRect(left, top, width, height)] : []
    }
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 ? [rect] : []
  }

  /** Rogne un rectangle par les ancêtres qui coupent leur contenu (`overflow`). */
  const clipRect = (el: Element, rect: DOMRect, includeSelf: boolean): DOMRect | null => {
    let left = rect.left
    let top = rect.top
    let right = rect.right
    let bottom = rect.bottom
    const intersect = (node: Element) => {
      const clip = getComputedStyle(node)
      if (clip.overflowX === 'visible' && clip.overflowY === 'visible') return
      const box = node.getBoundingClientRect()
      const bx = Number.parseFloat(clip.borderLeftWidth) || 0
      const by = Number.parseFloat(clip.borderTopWidth) || 0
      if (clip.overflowX !== 'visible') {
        left = Math.max(left, box.left + bx)
        right = Math.min(right, box.right - (Number.parseFloat(clip.borderRightWidth) || 0))
      }
      if (clip.overflowY !== 'visible') {
        top = Math.max(top, box.top + by)
        bottom = Math.min(bottom, box.bottom - (Number.parseFloat(clip.borderBottomWidth) || 0))
      }
    }
    if (includeSelf) intersect(el)
    let node: Element | null = el
    while (node) {
      const style = getComputedStyle(node)
      let parent: Element | null = node.parentElement
      if (style.position === 'fixed') parent = null
      else if (style.position === 'absolute') parent = (node as HTMLElement).offsetParent
      node = parent
      if (!node || node === document.documentElement || node === document.body) break
      intersect(node)
    }
    return right - left > 1 && bottom - top > 1
      ? new DOMRect(left, top, right - left, bottom - top)
      : null
  }

  const isOpaqueCover = (node: Element, covered: Element): boolean => {
    if (node.contains(covered) || covered.contains(node)) return false
    const style = getComputedStyle(node)
    if (style.visibility === 'hidden' || Number(style.opacity) < 0.98) return false
    if (['img', 'video', 'canvas', 'picture', 'iframe'].includes(node.localName)) return true
    if (style.backgroundImage.includes('url(')) return true
    return toRgba(style.backgroundColor)[3] >= 0.98
  }

  const MEDIA_TAGS = ['img', 'video', 'canvas', 'picture']
  const stackSignature = (stack: Element[]): { sig: string; media: boolean } => {
    let media = false
    const parts: string[] = []
    for (const node of stack.slice(0, 14)) {
      const style = getComputedStyle(node)
      const image = style.backgroundImage !== 'none'
      if (MEDIA_TAGS.includes(node.localName) || style.backgroundImage.includes('url('))
        media = true
      parts.push(
        `${style.backgroundColor}|${style.opacity}|${image ? style.backgroundImage.slice(0, 60) : ''}|${node.localName}`,
      )
    }
    return { sig: parts.join(';'), media }
  }

  const probeOne = (target: Target): ProbeResult => {
    const el = target.el
    const result: ProbeResult = { id: target.id, status: 'invisible', boxes: [], full: false }
    if (!el.isConnected || !rgaa.isRendered(el)) return result
    // Technique « sr-only » : tout est rogné, rien n'est peint.
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (
        /^inset\(\s*(50|100)%/.test(style.clipPath) ||
        /^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(style.clip)
      )
        return result
    }
    const clipped: DOMRect[] = []
    for (const rect of rawBoxes(target)) {
      const box = clipRect(el, rect, target.kind === 'texte')
      if (box) clipped.push(box)
    }
    if (clipped.length === 0) return result
    const vw = document.documentElement.clientWidth
    const vh = window.innerHeight
    const inside = clipped.filter((b) => b.right > 0 && b.left < vw && b.bottom > 0 && b.top < vh)
    if (inside.length === 0) return { ...result, status: 'hors' }
    result.full = clipped.every((b) => b.left >= 0 && b.top >= 0 && b.right <= vw && b.bottom <= vh)
    // Une cible plus haute que la fenêtre ne tiendra jamais en entier : on mesure ce qui est visible.
    const spanTop = Math.min(...clipped.map((b) => b.top))
    const spanBottom = Math.max(...clipped.map((b) => b.bottom))
    if (spanBottom - spanTop > vh * 0.8) result.full = true
    const textual =
      target.kind === 'texte' || target.kind === 'valeur' || target.kind === 'placeholder'
    const first = inside[0] as DOMRect
    // Rognage par la fenêtre : on ne mesure que la part visible, et on ne rend la cible
    // mesurable que si elle l'est en entier, sauf si elle est plus grande que la fenêtre.
    const shrink = textual ? 0.12 : 0
    result.boxes = inside.map((b) => {
      const x = Math.max(0, b.left)
      const y = Math.max(0, b.top)
      const w = Math.min(vw, b.right) - x
      const h = Math.min(vh, b.bottom) - y
      return [x, y + h * shrink, w, h * (1 - 2 * shrink)] as BoxTuple
    })
    const cx = Math.min(vw - 1, Math.max(0, first.left + first.width / 2))
    const cy = Math.min(vh - 1, Math.max(0, first.top + first.height / 2))
    const stack = document.elementsFromPoint(cx, cy)
    const index = stack.findIndex((node) => el.contains(node))
    const front = index < 0 ? stack : stack.slice(0, index)
    const covered = front.some((node) => isOpaqueCover(node, el))
    const reachable = index >= 0 || stack.some((node) => node.contains(el))
    if (covered || !reachable) return { ...result, status: 'masque' }
    result.status = 'ok'
    const signature = stackSignature(stack)
    result.sig = signature.sig
    result.media = signature.media
    if (target.kind === 'champ' || target.kind === 'icone') {
      // Un contour de focus ou un halo dessiné autour de la cible ne doit pas être pris pour son fond contigu.
      const style = getComputedStyle(el)
      let extra = 0
      if (style.outlineStyle !== 'none' && style.outlineStyle !== 'hidden') {
        extra =
          (Number.parseFloat(style.outlineWidth) || 0) +
          Math.max(0, Number.parseFloat(style.outlineOffset) || 0)
      }
      for (const shadow of parseShadows(style.boxShadow)) {
        if (!shadow.inset) extra = Math.max(extra, shadow.spread + shadow.blur)
      }
      result.ringExtra = Math.max(0, extra)
    }
    if (textual) {
      Object.assign(result, textStyle(target, getComputedStyle(el)))
    }
    return result
  }

  const textStyle = (target: Target, style: CSSStyleDeclaration) => {
    const el = target.el
    let color: RgbaTuple
    let opacity = opacityChain(el)
    const svgText = el instanceof SVGElement
    if (svgText) {
      color = target.base ?? toRgba(style.fill)
      opacity *= target.base ? 1 : Number(style.fillOpacity)
    } else if (target.kind === 'placeholder') {
      const placeholder = getComputedStyle(el, '::placeholder')
      color = toRgba(placeholder.color)
      opacity *= Number(placeholder.opacity)
    } else {
      color = toRgba(style.color)
    }
    return {
      color: [
        color[0],
        color[1],
        color[2],
        Math.round(color[3] * opacity * 1000) / 1000,
      ] as RgbaTuple,
      size:
        Math.round(
          Number.parseFloat(style.fontSize) *
            (svgText ? ((el as SVGGraphicsElement).getScreenCTM()?.a ?? 1) : 1) *
            100,
        ) / 100,
      weight: Number.parseInt(style.fontWeight, 10) || 400,
    }
  }

  const isDisabled = (el: Element): boolean => {
    if (el.closest(':disabled, [aria-disabled="true"]')) return true
    const label = el.closest('label') as HTMLLabelElement | null
    const control = label?.control as (HTMLInputElement | null) | undefined
    return Boolean(control?.disabled)
  }

  const isDecorative = (el: Element): boolean =>
    Boolean(el.closest('[aria-hidden="true"], [role="presentation"], [role="none"]'))

  const isLogo = (el: Element): boolean => {
    const link = el.closest('a[href]') as HTMLAnchorElement | null
    if (!link) return false
    let root = false
    try {
      const url = new URL(link.href)
      root = url.origin === location.origin && (url.pathname === '/' || url.pathname === '')
    } catch {
      root = false
    }
    return root && Boolean(el.closest('header, [role="banner"], footer, [role="contentinfo"]'))
  }

  const FIELD_INPUT = /^(hidden|submit|button|reset|image|file|range|color)$/

  // ─── Inventaires ──────────────────────────────────────────────────────────
  const collectText = (): TextDesc[] => {
    const out: TextDesc[] = []
    const skip = 'script, style, noscript, template, option, optgroup, textarea, [hidden]'
    const parents = new Set<Element>()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent || !hasLetters(node.nodeValue ?? '') || parent.closest(skip)) continue
      parents.add(parent)
    }
    for (const el of parents) {
      if (known.get('texte')?.has(el)) continue
      if (!rgaa.isRendered(el)) continue
      const style = getComputedStyle(el)
      if (Number.parseFloat(style.fontSize) <= 0) continue
      if (opacityChain(el) <= 0) continue
      const target = register('texte', el)
      if (!target) continue
      if (el instanceof SVGElement) {
        const fill = toRgba(style.fill)
        target.base = [
          fill[0],
          fill[1],
          fill[2],
          Math.round(fill[3] * Number(style.fillOpacity) * 1000) / 1000,
        ]
      }
      const direct = Array.from(el.childNodes)
        .filter((node) => node.nodeType === 3)
        .map((node) => node.nodeValue ?? '')
        .join(' ')
      out.push({
        id: target.id,
        kind: 'texte',
        text: norm(direct).slice(0, 120),
        ...textStyle(target, style),
        shadow: style.textShadow !== 'none',
        clipText:
          style.getPropertyValue('-webkit-background-clip') === 'text' ||
          style.backgroundClip === 'text' ||
          (el instanceof SVGElement && style.fill.startsWith('url(')),
        disabled: isDisabled(el),
        decorative: isDecorative(el),
        logo: isLogo(el),
      })
    }
    // Valeur saisie et texte indicatif des champs.
    for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
      if (el instanceof HTMLInputElement && FIELD_INPUT.test(el.type)) continue
      if (!rgaa.isRendered(el)) continue
      const style = getComputedStyle(el)
      const field = el as HTMLInputElement
      const value = target0(
        register('valeur', el),
        'valeur',
        style,
        field.disabled || isDisabled(el),
      )
      if (value) out.push(value)
      const placeholder = field.placeholder
      if (placeholder && hasLetters(placeholder) && !field.value && el.localName !== 'select') {
        const tp = target0(
          register('placeholder', el),
          'placeholder',
          style,
          field.disabled || isDisabled(el),
        )
        if (tp) {
          tp.text = norm(placeholder).slice(0, 120)
          out.push(tp)
        }
      }
    }
    return out
  }

  function target0(
    target: Target | null,
    kind: 'valeur' | 'placeholder',
    style: CSSStyleDeclaration,
    disabled: boolean,
  ): TextDesc | null {
    if (!target) return null
    return {
      id: target.id,
      kind,
      text: kind === 'valeur' ? '(texte saisi)' : '',
      ...textStyle(target, style),
      shadow: false,
      clipText: false,
      disabled,
      decorative: false,
      logo: false,
    }
  }

  const parseShadows = (value: string): ShadowDesc[] => {
    if (!value || value === 'none') return []
    const parts: string[] = []
    let depth = 0
    let start = 0
    for (let i = 0; i < value.length; i++) {
      const ch = value[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (ch === ',' && depth === 0) {
        parts.push(value.slice(start, i))
        start = i + 1
      }
    }
    parts.push(value.slice(start))
    const out: ShadowDesc[] = []
    for (const part of parts) {
      const colorMatch = /(?:rgba?|hsla?|oklab|oklch|lab|lch|color)\([^)]*\)/.exec(part)
      const lengths = (part.replace(colorMatch?.[0] ?? '', '').match(/-?[\d.]+(?=px)/g) ?? []).map(
        Number,
      )
      out.push({
        color: colorMatch ? toRgba(colorMatch[0]) : [0, 0, 0, 1],
        blur: lengths[2] ?? 0,
        spread: lengths[3] ?? 0,
        inset: /\binset\b/.test(part),
      })
    }
    return out
  }

  const labelOf = (el: Element): string => {
    const name = rgaa.accName(el)
    return name || (el.getAttribute('placeholder') ?? '')
  }

  const describeField = (el: Element, id: number, isBox: boolean): FieldDesc => {
    const style = getComputedStyle(el)
    const borders: BorderDesc[] = []
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const width =
        Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) || 0
      const lineStyle = style.getPropertyValue(`border-${side.toLowerCase()}-style`)
      const color = toRgba(style.getPropertyValue(`border-${side.toLowerCase()}-color`))
      if (width >= 1 && lineStyle !== 'none' && lineStyle !== 'hidden' && color[3] > 0) {
        borders.push({ side, width, color })
      }
    }
    const shadows = parseShadows(style.boxShadow).filter(
      (s) => s.blur <= 1 && Math.abs(s.spread) >= 1,
    )
    const extent = Math.max(0, ...shadows.filter((s) => !s.inset).map((s) => s.spread + s.blur))
    return {
      id,
      kind: isBox ? 'case' : 'champ',
      label: norm(labelOf(el)).slice(0, 80),
      tag: el.localName,
      role: el.getAttribute('role') ?? '',
      borders,
      shadows,
      extent,
      invalid: el.getAttribute('aria-invalid') === 'true',
      checked:
        (el as HTMLInputElement).checked === true || el.getAttribute('aria-checked') === 'true',
    }
  }

  const isBoxField = (el: Element): boolean => {
    const role = el.getAttribute('role') ?? ''
    return (
      (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) ||
      role === 'checkbox' ||
      role === 'radio' ||
      role === 'switch'
    )
  }

  const collectFields = (): FieldDesc[] => {
    const out: FieldDesc[] = []
    const selector =
      'input, textarea, select, [role="checkbox"], [role="radio"], [role="switch"], [role="textbox"], [role="combobox"], [role="searchbox"]'
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (known.get('champ')?.has(el)) continue
      if (el instanceof HTMLInputElement && FIELD_INPUT.test(el.type)) continue
      if (!rgaa.isRendered(el) || isDisabled(el)) continue
      const rect = el.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4) continue
      const isBox = isBoxField(el)
      // Case native laissée telle quelle : style du navigateur, hors du champ du critère.
      if (el instanceof HTMLInputElement && isBox && getComputedStyle(el).appearance !== 'none')
        continue
      const target = register('champ', el)
      if (!target) continue
      out.push(describeField(el, target.id, isBox))
    }
    return out
  }

  /** Champs déjà inventoriés que le formulaire signale maintenant invalides, décrits dans leur état courant. */
  const invalidFields: CouleursLib['invalidFields'] = () => {
    const out: FieldDesc[] = []
    for (const target of targets.values()) {
      if (target.kind !== 'champ' || !target.el.isConnected) continue
      if (target.el.getAttribute('aria-invalid') !== 'true') continue
      out.push(describeField(target.el, target.id, isBoxField(target.el)))
    }
    return out
  }

  const SHAPES = 'path, circle, rect, ellipse, polygon, polyline, line'
  const CONTROLS =
    'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], summary, input[type="button"], input[type="submit"]'

  const paintOf = (shape: Element, which: 'fill' | 'stroke'): RgbaTuple | null | 'complexe' => {
    const style = getComputedStyle(shape)
    const value = style.getPropertyValue(which)
    if (!value || value === 'none') return null
    if (value.startsWith('url(')) return 'complexe'
    if (which === 'stroke' && (Number.parseFloat(style.strokeWidth) || 0) <= 0) return null
    const color = toRgba(value)
    let opacity = Number(style.getPropertyValue(`${which}-opacity`))
    for (let node: Element | null = shape; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity)
      if (node.localName === 'svg') break
    }
    // Opacité des ancêtres HTML de l'icône : comptée aussi.
    const svg = shape.closest('svg')
    if (svg?.parentElement) opacity *= opacityChain(svg.parentElement)
    return [color[0], color[1], color[2], Math.round(color[3] * opacity * 1000) / 1000]
  }

  const collectIcons = (): IconDesc[] => {
    const out: IconDesc[] = []
    for (const svg of Array.from(document.querySelectorAll('svg'))) {
      if (known.get('icone')?.has(svg)) continue
      if (svg.parentElement?.closest('svg')) continue
      if (!rgaa.isRendered(svg)) continue
      const rect = svg.getBoundingClientRect()
      if (rect.width < 6 || rect.height < 6) continue
      const control = svg.closest(CONTROLS)
      const controlText = control ? rgaa.visibleText(control) : ''
      const hiddenChain = Boolean(svg.closest('[aria-hidden="true"]'))
      const named =
        !hiddenChain &&
        (svg.getAttribute('role') === 'img' ||
          svg.hasAttribute('aria-label') ||
          svg.hasAttribute('aria-labelledby') ||
          Boolean(svg.querySelector(':scope > title')))
      let role: IconDesc['role'] | null = null
      if (control && controlText === '') role = 'controle'
      else if (named && !(control && controlText !== '')) role = 'nomme'
      if (!role) continue
      const target = register('icone', svg)
      if (!target) continue
      const paints: PaintDesc[] = []
      const sx = window.scrollX
      const sy = window.scrollY
      const shapes = Array.from(svg.querySelectorAll(SHAPES)).filter(
        (shape) =>
          !shape.closest(
            'defs, clipPath, mask, symbol, marker, pattern, linearGradient, radialGradient',
          ),
      )
      for (const shape of shapes.slice(0, 60)) {
        const style = getComputedStyle(shape)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        const box = shape.getBoundingClientRect()
        if (box.width <= 0 && box.height <= 0) continue
        const fill = paintOf(shape, 'fill')
        const stroke = paintOf(shape, 'stroke')
        if (!fill && !stroke) continue
        paints.push({ fill, stroke, box: [box.left + sx, box.top + sy, box.width, box.height] })
      }
      out.push({
        id: target.id,
        name: norm(rgaa.accName(control && controlText === '' ? control : svg)).slice(0, 80),
        role,
        paints,
        usesUse: Boolean(svg.querySelector('use')),
        shapes: shapes.length,
        box: [rect.left + sx, rect.top + sy, rect.width, rect.height],
      })
    }
    return out
  }

  const stableSource = (raw: string): string => {
    try {
      const url = new URL(raw, location.href)
      // next/image : l'image d'origine est dans `url=`, le reste n'est que redimensionnement.
      const inner = url.searchParams.get('url')
      const base = inner ? new URL(inner, location.href) : url
      return base.origin === location.origin ? base.pathname : `${base.host}${base.pathname}`
    } catch {
      return raw
    }
  }

  const collectImages = (): ImageDesc[] => {
    const out: ImageDesc[] = []
    for (const img of Array.from(document.images)) {
      if (known.get('image')?.has(img)) continue
      if (!rgaa.isRendered(img)) continue
      const rect = img.getBoundingClientRect()
      if (rect.width < 16 || rect.height < 16) continue
      if (isDecorative(img)) continue
      const alt = norm(img.getAttribute('alt'))
      const label = norm(img.getAttribute('aria-label'))
      // Sans alternative : image décorative ou absence d'alternative (thématique 1), pas d'information.
      if (!alt && !label) continue
      const target = register('image', img)
      if (!target) continue
      out.push({
        id: target.id,
        kind: 'img',
        source: stableSource(img.currentSrc || img.src),
        name: alt || label,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        logo: isLogo(img),
      })
    }
    return out
  }

  const collectMedia = (): MediaDesc[] => {
    const out: MediaDesc[] = []
    for (const el of Array.from(
      document.querySelectorAll('video, audio, canvas, object, embed, iframe'),
    )) {
      if (!rgaa.isRendered(el) && el.localName !== 'audio') continue
      const rect = el.getBoundingClientRect()
      if (el.localName !== 'audio' && (rect.width < 16 || rect.height < 16)) continue
      if (isDecorative(el)) continue
      const source =
        el.getAttribute('src') ??
        el.getAttribute('data') ??
        el.querySelector('source')?.getAttribute('src') ??
        ''
      out.push({
        kind: el.localName as MediaDesc['kind'],
        source: stableSource(source),
        title: norm(el.getAttribute('title') ?? el.getAttribute('aria-label')),
        ref: rgaa.ref(el),
      })
    }
    return out
  }

  // ─── Plan de défilement ───────────────────────────────────────────────────
  const hasFixedAncestor = (el: Element): boolean => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (getComputedStyle(node).position === 'fixed') return true
    }
    return false
  }

  const plan: CouleursLib['plan'] = (ids, attempts) => {
    let head: { id: number; top: number; fixed: boolean } | null = null
    for (const id of ids) {
      const target = targets.get(id)
      if (!target?.el.isConnected) continue
      const rect = rawBoxes(target)[0]
      if (!rect) continue
      const top = rect.top + window.scrollY
      if (!head || top < head.top) head = { id, top, fixed: hasFixedAncestor(target.el) }
    }
    if (!head) return null
    if (head.fixed) return { y: null, head: head.id }
    const offsets = [250, 520, 120]
    const attempt = attempts[head.id] ?? 0
    const wanted = head.top - (offsets[attempt % offsets.length] ?? 250)
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    return { y: Math.max(0, Math.min(max, Math.round(wanted))), head: head.id }
  }

  const pinnedTargets: CouleursLib['pinnedTargets'] = () => {
    const ids: number[] = []
    for (const target of targets.values()) {
      if (target.kind !== 'texte' || !target.el.isConnected) continue
      for (let node: Element | null = target.el; node; node = node.parentElement) {
        const position = getComputedStyle(node).position
        if (position === 'fixed' || position === 'sticky') {
          ids.push(target.id)
          break
        }
      }
    }
    return ids
  }

  const scrollMax = (): number =>
    Math.max(0, document.documentElement.scrollHeight - window.innerHeight)

  const scrollTo: CouleursLib['scrollTo'] = async (y) => {
    window.scrollTo({ top: y, left: 0, behavior: 'instant' })
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    await Promise.race([
      Promise.allSettled(document.getAnimations().map((animation) => animation.finished)),
      new Promise((resolve) => setTimeout(resolve, 400)),
    ])
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  const scope: CouleursLib['scope'] = (element) => {
    const rect = element.getBoundingClientRect()
    const ids: number[] = []
    for (const target of targets.values()) {
      if (target.kind !== 'texte' && target.kind !== 'valeur' && target.kind !== 'placeholder')
        continue
      if (!target.el.isConnected) continue
      if (element.contains(target.el)) {
        ids.push(target.id)
        continue
      }
      const other = target.el.getBoundingClientRect()
      if (
        other.right > rect.left &&
        other.left < rect.right &&
        other.bottom > rect.top &&
        other.top < rect.bottom
      ) {
        ids.push(target.id)
      }
    }
    return ids
  }

  // ─── États : survol, focus, panneaux ──────────────────────────────────────
  const hoverCandidates = (): Element[] => {
    const selectors = new Set<string>()
    const visit = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          if (!rule.selectorText.includes(':hover')) continue
          let depth = 0
          let start = 0
          const text = rule.selectorText
          for (let i = 0; i <= text.length; i++) {
            const ch = text[i]
            if (ch === '(') depth++
            else if (ch === ')') depth--
            else if ((ch === ',' && depth === 0) || i === text.length) {
              const part = text.slice(start, i).trim()
              start = i + 1
              if (part.includes(':hover') && !part.includes('::') && !part.includes('&')) {
                selectors.add(part.replace(/:hover/g, ''))
              }
            }
          }
        } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
          visit((rule as CSSGroupingRule).cssRules)
        }
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules)
      } catch {
        // feuille d'un autre domaine : illisible.
      }
    }
    const out = new Set<Element>()
    for (const selector of selectors) {
      if (!selector.trim()) continue
      let matches: Element[] = []
      try {
        matches = Array.from(document.querySelectorAll(selector)).slice(0, 60)
      } catch {
        continue
      }
      for (const match of matches) {
        // Un élément non rendu ne peut pas être survolé : son plus proche ancêtre rendu le sera (menus au survol).
        let node: Element | null = match
        while (node && !rgaa.isRendered(node)) node = node.parentElement
        if (node && node !== document.body && node !== document.documentElement) out.add(node)
      }
    }
    return Array.from(out).slice(0, 200)
  }

  const disclosureTriggers = (): Element[] => {
    const out: Element[] = []
    for (const el of Array.from(
      document.querySelectorAll('[aria-expanded="false"], details:not([open]) > summary'),
    )) {
      if (!rgaa.isRendered(el) || isDisabled(el)) continue
      // Un lien vers une autre page n'ouvre rien : cliquer quitterait la page.
      const href = el.getAttribute('href')
      if (el.localName === 'a' && href && !href.startsWith('#') && !href.startsWith('javascript:'))
        continue
      const rect = el.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) continue
      out.push(el)
    }
    for (const el of Array.from(document.querySelectorAll('[role="tab"][aria-selected="false"]'))) {
      if (rgaa.isRendered(el) && !isDisabled(el)) out.push(el)
    }
    return out
  }

  const describe = (element: Element): string => {
    const name = norm(rgaa.accName(element) || rgaa.visibleText(element))
    return `${element.localName}${element.getAttribute('role') ? `[${element.getAttribute('role')}]` : ''} « ${name.slice(0, 60)} »`
  }

  const restSnapshot = new WeakMap<Element, { background: string; border: string }>()
  const focusInfo = (element: Element | null): FocusInfo | null => {
    if (!element?.isConnected || element === document.body) return null
    const style = getComputedStyle(element)
    const rest = restSnapshot.get(element)
    const outlineStyle = style.outlineStyle
    const outlineWidth = Number.parseFloat(style.outlineWidth) || 0
    const outlineColor = toRgba(style.outlineColor)
    const outlineOffset = Number.parseFloat(style.outlineOffset) || 0
    const nativeOutline = outlineStyle === 'auto'
    const visibleOutline =
      !nativeOutline &&
      outlineStyle !== 'none' &&
      outlineStyle !== 'hidden' &&
      outlineWidth > 0 &&
      outlineColor[3] > 0
    const shadows = parseShadows(style.boxShadow).filter(
      (s) => s.blur <= 4 && (s.spread >= 1 || s.inset),
    )
    const borderWidth = Number.parseFloat(style.borderTopWidth) || 0
    const rect = element.getBoundingClientRect()
    let extent = 0
    if (visibleOutline) extent = Math.max(extent, outlineWidth + outlineOffset)
    for (const s of shadows) if (!s.inset) extent = Math.max(extent, s.spread + s.blur)
    // Fond contigu : signature des fonds des ancêtres, sans image.
    const parts: string[] = []
    let media = false
    for (
      let node: Element | null = element.parentElement;
      node && parts.length < 8;
      node = node.parentElement
    ) {
      const parentStyle = getComputedStyle(node)
      if (parentStyle.backgroundImage !== 'none') media = true
      const bg = parentStyle.backgroundColor
      if (toRgba(bg)[3] > 0) parts.push(bg)
      if (toRgba(bg)[3] >= 1) break
    }
    return {
      ref: rgaa.ref(element),
      tag: element.localName,
      nativeOutline,
      outline: visibleOutline
        ? { color: outlineColor, width: outlineWidth, offset: outlineOffset }
        : null,
      shadows,
      border: borderWidth >= 1 ? { color: toRgba(style.borderTopColor), width: borderWidth } : null,
      borderChanged: Boolean(rest) && rest?.border !== style.borderTopColor,
      backgroundChanged: Boolean(rest) && rest?.background !== style.backgroundColor,
      background: toRgba(style.backgroundColor),
      borderColor: toRgba(style.borderTopColor),
      extent,
      box: [rect.left, rect.top, rect.width, rect.height],
      backdrop: parts.join('>'),
      media,
    }
  }

  // ─── Information donnée par la couleur (3.1) ──────────────────────────────
  const TEXT_BLOCK =
    'p, li, td, th, dd, dt, blockquote, figcaption, caption, label, h1, h2, h3, h4, h5, h6'

  /** Repère visuel d'un lien autre que la couleur (soulignement, graisse, icône, fond…), ou `null`. */
  const cueOf = (link: Element, block: Element): string | null => {
    const style = getComputedStyle(link)
    const parentStyle = getComputedStyle(block)
    if (
      style.textDecorationLine.includes('underline') &&
      !parentStyle.textDecorationLine.includes('underline')
    )
      return 'soulignement'
    for (const side of ['top', 'bottom']) {
      const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0
      if (
        width > 0 &&
        style.getPropertyValue(`border-${side}-style`) !== 'none' &&
        toRgba(style.getPropertyValue(`border-${side}-color`))[3] > 0
      )
        return 'bordure'
    }
    if (
      Math.abs(
        (Number.parseInt(style.fontWeight, 10) || 400) -
          (Number.parseInt(parentStyle.fontWeight, 10) || 400),
      ) >= 200
    )
      return 'graisse'
    if (style.fontStyle !== parentStyle.fontStyle) return 'italique'
    if (style.fontFamily !== parentStyle.fontFamily) return 'police'
    if (toRgba(style.backgroundColor)[3] > 0 || style.backgroundImage !== 'none') return 'fond'
    if (link.querySelector('svg, img')) return 'icône'
    for (const pseudo of ['::before', '::after']) {
      const content = getComputedStyle(link, pseudo).content
      if (content && content !== 'none' && content !== 'normal') return 'contenu généré'
    }
    const outline = Number.parseFloat(style.outlineWidth) || 0
    if (outline > 0 && style.outlineStyle !== 'none' && style.outlineStyle !== 'auto')
      return 'contour'
    return null
  }

  const colorOnlyLinks: Element[] = []
  const linkCues: CouleursLib['linkCues'] = () => {
    const out: LinkCue[] = []
    colorOnlyLinks.length = 0
    for (const link of Array.from(document.querySelectorAll('a[href]'))) {
      if (!rgaa.isRendered(link) || !rgaa.isVisible(link)) continue
      const block = link.closest(TEXT_BLOCK)
      if (
        !block ||
        block.closest(
          'nav, [role="navigation"], header, footer, [role="banner"], [role="contentinfo"]',
        )
      )
        continue
      // Un lien qui constitue à lui seul le bloc n'est pas « dans un texte ».
      const around = norm(rgaa.visibleText(block).replace(norm(rgaa.visibleText(link)), ''))
      if (around.length < 12) continue
      const cue = cueOf(link, block)
      if (!cue) colorOnlyLinks.push(link)
      out.push({
        ref: rgaa.ref(link),
        text: norm(rgaa.visibleText(link)).slice(0, 80),
        cue,
        linkColor: toRgba(getComputedStyle(link).color),
        textColor: toRgba(getComputedStyle(block).color),
        block: around.slice(0, 80),
      })
    }
    return out
  }

  const COLOR_WORDS =
    '(?:rouge|rouges|vert|verte|verts|vertes|bleu|bleue|bleus|bleues|jaune|jaunes|orange|oranges|rose|roses|violet|violette|violets|violettes|noir|noire|noirs|noires|blanc|blanche|blancs|blanches|gris|grise|grises|marron|turquoise|mauve|doré|dorée|argenté|argentée|écarlate|bordeaux|red|green|blue|yellow|pink|purple|black|white|gr[ae]y)'
  const COLOR_CONTEXT = new RegExp(
    `(?:\\ben\\s+${COLOR_WORDS}\\b|\\b(?:couleur|teinte|coloré|colorée|colorés|colorées|surligné|surlignée|marqué|marquée|signalé|signalée|indiqué|indiquée|affiché|affichée|écrit|écrite)s?\\s+(?:en\\s+|de\\s+|d['’])?${COLOR_WORDS}\\b|\\b(?:bouton|boutons|champ|champs|lien|liens|texte|textes|zone|zones|case|cases|ligne|lignes|colonne|colonnes|bandeau|bandeaux|pastille|pastilles|point|points|icône|icônes|pictogramme|pictogrammes|voyant|voyants|trait|traits|barre|barres|cadre|cadres|flèche|flèches|astérisque|astérisques|carré|carrés|cercle|cercles|zones?)\\s+${COLOR_WORDS}\\b|\\b(?:the|button|field|link|text|red|green|blue)\\s+${COLOR_WORDS}\\b)`,
    'i',
  )

  const colorWords: CouleursLib['colorWords'] = () => {
    const out: { sentence: string; ref: RefTuple }[] = []
    const seen = new Set<string>()
    for (const el of Array.from(
      document.querySelectorAll(`${TEXT_BLOCK}, div, span, a, button, summary`),
    )) {
      if (!rgaa.isRendered(el) || rgaa.isHiddenFromAT(el)) continue
      if (el.querySelector(TEXT_BLOCK)) continue
      const text = norm(rgaa.visibleText(el))
      if (text.length < 8 || text.length > 600) continue
      for (const sentence of text.split(/(?<=[.!?:;])\s+/)) {
        if (!COLOR_CONTEXT.test(sentence)) continue
        const clean = sentence.slice(0, 200)
        if (seen.has(clean)) continue
        seen.add(clean)
        out.push({ sentence: clean, ref: rgaa.ref(el) })
      }
    }
    return out
  }

  /** Teinte (0-360) et saturation (0-1) HSL d'une couleur sRGB. */
  const hueSat = (c: RgbaTuple): { h: number; s: number; l: number } => {
    const r = c[0] / 255
    const g = c[1] / 255
    const b = c[2] / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const l = (max + min) / 2
    const d = max - min
    if (d === 0) return { h: 0, s: 0, l }
    const s = d / (1 - Math.abs(2 * l - 1))
    let h = 0
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    return { h: (h * 60 + 360) % 360, s, l }
  }
  /** Deux couleurs sont-elles de teintes franchement différentes (rouge/vert), pas de simples nuances ? */
  const distinctHue = (a: RgbaTuple, b: RgbaTuple): boolean => {
    const x = hueSat(a)
    const y = hueSat(b)
    const chromaX = x.s >= 0.3 && x.l > 0.1 && x.l < 0.9
    const chromaY = y.s >= 0.3 && y.l > 0.1 && y.l < 0.9
    if (chromaX !== chromaY) return true
    if (!chromaX && !chromaY) return false
    const delta = Math.abs(x.h - y.h)
    return Math.min(delta, 360 - delta) > 30
  }

  const INLINE_TAGS = ['span', 'em', 'strong', 'b', 'i', 'mark', 'small', 'abbr', 'code']
  const coloredInline: CouleursLib['coloredInline'] = () => {
    const out: ColoredInline[] = []
    const selector = INLINE_TAGS.map((tag) =>
      TEXT_BLOCK.split(',')
        .map((block) => `${block.trim()} ${tag}`)
        .join(', '),
    ).join(', ')
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (!rgaa.isRendered(el) || !rgaa.isVisible(el) || el.closest('a[href], button')) continue
      const parent = el.parentElement
      if (!parent) continue
      const text = norm(rgaa.visibleText(el))
      if (!text || text.length > 80) continue
      const style = getComputedStyle(el)
      const parentStyle = getComputedStyle(parent)
      const colorDiffers = distinctHue(toRgba(style.color), toRgba(parentStyle.color))
      const bg = toRgba(style.backgroundColor)
      const bgDiffers = bg[3] > 0 && style.backgroundColor !== parentStyle.backgroundColor
      if (!colorDiffers && !bgDiffers) continue
      // Un autre repère que la couleur : graisse, italique, soulignement, taille, titre ou icône.
      const hasOtherCue =
        Math.abs(
          (Number.parseInt(style.fontWeight, 10) || 400) -
            (Number.parseInt(parentStyle.fontWeight, 10) || 400),
        ) >= 200 ||
        style.fontStyle !== parentStyle.fontStyle ||
        (style.textDecorationLine !== parentStyle.textDecorationLine &&
          style.textDecorationLine !== 'none') ||
        Math.abs(Number.parseFloat(style.fontSize) - Number.parseFloat(parentStyle.fontSize)) >=
          1 ||
        el.hasAttribute('title') ||
        Boolean(el.querySelector('svg, img'))
      if (hasOtherCue) continue
      out.push({
        ref: rgaa.ref(el),
        text,
        tag: el.localName,
        context: norm(rgaa.visibleText(parent)).slice(0, 120),
        color: style.color,
        parentColor: parentStyle.color,
      })
    }
    // Cellules, items de liste et définitions mis en couleur (statuts d'un tableau, d'une liste).
    for (const el of Array.from(document.querySelectorAll('td, li, dd'))) {
      if (!rgaa.isRendered(el) || !rgaa.isVisible(el)) continue
      const own = norm(
        Array.from(el.childNodes)
          .filter((node) => node.nodeType === 3)
          .map((node) => node.nodeValue ?? '')
          .join(' '),
      )
      if (!own || own.length > 40 || !hasLetters(own)) continue
      const style = getComputedStyle(el)
      const reference = getComputedStyle(el.closest('table, ul, ol, dl') ?? document.body)
      if (!distinctHue(toRgba(style.color), toRgba(reference.color))) continue
      const hasOtherCue =
        Math.abs(
          (Number.parseInt(style.fontWeight, 10) || 400) -
            (Number.parseInt(reference.fontWeight, 10) || 400),
        ) >= 200 ||
        style.fontStyle !== reference.fontStyle ||
        Boolean(el.querySelector('svg, img')) ||
        el.hasAttribute('title')
      if (hasOtherCue) continue
      out.push({
        ref: rgaa.ref(el),
        text: own,
        tag: el.localName,
        context: norm(rgaa.visibleText(el.parentElement ?? el)).slice(0, 120),
        color: style.color,
        parentColor: reference.color,
      })
    }
    return out
  }

  const iconControls: CouleursLib['iconControls'] = () => {
    const out: { name: string; ref: RefTuple }[] = []
    for (const el of Array.from(document.querySelectorAll(CONTROLS))) {
      if (el.localName === 'input' || !rgaa.isRendered(el) || !rgaa.isVisible(el) || isDisabled(el))
        continue
      if (rgaa.visibleText(el) !== '' || el.querySelector('svg, img, picture, canvas')) continue
      const name = norm(rgaa.accName(el))
      if (name) out.push({ name: name.slice(0, 80), ref: rgaa.ref(el) })
    }
    return out
  }

  const shadowHostCount = (): number => {
    let count = 0
    for (const el of Array.from(document.querySelectorAll('*'))) {
      if (!el.shadowRoot) continue
      // Les hôtes sans boîte (annonceur de route de Next.js) ne montrent rien.
      const rect = el.getBoundingClientRect()
      if (rect.width >= 4 && rect.height >= 4 && rgaa.isRendered(el)) count++
    }
    return count
  }

  const COLOR_PROPS = [
    'color',
    'background-color',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'outline-color',
    'text-decoration-color',
    'fill',
    'stroke',
    'caret-color',
    'column-rule-color',
    'opacity',
  ]
  const STRUCTURAL_PROPS = [
    'font-weight',
    'font-style',
    'font-size',
    'font-family',
    'text-decoration-line',
    'text-decoration-style',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'border-top-style',
    'border-bottom-style',
    'outline-width',
    'outline-style',
    'box-shadow',
    'transform',
    'display',
    'text-transform',
    'letter-spacing',
    'background-image',
  ]
  const pseudoSig = (el: Element, pseudo: '::before' | '::after'): string => {
    const style = getComputedStyle(el, pseudo)
    if (style.content === 'none' || style.content === 'normal') return ''
    return `${style.content}|${style.width}|${style.height}|${style.display}|${style.transform}|${style.backgroundImage}|${style.borderTopWidth}`
  }

  /** Élément de même nature, sans l'état, dans le même ensemble (liste, barre d'onglets, groupe). */
  const findPeer = (active: Element, query: string): Element | undefined => {
    const accept = (el: Element): boolean =>
      el !== active &&
      !el.contains(active) &&
      !active.contains(el) &&
      el.getAttribute('role') === active.getAttribute('role') &&
      !el.matches(query) &&
      rgaa.isRendered(el)
    let scope: Element | null = active.parentElement
    for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement) {
      const candidates = Array.from(scope.querySelectorAll(active.localName)).filter(accept)
      const first = candidates.find((c) => c.className === active.className) ?? candidates[0]
      if (first) return first
      if (scope.matches('nav, ul, ol, menu, [role="tablist"], [role="toolbar"], aside, main')) break
    }
    return undefined
  }

  const stateGroups: CouleursLib['stateGroups'] = () => {
    const out: StateGroup[] = []
    const attributes: [string, string][] = [
      ['aria-current', '[aria-current]:not([aria-current="false"])'],
      ['aria-selected', '[aria-selected="true"]'],
      ['aria-pressed', '[aria-pressed="true"]'],
      ['aria-checked', '[role]:not(input)[aria-checked="true"]'],
    ]
    for (const [attribute, query] of attributes) {
      for (const active of Array.from(document.querySelectorAll(query))) {
        if (!rgaa.isRendered(active) || !rgaa.isVisible(active)) continue
        const peer = findPeer(active, query)
        if (!peer) continue
        const activeStyle = getComputedStyle(active)
        const peerStyle = getComputedStyle(peer)
        const differences: string[] = []
        const structural: string[] = []
        for (const prop of COLOR_PROPS) {
          if (activeStyle.getPropertyValue(prop) !== peerStyle.getPropertyValue(prop))
            differences.push(prop)
        }
        for (const prop of STRUCTURAL_PROPS) {
          if (activeStyle.getPropertyValue(prop) !== peerStyle.getPropertyValue(prop))
            structural.push(prop)
        }
        for (const pseudo of ['::before', '::after'] as const) {
          if (pseudoSig(active, pseudo) !== pseudoSig(peer, pseudo)) structural.push(pseudo)
        }
        // Une icône ou un contenu propre à l'élément actif est un repère non coloré.
        if (active.querySelectorAll('svg, img').length !== peer.querySelectorAll('svg, img').length)
          structural.push('icône')
        if (
          norm(rgaa.visibleText(active)) !== norm(rgaa.visibleText(peer)) &&
          attribute !== 'aria-current'
        ) {
          // Libellés différents : sans rapport avec l'état, on ne conclut pas.
        }
        out.push({
          ref: rgaa.ref(active),
          attribute,
          name: norm(rgaa.visibleText(active)).slice(0, 60),
          differences,
          structural,
        })
      }
    }
    return out
  }

  const swatches: CouleursLib['swatches'] = () => {
    const out: Swatch[] = []
    for (const el of Array.from(document.body.querySelectorAll('span, i, div, li, b'))) {
      if (el.children.length > 0 || norm(el.textContent) !== '' || el.closest('svg, button, a'))
        continue
      if (!rgaa.isRendered(el)) continue
      const rect = el.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4 || rect.width > 40 || rect.height > 40) continue
      // Une pastille est à peu près carrée ou ronde : un conteneur vide (squelette de chargement) n'en est pas une.
      const ratio = rect.width / rect.height
      if (ratio < 0.8 || ratio > 1.25) continue
      const style = getComputedStyle(el)
      const bg = toRgba(style.backgroundColor)
      if (bg[3] < 0.9 || style.backgroundImage !== 'none') continue
      const parent = el.parentElement
      if (!parent) continue
      // Une pastille isolée (puce, séparateur) sans texte voisin n'informe de rien : on exige un texte frère.
      const context = norm(rgaa.visibleText(parent))
      if (!context) continue
      out.push({ ref: rgaa.ref(el), color: style.backgroundColor, context: context.slice(0, 100) })
    }
    return out
  }

  const stylesheetsReactToDark: CouleursLib['stylesheetsReactToDark'] = () => {
    let reacts = false
    const visit = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (reacts) return
        if (
          rule instanceof CSSMediaRule &&
          /prefers-color-scheme\s*:\s*dark/.test(rule.conditionText || rule.media.mediaText)
        ) {
          reacts = true
          return
        }
        if (rule instanceof CSSStyleRule && /light-dark\(/.test(rule.cssText)) {
          reacts = true
          return
        }
        if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules)
          visit((rule as CSSGroupingRule).cssRules)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules)
      } catch {
        // feuille illisible
      }
      if (reacts) break
    }
    const scheme = getComputedStyle(document.documentElement).colorScheme
    if (/\bdark\b/.test(scheme) && /\blight\b/.test(scheme)) reacts = true
    return reacts
  }

  const MECHANISM =
    /contraste|contrast|daltoni|mode (?:sombre|nuit|clair)|th[eè]me (?:sombre|clair)|dark mode|affichage (?:adapt|accessible)|couleurs? (?:adapt|inversé)/i
  const mechanismCandidates: CouleursLib['mechanismCandidates'] = () => {
    const out: { name: string; ref: RefTuple }[] = []
    for (const el of Array.from(
      document.querySelectorAll(
        'button, a[href], [role="button"], [role="switch"], input[type="checkbox"], input[type="radio"], select, summary',
      ),
    )) {
      if (!rgaa.isRendered(el)) continue
      const name = norm(rgaa.accName(el) || rgaa.visibleText(el))
      if (name && name.length < 80 && MECHANISM.test(name)) out.push({ name, ref: rgaa.ref(el) })
    }
    return out
  }

  const disabledTextCount = (): number =>
    document.querySelectorAll(':disabled, [aria-disabled="true"]').length

  const pseudoTextCount = (): number => {
    let count = 0
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      for (const pseudo of ['::before', '::after']) {
        const content = getComputedStyle(el, pseudo).content
        // Texte généré (hors icônes de police et guillemets ouvrants/fermants).
        if (/^"[^"\s]/.test(content) && /[\p{L}\p{N}*]/u.test(content) && !/^"[-]/u.test(content))
          count++
      }
    }
    return count
  }

  const lists: { current: Element[] } = { current: [] }
  const list: CouleursLib['list'] = (kind) => {
    if (kind === 'survol') lists.current = hoverCandidates()
    else if (kind === 'panneau') lists.current = disclosureTriggers()
    else if (kind === 'lien') lists.current = colorOnlyLinks.slice(0, 25)
    else {
      lists.current = Array.from(
        document.querySelectorAll(
          'form button[type="submit"], form input[type="submit"], form button:not([type])',
        ),
      ).filter((el) => rgaa.isRendered(el) && !isDisabled(el))
    }
    return lists.current.length
  }

  const reveal: CouleursLib['reveal'] = (index) => {
    const el = lists.current[index]
    if (!el?.isConnected || !rgaa.isRendered(el)) return null
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    const x = Math.min(window.innerWidth - 1, Math.max(1, rect.left + rect.width / 2))
    const y = Math.min(window.innerHeight - 1, Math.max(1, rect.top + rect.height / 2))
    return { x, y, label: describe(el) }
  }

  const snapshotRest: CouleursLib['snapshotRest'] = () => {
    const items = rgaa.tabbables()
    for (const el of items) {
      const style = getComputedStyle(el)
      restSnapshot.set(el, { background: style.backgroundColor, border: style.borderTopColor })
    }
    return items.length
  }

  const observe: CouleursLib['observe'] = (index) => {
    const el = index < 0 ? document.activeElement : (lists.current[index] ?? null)
    const empty: Observation = {
      focus: null,
      texts: [],
      fields: [],
      icons: [],
      images: [],
      probes: [],
      moved: false,
    }
    if (!el || el === document.body || !el.isConnected) return empty
    const texts = collectText()
    const fields = collectFields()
    const icons = collectIcons()
    const images = collectImages()
    const ids = new Set(scope(el))
    for (const desc of texts) ids.add(desc.id)
    return {
      focus: index < 0 ? focusInfo(el) : null,
      texts,
      fields,
      icons,
      images,
      probes: probe(Array.from(ids)),
      moved: true,
    }
  }

  const probe: CouleursLib['probe'] = (ids) =>
    ids.map((id) => {
      const target = targets.get(id)
      return target
        ? probeOne(target)
        : { id, status: 'invisible' as const, boxes: [], full: false }
    })

  window.__couleurs = {
    collectText,
    collectFields,
    invalidFields,
    collectIcons,
    collectImages,
    collectMedia,
    probe,
    plan,
    scrollTo,
    pinnedTargets,
    scrollMax,
    ref: (id) => {
      const el = targets.get(id)?.el
      return el ? rgaa.ref(el) : null
    },
    scope,
    list,
    reveal,
    observe,
    snapshotRest,
    cueNow: (index) => {
      const el = lists.current[index]
      const block = el?.closest(TEXT_BLOCK)
      return el && block ? cueOf(el, block) : null
    },
    focusIndex: (index) => {
      const el = lists.current[index] as HTMLElement | undefined
      el?.focus({ focusVisible: true } as FocusOptions)
    },
    label: (index) => (lists.current[index] ? describe(lists.current[index] as Element) : ''),
    isOpen: (index) => {
      const el = lists.current[index]
      if (!el) return false
      if (el.localName === 'summary')
        return Boolean((el.parentElement as HTMLDetailsElement | null)?.open)
      return (
        el.getAttribute('aria-expanded') === 'true' || el.getAttribute('aria-selected') === 'true'
      )
    },
    stylesheetsReactToDark,
    mechanismCandidates,
    linkCues,
    colorWords,
    coloredInline,
    iconControls,
    shadowHostCount,
    stateGroups,
    swatches,
    disabledTextCount,
    pseudoTextCount,
  }
}

/** Feuille de style qui rend le texte transparent et fige les transitions, pour lire le fond seul. */
export const HIDE_TEXT_CSS = `
*, *::before, *::after {
  transition: none !important;
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
  pointer-events: auto !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  text-decoration-color: transparent !important;
  -webkit-text-stroke: 0 !important;
}
svg text, svg tspan { fill: transparent !important; stroke: transparent !important; }
::placeholder { -webkit-text-fill-color: transparent !important; }
`
