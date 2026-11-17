import type { Page } from 'playwright'
import type { PageContext } from '../core/types.ts'
import type { RgaaElementRef } from '../inpage/types.d.ts'
import { disclosureTogglers, revealOnScroll } from './presentation-inpage.ts'
import { compareCaptures, type Difference, decodePng } from './presentation-png.ts'
import {
  type Digest,
  type FocusInfo,
  type HoverTarget,
  installProbe,
  type ProbeReveal,
} from './presentation-probe.ts'

/**
 * Parcours d'interaction d'une page neuve : tabulation réelle sur chaque
 * contrôle (rendu avec et sans focus, contenus qui apparaissent), puis survol
 * des déclencheurs probables. Résultat partagé par 10.6, 10.7, 10.13 et 10.14.
 */

const MAX_TABS = 250
const POOL = 120
/** Marge autour de la zone mesurée : outline, anneau d'ombre, bordure. */
const PAD = 14
/** Pixels à fort contraste (3:1) en dessous desquels un changement n'est pas un indicateur. */
const STRONG_MIN = 10
const CHANGED_MIN = 6

export type FocusVerdict = 'visible' | 'weak' | 'invisible' | 'unmeasured'

export interface FocusRecord {
  ref: RgaaElementRef
  tag: string
  name: string
  href: string | null
  verdict: FocusVerdict
  /** Ce qui change (lisible), ou la raison de l'invisibilité. */
  detail: string
  /** Empreinte du rendu avec/sans focus : un même rendu n'est mesuré qu'une fois. */
  signature: string
  before: Digest
  after: Digest
  difference: Difference | null
  reveals: ProbeReveal[]
  /** Changements d'état et fond, lisibles et stables : sert d'élément de preuve. */
  summary: string
}

export interface HoverRecord {
  ref: RgaaElementRef
  tag: string
  before: Digest
  after: Digest
  reveals: ProbeReveal[]
}

export interface ActivationResult {
  /** Sélecteur du contenu caché. */
  target: string
  controller: string
  /** Révélé à l'écran par une action clavier sur le contrôle. */
  revealed: boolean
  /** Une fois révélé, est-il encore retiré de l'arbre d'accessibilité (aria-hidden, inert) ? */
  stillHidden: boolean
  /** Le contrôle n'est pas visible à cette largeur. */
  controllerHidden: boolean
}

export interface ScanResult {
  /** Page de la tabulation, laissée ouverte (captures des jugements) : à fermer par le dernier consommateur. */
  page: Page
  focus: FocusRecord[]
  hover: HoverRecord[]
  /** Contrôles atteints à la tabulation, et nombre de contenus masqués repérés. */
  tabbed: number
  hiddenRoots: number
  notes: string[]
  /** Essais d'activation au clavier des contrôles `aria-controls` (10.8). */
  activations: ActivationResult[]
}

function changes(before: Digest, after: Digest): string[] {
  return Object.keys(after)
    .filter((prop) => before[prop] !== after[prop])
    .map((prop) => `${prop} ${before[prop] ?? ''} → ${after[prop] ?? ''}`)
}

async function capture(page: Page, area: { x: number; y: number; width: number; height: number }) {
  const viewport = page.viewportSize() ?? { width: 1280, height: 900 }
  const x = Math.max(0, Math.floor(area.x - PAD))
  const y = Math.max(0, Math.floor(area.y - PAD))
  const right = Math.min(viewport.width, Math.ceil(area.x + area.width + PAD))
  const bottom = Math.min(viewport.height, Math.ceil(area.y + area.height + PAD))
  const clip = { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
  return decodePng(await page.screenshot({ clip, caret: 'hide', timeout: 20_000 }))
}

/** Mesure l'indicateur de focus de l'élément qui a actuellement le focus. */
/**
 * Mesure l'indicateur de focus de l'élément qui a actuellement le focus. Une
 * capture qui échoue (machine chargée) est refaite ; si elle échoue encore, l'erreur
 * remonte : on ne conclut jamais « focus invisible » d'une mesure qui n'a pas eu lieu.
 */
async function measureFocus(page: Page, info: FocusInfo): Promise<Difference | null> {
  if (!info.area) return null
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const after = await capture(page, info.area)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      const before = await capture(page, info.area)
      await page.waitForTimeout(60)
      const again = await capture(page, info.area)
      await page.evaluate((selector) => window.__probe?.refocus(selector), info.ref.selector)
      return compareCaptures(before, after, again)
    } catch (error) {
      lastError = error
      await page
        .evaluate((selector) => window.__probe?.refocus(selector), info.ref.selector)
        .catch(() => {})
    }
  }
  throw lastError
}

