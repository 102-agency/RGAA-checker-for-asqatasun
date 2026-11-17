import type { FieldInfo } from './formulaires-types.ts'

/** Règles de la thématique 11 qui s'exécutent côté Node, sur les données relevées dans la page. */

// ─── Comparaison de textes ──────────────────────────────────────────────────

/** Minuscules, ponctuation et astérisques retirés, espaces réduits : « Nom * » et « nom » sont égaux. */
export function squash(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Même chose sans accents : pour reconnaître des mots-clés. */
export function plain(text: string): string {
  return squash(text.normalize('NFD').replace(/[\u0300-\u036F]/g, ''))
}

/** `name` contient-il au moins `visible` (RGAA 11.2.5 et 11.9.2, ponctuation et casse ignorées) ? */
export function nameContains(name: string, visible: string): boolean {
  const needle = squash(visible)
  if (needle === '') return true
  return ` ${squash(name)} `.includes(` ${needle} `) || squash(name).includes(needle)
}

/** Le texte visible n'est qu'un symbole (aucune lettre ni chiffre) : « > », « + », « × ». */
export function isSymbolOnly(text: string): boolean {
  return text.trim() !== '' && !/[\p{L}\p{N}]/u.test(text)
}

/** Libellé de type de champ pour les questions de jugement : stable et lisible. */
export function fieldKindLabel(field: Pick<FieldInfo, 'kind' | 'tag'>): string {
  return field.kind
}

// ─── autocomplete (WCAG 1.3.5, RGAA 11.13) ──────────────────────────────────

/** Valeurs de « field name » admises par WCAG 1.3.5 (liste du RGAA). */
export const AUTOCOMPLETE_FIELDS = new Set(
  `name honorific-prefix given-name additional-name family-name honorific-suffix nickname username
new-password current-password one-time-code organization-title organization street-address
address-line1 address-line2 address-line3 address-level4 address-level3 address-level2 address-level1
country country-name postal-code cc-name cc-given-name cc-additional-name cc-family-name cc-number
cc-exp cc-exp-month cc-exp-year cc-csc cc-type transaction-currency transaction-amount language bday
bday-day bday-month bday-year sex url photo tel tel-country-code tel-national tel-area-code tel-local
tel-local-prefix tel-local-suffix tel-extension email impp`.split(/\s+/),
)

const CONTACT_FIELDS = new Set([
  'tel',
  'tel-country-code',
  'tel-national',
  'tel-area-code',
  'tel-local',
  'tel-local-prefix',
  'tel-local-suffix',
  'tel-extension',
  'email',
  'impp',
])

export interface AutocompleteParse {
  valid: boolean
  /** Le « field name » (dernier jeton de sens), s'il est valide. */
  field: string | null
  reason?: string
}

/** Analyse la valeur d'un attribut `autocomplete` selon l'algorithme de la spécification HTML. */
export function parseAutocomplete(value: string): AutocompleteParse {
  const tokens = value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { valid: false, field: null, reason: 'valeur vide' }
  if (tokens.length === 1 && (tokens[0] === 'on' || tokens[0] === 'off')) {
    return { valid: false, field: null, reason: `« ${tokens[0]} » n’est pas une finalité` }
  }
  let i = 0
  if (tokens[i]?.startsWith('section-')) i++
  if (tokens[i] === 'shipping' || tokens[i] === 'billing') i++
  let contactHint = false
  if (['home', 'work', 'mobile', 'fax', 'pager'].includes(tokens[i] ?? '')) {
    contactHint = true
    i++
  }
  const field = tokens[i] ?? ''
  if (!AUTOCOMPLETE_FIELDS.has(field)) {
    return {
      valid: false,
      field: null,
      reason: `« ${field || tokens.join(' ')} » n’est pas dans la liste des valeurs`,
    }
  }
  if (contactHint && !CONTACT_FIELDS.has(field)) {
    return {
      valid: false,
      field,
      reason: `« ${tokens[i - 1]} » ne se combine qu’avec tel, email ou impp`,
    }
  }
  i++
  if (tokens[i] === 'webauthn') i++
  if (i !== tokens.length) {
    return { valid: false, field, reason: 'jetons en trop ou dans le désordre' }
  }
  return { valid: true, field }
}

/** Mots qui désignent une saisie qui n'est pas une donnée de l'utilisateur. */
const NOT_PERSONAL =
  /\b(message|objet|sujet|commentaires?|remarques?|recherch\w*|question|description|mots? cles?|motif|demande|details?|precisions?|observations?|texte|contenu|reponse|avis|suggestion|code promo|quantite|montant|nombre|filtre|trier|tri|services?|themes?|categories|categorie|rubriques?|domaines?|nature|mode|type|choix|options?)\b/

export interface Purpose {
  /** Jetons autocomplete admissibles pour ce champ. */
  tokens: string[]
  /** Raison pour le message d'échec. */
  why: string
  /** Déduction fragile (« nom », « adresse » : l'objet peut ne pas être l'utilisateur) : question, jamais échec. */
  weak?: boolean
}

const RULES: { test: RegExp; tokens: string[]; why: string; weak?: boolean }[] = [
  {
    test: /\b(e ?mail|courriel|mel|adresse electronique|adresse mail)\b/,
    tokens: ['email'],
    why: 'adresse électronique',
  },
  {
    test: /\b(telephone|tel|portable|mobile|gsm)\b/,
    tokens: ['tel', 'tel-national', 'tel-local'],
    why: 'numéro de téléphone',
  },
  {
    test: /\b(organisation|societe|entreprise|raison sociale)\b/,
    tokens: ['organization'],
    why: 'organisation',
  },
  {
    test: /\b(structure|association|etablissement)\b/,
    tokens: ['organization'],
    why: 'organisation',
    weak: true,
  },
  {
    test: /\b(fonction|poste|profession|metier)\b/,
    tokens: ['organization-title'],
    why: 'fonction',
  },
  { test: /\bprenoms?\b/, tokens: ['given-name', 'additional-name', 'name'], why: 'prénom' },
  {
    test: /\b(nom de famille|nom d usage|nom patronymique|nom de naissance)\b/,
    tokens: ['family-name'],
    why: 'nom de famille',
  },
  {
    test: /\b(nom et prenom|nom complet|nom prenom|prenom et nom|identite)\b/,
    tokens: ['name'],
    why: 'nom complet',
  },
  { test: /\b(code postal|cp)\b/, tokens: ['postal-code'], why: 'code postal' },
  { test: /\b(ville|commune|localite)\b/, tokens: ['address-level2'], why: 'ville' },
  { test: /\bpays\b/, tokens: ['country', 'country-name'], why: 'pays' },
  {
    test: /\badresse\b/,
    tokens: [
      'street-address',
      'address-line1',
      'address-line2',
      'address-line3',
      'address-level1',
      'address-level2',
      'address-level3',
      'address-level4',
      'postal-code',
      'country',
      'country-name',
    ],
    why: 'adresse postale',
    weak: true,
  },
  {
    test: /\b(date de naissance|naissance|ne le|nee le)\b/,
    tokens: ['bday', 'bday-day', 'bday-month', 'bday-year'],
    why: 'date de naissance',
  },
  {
    test: /\b(civilite|titre de civilite)\b/,
    tokens: ['honorific-prefix', 'sex'],
    why: 'civilité',
  },
  {
    test: /\b(identifiant|nom d utilisateur|pseudo|login)\b/,
    tokens: ['username', 'nickname', 'email'],
    why: 'identifiant',
  },
  {
    test: /\b(numero de carte|carte bancaire|carte de paiement)\b/,
    tokens: ['cc-number'],
    why: 'numéro de carte',
  },
  {
    test: /\bnom\b/,
    tokens: ['family-name', 'name', 'additional-name', 'nickname', 'username'],
    why: 'nom',
    weak: true,
  },
]

/**
 * Finalité du champ déduite de ce qu'il demande (type, étiquette, nom). `null` si
 * aucune donnée de l'utilisateur n'est reconnue ; `'neutre'` si le champ n'en est
 * manifestement pas une (message, recherche, objet…).
 */
export function inferPurpose(field: FieldInfo): Purpose | 'neutre' | null {
  if (field.kind === 'password') {
    return { tokens: ['current-password', 'new-password'], why: 'mot de passe' }
  }
  if (field.kind === 'email') return { tokens: ['email'], why: 'adresse électronique' }
  if (field.kind === 'tel')
    return { tokens: ['tel', 'tel-national', 'tel-local'], why: 'numéro de téléphone' }
  const label = plain(field.visibleLabel || field.nameText || field.accName)
  if (label && NOT_PERSONAL.test(label)) return 'neutre'
  for (const rule of RULES) {
    if (label && rule.test.test(label))
      return { tokens: rule.tokens, why: rule.why, weak: rule.weak }
  }
  if (!label) {
    const attrs = plain(`${field.name} ${field.id}`)
    for (const rule of RULES) {
      if (rule.test.test(attrs)) return { tokens: rule.tokens, why: rule.why, weak: true }
    }
  }
  return null
}

// ─── Indications de format ──────────────────────────────────────────────────

/** Texte qui indique un type ou un format de données (exemple, motif, nature de la valeur). */
export const FORMAT_HINT =
  /format|exemple|\bex\b|par ex|@|\bjj\b|\bmm\b|aaaa|chiffres?|lettres?|caract[eè]res?|\d{2}[ ./-]\d{2}|nom@|adresse e-?mail valide|doit (contenir|commencer|comporter)|commen[cç]ant|au moins \d|entre \d+ et \d+|\d+ (chiffres|caract)/i

/** Texte qui donne un exemple de valeur attendue. */
export const EXAMPLE_HINT =
  /exemple|\bex\b|\bex\.|par ex|nom@\S|\S+@\S+\.\S+|\b\d{2}[ ./-]\d{2}[ ./-]\d{2,4}|\bjj\/mm|e\.g\./i

// ─── Libellés de boutons ────────────────────────────────────────────────────

/** Intitulés qui ne disent rien de l'action : échec sans question. */
export const GENERIC_BUTTON =
  /^(bouton|button|submit|reset|valider le formulaire|cliquez ici|cliquer ici|clic|click here|click|ok ok|\.\.\.|…)$/

export const GENERIC_LABEL =
  /^(champ|input|label|field|textfield|text field|saisie|saisir|zone de texte|zone de saisie|champ de saisie|champ texte|text|texte|nom du champ|sans titre|untitled)$/
