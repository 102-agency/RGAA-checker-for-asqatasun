# Claude Code : Sonnet juge, Haiku corrige

Deux rôles, deux modèles, deux serveurs MCP :

| Rôle              | Modèle | Serveur MCP                           | Peut trancher les questions         | Modifie le code                       |
| ----------------- | ------ | ------------------------------------- | ----------------------------------- | ------------------------------------- |
| `rgaa-juge`       | Sonnet | `rgaa-juge` (`--decide tout`)         | oui, avec justification             | non                                   |
| `rgaa-correcteur` | Haiku  | `rgaa-correcteur` (`--decide aucune`) | non : l'outil n'existe pas pour lui | oui, seulement ce que la consigne dit |

Le raisonnement coûteux (est-ce décoratif ? quel contraste choisir ? où est le fichier ?) est fait une fois par Sonnet, qui rend des consignes sans ambiguïté : fichier, texte avant, texte après. Haiku n'a plus qu'à les appliquer et à vérifier par l'audit. Le serveur du correcteur ne propose pas `trancher_question` : même une consigne ambiguë ne peut pas lui faire décider un jugement.

## Installation dans le site à corriger

```bash
# depuis la racine du site
cp /chemin/vers/rgaa-checker/examples/claude-code/.mcp.json .
cp -r /chemin/vers/rgaa-checker/examples/claude-code/.claude .
cat /chemin/vers/rgaa-checker/examples/claude-code/CLAUDE.md >> CLAUDE.md
```

Puis remplacer `/CHEMIN/VERS/rgaa-checker` et l'adresse du site dans `.mcp.json`. Lancer le site (`pnpm dev` ou la version de production), ouvrir Claude Code dans le dossier du site, et taper `/rgaa-boucle`.

Pour des pages derrière une connexion, ajouter `--storage-state auth.json` aux deux serveurs
(`npx playwright codegen --save-storage=auth.json <url>`, se connecter, fermer). Ne pas versionner `auth.json`.

## À savoir

- Les deux agents partagent `rgaa-report/` et `rgaa-decisions/` : ils ne doivent pas tourner en même temps (la commande `/rgaa-boucle` les enchaîne).
- Les noms d'outils vus par Claude Code sont `mcp__rgaa-juge__*` et `mcp__rgaa-correcteur__*` ; si les serveurs sont renommés, adapter la ligne `tools:` des deux agents.
- `model: haiku` et `model: sonnet` suivent les versions courantes. Pour figer une version, remplacer par l'identifiant complet du modèle.
- Mesurer avant de généraliser : lancer la boucle sur 3 à 5 pages réelles et compter les non-conformités corrigées, les régressions et les tokens consommés. Si Haiku échoue sur un type de correction, passer ce type à Sonnet (filtre `correction: "a-concevoir"` de `lire_a_corriger`).
