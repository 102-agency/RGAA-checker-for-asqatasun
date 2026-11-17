import type { Page } from 'playwright'
import {
  type BoxTuple,
  type ColoredInline,
  type FieldDesc,
  type FocusInfo,
  HIDE_TEXT_CSS,
  type IconDesc,
  type ImageDesc,
  installCouleurs,
  type LinkCue,
  type MediaDesc,
  type Observation,
  type ProbeResult,
  type RefTuple,
  type RgbaTuple,
  type StateGroup,
  type Swatch,
  type TextDesc,
} from './couleurs-inpage.ts'
import {
  type Bitmap,
  type Box,
  blend,
  colorDiversity,
  contrast,
  decodePng,
  hex,
  type Rgb,
  samplePixels,
  unpack,
  worstContrast,
} from './couleurs-pixels.ts'

/**
 * Mesure des contrastes en vrai navigateur (thématique 3).
 *
 * Principe : sur une page dont le texte est rendu transparent, la capture d'écran
 * donne le fond réellement peint derrière chaque texte (image, dégradé,
 * transparence, couleurs oklab/oklch comprises). La couleur du texte vient du
 * style calculé, opacité des ancêtres comprise. Le contraste retenu est celui du
 * pire pixel significatif (voir `worstContrast`).
 */

export interface TextResult {
  desc: TextDesc
  /** `repos`, ou l'état dans lequel le texte a été mesuré (`survol`, `focus`, `panneau`, `erreur`). */
  state: string
  size: number
  weight: number
  color: RgbaTuple
  ratio: number
  background: Rgb
  foreground: Rgb
  backgrounds: number
}

export interface FieldResult {
  desc: FieldDesc
  state: string
  ratio: number
  source: string
  adjacent: Rgb | null
}

export interface IconFailure {
  test: '3.3.2' | '3.3.3'
  message: string
}
export interface IconResult {
  desc: IconDesc
  failures: IconFailure[]
  complex: boolean
  measured: boolean
}

export interface FocusResult {
  info: FocusInfo
  ratio: number
  indicator: string
}

export interface ImageResult {
  desc: ImageDesc
  photo: boolean
  diversity: number
}

export interface Unmeasured {
  kind: string
  text: string
  reason: string
}

export interface Mesures {
  texts: TextResult[]
  fields: FieldResult[]
  icons: IconResult[]
  focus: FocusResult[]
  images: ImageResult[]
  /** États (aria-current, aria-selected…) rencontrés dans les panneaux ouverts, hors inventaire initial. */
  stateGroups: StateGroup[]
  unmeasured: Unmeasured[]
  notes: string[]
}

export interface Statics {
  linkCues: LinkCue[]
  colorWords: { sentence: string; ref: RefTuple }[]
  coloredInline: ColoredInline[]
  iconControls: { name: string; ref: RefTuple }[]
  shadowHosts: number
  stateGroups: StateGroup[]
  swatches: Swatch[]
  media: MediaDesc[]
  mechanisms: { name: string; ref: RefTuple }[]
  darkReact: boolean
  pseudoText: number
  disabled: number
}

export interface MesureOptions {
  /** Explore survol, focus, panneaux fermés et erreurs de formulaire. */
  states: boolean
  /** Budget de temps pour l'exploration des états, en millisecondes. */
  budgetMs?: number
}

const MAX_HOVER_STATES = 40
const MAX_FOCUS_STEPS = 200
const MAX_PANELS = 45

const colorKey = (color: readonly number[] | undefined): string => (color ? color.join(',') : '')

function ringPixels(bitmap: Bitmap, box: Box, extent: number, limit = 900): Map<number, number> {
  const [x, y, w, h] = box
  const d = extent + 2
  const thickness = 3
  const pixels = new Map<number, number>()
  samplePixels(bitmap, [x, y - d - thickness, w, thickness], limit, pixels)
  samplePixels(bitmap, [x, y + h + d, w, thickness], limit, pixels)
  samplePixels(bitmap, [x - d - thickness, y, thickness, h], limit, pixels)
  samplePixels(bitmap, [x + w + d, y, thickness, h], limit, pixels)
  return pixels
}

