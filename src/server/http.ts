import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { SCREENSHOT_PATH } from '../core/capture.ts'
import { errorMessage, UserError } from '../core/errors.ts'
import { ASSETS } from '../core/paths.ts'
import { containedPath } from '../security/fs.ts'
import { DecisionError, type LiveState, REPORT_FILES } from './state.ts'

/**
 * Interface web locale de suivi et de décision.
 *
 * Sécurité :
 * - écoute uniquement sur 127.0.0.1 ;
 * - l'en-tête Host doit désigner ce serveur (parade au « DNS rebinding » :
 *   un site distant ne peut pas se faire passer pour lui) ;
 * - toute route `/api/` exige le jeton de la session, tiré au hasard au
 *   lancement et inscrit dans la page servie : un autre site ouvert dans le
 *   navigateur ne peut ni le lire ni forger de requête (pas de CORS) ;
 * - les écritures n'acceptent que du JSON, de taille bornée, validé ;
 * - seuls les fichiers du rapport (liste fermée) et les captures
 *   `preuves/<dossier>/<empreinte>.png` sont servis, jamais un chemin libre ;
 * - politique de sécurité du contenu stricte : aucun script en ligne, aucune
 *   ressource extérieure ; l'interface n'insère les données qu'en texte.
 */

export interface AuditRoutesOptions {
  state: LiveState
  outDir: string
  /** Relance un audit : `null` = tout le site, sinon les chemins donnés (fusionnés au rapport). */
  rerun?: (paths: string[] | null) => void
  /** Auteur inscrit dans les décisions prises depuis l'interface. */
  by?: string
  /**
   * Préfixe d'URL sous lequel la vue de cet audit est servie (`/audit/<id>`),
   * vide quand elle l'est à la racine. L'interface le lit pour construire ses appels.
   */
  root?: string
}

export interface UiServerOptions extends AuditRoutesOptions {
  /** Port d'écoute (0 = au hasard). Si le port est pris, un port libre est choisi. */
  port?: number
}

export interface UiServer {
  url: string
  port: number
  token: string
  close(): Promise<void>
}

/** Port proposé par défaut (un port libre est pris s'il est occupé). */
export const DEFAULT_PORT = 4747
const MAX_BODY = 16 * 1024
const UI_DIR = ASSETS.ui
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
/** Le rapport HTML porte ses styles en ligne ; il n'a ni script ni ressource extérieure. */
const REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
export const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  png: 'image/png',
}
const REPORT_NAMES = new Set(REPORT_FILES.map((file) => file.name))
/** Fichiers communs à toutes les pages de l'interface. */
export const STATIC_FILES = ['app.js', 'app.css', 'theme.js', 'accueil.js', 'accueil.css']

function extension(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1)
}

export function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  type = 'text/plain; charset=utf-8',
  csp = CSP,
): void {
  response.writeHead(status, {
    'content-type': type,
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'no-store',
  })
  response.end(body)
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), TYPES.json)
}

export function sameToken(given: string | null | undefined, token: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Corps JSON attendu.')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'Requête trop volumineuse.')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'JSON invalide.')
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function text(
  value: unknown,
  name: string,
  max: number,
  optional = false,
): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.length > max) {
    throw new HttpError(400, `Champ « ${name} » invalide.`)
  }
  return value
}

/** Fichier ordinaire (pas un lien symbolique) du dossier du rapport. */
export function readReportFile(outDir: string, relative: string): Buffer | undefined {
  try {
    const file = containedPath(outDir, ...relative.split('/'))
    const stat = lstatSync(file)
    if (!stat.isFile()) return undefined
    return readFileSync(file)
  } catch {
    return undefined
  }
}

/** Contenu d'une page de l'interface lue sur le disque. */
function readAsset(name: string): Buffer {
  return readFileSync(join(UI_DIR, name))
}

/**
 * Routes d'un audit : état, flux, décisions, relance, fichiers du rapport,
 * captures. Les chemins reçus sont relatifs à la racine de l'audit (`/api/etat`,
 * `/rapport.html`…), qu'il soit servi seul ou sous `/audit/<id>/` par le hub.
 */
