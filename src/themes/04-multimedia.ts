import { type Check, defineCheck, type ElementRef, type OutcomeFor } from '../core/types.ts'
import { resolvePageUrl } from '../security/url.ts'

/**
 * Thématique 4 — Multimédia.
 *
 * Inventaire des médias de la page : `<video>`, `<audio>`, lecteurs incorporés (YouTube, Vimeo,
 * SoundCloud…), `<object>`, `<embed>`, `<bgsound>`. Pour chacun, l'outil relève ce qui se voit dans
 * le code : pistes `<track>`, commandes natives, boutons de lecture, liens adjacents (« transcription »,
 * « audiodescription », « version sous-titrée »), lecture automatique du son, contenu de repli.
 * Ce que dit un média, lui, ne se mesure pas : transcriptions, sous-titres et audiodescriptions
 * trouvés sont soumis au jugement, de même que leur absence (un média décoratif ou lui-même alternatif
 * n'a pas besoin d'alternative).
 */

type Kind = 'audio' | 'video' | 'video-seule' | 'embed-video' | 'embed-audio' | 'objet'

interface Track {
  kind: string
  src: string
  lang: string
  label: string
}

interface Media {
  kind: Kind
  tag: string
  /** Identifiant stable du média : chemin du fichier ou lecteur incorporé. */
  source: string
  provider: string
  ref: ElementRef
  controls: boolean
  autoplay: boolean
  muted: boolean
  loop: boolean
  tracks: Track[]
  /** Contenu de repli (`<object>`, `<video>`, `<audio>`) : texte qui remplace le média. */
  fallback: string
  title: string
  /** Texte adjacent qui identifie le média : légende, titre, intitulé du conteneur. */
  identification: string
  /** Liens et boutons placés dans le même conteneur, avec leur intitulé. */
  neighbours: { label: string; href: string; tag: string; focusable: boolean; ref: ElementRef }[]
}

const VIDEO_PROVIDERS =
  /(youtube(-nocookie)?\.com|youtu\.be|vimeo\.com|dailymotion\.com|peertube|canal-u\.tv|arte\.tv|france\.tv|twitch\.tv|tiktok\.com|facebook\.com\/plugins\/video|viously|wistia|vidyard|brightcove)/i
const AUDIO_PROVIDERS =
  /(soundcloud\.com|spotify\.com|deezer\.com|ausha\.co|podcloud|anchor\.fm|mixcloud|podcasts?\.)/i

