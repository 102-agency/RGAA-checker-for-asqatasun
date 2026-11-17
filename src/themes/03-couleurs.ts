import type { Page } from 'playwright'
import { type Check, defineCheck, type PageContext } from '../core/types.ts'
import type { RgbaTuple } from '../lib/couleurs-inpage.ts'
import {
  CouleursSession,
  type FieldResult,
  type Mesures,
  ratioText,
  type Statics,
  type TextResult,
} from '../lib/couleurs-mesure.ts'
import { contrast, hex } from '../lib/couleurs-pixels.ts'

/**
 * Thématique 3 — Couleurs.
 *
 * - 3.2 : contraste du texte, mesuré sur les pixels réellement peints derrière
 *   chaque texte (voir `lib/couleurs-mesure.ts`), au repos, au survol, au focus,
 *   dans les panneaux fermés et les erreurs de formulaire, et en mode sombre si le
 *   site y réagit.
 * - 3.3 : contraste des composants d'interface (contour des champs, indicateur de
 *   focus) et des éléments graphiques (icônes seules, graphiques nommés).
 * - 3.1 : information donnée par la couleur seule. Ciblé : liens d'un bloc de texte,
 *   mots mis en couleur, indications de couleur, états signalés par la couleur seule,
 *   puis jugement pour ce qui ne se décide pas mécaniquement (images, médias).
 */

interface Context {
  session: CouleursSession
  mesures: Mesures
  statics: Statics
}

/** Budget de l'exploration des états (survol, focus, panneaux, erreurs) par page. */
const STATES_BUDGET_MS = 60_000

async function startSession(
  ctx: PageContext,
  options: { dark: boolean; states: boolean },
): Promise<Context> {
  const page: Page = await ctx.fresh(options.dark ? { colorScheme: 'dark' } : {})
  const session = new CouleursSession(page)
  await session.install()
  const statics = await session.statics()
  await session.run({ states: options.states, budgetMs: STATES_BUDGET_MS }, ctx.url)
  return { session, mesures: session.result(), statics }
}

const light = (ctx: PageContext): Promise<Context> =>
  ctx.memo('couleurs.clair', () => startSession(ctx, { dark: false, states: true }))

/** Rendu sombre, seulement si les feuilles de style réagissent à `prefers-color-scheme`. */
const dark = (ctx: PageContext): Promise<Context | null> =>
  ctx.memo('couleurs.sombre', async () => {
    const base = await light(ctx)
    if (!base.statics.darkReact) return null
    return startSession(ctx, { dark: true, states: false })
  })

// ─── 3.2 : contraste du texte ───────────────────────────────────────────────

type TextTest = '3.2.1' | '3.2.2' | '3.2.3' | '3.2.4'

/**
 * Seuils du RGAA 4 : 4,5:1 sauf pour le texte de grande taille (3:1), soit au moins
 * 24 px sans effet de graisse ou 18,5 px en gras (graisse 700 et plus : une graisse
 * intermédiaire, 500 ou 600, n'est pas « en gras »).
 */
export function classifyText(size: number, weight: number): { test: TextTest; threshold: number } {
  const bold = weight >= 700
  const large = bold ? size >= 18.5 : size >= 24
  const test: TextTest = bold ? (large ? '3.2.4' : '3.2.2') : large ? '3.2.3' : '3.2.1'
  return { test, threshold: large ? 3 : 4.5 }
}

const opaque = (color: RgbaTuple): [number, number, number] => [color[0], color[1], color[2]]

function textMessage(result: TextResult, threshold: number, mode: string): string {
  const { desc } = result
  const what =
    desc.kind === 'placeholder'
      ? `Texte indicatif du champ « ${desc.text} »`
      : desc.kind === 'valeur'
        ? 'Texte saisi dans le champ'
        : `Texte « ${desc.text.slice(0, 60)} »`
  const weight = result.weight >= 700 ? 'gras' : 'normal'
  const size = String(result.size).replace('.', ',')
  const expected = String(threshold).replace('.', ',')
  const where = [result.state === 'repos' ? '' : result.state, mode].filter(Boolean).join(', ')
  const flat = result.backgrounds > 1 ? ' (fond non uni : pire zone significative)' : ''
  return `${what} (${size} px, ${weight}) : contraste de ${ratioText(result.ratio)} au lieu de ${expected}:1, texte ${hex(result.foreground)} sur fond ${hex(result.background)}${flat}${where ? ` — ${where}` : ''}.`
}

