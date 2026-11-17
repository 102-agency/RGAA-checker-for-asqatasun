import { type Check, defineCheck, type OutcomeFor, type PageContext } from '../core/types.ts'
import { deepReveals, revealCases } from '../lib/presentation-deep.ts'
import {
  type CssReport,
  cssOnlyInformation,
  cssReport,
  hiddenContent,
  inlineLinks,
  type LayoutSnapshot,
  markupReport,
  readingOrder,
  shapeCandidates,
} from '../lib/presentation-inpage.ts'
import { type LostText, layoutMeasures, type OpenState } from '../lib/presentation-measures.ts'
import { type ScanResult, scanInteractions } from '../lib/presentation-scan.ts'

/**
 * Thématique 10 — Présentation de l'information.
 *
 * Les contrôles s'appuient sur le rendu réel : une page neuve que l'on redimensionne
 * et modifie (zoom, reflow, espacement du texte, page sans CSS : `presentation-measures`),
 * et une autre que l'on manipule (tabulation, survol : `presentation-scan`).
 */

// ─── 10.1 : balises, attributs et espaces de présentation ───────────────────

const markup = defineCheck(['10.1.1', '10.1.2', '10.1.3'], async (ctx, t) => {
  // Le DOCTYPE HTML 5 est `<!DOCTYPE html>` : `<u>` n'est une balise de présentation que dans les autres.
  const doctype = await ctx.page.evaluate(() => {
    const d = document.doctype
    return d ? { name: d.name, publicId: d.publicId, systemId: d.systemId } : null
  })
  const html5 =
    !doctype ||
    (doctype.name.toLowerCase() === 'html' &&
      doctype.publicId === '' &&
      (doctype.systemId === '' || doctype.systemId === 'about:legacy-compat'))
  const report = await ctx.page.evaluate(markupReport, html5)

  t('10.1.1').applicable()
  for (const finding of report.tags) t('10.1.1').fail(finding.message, finding.ref)

  t('10.1.2').applicable()
  for (const finding of report.attributes) t('10.1.2').fail(finding.message, finding.ref)

  // 10.1.3 : tout page avec du texte est concernée.
  if (report.hasText) t('10.1.3').applicable()
  for (const finding of report.spaces) t('10.1.3').fail(finding.message, finding.ref)
  for (const pre of report.preformatted) {
    await t('10.1.3').judgePass({
      topic: 'presentation.espaces-pre',
      question:
        'Dans ce texte préformaté, les espaces servent-ils à simuler un tableau ou des colonnes (non) plutôt qu’à présenter du code ou un texte dont la mise en forme fait le sens (oui) ?',
      evidence: { texte: pre.text },
      ref: pre.ref,
    })
  }
  t('10.1.3').note(
    'Contrôle limité aux espaces insécables en série, aux lettres espacées et au texte préformaté : des retraits obtenus par des espaces ordinaires ne sont pas visibles dans le DOM.',
  )
})

// ─── 10.2 et 10.3 : la page sans feuilles de styles ─────────────────────────

