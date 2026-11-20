# rgaa-checker

Audit **RGAA 4.1.2 (niveau AA)** en ligne de commande, dans un vrai navigateur (Chromium
piloté par Playwright).

Asqatasun ne statue que sur une petite partie des 258 tests du RGAA : sur une page
courante, environ 50 sortent « Pré-qualifié » et 150 « Non testé ». Cet outil statue sur
tous les tests qu'il sait vérifier, page par page, et **fusionne son verdict avec le dernier
export CSV d'Asqatasun** de la page. Une page n'est à 100 % que si aucun test n'est en
échec **et** qu'aucun ne reste à valider.

> Couverture : les 13 thématiques et **les 258 tests** du RGAA 4.1.2 ont une vérification. Cela
> ne veut pas dire que tout est décidé par la machine : l'outil mesure ce qui se mesure et
> **pose une question de jugement** pour le reste (transcription pertinente, titre explicite,
> intitulé de lien parlant…). Un test qui dépend du sens d'un contenu sort « À valider » tant
> que personne n'a répondu. `rgaa explain <n>` indique, pour chaque critère, ce qui est mesuré
> et ce qui est jugé. Les vérifications des thématiques 4, 5, 6, 7, 9, 12 et 13 sont récentes et
> n'ont été éprouvées que sur des pages-témoins : lire leurs constats avec un œil critique.

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

### Le site complet : `pnpm dev`

```bash
pnpm dev            # http://127.0.0.1:4747/ (le port suivant si 4747 est pris)
```

Comme n'importe quel projet web : la commande démarre le site et le recharge quand le code ou
l'interface changent. Sur la **page d'accueil** :

- **Nouvelle analyse** : l'adresse du site, éventuellement des pages précises (sans pages ni
  sitemap, l'outil suit les liens depuis l'adresse donnée, sans sortir de son chemin :
  `https://site.fr/fr/` reste sous `/fr`) ; en options
  avancées, les thématiques, le nombre de pages, les captures, le dossier d'exports Asqatasun et
  la connexion (fichier d'état de session, cookies). L'analyse démarre et s'ouvre en direct.
- **Audits déjà faits**, regroupés par site, du plus récent au plus ancien : date, nombre de
  pages, taux, pages non conformes, questions à trancher, évolution depuis l'audit précédent.
  Un clic ouvre la vue détaillée de l'audit (décrite plus bas).

Chaque lancement crée un dossier daté `audits/<site>-<date>/` (`rapport/` et `decisions/`) ; si
le site a déjà été audité, ses décisions sont reprises (case à décocher). Les anciens dossiers
d'audit et `./rgaa-report` sont reconnus. Un seul audit tourne à la fois. `RGAA_AUDITS_DIR`
change le dossier, `PORT` le port ; `rgaa web --help` donne les autres options.

`pnpm start` sert la version compilée (après `pnpm build`). L'ancien `pnpm dev` (la ligne de
commande sans compiler) devient `pnpm cli <commande>`.

### En ligne de commande

```bash
rgaa audit http://localhost:3000                    # toutes les pages du sitemap (sinon : en suivant les liens)
rgaa audit https://www.exemple.fr / /contact        # certaines pages
rgaa audit http://localhost:3000 --theme 1,3        # certaines thématiques
rgaa audit http://localhost:3000 --test 10.7.1      # un test
rgaa audit http://localhost:3000 --asqatasun ./exports-asqatasun
rgaa audit http://localhost:3000 --detail tout      # tout, page par page, test par test
rgaa audit http://localhost:3000 --storage-state auth.json   # pages derrière une connexion

rgaa report                  # réaffiche le dernier rapport, sans relancer le navigateur
rgaa report --page /contact  # le détail test par test d'une page
rgaa pending                 # les questions de jugement en attente
rgaa decide                  # y répondre, une à une
rgaa explain 1.1.1           # l'intitulé officiel, les cas particuliers, la couverture

rgaa audit http://localhost:3000 --serve            # suivi en direct dans le navigateur
rgaa audit http://localhost:3000 /contact --merge   # réaudite une page après correction
rgaa serve                   # rouvre l'interface sur le dernier rapport
rgaa web                     # le site complet : accueil, audits, nouvelle analyse (= pnpm dev)
rgaa mcp                     # serveur MCP : l'outil piloté par une IA
```

