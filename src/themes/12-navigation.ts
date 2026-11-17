import type { Page } from 'playwright'
import {
  type Check,
  defineCheck,
  defineSiteCheck,
  type ElementRef,
  type PageContext,
} from '../core/types.ts'
import {
  collectFeatures,
  type Feature,
  type MenuFeature,
  type PageFeatures,
  type Place,
  type TabStop,
  type TabWalk,
  walkTabs,
} from '../lib/navigation-inpage.ts'
import { resolvePageUrl } from '../security/url.ts'

/**
 * Thématique 12 — Navigation.
 *
 * Trois familles de vérifications :
 * - **par page** : repères (12.6), lien d'évitement (12.7.1), tabulation réelle au clavier
 *   (12.8, 12.9), contenus qui apparaissent au survol (12.11), raccourcis clavier (12.10),
 *   et le contenu de la page « plan du site » quand elle est auditée (12.3) ;
 * - **inter-pages** : cohérence d'un ensemble de pages (12.1, 12.2, 12.4, 12.5, 12.7.2) :
 *   les pages sont comparées entre elles. Ces tests ne s'appliquent qu'à partir de deux pages
 *   auditées, et la page d'accueil (`/`) est exemptée de 12.2.1.
 */

const FEATURES = 'navigation.features'
const SKIP = 'navigation.skip'

async function features(ctx: PageContext): Promise<PageFeatures> {
  return ctx.memo('navigation.features', async () => {
    const found = await collectFeatures(ctx.page)
    ctx.record(FEATURES, found)
    return found
  })
}

/** Parcours à la tabulation, sur une page neuve, partagé par les vérifications du clavier. */
async function tabWalk(ctx: PageContext): Promise<TabWalk> {
  return ctx.memo('navigation.walk', async () =>
    walkTabs(await ctx.fresh({ reducedMotion: 'reduce' })),
  )
}

/**
 * Relevé des fonctionnalités de la page (menu, recherche, plan du site) pour les tests
 * inter-pages : exécuté dès que l'un d'eux est demandé, même sans les tests 12.6.
 */
const recorder = defineCheck(
  ['12.1.1', '12.2.1', '12.4.1', '12.4.2', '12.4.3', '12.5.1', '12.5.2', '12.5.3'],
  async (ctx) => {
    await features(ctx)
  },
)

// ─── 12.6 : repères des zones ───────────────────────────────────────────────

const LANDMARK_ROLE: Record<string, string[]> = {
  'en-tête': ['banner'],
  navigation: ['navigation'],
  'contenu principal': ['main'],
  'pied de page': ['contentinfo'],
  'moteur de recherche': ['search'],
}

const zones = defineCheck(['12.6.1'], async (ctx, t) => {
  const found = await features(ctx)
  const o = t('12.6.1')
  for (const zone of found.zones) {
    o.applicable()
    if (zone.role && LANDMARK_ROLE[zone.kind]?.includes(zone.role)) continue
    if (zone.role) continue // repère d'un autre type : il est nommé par son rôle.
    if (!zone.labelled) {
      o.fail(
        `Zone « ${zone.kind} » sans rôle de repère (landmark) ni titre qui l’identifie : utiliser la balise ou le rôle correspondant.`,
        zone.ref,
      )
    }
  }
  for (const ref of found.unlabelledSearch) {
    o.applicable()
    o.fail('Zone de recherche sans rôle search ni titre qui l’identifie.', ref)
  }
})

// ─── 12.7.1 : lien d'évitement ──────────────────────────────────────────────

const SKIP_LABEL = /(aller|acc[eé]der|passer|contenu|content|skip|direct|principal|menu)/i

