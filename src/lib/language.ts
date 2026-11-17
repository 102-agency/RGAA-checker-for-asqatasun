/**
 * Détection de langue par mots-outils, suffisante pour dire « ce passage est en
 * anglais » ou « cette page est bien en français ». Volontairement simple :
 * quand le signal est faible, la fonction répond `null` et la vérification
 * demande un jugement plutôt que de trancher.
 */
const MARKERS: Record<string, string[]> = {
  fr: 'le la les des du un une et est sont dans pour avec sur par au aux que qui ce cette ces nous vous votre vos notre nos plus pas ne se sa son ses leur leurs été être avoir fait où mais ou donc chez entre depuis vers tous toutes'.split(
    ' ',
  ),
  en: 'the and of to in is are for with on by this that these those you your our we it its from at as be was were has have will can not more about all how what when where who which their there here'.split(
    ' ',
  ),
  es: 'el los las del y es son en para con por una uno que este esta estos su sus nuestro nuestra más pero como cuando donde desde hasta también muy'.split(
    ' ',
  ),
  de: 'der die das und ist sind in für mit auf von ein eine einen dem den des zu nicht auch wir sie ihr ihre unser unsere mehr aber oder wie wenn wo bei nach'.split(
    ' ',
  ),
  it: 'il lo gli le del della dei e è sono in per con su da un una che questo questa questi il suo nostra nostro più ma come quando dove anche molto'.split(
    ' ',
  ),
}

const MARKER_SETS = Object.fromEntries(
  Object.entries(MARKERS).map(([lang, words]) => [lang, new Set(words)]),
) as Record<string, Set<string>>

export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}]+(?:['’-][\p{L}]+)*/gu) ?? []
}

export interface LanguageGuess {
  lang: string
  /** Part des mots du texte qui sont des mots-outils de cette langue. */
  ratio: number
  /** Écart avec la deuxième langue candidate. */
  margin: number
}

/**
 * Langue la plus probable d'un texte, ou `null` si le texte est trop court ou
 * le signal trop faible. `minWords` : nombre de mots en dessous duquel on ne
 * se prononce pas.
 */
export function guessLanguage(text: string, minWords = 6): LanguageGuess | null {
  // Les élisions (« l'accueil », « d'un ») cachent les mots-outils français : on les sépare.
  const tokens = words(text).flatMap((token) => token.split(/['’]/))
  if (tokens.length < minWords) return null
  const scores = Object.entries(MARKER_SETS)
    .map(([lang, set]) => ({
      lang,
      ratio: tokens.filter((token) => set.has(token)).length / tokens.length,
    }))
    .sort((a, b) => b.ratio - a.ratio)
  const [best, second] = scores
  if (!best || best.ratio < 0.12) return null
  const margin = best.ratio - (second?.ratio ?? 0)
  if (margin < 0.06) return null
  return { lang: best.lang, ratio: best.ratio, margin }
}

/** Sous-étiquette de langue principale d'un code BCP 47 (`fr-FR` → `fr`). */
export function primarySubtag(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0] ?? ''
}

/** Codes ISO 639-1 (deux lettres) reconnus. */
const ISO_639_1 = new Set(
  'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(
    ' ',
  ),
)

/**
 * Le code de langue est-il valide ? Forme BCP 47 (`fr`, `fr-FR`, `oc`, `zh-Hant`)
 * avec une sous-étiquette principale ISO 639-1, ou une de trois lettres (ISO 639-2/3).
 */
export function isValidLanguageCode(code: string): boolean {
  const value = code.trim()
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) return false
  const primary = primarySubtag(value)
  return primary.length === 3 || ISO_639_1.has(primary)
}