const withoutCss = defineCheck(['10.2.1', '10.3.1'], async (ctx, t) => {
  const { base, bare } = await layoutMeasures(ctx)
  const o = t('10.2.1')
  o.applicable()

  // Texte visible avec les styles et plus sans eux (ex. `hidden` neutralisé par un `display` du CSS).
  const present = new Set(bare.texts.map((item) => item.t))
  const reported = new Set<string>()
  for (const item of base.texts) {
    if (present.has(item.t) || reported.has(item.t)) continue
    reported.add(item.t)
    o.fail(`Le texte « ${item.t.slice(0, 80)} » est visible avec les styles et disparaît sans eux.`)
  }

  // Information fournie par le CSS lui-même : contenu généré et images d'arrière-plan.
  const css = await ctx.page.evaluate(cssOnlyInformation)
  for (const item of css.generated) {
    if (item.textual) {
      o.fail(
        `Texte généré par le CSS (${item.pseudo} { content: « ${item.value} » }) : il disparaît sans les styles.`,
        item.ref,
      )
    } else {
      await o.judgePass({
        topic: 'presentation.contenu-genere',
        question: `Ce symbole généré par le CSS (« ${item.value} », ${item.pseudo}) porte-t-il une information qui disparaît sans les styles (non), ou est-il purement décoratif ou redondant (oui) ?`,
        evidence: { contenu: item.value, balise: item.ref.snippet.match(/^<(\w+)/)?.[1] ?? '' },
        ref: item.ref,
      })
    }
  }
  const imageSeen = new Set<string>()
  for (const image of css.images) {
    if (imageSeen.has(image.source)) continue
    imageSeen.add(image.source)
    await o.judgePass({
      topic: 'presentation.image-fond',
      question:
        'Cette image d’arrière-plan (CSS) est-elle décorative, ou son information est-elle aussi donnée par du texte (oui) ? Si elle porte seule une information, elle disparaît sans les styles (non).',
      evidence: { image: image.source },
      ref: image.ref,
      screenshot: ctx.page.locator(image.ref.selector),
    })
  }

  // 10.3.1 : l'ordre sans styles est celui du code ; on cherche où le rendu le contredit.
  const order = t('10.3.1')
  order.applicable()
  for (const item of await ctx.page.evaluate(readingOrder)) {
    await order.judgePass({
      topic: 'presentation.ordre-lecture',
      question: `Sans les styles, ces contenus s’affichent dans l’ordre du code, différent de leur ordre visuel (${item.kinds.join(', ')}). Le contenu reste-t-il compréhensible dans l’ordre du code ?`,
      evidence: { ordre: item.items.join(' › '), cas: item.kinds.join(', ') },
      ref: item.ref,
      screenshot: ctx.page.locator(item.ref.selector),
    })
  }
  order.note(
    'Le contrôle compare l’ordre visuel et l’ordre du code entre éléments frères ; un ordre de code incohérent par lui-même (contenu mal rédigé) relève d’un jugement humain non posé ici.',
  )
})

// ─── 10.5 : feuilles de styles ────────────────────────────────────

/** Rapport CSSOM de la page, feuilles d'une autre origine incluses (récupérées côté outil). */
function stylesheets(ctx: PageContext): Promise<CssReport> {
  return ctx.memo('presentation.css', async () => {
    const first = await ctx.page.evaluate(cssReport, [])
    const hrefs = first.unreadable.filter((name) => /^https?:/.test(name))
    if (hrefs.length === 0) return first
    const extra: { href: string; text: string }[] = []
    for (const href of hrefs) {
      try {
        const response = await ctx.page.request.get(href)
        if (response.ok()) extra.push({ href, text: await response.text() })
      } catch {
        // Feuille injoignable : elle reste signalée comme illisible.
      }
    }
    return extra.length > 0 ? ctx.page.evaluate(cssReport, extra) : first
  })
}

const colors = defineCheck(['10.5.1', '10.5.2', '10.5.3'], async (ctx, t) => {
  const css = await stylesheets(ctx)
  for (const test of ['10.5.1', '10.5.2', '10.5.3'] as const) {
    if (css.sheets > 0) t(test).applicable()
  }
  const wording = {
    '10.5.1': 'Couleur de police déclarée sans couleur de fond (ni sur l’élément ni sur un parent)',
    '10.5.2': 'Couleur de fond déclarée sans couleur de police (ni sur l’élément ni sur un parent)',
    '10.5.3': 'Image de fond déclarée sans couleur de fond (ni sur l’élément ni sur un parent)',
  } as const
  for (const group of css.colors) {
    t(group.test).fail(
      `${wording[group.test]} : règle « ${group.rule} » (${group.count} élément${group.count > 1 ? 's' : ''}).`,
      group.ref,
    )
  }
  for (const test of ['10.5.1', '10.5.2', '10.5.3'] as const) {
    for (const name of css.unreadable) {
      t(test).note(
        `Feuille de styles illisible (origine différente) : ${name}. Ses déclarations n’ont pas été contrôlées.`,
      )
    }
  }
  t('10.5.1').note(
    'Les déclarations conditionnelles (@media non applicable au chargement, mode sombre, @container) et celles posées par script ne sont pas évaluées.',
  )
})

// ─── Mesures partagées par le zoom (10.4), le reflow (10.11) et l'espacement (10.12) ──