function innerPixels(bitmap: Bitmap, box: Box, inset: number, limit = 900): Map<number, number> {
  const [x, y, w, h] = box
  const t = 2
  const pixels = new Map<number, number>()
  if (w < 2 * inset + 2 * t || h < 2 * inset + 2 * t) return pixels
  samplePixels(bitmap, [x + inset, y + inset, w - 2 * inset, t], limit, pixels)
  samplePixels(bitmap, [x + inset, y + h - inset - t, w - 2 * inset, t], limit, pixels)
  samplePixels(bitmap, [x + inset, y + inset, t, h - 2 * inset], limit, pixels)
  samplePixels(bitmap, [x + w - inset - t, y + inset, t, h - 2 * inset], limit, pixels)
  return pixels
}

function dominantColor(pixels: Map<number, number>): Rgb | null {
  let best: { key: number; count: number } | null = null
  for (const [key, count] of pixels) if (!best || count > best.count) best = { key, count }
  return best ? unpack(best.key) : null
}

function contains(outer: BoxTuple, inner: BoxTuple, tolerance = 1.5): boolean {
  return (
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    inner[0] + inner[2] <= outer[0] + outer[2] + tolerance &&
    inner[1] + inner[3] <= outer[1] + outer[3] + tolerance &&
    // Même boîte : ce n'est pas un contenant.
    (outer[2] > inner[2] + tolerance || outer[3] > inner[3] + tolerance)
  )
}

export class CouleursSession {
  readonly texts: TextResult[] = []
  readonly fields: FieldResult[] = []
  readonly icons: IconResult[] = []
  readonly focus: FocusResult[] = []
  readonly images: ImageResult[] = []
  readonly stateGroups: StateGroup[] = []
  readonly unmeasured: Unmeasured[] = []
  readonly notes: string[] = []

  private readonly textDescs = new Map<number, TextDesc>()
  private readonly fieldDescs = new Map<number, FieldDesc>()
  private readonly iconDescs = new Map<number, IconDesc>()
  private readonly imageDescs = new Map<number, ImageDesc>()
  /** Signature et couleur de chaque texte au repos, pour repérer ce que le survol ou le focus change. */
  private readonly rest = new Map<number, { sig: string; color: string }>()
  private readonly seenStates = new Set<string>()
  private deadline = Number.POSITIVE_INFINITY
  private readonly truncated = new Set<string>()
  private readonly failedSteps: string[] = []

  constructor(readonly page: Page) {}

  async install(): Promise<void> {
    await this.page.evaluate(installCouleurs)
  }

  /** Rend le texte transparent et fige les transitions : à appeler après les inventaires statiques. */
  async hideText(): Promise<void> {
    await this.page.evaluate((css) => {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(css)
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
    }, HIDE_TEXT_CSS)
  }

  private register(observation: Pick<Observation, 'texts' | 'fields' | 'icons' | 'images'>): {
    texts: number[]
    fields: number[]
    icons: number[]
    images: number[]
  } {
    for (const d of observation.texts) this.textDescs.set(d.id, d)
    for (const d of observation.fields) this.fieldDescs.set(d.id, d)
    for (const d of observation.icons) this.iconDescs.set(d.id, d)
    for (const d of observation.images) this.imageDescs.set(d.id, d)
    return {
      texts: observation.texts.map((d) => d.id),
      fields: observation.fields.map((d) => d.id),
      icons: observation.icons.map((d) => d.id),
      images: observation.images.map((d) => d.id),
    }
  }

  async shoot(): Promise<Bitmap> {
    const buffer = await this.page.screenshot({
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      timeout: 20_000,
    })
    return decodePng(buffer)
  }

