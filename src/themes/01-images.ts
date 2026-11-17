import { judgementKey } from '../core/decisions.ts'
import {
  type Check,
  defineCheck,
  type ElementRef,
  type JudgeRequest,
  type OutcomeFor,
  type PageContext,
} from '../core/types.ts'
import {
  collectGraphics,
  collectOpenedGraphics,
  countCssImages,
  type Graphic,
  type GraphicType,
  graphicSignature,
} from '../lib/images-collect.ts'
import { unworthyAlternative } from '../lib/images-source.ts'

/**
 * Thématique 1 — Images.
 *
 * Le cœur est de classer chaque image distincte : décorative ou porteuse
 * d'information. Le classement est mécanique quand le contexte le permet
 * (image seule dans un lien, icône `aria-hidden` doublant le nom d'un bouton,
 * image légendée, CAPTCHA nommé comme tel) et, sinon, une question de jugement
 * unique par image (`image.role`), dont la réponse porte aussi sur le texte
 * contenu dans l'image (1.8), le besoin d'une description détaillée (1.6) et
 * une légende non balisée (1.9). Les autres tests s'en déduisent :
 *
 *   décorative              → 1.2.x (marquage correct ?)
 *   porteuse d'information  → 1.1.x (alternative présente), 1.3.x (pertinence,
 *                             concision), 1.9.x (légende), 1.6.x et 1.7.x (si
 *                             description détaillée), 1.8.x (si image texte)
 *   CAPTCHA / image-test    → 1.1.x, 1.4.x, 1.5.x (à la place de 1.3 et 1.8)
 *
 * Éléments traités : img, [role=img], area, input[type=image], svg, object,
 * embed, canvas. Les panneaux repliés (accordéons, onglets, menus) sont
 * ouverts sur une page à part pour que leurs images soient auditées aussi.
 */

// ─── Table des tests par type d'élément ─────────────────────────────────────

interface TypeTests {
  /** 1.1 : alternative présente. */
  alt: string
  /** 1.2 : décoration correctement masquée. */
  deco?: string
  /** 1.3 : pertinence de l'alternative. */
  rel: string
  /** 1.4 : pertinence de l'alternative d'un CAPTCHA / image-test. */
  captcha: string
  /** 1.5 : accès alternatif à la fonction protégée par le CAPTCHA. */
  access: string
  /** 1.6 : description détaillée. */
  detail?: string
  /** 1.7 : pertinence de la description détaillée. */
  detailRel?: string
  /** 1.8 : image texte. */
  text?: string
  /** 1.9 : légende. */
  legend: string
}

const TESTS: Record<GraphicType | 'roleImg', TypeTests> = {
  img: {
    alt: '1.1.1',
    deco: '1.2.1',
    rel: '1.3.1',
    captcha: '1.4.1',
    access: '1.5.1',
    detail: '1.6.1',
    detailRel: '1.7.1',
    text: '1.8.1',
    legend: '1.9.1',
  },
  roleImg: {
    alt: '1.1.1',
    deco: '1.2.1',
    rel: '1.3.1',
    captcha: '1.4.1',
    access: '1.5.1',
    detail: '1.6.10',
    detailRel: '1.7.1',
    text: '1.8.1',
    legend: '1.9.1',
  },
  area: {
    alt: '1.1.2',
    deco: '1.2.2',
    rel: '1.3.2',
    captcha: '1.4.2',
    access: '1.5.1',
    legend: '1.9.1',
  },
  input: {
    alt: '1.1.3',
    rel: '1.3.3',
    captcha: '1.4.3',
    access: '1.5.2',
    detail: '1.6.4',
    detailRel: '1.7.2',
    text: '1.8.2',
    legend: '1.9.1',
  },
  object: {
    alt: '1.1.6',
    deco: '1.2.3',
    rel: '1.3.4',
    captcha: '1.4.4',
    access: '1.5.1',
    detail: '1.6.2',
    detailRel: '1.7.3',
    text: '1.8.3',
    legend: '1.9.2',
  },
  embed: {
    alt: '1.1.7',
    deco: '1.2.6',
    rel: '1.3.5',
    captcha: '1.4.5',
    access: '1.5.1',
    detail: '1.6.3',
    detailRel: '1.7.4',
    text: '1.8.4',
    legend: '1.9.3',
  },
  svg: {
    alt: '1.1.5',
    deco: '1.2.4',
    rel: '1.3.6',
    captcha: '1.4.6',
    access: '1.5.1',
    detail: '1.6.5',
    detailRel: '1.7.5',
    // 1.8.6 ne vise que les SVG dont le texte est dessiné (tracés) et non écrit en éléments <text>.
    text: '1.8.6',
    legend: '1.9.4',
  },
  canvas: {
    alt: '1.1.8',
    deco: '1.2.5',
    rel: '1.3.7',
    captcha: '1.4.7',
    access: '1.5.1',
    detail: '1.6.7',
    detailRel: '1.7.6',
    text: '1.8.5',
    legend: '1.9.5',
  },
}