/** Ce que la variante a dégradé par rapport à la page de référence. */
function degradation(base: LayoutSnapshot, variant: LayoutSnapshot) {
  const before = new Map(base.items.map((item) => [item.key, item.ratio]))
  const clipped = variant.items.filter((item) => item.ratio < (before.get(item.key) ?? 1) - 0.1)
  const known = new Set(base.overlaps.map((overlap) => overlap.key))
  const overlaps = variant.overlaps.filter((overlap) => !known.has(overlap.key))
  return { clipped, overlaps }
}

/**
 * Ce qu'une ouverture de menu ou de panneau a de rogné ou de chevauché dans son propre
 * contenu (nœuds de texte absents de la page fermée). Avec `reference` (le même état
 * ouvert, sans la modification), seule la dégradation compte ; sans elle, tout rognage
 * du contenu ouvert est relevé. Les chevauchements avec le reste de la page sont
 * voulus (un panneau se superpose à la page) et ne sont pas relevés.
 */
function openDegradation(closed: LayoutSnapshot, open: LayoutSnapshot, reference?: LayoutSnapshot) {
  const closedKeys = new Set(closed.keys)
  const fresh = (key: string) => !closedKeys.has(key)
  const before = new Map((reference?.items ?? closed.items).map((item) => [item.key, item.ratio]))
  const clipped = open.items.filter((item) =>
    reference
      ? item.ratio < (before.get(item.key) ?? 1) - 0.1
      : item.ratio < 0.9 && !before.has(item.key),
  )
  const known = new Set((reference?.overlaps ?? closed.overlaps).map((overlap) => overlap.key))
  const overlaps = open.overlaps.filter(
    (overlap) => !known.has(overlap.key) && overlap.key.split('|').every(fresh),
  )
  return { clipped, overlaps }
}

/** Relève les dégradations de chaque état ouvert (menu, panneau, accordéon). */
function reportOpenStates(
  o: ReturnType<OutcomeFor>,
  context: string,
  closed: LayoutSnapshot,
  states: OpenState[],
  references?: OpenState[],
) {
  for (const state of states) {
    const reference = references?.find((candidate) => candidate.toggler === state.toggler)
    if (references && !reference) continue
    reportDegradation(
      o,
      `${context}, « ${state.label} » ouvert`,
      openDegradation(closed, state.snapshot, reference?.snapshot),
    )
  }
}

function reportDegradation(
  o: ReturnType<OutcomeFor>,
  context: string,
  { clipped, overlaps }: ReturnType<typeof degradation>,
) {
  for (const item of clipped) {
    const lost = Math.round((1 - item.ratio) * 100)
    o.fail(
      item.kind === 'text'
        ? `${context}, le texte « ${item.label} » est rogné (${lost} % de sa surface masquée).`
        : `${context}, le contrôle « ${item.label} » est rogné (${lost} % de sa surface masquée).`,
      item.ref,
    )
  }
  for (const overlap of overlaps) {
    o.fail(`${context}, « ${overlap.a} » et « ${overlap.b} » se chevauchent.`, overlap.ref)
  }
}

/**
 * Pose la question des contenus qui disparaissent à une largeur réduite : sont-ils
 * redondants (même information ailleurs) ou perdus ? Une question par texte, valable
 * pour toutes les pages et pour les tests 10.4.1 et 10.11.1.
 */
async function judgeLost(o: ReturnType<OutcomeFor>, context: string, lost: LostText[]) {
  for (const item of lost) {
    await o.judgePass({
      topic: 'presentation.contenu-masque',
      question: `${context}, ce contenu n’est plus affiché et aucun contrôle ne le rend atteignable. L’information (et le lien) reste-t-elle disponible autrement dans la page ?`,
      evidence: item.href
        ? { texte: item.t.slice(0, 120), lien: item.href }
        : { texte: item.t.slice(0, 120) },
    })
  }
}

type Overflow = Awaited<ReturnType<typeof layoutMeasures>>['narrow']['overflow']

