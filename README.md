# rgaa-checker

Audit **RGAA 4.1.2 (niveau AA)** en ligne de commande, dans un vrai navigateur (Chromium
piloté par Playwright).

Asqatasun ne statue que sur une petite partie des 258 tests du RGAA : sur une page
courante, environ 50 sortent « Pré-qualifié » et 150 « Non testé ». Cet outil statue sur
tous les tests qu'il sait vérifier, page par page, et **fusionne son verdict avec le dernier
export CSV d'Asqatasun** de la page. Une page n'est à 100 % que si aucun test n'est en
échec **et** qu'aucun ne reste à valider.

> Couverture actuelle : thématiques 1 (images), 2 (cadres), 3 (couleurs), 8 (éléments
> obligatoires), 10 (présentation) et 11 (formulaires). Les autres thématiques ne sont pas
> encore vérifiées automatiquement : leurs tests sortent « Non testé » et le rapport les liste
> explicitement. `rgaa explain <n>` indique, pour chaque critère, ce qui est automatisé.

## Installation

Node.js ≥ 22.12 et pnpm.

```bash
pnpm install
pnpm browser:install     # télécharge Chromium
pnpm build
node dist/cli.js --help  # ou, après `pnpm link --global`, simplement : rgaa --help
```

Sans droits root, s'il manque des bibliothèques système (`libnspr4`, `libnss3`,
`libasound2`), les extraire dans un dossier utilisateur
(`apt-get download libnspr4 libnss3 libasound2t64` puis `dpkg -x <paquet> <dossier>`) et
l'indiquer par `--browser-libs <dossier>` ou `RGAA_BROWSER_LIBS`.

## Utilisation

```bash
rgaa audit http://localhost:3000                    # toutes les pages du sitemap
rgaa audit https://www.exemple.fr / /contact        # certaines pages
rgaa audit http://localhost:3000 --theme 1,3        # certaines thématiques
rgaa audit http://localhost:3000 --test 10.7.1      # un test
rgaa audit http://localhost:3000 --asqatasun ./exports-asqatasun
rgaa audit http://localhost:3000 --detail tout      # tout, page par page, test par test

rgaa report                  # réaffiche le dernier rapport, sans relancer le navigateur
rgaa report --page /contact  # le détail test par test d'une page
rgaa pending                 # les questions de jugement en attente
rgaa decide                  # y répondre, une à une
rgaa explain 1.1.1           # l'intitulé officiel, les cas particuliers, la couverture
```

`rgaa <commande> --help` détaille les options.

### Ce que montre le rapport

Le terminal affiche, par ordre d'importance :

1. **Le verdict** : `✗ NON CONFORME`, `? CONFORMITÉ NON DÉMONTRÉE` (aucun échec, mais des tests
   restent ouverts) ou `✓ CONFORME`. L'outil n'affirme jamais « conforme » tant qu'un test reste
   à valider, en erreur ou non testé.
2. **Les taux** : taux du site au niveau des critères (taux RGAA officiel), taux moyen des
   pages, critères conformes / non conformes / non applicables / ouverts. Un taux est marqué
   _provisoire_ tant que des tests sont ouverts.
3. **Le tableau des pages** : état, taux, nombre de non-conformités, de tests à valider.
4. **Les non-conformités**, regroupées par thématique et par critère. Pour chaque test en
   échec : l'intitulé officiel, chaque constat avec **l'élément fautif** (sélecteur CSS) et
   **son code HTML**, et les pages concernées. Un échec qui se répète sur toutes les pages
   (en-tête, pied de page) n'est listé qu'une fois.
5. **Les questions à trancher**, **les erreurs de l'outil** et **les tests non testés**.

Chaque verdict a un symbole et un libellé : la couleur n'est jamais seule à porter
l'information (`--no-color` ou `NO_COLOR=1` pour la désactiver).

Trois niveaux de détail : `--detail synthese`, `problemes` (défaut), `tout`.

### Fichiers produits (dans `./rgaa-report`, `--out` pour changer)

| Fichier        | Contenu                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `rapport.html` | rapport complet, à ouvrir dans un navigateur (clair/sombre, sans script) |
| `rapport.md`   | le même, en Markdown (à joindre à un ticket ou à versionner)             |
| `rapport.json` | données brutes, relues par `report`, `pending` et `decide`               |
| `preuves/`     | captures des éléments sur lesquels une question est posée                |

### Codes de sortie