const ALL_TESTS = [
  ...['1.1.1', '1.1.2', '1.1.3', '1.1.4', '1.1.5', '1.1.6', '1.1.7', '1.1.8'],
  ...['1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.2.5', '1.2.6'],
  ...['1.3.1', '1.3.2', '1.3.3', '1.3.4', '1.3.5', '1.3.6', '1.3.7', '1.3.8', '1.3.9'],
  ...['1.4.1', '1.4.2', '1.4.3', '1.4.4', '1.4.5', '1.4.6', '1.4.7'],
  ...['1.5.1', '1.5.2'],
  ...['1.6.1', '1.6.2', '1.6.3', '1.6.4', '1.6.5', '1.6.6', '1.6.7', '1.6.8', '1.6.9', '1.6.10'],
  ...['1.7.1', '1.7.2', '1.7.3', '1.7.4', '1.7.5', '1.7.6'],
  ...['1.8.1', '1.8.2', '1.8.3', '1.8.4', '1.8.5', '1.8.6'],
  ...['1.9.1', '1.9.2', '1.9.3', '1.9.4', '1.9.5'],
]

const testsOf = (graphic: Graphic): TypeTests =>
  graphic.roleImgTag ? TESTS.roleImg : TESTS[graphic.type]

/** Tous les tests qu'une image peut concerner : à marquer « à valider » tant que son rôle n'est pas jugé. */
const pendingTests = (graphic: Graphic): string[] => {
  const tests = testsOf(graphic)
  return [
    tests.alt,
    tests.deco,
    tests.rel,
    tests.captcha,
    tests.access,
    tests.detail,
    tests.detailRel,
    tests.text,
    tests.legend,
  ].filter((id): id is string => !!id)
}

// ─── Vocabulaire du jugement ────────────────────────────────────────────────

type Role =
  | 'decorative'
  | 'informative'
  | 'informative-detail'
  | 'text-exempt'
  | 'text-replaceable'
  | 'legend-unstructured'
  | 'captcha'

const ROLE_ANSWERS: Role[] = [
  'decorative',
  'informative',
  'informative-detail',
  'text-exempt',
  'text-replaceable',
  'legend-unstructured',
  'captcha',
]

const ROLE_QUESTION =
  'Cette image est-elle décorative ou porteuse d’information ? Réponses : ' +
  '`decorative` (aucune information propre, ou simple doublon du texte voisin) ; ' +
  '`informative` (porteuse d’information, sans texte dans l’image) ; ' +
  '`informative-detail` (porteuse d’information nécessitant une description détaillée : graphique, carte, schéma) ; ' +
  '`text-exempt` (contient du texte, cas admis : logo, effet graphique impossible en CSS, exactitude graphique essentielle) ; ' +
  '`text-replaceable` (contient du texte qui pourrait être du texte stylé) ; ' +
  '`legend-unstructured` (porteuse d’information, avec une légende adjacente non balisée en figure/figcaption) ; ' +
  '`captcha` (CAPTCHA ou image-test). En cas de cumul, choisir la réponse qui signale le défaut.'

const TYPE_LABEL: Record<GraphicType, string> = {
  img: 'image',
  area: 'zone d’image réactive',
  input: 'bouton image',
  object: 'image objet',
  embed: 'image embarquée',
  svg: 'image vectorielle',
  canvas: 'image bitmap (canvas)',
}

const labelOf = (graphic: Graphic): string =>
  graphic.roleImgTag ? `élément <${graphic.tag}> role="img"` : TYPE_LABEL[graphic.type]

