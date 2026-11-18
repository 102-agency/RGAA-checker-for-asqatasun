/**
 * Pistes de correction : pour les tests dont l'échec revient le plus souvent,
 * ce qu'il faut changer dans le code. Elles servent à une personne ou à une IA
 * qui doit corriger sans connaître le RGAA.
 *
 * Deux types, pour répartir le travail :
 * - `mecanique`   : le changement est connu d'avance (ajouter `lang`, un `alt`,
 *                   un `label`…) ; un modèle économe peut l'appliquer tel quel
 *                   une fois le constat établi ;
 * - `a-concevoir` : il faut choisir (une couleur, un libellé, une mise en page,
 *                   un texte pertinent) ; à confier à un modèle plus fort ou à
 *                   une personne, puis à faire appliquer.
 *
 * Une piste n'est jamais une preuve de conformité : après la correction, on
 * relance l'audit de la page.
 */

export type RemediationKind = 'mecanique' | 'a-concevoir'

export interface Remediation {
  kind: RemediationKind
  /** Ce qu'il faut faire, en une ou deux phrases, avec l'exemple minimal. */
  text: string
}

const M = (text: string): Remediation => ({ kind: 'mecanique', text })
const C = (text: string): Remediation => ({ kind: 'a-concevoir', text })

const HINTS: Record<string, Remediation> = {
  '1.1.1': M(
    'Ajouter un `alt` qui donne la fonction ou l’information de l’image : `<img src="…" alt="Logo Acme">`. Pour un `role="img"` ou un SVG, ajouter `aria-label` ou `<title>`. Si l’image est décorative, c’est le test 1.2.1 : `alt=""`.',
  ),
  '1.2.1': M(
    'Image décorative : `alt=""` et aucun `title`, `aria-label` ni `aria-labelledby` (ou `aria-hidden="true"`, ou `role="presentation"`).',
  ),
  '1.3.1': C(
    'Réécrire l’alternative pour qu’elle transmette la même information que l’image, sans « image de… » ni nom de fichier.',
  ),
  '2.1.1': M(
    'Ajouter un `title` décrivant le contenu du cadre : `<iframe title="Carte du site" …>`.',
  ),
  '2.2.1': C('Réécrire le `title` du cadre pour qu’il décrive son contenu.'),
  '3.1.1': C(
    'Doubler la couleur par un autre indice (texte, icône, souligné, gras) dès qu’elle porte une information.',
  ),
  '3.2.1': C(
    'Foncer le texte ou éclaircir le fond pour atteindre 4,5:1 (3:1 si 24 px et plus, ou 18,5 px gras). Corriger la variable de couleur du design plutôt que le style local, puis vérifier ses autres usages.',
  ),
  '3.3.1': C(
    'Contour, icône ou état d’un composant : au moins 3:1 contre le fond contigu, dans chacun des états (repos, survol, focus, actif).',
  ),
  '5.4.1': M(
    'Associer le titre au tableau : `<caption>` en premier enfant de `<table>`, ou `aria-labelledby` pointant vers le titre.',
  ),
  '5.6.1': M(
    'Structurer chaque en-tête de colonne en `<th scope="col">` (ou `<th>` avec `id` référencé par `headers`).',
  ),
  '5.7.1': M(
    'Associer chaque cellule d’en-tête à ses données : `<th scope="row">` ou `<th scope="col">`, ou `id` et `headers` pour les tableaux complexes.',
  ),
  '5.8.1': M(
    'Tableau de mise en forme : retirer `<th>`, `<caption>`, `summary`, `headers`, `scope` ; ou, mieux, remplacer le tableau par du CSS.',
  ),
  '6.1.1': C(
    'Rendre l’intitulé du lien explicite hors contexte (« Lire l’article X » plutôt que « Lire la suite »), ou ajouter un texte masqué ou un `aria-label` qui commence par le texte visible.',
  ),
  '6.1.2': C(
    'Lien image : donner à l’image un `alt` qui décrit la destination, ou un `aria-label` sur le lien.',
  ),
  '6.2.1': M(
    'Donner un intitulé au lien : texte entre `<a>` et `</a>`, `alt` non vide sur l’image qu’il contient, ou `aria-label`.',
  ),
  '7.3.1': M(
    'Un élément cliquable doit être un `<button>` ou un `<a href>`. À défaut : `role`, `tabindex="0"` et gestion des touches Entrée et Espace.',
  ),
  '7.5.1': M(
    'Message de statut (succès, résultat, erreur) : l’annoncer par `role="status"` (ou `role="alert"`).',
  ),
  '8.1.1': M('Ajouter `<!DOCTYPE html>` en toute première ligne du document.'),
  '8.2.1': C(
    'Corriger les erreurs de balisage signalées (balises mal fermées ou imbriquées, attributs en double, `id` dupliqués). Contrôler le code généré par la page, pas seulement le modèle source.',
  ),
  '8.3.1': M(
    'Déclarer la langue de la page : `<html lang="fr">` (Next.js : dans `app/layout.tsx`, `<html lang="fr">`).',
  ),
  '8.4.1': M(
    'Utiliser un code de langue valide et correspondant au contenu : `fr`, `en`, `fr-FR`.',
  ),
  '8.5.1': M('Ajouter un `<title>` non vide dans le `<head>` (Next.js : `metadata.title`).'),
  '8.6.1': C('Écrire un titre de page qui décrit cette page et la distingue des autres.'),
  '8.7.1': M(
    'Passage dans une autre langue : l’entourer d’un élément avec `lang="en"` (code de la langue du passage).',
  ),
  '8.8.1': M(
    'Corriger le code de langue du passage : valide (`en`, `de`…) et correspondant au texte.',
  ),
  '9.1.1': M(
    'Un seul `<h1>`, puis des niveaux qui se suivent sans saut (h1 → h2 → h3). Changer le niveau de balise, pas son apparence (la taille se règle en CSS).',
  ),
  '9.1.3': M(
    'Un texte qui fait office de titre doit être un `<h1>`–`<h6>` (ou `role="heading"` avec `aria-level`).',
  ),
  '9.2.1': M(
    'Structurer avec `<header>`, `<nav>` (navigations seulement), un seul `<main>` visible, et `<footer>`.',
  ),
  '9.3.1': M('Regroupement visuel en liste : utiliser `<ul>`/`<ol>` et `<li>`.'),
  '9.4.1': M('Citation courte : l’entourer de `<q>`.'),
  '9.4.2': M('Bloc de citation : utiliser `<blockquote>`.'),
  '10.1.1': M(
    'Retirer les balises et attributs de présentation (`<font>`, `<center>`, `align`, `bgcolor`, `border`…) et les remplacer par du CSS.',
  ),
  '10.4.1': C(
    'Tailles de texte en unités relatives (`rem`, `em`, `%`) ; éviter hauteurs fixes et `overflow: hidden` sur les blocs de texte, pour qu’aucune information ne soit perdue à 200 %.',
  ),
  '10.7.1': C(
    'Ne pas retirer `outline` sans le remplacer : fournir un `:focus-visible` visible, d’au moins 3:1 contre le fond.',
  ),
  '10.8.1': M(
    'Contenu masqué : `hidden`, `display: none` ou `aria-hidden="true"` s’il doit être ignoré ; sinon le rendre accessible (texte visuellement masqué, pas `display: none`).',
  ),
  '10.9.1': C(
    'Doubler toute information portée seulement par la forme, la taille ou la position par un texte.',
  ),
  '10.11.1': C(
    'Reflow à 320 px : pas de largeur fixe en `px`, `flex-wrap`, grilles fluides, `min-width: 0` ; pas de défilement horizontal de la page.',
  ),
  '10.12.1': C(
    'Pas de hauteur fixe ni de `overflow: hidden` sur les blocs de texte ; interlignage, espacements en unités relatives (`em`).',
  ),
  '10.13.1': C(
    'Un contenu qui apparaît au survol ou au focus doit pouvoir être fermé (Échap) sans bouger le pointeur ni le focus.',
  ),
  '10.14.1': C(
    'Contenu additionnel au survol : le rendre aussi accessible au focus clavier, fermable et persistant.',
  ),
  '11.1.1': M(
    'Étiqueter chaque champ : `<label for="id">` + `id` sur le champ, ou `aria-label` / `aria-labelledby`. Un `placeholder` seul ne suffit pas.',
  ),
  '11.2.1': C('Réécrire le `<label>` pour qu’il dise la fonction exacte du champ.'),
  '11.3.1': C(
    'Étiquettes répétées de même fonction : leur donner un libellé cohérent (ou un `aria-label` distinct).',
  ),
  '11.4.1': M(
    'Placer l’étiquette contre son champ (juste avant, ou juste après pour une case à cocher ou un bouton radio).',
  ),
  '11.5.1': M('Regrouper les champs de même nature dans un `<fieldset>`.'),
  '11.6.1': M(
    'Ajouter une `<legend>` en premier enfant du `<fieldset>` (ou `role="group"` avec `aria-labelledby`).',
  ),
  '11.9.1': M(
    'Nommer le bouton : texte entre `<button>` et `</button>`, `value` pour `<input type="submit">`, ou `aria-label` pour un bouton-icône.',
  ),
  '11.10.1': M(
    'Champ obligatoire : `required` (ou `aria-required="true"`) et une indication visible (« * » expliqué, ou « obligatoire »).',
  ),
  '11.13.1': M(
    'Champ sur l’utilisateur : ajouter `autocomplete` adapté (`name`, `email`, `tel`, `postal-code`…).',
  ),
  '12.6.1': M(
    'Zones de la page repérables : `<header>`, `<nav>`, `<main>`, `<footer>`, et `role="search"` pour la recherche.',
  ),
  '12.7.1': M(
    'Premier élément focusable de la page : un lien « Aller au contenu » vers `<main id="contenu">`, visible au focus.',
  ),
}

export function remediationFor(test: string): Remediation | undefined {
  return HINTS[test]
}

/** Tests pour lesquels une piste existe (contrôlés contre le référentiel par un test). */
export function remediatedTests(): string[] {
  return Object.keys(HINTS)
}

export const REMEDIATION_LABEL: Record<RemediationKind, string> = {
  mecanique: 'mécanique',
  'a-concevoir': 'à concevoir',
}
