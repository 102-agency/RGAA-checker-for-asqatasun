import { type DefaultTreeAdapterMap, parse } from 'parse5'
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
  /** Durée maximale de l'exploration des liens, en millisecondes. */
  crawlBudgetMs?: number
}

export interface DiscoveredPages {
  urls: string[]
  /** Pages du sitemap écartées par le plafond `maxPages`. */
  dropped: number
  source: 'arguments' | 'sitemap'
  /** Comment les pages ont été trouvées quand il n'y a pas d'arguments : sitemap, ou exploration des liens. */
  via?: 'sitemap' | 'liens'
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

type DownloadOptions = Required<Omit<SitemapOptions, 'maxPages' | 'crawlBudgetMs'>>

/** Sitemap absent ou injoignable (par opposition à un sitemap refusé : trop gros…). */
class SitemapMissing extends UserError {}

async function download(url: URL, options: DownloadOptions): Promise<string> {
  const response = await options.fetch(url, {
    signal: AbortSignal.timeout(options.timeoutMs),
    redirect: 'follow',
    headers: { accept: 'application/xml, text/xml;q=0.9, */*;q=0.1' },
  })
  if (!response.ok) {
    throw new SitemapMissing(
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

/** Télécharge un sitemap ; une page qui n'en est pas un (HTML d'erreur, redirection vers l'accueil) compte comme absent. */
async function downloadSitemap(url: URL, options: DownloadOptions): Promise<string> {
  const text = await download(url, options)
  if (!/<(?:urlset|sitemapindex)[\s>]/i.test(text)) {
    throw new SitemapMissing(
      `Sitemap ${url.pathname} introuvable (le contenu n'est pas un sitemap) : donner les chemins à auditer en arguments.`,
    )
  }
  return text
}

/** Sitemaps annoncés par `robots.txt` (`Sitemap: <url>`), ramenés à des chemins du site audité. */
async function robotsSitemaps(base: URL, settings: DownloadOptions): Promise<string[]> {
  try {
    const text = await download(new URL('/robots.txt', base), { ...settings, maxBytes: 512 * 1024 })
    const paths: string[] = []
    for (const match of text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
      try {
        // L'hôte annoncé est ignoré (comme pour le sitemap lui-même) ; la requête, elle, compte.
        const url = new URL(match[1] ?? '', base)
        const path = `${url.pathname}${url.search}`
        if (path !== '/sitemap.xml') paths.push(path)
      } catch {
        // Ligne inutilisable : on passe à la suivante.
      }
    }
    return paths.slice(0, 3)
  } catch {
    return []
  }
}

/** Sitemap racine : `/sitemap.xml`, sinon ceux de `robots.txt`. */
async function readRootSitemap(base: URL, settings: DownloadOptions): Promise<string> {
  const first = new URL('/sitemap.xml', base)
  try {
    return await downloadSitemap(first, settings)
  } catch (error) {
    if (!(error instanceof SitemapMissing) && error instanceof UserError) throw error
    for (const path of await robotsSitemaps(base, settings)) {
      try {
        return await downloadSitemap(new URL(path, base), settings)
      } catch (next) {
        if (!(next instanceof SitemapMissing)) throw next
      }
    }
    if (error instanceof SitemapMissing) throw error
    throw new SitemapMissing(
      `Impossible de lire ${first.href} (${error instanceof Error ? error.message : String(error)}). Le site est-il démarré ? Sinon, donner les chemins à auditer en arguments.`,
    )
  }
}

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

const NOT_A_PAGE =
  /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|gz|rar|7z|png|jpe?g|gif|webp|svg|avif|ico|bmp|mp[34]|webm|mov|avi|wav|ogg|css|js|mjs|json|xml|rss|atom|txt|csv|woff2?|ttf|eot)$/i
const MAX_PAGE_BYTES = 2 * 1024 * 1024
const CRAWL_CONCURRENCY = 4
const CRAWL_PAGE_TIMEOUT_MS = 15_000

/** Cibles des liens `<a href>` d'une page HTML. */
function pageLinks(html: string): string[] {
  const links: string[] = []
  const visit = (node: Node): void => {
    if ('tagName' in node) {
      const element = node as Element
      if (element.tagName === 'a') {
        const href = element.attrs.find((attr) => attr.name === 'href')?.value
        if (href) links.push(href)
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child)
  }
  visit(parse(html))
  return links
}

/** Lit une page HTML (taille et durée bornées) ; `null` si ce n'en est pas une. */
async function fetchHtml(
  url: URL,
  fetcher: typeof fetch,
): Promise<{ html: string; finalUrl: URL } | null> {
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(CRAWL_PAGE_TIMEOUT_MS),
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
    })
    const type = response.headers.get('content-type') ?? ''
    if (!response.ok || !response.body || !/html/i.test(type)) {
      await response.body?.cancel()
      return null
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_PAGE_BYTES) {
        await reader.cancel()
        break
      }
      chunks.push(value)
    }
    return {
      html: Buffer.concat(chunks).toString('utf8'),
      finalUrl: new URL(response.url || url.href),
    }
  } catch {
    return null
  }
}

