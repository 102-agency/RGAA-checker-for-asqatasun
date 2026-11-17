// Vide `dist/` avant une compilation : aucun fichier périmé ne doit être livré.
import { rmSync } from 'node:fs'

rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true })