/** Défilement horizontal imposé, hors cas particuliers du RGAA (tableaux de données, médias). */
function reportOverflow(o: ReturnType<OutcomeFor>, context: string, overflow: Overflow) {
  for (const offender of overflow.offenders) {
    if (offender.exception) {
      o.note(
        `Cas particulier admis (${offender.exception}) : « ${offender.text} » dépasse ${context}.`,
      )
      continue
    }
    const lead = `${context[0]?.toUpperCase()}${context.slice(1)}`
    if (offender.scope === 'page' && overflow.docScroll <= 1) {
      // La page ne défile pas : le débordement est masqué (overflow: hidden), le contenu est hors d'atteinte.
      o.fail(
        `${lead}, « ${offender.text} » dépasse de la fenêtre (${offender.excess} px) sans que la page puisse défiler : il est inaccessible.`,
        offender.ref,
      )
      continue
    }
    o.fail(
      `${lead}, « ${offender.text} » impose un défilement horizontal (${offender.excess} px de dépassement${offender.scope === 'container' ? ', dans un bloc' : ''}).`,
      offender.ref,
    )
  }
  if (overflow.docScroll > 1 && !overflow.offenders.some((offender) => offender.scope === 'page')) {
    for (const widest of overflow.widest) {
      o.fail(
        `${context[0]?.toUpperCase()}${context.slice(1)}, la page défile horizontalement (${overflow.docScroll} px) à cause de cet élément.`,
        widest.ref,
      )
    }
  }
}

// ─── 10.4.1 et 10.4.2 : agrandissement du texte à 200 % ─────────────────────

const zoom = defineCheck(['10.4.1', '10.4.2'], async (ctx, t) => {
  // 10.4.2 : le zoom est-il possible ? Une balise meta viewport peut l'interdire.
  const viewport = await ctx.page.evaluate(
    () => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null,
  )
  t('10.4.2').applicable()
  if (viewport !== null) {
    const scalable = /user-scalable\s*=\s*(no|0)\b/i.exec(viewport)
    const maximum = /maximum-scale\s*=\s*([\d.]+)/i.exec(viewport)
    if (scalable) {
      t('10.4.2').fail(`Le zoom est interdit par la balise meta viewport (${scalable[0]}).`)
    }
    if (maximum && Number(maximum[1]) < 2) {
      t('10.4.2').fail(
        `Le zoom est limité à ${maximum[1]} par la balise meta viewport (${maximum[0]}), moins de 200 %.`,
      )
    }
  }
  t('10.4.2').note(
    'Le zoom est simulé en divisant la fenêtre par deux ; une taille de texte qui ignorerait le réglage du navigateur (texte dans une image, <canvas>) n’est pas détectée ici.',
  )

  // 10.4.1 : pas de perte d'information à 200 %.
  const { base, zoom } = await layoutMeasures(ctx)
  const o = t('10.4.1')
  o.applicable()
  reportDegradation(o, 'À 200 %', degradation(base, zoom.snapshot))
  reportOpenStates(o, 'À 200 %', zoom.snapshot, zoom.open)
  reportOverflow(o, 'à 200 %', zoom.overflow)
  await judgeLost(o, 'À 200 %', zoom.lost)
})

// ─── 10.11 : reflow à 320 px ────────────────────────────────────────────────

const reflow = defineCheck(['10.11.1', '10.11.2'], async (ctx, t) => {
  const { base, narrow, vertical } = await layoutMeasures(ctx)
  const o = t('10.11.1')
  o.applicable()
  reportDegradation(o, 'À 320 px', degradation(base, narrow.snapshot))
  reportOpenStates(o, 'À 320 px', narrow.snapshot, narrow.open)
  reportOverflow(o, 'à 320 px', narrow.overflow)
  await judgeLost(o, 'À 320 px', narrow.lost)

  // 10.11.2 : seuls les contenus à lecture verticale (écriture verticale) sont concernés.
  for (const block of vertical.short) {
    t('10.11.2').applicable()
    if (block.bottom > block.viewportHeight + 1) {
      t('10.11.2').fail(
        `À 256 px de hauteur, « ${block.text} » (lecture verticale) impose un défilement vertical.`,
        block.ref,
      )
    }
  }
  if (vertical.present.length > 0 && vertical.short.length === 0) {
    t('10.11.2').applicable()
    t('10.11.2').note('Contenu à lecture verticale présent mais masqué à 256 px de hauteur.')
  }
})

// ─── 10.12 : espacement du texte ────────────────────────────────────────────