interface TextFailure {
  test: TextTest
  message: string
  ref?: { selector: string; snippet: string }
}

const texts = defineCheck(['3.2.1', '3.2.2', '3.2.3', '3.2.4', '3.2.5'], async (ctx, t) => {
  const base = await light(ctx)
  const night = await dark(ctx)
  const failures: TextFailure[] = []

  const analyse = async (context: Context, mode: string) => {
    const seen = new Set<string>()
    for (const result of context.mesures.texts) {
      const { desc } = result
      // Cas particulier : composant inactif (bouton `disabled`…), hors du champ du critère.
      if (desc.disabled) continue
      const { test, threshold } = classifyText(result.size, result.weight)
      const key = `${mode}|${desc.id}|${result.state.split(' ')[0]}|${result.ratio.toFixed(1)}`
      if (seen.has(key)) continue
      seen.add(key)
      const outcome = t(test)
      outcome.applicable()

      const ref = await context.session.refFor(desc.id)
      // Texte peint par un dégradé ou une image (`background-clip: text`) : le fond mesuré serait le texte lui-même.
      if (desc.clipText) {
        await outcome.judgePass({
          topic: 'couleurs.texte-degrade',
          question:
            'Ce texte est peint par un dégradé ou une image (background-clip: text). Son contraste avec l’arrière-plan est-il suffisant (4,5:1, ou 3:1 pour un texte de grande taille) ?',
          evidence: { texte: desc.text.slice(0, 80), taille: `${result.size}px` },
          ref,
        })
        continue
      }
      if (result.ratio + 1e-9 >= threshold) continue

      const colors = `${hex(result.foreground)} sur ${hex(result.background)}`
      const message = textMessage(result, threshold, mode)
      // Signaux d'un cas particulier : on pose la question plutôt que de conclure.
      const signal = desc.logo
        ? 'logo'
        : desc.decorative
          ? 'décoratif'
          : desc.shadow
            ? 'ombre'
            : null
      if (signal === 'ombre') {
        const answer = await outcome.judge({
          topic: 'couleurs.texte-ombre',
          question: `Ce texte porte une ombre (text-shadow) et mesure ${ratioText(result.ratio)} sans elle. Reste-t-il suffisamment contrasté ombre comprise (${threshold}:1 attendus) ?`,
          answers: ['lisible', 'illisible'],
          evidence: { texte: desc.text.slice(0, 80), couleurs: colors, taille: `${result.size}px` },
          ref,
        })
        if (answer === 'illisible') failures.push({ test, message, ref })
        continue
      }
      if (signal) {
        const answer = await outcome.judge({
          topic: 'couleurs.texte-exempte',
          question: `Ce texte mesure ${ratioText(result.ratio)} pour ${threshold}:1 attendus. Relève-t-il d’un cas particulier du RGAA (${
            signal === 'logo'
              ? 'texte faisant partie d’un logo ou d’un nom de marque'
              : 'texte purement décoratif, masqué aux technologies d’assistance'
          }) ?`,
          answers: ['exempte', 'non-exempte'],
          evidence: { texte: desc.text.slice(0, 80), couleurs: colors, signal },
          ref,
        })
        if (answer === 'non-exempte') failures.push({ test, message, ref })
        continue
      }
      failures.push({ test, message, ref })
    }
  }

  await analyse(base, '')
  if (night) await analyse(night, 'mode sombre')

  // « Un mécanisme permet d'afficher le texte avec un contraste suffisant » : seule issue d'un texte en échec.
  const mechanisms = base.statics.mechanisms
  if (failures.length > 0 && mechanisms.length > 0) {
    const names = mechanisms
      .map((m) => m.name)
      .sort()
      .join(' | ')
    const failedTests = Array.from(new Set(failures.map((f) => f.test)))
    for (const test of failedTests) {
      const answer = await t(test).judge({
        topic: 'couleurs.mecanisme',
        question:
          'Des textes ont un contraste insuffisant. Une de ces commandes permet-elle d’afficher la page avec un contraste suffisant (4,5:1, ou 3:1 pour le grand texte) sans perdre de contenu ni de fonction ?',
        answers: ['mecanisme-valide', 'aucun-mecanisme'],
        evidence: { commandes: names },
        ref: mechanisms[0]?.ref,
      })
      if (answer === 'aucun-mecanisme') {
        for (const failure of failures.filter((f) => f.test === test)) {
          t(test).fail(failure.message, failure.ref)
        }
      }
      if (answer === 'mecanisme-valide') {
        // 3.2.5 : le contraste du texte dans le mécanisme lui-même.
        await t('3.2.5').judgePass({
          topic: 'couleurs.mecanisme-contraste',
          question:
            'Dans le mode d’affichage proposé par ces commandes, le rapport de contraste entre le texte et son arrière-plan est-il suffisamment élevé ?',
          evidence: { commandes: names },
          ref: mechanisms[0]?.ref,
        })
      }
    }
  } else {
    for (const failure of failures) t(failure.test).fail(failure.message, failure.ref)
  }

  // Limites connues du contrôle, portées par chaque test concerné.
  const unmeasured = base.mesures.unmeasured.filter((u) => u.kind === 'texte')
  for (const test of ['3.2.1', '3.2.2', '3.2.3', '3.2.4'] as const) {
    t(test).note(
      'Le contraste est mesuré sur les pixels peints derrière le texte (pire zone significative, 3 % de pixels écartés). Ne sont pas mesurés : le texte inclus dans une image, les ombres et filtres CSS, les modes de fusion.',
    )
    if (base.statics.pseudoText > 0) {
      t(test).note(
        `${base.statics.pseudoText} texte(s) généré(s) par CSS (::before / ::after) ne sont pas mesurés.`,
      )
    }
    if (base.statics.shadowHosts > 0) {
      t(test).note(
        `${base.statics.shadowHosts} composant(s) à Shadow DOM : leur texte n’est pas inventorié.`,
      )
    }
    if (base.statics.media.some((m) => m.kind === 'iframe')) {
      t(test).note('Le texte des cadres (iframe) n’est pas mesuré : il relève de leur propre page.')
    }
    t(test).note(
      'Seule la présentation en 1280 px de large est auditée ; le texte masqué par un conteneur défilant (carrousel) n’est pas mesuré tant qu’il n’est pas visible.',
    )
    if (!base.statics.darkReact) {
      t(test).note(
        'Aucune feuille de style ne réagit à prefers-color-scheme : seul le rendu clair est audité.',
      )
    }
    if (base.statics.disabled > 0) {
      t(test).note(
        'Les textes de composants inactifs (disabled, aria-disabled) sont exemptés, conformément aux cas particuliers du RGAA.',
      )
    }
    if (unmeasured.length > 0) {
      t(test).note(
        `${unmeasured.length} texte(s) visible(s) n’ont pas pu être mesurés (recouverts ou hors cadre) : ${unmeasured
          .slice(0, 3)
          .map((u) => `« ${u.text.slice(0, 30)} » (${u.reason})`)
          .join(', ')}.`,
      )
    }
  }
  for (const note of [...base.mesures.notes, ...(night?.mesures.notes ?? [])]) {
    for (const test of ['3.2.1', '3.2.2', '3.2.3', '3.2.4'] as const) t(test).note(note)
  }
})