// ─── Lecture d'un élément ───────────────────────────────────────────────────

/** Masquée aux technologies d'assistance par `aria-hidden`, `inert` ou `role=presentation|none`. */
const hiddenFromAT = (graphic: Graphic): boolean =>
  graphic.ariaHiddenSelf ||
  graphic.hiddenByAncestor ||
  graphic.role === 'presentation' ||
  graphic.role === 'none'

interface Alternative {
  text: string
  source: string
}

/** Alternative textuelle selon les sources admises pour le type d'élément (hors contenu alternatif). */
function alternativeOf(graphic: Graphic): Alternative {
  if (graphic.labelledbyText) return { text: graphic.labelledbyText, source: 'aria-labelledby' }
  if (graphic.ariaLabel) return { text: graphic.ariaLabel, source: 'aria-label' }
  if (graphic.roleImgTag || graphic.type === 'canvas') return { text: '', source: '' }
  if (graphic.type === 'svg') {
    return graphic.svgTitle
      ? { text: graphic.svgTitle, source: '<title>' }
      : { text: '', source: '' }
  }
  if (graphic.type === 'img' || graphic.type === 'input' || graphic.type === 'area') {
    const alt = (graphic.alt ?? '').trim()
    if (alt) return { text: alt, source: 'alt' }
  }
  if (graphic.type !== 'area' && graphic.title) return { text: graphic.title, source: 'title' }
  return { text: '', source: '' }
}

interface Marking {
  marked: boolean
  /** Alternative résiduelle qui contredit le marquage décoratif. */
  residual: string | null
}

/** L'élément est-il correctement marqué comme décoratif (1.2.x) ? */
function markingOf(graphic: Graphic): Marking {
  const hidden = hiddenFromAT(graphic)
  if (graphic.type === 'img' && !graphic.roleImgTag) {
    if (hidden) return { marked: true, residual: null }
    if (graphic.alt === '') {
      const residual = graphic.title
        ? 'un attribut title'
        : graphic.ariaLabel
          ? 'un attribut aria-label'
          : graphic.hasLabelledby
            ? 'un attribut aria-labelledby'
            : null
      return { marked: true, residual }
    }
    return { marked: false, residual: null }
  }
  if (graphic.type === 'area') {
    if (hidden) return { marked: true, residual: null }
    if (graphic.alt === '') {
      return {
        marked: true,
        residual: graphic.ariaLabel || graphic.title ? 'une alternative en plus de alt=""' : null,
      }
    }
    return { marked: false, residual: null }
  }
  // svg, canvas, object, embed, role=img : seul aria-hidden convient (un ancêtre masqué équivaut pour les aides techniques).
  if (!(graphic.ariaHiddenSelf || graphic.hiddenByAncestor))
    return { marked: false, residual: null }
  const residual = graphic.ariaLabel
    ? 'un attribut aria-label'
    : graphic.labelledbyText
      ? 'un attribut aria-labelledby'
      : graphic.title
        ? 'un attribut title'
        : graphic.svgInnerAlternative
          ? 'une alternative interne (<title>, <desc> ou attribut title)'
          : graphic.fallbackText
            ? 'un contenu alternatif entre les balises'
            : null
  return { marked: true, residual }
}

/** Clé d'identité de l'image dans les preuves : adresse d'origine ou empreinte du contenu. */
function identity(graphic: Graphic): Record<string, string> {
  const evidence: Record<string, string> = {
    type: graphic.roleImgTag ? `role=img (${graphic.tag})` : graphic.type,
  }
  if (graphic.source) evidence.source = graphic.source
  if (graphic.print) {
    evidence.empreinte = graphic.print
    evidence.apercu = graphic.preview
  }
  return evidence
}

const MAX_ALT = 80

// ─── Classement mécanique ───────────────────────────────────────────────────

type Mechanical =
  | { kind: 'decorative'; reason: string }
  | { kind: 'informative'; reason: string; ask: boolean }
  | { kind: 'captcha'; reason: string }
  | { kind: 'unmarked' }
  | { kind: 'ask' }

