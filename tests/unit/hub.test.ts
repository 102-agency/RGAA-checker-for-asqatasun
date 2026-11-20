import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditLibrary, parseNewAudit, siteSlug } from '../../src/app/library.ts'
import { loadCatalog } from '../../src/core/catalog.ts'
import type { AuditResult } from '../../src/core/runner.ts'
import type { PageReport } from '../../src/core/types.ts'
import { buildReport, type ReportDocument } from '../../src/report/model.ts'
import { writeReport } from '../../src/report/write.ts'
import type { UiServer } from '../../src/server/http.ts'
import { startHub } from '../../src/server/hub.ts'

const catalog = loadCatalog()

function page(path: string, status: 'C' | 'NC' = 'C'): PageReport {
  return {
    url: `https://exemple.fr${path}`,
    path,
    httpStatus: 200,
    results: {
      '2.1.1': {
        test: '2.1.1',
        status,
        failures:
          status === 'NC'
            ? [
                {
                  id: 'cccccccccccc',
                  message: 'Cadre sans titre',
                  selector: 'iframe',
                  snippet: '<iframe>',
                },
              ]
            : [],
        failureCount: status === 'NC' ? 1 : 0,
        pending: [],
        notes: [],
        checked: 1,
      },
    },
  }
}

function report(
  startedAt: string,
  pages: PageReport[],
  decisionsDir = '/nulle-part',
): ReportDocument {
  const audit: AuditResult = { pages, pending: [] }
  return buildReport({
    audit,
    catalog,
    asqatasun: new Map(),
    filter: (test) => test === '2.1.1',
    tool: { name: 'rgaa-checker', version: 'test' },
    meta: {
      baseUrl: 'https://exemple.fr/',
      startedAt,
      durationMs: 1000,
      pagesSource: 'sitemap',
      pagesDropped: 0,
      scope: { themes: [], criteria: [], tests: [] },
      decisionsDir,
      decisionsCount: 0,
      unusedDecisions: null,
      asqatasunDir: null,
      asqatasunReports: 0,
      strict: false,
    },
  })
}

function library(root: string, extra?: ConstructorParameters<typeof AuditLibrary>[0]['extra']) {
  return new AuditLibrary({
    root,
    extra,
    // Dossier de bibliothèques absent : un audit lancé échoue aussitôt, sans navigateur.
    defaults: {
      concurrency: 1,
      captures: 'aucune',
      limit: 50,
      sandbox: true,
      browserLibs: '/nulle-part/libs',
    },
  })
}

describe('formulaire « nouvelle analyse »', () => {
  it('valide et normalise la saisie', () => {
    const input = parseNewAudit(
      {
        url: ' https://www.exemple.fr ',
        pages: '/\n/contact, /contact\n',
        themes: [3, 1, 3],
        limit: '20',
        captures: 'doutes',
        cookies: 'a=1\nb=2',
      },
      catalog,
    )
    expect(input).toMatchObject({
      url: 'https://www.exemple.fr',
      pages: ['/', '/contact'],
      themes: [1, 3],
      limit: 20,
      captures: 'doutes',
      cookies: ['a=1', 'b=2'],
      reuseDecisions: true,
    })
  })

  it('refuse ce qui n’a pas de sens, avec un message', () => {
    const refuse = (body: unknown) => () => parseNewAudit(body, catalog)
    expect(refuse(null)).toThrow(/invalide/)
    expect(refuse({})).toThrow(/adresse/)
    expect(refuse({ url: 'file:///etc/passwd' })).toThrow(/Schéma refusé/)
    expect(refuse({ url: 'https://u:p@exemple.fr' })).toThrow(/Identifiants/)
    expect(refuse({ url: 'https://exemple.fr', themes: [14] })).toThrow(/Thématique/)
    expect(refuse({ url: 'https://exemple.fr', themes: 'a' })).toThrow(/thématiques/)
    expect(refuse({ url: 'https://exemple.fr', limit: 0 })).toThrow(/entre 1 et 10 000/)
    expect(refuse({ url: 'https://exemple.fr', captures: 'toutes' })).toThrow(/Captures/)
    expect(refuse({ url: 'https://exemple.fr', pages: 12 })).toThrow(/pages/)
  })

  it('nomme le dossier d’après l’hôte, sans caractère douteux', () => {
    expect(siteSlug(new URL('https://www.Exemple.fr/chemin'))).toBe('www-exemple-fr')
    expect(siteSlug(new URL('http://localhost:3000'))).toBe('localhost-3000')
    expect(siteSlug(new URL('http://[::1]:8080'))).toMatch(/^[a-z0-9-]+$/)
  })
})