// ─── 3.3 : composants d'interface et éléments graphiques ────────────────────

const components = defineCheck(['3.3.1', '3.3.2', '3.3.3', '3.3.4'], async (ctx, t) => {
  const base = await light(ctx)
  const night = await dark(ctx)
  const failures: {
    test: '3.3.1' | '3.3.2' | '3.3.3'
    message: string
    ref?: { selector: string; snippet: string }
  }[] = []

  const analyse = async (context: Context, mode: string) => {
    const suffix = mode ? ` — ${mode}` : ''
    // Contour (ou fond) des champs et des cases personnalisées contre le fond contigu.
    const seenFields = new Set<string>()
    const fields: FieldResult[] = context.mesures.fields
    for (const field of fields) {
      const fieldKey = `${field.desc.id}|${field.state.split(' ')[0]}`
      if (seenFields.has(fieldKey)) continue
      seenFields.add(fieldKey)
      t('3.3.1').applicable()
      if (field.ratio + 1e-9 < 3) {
        const what = field.desc.kind === 'case' ? 'La case' : 'Le champ'
        failures.push({
          test: '3.3.1',
          message: `${what} « ${field.desc.label || field.desc.tag} » n’est repérable que par ${
            field.source === 'aucun' ? 'rien (ni contour ni fond distinct)' : `son ${field.source}`
          } à ${ratioText(field.ratio)} du fond contigu${
            field.adjacent ? ` ${hex(field.adjacent)}` : ''
          } (3:1 attendus)${field.state === 'repos' ? '' : ` — ${field.state}`}${suffix}.`,
          ref: await context.session.refFor(field.desc.id),
        })
      }
    }

    // Indicateur de focus personnalisé : contraste avec le fond contigu.
    const seenFocus = new Set<string>()
    for (const focus of context.mesures.focus) {
      if (seenFocus.has(focus.info.ref.selector)) continue
      seenFocus.add(focus.info.ref.selector)
      t('3.3.1').applicable()
      if (focus.ratio + 1e-9 < 3) {
        failures.push({
          test: '3.3.1',
          message: `L’indicateur de focus (${focus.indicator}) de <${focus.info.tag}> n’a que ${ratioText(focus.ratio)} de contraste avec le fond contigu (3:1 attendus)${suffix}.`,
          ref: focus.info.ref,
        })
      }
    }

    // Icônes seules et graphiques nommés.
    for (const icon of context.mesures.icons) {
      if (icon.complex) {
        const request = {
          topic: 'couleurs.graphique',
          question:
            'Ce graphique utilise un dégradé, un motif ou un <use> que l’outil ne sait pas mesurer. Les couleurs nécessaires à sa compréhension sont-elles contrastées (3:1 avec le fond contigu et entre elles) ?',
          evidence: { graphique: icon.desc.name, formes: String(icon.desc.shapes) },
          ref: await context.session.refFor(icon.desc.id),
        }
        await t('3.3.2').judgePass(request)
        await t('3.3.3').judgePass(request)
        continue
      }
      if (!icon.measured) continue
      t('3.3.2').applicable()
      if (icon.desc.paints.length > 1) t('3.3.3').applicable()
      for (const failure of icon.failures) {
        failures.push({
          test: failure.test,
          message: `Graphique « ${icon.desc.name || 'icône'} » : ${failure.message}${suffix}`,
          ref: await context.session.refFor(icon.desc.id),
        })
      }
    }
  }
  await analyse(base, '')
  if (night) await analyse(night, 'mode sombre')

  // Commandes sans libellé visible dont l'icône est en CSS ou en police : non mesurable, on la juge une fois.
  for (const control of base.statics.iconControls) {
    await t('3.3.2').judgePass({
      topic: 'couleurs.icone-css',
      question:
        'Cette commande n’a pas de libellé visible : son icône (image de fond CSS ou police d’icônes) est-elle contrastée au moins à 3:1 avec le fond contigu ?',
      evidence: { commande: control.name },
      ref: control.ref,
    })
  }

  const mechanisms = base.statics.mechanisms
  if (failures.length > 0 && mechanisms.length > 0) {
    const names = mechanisms
      .map((m) => m.name)
      .sort()
      .join(' | ')
    for (const test of Array.from(new Set(failures.map((f) => f.test)))) {
      const answer = await t(test).judge({
        topic: 'couleurs.mecanisme-composants',
        question:
          'Des composants ou graphiques ont un contraste insuffisant. Une de ces commandes permet-elle de les afficher avec un contraste d’au moins 3:1 ?',
        answers: ['mecanisme-valide', 'aucun-mecanisme'],
        evidence: { commandes: names },
        ref: mechanisms[0]?.ref,
      })
      if (answer === 'aucun-mecanisme') {
        for (const failure of failures.filter((f) => f.test === test))
          t(test).fail(failure.message, failure.ref)
      }
      if (answer === 'mecanisme-valide') {
        await t('3.3.4').judgePass({
          topic: 'couleurs.mecanisme-composants-contraste',
          question:
            'Dans le mode d’affichage proposé par ces commandes, les couleurs des composants et des éléments graphiques porteurs d’information sont-elles suffisamment contrastées ?',
          evidence: { commandes: names },
          ref: mechanisms[0]?.ref,
        })
      }
    }
  } else {
    for (const failure of failures) t(failure.test).fail(failure.message, failure.ref)
  }

  const unmeasured = base.mesures.unmeasured.filter((u) => u.kind !== 'texte')
  t('3.3.1').note(
    'Mesuré : contour ou fond des champs, des cases personnalisées et des listes contre le fond contigu ; indicateur de focus personnalisé (contour, halo). Exemptés par le RGAA : composants inactifs, apparence native du navigateur, composants identifiés par un libellé visible (boutons, liens). Non mesurés : les états coché et survolé des cases personnalisées.',
  )
  t('3.3.2').note(
    'Mesuré : couleurs de remplissage et de trait des icônes seules (sans libellé visible) et des graphiques SVG nommés, contre le fond contigu. Le contenu des images matricielles est soumis à jugement (voir 3.1.3).',
  )
  if (unmeasured.length > 0) {
    t('3.3.1').note(
      `${unmeasured.length} composant(s) n’ont pas pu être mesurés : ${unmeasured
        .slice(0, 3)
        .map((u) => `${u.kind} « ${u.text.slice(0, 30)} » (${u.reason})`)
        .join(', ')}.`,
    )
  }
  for (const note of base.mesures.notes) t('3.3.1').note(note)
})

