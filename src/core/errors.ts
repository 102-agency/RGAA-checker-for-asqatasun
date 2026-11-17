/**
 * Erreur due à l'utilisation (option invalide, fichier absent ou mal formé…).
 * Le CLI l'affiche telle quelle, sans pile d'appels, avec le code de sortie 2.
 */
export class UserError extends Error {
  override readonly name = 'UserError'
}

/** Message d'erreur sur une ligne, quel que soit le type de l'erreur. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n')[0] ?? text
}

/** Codes de sortie du CLI. */
export const EXIT = {
  /** Audit complet : aucune non-conformité, rien d'ouvert. */
  OK: 0,
  /** Non-conformités, page non auditée, test sans verdict (ou à valider avec `--strict`). */
  ISSUES: 1,
  /** Mauvaise utilisation : option, argument ou fichier invalide. */
  USAGE: 2,
  /** Panne : navigateur impossible à lancer, erreur inattendue. */
  FAILURE: 3,
} as const