const spacing = defineCheck(['10.12.1'], async (ctx, t) => {
  const { base, spacing, spacingOpen, baseOpen } = await layoutMeasures(ctx)
  const o = t('10.12.1')
  o.applicable()
  reportDegradation(o, 'Avec l’espacement du texte augmenté', degradation(base, spacing))
  reportOpenStates(o, 'Avec l’espacement du texte augmenté', spacing, spacingOpen, baseOpen)
})

// ─── 10.6 : liens signalés par la couleur ───────────────────────────────────

/** Parcours d'interaction (tabulation, survol), partagé par 10.6, 10.7, 10.13 et 10.14. */
function interactions(ctx: PageContext): Promise<ScanResult> {
  return ctx.memo('presentation.scan', async () => {
    // Contrôles qui disent révéler un contenu masqué (aria-controls) : essayés au clavier à la fin du parcours.
    const report = await ctx.page.evaluate(hiddenContent)
    const controls = report.hidden.flatMap((item) =>
      item.controllers.map((controller) => ({ controller, target: item.ref.selector })),
    )
    return scanInteractions(ctx, controls)
  })
}

/** Propriétés dont le changement marque un état autrement que par la couleur. */
const NON_COLOR = [
  'textDecorationLine',
  'fontWeight',
  'fontStyle',
  'borderTopWidth',
  'borderBottomWidth',
  'borderTopStyle',
  'borderBottomStyle',
  'backgroundImage',
  'boxShadow',
  'transform',
] as const

function visualChange(
  before: Record<string, string>,
  after: Record<string, string>,
): string | null {
  for (const prop of NON_COLOR) {
    if (before[prop] !== after[prop]) return `${prop} ${before[prop]} → ${after[prop]}`
  }
  // Un fond qui apparaît ou disparaît (pas une simple nuance).
  if (before.backgroundColor !== after.backgroundColor) {
    const clear = (value: string | undefined) =>
      !value || /rgba\(.*,\s*0\)$|transparent/.test(value)
    if (clear(before.backgroundColor) !== clear(after.backgroundColor)) return 'backgroundColor'
  }
  return null
}

const links = defineCheck(['10.6.1'], async (ctx, t) => {
  const inline = await ctx.page.evaluate(inlineLinks)
  const candidates = inline.filter((link) => link.indicators.length === 0)
  if (candidates.length === 0) return
  const o = t('10.6.1')
  const scan = await interactions(ctx)
  const page = scan.page
  // Un même rendu (couleurs, classes) n'est essayé qu'une fois.
  const seen = new Set<string>()
  for (const link of candidates) {
    const klass = /class="([^"]*)"/.exec(link.ref.snippet)?.[1] ?? ''
    const signature = `${link.linkColor}|${link.textColor}|${klass}`
    if (seen.has(signature)) {
      o.applicable()
      continue
    }
    seen.add(signature)
    if (seen.size > 15) {
      o.note(
        'Plus de 15 rendus de liens distincts : seuls les 15 premiers sont essayés au survol et au focus.',
      )
      o.applicable()
      continue
    }
    const where = `« ${link.text} » (dans « ${link.around.slice(0, 40)}… »)`
    o.applicable()
    if (link.contrast < 3) {
      o.fail(
        `Le lien ${where} n’est signalé que par la couleur, avec un contraste de ${link.contrast}:1 avec le texte environnant (3:1 requis).`,
        link.ref,
      )
    }
    // Survol : une indication autre que la couleur ?
    await page.mouse.move(0, 0)
    const target = await page.evaluate(
      (s) => window.__probe?.prepareSelector(s) ?? null,
      link.ref.selector,
    )
    if (!target) {
      o.note(`Lien introuvable pour l’essai au survol : ${link.ref.selector}`)
      continue
    }
    await page.mouse.move(target.x, target.y)
    await page.waitForTimeout(80)
    const hovered = await page.evaluate(
      (s) => window.__probe?.digestOf(s) ?? null,
      link.ref.selector,
    )
    await page.mouse.move(0, 0)
    if (hovered && !visualChange(target.digest, hovered)) {
      o.fail(
        `Le lien ${where} n’a pas d’indication visuelle au survol autre qu’un changement de couleur.`,
        link.ref,
      )
    }
    // Focus : outline natif ou autre indication.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const unfocused = await page.evaluate(
      (s) => window.__probe?.digestOf(s) ?? null,
      link.ref.selector,
    )
    await page.evaluate((s) => window.__probe?.refocus(s), link.ref.selector)
    const focused = await page.evaluate(
      (s) => window.__probe?.digestOf(s) ?? null,
      link.ref.selector,
    )
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    if (focused && unfocused) {
      const ring =
        focused.outlineStyle !== 'none' && Number.parseFloat(focused.outlineWidth ?? '0') > 0
      if (!ring && !visualChange(unfocused, focused)) {
        o.fail(
          `Le lien ${where} n’a pas d’indication visuelle au focus autre qu’un changement de couleur.`,
          link.ref,
        )
      }
    }
  }
  o.note(
    'Seuls les liens placés dans du texte courant sont contrôlés ; les liens de navigation, de menu ou formant leur propre bloc sont d’une nature évidente.',
  )
})

