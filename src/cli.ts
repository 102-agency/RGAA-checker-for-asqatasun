#!/usr/bin/env node
/**
 * Point d'entrée du CLI `rgaa`. Voir `rgaa --help` et le README.
 *
 * Ctrl+C garde le comportement par défaut de Node (arrêt immédiat, code 130) ;
 * Playwright ferme alors lui-même les navigateurs qu'il a lancés.
 */
import { main, reportError } from './cli/main.ts'

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.exitCode = reportError(error)
  })
