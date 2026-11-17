/**
 * Types des données relevées dans la page par `collectForms`
 * (`formulaires-collect.ts`) et exploitées par la thématique 11.
 */

export interface Ref {
  selector: string
  snippet: string
}

/** Passage de texte référencé par `aria-labelledby`, `aria-describedby` ou `aria-errormessage`. */
export interface Passage {
  id: string
  exists: boolean
  /** Contenu textuel, masqué ou non (ce que lit un lecteur d'écran). */
  text: string
  /** Texte réellement affiché à l'écran. */
  visible: boolean
}

export interface LabelInfo {
  /** Contenu de l'étiquette tel que le restitue un lecteur d'écran (`aria-hidden` exclu). */
  text: string
  /** Texte réellement affiché (astérisque `aria-hidden` compris, texte `sr-only` exclu). */
  visibleText: string
  visible: boolean
  hasFor: boolean
  /** `for` égal à l'`id` du champ. */
  forMatches: boolean
  /** Le champ est dans l'étiquette. */
  implicit: boolean
  ref: Ref
}

export type Relation = 'above' | 'below' | 'left' | 'right' | 'inside' | 'diagonal'

export interface Geometry {
  relation: Relation
  /** Espace entre l'étiquette et le champ, hors textes d'aide intercalés, en px. */
  gap: number
  /** Distance entre les deux boîtes, en px. */
  distance: number
  /** Sens de lecture de l'étiquette. */
  rtl: boolean
  /** Étiquette mêlant écritures de gauche à droite et de droite à gauche. */
  mixedDirection: boolean
}

export interface SelectInfo {
  options: { text: string; value: string }[]
  optgroups: { ref: Ref; label: string | null; options: string[] }[]
  /** Options hors de tout `<optgroup>`, sans l'éventuelle première option vide (invite). */
  ungrouped: string[]
}

export interface FieldInfo {
  index: number
  ref: Ref
  tag: string
  /** Type de champ : type de l'`<input>`, balise, ou rôle ARIA. */
  kind: string
  role: string | null
  /** Case à cocher, bouton radio ou interrupteur. */
  checkable: boolean
  id: string
  name: string
  formIndex: number
  required: boolean
  ariaRequired: boolean
  autocomplete: string | null
  title: string
  placeholder: string
  ariaLabel: string
  labelledby: Passage[] | null
  labels: LabelInfo[]
  describedby: Passage[]
  errormessage: Passage[]
  /** Technique qui fournit le nom accessible, dans l'ordre du RGAA. */
  nameSource: 'aria-labelledby' | 'aria-label' | 'label' | 'title' | 'none'
  /** Contenu de la technique gagnante. */
  nameText: string
  /** Nom accessible calculé par le navigateur (axe-core). */
  accName: string
  /** Intitulé visible associé au champ (étiquette ou passage lié par aria-labelledby). */
  visibleLabel: string
  /** Texte visible de chaque intitulé associé, séparément. */
  visibleLabels: string[]
  fieldVisible: boolean
  /** Position de l'étiquette visible la plus proche, `null` sans étiquette visible. */
  geometry: Geometry | null
  adjacentButton: { text: string; ref: Ref } | null
  adjacentText: string | null
  /** Indication visible du caractère obligatoire (astérisque, « obligatoire »…), dans l'étiquette ou son passage de texte. */
  requiredIndication: string | null
  /** Indication visible « facultatif ». */
  optionalIndication: boolean
  pattern: string | null
  min: string | null
  max: string | null
  minLength: string | null
  maxLength: string | null
  disabled: boolean
  /** Regroupements (fieldset, role=group) qui contiennent le champ, du plus proche au plus lointain. */
  groups: number[]
  select: SelectInfo | null
  /** Aucune valeur saisie ni choisie au chargement. */
  valueEmpty: boolean
  /** État (utile aux sondes d'erreur). */
  ariaInvalid: string | null
  invalidPseudo: boolean
  validationMessage: string
}

export interface FormInfo {
  index: number
  ref: Ref
  tag: string
  noValidate: boolean
  method: string
  fields: number[]
  /** Premier bouton d'envoi visible. */
  submit: Ref | null
  /** Le formulaire est un moteur de recherche. */
  search: boolean
  /** Texte visible qui explique l'astérisque (dans le formulaire ou juste avant). */
  asteriskExplained: boolean
  /** Texte visible annonçant que tous les champs sont obligatoires. */
  allRequiredNotice: string | null
}

export interface GroupInfo {
  index: number
  ref: Ref
  kind: 'fieldset' | 'group' | 'radiogroup'
  /** `<legend>` (fieldset) : texte, ou `null` si absent. */
  legend: string | null
  ariaLabel: string
  labelledby: Passage[] | null
  /** Nom du regroupement : légende, sinon aria-labelledby, sinon aria-label. */
  name: string
  fields: number[]
}

export interface ButtonInfo {
  ref: Ref
  kind: 'button' | 'submit' | 'reset' | 'input-button' | 'image' | 'role'
  /** Le bouton est dans un formulaire (form, role=form, role=search, ou à côté d'un champ). */
  inForm: boolean
  /** Formulaire (`FormInfo.index`) qui contient le bouton, -1 sinon. */
  formIndex: number
  accName: string
  ariaLabel: string
  labelledby: Passage[] | null
  value: string
  content: string
  alt: string
  title: string
  /** Texte réellement affiché dans le bouton. */
  visibleText: string
  /** Contient une image ou une icône sans texte visible. */
  iconOnly: boolean
}

export interface LabelForInfo {
  ref: Ref
  forValue: string
  targetExists: boolean
  targetTag: string
  /** La cible est un élément étiquetable (champ, bouton, meter, output, progress). */
  targetLabelable: boolean
  duplicateId: boolean
}

/** Bloc de texte visible d'un formulaire, pour repérer les messages apparus après un envoi. */
export interface FormText {
  text: string
  ref: Ref
  inAlert: boolean
  /** Champs dont un passage associé (aria-describedby, aria-errormessage, étiquette) contient ce bloc. */
  assoc: number[]
  nearestField: number
  nearestDistance: number
}

export interface FormsSnapshot {
  fields: FieldInfo[]
  forms: FormInfo[]
  groups: GroupInfo[]
  buttons: ButtonInfo[]
  labelFors: LabelForInfo[]
  texts: FormText[]
  active: { fieldIndex: number; tag: string; ref: Ref } | null
  /** Champs ignorés parce qu'ils sont retirés de l'arbre d'accessibilité. */
  skippedHidden: number
  /** Mêmes indications que `FormInfo`, pour les champs qui ne sont dans aucun formulaire (calculées sur toute la page). */
  page: { asteriskExplained: boolean; allRequiredNotice: string | null }
  url: string
}