  /**
   * Mesure les cibles `ids` : défile jusqu'à chacune (`scroll`), capture la fenêtre
   * et confie chaque cible mesurable à `handler`. Renvoie celles qui n'ont pas pu
   * l'être, avec la raison.
   */
  async sweep(
    ids: number[],
    handler: (probe: ProbeResult, bitmap: Bitmap) => void,
    scroll: boolean,
    at?: number,
  ): Promise<Map<number, string>> {
    const pending = new Set(ids)
    const left = new Map<number, string>()
    const attempts: Record<number, number> = {}
    let guard = 0
    while (pending.size > 0 && guard++ < 120) {
      const list = Array.from(pending)
      let head: number | null = null
      if (scroll) {
        const plan = await this.page.evaluate(({ i, a }) => window.__couleurs.plan(i, a), {
          i: list,
          a: attempts,
        })
        if (!plan) {
          for (const id of list) left.set(id, 'détaché de la page')
          break
        }
        head = plan.head
        await this.page.evaluate((y) => window.__couleurs.scrollTo(y ?? window.scrollY), plan.y)
      } else {
        await this.page.evaluate((y) => window.__couleurs.scrollTo(y ?? window.scrollY), at ?? null)
      }
      const probes = await this.page.evaluate((i) => window.__couleurs.probe(i), list)
      const bitmap = await this.shoot()
      for (const probe of probes) {
        if (probe.status === 'invisible') {
          pending.delete(probe.id)
          left.set(probe.id, 'invisible')
        } else if (probe.status === 'ok' && probe.full) {
          handler(probe, bitmap)
          pending.delete(probe.id)
        }
      }
      if (!scroll) {
        for (const id of pending) {
          const status = probes.find((p) => p.id === id)?.status ?? 'hors'
          left.set(id, status === 'masque' ? 'recouvert' : 'hors du cadre')
        }
        break
      }
      if (head !== null && pending.has(head)) {
        attempts[head] = (attempts[head] ?? 0) + 1
        if ((attempts[head] ?? 0) >= 3) {
          pending.delete(head)
          const status = probes.find((p) => p.id === head)?.status
          left.set(head, status === 'masque' ? 'recouvert' : 'hors du cadre')
        }
      }
    }
    for (const id of pending) left.set(id, 'non mesuré')
    return left
  }

  // ─── Gestionnaires par nature de cible ─────────────────────────────────────

  private textHandler(state: string) {
    return (probe: ProbeResult, bitmap: Bitmap): void => {
      const desc = this.textDescs.get(probe.id)
      if (!desc) return
      const pixels = new Map<number, number>()
      for (const box of probe.boxes) {
        samplePixels(bitmap, box, Math.ceil(4000 / probe.boxes.length), pixels)
      }
      const color = probe.color ?? desc.color
      const worst = worstContrast(color, pixels)
      if (!worst) {
        this.unmeasured.push({ kind: 'texte', text: desc.text, reason: 'aucun pixel' })
        return
      }
      if (state === 'repos')
        this.rest.set(probe.id, { sig: probe.sig ?? '', color: colorKey(color) })
      this.texts.push({
        desc,
        state,
        size: probe.size ?? desc.size,
        weight: probe.weight ?? desc.weight,
        color,
        ratio: worst.ratio,
        background: worst.background,
        foreground: worst.foreground,
        backgrounds: worst.backgrounds,
      })
    }
  }

  private fieldHandler(state: string) {
    return (probe: ProbeResult, bitmap: Bitmap): void => {
      const desc = this.fieldDescs.get(probe.id)
      const box = probe.boxes[0]
      if (!desc || !box) return
      const extent = Math.max(desc.extent, probe.ringExtra ?? 0)
      const adjacent = ringPixels(bitmap, box, extent)
      const adjacentColor = dominantColor(adjacent)
      if (!adjacentColor) {
        this.unmeasured.push({ kind: 'champ', text: desc.label, reason: 'fond contigu illisible' })
        return
      }
      let best = { ratio: 1, source: 'aucun' }
      for (const border of desc.borders) {
        const worst = worstContrast(border.color, adjacent)
        if (worst && worst.ratio > best.ratio) best = { ratio: worst.ratio, source: 'contour' }
      }
      for (const shadow of desc.shadows) {
        const worst = worstContrast(shadow.color, adjacent)
        if (worst && worst.ratio > best.ratio) best = { ratio: worst.ratio, source: 'ombre' }
      }
      const inset = Math.max(0, ...desc.borders.map((b) => b.width)) + 1
      const fill = dominantColor(innerPixels(bitmap, box, inset))
      if (fill) {
        const worst = worstContrast([fill[0], fill[1], fill[2], 1], adjacent)
        if (worst && worst.ratio > best.ratio) best = { ratio: worst.ratio, source: 'fond' }
      }
      this.fields.push({
        desc,
        state,
        ratio: best.ratio,
        source: best.source,
        adjacent: adjacentColor,
      })
    }
  }