| Code | Sens                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 0    | aucune non-conformité et aucun test ouvert                                                             |
| 1    | non-conformité, page non auditée, test en erreur ou non testé (`--strict` : aussi des tests à valider) |
| 2    | mauvaise utilisation : option, argument ou fichier invalide                                            |
| 3    | panne : navigateur impossible à lancer, erreur inattendue                                              |

### Verdicts

| Verdict             | Sens                                                         |
| ------------------- | ------------------------------------------------------------ |
| ✓ Conforme          | le test a été vérifié et passe                               |
| ✗ Non conforme      | au moins un échec, détaillé avec l'élément fautif            |
| – Non applicable    | la page n'a pas le contenu visé par le test                  |
| ? À valider         | le test dépend d'un jugement qui n'est pas encore enregistré |
| ⚠ Erreur de l'outil | la vérification a planté : le résultat est inconnu           |
| · Non testé         | aucune vérification automatique : à auditer à la main        |

### Fusion avec Asqatasun

Les exports CSV déposés dans le dossier `--asqatasun` (ou `RGAA_ASQATASUN_DIR`) sont lus à
chaque audit. Pour chaque page (rapprochée par le chemin de l'URL, l'hôte est ignoré), le
dernier export (`Report_N.csv`, N le plus grand) l'emporte. Le verdict retenu pour un test est
le plus sévère des deux outils ; les contradictions sont signalées. Asqatasun audite le
RGAA 4.0 : ses verdicts sont ramenés à la numérotation 4.1.2 (le test 10.4.1 « unités
relatives » n'existe plus ; 10.4.2 et 10.4.3 deviennent 10.4.1 et 10.4.2).

### Décisions de jugement

Certains tests ne se décident pas mécaniquement : « cette alternative est-elle pertinente ? »,
« cette image est-elle décorative ? ». L'outil pose alors une question, identifiée par une
empreinte de son contenu. La réponse, avec sa justification, est enregistrée **une fois** dans
`./rgaa-decisions/<sujet>.json` (à versionner avec le site) et vaut pour toutes les pages qui
présentent le même contenu. Si le contenu change, l'empreinte change et la question est reposée :
un jugement ne peut pas couvrir un contenu qu'il n'a pas vu.

```bash
rgaa decide                                       # interactif : question, capture, réponse, justification
rgaa decide 3f2a9c81d0e4 pass --reason "Le titre reprend l'objet de la page"
rgaa decide --file reponses.json                  # [{ "key", "answer", "reason", "by"? }]
```

Relancer l'audit pour appliquer les décisions.

## Sécurité

Les pages auditées sont du contenu tiers : l'outil ne leur fait pas confiance.

- **Navigateur isolé** : le bac à sable de Chromium est actif par défaut (`--no-sandbox` est un
  choix explicite, signalé, réservé aux conteneurs). Les pages n'obtiennent aucune permission,
  ne téléchargent rien, n'installent pas de service worker. Le navigateur ne reçoit qu'une
  liste blanche de variables d'environnement : vos jetons et clés n'y passent pas.
- **Adresses** : seules les URL `http(s)` sont acceptées (pas de `file:`, `javascript:`,
  `data:`…), sans identifiants intégrés. Une page ou un sitemap ne peut pas faire sortir l'audit
  du site demandé ; les téléchargements de sitemap sont bornés (taille, durée, nombre).
- **Sorties neutralisées** : tout texte venu d'une page est nettoyé avant affichage —
  séquences d'échappement du terminal, caractères de contrôle et contrôles bidirectionnels
  retirés ; HTML et Markdown échappés ; le rapport HTML n'exécute aucun script
  (CSP `default-src 'none'`).
- **Fichiers** : lectures plafonnées en taille, liens symboliques refusés, écritures atomiques
  (jamais de fichier tronqué), noms de fichiers dérivés des données jamais autorisés à sortir de
  leur dossier. Les fichiers de décisions et de rapport sont validés champ par champ à la
  lecture : un fichier altéré arrête l'outil avec un message clair, il n'est pas ignoré en silence.
- **Dépendances** : trois dépendances d'exécution, aux versions exactes (`axe-core`, `parse5`,
  `playwright`) ; aucun script d'installation n'est exécuté (`.npmrc`, `pnpm-workspace.yaml`).

## Écrire une vérification

Une thématique du RGAA = un fichier `src/themes/NN-nom.ts` qui exporte `checks`. Le modèle à
suivre est `src/themes/08-elements-obligatoires.ts`, testé par
`tests/08-elements-obligatoires.test.ts` sur les pages de `fixtures/08-elements-obligatoires/`.

