import type { Page } from 'playwright'
import {
  type Check,
  defineCheck,
  type ElementRef,
  type OutcomeFor,
  type PageContext,
} from '../core/types.ts'
import { gifInfo, pdfTagging } from '../lib/consultation.ts'

/**
 * Thématique 13 — Consultation.
 *
 * Mesuré : rafraîchissements et redirections `<meta>` (13.1), fenêtres ouvertes sans action
 * (13.2), animations CSS qui clignotent ou bougent plus de 5 s (13.7, 13.8), GIF animés,
 * carrousels qui défilent seuls, orientation de l'écran (13.9).
 * Jugé : documents bureautiques (13.3, 13.4), contenus cryptiques (13.5, 13.6), gestes,
 * pointeur et mouvement de l'appareil (13.10 à 13.12), repérés dans le code de la page.
 *
 * Limite assumée : les scripts externes (bundles) ne sont pas lus. Un geste ou un
 * écouteur défini dans un bundle échappe donc aux détections de code (13.1.3, 13.10 à 13.12).
 */

const MAX_QUESTIONS = 10
/** Surface cumulée (en pixels) au-delà de laquelle un clignotement rapide est un risque (RGAA 13.7). */
const FLASH_AREA = 21_824
/** Une fréquence de 3 par seconde correspond à une période de 333 ms. */
const FLASH_PERIOD_MS = 333

// ─── Relevé du code et des animations ───────────────────────────────────────

interface Survey {
  metas: { content: string; ref: ElementRef }[]
  scripts: string
  attributes: { name: string; ref: ElementRef }[]
  libraries: string[]
  documents: { href: string; label: string; alternative: boolean; ref: ElementRef }[]
  cryptic: { text: string; title: string; ref: ElementRef }[]
  obsolete: { tag: string; ref: ElementRef }[]
  animations: AnimationInfo[]
  gifs: { src: string; ref: ElementRef }[]
  videos: { ref: ElementRef; controls: boolean; loop: boolean; muted: boolean }[]
  carousels: { ref: ElementRef }[]
  pauseControl: string
}

interface AnimationInfo {
  name: string
  kind: 'css' | 'script'
  element: string
  ref: ElementRef
  properties: string[]
  periodMs: number
  infinite: boolean
  totalMs: number
  area: number
  /** Écart de luminance ou d'opacité entre le début et la fin du cycle (0 à 1). */
  amplitude: number
}

const MOTION_PROPERTIES = [
  'transform',
  'translate',
  'rotate',
  'scale',
  'left',
  'right',
  'top',
  'bottom',
  'marginLeft',
  'marginTop',
  'marginRight',
  'marginBottom',
  'backgroundPosition',
  'offsetDistance',
  'strokeDashoffset',
]
const BLINK_PROPERTIES = [
  'opacity',
  'visibility',
  'color',
  'backgroundColor',
  'filter',
  'borderColor',
  'outlineColor',
]