  private iconHandler() {
    return (probe: ProbeResult, bitmap: Bitmap): void => {
      const desc = this.iconDescs.get(probe.id)
      const box = probe.boxes[0]
      if (!desc || !box) return
      const result: IconResult = { desc, failures: [], complex: false, measured: false }
      this.icons.push(result)
      if (desc.usesUse) {
        result.complex = true
        return
      }
      const adjacent = ringPixels(bitmap, box, probe.ringExtra ?? 0)
      const adjacentColor = dominantColor(adjacent)
      if (!adjacentColor) return
      const paints = desc.paints
      if (paints.length === 0) return
      result.measured = true

      interface Layer {
        color: RgbaTuple
        kind: string
        container: number
        index: number
      }
      const layers: Layer[] = []
      paints.forEach((paint, index) => {
        if (paint.fill === 'complexe' || paint.stroke === 'complexe') result.complex = true
        // Fond d'une forme : la plus proche forme pleine qui la contient, sinon le fond contigu.
        let container = -1
        for (let j = index - 1; j >= 0; j--) {
          const outer = paints[j]
          if (
            outer &&
            Array.isArray(outer.fill) &&
            outer.fill[3] >= 0.05 &&
            contains(outer.box, paint.box)
          ) {
            container = j
            break
          }
        }
        if (Array.isArray(paint.fill) && paint.fill[3] >= 0.05)
          layers.push({ color: paint.fill, kind: 'remplissage', container, index })
        if (Array.isArray(paint.stroke) && paint.stroke[3] >= 0.05)
          layers.push({ color: paint.stroke, kind: 'trait', container, index })
      })

      /** Couleur opaque peinte d'une forme pleine, empilée sur ses contenants. */
      const backdropOf = (index: number): Rgb => {
        const paint = paints[index]
        const layer = layers.find((l) => l.index === index && l.kind === 'remplissage')
        if (!paint || !layer) return adjacentColor
        const under = layer.container >= 0 ? backdropOf(layer.container) : adjacentColor
        return blend(layer.color, under)
      }
      const nestedIn = (index: number) => layers.filter((l) => l.container === index)

      for (const layer of layers) {
        if (layer.container < 0) {
          const worst = worstContrast(layer.color, adjacent)
          if (!worst || worst.ratio >= 3) continue
          // Forme de fond (pastille) dont le contenu se détache de la page : sa teinte n'est pas nécessaire.
          const nested = nestedIn(layer.index)
          const standsOut =
            nested.length > 0 &&
            nested.every((n) => (worstContrast(n.color, adjacent)?.ratio ?? 1) >= 3)
          if (standsOut) continue
          result.failures.push({
            test: '3.3.2',
            message: `Le ${layer.kind} ${hex(layer.color)} de l’icône n’a que ${ratioText(worst.ratio)} de contraste avec le fond contigu ${hex(worst.background)} (3:1 attendus).`,
          })
        } else {
          const back = backdropOf(layer.container)
          const ratio = contrast(blend(layer.color, back), back)
          if (ratio < 1.05 || ratio >= 3) continue
          result.failures.push({
            test: '3.3.3',
            message: `Le ${layer.kind} ${hex(layer.color)} n’a que ${ratioText(ratio)} de contraste avec la forme ${hex(back)} sur laquelle il est peint (3:1 attendus).`,
          })
        }
      }
    }
  }

  private imageHandler() {
    return (probe: ProbeResult, bitmap: Bitmap): void => {
      const desc = this.imageDescs.get(probe.id)
      const box = probe.boxes[0]
      if (!desc || !box) return
      const pixels = samplePixels(bitmap, box, 8000)
      const diversity = colorDiversity(pixels)
      // Une photographie compte des centaines de teintes ; un graphique ou un texte sur aplat en compte quelques dizaines.
      this.images.push({ desc, photo: diversity >= 400, diversity })
    }
  }

  // ─── Passes ────────────────────────────────────────────────────────────────

  /** Mesure ce qui vient d'apparaître (inventaires de `observe`) dans l'état courant. */
  private async measureNew(obs: Observation, state: string, scroll: boolean): Promise<void> {
    const ids = this.register(obs)
    const textHandler = this.textHandler(state)
    const unmeasure = (left: Map<number, string>, kind: string) => {
      for (const [id, reason] of left) {
        if (reason === 'invisible') continue
        const text = kind === 'texte' ? (this.textDescs.get(id)?.text ?? '') : String(id)
        this.unmeasured.push({ kind, text, reason: `${reason} (${state})` })
      }
    }
    unmeasure(await this.sweep(ids.texts, textHandler, scroll), 'texte')
    unmeasure(await this.sweep(ids.fields, this.fieldHandler(state), scroll), 'champ')
    unmeasure(await this.sweep(ids.icons, this.iconHandler(), scroll), 'icône')
    unmeasure(await this.sweep(ids.images, this.imageHandler(), scroll), 'image')
  }