`rgaa <commande> --help` détaille les options.

### Interface web en direct

`rgaa audit <url> --serve` (ou `rgaa serve` sur un rapport déjà écrit) ouvre une interface
locale, `http://127.0.0.1:4747/` (`--port` pour changer). Pendant l'analyse, elle s'enrichit
au fil de l'eau :

- **Non-conformités** : chaque échec avec l'exigence RGAA, le sélecteur, le code HTML, les pages
  et **une capture de la zone, encadrée en rouge** ;
- **À trancher** : chaque question que l'outil ne peut pas résoudre seul, avec ses preuves et
  sa capture, et trois boutons — **C'est un problème**, **Ce n'est pas un problème**, **Doute**
  (touches `P`, `O`, `D`). Un commentaire facultatif est gardé avec la décision. Quand une
  question admet plusieurs réponses précises (« alternative absente », « titre non balisé »…),
  le bouton les propose ; les questions de classement (image décorative ou informative,
  tableau de données ou de mise en forme) affichent leurs réponses telles quelles ;
- **Doutes** : questions laissées en doute, à revoir avec un expert ;
- **Tranchées**, **Pages** (état, taux, bouton « Réauditer »), **Fichiers** ;
- **Avant / après** (seulement si une IA est connectée en MCP, ou si `corrections.json` existe
  dans le dossier du rapport) : ce que l'IA a changé dans le code, **problème par problème**,
  comme la revue des modifications d'un éditeur — fichier, ligne, texte avant et après
  (côte à côte ou unifié, mots modifiés surlignés), et le verdict du réaudit : _corrigée_,
  _persiste_, _régression_ ou _à vérifier_. La même différence apparaît sous chaque
  non-conformité concernée.

L'interface suit une grille suisse (12 colonnes, filets fins, un seul accent) en thème clair
ou sombre : **Auto** suit le système, le choix est gardé dans le navigateur. Au clavier :
`/` filtre, `J` et `K` passent d'une ligne à l'autre, `P`, `O`, `D` répondent à la question
ouverte.

Les décisions sont enregistrées dans `rgaa-decisions/` dès le clic : une décision prise
pendant l'analyse vaut aussitôt pour les pages qui restent. Les verdicts et les taux n'en
tiennent compte qu'après une nouvelle analyse : le bandeau propose de **réauditer les pages
concernées** (fusionnées au rapport) ou tout le site. L'interface reste ouverte à la fin de
l'audit ; `Ctrl+C` la ferme.

Sécurité de l'interface : elle n'écoute que sur `127.0.0.1` ; l'en-tête `Host` doit la désigner
(parade au _DNS rebinding_) ; chaque appel à l'API exige un jeton tiré au hasard au lancement
et une origine identique ; les écritures n'acceptent que du JSON borné et validé ; seuls les
fichiers du rapport et les captures `preuves/…` sont servis ; politique de sécurité du contenu
sans script en ligne ni ressource extérieure ; toutes les données sont insérées en texte.

### Travailler avec une IA

L'outil fonctionne sans IA. Une IA peut toutefois l'utiliser de deux façons :

1. **Par les fichiers** : `a-corriger.md` (ou `a-corriger.json`) se lit seul. Chaque
   non-conformité porte l'exigence RGAA, l'élément fautif, son code, sa capture et ses pages ;
   chaque doute, la question, les preuves, les réponses admises et leur sens ; le fichier donne
   les commandes pour vérifier une correction (`rgaa audit <url> <chemin> --merge`) et pour
   enregistrer une réponse. `resultats-complets.md` donne le verdict de chaque test sur chaque
   page (positifs, négatifs, doutes).