// ─── Images et graphiques : texte en image, couleur seule, contraste ─────────

const images = defineCheck(['3.1.3', '3.2.1', '3.3.2', '3.3.3'], async (ctx, t) => {
  const { mesures } = await light(ctx)
  for (const image of mesures.images) {
    if (image.desc.logo) continue // Logo ou nom de marque : hors du champ des critères.
    // Photographie : couleurs et contrastes essentiels à l'information, exemptés par le RGAA.
    if (image.photo) continue
    const request = {
      topic: 'couleurs.image',
      question:
        'Cette image informative contient-elle un texte au contraste insuffisant (4,5:1, ou 3:1 pour le grand texte), une information donnée par la seule couleur, ou des couleurs nécessaires à sa compréhension trop peu contrastées avec le fond (3:1) ? Répondre « conforme » si aucun de ces défauts, ou si l’image est une photographie ou un logo.',
      answers: ['conforme', 'texte-contraste', 'couleur-seule', 'graphique-contraste'],
      evidence: { source: image.desc.source, alternative: image.desc.name },
      ref: await ctxRef(ctx, image.desc.id),
      screenshot: await imageLocator(ctx, image.desc.id),
    }
    // Une même question, posée sur chaque test qu'elle peut mettre en échec : elle les laisse tous « à valider ».
    const answer = await t('3.1.3').judge(request)
    await t('3.2.1').judge(request)
    await t('3.3.2').judge(request)
    if (answer === 'texte-contraste') {
      t('3.2.1').fail(
        `L’image « ${image.desc.name} » contient un texte au contraste insuffisant (décision enregistrée).`,
        request.ref,
      )
    } else if (answer === 'couleur-seule') {
      t('3.1.3').fail(
        `L’image « ${image.desc.name} » donne une information par la seule couleur (décision enregistrée).`,
        request.ref,
      )
    } else if (answer === 'graphique-contraste') {
      t('3.3.2').fail(
        `Les couleurs nécessaires à la compréhension de l’image « ${image.desc.name} » sont trop peu contrastées (décision enregistrée).`,
        request.ref,
      )
    }
  }
  t('3.1.3').note(
    'Les photographies (images à nombreuses teintes) ne sont pas soumises à jugement : un texte incrusté dans une photo n’est pas repéré automatiquement.',
  )
})