export class AuditRoutes {
  private readonly clients = new Set<ServerResponse>()
  private readonly unsubscribe: () => void
  private readonly heartbeat: NodeJS.Timeout
  private readonly watcher: NodeJS.Timeout
  private readonly template = readAsset('index.html').toString('utf8')

  constructor(private readonly options: AuditRoutesOptions) {
    this.unsubscribe = options.state.subscribe((event) => {
      const line = `data: ${JSON.stringify(event)}\n\n`
      for (const client of this.clients) client.write(line)
    })
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.write(': ping\n\n')
    }, 20_000)
    this.heartbeat.unref()
    // Le journal des modifications peut être écrit par un autre processus (serveur MCP).
    this.watcher = setInterval(() => options.state.refreshChanges(), 1_500)
    this.watcher.unref()
  }

  /** Page de l'audit, avec le jeton de session et la racine des appels. */
  page(token: string): string {
    return this.template.replace('__JETON__', token).replace('__RACINE__', this.options.root ?? '')
  }

  close(): void {
    clearInterval(this.heartbeat)
    clearInterval(this.watcher)
    this.unsubscribe()
    for (const client of this.clients) client.end()
    this.clients.clear()
  }

  private openStream(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      connection: 'keep-alive',
    })
    response.write('retry: 2000\n\n')
    response.write(`data: ${JSON.stringify({ type: 'recharger' })}\n\n`)
    this.clients.add(response)
    response.on('close', () => this.clients.delete(response))
  }

  async handle(request: IncomingMessage, response: ServerResponse, route: string): Promise<void> {
    const { state, outDir, rerun, by } = this.options
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (route === '/api/etat') return json(response, 200, state.snapshot())
      if (route === '/api/flux') return this.openStream(response)
      if (route === '/api/modifications') {
        return json(response, 200, { mcp: state.isMcp, changes: state.uiChanges() })
      }
      const name = route.slice(1)
      if (REPORT_NAMES.has(name)) {
        const body = readReportFile(outDir, name)
        if (!body) throw new HttpError(404, 'Fichier pas encore écrit.')
        return send(
          response,
          200,
          body,
          TYPES[extension(name)],
          name.endsWith('.html') ? REPORT_CSP : CSP,
        )
      }
      let decoded = name
      try {
        decoded = decodeURIComponent(name)
      } catch {
        throw new HttpError(400, 'Adresse invalide.')
      }
      if (SCREENSHOT_PATH.test(decoded)) {
        const body = readReportFile(outDir, decoded)
        if (!body) throw new HttpError(404, 'Capture introuvable.')
        return send(response, 200, body, TYPES.png)
      }
      throw new HttpError(404, 'Introuvable.')
    }

    if (request.method === 'POST' && route === '/api/decision') {
      const body = (await readBody(request)) as Record<string, unknown>
      if (typeof body !== 'object' || body === null) throw new HttpError(400, 'Objet attendu.')
      const question = state.decide({
        key: text(body.key, 'key', 40) ?? '',
        answer: text(body.answer, 'answer', 100) ?? '',
        reason: text(body.reason, 'reason', 2_000, true),
        by,
      })
      return json(response, 200, { question })
    }

    if (request.method === 'POST' && route === '/api/relancer') {
      if (!rerun) throw new HttpError(501, 'Relance indisponible ici.')
      if (state.running) throw new HttpError(409, 'Un audit est déjà en cours.')
      const body = (await readBody(request)) as Record<string, unknown>
      const mode = text(body?.mode, 'mode', 20)
      let paths: string[] | null = null
      if (mode === 'decisions') paths = state.pagesToRecheck()
      else if (mode === 'pages') {
        if (!Array.isArray(body.pages) || body.pages.length === 0 || body.pages.length > 500) {
          throw new HttpError(400, 'Liste de pages invalide.')
        }
        paths = body.pages.map((item) => {
          const path = text(item, 'pages', 2_000) ?? ''
          if (!path.startsWith('/')) throw new HttpError(400, 'Chemin de page invalide.')
          return path
        })
      } else if (mode !== 'tout') throw new HttpError(400, 'Mode de relance inconnu.')
      if (paths && paths.length === 0) throw new HttpError(400, 'Aucune page à relancer.')
      rerun(paths)
      return json(response, 202, { started: true, pages: paths })
    }

    throw new HttpError(405, 'Méthode non admise.')
  }
}

