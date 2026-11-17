/** Textes d'aide du CLI. */

export const MAIN_HELP = `rgaa — audit RGAA 4.1.2 (niveau AA) en vrai navigateur

Utilisation
  rgaa audit <url> [chemins…] [options]   audite un site (sitemap) ou certaines pages
  rgaa report [options]                   réaffiche le dernier rapport
  rgaa pending [options]                  liste les questions de jugement en attente
  rgaa decide [<empreinte> <réponse>]     enregistre une décision (interactif sans argument)
  rgaa explain <test|critère|thématique>  explique un test du RGAA
  rgaa --version | --help

Exemples
  rgaa audit http://localhost:3000
  rgaa audit https://www.exemple.fr / /contact --theme 1,3 --detail tout
  rgaa audit http://localhost:3000 --asqatasun ./exports-asqatasun --strict
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
sitemap (<url>/sitemap.xml), ou seulement les chemins donnés.

Périmètre
  --theme <n>            limite à une thématique (répétable, ou 1,3,10)
  --criterion <n.n>      limite à un critère (répétable)
  --test <n.n.n>         limite à un test (répétable)
  --limit <n>            nombre maximal de pages (défaut 500)

Données
  --asqatasun <dossier>  exports CSV d'Asqatasun à fusionner (défaut : RGAA_ASQATASUN_DIR, sinon aucun)
  --decisions <dossier>  décisions de jugement (défaut ./rgaa-decisions)
  --out <dossier>        dossier du rapport (défaut ./rgaa-report)

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
  rapport.html   rapport complet, à ouvrir dans un navigateur
  rapport.md     le même, en Markdown
  rapport.json   données brutes (relues par report, pending et decide)
  preuves/       captures des éléments sur lesquels une question est posée
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
