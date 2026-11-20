/** Textes d'aide du CLI. */

export const MAIN_HELP = `rgaa — audit RGAA 4.1.2 (niveau AA) en vrai navigateur

Utilisation
  rgaa audit <url> [chemins…] [options]   audite un site (sitemap) ou certaines pages
  rgaa report [options]                   réaffiche le dernier rapport
  rgaa pending [options]                  liste les questions de jugement en attente
  rgaa decide [<empreinte> <réponse>]     enregistre une décision (interactif sans argument)
  rgaa explain <test|critère|thématique>  explique un test du RGAA
  rgaa web [options]                      site local : liste des audits, nouvelle analyse, suivi
  rgaa serve [options]                    interface web locale sur le dernier rapport
  rgaa mcp [options]                      serveur MCP (stdio) pour piloter l'outil depuis une IA
  rgaa --version | --help

Exemples
  rgaa audit http://localhost:3000
  rgaa audit http://localhost:3000 --serve        suivi en direct dans le navigateur
  rgaa audit http://localhost:3000 /contact --merge   réaudite une page après correction
  rgaa audit https://www.exemple.fr / /contact --theme 1,3 --detail tout
  rgaa audit http://localhost:3000 --asqatasun ./exports-asqatasun --strict
  rgaa web                                        le site complet (ou : pnpm dev)
  rgaa report --page /contact
  rgaa decide
  rgaa explain 1.1.1

Aide d'une commande : rgaa <commande> --help

Codes de sortie
  0  aucune non-conformité et aucun test ouvert
  1  non-conformité, page non auditée, test en erreur ou non testé (et « à valider » avec --strict)
  2  mauvaise utilisation (option, argument ou fichier invalide)
  3  panne (navigateur impossible à lancer, erreur inattendue)
`

export const AUDIT_HELP = `rgaa audit <url> [chemins…] [options]

Audite les pages du site en vrai navigateur (Chromium) : toutes celles du
sitemap (<url>/sitemap.xml, ou celui qu'annonce robots.txt), ou seulement les
chemins donnés. Sans sitemap, les pages sont trouvées en suivant les liens
internes depuis <url> (sans sortir de son chemin : https://site.fr/fr/ reste
sous /fr), dans la limite de --limit.

Périmètre
  --theme <n>            limite à une thématique (répétable, ou 1,3,10)
  --criterion <n.n>      limite à un critère (répétable)
  --test <n.n.n>         limite à un test (répétable)
  --limit <n>            nombre maximal de pages (défaut 500)

Données
  --asqatasun <dossier>  exports CSV d'Asqatasun à fusionner (défaut : RGAA_ASQATASUN_DIR, sinon aucun)
  --decisions <dossier>  décisions de jugement (défaut ./rgaa-decisions)
  --out <dossier>        dossier du rapport (défaut ./rgaa-report)

Pages derrière une connexion
  --storage-state <fichier>  état de session Playwright (cookies et localStorage), obtenu une fois par
                         npx playwright codegen --save-storage=auth.json <url>
  --cookie <nom=valeur>  cookie à poser sur le site (répétable ; aussi RGAA_COOKIES="a=1; b=2",
                         à préférer : la ligne de commande est visible des autres utilisateurs)
                         Les secrets restent sur le site audité et ne sont jamais écrits dans le rapport.

Interface et captures
  --serve                ouvre l'interface web locale (127.0.0.1) : résultats en direct,
                         captures, boutons « problème / pas un problème / doute » ;
                         elle reste ouverte après l'audit (Ctrl+C pour quitter)
  --port <n>             port de l'interface (défaut 4747, un autre s'il est pris)
  --by <nom>             auteur des décisions prises dans l'interface
  --captures <mode>      tout (défaut) | doutes | aucune : captures encadrées des zones
                         en échec et des questions
  --merge                fusionne le résultat dans le rapport existant de --out (mêmes
                         pages remplacées, autres pages conservées) : boucle « corriger,
                         réauditer la page »

Affichage
  --detail <niveau>      synthese | problemes (défaut) | tout
  --page <chemin>        affiche le détail test par test de cette page (répétable)
  --format <format>      texte (défaut) | json (rapport JSON sur la sortie standard)
  --quiet                pas de progression page par page
  --no-color             sans couleurs (aussi : NO_COLOR=1)

Exécution
  --concurrency <n>      pages auditées en parallèle, 1 à 8 (défaut 2 ; ~1 Go de mémoire par page)
  --strict               code de sortie 1 aussi quand des tests restent à valider
  --browser-libs <dir>   bibliothèques système pour Chromium (aussi : RGAA_BROWSER_LIBS)
  --no-sandbox           désactive le bac à sable de Chromium (conteneurs seulement : déconseillé)
  --trace                affiche les vérifications lentes (diagnostic)

Fichiers produits dans --out
  a-corriger.md          non-conformités et doutes, lisible seul par un humain ou une IA
  a-corriger.json        le même, structuré pour une IA
  resultats-complets.md  tous les tests, tous les verdicts (positifs, négatifs, doutes)
  rapport.html           rapport complet, à ouvrir dans un navigateur
  rapport.md             le même, en Markdown
  rapport.json           données brutes (relues par report, pending, decide, serve, mcp)
  preuves/               captures encadrées des zones en échec et des questions
`

