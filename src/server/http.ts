import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { SCREENSHOT_PATH } from '../core/capture.ts'
import { errorMessage } from '../core/errors.ts'
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

export interface UiServerOptions {
  state: LiveState
  outDir: string
  /** Port d'écoute (0 = au hasard). Si le port est pris, un port libre est choisi. */
  port?: number
  /** Relance un audit : `null` = tout le site, sinon les chemins donnés (fusionnés au rapport). */
  rerun?: (paths: string[] | null) => void
  /** Auteur inscrit dans les décisions prises depuis l'interface. */
  by?: string
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
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
/** Le rapport HTML porte ses styles en ligne ; il n'a ni script ni ressource extérieure. */
const REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  png: 'image/png',
}
const REPORT_NAMES = new Set(REPORT_FILES.map((file) => file.name))
const STATIC = new Set(['app.js', 'app.css'])

function extension(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1)
}

function send(
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

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), TYPES.json)
}

function sameToken(given: string | null | undefined, token: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readBody(request: IncomingMessage): Promise<unknown> {
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function text(value: unknown, name: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.length > max) {
    throw new HttpError(400, `Champ « ${name} » invalide.`)
  }
  return value
}

/** Fichier ordinaire (pas un lien symbolique) du dossier du rapport. */
function readReportFile(outDir: string, relative: string): Buffer | undefined {
  try {
    const file = containedPath(outDir, ...relative.split('/'))
    const stat = lstatSync(file)
    if (!stat.isFile()) return undefined
    return readFileSync(file)
  } catch {
    return undefined
  }
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const token = randomBytes(24).toString('base64url')
  const page = readFileSync(join(UI_DIR, 'index.html'), 'utf8').replace('__JETON__', token)
  const statics = new Map(
    Array.from(STATIC, (name) => [name, readFileSync(join(UI_DIR, name))] as const),
  )
  const clients = new Set<ServerResponse>()
  let allowedHosts = new Set<string>()

  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? ''
      if (!allowedHosts.has(host)) throw new HttpError(421, 'Hôte refusé.')
      const url = new URL(request.url ?? '/', `http://${host}`)
      const route = url.pathname

      if (route.startsWith('/api/')) {
        const given = request.headers['x-rgaa-jeton']
        const candidate = typeof given === 'string' ? given : url.searchParams.get('jeton')
        if (!sameToken(candidate, token))
          throw new HttpError(403, 'Jeton de session absent ou faux.')
        const origin = request.headers.origin
        if (origin && origin !== `http://${host}`) throw new HttpError(403, 'Origine refusée.')
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        if (route === '/') return send(response, 200, page, TYPES.html)
        const name = route.slice(1)
        const asset = statics.get(name)
        if (asset) return send(response, 200, asset, TYPES[extension(name)])
        if (route === '/api/etat') return json(response, 200, options.state.snapshot())
        if (route === '/api/flux') return openStream(response)
        if (REPORT_NAMES.has(name)) {
          const body = readReportFile(options.outDir, name)
          if (!body) throw new HttpError(404, 'Fichier pas encore écrit.')
          return send(
            response,
            200,
            body,
            TYPES[extension(name)],
            name.endsWith('.html') ? REPORT_CSP : CSP,
          )
        }
        if (SCREENSHOT_PATH.test(decodeURIComponent(name))) {
          const body = readReportFile(options.outDir, decodeURIComponent(name))
          if (!body) throw new HttpError(404, 'Capture introuvable.')
          return send(response, 200, body, TYPES.png)
        }
        throw new HttpError(404, 'Introuvable.')
      }

      if (request.method === 'POST' && route === '/api/decision') {
        const body = (await readBody(request)) as Record<string, unknown>
        if (typeof body !== 'object' || body === null) throw new HttpError(400, 'Objet attendu.')
        const question = options.state.decide({
          key: text(body.key, 'key', 40) ?? '',
          answer: text(body.answer, 'answer', 100) ?? '',
          reason: text(body.reason, 'reason', 2_000, true),
          by: options.by,
        })
        return json(response, 200, { question })
      }

      if (request.method === 'POST' && route === '/api/relancer') {
        if (!options.rerun) throw new HttpError(501, 'Relance indisponible ici.')
        if (options.state.running) throw new HttpError(409, 'Un audit est déjà en cours.')
        const body = (await readBody(request)) as Record<string, unknown>
        const mode = text(body?.mode, 'mode', 20)
        let paths: string[] | null = null
        if (mode === 'decisions') paths = options.state.pagesToRecheck()
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
        options.rerun(paths)
        return json(response, 202, { started: true, pages: paths })
      }

      throw new HttpError(405, 'Méthode non admise.')
    } catch (error) {
      if (response.headersSent) return response.end()
      if (error instanceof HttpError) return json(response, error.status, { error: error.message })
      if (error instanceof DecisionError) return json(response, 400, { error: error.message })
      return json(response, 500, { error: errorMessage(error).slice(0, 500) })
    }
  })

  function openStream(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      connection: 'keep-alive',
    })
    response.write('retry: 2000\n\n')
    response.write(`data: ${JSON.stringify({ type: 'recharger' })}\n\n`)
    clients.add(response)
    response.on('close', () => clients.delete(response))
  }

  const unsubscribe = options.state.subscribe((event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const client of clients) client.write(line)
  })
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n')
  }, 20_000)
  heartbeat.unref()

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
  let port: number
  try {
    port = await listen(options.port ?? 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    port = await listen(0)
  }
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    close: async () => {
      clearInterval(heartbeat)
      unsubscribe()
      for (const client of clients) client.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