L'intitulé exact de chaque test, avec les cas particuliers et les notes techniques de son
critère, est dans `assets/rgaa-4.1.2.json` (les 258 tests et 106 critères, générés depuis l'ODT
officiel `RGAA-v4.1.2.odt` par `pnpm catalog`). Le glossaire est sur
<https://accessibilite.numerique.gouv.fr/methode/glossaire/>.

```ts
const frames = defineCheck(['2.1.1', '2.2.1'], async (ctx, t) => {
  const frames = await ctx.page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe')).map((el) => ({
      title: el.getAttribute('title'),
      ref: window.__rgaa.ref(el),
    })),
  )
  for (const frame of frames) {
    t('2.1.1').applicable()
    if (frame.title === null) t('2.1.1').fail('Le cadre n’a pas d’attribut title.', frame.ref)
  }
})
```

### API

- `defineCheck(tests, run)` : vérification exécutée sur chaque page. `tests` déclare tous les
  tests qu'elle statue ; `t('n.n.n')` donne l'accumulateur d'un test.
- `defineSiteCheck(tests, run)` : vérification inter-pages, exécutée une fois toutes les pages
  auditées, à partir des faits déposés par `ctx.record(sujet, valeur)`.
- Accumulateur d'un test (`Outcome`) : `applicable(n?)`, `fail(message, ref?)`, `note(texte)`,
  `judge({ topic, question, evidence, answers?, ref?, screenshot? })`, `judgePass({ … })`.
- Verdict d'un test : `NC` s'il y a un échec ; sinon `AV` s'il reste une question en attente ;
  sinon `NA` si rien n'a été déclaré applicable ; sinon `C`.
- Contexte (`PageContext`) : `ctx.page` (1280×900, **en lecture seule**), `ctx.source`,
  `ctx.fresh(options?)`, `ctx.shared(nom, options, setup?)`, `ctx.memo(clé, calcul)`,
  `ctx.record(sujet, valeur)`.
- Dans la page, `window.__rgaa` (types : `src/inpage/types.d.ts`, implémentation :
  `assets/helpers.js`) et `window.axe` (axe-core).

### Règles

1. **Jamais de « Conforme » sans contrôle réel.** Un faux « Conforme » est le pire résultat
   possible. Si le test ne se décide pas mécaniquement, poser une question (`judge`) ; si le
   contrôle a un angle mort, le dire avec `note`.
2. **Non applicable = pas de matière.** Sans élément visé par le test, ne rien déclarer.
3. **Trancher mécaniquement ce qui peut l'être** : chaque question coûte une relecture humaine.
4. **Preuves stables et minimales.** L'empreinte d'une question est calculée sur `topic` +
   `evidence` : y mettre le contenu jugé, jamais ce qui varie sans changer le sens
   (identifiants générés, URL d'image redimensionnée, position dans la page).
5. **Générique** : s'appuyer sur la sémantique HTML/ARIA et le rendu, jamais sur les classes CSS
   ou les textes d'un site.
6. **Ne pas modifier `ctx.page`** : ouvrir les menus, tabuler, redimensionner sur `ctx.fresh()`
   ou `ctx.shared()`.
7. **Une page-témoin par défaut détecté** : une fixture fautive qui prouve le `NC`, une fixture
   correcte qui prouve le `C` ou le `NA`.

## Développement

```bash
pnpm verify            # types + lint + tests unitaires
pnpm test              # tests unitaires seuls (rapides, sans navigateur)
pnpm test:fixtures     # pages-témoins, avec un vrai Chromium
pnpm lint / pnpm format
```

```text
src/
  cli.ts, cli/          point d'entrée, commandes (audit, report, pending, decide, explain)
  core/                 navigateur, exécution d'un audit, sitemap, catalogue, décisions, Asqatasun
  security/             nettoyage des textes, URL, fichiers, validation des entrées
  report/               modèle du rapport, rendus texte / Markdown / HTML
  themes/               les vérifications, une thématique par fichier
  lib/, inpage/         mesures et code exécuté dans les pages
assets/                 référentiel RGAA 4.1.2, utilitaires injectés dans les pages
fixtures/, tests/       pages-témoins et tests
```

## Limites

- L'outil audite l'état des pages au chargement et les états qu'une vérification ouvre
  explicitement (menus, accordéons, erreurs de formulaire). Un état que personne n'ouvre n'est
  pas audité.
- Un audit automatique ne remplace pas un audit manuel : il ne couvre que les tests listés par
  `rgaa explain`, et les jugements enregistrés valent ce que vaut la personne qui les a rendus
  (le fichier de décisions garde l'auteur, la date et la justification de chacun).
- L'indicateur de développement de Next.js est retiré de la page avant l'audit.