export const SERVE_HELP = `rgaa serve [options]

Ouvre l'interface web locale sur le dernier rapport : non-conformités avec
captures, questions à trancher (problème / pas un problème / doute), pages.
Les décisions sont enregistrées dans le dossier des décisions du rapport ;
l'interface peut relancer l'audit (tout le site, ou les pages concernées).

  --out <dossier>        dossier du rapport (défaut ./rgaa-report)
  --port <n>             port (défaut 4747, un autre s'il est pris)
  --by <nom>             auteur des décisions (défaut « interface web »)
  --concurrency <n>      pages en parallèle lors d'une relance (défaut 2)
  --captures <mode>      tout (défaut) | doutes | aucune
  --browser-libs <dir>   bibliothèques système pour Chromium (aussi : RGAA_BROWSER_LIBS)
  --no-sandbox           désactive le bac à sable de Chromium (déconseillé)

L'interface n'écoute que sur 127.0.0.1 et exige un jeton tiré au lancement.
`

export const REPORT_HELP = `rgaa report [options]

Réaffiche le rapport du dernier audit sans relancer le navigateur.

  --out <dossier>        dossier du rapport (défaut ./rgaa-report)
  --detail <niveau>      synthese | problemes (défaut) | tout
  --page <chemin>        détail test par test de cette page (répétable)
  --format <format>      texte (défaut) | markdown | json
  --no-color             sans couleurs

Le code de sortie est celui de l'audit (voir rgaa --help).
`

export const PENDING_HELP = `rgaa pending [options]

Liste les questions de jugement posées par le dernier audit : ce qui est
jugé, où, et comment répondre.

  --out <dossier>        dossier du rapport (défaut ./rgaa-report)
  --topic <sujet>        seulement ce sujet (ex. image.alt ; répétable)
  --format <format>      texte (défaut) | json
  --no-color             sans couleurs
`

export const DECIDE_HELP = `rgaa decide [<empreinte> <réponse>] [options]

Enregistre la réponse à une question de jugement. Elle vaut pour toutes les
pages qui présentent le même contenu ; relancer l'audit pour l'appliquer.

  rgaa decide                                   mode interactif : question par question
  rgaa decide 3f2a9c81d0e4 pass --reason "…"     une réponse
  rgaa decide --file reponses.json              plusieurs : [{ "key", "answer", "reason", "by"? }]

  Réponse « doute » admise pour toute question : elle reste ouverte et figure
  dans a-corriger.md avec la justification.

  --reason <texte>       justification (obligatoire)
  --by <nom>             auteur de la décision (défaut « humain »)
  --out <dossier>        dossier du rapport (défaut ./rgaa-report)
  --decisions <dossier>  dossier des décisions (défaut : celui du dernier audit)
`