  /** Inventaire initial, puis mesure au repos sur la page au texte transparent. */
  async measureRest(): Promise<void> {
    // L'inventaire précède `hideText` : il lit l'ombre du texte, que la feuille de mesure neutralise.
    const lib = await this.page.evaluate(() => ({
      texts: window.__couleurs.collectText(),
      fields: window.__couleurs.collectFields(),
      icons: window.__couleurs.collectIcons(),
      images: window.__couleurs.collectImages(),
    }))
    await this.hideText()
    await this.measureNew({ ...lib, focus: null, probes: [], moved: true }, 'repos', true)
    await this.pinnedPass()
  }

  /**
   * En-têtes et bandeaux fixes ou collants : leur fond change quand la page défile
   * (en-tête transparent sur la bannière, opaque ensuite). On les mesure à d'autres positions.
   */
  private async pinnedPass(): Promise<void> {
    const ids = await this.page.evaluate(() => window.__couleurs.pinnedTargets())
    if (ids.length === 0) return
    const max = await this.page.evaluate(() => window.__couleurs.scrollMax())
    if (max < 200) return
    for (const at of [Math.round(max / 2), max]) {
      await this.sweep(ids, this.textHandler('défilement'), false, at)
    }
    await this.page.evaluate(() => window.__couleurs.scrollTo(0))
  }

  private timeLeft(): boolean {
    return Date.now() < this.deadline
  }

  private async changed(obs: Observation): Promise<number[]> {
    const out: number[] = []
    for (const probe of obs.probes) {
      if (probe.status !== 'ok') continue
      const before = this.rest.get(probe.id)
      if (!before || before.sig !== probe.sig || before.color !== colorKey(probe.color))
        out.push(probe.id)
    }
    return out
  }

  /** Survol : chaque élément dont une règle `:hover` peut changer l'apparence. */
  private async hoverPass(): Promise<void> {
    const count = await this.page.evaluate(() => window.__couleurs.list('survol'))
    let measured = 0
    for (let index = 0; index < count; index++) {
      if (measured >= MAX_HOVER_STATES) {
        this.notes.push(
          `Survol : ${MAX_HOVER_STATES} états distincts mesurés, les ${count - index} éléments restants ne sont pas survolés.`,
        )
        break
      }
      if (!this.timeLeft()) {
        this.truncated.add('le survol')
        break
      }
      await this.guarded('le survol', async () => {
        const point = await this.page.evaluate((i) => window.__couleurs.reveal(i), index)
        if (!point) return
        await this.page.mouse.move(point.x, point.y)
        const obs = await this.page.evaluate((i) => window.__couleurs.observe(i), index)
        const ids = this.register(obs)
        const changedIds = new Set(await this.changed(obs))
        for (const id of ids.texts) changedIds.add(id)
        if (changedIds.size === 0) return
        const media = obs.probes.some((p) => changedIds.has(p.id) && p.media)
        const key = this.stateKey(obs, changedIds)
        if (!media && this.seenStates.has(`survol:${key}`)) return
        this.seenStates.add(`survol:${key}`)
        measured++
        const state = `survol de ${point.label}`
        await this.sweep(Array.from(changedIds), this.textHandler(state), false)
        await this.measureNewOther(obs, state)
      })
    }
    await this.page.mouse.move(0, 0)
  }

  /** Signature des textes qui changent dans un état : deux états identiques ne sont mesurés qu'une fois. */
  private stateKey(obs: Observation, ids: Set<number>): string {
    return Array.from(ids)
      .map((id) => obs.probes.find((p) => p.id === id))
      .map((p) => `${colorKey(p?.color)}|${p?.sig ?? ''}`)
      .sort()
      .join('#')
  }