const skipLink = defineCheck(['12.7.1', '12.7.2'], async (ctx, t) => {
  const o = t('12.7.1')
  const walk = await tabWalk(ctx)
  const stops = walk.stops
  if (stops.length === 0) return // aucune commande au clavier : rien à éviter.

  const firstInMain = stops.findIndex((stop) => stop.inMain)
  const near = stops.slice(0, 8)
  const candidate = near.find(
    (stop, index) =>
      stop.tag === 'a' &&
      stop.href.startsWith('#') &&
      stop.href.length > 1 &&
      (index < 3 || SKIP_LABEL.test(stop.name)),
  )

  if (!candidate) {
    // Le contenu principal est atteint en moins de quatre tabulations : aucun contournement utile.
    if (firstInMain !== -1 && firstInMain <= 2) {
      o.applicable()
      o.note(
        `Le contenu principal reçoit le focus à la tabulation n°${firstInMain + 1} : un lien d’évitement n’apporterait rien.`,
      )
      ctx.record(SKIP, null)
      return
    }
    o.applicable()
    o.fail(
      `Aucun lien d’évitement ou d’accès rapide au contenu principal parmi les ${Math.min(8, stops.length)} premiers éléments atteints à la tabulation${firstInMain === -1 ? '' : ` (le contenu principal n’est atteint qu’à la tabulation n°${firstInMain + 1})`}.`,
      stops[0]?.ref,
    )
    ctx.record(SKIP, null)
    return
  }

  o.applicable()
  ctx.record(SKIP, {
    x: candidate.x,
    y: candidate.y,
    domIndex: candidate.domIndex,
    container: candidate.container,
    visibleBefore: candidate.visibleBefore,
    visibleFocused: candidate.visibleFocused,
    ref: candidate.ref,
  })
  // La cible existe-t-elle, et est-ce bien le contenu principal ?
  const target = await ctx.page.evaluate((hash) => {
    const { ref } = window.__rgaa
    let id = hash.slice(1)
    try {
      id = decodeURIComponent(id)
    } catch {
      // identifiant laissé tel quel
    }
    const el = document.getElementById(id) ?? document.querySelector(`a[name="${CSS.escape(id)}"]`)
    if (!el) return { exists: false as const }
    const main = document.querySelector('main, [role="main"]')
    return {
      exists: true as const,
      inMain: !main || main === el || main.contains(el) || el.contains(main),
      ref: ref(el),
    }
  }, candidate.href)
  if (!target.exists) {
    o.fail(
      `Le lien d’évitement « ${candidate.name} » pointe vers ${candidate.href}, qui n’existe pas dans la page.`,
      candidate.ref,
    )
  } else if (!target.inMain) {
    await o.judgePass({
      topic: 'skiplink.target',
      question: `Le lien « ${candidate.name} » mène à ${candidate.href}, hors de la balise <main>. Cette cible est-elle bien le début du contenu principal ?`,
      evidence: { lien: candidate.name, cible: candidate.href },
      ref: target.ref,
    })
  }
})

// ─── 12.8 / 12.9 : ordre de tabulation et pièges clavier ────────────────────

/** Remontée verticale (en pixels) entre deux éléments consécutifs de la tabulation qui paraît incohérente. */
const BACKWARD_JUMP = 300

const keyboard = defineCheck(['12.8.1', '12.9.1'], async (ctx, t) => {
  const walk = await tabWalk(ctx)
  if (walk.stops.length < 2 && !walk.stuck) return

  // 12.8.1 — l'ordre de tabulation suit l'ordre de lecture.
  const order = t('12.8.1')
  order.applicable()
  for (const ref of walk.positive.slice(0, 5)) {
    await order.judgePass({
      topic: 'tab.order',
      question:
        'Cet élément a un tabindex positif, qui modifie l’ordre de tabulation. L’ordre obtenu reste-t-il cohérent avec l’ordre de lecture ?',
      evidence: { page: ctx.path, element: ref.selector },
      ref,
    })
  }
  let jumps = 0
  for (let i = 1; i < walk.stops.length && jumps < 5; i++) {
    const previous = walk.stops[i - 1] as TabStop
    const stop = walk.stops[i] as TabStop
    // Le contenu qui apparaît (menu déroulant, bandeau) peut légitimement remonter ; on ne juge que le contenu principal.
    if (!(previous.inMain && stop.inMain)) continue
    if (previous.y - stop.y > BACKWARD_JUMP) {
      jumps += 1
      await order.judgePass({
        topic: 'tab.order',
        question: `Le focus remonte de ${previous.y - stop.y} px entre « ${previous.name} » et « ${stop.name} » à la tabulation. Cet ordre est-il cohérent avec l’ordre de lecture ?`,
        evidence: { page: ctx.path, de: previous.name, vers: stop.name },
        ref: stop.ref,
      })
    }
  }

  // 12.9.1 — pas de piège au clavier.
  const trap = t('12.9.1')
  trap.applicable()
  if (walk.stuck) {
    trap.fail(
      `Piège au clavier : le focus reste sur « ${walk.stuck.name || walk.stuck.tag} » malgré la touche Tab alors que la page compte ${walk.expected} éléments tabulables.`,
      walk.stuck.ref,
    )
  } else if (walk.cycledEarly) {
    const last = walk.stops[walk.stops.length - 1]
    await trap.judgePass({
      topic: 'tab.cycle',
      question: `Le focus tourne en boucle après ${walk.stops.length} éléments sur ${walk.expected} tabulables. Peut-on atteindre le reste de la page au clavier (avec la touche Échap, par exemple) ?`,
      evidence: {
        page: ctx.path,
        parcourus: String(walk.stops.length),
        tabulables: String(walk.expected),
      },
      ref: last?.ref,
    })
  }
})