describe('bibliothèque d’audits', () => {
  let root: string
  let outside: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rgaa-lib-'))
    outside = mkdtempSync(join(tmpdir(), 'rgaa-lib-hors-'))
    // Disposition à plat, la plus ancienne.
    writeReport(
      join(root, 'ancien'),
      report('2026-01-01T10:00:00.000Z', [page('/', 'NC')]),
      catalog,
    )
    // Disposition `rapport/` + `decisions/`.
    mkdirSync(join(root, 'recent', 'decisions'), { recursive: true })
    writeFileSync(
      join(root, 'recent', 'decisions', 'frame.title.json'),
      JSON.stringify({ topic: 'frame.title', entries: {} }),
    )
    writeReport(
      join(root, 'recent', 'rapport'),
      report('2026-02-01T10:00:00.000Z', [page('/'), page('/contact')]),
      catalog,
    )
    // Rapport abîmé, dossier sans rapport, dossier caché : seul le premier est listé.
    mkdirSync(join(root, 'casse'))
    writeFileSync(join(root, 'casse', 'rapport.json'), '{ pas du json')
    mkdirSync(join(root, 'vide'))
    mkdirSync(join(root, '.cache'))
    writeReport(join(root, '.cache'), report('2026-03-01T10:00:00.000Z', [page('/')]), catalog)
    // Rapport du CLI, hors du dossier des audits.
    writeReport(outside, report('2026-01-15T10:00:00.000Z', [page('/')]), catalog)
  })

  it('reconnaît les deux dispositions et les rapports hors dossier, du plus récent au plus ancien', () => {
    const list = library(root, [
      { id: 'rgaa-report', reportDir: outside, decisionsDir: join(outside, 'decisions') },
    ]).list()
    expect(list.map((audit) => audit.id)).toEqual(['recent', 'rgaa-report', 'ancien', 'casse'])
    const [recent, , ancien, casse] = list
    expect(recent).toMatchObject({
      status: 'termine',
      pages: 2,
      host: 'exemple.fr',
      partial: false,
    })
    expect(ancien?.states['non-conforme']).toBe(1)
    expect(casse).toMatchObject({ status: 'illisible', pages: 0 })
    expect(casse?.message).toBeTruthy()
  })

  it('ouvre un audit à la demande, avec ses décisions, et refuse un autre nom', () => {
    const lib = library(root)
    const controller = lib.open('recent')
    expect(controller.state.lastReport?.pages).toHaveLength(2)
    expect(controller.config.decisionsDir).toBe(join(root, 'recent', 'decisions'))
    expect(lib.open('recent')).toBe(controller)
    expect(() => lib.open('../ancien')).toThrow(/introuvable/)
    expect(() => lib.open('.cache')).toThrow(/introuvable/)
    expect(() => lib.open('casse')).toThrow(/illisible/)
  })

  it('crée un audit daté par jour, reprend les décisions du précédent et ne mélange pas les sites', async () => {
    const lib = library(root)
    const first = lib.create(parseNewAudit({ url: 'https://exemple.fr', pages: '/' }, catalog))
    expect(first.id).toMatch(/^exemple-fr-\d{4}-\d{2}-\d{2}$/)
    // L'audit précédent de ce site a un dossier de décisions : il est copié.
    expect(first.reused).toBe(1)
    expect(readdirSync(join(root, first.id, 'decisions'))).toEqual(['frame.title.json'])
    // Navigateur impossible à lancer : l'audit échoue, l'accueil le dit.
    await new Promise((done) => setTimeout(done, 300))
    expect(lib.list().find((audit) => audit.id === first.id)).toMatchObject({ status: 'erreur' })

    const second = lib.create(
      parseNewAudit({ url: 'https://exemple.fr', pages: '/', reuseDecisions: false }, catalog),
    )
    expect(second.id).toBe(`${first.id}-2`)
    expect(second.reused).toBe(0)
    expect(existsSync(join(root, second.id, 'decisions'))).toBe(false)

    await new Promise((done) => setTimeout(done, 300))
    const other = lib.create(parseNewAudit({ url: 'https://autre.fr', pages: '/' }, catalog))
    expect(other.reused).toBe(0)
  })

  it('refuse une page d’un autre site et un cookie mal formé avant de créer quoi que ce soit', () => {
    const lib = library(root)
    const before = readdirSync(root).sort()
    expect(() =>
      lib.create(
        parseNewAudit({ url: 'https://exemple.fr', pages: 'https://autre.fr/x' }, catalog),
      ),
    ).toThrow(/n'est pas sur le site/)
    expect(() =>
      lib.create(parseNewAudit({ url: 'https://exemple.fr', cookies: 'sans-valeur' }, catalog)),
    ).toThrow(/Cookie invalide/)
    expect(() =>
      lib.create(
        parseNewAudit(
          { url: 'https://exemple.fr', asqatasunDir: join(root, 'nulle-part') },
          catalog,
        ),
      ),
    ).toThrow(/Asqatasun/)
    expect(readdirSync(root).sort()).toEqual(before)
  })
})

