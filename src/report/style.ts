import type { Status } from '../core/types.ts'
import { safeText } from '../security/text.ts'

/**
 * Mise en forme pour le terminal : couleurs (désactivables), symboles et
 * retour à la ligne. Les couleurs ne portent jamais seules l'information :
 * chaque verdict a aussi son symbole et son libellé.
 */
export interface Style {
  color: boolean
  width: number
}

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
} as const

export type Tone = keyof typeof CODES

export function paint(style: Style, tone: Tone, text: string): string {
  if (!style.color || text === '') return text
  const [open, close] = CODES[tone]
  return `\u001b[${open}m${text}\u001b[${close}m`
}

/** Faut-il colorer la sortie ? `--no-color`, NO_COLOR, FORCE_COLOR, puis terminal ou non. */
export function shouldColor(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv,
  flag?: boolean,
): boolean {
  if (flag === false) return false
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true
  if (env.TERM === 'dumb') return false
  return Boolean(stream.isTTY)
}

export function terminalWidth(stream: { columns?: number }): number {
  return Math.max(60, Math.min(stream.columns ?? 100, 140))
}

export const STATUS_SYMBOL: Record<Status, string> = {
  C: '✓',
  NC: '✗',
  NA: '–',
  AV: '?',
  ERR: '⚠',
  NT: '·',
}

export const STATUS_TONE: Record<Status, Tone> = {
  C: 'green',
  NC: 'red',
  NA: 'gray',
  AV: 'yellow',
  ERR: 'magenta',
  NT: 'gray',
}

/** Libellé détaillé d'un verdict, pour un humain. */
export const STATUS_TEXT: Record<Status, string> = {
  C: 'Conforme',
  NC: 'Non conforme',
  NA: 'Non applicable',
  AV: 'À valider',
  ERR: 'Erreur de l’outil',
  NT: 'Non testé',
}

/** Ce que signifie le verdict, en une phrase. */
export const STATUS_MEANING: Record<Status, string> = {
  C: 'vérifié, le test passe',
  NC: 'au moins un échec constaté',
  NA: 'la page n’a pas le contenu visé par le test',
  AV: 'un jugement humain doit être enregistré',
  ERR: 'la vérification a planté : le résultat est inconnu',
  NT: 'aucune vérification automatique : à auditer à la main',
}

export function badge(style: Style, status: Status, label = STATUS_TEXT[status]): string {
  return paint(style, STATUS_TONE[status], `${STATUS_SYMBOL[status]} ${label}`)
}

/** Longueur visible (séquences de couleur exclues, caractères Unicode comptés une fois). */
export function visibleLength(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: retrait de nos propres couleurs.
  return Array.from(text.replace(/\u001b\[\d+m/g, '')).length
}

export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)))
}

export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visibleLength(text))) + text
}

/**
 * Coupe un texte (non coloré) en lignes de `width` caractères au plus, chaque
 * ligne préfixée par `indent` ; `first` remplace `indent` sur la première ligne.
 */
export function wrap(text: string, width: number, indent = '', first = indent): string[] {
  const lines: string[] = []
  for (const paragraph of safeText(text).split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    let prefix = lines.length === 0 ? first : indent
    let line = ''
    const room = () => Math.max(20, width - Array.from(prefix).length)
    for (const word of words) {
      const chunks: string[] = []
      // Mot plus long que la ligne (URL, sélecteur) : découpé.
      let rest = Array.from(word)
      while (rest.length > room()) {
        chunks.push(rest.slice(0, room()).join(''))
        rest = rest.slice(room())
      }
      chunks.push(rest.join(''))
      for (const chunk of chunks) {
        const candidate = line ? `${line} ${chunk}` : chunk
        if (Array.from(candidate).length > room() && line) {
          lines.push(prefix + line)
          prefix = indent
          line = chunk
        } else {
          line = candidate
        }
      }
    }
    lines.push(prefix + line)
  }
  return lines
}

/** Nombre formaté à la française (`87,5`). */
export function frNumber(value: number): string {
  return value.toLocaleString('fr-FR', { maximumFractionDigits: 1 })
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

export function frDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })
}