// ─── 12.8.2 / 12.11.1 : contenus qui apparaissent après une action ──────────

interface Reveal {
  trigger: ElementRef
  name: string
  revealed: string[]
  /** Atteint par le focus, ou par le clavier (Entrée) : `focus`, `tab`, `enter`, ou `none`. */
  reachable: 'focus' | 'tab' | 'enter' | 'none'
}

interface Expansion {
  trigger: ElementRef
  name: string
  /** Les nouveaux éléments tabulables suivent immédiatement le déclencheur, ou le focus y est déplacé. */
  coherent: boolean
  added: string[]
}

const MAX_TRIGGERS = 8

async function visibleTabbables(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const { tabbables, isVisible, ref } = window.__rgaa
    return tabbables()
      .filter((el) => isVisible(el))
      .map((el) => ref(el).selector)
  })
}

async function describeElement(
  page: Page,
  selector: string,
): Promise<{ ref: ElementRef; name: string; navigates: boolean } | null> {
  return page
    .evaluate((s) => {
      const { ref, accName, norm } = window.__rgaa
      const el = document.querySelector(s)
      if (!el) return null
      const href = el.getAttribute('href') ?? ''
      return {
        ref: ref(el),
        name: norm(accName(el) || el.textContent).slice(0, 60),
        // Un vrai lien : Entrée change de page, ce n'est pas une façon d'ouvrir un contenu.
        navigates:
          el.localName === 'a' &&
          href !== '' &&
          !href.startsWith('#') &&
          !/^javascript:/i.test(href),
      }
    }, selector)
    .catch(() => null)
}