function mechanical(graphic: Graphic): Mechanical {
  const marking = markingOf(graphic)
  const alt = alternativeOf(graphic)
  if (graphic.captchaHint) return { kind: 'captcha', reason: 'nommée CAPTCHA' }
  if (graphic.type === 'area') {
    if (graphic.hasHref) return { kind: 'informative', reason: 'zone cliquable', ask: false }
    if (marking.marked) return { kind: 'decorative', reason: 'zone non cliquable masquée' }
    return alt.text
      ? { kind: 'informative', reason: 'zone non cliquable dotée d’une alternative', ask: false }
      : { kind: 'unmarked' }
  }
  if (graphic.type === 'input') return { kind: 'informative', reason: 'bouton image', ask: true }
  if (graphic.figure?.hasCaption) {
    return { kind: 'informative', reason: 'image légendée (figcaption)', ask: true }
  }
  if (graphic.control && !graphic.control.otherName) {
    return { kind: 'informative', reason: `seule dans un ${graphic.control.kind}`, ask: true }
  }
  if (graphic.control?.otherName && marking.marked) {
    return { kind: 'decorative', reason: `icône doublant le nom du ${graphic.control.kind}` }
  }
  if (marking.marked && (graphic.width <= 1 || graphic.height <= 1)) {
    return { kind: 'decorative', reason: 'image d’un pixel (calage)' }
  }
  const mayHaveContentAlternative =
    graphic.type === 'object' || graphic.type === 'embed' || graphic.type === 'canvas'
  if (
    !marking.marked &&
    !mayHaveContentAlternative &&
    !alt.text &&
    !graphic.svgTitle &&
    !graphic.fallbackText
  ) {
    return { kind: 'unmarked' }
  }
  return { kind: 'ask' }
}

// ─── Vérification ───────────────────────────────────────────────────────────

interface Env {
  ctx: PageContext
  t: OutcomeFor
  asked: Map<string, Promise<string | undefined>>
  legendsDone: Set<string>
}

/** Pose une question une seule fois par test et par page (les images répétées partagent la réponse). */
function ask(env: Env, test: string, request: JudgeRequest): Promise<string | undefined> {
  const id = `${test}|${judgementKey(request.topic, request.evidence)}`
  let answer = env.asked.get(id)
  if (!answer) {
    answer = env.t(test).judge(request)
    env.asked.set(id, answer)
  }
  return answer
}

/**
 * Jugement binaire : `fail` met `test` en échec, pas de réponse laisse `test`
 * (et `also`) à valider.
 */
async function askPass(
  env: Env,
  test: string,
  request: Omit<JudgeRequest, 'answers'>,
  failure: string,
  ref: ElementRef,
  also: string[] = [],
): Promise<'pass' | 'fail' | undefined> {
  const full: JudgeRequest = { ...request, answers: ['pass', 'fail'] }
  const answer = await ask(env, test, full)
  if (answer === undefined) {
    for (const other of also) await ask(env, other, full)
    return undefined
  }
  if (answer === 'fail') {
    env.t(test).fail(`${failure} (décision ${judgementKey(request.topic, request.evidence)})`, ref)
    return 'fail'
  }
  return 'pass'
}

/** Pose la question de rôle de l'image ; renvoie la réponse ou `undefined` si elle est en attente. */
async function askRole(
  env: Env,
  graphic: Graphic,
  allowDecorative: boolean,
): Promise<Role | undefined> {
  const marking = markingOf(graphic)
  const alt =
    alternativeOf(graphic).text || (graphic.fallbackText ? graphic.fallbackText.slice(0, 200) : '')
  const evidence = identity(graphic)
  if (alt) evidence.alternative = alt
  if (marking.marked && !graphic.control) {
    evidence.contexte = graphic.textNeighbor ? 'accompagne un texte' : 'sans texte voisin'
  }
  const answers = ROLE_ANSWERS.filter((answer) => allowDecorative || answer !== 'decorative')
  const request: JudgeRequest = {
    topic: 'image.role',
    question: ROLE_QUESTION,
    evidence,
    answers,
    ref: graphic.ref,
    screenshot: graphic.fromBase ? env.ctx.page.locator(graphic.ref.selector) : undefined,
  }
  // `judge` marque applicable le test sur lequel la question est posée, quelle que soit la réponse :
  // on la pose sur le test le plus probable (décoration si l'image est masquée, sinon alternative).
  const own = testsOf(graphic)
  const first = (allowDecorative && marking.marked && own.deco ? own.deco : own.alt) as string
  const answer = await ask(env, first, request)
  if (answer === undefined) {
    const others = pendingTests(graphic)
    // aria-describedby : 1.6.9 dépend aussi du rôle de l'image.
    if (graphic.describedby) others.push('1.6.9')
    for (const test of others) if (test !== first) await ask(env, test, request)
    return undefined
  }
  return answer as Role
}

