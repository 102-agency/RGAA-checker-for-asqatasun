import type { Page } from 'playwright'
import type { PageContext } from '../core/types.ts'
import {
  disclosureTogglers,
  type HorizontalOverflow,
  horizontalOverflow,
  type Inventory,
  type LayoutSnapshot,
  layoutSnapshot,
  reachableInventory,
  revealOnScroll,
  setToggle,
  stripStyles,
  type VerticalBlock,
  verticalBlocks,
} from './presentation-inpage.ts'

/**
 * Mesures de mise en page de la thématique 10 sur UNE page neuve qu'on
 * redimensionne et modifie tour à tour : espacement du texte (10.12), zoom à
 * 200 % (10.4.1), reflow à 320 px (10.11), page sans styles (10.2). Charger une
 * page par variante coûterait trois secondes chacune.
 */

/** Zoom 200 % : la fenêtre de 1280×900 devient de 640×450 pixels CSS. */
export const ZOOM = { width: 640, height: 450 }
export const REFLOW = { width: 320, height: 800 }
const FULL = { width: 1280, height: 900 }
const SHORT = { width: 1280, height: 256 }

/** Valeurs de l'indicateur WCAG 1.4.12, imposées partout. */
const SPACING_CSS = `
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`

export interface LostText {
  t: string
  href: string | null
}

/** Mise en page avec un menu, un panneau ou un accordéon ouvert. */
export interface OpenState {
  toggler: string
  label: string
  snapshot: LayoutSnapshot
}

export interface ViewportMeasure {
  snapshot: LayoutSnapshot
  /** États ouverts à cette taille de fenêtre. */
  open: OpenState[]
  overflow: HorizontalOverflow
  /** Contenus visibles à 1280 px, absents ici même après avoir déplié les contrôles. */
  lost: LostText[]
}

export interface Measures {
  /** Page de référence (1280×900), allégée de ce qui change tout seul. */
  base: LayoutSnapshot
  /** États ouverts à 1280 px, sans modification : référence des états ouverts avec espacement. */
  baseOpen: OpenState[]
  spacing: LayoutSnapshot
  spacingOpen: OpenState[]
  zoom: ViewportMeasure
  narrow: ViewportMeasure
  vertical: { present: VerticalBlock[]; short: VerticalBlock[] }
  /** Page sans feuilles de styles. */
  bare: LayoutSnapshot
}

/** Un contenu retrouvé sous une autre forme compte comme conservé. */
function covered(item: LostText, seen: Pick<Inventory, 'hrefs' | 'names'>): boolean {
  const needle = item.t.toLowerCase()
  // Texte réduit à une icône : le contrôle garde son nom accessible.
  if (seen.names.some((name) => name.toLowerCase().includes(needle))) return true
  // Lien masqué : sa destination reste offerte par un autre lien visible.
  return item.href !== null && seen.hrefs.includes(item.href)
}

const OPEN_STATES = 3

/** Ouvre, un à un, les premiers contrôles de divulgation et photographie la page ouverte. */
async function openStates(page: Page, selectors?: string[]): Promise<OpenState[]> {
  const list = selectors ?? (await page.evaluate(disclosureTogglers, OPEN_STATES))
  const out: OpenState[] = []
  for (const toggler of list) {
    const label = await page.evaluate(setToggle, { selector: toggler, open: true })
    if (label === null) continue
    await page.waitForTimeout(160)
    out.push({ toggler, label, snapshot: await page.evaluate(layoutSnapshot) })
    await page.evaluate(setToggle, { selector: toggler, open: false })
    await page.waitForTimeout(80)
  }
  return out
}

async function resize(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size)
  // Laisse le temps aux requêtes média, conteneurs et gestionnaires de redimensionnement.
  await page.waitForTimeout(300)
}

