import type { Page } from 'playwright'
import type { PageContext } from '../core/types.ts'
import type { RgaaElementRef } from '../inpage/types.d.ts'
import { revealOnScroll } from './presentation-inpage.ts'
import { installProbe } from './presentation-probe.ts'
import type { ScanResult } from './presentation-scan.ts'

/**
 * Essais approfondis sur une page neuve (transitions d'origine, délais réels) :
 * contenus additionnels au survol ou au focus (10.13, 10.14).
 */

const MAX_CASES = 8
const APPEAR_MS = 450
const PERSIST_MS = 1500

export interface RevealCase {
  kind: 'hover' | 'focus'
  trigger: RgaaElementRef
  root: RgaaElementRef
  text: string
  /** Le contenu apparu recouvre d'autres contenus. */
  obscures: boolean
  /** L'apparition passe par un script (le DOM a changé) plutôt que par le seul CSS. */
  mutated: boolean
  /** Le déclencheur contient le contenu : survoler le contenu, c'est survoler le déclencheur. */
  inside: boolean
}

export interface RevealResult extends RevealCase {
  /** Le contenu est réapparu lors de l'essai approfondi. */
  reproduced: boolean
  /** Peut être masqué par Échap sans bouger (`null` : sans objet, il ne recouvre rien). */
  dismissible: boolean | null
  /** Reste affiché quand le pointeur passe du déclencheur au contenu (`null` : focus, ou contenu dans le déclencheur). */
  hoverable: boolean | null
  /** Reste affiché sans limite de temps (`null` : non reproduit). */
  persistent: boolean | null
  /** Apparaît aussi autrement (focus, survol, activation) ; `null` : sans objet (script). */
  equivalent: string | null | false
}

/** Cas de contenu additionnel relevés par la tabulation et le survol. */
export function revealCases(scan: ScanResult): RevealCase[] {
  const cases = new Map<string, RevealCase>()
  const add = (
    kind: 'hover' | 'focus',
    trigger: RgaaElementRef,
    reveals: ScanResult['hover'][number]['reveals'],
  ) => {
    for (const reveal of reveals) {
      const key = `${kind}|${trigger.selector}|${reveal.ref.selector}`
      if (cases.has(key)) continue
      cases.set(key, {
        kind,
        trigger,
        root: reveal.ref,
        text: reveal.text,
        obscures: reveal.obscures,
        mutated: reveal.mutated,
        inside: false,
      })
    }
  }
  for (const record of scan.focus) add('focus', record.ref, record.reveals)
  for (const record of scan.hover) add('hover', record.ref, record.reveals)
  return Array.from(cases.values())
}

async function prepare(page: Page) {
  await page.evaluate(installProbe, { transitions: true })
  // Un clic sur un lien ne doit pas changer de page : le défaut est annulé avant les gestionnaires du site.
  await page.evaluate(() => {
    document.addEventListener(
      'click',
      (event) => {
        if ((event.target as Element | null)?.closest('a[href]')) event.preventDefault()
      },
      true,
    )
  })
}

const revealed = (page: Page, selector: string) =>
  page.evaluate((s) => window.__probe?.isRevealed(s) ?? false, selector)

async function rest(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(0, 0)
  await page.waitForTimeout(120)
}

/** Déclenche le survol ou le focus ; `false` si le déclencheur est introuvable. */
async function trigger(page: Page, kind: 'hover' | 'focus', selector: string): Promise<boolean> {
  if (kind === 'focus') {
    const ok = await page.evaluate((s) => window.__probe?.refocus(s) ?? false, selector)
    await page.waitForTimeout(APPEAR_MS)
    return ok
  }
  const target = await page.evaluate((s) => window.__probe?.prepareSelector(s) ?? null, selector)
  if (!target) return false
  await page.mouse.move(target.x, target.y)
  await page.waitForTimeout(APPEAR_MS)
  return true
}

/** Point du contenu le plus proche du déclencheur : le trajet le plus court qu'un pointeur prendrait. */
async function nearest(page: Page, triggerSelector: string, rootSelector: string) {
  return page.evaluate(
    ([t, r]) => {
      const from = document.querySelector(t as string)?.getBoundingClientRect()
      const to = document.querySelector(r as string)?.getBoundingClientRect()
      if (!from || !to) return null
      const cx = from.left + from.width / 2
      const cy = from.top + from.height / 2
      return {
        x: Math.min(Math.max(cx, to.left + 3), to.right - 3),
        y: Math.min(Math.max(cy, to.top + 3), to.bottom - 3),
      }
    },
    [triggerSelector, rootSelector],
  )
}