/** 1.2.x : l'élément de décoration est-il correctement masqué ? */
function checkDecorative(env: Env, graphic: Graphic): void {
  const id = testsOf(graphic).deco
  if (!id) return
  const out = env.t(id)
  out.applicable()
  const marking = markingOf(graphic)
  const label = labelOf(graphic)
  if (!marking.marked) {
    const fix =
      graphic.type === 'img' && !graphic.roleImgTag
        ? 'alt="" (sans title ni aria-label) ou aria-hidden="true"'
        : 'aria-hidden="true"'
    out.fail(
      `${label} de décoration non masquée aux technologies d’assistance : ajouter ${fix}.`,
      graphic.ref,
    )
  } else if (marking.residual) {
    out.fail(`${label} de décoration qui porte pourtant ${marking.residual}.`, graphic.ref)
  }
}

/** 1.9.x : image et légende regroupées dans une figure correctement étiquetée. */
function checkLegend(env: Env, graphic: Graphic): void {
  const figure = graphic.figure
  if (!figure?.hasCaption) return
  const id = testsOf(graphic).legend
  const done = `${id}|${figure.ref.selector}`
  if (env.legendsDone.has(done)) return
  env.legendsDone.add(done)
  const out = env.t(id)
  out.applicable()
  if (figure.role !== 'figure' && figure.role !== 'group') {
    out.fail('La balise <figure> n’a pas d’attribut role="figure" ou role="group".', figure.ref)
  }
  if (figure.ariaLabel !== figure.captionText) {
    out.fail(
      `L’aria-label de la <figure> (« ${figure.ariaLabel} ») n’est pas identique à la légende (« ${figure.captionText} »).`,
      figure.ref,
    )
  }
}

/** Évidence d'un jugement sur l'alternative : ce que l'utilisateur de lecteur d'écran entend. */
function alternativeEvidence(graphic: Graphic, text: string): Record<string, string> {
  const evidence: Record<string, string> = { ...identity(graphic), alternative: text }
  const alt = (graphic.alt ?? '').trim()
  if (alt && alt !== text) evidence.alt = alt
  if (graphic.title && graphic.title !== text) evidence.title = graphic.title
  if (graphic.ariaLabel && graphic.ariaLabel !== text) evidence['aria-label'] = graphic.ariaLabel
  return evidence
}

