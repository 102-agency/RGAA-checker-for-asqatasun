---

description: Boucle RGAA — Sonnet juge et prépare, Haiku corrige, l'outil vérifie
argument-hint: [chemins des pages, ex. / /contact — vide = tout le site]
---

Conduis une boucle de correction RGAA sur le site, en séparant les rôles. Pages visées : $ARGUMENTS (vide = tout le site).

1. Lance l'agent **rgaa-juge** : il audite, tranche les questions de jugement, applique ses décisions par un réaudit, puis te rend des **consignes de correction précises** (fichier, avant, après). Ne corrige rien toi-même.
2. Si le juge rend des consignes de type « mécanique » ou « à concevoir » déjà décidées, lance l'agent **rgaa-correcteur** en lui transmettant les consignes **telles quelles**. Les deux agents ne doivent jamais tourner en même temps (ils partagent le dossier du rapport).
3. Lis le compte rendu du correcteur :
   - consignes « persistantes » ou « non appliquées » : renvoie-les au juge, qui rédige une consigne corrigée ;
   - régressions : elles doivent déjà être défaites ; vérifie-le.
4. Recommence les étapes 1 à 3 jusqu'à ce qu'il ne reste plus de consigne applicable, **au plus 3 tours**.
5. Fais le bilan à la personne : taux de conformité, ce qui est corrigé, ce qui reste (doutes, points à concevoir), et ce qu'elle doit trancher ou relire elle-même. N'écris jamais « conforme » tant que des tests restent à valider : un audit automatique ne remplace pas un audit manuel.