async function probeReveals(
  ctx: PageContext,
): Promise<{ reveals: Reveal[]; expansions: Expansion[] }> {
  const page = await ctx.fresh({ reducedMotion: 'reduce' })
  const reveals: Reveal[] = []
  const expansions: Expansion[] = []
  const origin = page.url()

  // Déclencheurs au survol : sous-menus, menus déroulants.
  const hoverTriggers: string[] = await page.evaluate((max) => {
    const { tabbables, isVisible, ref } = window.__rgaa
    const out: string[] = []
    for (const el of document.querySelectorAll(
      'li:has(> ul), li:has(> div), [aria-haspopup]:not([aria-haspopup="false"])',
    )) {
      const trigger = el.matches('a, button, [tabindex]')
        ? el
        : el.querySelector(':scope > a, :scope > button')
      if (!trigger || !isVisible(trigger) || !tabbables().includes(trigger as HTMLElement)) continue
      const selector = ref(trigger).selector
      if (!out.includes(selector)) out.push(selector)
      if (out.length >= max) break
    }
    return out
  }, MAX_TRIGGERS)

  for (const selector of hoverTriggers) {
    try {
      const before = new Set(await visibleTabbables(page))
      await page.hover(selector, { timeout: 2_000 })
      await page.waitForTimeout(300)
      const revealed = (await visibleTabbables(page)).filter((s) => !before.has(s))
      if (revealed.length === 0) continue
      await page.mouse.move(0, 0)
      await page.waitForTimeout(300)
      const stillThere = new Set(await visibleTabbables(page))
      const hoverOnly = revealed.filter((s) => !stillThere.has(s))
      if (hoverOnly.length === 0) continue // reste affiché sans survol : pas un contenu au survol

      const info = await describeElement(page, selector)
      if (!info) continue
      const shown = async () => {
        const now = new Set(await visibleTabbables(page))
        return hoverOnly.some((s) => now.has(s))
      }
      let reachable: Reveal['reachable'] = 'none'
      await page.focus(selector, { timeout: 2_000 })
      await page.waitForTimeout(300)
      if (await shown()) reachable = 'focus'
      if (reachable === 'none') {
        await page.keyboard.press('Tab')
        const active = await page.evaluate(
          () => window.__rgaa.ref(document.activeElement as Element).selector,
        )
        if (hoverOnly.includes(active)) reachable = 'tab'
      }
      if (reachable === 'none' && !info.navigates) {
        await page.focus(selector, { timeout: 2_000 })
        await page.keyboard.press('Enter')
        await page.waitForTimeout(300)
        if (page.url() !== origin) {
          await page.goBack().catch(() => {})
        } else if (await shown()) {
          reachable = 'enter'
        }
      }
      reveals.push({ trigger: info.ref, name: info.name, revealed: hoverOnly, reachable })
      await page.keyboard.press('Escape')
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(0, 0)
    } catch {
      // Déclencheur disparu ou inatteignable : on passe au suivant.
    }
  }

  // Déclencheurs qui développent un contenu : le contenu ajouté suit-il le déclencheur dans la tabulation ?
  const expanders: string[] = await page.evaluate((max) => {
    const { isVisible, ref } = window.__rgaa
    const out: string[] = []
    for (const el of document.querySelectorAll(
      '[aria-expanded="false"]:is(button, [role="button"], a[href])',
    )) {
      if (isVisible(el)) out.push(ref(el).selector)
      if (out.length >= max) break
    }
    return out
  }, MAX_TRIGGERS)
  for (const selector of expanders) {
    try {
      const before = await visibleTabbables(page)
      await page.click(selector, { timeout: 2_000 })
      await page.waitForTimeout(350)
      if (page.url() !== origin) {
        await page.goto(origin)
        continue
      }
      const after = await visibleTabbables(page)
      const added = after.filter((s) => !before.includes(s))
      if (added.length === 0) continue
      const index = after.indexOf(selector)
      const first = Math.min(...added.map((s) => after.indexOf(s)))
      const focusedInside = await page.evaluate(
        (selectors) =>
          selectors.includes(window.__rgaa.ref(document.activeElement as Element).selector),
        added,
      )
      const info = await describeElement(page, selector)
      if (!info) continue
      expansions.push({
        trigger: info.ref,
        name: info.name,
        coherent: index !== -1 && (first === index + 1 || focusedInside),
        added,
      })
    } catch {
      // Contrôle sans effet mesurable : ignoré.
    }
  }
  return { reveals, expansions }
}

const reveals = defineCheck(['12.8.2', '12.11.1'], async (ctx, t) => {
  const { reveals, expansions } = await ctx.memo('navigation.reveals', () => probeReveals(ctx))

  for (const reveal of reveals) {
    const o = t('12.11.1')
    o.applicable()
    if (reveal.reachable !== 'none') continue
    await o.judgePass({
      topic: 'hover.keyboard',
      question: `Le contenu qui apparaît au survol de « ${reveal.name} » (${reveal.revealed.length} élément(s) interactif(s)) n’est pas révélé par le focus ni par Entrée. Est-il atteignable au clavier autrement ?`,
      evidence: { declencheur: reveal.name, elements: String(reveal.revealed.length) },
      ref: reveal.trigger,
    })
  }
  if (reveals.length > 0) {
    t('12.11.1').note(
      'Seuls les contenus interactifs révélés par le survol de menus et de contrôles à fenêtre contextuelle sont essayés (info-bulles `title` et contenus déclenchés par script exclus).',
    )
  }

  for (const expansion of expansions) {
    const o = t('12.8.2')
    o.applicable()
    if (expansion.coherent) continue
    await o.judgePass({
      topic: 'tab.dynamic',
      question: `Après activation de « ${expansion.name} », ${expansion.added.length} nouvel(s) élément(s) tabulable(s) apparaissent sans suivre le déclencheur dans l’ordre de tabulation et sans que le focus y soit déplacé. L’ordre de tabulation reste-t-il cohérent ?`,
      evidence: { declencheur: expansion.name, ajoutes: String(expansion.added.length) },
      ref: expansion.trigger,
    })
  }
})

// ─── 12.10 : raccourcis clavier ─────────────────────────────────────────────

const shortcuts = defineCheck(['12.10.1'], async (ctx, t) => {
  const found = await features(ctx)
  if (found.keyListeners.length === 0) return
  const o = t('12.10.1')
  const first = found.keyListeners[0]
  await o.judgePass({
    topic: 'shortcut.script',
    question: `La page déclare des écouteurs d’événements clavier (${found.keyListeners.length}). Certains définissent-ils un raccourci à une seule touche, sans moyen de le désactiver ou de le reconfigurer ?`,
    evidence: { page: ctx.path, exemple: first?.excerpt ?? '' },
  })
  o.note(
    'Seuls les écouteurs déclarés dans le code de la page sont repérés, pas ceux des scripts externes.',
  )
})