/** Porteuse d'information (ou CAPTCHA) : 1.1, 1.3 ou 1.4, 1.5, 1.6, 1.7, 1.8. */
async function checkInformative(env: Env, graphic: Graphic, role: Role): Promise<void> {
  const tests = testsOf(graphic)
  const label = labelOf(graphic)
  const isCaptcha = role === 'captcha'
  const alt = alternativeOf(graphic)
  const hidden = hiddenFromAT(graphic)
  const out = env.t(tests.alt)
  out.applicable()

  // 1.1.x : alternative textuelle présente.
  let altText = ''
  let hasAlternative = false
  if (hidden) {
    out.fail(
      `${label} porteuse d’information masquée aux technologies d’assistance (aria-hidden, inert ou role="presentation").`,
      graphic.ref,
    )
  } else if (graphic.type === 'svg') {
    if (graphic.role !== 'img')
      out.fail('<svg> porteur d’information sans role="img".', graphic.ref)
    if (!alt.text) {
      out.fail(
        '<svg> porteur d’information sans alternative (<title>, aria-label ou aria-labelledby).',
        graphic.ref,
      )
    }
    altText = alt.text
    hasAlternative = !!alt.text
  } else if (graphic.type === 'canvas' || graphic.type === 'object' || graphic.type === 'embed') {
    const ariaOk = graphic.type !== 'canvas' || graphic.role === 'img'
    altText = ariaOk ? alt.text : ''
    const content = graphic.type === 'embed' ? '' : graphic.fallbackText
    hasAlternative = !!altText || !!content
    if (!altText && content) altText = content
    if (!hasAlternative) {
      const adjacent = graphic.adjacentControl
        ? `suivi d’un lien ou bouton (« ${graphic.adjacentControl} »)`
        : 'aucun lien ni bouton adjacent'
      const answer = await askPass(
        env,
        tests.alt,
        {
          topic: 'image.alternative-externe',
          question: `${label} sans alternative textuelle ni contenu alternatif : un lien ou bouton adjacent donne-t-il accès à un contenu alternatif, ou un mécanisme permet-il de la remplacer par un contenu alternatif ?`,
          evidence: { ...identity(graphic), voisinage: adjacent },
          ref: graphic.ref,
          screenshot: graphic.fromBase ? env.ctx.page.locator(graphic.ref.selector) : undefined,
        },
        `${label} porteuse d’information sans alternative ni accès à un contenu alternatif`,
        graphic.ref,
      )
      if (answer === 'pass') hasAlternative = false // l'alternative est externe : rien à juger sur le texte.
    }
  } else {
    altText = alt.text
    hasAlternative = !!alt.text
    if (!alt.text) {
      const why =
        graphic.alt === '' || graphic.role === 'presentation' || graphic.role === 'none'
          ? 'alternative vide (alt="")'
          : 'pas d’alternative textuelle'
      const source = graphic.roleImgTag
        ? 'aria-label ou aria-labelledby'
        : 'alt, aria-label, aria-labelledby ou title'
      out.fail(`${label} porteuse d’information : ${why} (attendu : ${source}).`, graphic.ref)
    }
  }

  // 1.3.x / 1.4.x : pertinence ; 1.3.9 : concision.
  if (altText && !hidden) {
    const relevance = isCaptcha ? tests.captcha : tests.rel
    env.t(relevance).applicable()
    const unworthy = unworthyAlternative(altText, graphic.source)
    if (unworthy) {
      env
        .t(relevance)
        .fail(`Alternative non pertinente : ${unworthy} (« ${altText} »).`, graphic.ref)
    } else {
      await askPass(
        env,
        relevance,
        {
          topic: isCaptcha ? 'image.alt-captcha' : 'image.alt',
          question: isCaptcha
            ? 'Cette alternative décrit-elle la nature et la fonction du CAPTCHA ou de l’image-test, sans en donner la réponse ?'
            : 'Cette alternative textuelle (alt, title, aria-label ou contenu alternatif) est-elle pertinente pour l’image ?',
          evidence: alternativeEvidence(graphic, altText),
          ref: graphic.ref,
          screenshot: graphic.fromBase ? env.ctx.page.locator(graphic.ref.selector) : undefined,
        },
        `Alternative non pertinente (« ${altText} »)`,
        graphic.ref,
      )
    }
    if (!isCaptcha) {
      env.t('1.3.9').applicable()
      if (altText.length > MAX_ALT) {
        await askPass(
          env,
          '1.3.9',
          {
            topic: 'image.alt-courte',
            question: `Cette alternative de plus de ${MAX_ALT} caractères est-elle courte et concise (sinon, une description détaillée est nécessaire) ?`,
            evidence: alternativeEvidence(graphic, altText),
            ref: graphic.ref,
          },
          `Alternative trop longue (${altText.length} caractères)`,
          graphic.ref,
        )
      }
    }
  }

  // 1.3.8 : contenu alternatif d'un canvas restitué par les technologies d'assistance.
  if (graphic.type === 'canvas' && graphic.fallbackText && !hidden && !isCaptcha) {
    env.t('1.3.8').applicable()
    await askPass(
      env,
      '1.3.8',
      {
        topic: 'image.restitution',
        question:
          'Le contenu alternatif placé entre <canvas> et </canvas> est-il restitué par les technologies d’assistance (pas de role="img" qui masque les enfants, canvas exposé) ?',
        evidence: {
          ...identity(graphic),
          role: graphic.role,
          contenu: graphic.fallbackText.slice(0, 200),
        },
        ref: graphic.ref,
      },
      'Le contenu alternatif du canvas n’est pas restitué',
      graphic.ref,
    )
  }

  // 1.5.x : accès alternatif à la fonction protégée par un CAPTCHA.
  if (isCaptcha) {
    env.t(tests.access).applicable()
    await askPass(
      env,
      tests.access,
      {
        topic: 'image.captcha-acces',
        question:
          'Existe-t-il, pour ce CAPTCHA, une autre forme non graphique (audio, question logique…) ou une autre solution d’accès à la fonctionnalité qu’il protège ?',
        evidence: identity(graphic),
        ref: graphic.ref,
        screenshot: graphic.fromBase ? env.ctx.page.locator(graphic.ref.selector) : undefined,
      },
      'Aucune alternative au CAPTCHA graphique',
      graphic.ref,
    )
    return
  }

  // 1.8.x : image texte.
  if ((role === 'text-exempt' || role === 'text-replaceable') && tests.text) {
    const text = env.t(tests.text)
    text.applicable()
    if (role === 'text-replaceable') {
      text.fail(
        `${label} contenant du texte qui pourrait être remplacé par du texte stylé.`,
        graphic.ref,
      )
    }
  }

  // 1.6.x / 1.7.x : description détaillée.
  if (role === 'informative-detail') await checkDetail(env, graphic)

  // 1.6.9 : aria-describedby associe-t-il la description détaillée ?
  if (graphic.describedby) await checkDescribedBy(env, graphic)

  // 1.9.x : légende non balisée.
  if (role === 'legend-unstructured') {
    const legend = env.t(tests.legend)
    legend.applicable()
    legend.fail(
      `${label} avec une légende adjacente qui n’est pas regroupée avec elle dans <figure> / <figcaption>.`,
      graphic.ref,
    )
  }
}

