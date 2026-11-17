import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { UserError } from '../core/errors.ts'

/**
 * Accès disque défensifs : lectures plafonnées, écritures atomiques, chemins
 * construits à partir de données jamais autorisés à sortir de leur dossier.
 */

/** Plafond par défaut d'un fichier lu (JSON de décisions, export CSV…). */
export const DEFAULT_MAX_READ_BYTES = 20 * 1024 * 1024

/**
 * Segment de chemin sûr : lettres (accents compris), chiffres, `.`, `_`, `-` ;
 * commence par une lettre ou un chiffre ; jamais de séparateur ni de `..`.
 */
const SAFE_SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u

export function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && !value.includes('..')
}

export function assertSafeSegment(value: string, what: string): string {
  if (!isSafeSegment(value)) {
    throw new UserError(
      `${what} invalide : « ${value.slice(0, 80)} » (lettres, chiffres, « . », « _ » et « - » uniquement).`,
    )
  }
  return value
}

/** Joint des segments à `root` et vérifie que le résultat reste dans `root`. */
export function containedPath(root: string, ...segments: string[]): string {
  const base = resolve(root)
  const target = resolve(base, ...segments)
  const rel = relative(base, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new UserError(`Chemin refusé : ${segments.join('/')} sort du dossier ${base}.`)
  }
  return target
}

/** Lit un fichier texte UTF-8 en refusant les fichiers trop gros ou qui ne sont pas des fichiers. */
export function readTextFile(file: string, maxBytes = DEFAULT_MAX_READ_BYTES): string {
  let stats: ReturnType<typeof lstatSync>
  try {
    stats = lstatSync(file)
  } catch {
    throw new UserError(`Fichier introuvable : ${file}`)
  }
  if (!stats.isFile()) throw new UserError(`${file} n'est pas un fichier ordinaire.`)
  if (stats.size > maxBytes) {
    throw new UserError(
      `${file} est trop volumineux (${Math.round(stats.size / 1024)} Ko, maximum ${Math.round(maxBytes / 1024)} Ko).`,
    )
  }
  return readFileSync(file, 'utf8')
}

/** Lit et analyse un fichier JSON ; l'erreur d'analyse nomme le fichier. */
export function readJsonFile(file: string, maxBytes = DEFAULT_MAX_READ_BYTES): unknown {
  const text = readTextFile(file, maxBytes)
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new UserError(
      `${file} n'est pas un JSON valide : ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Écriture atomique : le contenu est écrit dans un fichier temporaire du même
 * dossier, synchronisé, puis renommé. Un arrêt brutal laisse l'ancien fichier
 * ou le nouveau, jamais un fichier tronqué. Si la cible est un lien symbolique,
 * c'est le lien qui est remplacé : on n'écrit jamais au travers.
 */
export function writeFileAtomic(file: string, content: string | Uint8Array, mode = 0o644): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const temporary = join(dir, `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(temporary, 'wx', mode)
  try {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    let offset = 0
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    rmSync(temporary, { force: true })
    throw error
  }
  closeSync(fd)
  try {
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** Écrit un JSON indenté, terminé par un saut de ligne, de façon atomique. */
export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}