function survey(page: Page): Promise<Survey> {
  return page.evaluate(
    ([motion, blink]) => {
      const { ref, norm, isRendered, isVisible, isHiddenFromAT, accName, rgba, luminance } =
        window.__rgaa

      const metas = Array.from(document.querySelectorAll('meta[http-equiv]'))
        .filter((el) => (el.getAttribute('http-equiv') ?? '').toLowerCase() === 'refresh')
        .map((el) => ({ content: el.getAttribute('content') ?? '', ref: ref(el) }))

      let scripts = ''
      for (const script of document.querySelectorAll('script:not([src])')) {
        if (scripts.length < 200_000) scripts += `${script.textContent ?? ''}\n`
      }
      const attributes: { name: string; ref: { selector: string; snippet: string } }[] = []
      for (const el of document.querySelectorAll('*')) {
        for (const name of el.getAttributeNames()) {
          if (
            /^on(mousedown|pointerdown|touchstart|touchmove|touchend|devicemotion|deviceorientation|gesturestart)$/.test(
              name,
            )
          ) {
            attributes.push({ name, ref: ref(el) })
          }
        }
        if (attributes.length > 50) break
      }
      const libraries = Array.from(document.querySelectorAll('script[src]'))
        .map((el) => el.getAttribute('src') ?? '')
        .map(
          (src) =>
            /(swiper|hammer|leaflet|openlayers|ol\.js|mapbox|maplibre|maps\.googleapis|slick|flickity|glide|embla|pinch|panzoom|touch)/i
              .exec(src)?.[1]
              ?.toLowerCase() ?? '',
        )
        .filter(Boolean)

      // Documents bureautiques à télécharger.
      const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|epub)(\?|#|$)/i
      const documents: {
        href: string
        label: string
        alternative: boolean
        ref: { selector: string; snippet: string }
      }[] = []
      const seenDocuments = new Set<string>()
      for (const link of document.querySelectorAll('a[href]')) {
        const href = (link as HTMLAnchorElement).href
        if (!DOCUMENT.test(href) || !isRendered(link) || seenDocuments.has(href)) continue
        seenDocuments.add(href)
        const holder = link.closest('li, p, td, article, div') ?? link
        documents.push({
          href,
          label: norm(accName(link)).slice(0, 100),
          alternative: Array.from(holder.querySelectorAll('a[href]')).some(
            (other) =>
              other !== link &&
              /version\s+(accessible|html|texte|web)|accessible/i.test(norm(other.textContent)),
          ),
          ref: ref(link),
        })
      }

      // Contenus cryptiques : émoticônes et dessins en caractères.
      const EMOTICON =
        /(?:^|\s)(?:[:;=8xX][-o^']?[)(DPp|\\/[\]]|<3|[>:;=]-?[|3]|\\o\/|¯\\_\(ツ\)_\/¯)(?=\s|$|[.,!?])/
      const cryptic: { text: string; title: string; ref: { selector: string; snippet: string } }[] =
        []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node && cryptic.length < 20; node = walker.nextNode()) {
        const parent = node.parentElement
        const value = node.nodeValue ?? ''
        if (
          !parent ||
          parent.closest('script, style, noscript, code, textarea, [aria-hidden="true"]') ||
          !isRendered(parent)
        )
          continue
        const found = EMOTICON.exec(value)
        const art =
          parent.closest('pre') && /[\\/|_()<>^~=*#-]{8,}/.test(value)
            ? /[\\/|_()<>^~=*#-]{8,}/.exec(value)
            : null
        const hit = found?.[0].trim() ?? art?.[0]
        if (!hit) continue
        const titled = parent.closest('[title], abbr')
        cryptic.push({
          text: hit.slice(0, 40),
          title: norm(titled?.getAttribute('title')),
          ref: ref(parent),
        })
      }

      const obsolete = Array.from(document.querySelectorAll('marquee, blink')).map((el) => ({
        tag: el.localName,
        ref: ref(el),
      }))

      // Animations en cours.
      const animations: {
        name: string
        kind: 'css' | 'script'
        element: string
        ref: { selector: string; snippet: string }
        properties: string[]
        periodMs: number
        infinite: boolean
        totalMs: number
        area: number
        amplitude: number
      }[] = []
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      for (const animation of document.getAnimations()) {
        const effect = animation.effect as KeyframeEffect | null
        const target = effect?.target
        if (!effect || !(target instanceof Element) || animation.playState !== 'running') continue
        if (typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition) continue
        const timing = effect.getComputedTiming()
        const duration = Number(timing.duration)
        if (!Number.isFinite(duration) || duration <= 0) continue
        const keyframes = effect.getKeyframes()
        const properties = new Set<string>()
        for (const frame of keyframes) {
          for (const key of Object.keys(frame)) {
            if (!['offset', 'easing', 'composite', 'computedOffset'].includes(key))
              properties.add(key)
          }
        }
        const moves = [...properties].filter((property) => motion.includes(property))
        const blinks = [...properties].filter((property) => blink.includes(property))
        if (moves.length === 0 && blinks.length === 0) continue
        const rect = target.getBoundingClientRect()
        const onScreen =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < viewport.height &&
          rect.left < viewport.width
        if (!onScreen || !isVisible(target)) continue

        // Amplitude : opacité ou luminance entre la première et la dernière image-clé.
        let amplitude = 0
        const first = keyframes[0] as Record<string, unknown> | undefined
        const last = keyframes[keyframes.length - 1] as Record<string, unknown> | undefined
        if (first && last) {
          if (typeof first.opacity !== 'undefined' || typeof last.opacity !== 'undefined') {
            amplitude = Math.max(
              amplitude,
              Math.abs(Number(first.opacity ?? 1) - Number(last.opacity ?? 1)),
            )
          }
          for (const key of ['backgroundColor', 'color']) {
            if (typeof first[key] === 'string' && typeof last[key] === 'string') {
              const a = rgba(String(first[key]))
              const b = rgba(String(last[key]))
              amplitude = Math.max(
                amplitude,
                Math.abs(luminance(a.slice(0, 3)) - luminance(b.slice(0, 3))),
              )
            }
          }
          if (first.visibility !== last.visibility && (first.visibility || last.visibility))
            amplitude = 1
        }
        const name = animation instanceof CSSAnimation ? animation.animationName : 'script'
        animations.push({
          name,
          kind: animation instanceof CSSAnimation ? 'css' : 'script',
          element: `${target.localName}${typeof target.className === 'string' && target.className ? `.${target.className.split(/\s+/)[0]}` : ''}`,
          ref: ref(target),
          properties: [...moves, ...blinks],
          periodMs: duration,
          infinite: timing.iterations === Infinity,
          totalMs: Number.isFinite(Number(timing.endTime))
            ? Number(timing.endTime)
            : Number.POSITIVE_INFINITY,
          area: Math.round(rect.width * rect.height),
          amplitude,
        })
      }

      const gifs = Array.from(document.querySelectorAll('img[src]'))
        .filter((img) => /\.gif(\?|#|$)/i.test(img.getAttribute('src') ?? '') && isVisible(img))
        .map((img) => ({
          src: (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src,
          ref: ref(img),
        }))

      const videos = Array.from(document.querySelectorAll('video[autoplay]'))
        .filter((video) => isVisible(video) && !(video as HTMLVideoElement).paused)
        .map((video) => ({
          ref: ref(video),
          controls: (video as HTMLVideoElement).controls,
          loop: (video as HTMLVideoElement).loop,
          muted: (video as HTMLVideoElement).muted,
        }))

      const carousels = Array.from(
        document.querySelectorAll(
          '[aria-roledescription="carousel"], [class*="carousel" i], [class*="slider" i], [class*="swiper" i], [class*="slick" i], [class*="slideshow" i], [class*="ticker" i]',
        ),
      )
        .filter(
          (el) =>
            isVisible(el) &&
            !isHiddenFromAT(el) &&
            !el.parentElement?.closest(
              '[class*="carousel" i], [class*="slider" i], [class*="swiper" i], [class*="slick" i]',
            ),
        )
        .slice(0, 6)
        .map((el) => ({ ref: ref(el) }))

      // Contrôle d'arrêt présent dans la page : indice pour le jugement.
      const stop = Array.from(document.querySelectorAll('button, [role="button"], a[href]')).find(
        (el) =>
          isVisible(el) &&
          /(^|\W)(pause|arr[eê]ter|stop|suspendre|figer|d[ée]sactiver les animations|lecture auto)(\W|$)/i.test(
            norm(accName(el)),
          ),
      )
      return {
        metas,
        scripts,
        attributes,
        libraries: [...new Set(libraries)],
        documents,
        cryptic,
        obsolete,
        animations,
        gifs,
        videos,
        carousels,
        pauseControl: stop ? norm(accName(stop)).slice(0, 60) : '',
      }
    },
    [MOTION_PROPERTIES, BLINK_PROPERTIES] as const,
  )
}

function fingerprints(page: Page, selectors: string[]): Promise<string[]> {
  return page.evaluate((list) => {
    return list.map((selector) => {
      const el = document.querySelector(selector)
      if (!el) return ''
      let signature = ''
      for (const node of [el, ...Array.from(el.querySelectorAll('*')).slice(0, 400)]) {
        signature += `${node.getAttribute('class') ?? ''}|${node.getAttribute('style') ?? ''}|${node.getAttribute('aria-hidden') ?? ''}|${node.getAttribute('aria-current') ?? ''};`
      }
      return `${signature}#${(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)}`
    })
  }, selectors)
}

/** Relevé de la page neuve, laissée 6 secondes pour voir ce qui bouge seul (carrousels, défilement). */
async function observe(
  ctx: PageContext,
): Promise<{ data: Survey; moving: string[]; popups: string[] }> {
  return ctx.memo('consultation.survey', async () => {
    const page = await ctx.fresh({ reducedMotion: 'no-preference' })
    const data = await survey(page)
    const selectors = data.carousels.map((carousel) => carousel.ref.selector)
    const before = await fingerprints(page, selectors)
    await page.waitForTimeout(6_000)
    const after = await fingerprints(page, selectors)
    const moving = selectors.filter((_, index) => before[index] !== after[index])
    // Fenêtres ouvertes pendant le chargement, sans geste de l'utilisateur.
    const popups = page
      .context()
      .pages()
      .filter((other) => other !== page)
      .map((other) => other.url())
    return { data, moving, popups }
  })
}

// ─── 13.1 : limites de temps ────────────────────────────────────────────────

const REFRESH = /^\s*(\d+(?:\.\d+)?)\s*(?:[;,]\s*(?:url\s*=\s*)?['"]?(.*?)['"]?)?\s*$/i

const timeLimits = defineCheck(['13.1.1', '13.1.2', '13.1.3', '13.1.4'], async (ctx, t) => {
  const { data } = await observe(ctx)

  for (const meta of data.metas) {
    const parsed = REFRESH.exec(meta.content)
    const delay = parsed ? Number(parsed[1]) : Number.NaN
    const target = parsed?.[2]?.trim() ?? ''
    if (target === '') {
      t('13.1.1').applicable()
      t('13.1.1').fail(
        `Rafraîchissement automatique de la page toutes les ${Number.isFinite(delay) ? delay : '?'} s (balise <meta http-equiv="refresh">) : l’utilisateur ne peut ni l’arrêter ni le relancer.`,
        meta.ref,
      )
    } else {
      t('13.1.2').applicable()
      if (!(delay === 0)) {
        t('13.1.2').fail(
          `Redirection <meta> vers ${target} après ${Number.isFinite(delay) ? delay : '?'} s : elle doit être immédiate (0 s).`,
          meta.ref,
        )
      }
    }
  }

  // 13.1.3 — redirections par script : seuls les scripts de la page sont lus.
  const redirect = /(setTimeout|setInterval)\s*\([^)]*?(location|window\.open)/s.exec(data.scripts)
  if (redirect) {
    await t('13.1.3').judgePass({
      topic: 'redirect.script',
      question:
        'Un script de la page déclenche une redirection après un délai. L’utilisateur peut-il l’arrêter, la relancer ou augmenter le délai ?',
      evidence: {
        page: ctx.path,
        extrait: data.scripts
          .slice(Math.max(0, redirect.index - 20), redirect.index + 140)
          .replace(/\s+/g, ' '),
      },
    })
  }

  // 13.1.4 — limites de session : repérées par les mots de la page.
  const text = await ctx.page.evaluate(() =>
    window.__rgaa.visibleText(document.body).slice(0, 20_000),
  )
  const session =
    /(session|connexion)[^.]{0,60}(expire|expir[eé]e?|d[ée]lai|minutes?|inactivit[eé])/i.exec(text)
  if (session) {
    await t('13.1.4').judgePass({
      topic: 'session.limit',
      question:
        'Le texte de la page évoque une limite de temps de session. L’utilisateur peut-il la supprimer, l’augmenter, ou en être averti 20 s avant au moins (avec 10 prolongations possibles) ?',
      evidence: { page: ctx.path, extrait: session[0].slice(0, 160) },
    })
  }
  t('13.1.3').note(
    'Seuls les scripts écrits dans la page sont lus : une redirection codée dans un fichier externe n’est pas repérée.',
  )
})

// ─── 13.2 : nouvelle fenêtre sans action ────────────────────────────────────

const newWindow = defineCheck(['13.2.1'], async (ctx, t) => {
  const { popups } = await observe(ctx)
  const o = t('13.2.1')
  o.applicable()
  for (const url of popups) {
    o.fail(
      `Une nouvelle fenêtre s’est ouverte d’elle-même pendant le chargement de la page (${url || 'adresse vide'}).`,
    )
  }
})

// ─── 13.3 / 13.4 : documents bureautiques ───────────────────────────────────

const documents = defineCheck(['13.3.1', '13.4.1'], async (ctx, t) => {
  const { data } = await observe(ctx)
  const base = new URL(ctx.url)
  let asked = 0
  for (const doc of data.documents) {
    if (asked >= MAX_QUESTIONS) break
    asked += 1
    const path = new URL(doc.href).pathname
    const isPdf = /\.pdf$/i.test(path)
    const tagging = isPdf ? await pdfTagging(base, doc.href) : 'sans objet'
    await t('13.3.1').judgePass({
      topic: 'document.accessible',
      question: `Le document « ${doc.label || path} » (${/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toUpperCase() ?? 'fichier'}) est-il compatible avec l’accessibilité, ou une version alternative accessible est-elle proposée ?`,
      evidence: { fichier: path, balisage: tagging, alternative: doc.alternative ? 'oui' : 'non' },
      ref: doc.ref,
    })
    if (doc.alternative) {
      await t('13.4.1').judgePass({
        topic: 'document.alternative',
        question: `La version accessible de « ${doc.label || path} » offre-t-elle la même information que le document ?`,
        evidence: { fichier: path },
        ref: doc.ref,
      })
    }
  }
  if (data.documents.length > MAX_QUESTIONS) {
    t('13.3.1').note(
      `${data.documents.length - MAX_QUESTIONS} autre(s) document(s) n’ont pas été soumis au jugement (plafond de ${MAX_QUESTIONS} par page).`,
    )
  }
  if (data.documents.some((doc) => /\.pdf$/i.test(doc.href))) {
    t('13.3.1').note(
      '« balisé » signifie que le PDF contient une structure logique : c’est nécessaire, pas suffisant.',
    )
  }
})

// ─── 13.5 / 13.6 : contenus cryptiques ──────────────────────────────────────

const cryptic = defineCheck(['13.5.1', '13.6.1'], async (ctx, t) => {
  const { data } = await observe(ctx)
  for (const item of data.cryptic.slice(0, MAX_QUESTIONS)) {
    if (item.title) {
      // Un attribut title est disponible : sa pertinence reste à juger (13.6.1).
      t('13.5.1').applicable()
      await t('13.6.1').judgePass({
        topic: 'cryptic.title',
        question: `Le contenu « ${item.text} » est expliqué par un attribut title. Cette explication est-elle pertinente ?`,
        evidence: { contenu: item.text, title: item.title },
        ref: item.ref,
      })
      continue
    }
    const answer = await t('13.5.1').judge({
      topic: 'cryptic.context',
      question: `Le contenu « ${item.text} » (émoticône ou dessin en caractères) est-il défini par le contexte adjacent ? Sinon, il n’a pas d’explication.`,
      answers: ['defini-par-le-contexte', 'sans-definition', 'pas-cryptique'],
      evidence: { contenu: item.text },
      ref: item.ref,
    })
    if (answer === 'sans-definition') {
      t('13.5.1').fail(
        `Le contenu cryptique « ${item.text} » n’a ni attribut title ni définition dans son contexte.`,
        item.ref,
      )
    } else if (answer === 'defini-par-le-contexte') {
      await t('13.6.1').judgePass({
        topic: 'cryptic.definition',
        question: `La définition donnée par le contexte pour « ${item.text} » est-elle pertinente ?`,
        evidence: { contenu: item.text },
        ref: item.ref,
      })
    }
  }
})

// ─── 13.7 / 13.8 : effets de flash, mouvements et clignotements ─────────────

/** Regroupe les animations identiques (même nom, mêmes propriétés) : une question par famille. */
function groupAnimations(
  animations: AnimationInfo[],
): { sample: AnimationInfo; count: number; area: number }[] {
  const groups = new Map<string, { sample: AnimationInfo; count: number; area: number }>()
  for (const animation of animations) {
    const key = `${animation.name}|${animation.properties.join(',')}`
    const group = groups.get(key)
    if (group) {
      group.count += 1
      group.area += animation.area
    } else {
      groups.set(key, { sample: animation, count: 1, area: animation.area })
    }
  }
  return [...groups.values()]
}

const motion = defineCheck(['13.7.1', '13.7.2', '13.7.3', '13.8.1', '13.8.2'], async (ctx, t) => {
  const { data, moving } = await observe(ctx)

  // 13.7 — effets de flash : cycle de moins de 333 ms avec un écart de luminosité net.
  const flashing = data.animations.filter(
    (animation) =>
      animation.infinite &&
      animation.periodMs < FLASH_PERIOD_MS &&
      animation.amplitude >= 0.1 &&
      animation.properties.some((property) => BLINK_PROPERTIES.includes(property)),
  )
  for (const group of groupAnimations(flashing)) {
    const test = group.sample.kind === 'css' ? '13.7.3' : '13.7.2'
    t(test).applicable()
    if (group.area >= FLASH_AREA) {
      t(test).fail(
        `Effet de flash : « ${group.sample.name} » alterne en ${group.sample.periodMs} ms (plus de 3 fois par seconde) sur ${group.count} élément(s), soit ${group.area} px² (limite : ${FLASH_AREA} px²).`,
        group.sample.ref,
      )
    }
  }
  t('13.7.1').note(
    'Les images, GIF et vidéos qui clignotent ne sont pas analysés image par image : relire ces médias à la main.',
  )

  // 13.8 — mouvements et clignotements automatiques de plus de 5 secondes.
  const lasting = data.animations.filter(
    (animation) =>
      !flashing.includes(animation) && (animation.infinite || animation.totalMs > 5_000),
  )
  const moves = lasting.filter((animation) =>
    animation.properties.some((p) => MOTION_PROPERTIES.includes(p)),
  )
  const blinks = lasting.filter(
    (animation) =>
      !moves.includes(animation) &&
      animation.amplitude >= 0.5 &&
      animation.properties.some((p) => BLINK_PROPERTIES.includes(p)),
  )
  const stop = data.pauseControl
    ? `Un contrôle « ${data.pauseControl} » existe dans la page.`
    : 'Aucun bouton d’arrêt n’a été repéré dans la page.'
  for (const [test, list, label] of [
    ['13.8.1', moves, 'se déplace'],
    ['13.8.2', blinks, 'clignote'],
  ] as const) {
    let asked = 0
    for (const group of groupAnimations(list)) {
      if (asked++ >= MAX_QUESTIONS) break
      await t(test).judgePass({
        topic: 'motion.control',
        question: `Le contenu « ${group.sample.element} » ${label} automatiquement (animation « ${group.sample.name} », ${group.sample.infinite ? 'en boucle' : `${Math.round(group.sample.totalMs / 1000)} s`}, ${group.count} élément(s)). ${stop} L’utilisateur peut-il l’arrêter et le relancer, ou le masquer ?`,
        evidence: {
          animation: group.sample.name,
          elements: String(group.count),
          proprietes: group.sample.properties.join(', '),
          boucle: group.sample.infinite ? 'oui' : 'non',
        },
        ref: group.sample.ref,
      })
    }
  }
  for (const item of data.obsolete) {
    const test = item.tag === 'blink' ? '13.8.2' : '13.8.1'
    t(test).applicable()
    t(test).fail(
      `Balise obsolète <${item.tag}> : contenu ${item.tag === 'blink' ? 'clignotant' : 'en mouvement'} que l’utilisateur ne peut pas arrêter.`,
      item.ref,
    )
  }

  // GIF animés : image, durée du tour et nombre de tours lus dans le fichier.
  const base = new URL(ctx.url)
  for (const gif of data.gifs.slice(0, MAX_QUESTIONS)) {
    const info = await gifInfo(base, gif.src)
    if (!info || info.frames < 2) continue
    const looping = info.loops === 0
    if (!looping && info.loopMs * (info.loops ?? 1) <= 5_000) continue
    t('13.8.1').applicable()
    await t('13.8.1').judgePass({
      topic: 'motion.gif',
      question: `Ce GIF animé (${info.frames} images, ${(info.loopMs / 1000).toFixed(1)} s${looping ? ', en boucle' : ''}) s’anime plus de 5 secondes. L’utilisateur peut-il l’arrêter ou le masquer ?`,
      evidence: {
        fichier: new URL(gif.src).pathname,
        images: String(info.frames),
        boucle: looping ? 'oui' : 'non',
      },
      ref: gif.ref,
    })
  }

  // Vidéos lancées seules.
  for (const video of data.videos) {
    t('13.8.1').applicable()
    if (video.controls) continue // l'utilisateur dispose des commandes natives.
    await t('13.8.1').judgePass({
      topic: 'motion.video',
      question: `Cette vidéo démarre automatiquement${video.loop ? ' et tourne en boucle' : ''}, sans commandes natives. ${stop} L’utilisateur peut-il l’arrêter ?`,
      evidence: { boucle: video.loop ? 'oui' : 'non', muette: video.muted ? 'oui' : 'non' },
      ref: video.ref,
    })
  }

  // Carrousels dont le contenu change seul pendant l'observation.
  for (const selector of moving) {
    const carousel = data.carousels.find((item) => item.ref.selector === selector)
    if (!carousel) continue
    t('13.8.1').applicable()
    await t('13.8.1').judgePass({
      topic: 'motion.carousel',
      question: `Ce carrousel a changé de contenu seul en 6 secondes. ${stop} L’utilisateur peut-il l’arrêter et le relancer ?`,
      evidence: { page: ctx.path, element: selector },
      ref: carousel.ref,
    })
  }
  t('13.8.1').note(
    'Observation de 6 secondes : un mouvement plus lent ou déclenché plus tard n’est pas repéré.',
  )
})

// ─── 13.9 : orientation de l'écran ──────────────────────────────────────────

const ORIENTATION_MESSAGE =
  /(tourn\w+|pivot\w+|orient\w+|rotate|turn)\s+(votre|your|l['’])?\s*(appareil|[ée]cran|t[ée]l[ée]phone|device|phone|screen|tablette)|(mode|vue)\s+(portrait|paysage)|please\s+rotate/i

async function orientationProfile(page: Page): Promise<{ chars: number; message: string }> {
  return page.evaluate((pattern) => {
    const text = window.__rgaa.visibleText(document.body)
    const found = new RegExp(pattern, 'i').exec(text)
    return { chars: text.length, message: found?.[0] ?? '' }
  }, ORIENTATION_MESSAGE.source)
}

const orientation = defineCheck(['13.9.1'], async (ctx, t) => {
  const portrait = await ctx.shared('orientation-portrait', {
    viewport: { width: 390, height: 844 },
  })
  const landscape = await ctx.shared('orientation-landscape', {
    viewport: { width: 844, height: 390 },
  })
  const [p, l] = await Promise.all([orientationProfile(portrait), orientationProfile(landscape)])
  const o = t('13.9.1')
  o.applicable()
  if (Boolean(p.message) !== Boolean(l.message)) {
    const shown = p.message ? 'portrait' : 'paysage'
    o.fail(
      `La page affiche « ${p.message || l.message} » en ${shown} : la consultation dépend de l’orientation de l’écran.`,
    )
    return
  }
  const ratio = p.chars === 0 ? 1 : l.chars / p.chars
  // À 844 px de large le gabarit change : on ne s'alarme que d'une perte massive de contenu.
  if (ratio < 0.6) {
    await o.judgePass({
      topic: 'orientation.content',
      question: `En paysage, la page n’affiche que ${Math.round(ratio * 100)} % du texte visible en portrait (${l.chars} contre ${p.chars} caractères). Le contenu et les fonctions restent-ils les mêmes ?`,
      evidence: { page: ctx.path, portrait: String(p.chars), paysage: String(l.chars) },
    })
  }
})

// ─── 13.10 à 13.12 : gestes, pointeur, mouvement ────────────────────────────

/** Une question par page pour chaque famille de geste repérée dans le code. */
async function codeSignal(
  t: OutcomeFor,
  test: string,
  topic: string,
  question: string,
  hits: string[],
  path: string,
): Promise<void> {
  if (hits.length === 0) return
  await t(test).judgePass({
    topic,
    question,
    evidence: { page: path, indices: hits.slice(0, 4).join(' | ') },
  })
}

const gestures = defineCheck(
  ['13.10.1', '13.10.2', '13.11.1', '13.12.1', '13.12.2', '13.12.3'],
  async (ctx, t) => {
    const { data } = await observe(ctx)
    const code = data.scripts
    const attribute = (pattern: RegExp) =>
      data.attributes
        .filter((a) => pattern.test(a.name))
        .map((a) => `${a.name} sur ${a.ref.selector}`)
    const script = (pattern: RegExp) => {
      const found = pattern.exec(code)
      return found
        ? [code.slice(Math.max(0, found.index - 20), found.index + 80).replace(/\s+/g, ' ')]
        : []
    }
    const library = (pattern: RegExp) =>
      data.libraries.filter((name) => pattern.test(name)).map((name) => `bibliothèque ${name}`)

    await codeSignal(
      t,
      '13.10.1',
      'gesture.multipoint',
      'Le code de la page gère des gestes à plusieurs doigts (pincement, rotation). Chaque fonction obtenue ainsi existe-t-elle aussi par un contact en un point (boutons +/−, par exemple) ?',
      [
        ...attribute(/^ongesturestart$/),
        ...script(/gesturestart|touches\s*\[\s*1\s*\]|touches\.length\s*[>=]=?\s*2|pinch/i),
        ...library(
          /hammer|pinch|panzoom|leaflet|openlayers|ol\.js|mapbox|maplibre|maps\.googleapis/,
        ),
      ],
      ctx.path,
    )
    await codeSignal(
      t,
      '13.10.2',
      'gesture.path',
      'Le code de la page gère des gestes qui suivent une trajectoire (balayage, glisser-déposer). Chaque fonction obtenue ainsi existe-t-elle aussi par un contact en un point (boutons précédent/suivant, par exemple) ?',
      [
        ...attribute(/^ontouchmove$/),
        ...script(/touchmove|swipe|ondrag|draggable|pointermove/i),
        ...library(/swiper|slick|flickity|glide|embla|hammer|touch/),
      ],
      ctx.path,
    )
    await codeSignal(
      t,
      '13.11.1',
      'pointer.down',
      'Le code de la page déclenche des actions à l’appui (mousedown, pointerdown, touchstart) plutôt qu’au relâchement. Ces actions peuvent-elles être annulées, abandonnées ou inversées ?',
      [
        ...attribute(/^on(mousedown|pointerdown|touchstart)$/),
        ...script(/addEventListener\(\s*['"](mousedown|pointerdown|touchstart)['"]/),
      ],
      ctx.path,
    )
    await codeSignal(
      t,
      '13.12.1',
      'motion.device',
      'Le code de la page réagit au mouvement de l’appareil (inclinaison, secousse). Chaque fonction obtenue ainsi est-elle aussi accessible par des composants d’interface ?',
      [
        ...attribute(/^on(devicemotion|deviceorientation)$/),
        ...script(/devicemotion|deviceorientation|DeviceMotionEvent|shake/i),
      ],
      ctx.path,
    )
    await codeSignal(
      t,
      '13.12.3',
      'motion.disable',
      'Le code de la page réagit au mouvement de l’appareil. L’utilisateur peut-il désactiver cette détection pour éviter un déclenchement accidentel ?',
      [
        ...attribute(/^on(devicemotion|deviceorientation)$/),
        ...script(/devicemotion|deviceorientation|DeviceMotionEvent|shake/i),
      ],
      ctx.path,
    )
    t('13.10.1').note(
      'Seul le code écrit dans la page et les bibliothèques reconnues par leur nom de fichier sont repérés : les gestes codés dans un bundle échappent à cette détection.',
    )
  },
)

export const checks: Check[] = [
  timeLimits,
  newWindow,
  documents,
  cryptic,
  motion,
  orientation,
  gestures,
]
