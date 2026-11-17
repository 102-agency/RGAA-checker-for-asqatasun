/**
 * Neutralisation des textes venus des pages auditées ou de fichiers.
 *
 * Tout ce que l'outil affiche (messages, extraits de code, textes alternatifs…)
 * peut provenir du site audité, donc d'un tiers. Avant de l'écrire dans un
 * terminal, un fichier Markdown ou une page HTML, on retire ce qui pourrait
 * agir au lieu d'être lu : séquences d'échappement ANSI (déplacement du
 * curseur, réécriture du titre de la fenêtre, liens OSC 8…), caractères de
 * contrôle, et caractères de contrôle bidirectionnel (« Trojan Source ») qui
 * font lire un texte dans un autre ordre que celui où il est écrit.
 */

// Séquences ANSI complètes : CSI (ESC [ … final), OSC (ESC ] … BEL | ESC \), et ESC + un caractère.
const ANSI_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: c'est précisément leur rôle.
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g

// C0 (hors tabulation et saut de ligne), DEL, C1.
// biome-ignore lint/suspicious/noControlCharactersInRegex: idem.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

// Contrôles bidirectionnels et séparateurs invisibles qui trompent la lecture.
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/g

/** Texte sûr, sur plusieurs lignes : contrôles retirés, sauts de ligne conservés. */
export function safeText(value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined ? '' : String(value)
  return text
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_SEQUENCE, '')
    .replace(CONTROL, '')
    .replace(BIDI, '')
}

/** Texte sûr sur une seule ligne, espaces normalisés, tronqué à `max` caractères. */
export function safeLine(value: unknown, max = 2_000): string {
  const text = safeText(value).replace(/\s+/g, ' ').trim()
  return truncate(text, max)
}

/** Tronque sans couper une paire de substitution UTF-16. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** Échappement HTML (contenu et valeurs d'attribut entre guillemets doubles ou simples). */
export function escapeHtml(value: unknown): string {
  return safeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Texte Markdown inerte : la ponctuation qui a un sens en Markdown ou en HTML est échappée. */
export function escapeMarkdown(value: unknown): string {
  return safeLine(value).replace(/[\\`*_{}[\]()<>#+\-.!|~&]/g, (char) =>
    char === '&' ? '&amp;' : `\\${char}`,
  )
}

/**
 * Échappement Markdown léger, pour un texte placé après une puce ou un titre :
 * seuls les caractères qui peuvent créer du HTML, un lien, de l'emphase, du code
 * ou une cellule de tableau sont échappés. Le texte reste lisible tel quel
 * (fichiers lus par une IA), et inerte une fois rendu.
 */
export function escapeInline(value: unknown): string {
  return safeLine(value).replace(/[\\`*_[\]<>|&]/g, (char) => `\\${char}`)
}

/** Code en ligne Markdown : délimiteur plus long que toute suite d'accents graves du contenu. */
export function markdownCode(value: unknown): string {
  const text = safeLine(value)
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** Bloc de code Markdown dont le contenu ne peut pas refermer la clôture. */
export function markdownBlock(value: unknown, language = ''): string {
  const text = safeText(value)
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${language}\n${text}\n${fence}`
}