  /** Une étape d'exploration qui échoue (élément détaché, page qui bouge) n'arrête pas la passe, mais est comptée. */
  private async guarded(name: string, work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error) {
      this.failedSteps.push(
        `${name} : ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`,
      )
    }
  }

  /** Fields/icons/images apparus dans un état (sans recompter les textes déjà traités). */
  private async measureNewOther(obs: Observation, state: string): Promise<void> {
    if (obs.fields.length + obs.icons.length + obs.images.length === 0) return
    await this.sweep(
      obs.fields.map((d) => d.id),
      this.fieldHandler(state),
      false,
    )
    await this.sweep(
      obs.icons.map((d) => d.id),
      this.iconHandler(),
      false,
    )
    await this.sweep(
      obs.images.map((d) => d.id),
      this.imageHandler(),
      false,
    )
  }

  /** Focus clavier : textes dont l'apparence change et indicateur de focus de chaque composant. */
  private async focusPass(): Promise<void> {
    await this.page.evaluate(() => {
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      window.scrollTo({ top: 0, behavior: 'instant' })
    })
    const count = await this.page.evaluate(() => window.__couleurs.snapshotRest())
    const visited = new Set<string>()
    const indicatorCache = new Map<string, FocusResult>()
    let sweeps = 0
    let repeats = 0
    const steps = Math.min(count + 3, MAX_FOCUS_STEPS)
    if (count + 3 > MAX_FOCUS_STEPS) {
      this.notes.push(
        `Focus : ${count} éléments atteignables, seuls les ${MAX_FOCUS_STEPS} premiers sont parcourus.`,
      )
    }
    for (let step = 0; step < steps; step++) {
      if (!this.timeLeft()) {
        this.truncated.add('le focus clavier')
        break
      }
      let stop = false
      await this.guarded('le focus clavier', async () => {
        await this.page.keyboard.press('Tab')
        const obs = await this.page.evaluate(() => window.__couleurs.observe(-1))
        const info = obs.focus
        if (!obs.moved || !info) {
          // Focus sorti du document (barre du navigateur, cadre externe) : la tabulation continue.
          if (++repeats >= 4) stop = true
          return
        }
        if (visited.has(info.ref.selector)) {
          if (++repeats >= 4) stop = true
          return
        }
        repeats = 0
        visited.add(info.ref.selector)
        const ids = this.register(obs)
        const changedIds = new Set(await this.changed(obs))
        for (const id of ids.texts) changedIds.add(id)
        const interesting = Array.from(changedIds)
        const media = obs.probes.some((p) => changedIds.has(p.id) && p.media)
        const key = this.stateKey(obs, changedIds)
        if (
          interesting.length > 0 &&
          sweeps < MAX_HOVER_STATES &&
          (media || !this.seenStates.has(`focus:${key}`))
        ) {
          this.seenStates.add(`focus:${key}`)
          sweeps++
          await this.sweep(interesting, this.textHandler(`focus de ${info.tag}`), false)
        }
        await this.measureNewOther(obs, `focus de ${info.tag}`)
        await this.focusIndicator(info, indicatorCache)
      })
      if (stop) break
    }
    await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  }

  private async focusIndicator(info: FocusInfo, cache: Map<string, FocusResult>): Promise<void> {
    const candidates: { kind: string; color: RgbaTuple }[] = []
    let extent = 0
    if (info.outline) {
      candidates.push({ kind: 'contour', color: info.outline.color })
      extent = Math.max(extent, info.outline.width + Math.max(0, info.outline.offset))
    }
    for (const shadow of info.shadows) {
      candidates.push({ kind: shadow.inset ? 'ombre interne' : 'halo', color: shadow.color })
      if (!shadow.inset) extent = Math.max(extent, shadow.spread + shadow.blur)
    }
    if (info.borderChanged && info.border)
      candidates.push({ kind: 'bordure', color: info.borderColor })
    if (info.backgroundChanged && info.background[3] > 0)
      candidates.push({ kind: 'fond', color: info.background })
    // Contour natif seul : apparence du navigateur laissée telle quelle, hors du champ du critère.
    if (candidates.length === 0) return
    const key = `${candidates.map((c) => `${c.kind}${colorKey(c.color)}`).join('+')}|${extent}|${info.backdrop}`
    const cached = cache.get(key)
    if (cached && !info.media) {
      this.focus.push({ ...cached, info })
      return
    }
    const bitmap = await this.shoot()
    const adjacent = ringPixels(bitmap, info.box, extent)
    if (adjacent.size === 0) {
      this.unmeasured.push({
        kind: 'focus',
        text: info.ref.selector,
        reason: 'fond contigu illisible',
      })
      return
    }
    let best = { ratio: 0, indicator: '' }
    for (const candidate of candidates) {
      const worst = worstContrast(candidate.color, adjacent)
      if (worst && worst.ratio > best.ratio)
        best = { ratio: worst.ratio, indicator: candidate.kind }
    }
    const result: FocusResult = { info, ratio: best.ratio, indicator: best.indicator }
    cache.set(key, result)
    this.focus.push(result)
  }

  /** Panneaux fermés au chargement : menus, accordéons, onglets, `<details>`. */
  private async panelPass(): Promise<void> {
    const count = await this.page.evaluate(() => window.__couleurs.list('panneau'))
    if (count > MAX_PANELS) {
      this.notes.push(
        `Panneaux : ${count} commandes d'ouverture, seules les ${MAX_PANELS} premières sont ouvertes.`,
      )
    }
    for (let index = 0; index < Math.min(count, MAX_PANELS); index++) {
      if (!this.timeLeft()) {
        this.truncated.add('les panneaux fermés')
        break
      }
      await this.guarded('les panneaux fermés', async () => {
        const point = await this.page.evaluate((i) => window.__couleurs.reveal(i), index)
        if (!point) return
        await this.page.mouse.click(point.x, point.y)
        await this.page.waitForTimeout(120)
        const open = await this.page.evaluate((i) => window.__couleurs.isOpen(i), index)
        if (!open) return
        const obs = await this.page.evaluate((i) => window.__couleurs.observe(i), index)
        // États courants (page courante d'un menu…) visibles seulement dans le panneau ouvert.
        for (const group of await this.page.evaluate(() => window.__couleurs.stateGroups())) {
          if (!this.stateGroups.some((known) => known.ref.selector === group.ref.selector)) {
            this.stateGroups.push(group)
          }
        }
        if (obs.texts.length + obs.fields.length + obs.icons.length + obs.images.length > 0) {
          await this.measureNew(obs, `panneau ouvert par ${point.label}`, true)
        }
        // Refermer : un menu ouvert recouvrirait le reste de la page.
        const stillThere = await this.page.evaluate((i) => window.__couleurs.reveal(i), index)
        if (stillThere) await this.page.mouse.click(stillThere.x, stillThere.y)
        await this.page.waitForTimeout(60)
      })
    }
  }

  /** Erreurs de formulaire : envoi à vide, sans rien envoyer au serveur. */
  private async errorPass(initialUrl: string): Promise<void> {
    const count = await this.page.evaluate(() => window.__couleurs.list('envoi'))
    if (count === 0) return
    let navigated = false
    for (let index = 0; index < Math.min(count, 3) && !navigated; index++) {
      if (!this.timeLeft()) {
        this.truncated.add('les erreurs de formulaire')
        break
      }
      await this.guarded('les erreurs de formulaire', async () => {
        const point = await this.page.evaluate((i) => window.__couleurs.reveal(i), index)
        if (!point) return
        await this.page.mouse.click(point.x, point.y)
        await this.page.waitForTimeout(250)
        if (this.page.url().split('#')[0] !== initialUrl.split('#')[0]) {
          // Navigation côté client après un envoi à vide : ce qui s'affiche n'est plus la page auditée.
          navigated = true
          this.notes.push(
            'Un envoi à vide a changé de page : exploration des erreurs de formulaire arrêtée.',
          )
          return
        }
        const obs = await this.page.evaluate((i) => window.__couleurs.observe(i), index)
        await this.measureNew(obs, 'erreurs de formulaire', true)
        // Champs déjà connus que l'erreur fait changer d'apparence (bordure rouge…).
        const invalid = await this.page.evaluate(() => window.__couleurs.invalidFields())
        for (const desc of invalid) this.fieldDescs.set(desc.id, desc)
        await this.sweep(
          invalid.map((d) => d.id),
          this.fieldHandler('erreurs de formulaire'),
          true,
        )
      })
    }
  }

  /** Mesure complète : repos, puis (si demandé) états. */
  async run(options: MesureOptions, initialUrl: string): Promise<void> {
    this.deadline = Date.now() + (options.budgetMs ?? 45_000)
    await this.measureRest()
    if (!options.states) return
    // Les passes d'états cliquent : aucune navigation, aucun envoi au serveur.
    await this.page.route('**/*', (route) => {
      const request = route.request()
      const method = request.method()
      if (method !== 'GET' && method !== 'HEAD') return route.abort()
      if (
        request.isNavigationRequest() &&
        request.frame() === this.page.mainFrame() &&
        request.url().split('#')[0] !== initialUrl.split('#')[0]
      ) {
        return route.abort()
      }
      return route.continue()
    })
    const passes: [string, () => Promise<void>][] = [
      ['le survol', () => this.hoverPass()],
      ['le focus clavier', () => this.focusPass()],
      ['les panneaux fermés', () => this.panelPass()],
      ['les erreurs de formulaire', () => this.errorPass(initialUrl)],
    ]
    for (const [name, pass] of passes) {
      if (!this.timeLeft()) {
        this.truncated.add(name)
        continue
      }
      const started = Date.now()
      await pass()
      if (process.env.RGAA_DEBUG) console.error(`[couleurs] ${name} : ${Date.now() - started} ms`)
    }
    // Une exploration incomplète ne doit pas se solder par un « non applicable » ou un « conforme » :
    // l'audit est signalé comme incomplet (Erreur outil) plutôt que de taire ce qui n'a pas été vu.
    if (this.truncated.size > 0) {
      throw new Error(
        `Exploration des états incomplète, budget de ${Math.round((options.budgetMs ?? 45_000) / 1000)} s dépassé : ${Array.from(this.truncated).join(', ')}.`,
      )
    }
    if (this.failedSteps.length > 0) {
      this.notes.push(
        `${this.failedSteps.length} étape(s) d'exploration ont échoué (élément détaché ou page modifiée) : ${this.failedSteps.slice(0, 2).join(' ; ')}.`,
      )
    }
  }

  /** Repère (sélecteur, extrait) de l'élément d'une cible, pour le rapport. */
  async refFor(id: number): Promise<{ selector: string; snippet: string } | undefined> {
    return (
      (await this.page.evaluate((i) => window.__couleurs.ref(i), id).catch(() => null)) ?? undefined
    )
  }

  /** Inventaires statiques (3.1) : à lancer avant `hideText`. */
  async statics(): Promise<Statics> {
    return this.page.evaluate(() => ({
      linkCues: window.__couleurs.linkCues(),
      colorWords: window.__couleurs.colorWords(),
      coloredInline: window.__couleurs.coloredInline(),
      iconControls: window.__couleurs.iconControls(),
      shadowHosts: window.__couleurs.shadowHostCount(),
      stateGroups: window.__couleurs.stateGroups(),
      swatches: window.__couleurs.swatches(),
      media: window.__couleurs.collectMedia(),
      mechanisms: window.__couleurs.mechanismCandidates(),
      darkReact: window.__couleurs.stylesheetsReactToDark(),
      pseudoText: window.__couleurs.pseudoTextCount(),
      disabled: window.__couleurs.disabledTextCount(),
    }))
  }

  /** Les liens distingués par la seule couleur : un repère apparaît-il au survol et au focus ? */
  async linkStates(): Promise<{ hover: (string | null)[]; focus: (string | null)[] }> {
    const count = await this.page.evaluate(() => window.__couleurs.list('lien'))
    const hover: (string | null)[] = []
    const focus: (string | null)[] = []
    for (let index = 0; index < count; index++) {
      const point = await this.page.evaluate((i) => window.__couleurs.reveal(i), index)
      if (!point) {
        hover.push(null)
        focus.push(null)
        continue
      }
      await this.page.mouse.move(point.x, point.y)
      hover.push(await this.page.evaluate((i) => window.__couleurs.cueNow(i), index))
      await this.page.mouse.move(0, 0)
      await this.page.evaluate((i) => window.__couleurs.focusIndex(i), index)
      focus.push(await this.page.evaluate((i) => window.__couleurs.cueNow(i), index))
      await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    }
    return { hover, focus }
  }

  result(): Mesures {
    return {
      texts: this.texts,
      fields: this.fields,
      icons: this.icons,
      focus: this.focus,
      images: this.images,
      stateGroups: this.stateGroups,
      unmeasured: this.unmeasured,
      notes: this.notes,
    }
  }
}

export function ratioText(ratio: number): string {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1).replace('.', ',')}:1`
}