// ─── 12.3 : la page « plan du site » ────────────────────────────────────────

const SITEMAP_PAGE = /plan[-_ ]?(du|de)[-_ ]?site|sitemap(?!\.xml)|plan[-_]?site/i
const MAX_SITEMAP_LINKS = 80

/** Mots significatifs d'un intitulé, pour le rapprocher du titre de la page visée. */
function words(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4)
}

function textOf(html: string, tag: string): string {
  const found = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html)
  return (found?.[1] ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const sitemapPage = defineCheck(['12.3.1', '12.3.2', '12.3.3'], async (ctx, t) => {
  const identity = await ctx.page.evaluate(() => {
    const h1 = document.querySelector('h1')
    return { title: document.title, h1: h1?.textContent ?? '' }
  })
  if (!SITEMAP_PAGE.test(`${ctx.path} ${identity.title} ${identity.h1}`)) return

  const links = await ctx.page.evaluate((limit) => {
    const { isHiddenFromAT, accName, norm } = window.__rgaa
    const seen = new Set<string>()
    const found: { label: string; href: string }[] = []
    const scope = document.querySelector('main, [role="main"]') ?? document.body
    for (const link of scope.querySelectorAll('a[href]')) {
      if (isHiddenFromAT(link)) continue
      const url = new URL((link as HTMLAnchorElement).href, location.href)
      url.hash = ''
      if (
        url.origin !== location.origin ||
        !/^https?:$/.test(url.protocol) ||
        url.href === location.href
      )
        continue
      if (seen.has(url.href)) continue
      seen.add(url.href)
      found.push({ label: norm(accName(link)), href: url.href })
      if (found.length >= limit) break
    }
    return found
  }, MAX_SITEMAP_LINKS)

  const base = new URL(ctx.url)
  await t('12.3.1').judgePass({
    topic: 'sitemap.representative',
    question:
      'Cette page « plan du site » reflète-t-elle l’architecture générale du site (toutes les rubriques principales y figurent) ?',
    evidence: {
      page: ctx.path,
      liens: String(links.length),
      extrait: links
        .slice(0, 12)
        .map((l) => l.label)
        .join(' | '),
    },
  })

  // 12.3.2 — chaque lien répond ; on en profite pour lire titre et h1 de la page visée (12.3.3).
  const pages: { label: string; href: string; status: number; heading: string }[] = []
  let cursor = 0
  const worker = async () => {
    while (cursor < links.length) {
      const link = links[cursor++]
      if (!link) continue
      let status = 0
      let heading = ''
      try {
        const url = resolvePageUrl(base, link.href) // même site uniquement
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          redirect: 'follow',
          headers: { accept: 'text/html' },
        })
        status = response.status
        if (response.ok && /html/i.test(response.headers.get('content-type') ?? '')) {
          const html = (await response.text()).slice(0, 200_000)
          heading = `${textOf(html, 'title')} ${textOf(html, 'h1')}`.trim()
        }
      } catch {
        status = 0 // aucune réponse (délai dépassé, connexion refusée)
      }
      pages.push({ ...link, status, heading })
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))

  if (links.length > 0) t('12.3.2').applicable(links.length)
  for (const page of pages) {
    if (page.status === 0 || page.status >= 400) {
      t('12.3.2').fail(
        `Le lien « ${page.label} » du plan du site ne répond pas (${page.status === 0 ? 'aucune réponse' : `HTTP ${page.status}`}) : ${new URL(page.href).pathname}.`,
      )
    }
  }
  let asked = 0
  for (const page of pages) {
    if (page.status >= 400 || page.status === 0 || page.heading === '' || asked >= 10) continue
    const target = new Set(words(`${page.heading} ${new URL(page.href).pathname}`))
    if (words(page.label).some((word) => target.has(word))) {
      t('12.3.3').applicable()
      continue
    }
    asked += 1
    await t('12.3.3').judgePass({
      topic: 'sitemap.target',
      question: `Le lien « ${page.label} » mène à une page intitulée « ${page.heading.slice(0, 100)} ». L’intitulé annonce-t-il bien cette page ?`,
      evidence: {
        intitule: page.label,
        destination: new URL(page.href).pathname,
        titre: page.heading.slice(0, 120),
      },
    })
  }
  if (pages.length >= MAX_SITEMAP_LINKS) {
    t('12.3.2').note(`Seuls les ${MAX_SITEMAP_LINKS} premiers liens du plan du site sont testés.`)
  }
})

