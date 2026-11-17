import type { Page } from 'playwright'
import type { PageContext } from '../core/types.ts'
import { collectForms } from './formulaires-collect.ts'
import type { FieldInfo, FormInfo, FormsSnapshot } from './formulaires-types.ts'

/**
 * Sondes d'erreur : soumet réellement chaque formulaire de la page, vide puis
 * avec des valeurs de format invalide, sur une page `ctx.fresh()`.
 *
 * Garde-fous : toute requête qui n'est pas un GET est interceptée et avortée
 * (aucun message n'est jamais envoyé), les navigations vers un autre site sont
 * bloquées, et on ne remplit que des champs dont la valeur est certainement
 * invalide : l'envoi ne peut pas être valide.
 */

export interface ProbeState {
  snapshot: FormsSnapshot
  /** Requêtes d'envoi (POST…) tentées par la page depuis le début de la sonde, toutes avortées. */
  requests: number
  /** La page a changé d'adresse ou le formulaire a disparu : il a été accepté. */
  navigated: boolean
}

export interface FormProbe {
  form: FormInfo
  /** Pourquoi la sonde n'a pas pu être menée. */
  skipped?: string
  baseline?: FormsSnapshot
  /** Après envoi du formulaire vide. */
  empty?: ProbeState
  /** Après envoi avec des valeurs invalides (`filled` : champs remplis, indices de la page). */
  invalid?: ProbeState & { filled: number[] }
}

const MAX_FORMS = 4

export function isProbeable(form: FormInfo): boolean {
  return form.tag === 'form' && form.submit !== null && form.fields.length > 0
}

async function snapshot(page: Page): Promise<FormsSnapshot | null> {
  try {
    return await page.evaluate(collectForms, true)
  } catch {
    return null // contexte détruit : la page a navigué
  }
}

/** Valeur certainement invalide pour ce champ, ou `null`. Teste la validité native sur un clone détaché. */
async function invalidValue(page: Page, field: FieldInfo): Promise<string | null> {
  if (field.tag !== 'input' || field.checkable || field.disabled) return null
  if (!field.fieldVisible) return null
  return page
    .evaluate(
      ({ selector }) => {
        const el = document.querySelector(selector)
        if (!(el instanceof HTMLInputElement)) return null
        const candidates = ['pas-un-email', 'pas une url', '§§', '!', 'x', 'abc', '0']
        for (const value of candidates) {
          const clone = el.cloneNode() as HTMLInputElement
          if (clone.type === 'number' || clone.type === 'date' || clone.type === 'range')
            return null
          clone.value = value
          if (
            clone.value === value &&
            (clone.validity.typeMismatch || clone.validity.patternMismatch)
          ) {
            return value
          }
        }
        return null
      },
      { selector: field.ref.selector },
    )
    .catch(() => null)
}

async function submit(page: Page, form: FormInfo): Promise<void> {
  if (form.submit) {
    try {
      await page.locator(form.submit.selector).first().click({ timeout: 4_000 })
      return
    } catch {
      // Bouton recouvert ou instable : envoi programmatique.
    }
  }
  await page
    .evaluate((selector) => {
      const el = document.querySelector(selector)
      if (el instanceof HTMLFormElement) el.requestSubmit()
    }, form.ref.selector)
    .catch(() => {})
}

/**
 * Attend que le DOM se stabilise après un envoi : la validation peut être
 * chargée à la demande (import différé) et le retour apparaître plus tard.
 */
async function settleAfterSubmit(page: Page): Promise<void> {
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          const start = performance.now()
          let last = start
          const observer = new MutationObserver(() => {
            last = performance.now()
          })
          observer.observe(document, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: [
              'aria-invalid',
              'aria-describedby',
              'aria-errormessage',
              'hidden',
              'disabled',
              'role',
            ],
          })
          const tick = () => {
            const now = performance.now()
            if ((now - last > 700 && now - start > 700) || now - start > 8_000) {
              observer.disconnect()
              resolve()
            } else {
              setTimeout(tick, 100)
            }
          }
          tick()
        }),
    )
    .catch(() => {}) // navigation en cours
  await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => {})
}

/** Sonde les formulaires de la page. Les champs de `main` sont ceux de la page partagée. */
export async function probeForms(ctx: PageContext, main: FormsSnapshot): Promise<FormProbe[]> {
  const eligible = main.forms.filter(isProbeable)
  const probes: FormProbe[] = main.forms
    .filter((form) => !isProbeable(form))
    .map((form) => ({
      form,
      skipped:
        form.tag !== 'form'
          ? 'conteneur role=form / role=search sans balise <form> : envoi non simulable'
          : form.submit === null
            ? 'aucun bouton d’envoi visible'
            : 'aucun champ',
    }))
  if (eligible.length === 0) return probes

  const page = await ctx.fresh()
  let requests = 0
  const origin = new URL(ctx.url).origin
  await page.route('**/*', (route) => {
    const request = route.request()
    const method = request.method()
    if (method !== 'GET' && method !== 'HEAD') {
      requests += 1
      return route.abort('blockedbyclient')
    }
    if (request.isNavigationRequest() && new URL(request.url()).origin !== origin) {
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  page.on('dialog', (dialog) => {
    dialog.dismiss().catch(() => {})
  })

  let first = true
  for (const form of eligible.slice(0, MAX_FORMS)) {
    const probe: FormProbe = { form }
    probes.push(probe)
    try {
      if (!first) {
        await page.goto(ctx.url, { waitUntil: 'load', timeout: 30_000 })
        await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {})
        await page.waitForTimeout(200)
      }
      first = false
      const before = await snapshot(page)
      const here = before?.forms.find((f) => f.ref.selector === form.ref.selector)
      if (!before || !here?.submit) {
        probe.skipped = 'formulaire introuvable sur la page de sonde'
        continue
      }
      probe.baseline = before
      const startUrl = page.url()
      const requestsBefore = requests

      // 1. Envoi du formulaire vide. Si la page change, on recommence une fois, plus tard :
      // le script du formulaire n'était peut-être pas encore actif et l'envoi est parti en natif.
      let snap: FormsSnapshot | null = null
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await page.goto(ctx.url, { waitUntil: 'load', timeout: 30_000 })
          await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {})
          await page.waitForTimeout(1_500)
        }
        await submit(page, here)
        await settleAfterSubmit(page)
        snap = await snapshot(page)
        const gone = !snap?.forms.some((f) => f.ref.selector === form.ref.selector)
        probe.empty = {
          snapshot: snap ?? before,
          requests: requests - requestsBefore,
          navigated: gone || page.url() !== startUrl,
        }
        if (!probe.empty.navigated) break
      }
      if (!probe.empty || probe.empty.navigated || !snap) continue

      // 2. Valeurs de format invalide, sans jamais rendre l'envoi valide.
      const filled: number[] = []
      for (const index of here.fields) {
        const field = before.fields[index]
        if (!field) continue
        const value = await invalidValue(page, field)
        if (value === null) continue
        try {
          await page.locator(field.ref.selector).first().fill(value, { timeout: 2_000 })
          filled.push(index)
        } catch {
          // Champ non remplissable : on l'ignore.
        }
      }
      if (filled.length === 0) continue
      const requestsMid = requests
      await submit(page, here)
      await settleAfterSubmit(page)
      snap = await snapshot(page)
      probe.invalid = {
        snapshot: snap ?? probe.empty.snapshot,
        requests: requests - requestsMid,
        navigated: !snap || page.url() !== startUrl,
        filled,
      }
    } catch (error) {
      probe.skipped = `sonde en échec : ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`
    }
  }
  return probes
}
