import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AuditLibrary, parseNewAudit } from '../app/library.ts'
import { UserError } from '../core/errors.ts'
import { ASSETS } from '../core/paths.ts'
import { CAPTURE_MODES } from '../core/runner.ts'
import {
  AuditRoutes,
  HttpError,
  json,
  listenLocal,
  readBody,
  send,
  TYPES,
  type UiServer,
} from './http.ts'

/**
 * Site complet : une page d'accueil qui liste les audits déjà faits et lance
 * une nouvelle analyse, et, pour chaque audit, la vue détaillée habituelle
 * servie sous `/audit/<id>/`. Même serveur, mêmes protections que la vue d'un
 * seul audit (hôte, jeton, origine, politique de sécurité du contenu).
 */

export interface HubOptions {
  library: AuditLibrary
  /** Port d'écoute (0 = au hasard). Si le port est pris, un port libre est choisi. */
  port?: number
  /** Auteur inscrit dans les décisions prises depuis l'interface. */
  by?: string
}

const AUDIT_ROUTE = /^\/audit\/([^/]+)(\/.*)?$/

export async function startHub(options: HubOptions): Promise<UiServer> {
  const { library } = options
  const home = readFileSync(join(ASSETS.ui, 'accueil.html'), 'utf8')
  const views = new Map<string, AuditRoutes>()

  /** Vue d'un audit, ouverte à la première visite. */
  function view(id: string): AuditRoutes {
    const known = views.get(id)
    if (known) return known
    let controller: ReturnType<AuditLibrary['open']>
    try {
      controller = library.open(id)
    } catch (error) {
      if (error instanceof UserError) throw new HttpError(404, error.message)
      throw error
    }
    const routes = new AuditRoutes({
      state: controller.state,
      outDir: controller.config.outDir,
      by: options.by,
      root: `/audit/${encodeURIComponent(id)}`,
      rerun: (paths) => {
        const busy = library.running
        if (busy && busy !== id) throw new HttpError(409, 'Une autre analyse est en cours.')
        controller.rerun(paths)
      },
    })
    views.set(id, routes)
    return routes
  }

  return listenLocal({
    port: options.port,
    onClose: () => {
      for (const routes of views.values()) routes.close()
      views.clear()
    },
    handle: async ({ request, response, route }, token) => {
      const read = request.method === 'GET' || request.method === 'HEAD'

      if (read && route === '/') {
        return send(response, 200, home.replace('__JETON__', token), TYPES.html)
      }

      if (route === '/api/audits') {
        if (read) {
          return json(response, 200, {
            running: library.running,
            audits: library.list(),
            themes: Array.from(library.catalog.themes, ([id, label]) => ({ id, label })).sort(
              (a, b) => a.id - b.id,
            ),
            defaults: {
              limit: library.defaults.limit,
              captures: library.defaults.captures,
              captureModes: CAPTURE_MODES,
            },
          })
        }
        if (request.method === 'POST') {
          const created = library.create(parseNewAudit(await readBody(request), library.catalog))
          return json(response, 201, {
            ...created,
            url: `/audit/${encodeURIComponent(created.id)}/`,
          })
        }
        throw new HttpError(405, 'Méthode non admise.')
      }

      const match = AUDIT_ROUTE.exec(route)
      if (match) {
        let id: string
        try {
          id = decodeURIComponent(match[1] ?? '')
        } catch {
          throw new HttpError(400, 'Adresse invalide.')
        }
        const rest = match[2]
        if (rest === undefined) {
          response.writeHead(308, { location: `${route}/` })
          response.end()
          return
        }
        const routes = view(id)
        if (read && rest === '/') return send(response, 200, routes.page(token), TYPES.html)
        return routes.handle(request, response, rest)
      }

      throw new HttpError(404, 'Introuvable.')
    },
  })
}
