import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { answerGroups, answerMeaning, isAdmitted } from '../../src/core/answers.ts'
import { loadCatalog } from '../../src/core/catalog.ts'
import { type Decision, DecisionStore } from '../../src/core/decisions.ts'
import type { AuditResult } from '../../src/core/runner.ts'
import type { PageReport, TestResult } from '../../src/core/types.ts'
import { serveMcp } from '../../src/mcp/protocol.ts'
import { RgaaTools } from '../../src/mcp/tools.ts'
import { buildToFix, renderFullResults, renderToFixMarkdown } from '../../src/report/ai.ts'
import { mergeReports } from '../../src/report/merge.ts'
import { buildReport, type ReportDocument } from '../../src/report/model.ts'
import { writeReport } from '../../src/report/write.ts'
import { startUiServer, type UiServer } from '../../src/server/http.ts'
import { LiveState } from '../../src/server/state.ts'

const catalog = loadCatalog()
const HOSTILE = '<script>alert(1)</script> [x](javascript:alert(1)) `a` *gras*'
const KEY = 'bbbbbbbbbbbb'
const SHOT = 'preuves/echecs/cccccccccccc.png'

function result(test: string, partial: Partial<TestResult>): TestResult {
  return {
    test,
    status: 'C',
    failures: [],
    failureCount: 0,
    pending: [],
    notes: [],
    checked: 1,
    ...partial,
  }
}

function page(path: string, alt: 'NC' | 'C' = 'NC'): PageReport {
  return {
    url: `https://exemple.fr${path}`,
    path,
    httpStatus: 200,
    results: {
      '1.1.1':
        alt === 'NC'
          ? result('1.1.1', {
              status: 'NC',
              failureCount: 1,
              failures: [
                {
                  id: 'cccccccccccc',
                  message: `Image sans alternative ${HOSTILE}`,
                  selector: 'body > header > img',
                  snippet: '<img src="logo.png">',
                  screenshot: SHOT,
                },
              ],
            })
          : result('1.1.1', { status: 'C' }),
      '2.1.1': result('2.1.1', { status: 'C' }),
      '2.2.1': result('2.2.1', {
        status: 'AV',
        pending: [
          {
            topic: 'frame.title',
            key: KEY,
            question: 'Ce titre de cadre est-il pertinent ?',
            answers: ['pass', 'fail'],
            evidence: { title: 'Carte' },
          },
        ],
      }),
    },
  }
}

function report(pages: PageReport[]): ReportDocument {
  const audit: AuditResult = {
    pages,
    pending: [
      {
        topic: 'frame.title',
        key: KEY,
        question: 'Ce titre de cadre est-il pertinent ?',
        answers: ['pass', 'fail'],
        evidence: { title: 'Carte' },
        selector: 'iframe',
        tests: ['2.2.1'],
        pages: pages.map((item) => item.url),
      },
    ],
  }
  return buildReport({
    audit,
    catalog,
    asqatasun: new Map(),
    filter: (test) => ['1.1.1', '2.1.1', '2.2.1'].includes(test),
    tool: { name: 'rgaa-checker', version: 'test' },
    meta: {
      baseUrl: 'https://exemple.fr/',
      startedAt: '2026-01-01T10:00:00.000Z',
      durationMs: 1000,
      pagesSource: 'sitemap',
      pagesDropped: 0,
      scope: { themes: [], criteria: [], tests: [] },
      decisionsDir: '/nulle-part',
      decisionsCount: 0,
      unusedDecisions: null,
      asqatasunDir: null,
      asqatasunReports: 0,
      strict: false,
    },
  })
}

function decision(answer: string): Decision {
  return {
    answer,
    evidence: { title: 'Carte' },
    question: 'Ce titre de cadre est-il pertinent ?',
    reason: 'vu',
    by: 'test',
    date: '2026-01-02',
  }
}

describe('sens des réponses', () => {
  it('range chaque réponse en problème, ok ou neutre ; le doute est toujours admis', () => {
    expect(answerMeaning('fail')).toBe('probleme')
    expect(answerMeaning('titre-non-balise')).toBe('probleme')
    expect(answerMeaning('pass')).toBe('ok')
    expect(answerMeaning('donnees')).toBe('neutre')
    expect(answerGroups(['pass', 'fail', 'decorative'])).toEqual({
      probleme: ['fail'],
      ok: ['pass'],
      neutre: ['decorative'],
    })
    expect(isAdmitted('doute', ['pass', 'fail'])).toBe(true)
    expect(isAdmitted('peut-etre', ['pass', 'fail'])).toBe(false)
  })
})