export async function scanInteractions(
  ctx: PageContext,
  controls: { controller: string; target: string }[],
): Promise<ScanResult> {
  // Mouvement réduit : ce qui se met en mouvement tout seul (mot qui défile, carrousel) ne se prend pas pour un contenu qui apparaît au focus.
  const page = await ctx.fresh({ reducedMotion: 'reduce' })
  const notes: string[] = []
  // Contenus révélés au défilement mis en place avant de repérer ceux qui sont masqués.
  await page.evaluate(revealOnScroll)
  const hiddenRoots = await page.evaluate(installProbe, { transitions: false })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(0, 0)

  // ─ Tabulation réelle ─
  const focus: FocusRecord[] = []
  const measured = new Map<
    string,
    { verdict: FocusVerdict; difference: Difference | null; detail: string }
  >()
  const visitedSelectors = new Set<string>()
  let previous: number[] = []
  let mark = 0

  /** Mesure l'élément qui a le focus : rendu avec/sans focus, contenus apparus. */
  const record = async (info: FocusInfo) => {
    visitedSelectors.add(info.ref.selector)
    previous = info.shown
    mark = info.mark
    const signature = JSON.stringify([info.before, info.after, info.backdrop, info.boxless])
    const delta = changes(info.before, info.after)
    const summary = `${delta.slice(0, 5).join(' ; ') || 'aucun changement de style'} (fond ${info.backdrop})`
    let result = measured.get(signature)
    if (!result) {
      let difference: Difference | null = null
      let verdict: FocusVerdict
      let detail: string | undefined
      if (!info.area) {
        verdict = 'invisible'
        detail =
          'l’élément reçoit le focus mais n’a aucune boîte visible (ni lui ni ses conteneurs proches)'
      } else {
        try {
          difference = await measureFocus(page, info)
        } catch (error) {
          detail =
            error instanceof Error ? (error.message.split('\n')[0] ?? 'erreur') : String(error)
        }
        if (!difference) {
          verdict = 'unmeasured'
          detail = `mesure impossible (${detail ?? 'erreur'})`
        } else if (
          difference.changed < CHANGED_MIN &&
          !(await page.evaluate((s) => {
            // Rendu, pas forcément visible : une case à cocher d'1 px transparente garde son focus lisible sur son libellé.
            const el = document.querySelector(s)
            return el !== null && window.__rgaa.isRendered(el)
          }, info.ref.selector))
        ) {
          // L'élément a reçu le focus quand son menu était ouvert, mais il est masqué à nouveau (menu replié) :
          // la mesure porte sur du vide. On ne conclut pas.
          verdict = 'unmeasured'
          detail =
            'l’élément n’était plus affiché au moment de la mesure (contenu replié après la tabulation)'
        } else if (difference.changed < CHANGED_MIN) {
          verdict = 'invisible'
          detail = `aucun changement visible à l’écran entre l’état sans focus et avec focus (${difference.changed} pixel(s) modifié(s))`
        } else if (difference.strong >= STRONG_MIN) {
          verdict = 'visible'
          detail = `${difference.strong} pixels changent avec un contraste d’au moins 3:1`
        } else {
          verdict = 'weak'
          detail = `le changement existe (${difference.changed} pixels) mais son contraste reste inférieur à 3:1 (meilleur : ${difference.maxContrast.toFixed(2)}:1)`
        }
      }
      result = { verdict, difference, detail: detail ?? '' }
      measured.set(signature, result)
    }
    focus.push({
      ref: info.ref,
      tag: info.tag,
      name: info.name,
      href: info.href,
      verdict: result.verdict,
      detail: result.detail,
      signature,
      before: info.before,
      after: info.after,
      difference: result.difference,
      reveals: info.reveals,
      summary,
    })
  }
  const step = () =>
    page.evaluate(
      ([shown, since]) => window.__probe?.focusStep(shown as number[], since as number) ?? null,
      [previous, mark],
    )

  let last: string | null = null
  for (let n = 0; n < MAX_TABS; n++) {
    await page.keyboard.press('Tab')
    let info: FocusInfo | null = await step()
    if (!info) {
      // Retour au début du document (ou sortie de page) : le tour est fait.
      if (focus.length > 0) break
      continue
    }
    if (info.ref.selector === last) {
      // La tabulation n'avance plus (cadre incorporé, piège) : on passe au contrôle suivant à la main.
      const moved = await page.evaluate(() => window.__probe?.focusNext() ?? false)
      if (!moved) break
      info = await step()
      if (!info) break
    }
    if (visitedSelectors.has(info.ref.selector)) break
    last = info.ref.selector
    await record(info)
  }

  // Contrôles que la tabulation n'a pas atteints (ordre, pièges) : focus direct, même mesure.
  const missed = await page.evaluate(() => window.__probe?.unvisited() ?? [])
  for (const selector of missed.slice(0, 60)) {
    if (visitedSelectors.has(selector)) continue
    const ok = await page.evaluate((s) => window.__probe?.refocus(s) ?? false, selector)
    if (!ok) continue
    const info = await step()
    if (info && !visitedSelectors.has(info.ref.selector)) await record(info)
  }
  if (missed.length > 60)
    notes.push(`${missed.length - 60} contrôles hors parcours de tabulation non mesurés.`)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  // ─ Survol ─
  const hover: HoverRecord[] = []
  const pool = await page.evaluate((limit) => window.__probe?.buildPool(limit) ?? 0, POOL)
  let dirty = false
  for (let index = 0; index < pool; index++) {
    // Le pointeur ne revient au coin que si le survol précédent a fait apparaître du contenu.
    if (dirty) await page.mouse.move(0, 0)
    dirty = false
    const target: HoverTarget | null = await page.evaluate(
      (i) => window.__probe?.prepareHover(i) ?? null,
      index,
    )
    if (!target) continue
    await page.mouse.move(target.x, target.y)
    const after = await page.evaluate(
      ([i, before, since]) =>
        window.__probe?.afterHover(i as number, before as number[], since as number),
      [index, target.before, target.mark],
    )
    if (!after) continue
    dirty = after.reveals.length > 0
    hover.push({
      ref: target.ref,
      tag: target.tag,
      before: target.digest,
      after: after.digest,
      reveals: after.reveals,
    })
  }
  await page.mouse.move(0, 0)

  // ─ États ouverts : activation au clavier des contrôles de divulgation ─
  // Révèle-t-il le contenu qu'il référence (10.8) ? Le focus des contrôles qui apparaissent est mesuré aussi (10.7).
  const activations: ActivationResult[] = []
  const extra = await page.evaluate(disclosureTogglers, 6)
  const controllers = Array.from(new Set([...controls.map((c) => c.controller), ...extra])).slice(
    0,
    40,
  )
  if (controllers.length > 0) {
    // Un lien ne doit pas changer de page : son défaut est annulé avant les gestionnaires du site.
    await page.evaluate(() => {
      document.addEventListener(
        'click',
        (event) => {
          if ((event.target as Element | null)?.closest('a[href]')) event.preventDefault()
        },
        true,
      )
    })
    const isRevealed = (selector: string) =>
      page.evaluate((s) => window.__probe?.isRevealed(s) ?? false, selector)
    for (const controller of controllers) {
      const pairs = controls.filter((c) => c.controller === controller)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      const visible = await page.evaluate((s) => {
        const el = document.querySelector(s)
        return el ? window.__rgaa.isVisible(el) : false
      }, controller)
      if (!visible) {
        for (const pair of pairs) {
          activations.push({ ...pair, revealed: false, stillHidden: false, controllerHidden: true })
        }
        continue
      }
      const before = new Set(await page.evaluate(() => window.__probe?.tabbableSelectors() ?? []))
      await page.evaluate((s) => window.__probe?.refocus(s), controller)
      let revealedAll = false
      for (const key of ['Enter', 'Space']) {
        await page.keyboard.press(key)
        await page.waitForTimeout(140)
        if (pairs.length === 0) break
        const states = await Promise.all(pairs.map((pair) => isRevealed(pair.target)))
        revealedAll = states.every(Boolean)
        if (revealedAll) break
      }
      for (const pair of pairs) {
        const revealed = await isRevealed(pair.target)
        const stillHidden = revealed
          ? await page.evaluate((s) => window.__probe?.hiddenFromAT(s) ?? false, pair.target)
          : false
        activations.push({ ...pair, revealed, stillHidden, controllerHidden: false })
      }
      // Contrôles apparus avec l'ouverture : focus mesuré comme les autres.
      const now = await page.evaluate(() => window.__probe?.tabbableSelectors() ?? [])
      const appeared = now.filter((s) => !before.has(s) && !visitedSelectors.has(s)).slice(0, 40)
      for (const selector of appeared) {
        const ok = await page.evaluate((s) => window.__probe?.refocus(s) ?? false, selector)
        if (!ok) continue
        const info = await step()
        if (info && !visitedSelectors.has(info.ref.selector)) await record(info)
      }
      // Referme (Échap, sinon la même touche) : le contrôle suivant part d'un état connu.
      await page.evaluate((s) => window.__probe?.refocus(s), controller)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(100)
      const stillOpen = pairs[0]
        ? await isRevealed(pairs[0].target)
        : (await page.evaluate(() => window.__probe?.tabbableSelectors().length ?? 0)) > before.size
      if (stillOpen) {
        await page.evaluate((s) => window.__probe?.refocus(s), controller)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(140)
      }
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  }
  return { page, focus, hover, tabbed: focus.length, hiddenRoots, notes, activations }
}
