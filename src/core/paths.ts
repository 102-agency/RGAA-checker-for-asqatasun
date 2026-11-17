import { fileURLToPath } from 'node:url'

/**
 * Emplacements des fichiers livrés avec l'outil. `src/core/` (développement)
 * et `dist/core/` (paquet compilé) sont à la même profondeur : la racine du
 * paquet est deux niveaux au-dessus dans les deux cas.
 */
const PACKAGE_ROOT = new URL('../../', import.meta.url)

export const ASSETS = {
  /** Référentiel RGAA 4.1.2 : 258 tests, 106 critères, cas particuliers et notes techniques. */
  catalog: fileURLToPath(new URL('assets/rgaa-4.1.2.json', PACKAGE_ROOT)),
  /** Utilitaires injectés dans les pages auditées (`window.__rgaa`). */
  helpers: fileURLToPath(new URL('assets/helpers.js', PACKAGE_ROOT)),
  packageJson: fileURLToPath(new URL('package.json', PACKAGE_ROOT)),
} as const