/** Essais de masquage, de survol du contenu, de persistance et d'équivalence clavier/souris. */
export async function deepReveals(
  ctx: PageContext,
  cases: RevealCase[],
  scan: ScanResult,
): Promise<RevealResult[]> {
  if (cases.length === 0) return []
  const page = await ctx.fresh({ reducedMotion: 'reduce' })
  const results: RevealResult[] = []
  const hoverRoots = new Set(scan.hover.flatMap((h) => h.reveals.map((r) => r.ref.selector)))
  const focusRoots = new Set(scan.focus.flatMap((f) => f.reveals.map((r) => r.ref.selector)))
  try {
    await page.evaluate(revealOnScroll)
    await prepare(page)
    for (const c of cases.slice(0, MAX_CASES)) {
      const result: RevealResult = {
        ...c,
        reproduced: false,
        dismissible: null,
        hoverable: null,
        persistent: null,
        equivalent: null,
      }
      results.push(result)
      await rest(page)
      result.inside = await page.evaluate(
        ([t, r]) =>
          !!document.querySelector(t as string)?.contains(document.querySelector(r as string)),
        [c.trigger.selector, c.root.selector],
      )
      // Causalité : le contenu est masqué au repos, puis apparaît quand on déclenche (sinon c'est une minuterie ou un état persistant).
      if (await revealed(page, c.root.selector)) continue
      if (!(await trigger(page, c.kind, c.trigger.selector))) continue
      result.reproduced = await revealed(page, c.root.selector)
      if (!result.reproduced) continue

      // 10.13.1 : masquable sans bouger le pointeur ni le focus (Échap), si le contenu recouvre autre chose.
      if (c.obscures) {
        await page.keyboard.press('Escape')
        await page.waitForTimeout(200)
        result.dismissible = !(await revealed(page, c.root.selector))
        if (result.dismissible) {
          await rest(page)
          await trigger(page, c.kind, c.trigger.selector)
        }
      }

      // 10.13.2 : le pointeur peut aller du déclencheur au contenu sans que celui-ci disparaisse.
      if (c.kind === 'hover' && !result.inside && (await revealed(page, c.root.selector))) {
        const to = await nearest(page, c.trigger.selector, c.root.selector)
        if (to) {
          await page.mouse.move(to.x, to.y, { steps: 8 })
          await page.waitForTimeout(350)
          result.hoverable = await revealed(page, c.root.selector)
          if (!result.hoverable) {
            await rest(page)
            await trigger(page, c.kind, c.trigger.selector)
          }
        }
      }

      // 10.13.3 : reste affiché tant que le pointeur ou le focus n'a pas quitté, sans minuterie.
      if (await revealed(page, c.root.selector)) {
        await page.waitForTimeout(PERSIST_MS)
        result.persistent = await revealed(page, c.root.selector)
      } else {
        result.persistent = null
      }

      // 10.14 : un contenu qui n'apparaît que par le CSS doit aussi apparaître par un autre moyen.
      if (!c.mutated) {
        const other = c.kind === 'hover' ? focusRoots : hoverRoots
        if (other.has(c.root.selector)) {
          result.equivalent = c.kind === 'hover' ? 'focus' : 'survol'
        } else if (c.kind === 'focus') {
          // L'activation d'un contrôle passe par son focus : elle ne se distingue pas de l'apparition au focus.
          result.equivalent = false
        } else {
          await rest(page)
          const focused = await page.evaluate(
            (s) => window.__probe?.refocus(s) ?? false,
            c.trigger.selector,
          )
          let via: string | false = false
          if (focused) {
            for (const key of ['Enter', 'Space']) {
              await page.keyboard.press(key)
              await page.waitForTimeout(300)
              if (await revealed(page, c.root.selector)) {
                via = `activation au clavier (${key})`
                break
              }
            }
          }
          result.equivalent = via
          if (via) {
            // L'état ouvert persiste : on repart d'une page propre pour les cas suivants.
            await page.reload({ waitUntil: 'load' })
            await page.waitForTimeout(300)
            await prepare(page)
          }
        }
      }
    }
  } finally {
    await page
      .context()
      .close()
      .catch(() => {})
  }
  return results
}