/** Signaux mécaniques d'une description détaillée autour de l'image. */
function detailSignals(graphic: Graphic): string[] {
  const signals: string[] = []
  if (graphic.longdesc) signals.push(`longdesc=${graphic.longdesc}`)
  if (graphic.describedby?.text) signals.push('aria-describedby')
  if (graphic.figure?.hasCaption) signals.push('figcaption')
  if (graphic.adjacentControl) signals.push(`lien/bouton adjacent « ${graphic.adjacentControl} »`)
  if (alternativeOf(graphic).text.length > MAX_ALT) signals.push('alternative longue')
  return signals
}

async function checkDetail(env: Env, graphic: Graphic): Promise<void> {
  const tests = testsOf(graphic)
  const label = labelOf(graphic)
  if (!tests.detail) return
  env.t(tests.detail).applicable()
  const signals = detailSignals(graphic)
  const evidence = { ...identity(graphic), signaux: signals.join(' ; ') || 'aucun' }
  const alsoPending = tests.detailRel ? [tests.detailRel] : []
  const found = await askPass(
    env,
    tests.detail,
    {
      topic: 'image.detail',
      question:
        'Cette image nécessite une description détaillée : en existe-t-il une (longdesc, alternative qui renvoie à une description adjacente, lien ou bouton adjacent, aria-describedby) ?',
      evidence,
      ref: graphic.ref,
      screenshot: graphic.fromBase ? env.ctx.page.locator(graphic.ref.selector) : undefined,
    },
    `${label} nécessitant une description détaillée qui n’existe pas`,
    graphic.ref,
    alsoPending,
  )
  if (found === 'pass' && tests.detailRel) {
    env.t(tests.detailRel).applicable()
    await askPass(
      env,
      tests.detailRel,
      {
        topic: 'image.detail-pertinence',
        question: 'La description détaillée de cette image est-elle pertinente ?',
        evidence,
        ref: graphic.ref,
      },
      'Description détaillée non pertinente',
      graphic.ref,
    )
  }
  // 1.6.6 / 1.6.8 : restitution par les technologies d'assistance.
  const restitution = graphic.type === 'svg' ? '1.6.6' : graphic.type === 'canvas' ? '1.6.8' : null
  if (restitution) {
    env.t(restitution).applicable()
    await askPass(
      env,
      restitution,
      {
        topic: 'image.restitution',
        question:
          'La description détaillée (ou la référence à celle-ci) de cette image est-elle correctement restituée par les technologies d’assistance ?',
        evidence,
        ref: graphic.ref,
      },
      'La description détaillée n’est pas correctement restituée',
      graphic.ref,
    )
  }
}