describe('site complet (accueil + audits)', () => {
  let root: string
  let server: UiServer
  let lib: AuditLibrary

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'rgaa-hub-'))
    writeReport(
      join(root, 'exemple'),
      report('2026-02-01T10:00:00.000Z', [page('/', 'NC')]),
      catalog,
    )
    writeFileSync(join(root, 'secret.txt'), 'secret')
    lib = library(root)
    server = await startHub({ library: lib, port: 0, by: 'test' })
  })
  afterAll(async () => {
    await server.close()
  })

  const raw = (
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: server.port,
            path,
            method: options.method ?? 'GET',
            headers: options.headers,
          },
          (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => {
              body += chunk
            })
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
            )
          },
        )
        req.on('error', reject)
        req.end(options.body)
      },
    )
  const authed = (extra: Record<string, string> = {}) => ({
    'x-rgaa-jeton': server.token,
    ...extra,
  })

  it('sert l’accueil avec le jeton, une politique de sécurité stricte et ses fichiers', async () => {
    const home = await raw('/')
    expect(home.status).toBe(200)
    expect(home.body).toContain(server.token)
    expect(home.body).toContain('Nouvelle analyse')
    expect(String(home.headers['content-security-policy'])).toContain("script-src 'self'")
    for (const file of ['/accueil.js', '/accueil.css', '/app.js', '/app.css', '/theme.js']) {
      expect((await raw(file)).status).toBe(200)
    }
  })

  it('exige le jeton, le bon hôte et la bonne origine', async () => {
    expect((await raw('/api/audits')).status).toBe(403)
    expect((await raw('/audit/exemple/api/etat')).status).toBe(403)
    expect((await raw('/', { headers: { host: 'attaquant.example' } })).status).toBe(421)
    const foreign = await raw('/api/audits', {
      headers: authed({ origin: 'https://attaquant.example' }),
    })
    expect(foreign.status).toBe(403)
    const post = await raw('/api/audits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://exemple.fr' }),
    })
    expect(post.status).toBe(403)
  })

  it('liste les audits et les thématiques du formulaire', async () => {
    const response = await raw('/api/audits', { headers: authed() })
    expect(response.status).toBe(200)
    const data = JSON.parse(response.body)
    expect(data.running).toBeNull()
    expect(data.audits.map((audit: { id: string }) => audit.id)).toEqual(['exemple'])
    expect(data.themes).toHaveLength(13)
    expect(data.defaults.captureModes).toEqual(['tout', 'doutes', 'aucune'])
  })

  it('sert chaque audit sous /audit/<id>/ et rien d’autre', async () => {
    const redirect = await raw('/audit/exemple')
    expect(redirect.status).toBe(308)
    expect(redirect.headers.location).toBe('/audit/exemple/')

    const view = await raw('/audit/exemple/')
    expect(view.status).toBe(200)
    expect(view.body).toContain('name="rgaa-racine" content="/audit/exemple"')
    expect(view.body).toContain(server.token)

    const state = await raw('/audit/exemple/api/etat', { headers: authed() })
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body).pages).toHaveLength(1)
    expect((await raw('/audit/exemple/a-corriger.md')).status).toBe(200)
    expect((await raw('/audit/exemple/secret.txt')).status).toBe(404)
    // L'URL est normalisée avant le routage : on ne sort jamais du dossier de l'audit.
    const climb = await raw('/audit/exemple/preuves/../../secret.txt')
    expect(climb.status).not.toBe(200)
    expect(climb.body).not.toContain('secret')

    expect((await raw('/audit/inconnu/')).status).toBe(404)
    expect((await raw('/audit/..%2F/')).status).toBe(404)
    expect((await raw('/audit/%E0%A4%A/')).status).toBe(400)
    expect((await raw('/secret.txt')).status).toBe(404)
  })

  it('refuse un formulaire invalide sans rien créer', async () => {
    const before = readdirSync(root).sort()
    const post = (body: unknown) =>
      raw('/api/audits', {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      })
    const bad = await post({ url: 'ftp://exemple.fr' })
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.body).error).toMatch(/Schéma refusé/)
    expect((await post({})).status).toBe(400)
    expect(
      (
        await raw('/api/audits', {
          method: 'POST',
          headers: authed({ 'content-type': 'text/plain' }),
          body: '{}',
        })
      ).status,
    ).toBe(415)
    expect((await raw('/api/audits', { method: 'DELETE', headers: authed() })).status).toBe(405)
    expect(readdirSync(root).sort()).toEqual(before)
  })

  it('lance une analyse depuis le formulaire et renvoie l’adresse de son suivi', async () => {
    const created = await raw('/api/audits', {
      method: 'POST',
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ url: 'https://exemple.fr', pages: '/', reuseDecisions: false }),
    })
    expect(created.status).toBe(201)
    const { id, url } = JSON.parse(created.body)
    expect(url).toBe(`/audit/${id}/`)
    // L'audit est ouvrable aussitôt, même sans rapport écrit.
    const state = await raw(`/audit/${id}/api/etat`, { headers: authed() })
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body).site).toBe('https://exemple.fr/')
  })
})