/** Requête déjà contrôlée (hôte, jeton, origine) : à la route de répondre. */
export interface LocalRequest {
  request: IncomingMessage
  response: ServerResponse
  /** Chemin de l'URL, sans la requête. */
  route: string
  url: URL
}

export interface LocalServerOptions {
  /** Port d'écoute (0 = au hasard). Si le port est pris, un port libre est choisi. */
  port?: number
  /** Répond à la requête (ou lève `HttpError`). */
  handle: (context: LocalRequest, token: string) => Promise<void> | void
  /** Libère ce que le serveur tient (flux, minuteries) à la fermeture. */
  onClose?: () => void
  /** Fichiers servis tels quels à la racine (`/app.js`…). */
  statics?: readonly string[]
}

/**
 * Serveur HTTP local commun à la vue d'un audit et au hub : écoute sur
 * 127.0.0.1, contrôle l'hôte (anti « DNS rebinding »), exige le jeton et une
 * origine identique pour toute route `api/`, répond aux erreurs en JSON.
 */
export async function listenLocal(options: LocalServerOptions): Promise<UiServer> {
  const token = randomBytes(24).toString('base64url')
  const statics = new Map(
    Array.from(options.statics ?? STATIC_FILES, (name) => [name, readAsset(name)] as const),
  )
  let allowedHosts = new Set<string>()

  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? ''
      if (!allowedHosts.has(host)) throw new HttpError(421, 'Hôte refusé.')
      const url = new URL(request.url ?? '/', `http://${host}`)
      const route = url.pathname

      if (/(^|\/)api\//.test(route)) {
        const given = request.headers['x-rgaa-jeton']
        const candidate = typeof given === 'string' ? given : url.searchParams.get('jeton')
        if (!sameToken(candidate, token))
          throw new HttpError(403, 'Jeton de session absent ou faux.')
        const origin = request.headers.origin
        if (origin && origin !== `http://${host}`) throw new HttpError(403, 'Origine refusée.')
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        const asset = statics.get(route.slice(1))
        if (asset) return send(response, 200, asset, TYPES[extension(route)])
      }
      await options.handle({ request, response, route, url }, token)
    } catch (error) {
      if (response.headersSent) return response.end()
      if (error instanceof HttpError) return json(response, error.status, { error: error.message })
      if (error instanceof DecisionError || error instanceof UserError) {
        return json(response, 400, { error: error.message })
      }
      return json(response, 500, { error: errorMessage(error).slice(0, 500) })
    }
  })

  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve((server.address() as AddressInfo).port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  // Port pris : les suivants (4747 → 4748…) avant un port au hasard, pour rester prévisible.
  let port = -1
  const wanted = options.port ?? 0
  const candidates = wanted > 0 ? [...Array.from({ length: 10 }, (_, i) => wanted + i), 0] : [0]
  for (const candidate of candidates) {
    if (candidate > 65_535) continue
    try {
      port = await listen(candidate)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  if (port < 0) throw new UserError('Aucun port disponible pour l’interface.')
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    close: async () => {
      options.onClose?.()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}

/** Interface d'un seul audit (`rgaa audit --serve`, `rgaa serve`, `rgaa mcp --serve`). */
export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const routes = new AuditRoutes(options)
  return listenLocal({
    port: options.port,
    onClose: () => routes.close(),
    handle: async ({ request, response, route }, token) => {
      if ((request.method === 'GET' || request.method === 'HEAD') && route === '/') {
        return send(response, 200, routes.page(token), TYPES.html)
      }
      return routes.handle(request, response, route)
    },
  })
}