export function layoutMeasures(ctx: PageContext): Promise<Measures> {
  return ctx.memo('presentation.measures', async () => {
    const first = await ctx.page.evaluate(layoutSnapshot)
    // Mouvement réduit : le mot qui défile, les révélations animées se figent, la mesure ne dépend plus de l'instant.
    const page = await ctx.fresh({ viewport: FULL, reducedMotion: 'reduce' })
    try {
      await page.evaluate(revealOnScroll)
      // 10.12 : espacement du texte (états ouverts avec et sans espacement).
      const baseOpen = await openStates(page)
      const style = await page.addStyleTag({ content: SPACING_CSS })
      await page.waitForTimeout(150)
      const spacing = await page.evaluate(layoutSnapshot)
      const spacingOpen = await openStates(
        page,
        baseOpen.map((state) => state.toggler),
      )
      await style.evaluate((el) => (el as unknown as Element).remove())

      // 10.4.1 et 10.11.1 : fenêtre réduite.
      await resize(page, ZOOM)
      const zoomSnapshot = await page.evaluate(layoutSnapshot)
      const zoomOverflow = await page.evaluate(horizontalOverflow)
      const zoomOpen = await openStates(page)
      await resize(page, REFLOW)
      const narrowSnapshot = await page.evaluate(layoutSnapshot)
      const narrowOverflow = await page.evaluate(horizontalOverflow)
      const narrowOpen = await openStates(page)

      // 10.11.2 : contenus à lecture verticale, fenêtre de 256 px de haut.
      const present = await ctx.page.evaluate(verticalBlocks)
      let short: VerticalBlock[] = []
      if (present.length > 0) {
        await resize(page, SHORT)
        short = await page.evaluate(verticalBlocks)
      }

      // Textes de la page de référence qui changent seuls (mot qui défile, horloge) : écartés.
      const again = await ctx.page.evaluate(layoutSnapshot)
      const stable = new Set(again.texts.map((item) => item.t))
      const base: LayoutSnapshot = {
        ...first,
        texts: first.texts.filter((item) => stable.has(item.t)),
      }

      // Contenus perdus : l'inventaire se refait après dépliage des contrôles (modifie la page, d'où la fin).
      const lost = async (snapshot: LayoutSnapshot, size: { width: number; height: number }) => {
        const present = new Set(snapshot.texts.map((item) => item.t))
        const seen = new Set<string>()
        const missing = base.texts.filter((item) => {
          if (present.has(item.t) || seen.has(item.t)) return false
          seen.add(item.t)
          return !covered(item, snapshot)
        })
        if (missing.length === 0) return []
        await resize(page, size)
        const sample = await page.evaluate(layoutSnapshot)
        const reachable = await page.evaluate(reachableInventory)
        const known = new Set([...sample.texts, ...reachable.texts].map((item) => item.t))
        const names = {
          hrefs: [...sample.hrefs, ...reachable.hrefs],
          names: [...sample.names, ...reachable.names],
        }
        return missing.filter((item) => !known.has(item.t) && !covered(item, names))
      }
      const zoomLost = await lost(zoomSnapshot, ZOOM)
      const narrowLost = await lost(narrowSnapshot, REFLOW)

      // 10.2 : page sans styles (destructif : en dernier).
      await resize(page, FULL)
      await page.evaluate(stripStyles)
      await page.waitForTimeout(150)
      const bare = await page.evaluate(layoutSnapshot)
      const bare2 = await page.evaluate(layoutSnapshot)
      const bareTexts = new Set([...bare.texts, ...bare2.texts].map((item) => item.t))
      bare.texts = Array.from(bareTexts, (t) => ({ t, href: null }))

      return {
        base,
        baseOpen,
        spacing,
        spacingOpen,
        zoom: { snapshot: zoomSnapshot, open: zoomOpen, overflow: zoomOverflow, lost: zoomLost },
        narrow: {
          snapshot: narrowSnapshot,
          open: narrowOpen,
          overflow: narrowOverflow,
          lost: narrowLost,
        },
        vertical: { present, short },
        bare,
      }
    } finally {
      await page
        .context()
        .close()
        .catch(() => {})
    }
  })
}