async function imageLocator(ctx: PageContext, id: number) {
  const { session } = await light(ctx)
  const ref = await session.refFor(id)
  return ref ? session.page.locator(ref.selector).first() : undefined
}

async function ctxRef(
  ctx: PageContext,
  id: number,
): Promise<{ selector: string; snippet: string } | undefined> {
  return (await light(ctx)).session.refFor(id)
}

// ─── 3.1 : information donnée par la couleur ────────────────────────────────

const colorInformation = defineCheck(
  ['3.1.1', '3.1.2', '3.1.3', '3.1.4', '3.1.5', '3.1.6'],
  async (ctx, t) => {
    const { session, statics, mesures } = await light(ctx)

    // 3.1.1 — liens d'un bloc de texte : la couleur ne doit pas être leur seul signe distinctif.
    const colorOnly = statics.linkCues.filter((link) => !link.cue)
    const states = colorOnly.length > 0 ? await session.linkStates() : { hover: [], focus: [] }
    let colorOnlyIndex = 0
    for (const link of statics.linkCues) {
      t('3.1.1').applicable()
      if (link.cue) continue
      const index = colorOnlyIndex++
      const ratio = contrast(opaque(link.linkColor), opaque(link.textColor))
      if (ratio < 3) {
        t('3.1.1').fail(
          `Le lien « ${link.text} » ne se distingue du texte qui l’entoure que par sa couleur (contraste de ${ratioText(ratio)} entre les deux, 3:1 au moins attendus), sans soulignement ni autre repère.`,
          link.ref,
        )
      } else if (index < states.hover.length && !(states.hover[index] && states.focus[index])) {
        t('3.1.1').fail(
          `Le lien « ${link.text} » ne se distingue du texte qui l’entoure que par sa couleur : aucun repère non coloré n’apparaît ${
            states.hover[index]
              ? 'au focus'
              : states.focus[index]
                ? 'au survol'
                : 'au survol ni au focus'
          }.`,
          link.ref,
        )
      } else if (index >= states.hover.length) {
        t('3.1.1').note(
          'Plus de 25 liens distingués par la seule couleur : survol et focus non contrôlés sur les suivants.',
        )
      }
    }

    // 3.1.1 — mots mis en couleur dans un texte (hors liens) : la couleur porte-t-elle une information ?
    for (const word of statics.coloredInline) {
      const answer = await t('3.1.1').judge({
        topic: 'couleurs.mot-colore',
        question:
          'Ce mot est mis en couleur sans autre repère (graisse, italique, soulignement, icône). La couleur transmet-elle une information (statut, erreur, importance…) qui n’est donnée que par elle ?',
        answers: ['sans-information', 'information-par-la-couleur-seule'],
        // Un symbole (astérisque…) a le même sens où qu'il soit : son contexte ne fait pas partie de la preuve.
        evidence:
          word.text.length <= 2 ? { mot: word.text } : { mot: word.text, contexte: word.context },
        ref: word.ref,
      })
      if (answer === 'information-par-la-couleur-seule') {
        t('3.1.1').fail(
          `Le mot « ${word.text} » transmet une information par la seule couleur (décision enregistrée).`,
          word.ref,
        )
      }
    }

    // 3.1.2 — indications de couleur données par un texte (« les champs en rouge… »).
    for (const item of statics.colorWords) {
      await t('3.1.2').judgePass({
        topic: 'couleurs.indication-couleur',
        question:
          'Cette phrase désigne un élément par sa couleur. L’élément est-il aussi repérable autrement (libellé, forme, position, icône) ?',
        evidence: { phrase: item.sentence },
        ref: item.ref,
      })
    }

    // 3.1.4 — états signalés par la couleur seule (page courante, onglet, bouton à bascule…).
    const groups = [...statics.stateGroups]
    for (const group of mesures.stateGroups) {
      if (!groups.some((known) => known.ref.selector === group.ref.selector)) groups.push(group)
    }
    for (const group of groups) {
      t('3.1.4').applicable()
      if (group.differences.length > 0 && group.structural.length === 0) {
        t('3.1.4').fail(
          `L’état « ${group.attribute} » de « ${group.name} » ne se distingue de ses voisins que par la couleur (${group.differences.join(', ')}).`,
          group.ref,
        )
      }
    }
    // Pastilles de couleur accompagnant un texte (légendes, statuts).
    for (const swatch of statics.swatches) {
      await t('3.1.4').judgePass({
        topic: 'couleurs.pastille',
        question: `Cette pastille colorée (exemple : à côté de « ${swatch.context.slice(0, 60)} ») accompagne un texte. La signification de sa couleur est-elle aussi donnée autrement (le texte voisin, une forme, un libellé) ? La réponse vaut pour toutes les pastilles de cette couleur.`,
        evidence: { couleur: swatch.color },
        ref: swatch.ref,
      })
    }
    if (groups.length > 0 || statics.swatches.length > 0) {
      t('3.1.4').note(
        'Contrôlé : état courant (aria-current, aria-selected, aria-pressed, aria-checked) comparé à ses frères, et pastilles colorées voisines d’un texte. Les autres usages de couleur dans le CSS ne sont pas inventoriés.',
      )
    }

    // 3.1.5 / 3.1.6 — médias : leur contenu n'est pas analysable, on le juge une fois par média.
    for (const media of statics.media) {
      const temporal =
        media.kind === 'video' ||
        media.kind === 'audio' ||
        (media.kind === 'iframe' &&
          /youtube|youtu\.be|vimeo|dailymotion|peertube|canal-u|video/i.test(media.source))
      const test = temporal ? '3.1.5' : '3.1.6'
      await t(test).judgePass({
        topic: 'couleurs.media',
        question: temporal
          ? 'Ce média temporel (vidéo, audio, animation) donne-t-il une information uniquement par la couleur ? Répondre « pass » si l’information est aussi donnée autrement.'
          : 'Ce contenu intégré (objet, canevas, carte, document…) donne-t-il une information uniquement par la couleur ? Répondre « pass » si l’information est aussi donnée autrement.',
        evidence: { type: media.kind, source: media.source, titre: media.title },
        ref: media.ref,
      })
    }
  },
)

export const checks: Check[] = [texts, components, images, colorInformation]