describe('fichiers « à corriger » et résultats complets', () => {
  const doc = report([page('/'), page('/contact')])

  it('décrit chaque non-conformité avec son exigence, son élément, sa capture et ses pages', () => {
    const toFix = buildToFix(doc, catalog)
    expect(toFix.format).toBe('rgaa-checker/a-corriger@1')
    const issue = toFix.nonConformities[0]
    expect(issue?.test).toBe('1.1.1')
    expect(issue?.requirement).toMatch(/alternative textuelle/)
    expect(issue?.reference).toMatch(/criteres-et-tests\/#1\.1\.1$/)
    expect(issue?.occurrences[0]).toMatchObject({ screenshot: SHOT, pages: ['/', '/contact'] })
    expect(toFix.questions[0]).toMatchObject({
      key: KEY,
      state: 'a-trancher',
      pages: ['/', '/contact'],
    })
    expect(toFix.questions[0]?.answers.map((answer) => answer.value)).toEqual([
      'pass',
      'fail',
      'doute',
    ])
  })

  it('reflète les décisions prises depuis l’audit', () => {
    const states = ['fail', 'pass', 'doute'].map(
      (answer) =>
        buildToFix(doc, catalog, { decisions: () => decision(answer) }).questions[0]?.state,
    )
    expect(states).toEqual(['probleme-confirme', 'tranchee-a-appliquer', 'doute-maintenu'])
  })

  it('le Markdown est inerte : ni HTML, ni lien, ni emphase venus de la page', () => {
    const markdown = renderToFixMarkdown(buildToFix(doc, catalog, { outDir: '/tmp/rapport' }))
    expect(markdown).not.toContain('<script>')
    expect(markdown).not.toContain('[x](javascript:')
    expect(markdown).toContain('\\[x\\](javascript:')
    expect(markdown).toContain('\\<script\\>')
    expect(markdown).toContain(
      '`rgaa audit https://exemple.fr/ <chemin> --merge --out /tmp/rapport`',
    )
    expect(markdown).toContain(`Capture : \`${SHOT}\``)
  })

  it('les résultats complets donnent le verdict de chaque test sur chaque page', () => {
    const full = renderFullResults(doc, catalog)
    expect(full).toContain('**1.1.1**')
    expect(full).toMatch(/✗ Non conforme : toutes les pages/)
    expect(full).toMatch(/\? À valider : toutes les pages/)
    expect(full).toMatch(/✓ Conforme : toutes les pages/)
  })
})

describe('fusion d’un audit partiel', () => {
  it('remplace les pages réauditées, garde les tests inter-pages et reconstruit les questions', () => {
    const previous = report([page('/'), page('/contact')])
    const partial = report([page('/contact', 'C')])
    // Le test 2.1.1 joue ici le rôle d'un test inter-pages : son ancien verdict est gardé.
    partial.pages[0]?.tests.forEach((entry) => {
      if (entry.test === '2.1.1') entry.final = 'NC'
    })
    const merged = mergeReports(previous, partial, new Set(['2.1.1']))
    const contact = merged.pages.find((item) => item.path === '/contact')
    expect(merged.pages.map((item) => item.path)).toEqual(['/', '/contact'])
    expect(contact?.tests.find((entry) => entry.test === '1.1.1')?.final).toBe('C')
    expect(contact?.tests.find((entry) => entry.test === '2.1.1')?.final).toBe('C')
    expect(contact?.counts.NC).toBe(0)
    expect(contact?.state).toBe('a-valider')
    expect(merged.pending[0]?.pages).toEqual(['https://exemple.fr/', 'https://exemple.fr/contact'])

    const added = mergeReports(previous, report([page('/nouvelle')]), new Set())
    expect(added.pages.map((item) => item.path)).toEqual(['/', '/contact', '/nouvelle'])
  })
})

describe('interface web locale', () => {
  let dir: string
  let server: UiServer
  let state: LiveState
  const doc = report([page('/'), page('/contact')])

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rgaa-ui-'))
    writeReport(dir, doc, catalog)
    mkdirSync(join(dir, 'preuves', 'echecs'), { recursive: true })
    writeFileSync(join(dir, SHOT), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(dir, 'secret.txt'), 'secret')
    state = new LiveState('https://exemple.fr/', catalog, new DecisionStore(join(dir, 'decisions')))
    state.load(doc)
    server = await startUiServer({ state, outDir: dir, port: 0, by: 'test' })
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

  it('sert la page avec le jeton et une politique de sécurité stricte', async () => {
    const response = await raw('/')
    expect(response.status).toBe(200)
    expect(response.body).toContain(server.token)
    expect(String(response.headers['content-security-policy'])).toContain("script-src 'self'")
  })

  it('refuse l’API sans jeton, un autre hôte et une autre origine', async () => {
    expect((await raw('/api/etat')).status).toBe(403)
    expect((await raw('/', { headers: { host: 'attaquant.example' } })).status).toBe(421)
    const foreign = await raw('/api/etat', {
      headers: { 'x-rgaa-jeton': server.token, origin: 'https://attaquant.example' },
    })
    expect(foreign.status).toBe(403)
    const ok = await raw('/api/etat', { headers: { 'x-rgaa-jeton': server.token } })
    expect(ok.status).toBe(200)
    const snapshot = JSON.parse(ok.body)
    expect(snapshot.issues[0].test).toBe('1.1.1')
    expect(snapshot.questions[0].key).toBe(KEY)
  })

  it('ne sert que les fichiers du rapport et les captures', async () => {
    expect((await raw('/a-corriger.md')).status).toBe(200)
    expect((await raw(`/${SHOT}`)).headers['content-type']).toBe('image/png')
    expect((await raw('/secret.txt')).status).toBe(404)
    expect((await raw('/preuves/../secret.txt')).status).toBe(404)
    expect((await raw('/preuves/echecs/..%2F..%2Fsecret.txt')).status).toBe(404)
  })

  it('enregistre une décision (problème, pas un problème, doute) et refuse le reste', async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      raw('/api/decision', {
        method: 'POST',
        headers: { 'x-rgaa-jeton': server.token, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    expect((await post({ key: KEY, answer: 'peut-etre' })).status).toBe(400)
    expect(
      (await post({ key: KEY, answer: 'fail' }, { 'content-type': 'text/plain' })).status,
    ).toBe(415)
    const noToken = await raw('/api/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY, answer: 'fail' }),
    })
    expect(noToken.status).toBe(403)

    const doubt = await post({ key: KEY, answer: 'doute', reason: 'à revoir' })
    expect(doubt.status).toBe(200)
    expect(JSON.parse(doubt.body).question.state).toBe('doute-maintenu')
    const problem = await post({ key: KEY, answer: 'fail' })
    expect(JSON.parse(problem.body).question.state).toBe('probleme-confirme')
    const saved = JSON.parse(readFileSync(join(dir, 'decisions', 'frame.title.json'), 'utf8'))
    expect(saved.entries[KEY]).toMatchObject({ answer: 'fail', by: 'test' })
    expect(state.pagesToRecheck()).toEqual(['/', '/contact'])
  })
})

describe('serveur MCP', () => {
  let dir: string
  let input: PassThrough
  let output: PassThrough
  let done: Promise<void>
  const replies = new Map<number, Record<string, unknown>>()
  let id = 0

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rgaa-mcp-'))
    const doc = report([page('/'), page('/contact')])
    doc.meta.decisionsDir = join(dir, 'decisions')
    writeReport(dir, doc, catalog)
    input = new PassThrough()
    output = new PassThrough()
    let buffer = ''
    output.on('data', (chunk) => {
      buffer += String(chunk)
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        if (typeof message.id === 'number') replies.set(message.id, message)
      }
    })
    const tools = new RgaaTools({
      outDir: dir,
      decisionsDir: join(dir, 'decisions'),
      concurrency: 1,
      captures: 'aucune',
      sandbox: true,
      sites: ['https://exemple.fr'],
      by: 'IA test',
      serve: false,
      port: 0,
      log: () => {},
    })
    done = serveMcp(tools.handlers(), input, output)
  })
  afterAll(async () => {
    input.end()
    await done
  })

  async function rpc(method: string, params: Record<string, unknown> = {}) {
    id += 1
    const current = id
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`)
    for (let tries = 0; tries < 200 && !replies.has(current); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return replies.get(current) as { result?: Record<string, never>; error?: { code: number } }
  }
  const tool = async (name: string, args: Record<string, unknown>) =>
    (await rpc('tools/call', { name, arguments: args })).result as unknown as {
      content: { type: string; text?: string }[]
      isError?: boolean
    }

  it('s’initialise et liste ses outils', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' })
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
    })
    const list = (await rpc('tools/list')).result as unknown as { tools: { name: string }[] }
    expect(list.tools.map((item) => item.name)).toEqual([
      'auditer_site',
      'auditer_pages',
      'etat_audit',
      'lire_a_corriger',
      'resultats_complets',
      'trancher_question',
      'voir_capture',
      'expliquer_rgaa',
    ])
    expect((await rpc('inconnue')).error?.code).toBe(-32601)
  })

  it('lit le rapport filtré, refuse les sites et chemins non admis', async () => {
    const toFix = await tool('lire_a_corriger', { page: '/contact', test: '1' })
    expect(toFix.content[0]?.text).toContain('1.1.1')
    expect(toFix.content[0]?.text).not.toContain(KEY)
    const refused = await tool('auditer_site', { url: 'https://ailleurs.example' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/non autorisé/)
    const traversal = await tool('voir_capture', { chemin: '../rapport.json' })
    expect(traversal.isError).toBe(true)
  })

  it('tranche une question en doute, avec justification obligatoire', async () => {
    expect(
      (await tool('trancher_question', { empreinte: KEY, reponse: 'doute', justification: ' ' }))
        .isError,
    ).toBe(true)
    const saved = await tool('trancher_question', {
      empreinte: KEY,
      reponse: 'doute',
      justification: 'Titre ambigu',
    })
    expect(saved.isError).toBeUndefined()
    expect(existsSync(join(dir, 'decisions', 'frame.title.json'))).toBe(true)
    const after = await tool('lire_a_corriger', { contenu: 'questions', format: 'json' })
    expect(after.content[0]?.text).toContain('"state": "doute-maintenu"')
  })
})