// ─── 10.8 : contenus cachés ─────────────────────────────────────────────────

const hidden = defineCheck(['10.8.1'], async (ctx, t) => {
  const report = await ctx.page.evaluate(hiddenContent)
  const o = t('10.8.1')

  // Contenu visible mais retiré de l'arbre d'accessibilité.
  const aria = new Set<string>()
  for (const item of report.ariaHiddenVisible) {
    o.applicable()
    if (item.focusable) {
      o.fail(
        'Du contenu atteignable au clavier est visible mais retiré de l’arbre d’accessibilité (aria-hidden="true").',
        item.ref,
      )
      continue
    }
    // Même texte (ou initiales) donné à côté aux technologies d'assistance : redondant, rien n'est perdu.
    if (item.redundant) continue
    const key = `${item.tag}|${item.text}`
    if (aria.has(key)) continue
    aria.add(key)
    await o.judgePass({
      topic: 'presentation.aria-hidden-visible',
      question: `Ce texte visible est masqué aux technologies d’assistance (aria-hidden="true"). Est-il redondant ou décoratif, donc sans information à restituer (oui) ? S’il porte une information utile, elle est perdue pour elles (non).`,
      evidence: { texte: item.text, balise: item.tag },
      ref: item.ref,
      screenshot: ctx.page.locator(item.ref.selector),
    })
  }

  // Contenu masqué : à ignorer, restitué par une action, ou déjà utile aux technologies d'assistance.
  const USED = ['labelledby', 'describedby', 'for', 'errormessage', 'details', 'owns', 'list']
  const { narrow } = await layoutMeasures(ctx)
  const visibleNarrow = new Set(narrow.snapshot.texts.map((text) => text.t))
  const unresolved: typeof report.hidden = []
  for (const item of report.hidden) {
    o.applicable()
    // Contrôle aria-controls : essayé au clavier par le parcours d'interaction (même référencé par aria-labelledby).
    if (item.controllers.length > 0) continue
    if (item.referencedBy.some((kind) => USED.includes(kind))) continue
    if (item.native === 'details') continue
    // Variante responsive : le même texte est affiché à une autre largeur.
    if (item.nodes.some((text) => visibleNarrow.has(text))) {
      o.note(
        `« ${item.text.slice(0, 40)} » est masqué à cette largeur et affiché à 320 px (variante responsive).`,
      )
      continue
    }
    unresolved.push(item)
  }
  for (const result of (await interactions(ctx)).activations) {
    const item = report.hidden.find((entry) => entry.ref.selector === result.target)
    if (result.controllerHidden) {
      o.note(
        `Le contrôle ${result.controller} est masqué à cette largeur : le contenu qu’il révèle n’a pas été essayé.`,
      )
    } else if (!result.revealed) {
      o.fail(
        `Le contenu masqué n’est pas révélé par une action au clavier (Entrée, Espace) sur le contrôle qui le référence (aria-controls).`,
        item?.ref,
      )
    } else if (result.stillHidden) {
      o.fail(
        'Le contenu est affiché à l’écran mais reste retiré de l’arbre d’accessibilité (aria-hidden ou inert).',
        item?.ref,
      )
    }
  }
  const seenHidden = new Set<string>()
  for (const item of unresolved) {
    const key = `${item.tag}|${item.text}`
    if (seenHidden.has(key)) continue
    seenHidden.add(key)
    await o.judgePass({
      topic: 'presentation.contenu-cache',
      question: `Ce contenu est masqué (${item.how}), sans contrôle ni référence qui le rende accessible. A-t-il vocation à être ignoré des technologies d’assistance (oui) ? Sinon, il devrait pouvoir être restitué par une action (non).`,
      evidence: { texte: item.text, balise: item.tag },
      ref: item.ref,
    })
  }
  o.note(
    'Le contenu masqué par le CSS qui reste lu par les lecteurs d’écran (texte réservé, « sr-only ») n’est pas concerné. Les menus ouverts au clic sans aria-controls ne sont pas reliés à leur contrôle.',
  )
})