async function checkDescribedBy(env: Env, graphic: Graphic): Promise<void> {
  const describedby = graphic.describedby
  if (!describedby) return
  const out = env.t('1.6.9')
  out.applicable()
  if (describedby.missing.length > 0) {
    out.fail(
      `aria-describedby référence des identifiants absents de la page (${describedby.missing.join(', ')}).`,
      graphic.ref,
    )
    return
  }
  if (!describedby.text) {
    out.fail('aria-describedby référence un passage vide.', graphic.ref)
    return
  }
  await askPass(
    env,
    '1.6.9',
    {
      topic: 'image.describedby',
      question:
        'L’attribut aria-describedby associe-t-il bien la description détaillée de l’image ?',
      evidence: { ...identity(graphic), description: describedby.text.slice(0, 300) },
      ref: graphic.ref,
    },
    'aria-describedby n’associe pas la description détaillée',
    graphic.ref,
  )
}

/** Inventaire de la page : état au chargement, puis panneaux repliés ouverts sur une page à part. */
async function inventory(ctx: PageContext): Promise<{ graphics: Graphic[]; cssImages: number }> {
  return ctx.memo('images.inventaire', async () => {
    const graphics = await collectGraphics(ctx.page, true)
    const known = new Set(graphics.map(graphicSignature))
    let cssImages = 0
    try {
      cssImages = await countCssImages(ctx.page)
    } catch {
      // Compte indicatif seulement.
    }
    // Les panneaux ne sont ouverts que s'il en existe : sinon aucune page supplémentaire.
    const hasClosed = await ctx.page.evaluate(
      () =>
        document.querySelector(
          'details:not([open]), [aria-expanded="false"], [role="tab"][aria-selected="false"], [aria-haspopup="menu"]',
        ) !== null,
    )
    if (hasClosed) {
      const fresh = await ctx.fresh()
      graphics.push(...(await collectOpenedGraphics(fresh, known)))
    }
    return { graphics, cssImages }
  })
}

const images = defineCheck(ALL_TESTS, async (ctx, t) => {
  const { graphics, cssImages } = await inventory(ctx)
  const env: Env = { ctx, t, asked: new Map(), legendsDone: new Set() }

  if (cssImages > 0) {
    t('1.1.1').note(
      `${cssImages} élément(s) affichent une image CSS d’arrière-plan sans texte : leur contenu n’est pas audité (image porteuse d’information éventuelle).`,
    )
  }

  for (const graphic of graphics) {
    const tests = testsOf(graphic)
    const label = labelOf(graphic)

    // 1.1.4 : image réactive côté serveur.
    if (graphic.ismap && (graphic.type === 'img' || graphic.type === 'input')) {
      t('1.1.4').applicable()
      await askPass(
        env,
        '1.1.4',
        {
          topic: 'image.ismap',
          question:
            'Chaque zone cliquable de cette image réactive côté serveur (ismap) est-elle doublée d’un lien dans la page ?',
          evidence: identity(graphic),
          ref: graphic.ref,
          screenshot: graphic.fromBase ? ctx.page.locator(graphic.ref.selector) : undefined,
        },
        'Zones d’une image réactive côté serveur non doublées par des liens',
        graphic.ref,
      )
    }

    // Légende structurée : mécanique, indépendante du rôle.
    checkLegend(env, graphic)

    const mech = mechanical(graphic)
    switch (mech.kind) {
      case 'decorative':
        checkDecorative(env, graphic)
        break
      case 'unmarked': {
        // Ni alternative ni marquage : défaillant que l'image soit décorative ou non.
        const id = graphic.type === 'area' ? tests.deco : tests.alt
        if (id) {
          t(id).fail(
            `${label} sans alternative textuelle et sans marquage de décoration (alt="" ou aria-hidden="true").`,
            graphic.ref,
          )
        }
        break
      }
      case 'captcha':
        await checkInformative(env, graphic, 'captcha')
        break
      case 'informative': {
        if (!mech.ask) {
          await checkInformative(env, graphic, 'informative')
          break
        }
        const role = await askRole(env, graphic, false)
        if (role) await checkInformative(env, graphic, role === 'decorative' ? 'informative' : role)
        break
      }
      case 'ask': {
        const role = await askRole(env, graphic, true)
        if (!role) break
        if (role === 'decorative') checkDecorative(env, graphic)
        else await checkInformative(env, graphic, role)
        break
      }
    }
  }
})

export const checks: Check[] = [images]