function collect(page: import('playwright').Page): Promise<Media[]> {
  return page.evaluate(
    ([videoPattern, audioPattern]) => {
      const { ref, norm, isHiddenFromAT, isRendered, accName, tabbables } = window.__rgaa
      const video = new RegExp(videoPattern, 'i')
      const audio = new RegExp(audioPattern, 'i')
      const focusable = new Set<Element>(tabbables())
      const out: Media[] = []

      const identify = (el: Element) => {
        const figure = el.closest('figure')
        const caption = figure?.querySelector('figcaption')
        if (caption) return norm(caption.textContent).slice(0, 120)
        const label = norm(el.getAttribute('title') || el.getAttribute('aria-label'))
        if (label) return label.slice(0, 120)
        // Titre ou paragraphe qui précède le média dans son conteneur.
        let holder: Element | null = el
        for (let depth = 0; depth < 3 && holder; depth++) {
          let previous = holder.previousElementSibling
          while (previous && !norm(previous.textContent)) previous = previous.previousElementSibling
          if (
            previous &&
            /^(h[1-6]|p|strong|b|div|span|figcaption|label)$/i.test(previous.localName)
          ) {
            const text = norm(previous.textContent)
            if (text.length > 0 && text.length < 200) return text.slice(0, 120)
          }
          holder = holder.parentElement
          if (holder?.matches('main, body, article, section')) break
        }
        return ''
      }

      /**
       * Commandes et liens « adjacents » : ceux de son conteneur propre (figure, item, lecteur),
       * et ceux de l'élément qui le précède ou le suit immédiatement. Jamais ceux de toute la page.
       */
      const neighbours = (el: Element) => {
        const wide = (node: Element | null) => !node || node.matches('main, body, article, section')
        const holder =
          el.closest('figure, li, .video, .media, [class*="player" i]') ?? el.parentElement
        const base = wide(holder) ? el : (holder as Element)
        const scopes: Element[] = []
        if (!wide(holder)) scopes.push(base)
        if (base.previousElementSibling) scopes.push(base.previousElementSibling)
        if (base.nextElementSibling) scopes.push(base.nextElementSibling)
        const controls = new Set<Element>()
        for (const scope of scopes) {
          if (scope.matches('a[href], button, [role="button"]')) controls.add(scope)
          for (const control of scope.querySelectorAll('a[href], button, [role="button"]'))
            controls.add(control)
        }
        return Array.from(controls)
          .filter((control) => !el.contains(control) && isRendered(control))
          .slice(0, 12)
          .map((control) => ({
            label: norm(accName(control) || control.textContent).slice(0, 80),
            href: control.getAttribute('href') ?? '',
            tag: control.localName,
            focusable: focusable.has(control as HTMLElement),
            ref: ref(control),
          }))
      }

      const add = (el: Element, kind: Kind, source: string, provider: string) => {
        if (isHiddenFromAT(el) && !(el instanceof HTMLMediaElement && el.autoplay)) return
        const media = el as HTMLMediaElement
        out.push({
          kind,
          tag: el.localName,
          source,
          provider,
          ref: ref(el),
          controls: media.controls === true,
          autoplay:
            media.autoplay === true || el.hasAttribute('autoplay') || /[?&]autoplay=1/.test(source),
          muted: media.muted === true || el.hasAttribute('muted') || /[?&]mute=1/.test(source),
          loop: media.loop === true,
          tracks: Array.from(el.querySelectorAll('track')).map((track) => ({
            kind: (track.getAttribute('kind') ?? 'subtitles').toLowerCase(),
            src: track.getAttribute('src') ?? '',
            lang: track.getAttribute('srclang') ?? '',
            label: track.getAttribute('label') ?? '',
          })),
          fallback: norm(
            Array.from(el.childNodes)
              .filter(
                (n) =>
                  n.nodeType === 3 ||
                  (n instanceof Element && !['source', 'track', 'param'].includes(n.localName)),
              )
              .map((n) => n.textContent)
              .join(' '),
          ).slice(0, 200),
          title: norm(el.getAttribute('title') || el.getAttribute('aria-label')),
          identification: identify(el),
          neighbours: neighbours(el),
        })
      }

      const pathOf = (value: string) => {
        try {
          const url = new URL(value, location.href)
          return url.host === location.host ? url.pathname : `${url.host}${url.pathname}`
        } catch {
          return value
        }
      }

      for (const el of document.querySelectorAll('video')) {
        const v = el as HTMLVideoElement
        const src =
          v.currentSrc ||
          v.getAttribute('src') ||
          v.querySelector('source')?.getAttribute('src') ||
          ''
        add(el, v.muted || v.hasAttribute('muted') ? 'video-seule' : 'video', pathOf(src), '')
      }
      for (const el of document.querySelectorAll('audio')) {
        const a = el as HTMLAudioElement
        add(
          el,
          'audio',
          pathOf(
            a.currentSrc ||
              a.getAttribute('src') ||
              a.querySelector('source')?.getAttribute('src') ||
              '',
          ),
          '',
        )
      }
      for (const el of document.querySelectorAll('iframe[src]')) {
        const src = el.getAttribute('src') ?? ''
        if (video.test(src)) add(el, 'embed-video', pathOf(src), new URL(src, location.href).host)
        else if (audio.test(src))
          add(el, 'embed-audio', pathOf(src), new URL(src, location.href).host)
      }
      for (const el of document.querySelectorAll('object, embed')) {
        const src = el.getAttribute('data') ?? el.getAttribute('src') ?? ''
        const type = (el.getAttribute('type') ?? '').toLowerCase()
        // Les images et SVG décoratifs relèvent de la thématique 1.
        if (type.startsWith('image/') || /\.(svg|png|jpe?g|gif|webp)(\?|#|$)/i.test(src)) continue
        if (el.closest('object') !== el && el.localName === 'object') continue
        if (el.parentElement?.closest('object')) continue
        add(
          el,
          type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'objet',
          pathOf(src),
          '',
        )
      }
      for (const el of document.querySelectorAll('bgsound'))
        add(el, 'audio', pathOf(el.getAttribute('src') ?? ''), '')
      return out
    },
    [VIDEO_PROVIDERS.source, AUDIO_PROVIDERS.source] as const,
  )
}

// ─── Vérifications ──────────────────────────────────────────────────────────

const TRANSCRIPT = /transcription|transcript|texte int[ée]gral|version texte|retranscription/i
const AUDIO_DESCRIPTION = /audio-?description|audio-?d[ée]crit|version\s+audio-?d[ée]crit/i
const CAPTIONED = /sous-?titr|version\s+(sous|avec)|captions?|lsf|langue des signes/i
const PLAY_CONTROL = /(^|\W)(lecture|lire|play|pause|volume|muet|son)(\W|$)/i

const describeMedia = (media: Media) =>
  `${media.tag} « ${media.source || media.provider || 'sans source'} »`

/** Intitulé et adresse d'un lien adjacent qui répond au motif, ou `null`. */
function neighbour(media: Media, pattern: RegExp): { label: string; href: string } | null {
  const found = media.neighbours.find((n) => n.tag === 'a' && pattern.test(n.label))
  return found ? { label: found.label, href: found.href } : null
}

async function fetchCues(base: URL, src: string): Promise<{ cues: number; first: string } | null> {
  try {
    const url = resolvePageUrl(base, src)
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    if (!response.ok) return null
    const text = (await response.text()).slice(0, 300_000)
    const cues = text.split('-->').length - 1
    const first = /-->[^\n]*\n([^\n]+)/.exec(text)?.[1]?.trim() ?? ''
    return { cues, first: first.slice(0, 100) }
  } catch {
    return null
  }
}

const media = defineCheck(
  [
    '4.1.1',
    '4.1.2',
    '4.1.3',
    '4.2.1',
    '4.2.2',
    '4.2.3',
    '4.3.1',
    '4.3.2',
    '4.4.1',
    '4.5.1',
    '4.5.2',
    '4.6.1',
    '4.6.2',
    '4.7.1',
    '4.8.1',
    '4.8.2',
    '4.9.1',
    '4.10.1',
    '4.11.1',
    '4.11.2',
    '4.11.3',
    '4.12.1',
    '4.12.2',
    '4.13.1',
    '4.13.2',
  ],
  async (ctx, t) => {
    const list = await collect(ctx.page)
    const base = new URL(ctx.url)

    for (const item of list) {
      const timed = item.kind !== 'objet'
      const id = { page: ctx.path, media: item.source || item.provider }
      if (timed) {
        await alternatives(item, id, t)
        await captions(item, id, t, base)
        await audioDescription(item, id, t)
        await identification(item, id, t)
        await autoplaySound(item, t)
        await controls(item, id, t)
      } else {
        await nonTimed(item, id, t)
      }
    }
    if (list.some((item) => item.kind === 'embed-video' || item.kind === 'embed-audio')) {
      for (const test of ['4.3.1', '4.5.2']) {
        t(test).note(
          'Lecteurs incorporés (YouTube, Vimeo…) : sous-titres et audiodescription gérés par le lecteur, non lisibles depuis la page ; ils sont soumis au jugement.',
        )
      }
    }
  },
)

type Id = Record<string, string>

/** 4.1 / 4.2 — transcription ou version alternative des médias préenregistrés. */
async function alternatives(item: Media, id: Id, t: OutcomeFor): Promise<void> {
  const test =
    item.kind === 'audio' || item.kind === 'embed-audio'
      ? '4.1.1'
      : item.kind === 'video-seule'
        ? '4.1.2'
        : '4.1.3'
  const relevance = test === '4.1.1' ? '4.2.1' : test === '4.1.2' ? '4.2.2' : '4.2.3'
  t(test).applicable()
  const link =
    neighbour(item, TRANSCRIPT) ?? neighbour(item, AUDIO_DESCRIPTION) ?? neighbour(item, CAPTIONED)
  const described = item.tracks.some((track) => track.kind === 'descriptions')
  if (!link && !described) {
    const answer = await t(test).judge({
      topic: 'media.alternative',
      question: `Aucune transcription ni version alternative n’est repérée près du média ${describeMedia(item)}. Est-elle inutile (média décoratif, ou lui-même alternative à un contenu) ?`,
      answers: ['inutile', 'alternative-absente'],
      evidence: { ...id, type: item.kind },
      ref: item.ref,
    })
    if (answer === 'alternative-absente') {
      t(test).fail(
        `Le média ${describeMedia(item)} n’a ni transcription textuelle ni version alternative.`,
        item.ref,
      )
    }
    return
  }
  await t(relevance).judgePass({
    topic: 'media.alternative.relevance',
    question: `${described && !link ? 'La piste d’audiodescription' : `Le lien « ${link?.label} »`} du média ${describeMedia(item)} propose-t-il une alternative pertinente (transcription complète, audiodescription synchronisée) ?`,
    evidence: {
      ...id,
      alternative: link?.label ?? 'piste descriptions',
      adresse: link?.href ?? '',
    },
    ref: item.ref,
  })
}

/** 4.3 / 4.4 — sous-titres synchronisés des médias synchronisés. */
async function captions(item: Media, id: Id, t: OutcomeFor, base: URL): Promise<void> {
  if (item.kind !== 'video' && item.kind !== 'embed-video') return
  t('4.3.1').applicable()
  const subtitles = item.tracks.filter(
    (track) => track.kind === 'captions' || track.kind === 'subtitles',
  )
  const captioned = item.tracks.filter((track) => track.kind === 'captions')

  if (subtitles.length > 0) {
    // 4.3.2 — des sous-titres diffusés par <track> doivent être déclarés kind="captions".
    t('4.3.2').applicable()
    if (captioned.length === 0) {
      t('4.3.2').fail(
        `La piste <track> du média ${describeMedia(item)} est déclarée kind="${subtitles[0]?.kind}" : les sous-titres pour personnes sourdes doivent porter kind="captions".`,
        item.ref,
      )
    }
    // 4.4.1 — le contenu des sous-titres : lu dans le fichier, puis jugé.
    for (const track of subtitles.slice(0, 2)) {
      const cues = track.src ? await fetchCues(base, track.src) : null
      if (cues && cues.cues === 0) {
        t('4.4.1').fail(
          `Le fichier de sous-titres ${track.src} ne contient aucune réplique.`,
          item.ref,
        )
        continue
      }
      await t('4.4.1').judgePass({
        topic: 'media.captions',
        question: `Les sous-titres « ${track.label || track.lang || track.src} » du média ${describeMedia(item)} sont-ils pertinents (fidèles aux dialogues, synchronisés, avec les informations sonores utiles) ?`,
        evidence: {
          ...id,
          piste: track.src.split('/').pop() ?? '',
          repliques: cues ? String(cues.cues) : 'non lues',
          debut: cues?.first ?? '',
        },
        ref: item.ref,
      })
    }
    return
  }

  const alternative = neighbour(item, CAPTIONED) ?? neighbour(item, TRANSCRIPT)
  const answer = await t('4.3.1').judge({
    topic: 'media.subtitles',
    question: `Le média ${describeMedia(item)} n’a pas de piste de sous-titres lisible dans la page${alternative ? ` (lien voisin : « ${alternative.label} »)` : ''}. A-t-il des sous-titres synchronisés (dans le lecteur), ou est-il sans parole ni son utile ?`,
    answers: ['sous-titres-presents', 'sans-objet', 'sous-titres-absents'],
    evidence: { ...id, fournisseur: item.provider, alternative: alternative?.label ?? '' },
    ref: item.ref,
  })
  if (answer === 'sous-titres-absents') {
    t('4.3.1').fail(
      `Le média ${describeMedia(item)} n’a ni sous-titres synchronisés ni version alternative sous-titrée.`,
      item.ref,
    )
  } else if (answer === 'sous-titres-presents') {
    await t('4.4.1').judgePass({
      topic: 'media.captions',
      question: `Les sous-titres du média ${describeMedia(item)} sont-ils pertinents (fidèles aux dialogues, synchronisés, avec les informations sonores utiles) ?`,
      evidence: { ...id, piste: 'dans le lecteur', repliques: 'non lues', debut: '' },
      ref: item.ref,
    })
  }
}

/** 4.5 / 4.6 — audiodescription des vidéos. */
async function audioDescription(item: Media, id: Id, t: OutcomeFor): Promise<void> {
  if (item.kind !== 'video' && item.kind !== 'embed-video' && item.kind !== 'video-seule') return
  const test = item.kind === 'video-seule' ? '4.5.1' : '4.5.2'
  const relevance = item.kind === 'video-seule' ? '4.6.1' : '4.6.2'
  t(test).applicable()
  const track = item.tracks.find((candidate) => candidate.kind === 'descriptions')
  const link = neighbour(item, AUDIO_DESCRIPTION)
  if (track || link) {
    await t(relevance).judgePass({
      topic: 'media.audiodescription',
      question: `L’audiodescription du média ${describeMedia(item)} (${track ? 'piste descriptions' : `lien « ${link?.label} »`}) est-elle pertinente (décrit les informations visuelles utiles, de façon synchronisée) ?`,
      evidence: { ...id, source: track?.src.split('/').pop() ?? link?.label ?? '' },
      ref: item.ref,
    })
    return
  }
  const answer = await t(test).judge({
    topic: 'media.audiodescription.needed',
    question: `Aucune audiodescription n’est repérée pour le média ${describeMedia(item)}. Les images transmettent-elles une information qui n’est pas dite dans la bande son (sinon l’audiodescription est inutile) ?`,
    answers: ['inutile', 'audiodescription-absente'],
    evidence: { ...id, fournisseur: item.provider },
    ref: item.ref,
  })
  if (answer === 'audiodescription-absente') {
    t(test).fail(
      `Le média ${describeMedia(item)} n’a pas d’audiodescription alors que ses images portent de l’information.`,
      item.ref,
    )
  }
}

/** 4.7 — identification du média par le texte adjacent. */
async function identification(item: Media, id: Id, t: OutcomeFor): Promise<void> {
  t('4.7.1').applicable()
  if (item.identification !== '') {
    await t('4.7.1').judgePass({
      topic: 'media.identification',
      question: `Le texte « ${item.identification} » identifie-t-il clairement le média ${describeMedia(item)} (nature, sujet) ?`,
      evidence: { ...id, texte: item.identification },
      ref: item.ref,
    })
    return
  }
  t('4.7.1').fail(
    `Aucun texte adjacent (légende, titre, intitulé) n’identifie le média ${describeMedia(item)}.`,
    item.ref,
  )
}

/** 4.10 — son déclenché automatiquement. */
async function autoplaySound(item: Media, t: OutcomeFor): Promise<void> {
  if (!item.autoplay || item.muted || item.kind === 'video-seule') return
  t('4.10.1').applicable()
  if (!item.controls && !item.neighbours.some((n) => PLAY_CONTROL.test(n.label))) {
    t('4.10.1').fail(
      `Le média ${describeMedia(item)} déclenche du son automatiquement et n’offre aucune commande pour l’arrêter ou le couper.`,
      item.ref,
    )
    return
  }
  await t('4.10.1').judgePass({
    topic: 'media.autoplay',
    question: `Le média ${describeMedia(item)} démarre seul avec du son. Le son dure-t-il 3 secondes au plus, ou l’utilisateur peut-il l’arrêter ou le couper dès le début de la page (commande atteinte en moins de 3 tabulations) ?`,
    evidence: {
      media: item.source || item.provider,
      commandes: item.controls ? 'natives' : 'personnalisées',
    },
    ref: item.ref,
  })
}

/** 4.11 / 4.13 — commandes de consultation des médias temporels. */
async function controls(item: Media, id: Id, t: OutcomeFor): Promise<void> {
  if (item.kind === 'embed-video' || item.kind === 'embed-audio') {
    // Le lecteur incorporé fournit ses commandes : on contrôle son accès, pas son contenu.
    t('4.11.1').applicable()
    t('4.11.2').applicable()
    t('4.11.3').applicable()
    t('4.11.1').note(
      'Lecteur incorporé : ses commandes sont celles de son éditeur, essayées au clavier seulement via le jugement 4.11.2 / 4.11.3 de la page.',
    )
    await t('4.11.2').judgePass({
      topic: 'media.player.keyboard',
      question: `Le lecteur incorporé ${item.provider || item.source} est-il utilisable au clavier (atteindre et activer lecture, pause, volume, sous-titres) ?`,
      evidence: { fournisseur: item.provider, ...id },
      ref: item.ref,
    })
    return
  }
  t('4.11.1').applicable()
  if (item.controls) {
    t('4.11.2').applicable()
    t('4.11.3').applicable()
    t('4.13.1').applicable()
    return // commandes natives du navigateur : atteignables au clavier et au pointeur.
  }
  const buttons = item.neighbours.filter((n) => n.tag !== 'a' && PLAY_CONTROL.test(n.label))
  if (buttons.length === 0) {
    t('4.11.1').fail(
      `Le média ${describeMedia(item)} n’a ni commandes natives (attribut controls) ni bouton de lecture ou de pause.`,
      item.ref,
    )
    return
  }
  // Commandes personnalisées : accessibles au clavier ? nommées ?
  t('4.11.2').applicable(buttons.length)
  t('4.13.1').applicable(buttons.length)
  for (const button of buttons) {
    if (!button.focusable) {
      t('4.11.2').fail(
        `La commande « ${button.label} » du média ${describeMedia(item)} n’est pas atteignable au clavier.`,
        button.ref,
      )
    }
  }
  await t('4.11.3').judgePass({
    topic: 'media.controls.activation',
    question: `Les commandes personnalisées (${buttons.map((b) => `« ${b.label} »`).join(', ')}) du média ${describeMedia(item)} s’activent-elles au clavier et à la souris ?`,
    evidence: { ...id, commandes: buttons.map((b) => b.label).join(' | ') },
    ref: item.ref,
  })
}

/** 4.8 / 4.9 / 4.12 / 4.13 — médias non temporels (`<object>`, `<embed>`). */
async function nonTimed(item: Media, id: Id, t: OutcomeFor): Promise<void> {
  t('4.8.1').applicable()
  const link = item.neighbours.find((n) => n.tag === 'a' && n.label !== '')
  const hasFallback = item.fallback !== ''
  if (!hasFallback && !link) {
    const answer = await t('4.8.1').judge({
      topic: 'media.nontimed.alternative',
      question: `Le média non temporel ${describeMedia(item)} n’a ni contenu de repli ni lien adjacent vers une alternative. En a-t-il besoin (hors média décoratif ou environnement maîtrisé) ?`,
      answers: ['inutile', 'alternative-absente'],
      evidence: id,
      ref: item.ref,
    })
    if (answer === 'alternative-absente') {
      t('4.8.1').fail(
        `Le média non temporel ${describeMedia(item)} n’a pas d’alternative.`,
        item.ref,
      )
    }
  } else {
    await t('4.9.1').judgePass({
      topic: 'media.nontimed.relevance',
      question: `L’alternative du média ${describeMedia(item)} (${hasFallback ? `contenu de repli « ${item.fallback.slice(0, 60)} »` : `lien « ${link?.label} »`}) donne-t-elle accès au même contenu et à des fonctionnalités similaires ?`,
      evidence: {
        ...id,
        alternative: hasFallback ? item.fallback.slice(0, 80) : (link?.label ?? ''),
      },
      ref: item.ref,
    })
    if (link && !hasFallback) {
      await t('4.8.2').judgePass({
        topic: 'media.nontimed.page',
        question: `La page ou le contenu vers lequel mène « ${link.label} » est-il accessible ?`,
        evidence: { ...id, lien: link.label, adresse: link.href },
        ref: item.ref,
      })
    }
  }
  await t('4.12.1').judgePass({
    topic: 'media.nontimed.keyboard',
    question: `Les fonctionnalités du média non temporel ${describeMedia(item)} sont-elles accessibles au clavier et au pointeur ?`,
    evidence: id,
    ref: item.ref,
  })
  await t('4.12.2').judgePass({
    topic: 'media.nontimed.activation',
    question: `Les fonctionnalités du média non temporel ${describeMedia(item)} sont-elles activables au clavier et au pointeur ?`,
    evidence: id,
    ref: item.ref,
  })
  await t('4.13.1').judgePass({
    topic: 'media.nontimed.assistive',
    question: `Le média ${describeMedia(item)} est-il compatible avec les technologies d’assistance (nom, rôle, valeur et états des composants exposés) ?`,
    evidence: id,
    ref: item.ref,
  })
  if (hasFallback || link) {
    t('4.13.2').applicable()
  }
}

export const checks: Check[] = [media]