// ─── Vérifications inter-pages ──────────────────────────────────────────────

interface PageValue<T> {
  url: string
  path: string
  value: T
}

/** Tolérances de comparaison des emplacements (pixels, à 1280 px de large). */
const SHIFT = 40
const SIZE = 80

function samePlace(a: Place, b: Place): boolean {
  return (
    a.container === b.container &&
    Math.abs(a.x - b.x) <= SHIFT &&
    Math.abs(a.y - b.y) <= SHIFT &&
    Math.abs(a.w - b.w) <= SIZE &&
    Math.abs(a.h - b.h) <= SHIFT
  )
}

/** Valeur de référence : celle que partage le plus grand nombre de pages (la première en cas d'égalité). */
function reference<T>(
  values: PageValue<T>[],
  same: (a: T, b: T) => boolean,
): PageValue<T> | undefined {
  let best: PageValue<T> | undefined
  let bestCount = 0
  for (const candidate of values) {
    const count = values.filter((other) => same(candidate.value, other.value)).length
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

function describePlace(place: Place): string {
  return `${place.container}, à ${place.x} px du bord gauche et ${place.y} px du haut, ${place.w}×${place.h} px`
}

/** Ordre relatif des intitulés communs à deux menus. */
function sameOrder(a: string[], b: string[]): boolean {
  const common = a.filter((item) => b.includes(item))
  if (common.length < 2) return true
  const other = b.filter((item) => a.includes(item))
  return common.join(' | ') === other.join(' | ')
}

const systems = defineSiteCheck(['12.1.1'], async (site, t) => {
  if (site.pages.length < 2) return
  const records = site.records(FEATURES) as PageValue<PageFeatures>[]
  const has = {
    'un menu de navigation': records.some((r) => r.value.menu),
    'un plan du site': records.some((r) => r.value.sitemap),
    'un moteur de recherche': records.some((r) => r.value.search),
  }
  const present = Object.entries(has)
    .filter(([, ok]) => ok)
    .map(([name]) => name)
  for (const page of site.pages) t(page.url, '12.1.1').applicable()
  if (present.length < 2) {
    const first = site.pages[0]
    if (!first) return
    t(first.url, '12.1.1').fail(
      `L’ensemble de pages ne propose pas deux systèmes de navigation différents parmi menu, plan du site et moteur de recherche (trouvé : ${present.join(', ') || 'aucun'}).`,
    )
  }
})

const menuConsistency = defineSiteCheck(['12.2.1'], async (site, t) => {
  if (site.pages.length < 2) return
  const records = (site.records(FEATURES) as PageValue<PageFeatures>[]).filter(
    (record): record is PageValue<PageFeatures & { menu: MenuFeature }> =>
      record.value.menu !== null,
  )
  if (records.length < 2) return
  const menus = records.map((r) => ({ ...r, value: r.value.menu as MenuFeature }))
  const ref = reference(
    menus,
    (a, b) => samePlace(a.place, b.place) && a.beforeMain === b.beforeMain,
  )
  if (!ref) return
  for (const entry of menus) {
    if (entry.path === '/') continue // cas particulier : la page d'accueil est exemptée.
    const o = t(entry.url, '12.2.1')
    o.applicable()
    if (entry === ref) continue
    if (!samePlace(entry.value.place, ref.value.place)) {
      o.fail(
        `Le menu n’est pas à la même place que sur ${ref.path} : ici ${describePlace(entry.value.place)}, là-bas ${describePlace(ref.value.place)}.`,
        entry.value.ref,
      )
    }
    if (entry.value.beforeMain !== ref.value.beforeMain) {
      o.fail(
        `Le menu ne se présente pas dans le même ordre relatif dans le code source que sur ${ref.path} (${entry.value.beforeMain ? 'avant' : 'après'} le contenu principal, là-bas l’inverse).`,
        entry.value.ref,
      )
    }
    if (!sameOrder(entry.value.items, ref.value.items)) {
      o.fail(`Les entrées du menu n’ont pas le même ordre que sur ${ref.path}.`, entry.value.ref)
    }
  }
})

/** Cohérence d'une fonctionnalité commune (plan du site, moteur de recherche) : présence, place, ordre. */
function featureConsistency(
  pick: (features: PageFeatures) => Feature | null,
  label: string,
  tests: [string, string, string],
) {
  return defineSiteCheck(tests, async (site, t) => {
    if (site.pages.length < 2) return
    const records = site.records(FEATURES) as PageValue<PageFeatures>[]
    const present = records.flatMap((record) => {
      const feature = pick(record.value)
      return feature ? [{ url: record.url, path: record.path, value: feature }] : []
    })
    if (present.length === 0) return // la fonctionnalité n'existe pas dans l'ensemble : tests non applicables.
    const ref = reference(
      present,
      (a, b) => samePlace(a.place, b.place) && a.beforeMain === b.beforeMain,
    )
    const withFeature = new Set(present.map((entry) => entry.url))

    for (const page of site.pages) {
      t(page.url, tests[0]).applicable()
      if (!withFeature.has(page.url)) {
        t(page.url, tests[0]).fail(
          `${label} n’est pas accessible depuis cette page alors qu’il l’est depuis ${present.length} autre(s) page(s).`,
        )
      }
    }
    if (!ref) return
    for (const entry of present) {
      t(entry.url, tests[1]).applicable()
      t(entry.url, tests[2]).applicable()
      if (entry === ref) continue
      if (!samePlace(entry.value.place, ref.value.place)) {
        t(entry.url, tests[1]).fail(
          `${label} n’est pas à la même place que sur ${ref.path} : ici ${describePlace(entry.value.place)}, là-bas ${describePlace(ref.value.place)}.`,
          entry.value.ref,
        )
      }
      if (
        entry.value.beforeMain !== ref.value.beforeMain ||
        entry.value.before !== ref.value.before
      ) {
        t(entry.url, tests[2]).fail(
          `${label} ne se présente pas dans le même ordre relatif dans le code source que sur ${ref.path}.`,
          entry.value.ref,
        )
      }
    }
  })
}

const sitemapLink = featureConsistency(
  (features) => features.sitemap,
  'Le lien vers le plan du site',
  ['12.4.1', '12.4.2', '12.4.3'],
)
const searchEngine = featureConsistency((features) => features.search, 'Le moteur de recherche', [
  '12.5.1',
  '12.5.2',
  '12.5.3',
])

interface SkipValue {
  x: number
  y: number
  domIndex: number
  container: string
  visibleBefore: boolean
  visibleFocused: boolean
  ref: ElementRef
}

const skipConsistency = defineSiteCheck(['12.7.2'], async (site, t) => {
  if (site.pages.length < 2) return
  const records = (site.records(SKIP) as PageValue<SkipValue | null>[]).filter(
    (record): record is PageValue<SkipValue> => record.value !== null,
  )
  if (records.length === 0) return
  const ref = reference(
    records,
    (a, b) =>
      Math.abs(a.x - b.x) <= SHIFT && Math.abs(a.y - b.y) <= SHIFT && a.domIndex === b.domIndex,
  )
  for (const entry of records) {
    const o = t(entry.url, '12.7.2')
    o.applicable()
    if (!entry.value.visibleBefore && !entry.value.visibleFocused) {
      o.fail(
        'Le lien d’évitement n’est visible ni en permanence ni à la prise de focus.',
        entry.value.ref,
      )
    }
    if (!ref || entry === ref) continue
    if (
      Math.abs(entry.value.x - ref.value.x) > SHIFT ||
      Math.abs(entry.value.y - ref.value.y) > SHIFT
    ) {
      o.fail(`Le lien d’évitement n’est pas à la même place que sur ${ref.path}.`, entry.value.ref)
    }
    if (entry.value.domIndex !== ref.value.domIndex) {
      o.fail(
        `Le lien d’évitement n’occupe pas le même rang dans le code source que sur ${ref.path} (n°${entry.value.domIndex + 1} au lieu de n°${ref.value.domIndex + 1}).`,
        entry.value.ref,
      )
    }
  }
})

export const checks: Check[] = [
  recorder,
  zones,
  skipLink,
  keyboard,
  reveals,
  shortcuts,
  sitemapPage,
  systems,
  menuConsistency,
  sitemapLink,
  searchEngine,
  skipConsistency,
]