// ─── 10.9 et 10.10 : information donnée par la forme, la taille ou la position ──

const SHAPE_ANSWERS = ['pass', 'alternative', 'alternative-insuffisante', 'fail']
const SHAPE_TESTS = {
  texte: ['10.9.1', '10.10.1'],
  image: ['10.9.2', '10.10.2'],
  'média temporel': ['10.9.3', '10.10.3'],
  'média non temporel': ['10.9.4', '10.10.4'],
} as const

const shape = defineCheck(
  ['10.9.1', '10.9.2', '10.9.3', '10.9.4', '10.10.1', '10.10.2', '10.10.3', '10.10.4'],
  async (ctx, t) => {
    const seen = new Set<string>()
    for (const candidate of await ctx.page.evaluate(shapeCandidates)) {
      const key = `${candidate.kind}|${JSON.stringify(candidate.evidence)}`
      if (seen.has(key)) continue
      seen.add(key)
      const [only, relevant] = SHAPE_TESTS[candidate.kind]
      const request = {
        topic: `presentation.forme.${candidate.kind.replace(/\s+/g, '-')}`,
        question: `Cette indication (${candidate.reason}) est-elle donnée uniquement par la forme, la taille ou la position ? Répondre « pass » si elle ne l’est pas (autre moyen ou pas d’indication), « alternative » si une alternative pertinente existe, « alternative-insuffisante » si l’alternative n’est pas pertinente, « fail » si l’information n’est donnée que visuellement.`,
        evidence: candidate.evidence,
        answers: SHAPE_ANSWERS,
        ref: candidate.ref,
        screenshot: ctx.page.locator(candidate.ref.selector),
      }
      const answer = await t(only).judge(request)
      if (answer === undefined) {
        // La question conditionne aussi la pertinence de l'alternative.
        await t(relevant).judge({ ...request, screenshot: undefined })
      } else if (answer === 'fail') {
        t(only).fail(
          `L’information n’est donnée que par la forme, la taille ou la position (${candidate.reason}).`,
          candidate.ref,
        )
      } else if (answer === 'alternative') {
        t(relevant).applicable()
      } else if (answer === 'alternative-insuffisante') {
        t(relevant).fail(
          `L’alternative à l’indication visuelle (${candidate.reason}) n’est pas pertinente.`,
          candidate.ref,
        )
      }
    }
  },
)

// ─── 10.13 et 10.14 : contenus additionnels au survol ou au focus ───────────