2. **Par le serveur MCP** : `rgaa mcp` expose `auditer_site`, `auditer_pages` (fusion au
   rapport, avec la **différence avant/après** : corrigé, persistant, régression),
   `etat_audit`, `lire_a_corriger` (format `compact` par défaut, filtrable par page, par test ou
   par type de correction), `resultats_complets`, `trancher_question`, `consigner_modification`,
   `voir_capture` (l'image PNG) et `expliquer_rgaa`. La boucle : auditer → lire → corriger le
   code → **consigner la modification** → réauditer les pages corrigées. Pour Claude Code, dans `.mcp.json` :

   ```json
   {
     "mcpServers": {
       "rgaa": {
         "command": "node",
         "args": ["/chemin/vers/rgaa-checker/dist/cli.js", "mcp", "--sites", "http://localhost:3000"]
       }
     }
   }
   ```

   `--sites` limite les sites que l'IA peut faire auditer (recommandé) ; `--serve` ouvre en plus
   l'interface web pour suivre l'IA en direct (avec l'avant/après de chacune de ses modifications) ;
   les décisions de l'IA sont signées `--by`
   (défaut « IA (MCP) »). Aucun modèle n'est appelé par l'outil.

   **Avant / après des modifications.** Après chaque correction du code, l'IA appelle
   `consigner_modification` (test visé, pages, fichier, texte avant, texte après, ligne et note
   facultatives ; le passage modifié seulement, 8 000 caractères au plus). L'entrée est écrite
   dans `corrections.json`, à côté du rapport. Au réaudit suivant, chaque modification reçoit
   son verdict d'après les pages revues : **corrigée** (le test n'échoue plus), **persiste**
   (il échoue encore) ou **régression** (un autre test se met à échouer sur ces pages). Le
   bilan de `auditer_pages` le rappelle à l'IA, et l'interface l'affiche. Ce que l'IA consigne
   est une donnée : jamais exécuté, jamais lu comme un chemin, affiché en texte seulement.

   **Ce que l'IA peut trancher** (`--decide`, imposé par le serveur et non par une consigne) :
   `tout` (défaut) accepte toute réponse admise ; `doute` n'accepte que « doute » ; `aucune` ne
   propose même pas `trancher_question`.

3. **Un modèle qui juge, un modèle économe qui corrige.** `examples/claude-code/` fournit deux
   serveurs MCP (`rgaa-juge` en `--decide tout`, `rgaa-correcteur` en `--decide aucune`), deux
   sous-agents Claude Code (**Sonnet** tranche les doutes et rédige des consignes précises :
   fichier, texte avant, texte après ; **Haiku** les applique, réaudite et défait toute
   régression) et la commande `/rgaa-boucle` qui les enchaîne. Les non-conformités portent une
   **piste de correction** de type _mécanique_ (changement connu d'avance : `lang`, `alt`,
   `label`…) ou _à concevoir_ (couleur, libellé, mise en page), pour savoir à qui la confier.

   Les textes et extraits de code que renvoie l'outil viennent des pages auditées : le format
   compact les neutralise et le signale au modèle comme des données, pas des instructions.

### Pages derrière une connexion

`--storage-state <fichier>` ouvre chaque page avec l'état de session de Playwright (cookies et
`localStorage`), obtenu une fois par une connexion manuelle :

```bash
npx playwright codegen --save-storage=auth.json http://localhost:3000   # se connecter, fermer
rgaa audit http://localhost:3000 --storage-state auth.json /compte /commandes
```

