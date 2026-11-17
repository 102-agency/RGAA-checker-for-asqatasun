import { createHash } from 'node:crypto'

/**
 * Identité stable d'une image et détection mécanique des alternatives
 * indignes (nom de fichier, mot générique), pour la thématique 1.
 */

/** Paramètres qui ne changent que la taille ou la compression de l'image servie. */
const SIZE_PARAMS = new Set(['w', 'h', 'q', 'width', 'height', 'size', 'quality', 'fit', 'fm'])

/** Retire l'hôte et les paramètres de taille d'une adresse d'image. */
function stripAddress(address: string): string {
  let url: URL
  try {
    url = new URL(address, 'http://origine.invalid')
  } catch {
    return address.trim()
  }
  for (const name of Array.from(url.searchParams.keys())) {
    if (SIZE_PARAMS.has(name.toLowerCase())) url.searchParams.delete(name)
  }
  const query = url.searchParams.toString()
  return `${decodeURIComponent(url.pathname)}${query ? `?${query}` : ''}`
}

/**
 * Adresse d'origine d'une image, indépendante de l'hôte, de la taille servie et
 * de la page qui l'affiche.
 *
 * - `/_next/image?url=%2Fapi%2Fmedia%2Ffile%2Fa.png&w=640&q=75` → `/api/media/file/a.png`
 * - `https://cdn.exemple.fr/a.png?w=300&v=2` → `/a.png?v=2`
 * - `data:…` → `data:<empreinte>`
 */
export function normalizeImageSource(raw: string, base: string): string {
  const value = raw.trim()
  if (value === '') return ''
  if (/^data:/i.test(value)) {
    return `data:${createHash('sha1').update(value).digest('hex').slice(0, 10)}`
  }
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    return value
  }
  // Optimiseur d'images de Next.js (et équivalents) : l'origine est dans `url`.
  if (/\/_next\/image\/?$/.test(url.pathname) || /\/_vercel\/image\/?$/.test(url.pathname)) {
    const origin = url.searchParams.get('url')
    if (origin) return normalizeImageSource(origin, url.origin)
  }
  return stripAddress(url.pathname + url.search)
}

/** Empreinte courte d'un contenu (svg en ligne : viewBox + formes). */
export function fingerprint(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 10)
}

const IMAGE_EXTENSION = '(?:png|jpe?g|gif|svg|webp|avif|bmp|tiff?|ico|heic)'

/** Mots qui ne décrivent rien : « image », « photo », « logo »… */
const GENERIC_ALTERNATIVES = new Set([
  'image',
  'images',
  'img',
  'photo',
  'photos',
  'picture',
  'pic',
  'illustration',
  'visuel',
  'banniere',
  'banner',
  'logo',
  'icone',
  'icon',
  'pictogramme',
  'graphique',
  'vignette',
  'thumbnail',
  'sans titre',
  'untitled',
  'spacer',
  'null',
  'undefined',
  'nom de l image',
  'texte alternatif',
  'alt',
])

function plain(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`_\-.]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Une alternative qui est un nom de fichier, un mot générique ou un numéro
 * d'appareil photo ne peut pas être pertinente : échec mécanique, pas une question.
 * Renvoie la raison, ou `undefined` si le texte mérite un jugement.
 */
export function unworthyAlternative(text: string, source: string): string | undefined {
  const value = text.trim()
  if (value === '') return undefined
  if (new RegExp(`^\\S+\\.${IMAGE_EXTENSION}(?:[?#]\\S*)?$`, 'i').test(value)) {
    return 'l’alternative est un nom de fichier'
  }
  const generic = plain(value)
  if (GENERIC_ALTERNATIVES.has(generic)) return 'l’alternative est un mot générique'
  if (
    /^(img|image|dsc|dscn|dscf|photo|pic|picture|screenshot|capture|scan|p)\s?\d+$/.test(generic)
  ) {
    return 'l’alternative est un numéro de fichier'
  }
  const file = source.split(/[?#]/)[0]?.split('/').pop() ?? ''
  const stem = plain(file.replace(new RegExp(`\\.${IMAGE_EXTENSION}$`, 'i'), ''))
  if (stem.length >= 3 && stem === generic) return 'l’alternative reprend le nom du fichier image'
  return undefined
}
