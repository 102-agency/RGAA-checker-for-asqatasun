/**
 * Sens des réponses aux questions de jugement.
 *
 * Chaque vérification pose ses questions avec ses propres réponses (`pass` /
 * `fail`, `titre-non-balise`, `donnees`…). Pour l'interface et les rapports, on
 * range chaque réponse dans l'une de trois familles :
 *
 * - `probleme` : la réponse confirme un défaut (le test sort non conforme) ;
 * - `ok`       : la réponse lève le soupçon ;
 * - `neutre`   : la réponse classe l'élément (image décorative ou informative,
 *                tableau de données ou de mise en forme…) et c'est la suite de
 *                la vérification qui conclut.
 *
 * À ces réponses s'ajoute `doute` : la personne (ou l'IA) qui examine la
 * question ne sait pas trancher. La décision est enregistrée, la question reste
 * ouverte (le test reste « à valider ») et figure dans la liste « à corriger ».
 */

export const DOUBT = 'doute'

export type AnswerMeaning = 'probleme' | 'ok' | 'neutre'

const PROBLEM = new Set([
  'fail',
  'alternative-absente',
  'alternative-insuffisante',
  'audiodescription-absente',
  'aucun-mecanisme',
  'citation-non-balisee',
  'couleur-seule',
  'graphique-contraste',
  'illisible',
  'information-par-la-couleur-seule',
  'liste-non-balisee',
  'message-sans-role',
  'non-exempte',
  'sans-definition',
  'sous-titres-absents',
  'legend-unstructured',
  'texte-contraste',
  'text-replaceable',
  'titre-non-balise',
])

const OK = new Set([
  'pass',
  'alternative',
  'conforme',
  'defini-par-le-contexte',
  'exempte',
  'inutile',
  'lisible',
  'mecanisme-valide',
  'pas-cryptique',
  'pas-un-message',
  'pas-un-titre',
  'pas-une-citation',
  'pas-une-liste',
  'sans-information',
  'sans-objet',
  'sous-titres-presents',
])

const LABELS: Record<string, string> = {
  pass: 'Pas un problème',
  fail: 'Problème',
  doute: 'Doute',
  alternative: 'Une alternative pertinente existe',
  'alternative-absente': 'Alternative absente',
  'alternative-insuffisante': 'Alternative insuffisante',
  'audiodescription-absente': 'Audiodescription absente',
  'aucun-mecanisme': 'Aucun mécanisme de remplacement',
  'autre-langue': 'Autre langue',
  'citation-non-balisee': 'Citation non balisée',
  conforme: 'Conforme',
  'couleur-seule': 'Information par la couleur seule',
  decorative: 'Image décorative',
  'defini-par-le-contexte': 'Défini par le contexte',
  donnees: 'Tableau de données',
  exempte: 'Exempté',
  'graphique-contraste': 'Contraste du graphique insuffisant',
  illisible: 'Illisible',
  'information-par-la-couleur-seule': 'Information par la couleur seule',
  informative: 'Image porteuse d’information',
  'informative-detail': 'Image informative à description détaillée',
  inutile: 'Sans objet ici',
  'liste-non-balisee': 'Liste non balisée',
  lisible: 'Lisible',
  'mecanisme-valide': 'Mécanisme de remplacement valide',
  'meme-langue': 'Même langue',
  'message-sans-role': 'Message de statut sans rôle',
  'mise-en-forme': 'Tableau de mise en forme',
  'non-exempte': 'Non exempté',
  'pas-cryptique': 'Pas cryptique',
  'pas-un-message': 'Pas un message de statut',
  'pas-un-titre': 'Pas un titre',
  'pas-une-citation': 'Pas une citation',
  'pas-une-liste': 'Pas une liste',
  'sans-definition': 'Sans définition',
  'sans-information': 'Sans information',
  'sans-objet': 'Sans objet',
  'sous-titres-absents': 'Sous-titres absents',
  'sous-titres-presents': 'Sous-titres présents',
  'text-exempt': 'Image texte exemptée',
  'text-replaceable': 'Image texte remplaçable par du texte stylé',
  'legend-unstructured': 'Légende non reliée à l’image',
  captcha: 'CAPTCHA',
  'texte-contraste': 'Contraste du texte insuffisant',
  'titre-non-balise': 'Titre non balisé',
}

export function answerMeaning(answer: string): AnswerMeaning {
  if (PROBLEM.has(answer)) return 'probleme'
  if (OK.has(answer)) return 'ok'
  return 'neutre'
}

/** Libellé lisible d'une réponse (la réponse brute si elle n'est pas répertoriée). */
export function answerLabel(answer: string): string {
  return LABELS[answer] ?? answer
}

/** Réponses admises pour une question, rangées par famille (le doute est toujours admis). */
export function answerGroups(answers: readonly string[]): Record<AnswerMeaning, string[]> {
  const groups: Record<AnswerMeaning, string[]> = { probleme: [], ok: [], neutre: [] }
  for (const answer of answers) groups[answerMeaning(answer)].push(answer)
  return groups
}

/** La réponse est-elle admise pour cette question (le doute l'est toujours) ? */
export function isAdmitted(answer: string, answers: readonly string[]): boolean {
  return answer === DOUBT || answers.includes(answer)
}