`--cookie nom=valeur` (répétable) pose des cookies ; préférer la variable `RGAA_COOKIES="a=1; b=2"`,
car une ligne de commande est visible des autres utilisateurs de la machine. Les mêmes options
existent pour `rgaa mcp`. Les secrets restent sur le site audité : l'état de session est filtré
(cookies du domaine, `localStorage` de l'origine) et rien n'en est écrit dans les rapports ni les
journaux. Ne pas versionner `auth.json`. Le sitemap est lu sans session : pour un espace connecté,
donner les chemins en arguments. Si la session expire ou est refusée, la page redirige vers la
connexion : elle est alors signalée « non auditée » (avec l'adresse d'arrivée) plutôt que de
laisser auditer la page de connexion à sa place.

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

| Fichier                 | Contenu                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `a-corriger.md`         | non-conformités et doutes, lisible seul par un humain ou une IA                 |
| `a-corriger.json`       | le même, structuré (format `rgaa-checker/a-corriger@1`)                         |
| `resultats-complets.md` | tous les tests, tous les verdicts, sur chaque page                              |
| `rapport.html`          | rapport complet, à ouvrir dans un navigateur (clair/sombre, sans script)        |
| `rapport.md`            | le même, en Markdown (à joindre à un ticket ou à versionner)                    |
| `rapport.json`          | données brutes, relues par `report`, `pending`, `decide`, `serve` et `mcp`      |
| `preuves/`              | captures encadrées des zones en échec (`echecs/`) et des questions (`<sujet>/`) |
| `corrections.json`      | modifications du code consignées par l'IA (MCP) et verdict du réaudit           |

Les captures montrent l'élément entouré de rouge avec une marge de contexte ; elles sont
prises sur la page principale (1280 × 900), 40 échecs au plus par page, une seule fois par
élément sur le site. `--captures doutes` ne capture que les questions, `--captures aucune`
rien.

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
rgaa decide 3f2a9c81d0e4 doute --reason "À voir avec le service juridique"
```

La réponse `doute` est admise pour toute question : elle est enregistrée avec sa
justification, mais la question reste ouverte (le test reste « à valider ») et figure dans
`a-corriger.md`. Relancer l'audit pour appliquer les décisions.

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
  L'interface web et le serveur MCP sont écrits avec les seuls modules de Node : aucune
  dépendance de plus.

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
  cli.ts, cli/          point d'entrée, commandes (audit, report, pending, decide, explain, serve, mcp)
  app/                  session d'audit partagée (CLI, interface, MCP), pilote des relances
  core/                 navigateur, session (auth), exécution d'un audit, captures, sitemap, catalogue, décisions
  security/             nettoyage des textes, URL, fichiers, validation des entrées
  report/               modèle du rapport, rendus texte / Markdown / HTML, « à corriger » (+ compact,
                        pistes de correction), fusion, différence avant/après
  server/               interface web locale : état en direct, serveur HTTP
  mcp/                  serveur MCP (JSON-RPC sur stdio) et ses outils
  themes/               les vérifications, une thématique par fichier
  lib/, inpage/         mesures et code exécuté dans les pages
assets/                 référentiel RGAA 4.1.2, utilitaires injectés dans les pages, interface (ui/)
examples/claude-code/   serveurs MCP, sous-agents et commande pour « Sonnet juge, Haiku corrige »
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
- **Faux positifs connus.** Un site qui met en page par animation peut déclencher des constats
  à tort : sections à défilement horizontal épinglé (texte « rogné » à 200 % ou à 320 px alors qu'il
  est atteint en défilant), contenus révélés au défilement dont l'état diffère entre la page avec et
  sans styles (10.2.1). L'outil ne masque pas ces cas : le constat porte l'élément et son code,
  à confirmer à la main. Les calques décoratifs `aria-hidden` (lettres séparées d'un effet de
  survol) sont, eux, reconnus et ne comptent ni comme texte rogné ni comme texte de la page.
- **Captures.** Elles sont prises sur la page principale, d'après le sélecteur de l'élément :
  un élément masqué, hors de la page principale (variante à 320 px, sans styles…) ou sans
  surface reste sans image. Une décision prise dans l'interface ou par l'IA ne change les
  verdicts qu'après une nouvelle analyse ; une fusion (`--merge`) ne recalcule pas les tests
  inter-pages (cohérence de la navigation), qui gardent leur verdict jusqu'au prochain audit
  complet.