export const EXPLAIN_HELP = `rgaa explain <test | critère | thématique>

Affiche l'intitulé officiel, les cas particuliers et les notes techniques
du RGAA 4.1.2, et indique si l'outil vérifie automatiquement le test.

  rgaa explain 1.1.1     un test
  rgaa explain 1.1       un critère et ses tests
  rgaa explain 1         une thématique et ses critères
  --no-color             sans couleurs
`

export const MCP_HELP = `rgaa mcp [options]

Serveur MCP (Model Context Protocol) sur l'entrée et la sortie standard :
une IA peut auditer un site ou quelques pages, lire ce qu'il faut corriger,
trancher les questions, voir les captures, puis réauditer après correction.
L'outil n'appelle aucun modèle : le serveur ne fait que l'exposer.

Outils : auditer_site, auditer_pages, etat_audit, lire_a_corriger,
resultats_complets, trancher_question, consigner_modification (avant/après de chaque
correction, montré dans l'interface web), voir_capture, expliquer_rgaa.

  --sites <url>          sites autorisés (répétable, ou liste séparée par des virgules) ;
                         sans cette option, tout site http(s) peut être audité
  --out <dossier>        dossier du rapport (défaut ./rgaa-report)
  --decisions <dossier>  dossier des décisions (défaut ./rgaa-decisions)
  --by <nom>             auteur des décisions prises par l'IA (défaut « IA (MCP) »)
  --decide <mode>        ce que l'IA peut faire de trancher_question, imposé par le serveur :
                           tout (défaut)  toute réponse admise : rôle « juge »
                           doute          seulement « doute » (consigner une hésitation)
                           aucune         l'outil n'est pas proposé : rôle « correcteur »
  --storage-state <f>    état de session Playwright pour auditer des pages derrière une connexion
  --cookie <nom=valeur>  cookie à poser sur le site (répétable ; aussi RGAA_COOKIES="a=1; b=2")
  --serve                ouvre aussi l'interface web locale pour suivre l'IA en direct
  --port <n>             port de l'interface (défaut 4747)
  --concurrency <n>      pages en parallèle (défaut 2)
  --captures <mode>      tout (défaut) | doutes | aucune
  --browser-libs <dir>   bibliothèques système pour Chromium (aussi : RGAA_BROWSER_LIBS)
  --no-sandbox           désactive le bac à sable de Chromium (déconseillé)

Deux rôles, deux serveurs (voir examples/claude-code/) : un « juge » (--decide tout) qui tranche
les doutes, un « correcteur » (--decide aucune) qui applique les corrections et réaudite.

Exemple de déclaration (Claude Code, .mcp.json) :
  { "mcpServers": { "rgaa": { "command": "rgaa", "args": ["mcp", "--sites", "http://localhost:3000"] } } }
`

export const WEB_HELP = `rgaa web [options]

Démarre le site local (127.0.0.1) : page d'accueil avec les audits déjà faits,
regroupés par site, et le formulaire « Nouvelle analyse » ; chaque audit
s'ouvre dans la vue détaillée (non-conformités, questions à trancher, pages,
avant / après). Un audit lancé ici s'écrit dans <dossier>/<site>-<date>/ et
reprend, si on le souhaite, les décisions du dernier audit du même site.

Options
  --dir <dossier>        dossier des audits (défaut : RGAA_AUDITS_DIR, sinon ./audits)
  --port <n>             port (défaut : PORT, sinon 4747 ; un autre s'il est pris)
  --by <nom>             auteur des décisions prises dans l'interface
  --concurrency <n>      pages analysées en parallèle (1 à 8, défaut 2)
  --captures <mode>      tout (défaut) | doutes | aucune : captures des zones en échec
  --browser-libs <dir>   bibliothèques système du navigateur (RGAA_BROWSER_LIBS)
  --no-sandbox           désactive le bac à sable de Chromium (déconseillé)

Un seul audit tourne à la fois. Les anciens dossiers d'audit (\`rapport.json\`
à plat, ou \`rapport/\` + \`decisions/\`) et ./rgaa-report sont reconnus.
`