const additional = defineCheck(
  ['10.13.1', '10.13.2', '10.13.3', '10.14.1', '10.14.2'],
  async (ctx, t) => {
    const scan = await interactions(ctx)
    const results = await deepReveals(ctx, revealCases(scan), scan)
    for (const result of results) {
      const how = result.kind === 'hover' ? 'au survol' : 'au focus'
      const subject = `Le contenu « ${result.text.slice(0, 50) || result.root.selector} » qui apparaît ${how} de « ${result.trigger.selector.split(' > ').slice(-2).join(' > ')} »`
      if (!result.reproduced) {
        t('10.13.3').note(
          `Contenu additionnel signalé ${how} non reproduit à l’essai : ${result.root.selector}`,
        )
        continue
      }
      if (result.obscures) {
        t('10.13.1').applicable()
        if (result.dismissible === false) {
          t('10.13.1').fail(
            `${subject} recouvre d’autres contenus et ne peut pas être masqué sans déplacer le focus ou le pointeur (touche Échap sans effet).`,
            result.root,
          )
        }
      }
      if (result.kind === 'hover' && !result.inside) {
        t('10.13.2').applicable()
        if (result.hoverable === false) {
          t('10.13.2').fail(
            `${subject} disparaît quand le pointeur passe du déclencheur au contenu.`,
            result.root,
          )
        }
      }
      t('10.13.3').applicable()
      if (result.persistent === false) {
        t('10.13.3').fail(
          `${subject} disparaît seul alors que le pointeur ou le focus n’a pas bougé.`,
          result.root,
        )
      }
      if (!result.mutated) {
        const test = result.kind === 'hover' ? '10.14.1' : '10.14.2'
        t(test).applicable()
        if (result.equivalent === false) {
          t(test).fail(
            result.kind === 'hover'
              ? `${subject} n’apparaît que par le CSS au survol : ni la prise de focus, ni l’activation au clavier ne le fait apparaître.`
              : `${subject} n’apparaît que par le CSS au focus : il n’apparaît pas au survol (ni du déclencheur, ni d’un autre composant).`,
            result.root,
          )
        }
      } else {
        t('10.14.1').note(
          'Des contenus additionnels apparaissent par script (hors 10.14, qui vise le CSS seul) : ils relèvent des tests de la thématique 7.',
        )
      }
    }
    if (scan.hover.length === 0)
      t('10.13.3').note('Aucun élément survolable atteint : contrôle de survol incomplet.')
    t('10.13.3').note(
      'Détection par le rendu : contenus qui apparaissent au survol ou au focus de contrôles atteignables à la tabulation et de leurs conteneurs ; un déclencheur sans lien visible avec le contenu (zone neutre) peut échapper au contrôle.',
    )
  },
)

// ─── 10.7 : focus visible ───────────────────────────────────────────────────

const focus = defineCheck(['10.7.1'], async (ctx, t) => {
  const o = t('10.7.1')
  const scan = await interactions(ctx)
  try {
    const total = await ctx.page.evaluate(() => window.__rgaa.tabbables().length)
    for (const record of scan.focus) {
      o.applicable()
      const label = `« ${record.name || record.tag} » (<${record.tag}>)`
      if (record.verdict === 'invisible') {
        o.fail(`Le focus n’est pas visible sur ${label} : ${record.detail}.`, record.ref)
      } else if (record.verdict === 'weak') {
        // Les changements de rendu faibles (contraste < 3:1) se jugent sur la capture, une fois par rendu.
        await scan.page.evaluate((s) => window.__probe?.refocus(s), record.ref.selector)
        await o.judgePass({
          topic: 'presentation.focus-faible',
          question: `Le focus est peu contrasté (${record.detail}). Reste-t-il visible, avec un contraste suffisant, pour l’élément focalisé (oui) ?`,
          evidence: { rendu: record.summary, balise: record.tag },
          ref: record.ref,
          screenshot: scan.page.locator(record.ref.selector),
        })
      }
    }
    if (scan.tabbed < total) {
      o.note(
        `${scan.tabbed} contrôles mesurés sur ${total} atteignables à la tabulation (les autres sont masqués après action ou hors parcours).`,
      )
    }
    const unmeasured = scan.focus.filter((record) => record.verdict === 'unmeasured')
    if (unmeasured.length > 0) {
      // Jamais de verdict sur une mesure qui n'a pas eu lieu : erreur de l'outil.
      throw new Error(
        `${unmeasured.length} contrôle(s) dont le focus n’a pas pu être mesuré : ${unmeasured[0]?.detail}`,
      )
    }
    for (const note of scan.notes) o.note(note)
    o.note(
      'Le focus est mesuré par captures avant/après sur chaque rendu distinct. Les éléments qui ne reçoivent le focus que par script (cibles de lien d’évitement, tabindex="-1") ne sont pas mesurés.',
    )
  } finally {
    await scan.page
      .context()
      .close()
      .catch(() => {})
  }
})

export const checks: Check[] = [
  markup,
  withoutCss,
  colors,
  zoom,
  reflow,
  spacing,
  links,
  hidden,
  shape,
  additional,
  focus,
]
