import { canonicalPath, resolvePageUrl } from '../security/url.ts'
import { UserError } from './errors.ts'

/**
 * Découverte des pages à auditer à partir du sitemap du site.
 *
 * Le sitemap porte souvent l'URL publique du site (production) alors qu'on
 * audite une autre instance (préproduction, poste local) : on n'en garde que le
 * chemin, rapporté au site audité. Les téléchargements sont bornés en taille,
 * en durée et en nombre (index de sitemaps compris).
 */

export interface SitemapOptions {
  /** Nombre maximal de pages retenues. */
  maxPages: number
  /** Taille maximale d'un sitemap téléchargé, en octets. */
  maxBytes?: number
  timeoutMs?: number
  /** Nombre maximal de sitemaps lus à partir d'un index. */
  maxSitemaps?: number
  fetch?: typeof fetch
}

export interface DiscoveredPages {
  urls: string[]
  /** Pages du sitemap écartées par le plafond `maxPages`. */
  dropped: number
  source: 'arguments' | 'sitemap'
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? whole
  })
}

/** Valeurs des balises `<loc>` d'un sitemap (CDATA accepté). */
export function extractLocations(xml: string): string[] {
  const locations: string[] = []
  for (const match of xml.matchAll(/<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/loc>/gi)) {
    const value = (match[1] ?? decodeXml(match[2] ?? '')).trim()
    if (value) locations.push(value)
  }
  return locations
}

export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml)
}

async function download(
  url: URL,
  options: Required<Omit<SitemapOptions, 'maxPages'>>,
): Promise<string> {
  const response = await options.fetch(url, {
    signal: AbortSignal.timeout(options.timeoutMs),
    redirect: 'follow',
    headers: { accept: 'application/xml, text/xml;q=0.9, */*;q=0.1' },
  })
  if (!response.ok) {
    throw new UserError(
      `Sitemap ${url.pathname} introuvable (HTTP ${response.status}) : donner les chemins à auditer en arguments.`,
    )
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > options.maxBytes) {
    throw new UserError(`Sitemap ${url.pathname} trop volumineux (${declared} octets).`)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > options.maxBytes) {
      await reader.cancel()
      throw new UserError(
        `Sitemap ${url.pathname} trop volumineux (plus de ${options.maxBytes} octets).`,
      )
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Ramène une URL du sitemap à un chemin du site audité (l'hôte du sitemap est ignoré). */
function toSitePath(base: URL, location: string): string | null {
  try {
    // `//autre.hote/x` serait relu comme une URL relative au protocole : on écrase les barres en tête.
    const path = canonicalPath(new URL(location, base)).replace(/^\/{2,}/, '/')
    return new URL(path, base).origin === base.origin ? path : null
  } catch {
    return null
  }
}

export async function discoverPages(
  base: URL,
  paths: string[],
  options: SitemapOptions,
): Promise<DiscoveredPages> {
  if (paths.length > 0) {
    const urls = Array.from(new Set(paths.map((path) => resolvePageUrl(base, path).href)))
    return { urls, dropped: 0, source: 'arguments' }
  }

  const settings = {
    maxBytes: options.maxBytes ?? 10 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 20_000,
    maxSitemaps: options.maxSitemaps ?? 50,
    fetch: options.fetch ?? fetch,
  }
  let root: string
  try {
    root = await download(new URL('/sitemap.xml', base), settings)
  } catch (error) {
    if (error instanceof UserError) throw error
    throw new UserError(
      `Impossible de lire ${new URL('/sitemap.xml', base).href} (${error instanceof Error ? error.message : String(error)}). Le site est-il démarré ? Sinon, donner les chemins à auditer en arguments.`,
    )
  }

  let locations: string[]
  if (isSitemapIndex(root)) {
    locations = []
    const children = extractLocations(root).slice(0, settings.maxSitemaps)
    for (const child of children) {
      const path = toSitePath(base, child)
      if (!path) continue
      // Le sitemap enfant est relu sur le site audité, jamais sur l'hôte qu'il annonce.
      const text = await download(new URL(path, base), settings)
      locations.push(...extractLocations(text))
    }
  } else {
    locations = extractLocations(root)
  }

  const found = new Set<string>(['/'])
  for (const location of locations) {
    const path = toSitePath(base, location)
    if (path) found.add(path)
  }
  const all = Array.from(found)
  const kept = all.slice(0, options.maxPages)
  return {
    urls: kept.map((path) => new URL(path, base).href),
    dropped: all.length - kept.length,
    source: 'sitemap',
  }
}