/**
 * Exploration des liens quand le site n'a pas de sitemap : on part de
 * l'adresse donnée, on suit les liens internes de page en page (largeur
 * d'abord), sans sortir du site ni, si l'adresse a un chemin (`/fr/`), de cette
 * partie du site. Borné en nombre de pages, en taille et en durée.
 */
async function crawl(
  base: URL,
  maxPages: number,
  options: { fetch: typeof fetch; budgetMs: number },
): Promise<{ urls: string[]; dropped: number }> {
  const startPath = canonicalPath(base)
  const section = startPath === '/' ? '' : startPath
  const inScope = (path: string) => !section || path === section || path.startsWith(`${section}/`)
  const deadline = Date.now() + options.budgetMs

  const known = new Set<string>([startPath])
  const confirmed: string[] = []
  const queue: string[] = [startPath]
  let dropped = 0
  let running = 0

  const worker = async (): Promise<void> => {
    while (Date.now() < deadline && confirmed.length < maxPages) {
      const path = queue.shift()
      if (path === undefined) {
        // File vide : un autre travailleur peut encore y ajouter des liens.
        if (running === 0) return
        await new Promise((done) => setTimeout(done, 25))
        continue
      }
      running += 1
      try {
        const page = await fetchHtml(new URL(path, base), options.fetch)
        if (!page || page.finalUrl.origin !== base.origin) continue
        const finalPath = canonicalPath(page.finalUrl)
        if (finalPath !== path) {
          // Redirigée : on ne garde que la destination, si elle est dans le périmètre.
          if (!inScope(finalPath) || confirmed.includes(finalPath)) continue
          known.add(finalPath)
        }
        if (confirmed.length >= maxPages) {
          dropped += 1
          continue
        }
        confirmed.push(finalPath)
        for (const href of pageLinks(page.html)) {
          let target: URL
          try {
            target = new URL(href, page.finalUrl)
          } catch {
            continue
          }
          if (!/^https?:$/.test(target.protocol) || target.origin !== base.origin) continue
          const next = canonicalPath(target).replace(/^\/{2,}/, '/')
          if (NOT_A_PAGE.test(next) || !inScope(next) || known.has(next)) continue
          known.add(next)
          queue.push(next)
        }
      } finally {
        running -= 1
      }
    }
  }
  await Promise.all(Array.from({ length: CRAWL_CONCURRENCY }, worker))
  // Pages repérées mais non visitées (plafond ou durée atteints).
  dropped += queue.length
  confirmed.sort()
  return {
    urls: confirmed.map((path) => new URL(path, base).href),
    dropped,
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
    root = await readRootSitemap(base, settings)
  } catch (error) {
    if (!(error instanceof SitemapMissing)) throw error
    // Pas de sitemap : on suit les liens à partir de l'adresse donnée.
    const crawled = await crawl(base, options.maxPages, {
      fetch: settings.fetch,
      budgetMs: options.crawlBudgetMs ?? 90_000,
    })
    if (crawled.urls.length === 0) throw error
    return {
      urls: crawled.urls,
      dropped: crawled.dropped,
      source: 'sitemap',
      via: 'liens',
    }
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
    via: 'sitemap',
  }
}
