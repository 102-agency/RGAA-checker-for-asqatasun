import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { answerGroups, answerMeaning, isAdmitted } from '../../src/core/answers.ts'
import { cookieInputs, parseCookie, resolveAuth } from '../../src/core/auth.ts'
import { loadCatalog } from '../../src/core/catalog.ts'
import {
  CHANGE_LIMITS,
  type Change,
  ChangeError,
  ChangeStore,
  cleanChangeInput,
  judgeChanges,
  renderChangeVerdicts,
} from '../../src/core/changes.ts'
import { type Decision, DecisionStore } from '../../src/core/decisions.ts'
import type { AuditResult } from '../../src/core/runner.ts'
import type { PageReport, TestResult } from '../../src/core/types.ts'
import { serveMcp } from '../../src/mcp/protocol.ts'
import { type DecideMode, RgaaTools, toolsFor } from '../../src/mcp/tools.ts'
import {
  buildToFix,
  renderFullResults,
  renderToFixCompact,
  renderToFixMarkdown,
} from '../../src/report/ai.ts'
import { diffReports, renderDiff } from '../../src/report/diff.ts'
import { mergeReports } from '../../src/report/merge.ts'
import { buildReport, type ReportDocument } from '../../src/report/model.ts'
import { remediatedTests, remediationFor } from '../../src/report/remediation.ts'
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

  it('donne au tableau de bord les 13 thématiques du référentiel, avec leurs totaux', async () => {
    const snapshot = JSON.parse(
      (await raw('/api/etat', { headers: { 'x-rgaa-jeton': server.token } })).body,
    )
    const themes = snapshot.themes as {
      id: number
      label: string
      criteria: number
      tests: number
    }[]
    expect(themes.map((theme) => theme.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(themes[0]).toMatchObject({ id: 1, label: expect.stringMatching(/image/i) })
    expect(themes.reduce((sum, theme) => sum + theme.tests, 0)).toBe(catalog.tests.length)
    expect(themes.reduce((sum, theme) => sum + theme.criteria, 0)).toBe(catalog.criteria.size)
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
      decide: 'tout',
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
      'consigner_modification',
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

describe('pistes de correction', () => {
  it('ne portent que sur des tests du référentiel, avec un texte et un type', () => {
    for (const test of remediatedTests()) {
      expect(catalog.byTest.has(test), test).toBe(true)
      const hint = remediationFor(test)
      expect(hint?.text.length, test).toBeGreaterThan(20)
      expect(['mecanique', 'a-concevoir']).toContain(hint?.kind)
    }
  })

  it('accompagnent la non-conformité dans le JSON, le Markdown et le format compact', () => {
    const doc = buildToFix(report([page('/'), page('/contact')]), catalog)
    const item = doc.nonConformities.find((entry) => entry.test === '1.1.1')
    expect(item?.remediation?.kind).toBe('mecanique')
    expect(renderToFixMarkdown(doc)).toContain('Piste de correction (mécanique)')
    expect(renderToFixCompact(doc)).toContain('Correction (mécanique)')
  })
})

describe('format compact', () => {
  it('garde de quoi corriger (élément, code, capture) en bien moins de texte', () => {
    const doc = buildToFix(report([page('/'), page('/contact')]), catalog)
    const compact = renderToFixCompact(doc)
    expect(compact).toContain('body > header > img')
    expect(compact).toContain('<img src="logo.png">')
    expect(compact).toContain(SHOT)
    expect(compact).toContain(KEY)
    expect(compact.length).toBeLessThan(renderToFixMarkdown(doc).length / 2)
  })

  it('liste les questions tranchées en attente de réaudit', () => {
    const doc = buildToFix(report([page('/')]), catalog, {
      decisions: () => decision('pass'),
    })
    const compact = renderToFixCompact(doc)
    expect(compact).toContain('TRANCHÉES, À APPLIQUER')
    expect(compact).toContain(`${KEY} « pass »`)
  })

  it('neutralise le texte hostile venu de la page', () => {
    const compact = renderToFixCompact(buildToFix(report([page('/')]), catalog))
    expect(compact).not.toContain('<script>')
  })

  it('écrit une seule fois la définition d’une question répétée', () => {
    const base = report([page('/'), page('/contact')])
    const second = { ...base.pending[0], key: 'dddddddddddd' } as (typeof base.pending)[number]
    base.pending.push(second)
    const compact = renderToFixCompact(buildToFix(base, catalog))
    expect(compact.match(/Q1 = /g)).toHaveLength(1)
    expect(compact.match(/\(Q1\)/g)).toHaveLength(2)
  })
})

describe('différence entre deux rapports', () => {
  it('distingue corrigé, persistant et régression', () => {
    const before = report([page('/', 'NC'), page('/contact', 'C')])
    const after = report([page('/', 'C'), page('/contact', 'NC')])
    const diff = diffReports(before, after)
    expect(diff.fixed.map((entry) => `${entry.test} ${entry.page}`)).toEqual(['1.1.1 /'])
    expect(diff.introduced.map((entry) => `${entry.test} ${entry.page}`)).toEqual([
      '1.1.1 /contact',
    ])
    expect(diff.persisting).toEqual([])
    const text = renderDiff(diff)
    expect(text).toContain('NOUVELLES non-conformités')
    expect(text).toContain('1.1.1 sur /contact')
  })

  it('compte une non-conformité inchangée comme persistante', () => {
    const diff = diffReports(report([page('/', 'NC')]), report([page('/', 'NC')]))
    expect(diff.persisting).toHaveLength(1)
    expect(diff.fixed).toHaveLength(0)
  })

  it('ignore les pages absentes d’un des deux rapports', () => {
    const diff = diffReports(report([page('/', 'NC')]), report([page('/autre', 'NC')]))
    expect(diff.comparedPages).toBe(0)
    expect(renderDiff(diff)).toContain('aucune page commune')
  })
})

describe('modes de décision du serveur MCP', () => {
  const options = (decide: DecideMode, dir: string) => ({
    outDir: dir,
    decisionsDir: join(dir, 'decisions'),
    concurrency: 1,
    captures: 'aucune' as const,
    sandbox: true,
    sites: ['https://exemple.fr'],
    by: 'IA test',
    decide,
    serve: false,
    port: 0,
    log: () => {},
  })

  async function session(decide: DecideMode) {
    const dir = mkdtempSync(join(tmpdir(), 'rgaa-mcp-mode-'))
    const doc = report([page('/')])
    doc.meta.decisionsDir = join(dir, 'decisions')
    writeReport(dir, doc, catalog)
    const input = new PassThrough()
    const output = new PassThrough()
    const replies = new Map<number, { result?: Record<string, unknown>; error?: unknown }>()
    let buffer = ''
    output.on('data', (chunk) => {
      buffer += String(chunk)
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        if (typeof message.id === 'number') replies.set(message.id, message)
      }
    })
    const tools = new RgaaTools(options(decide, dir))
    const done = serveMcp(tools.handlers(), input, output)
    let id = 0
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      id += 1
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      for (let tries = 0; tries < 200 && !replies.has(id); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return replies.get(id)
    }
    return {
      dir,
      rpc,
      close: async () => {
        input.end()
        await done
      },
    }
  }

  it('« aucune » : l’outil de décision n’est pas proposé et reste refusé s’il est appelé', async () => {
    expect(toolsFor('aucune').map((tool) => tool.name)).not.toContain('trancher_question')
    const { rpc, close, dir } = await session('aucune')
    const list = (await rpc('tools/list'))?.result as { tools: { name: string }[] }
    expect(list.tools.map((tool) => tool.name)).not.toContain('trancher_question')
    const call = await rpc('tools/call', {
      name: 'trancher_question',
      arguments: { empreinte: KEY, reponse: 'doute', justification: 'x' },
    })
    expect(call?.error).toBeDefined()
    expect(existsSync(join(dir, 'decisions', 'frame.title.json'))).toBe(false)
    await close()
  })

  it('« doute » : seule la réponse « doute » est enregistrée', async () => {
    const { rpc, close, dir } = await session('doute')
    const refused = (
      await rpc('tools/call', {
        name: 'trancher_question',
        arguments: { empreinte: KEY, reponse: 'pass', justification: 'Le titre est bon' },
      })
    )?.result as { isError?: boolean; content: { text: string }[] }
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/doute/)
    expect(existsSync(join(dir, 'decisions', 'frame.title.json'))).toBe(false)
    const accepted = (
      await rpc('tools/call', {
        name: 'trancher_question',
        arguments: { empreinte: KEY, reponse: 'doute', justification: 'À voir avec un expert' },
      })
    )?.result as { isError?: boolean }
    expect(accepted.isError).toBeUndefined()
    expect(existsSync(join(dir, 'decisions', 'frame.title.json'))).toBe(true)
    await close()
  })

  it('annonce le rôle dans les instructions', async () => {
    const { rpc, close } = await session('aucune')
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18' }))?.result as {
      instructions: string
    }
    expect(init.instructions).toMatch(/pas de votre ressort/)
    await close()
  })

  it('filtre les non-conformités par type de correction', async () => {
    const { rpc, close } = await session('tout')
    const read = async (correction: string) => {
      const reply = await rpc('tools/call', {
        name: 'lire_a_corriger',
        arguments: { correction },
      })
      const result = reply?.result as { content: { text: string }[] } | undefined
      return result?.content[0]?.text ?? ''
    }
    expect(await read('mecanique')).toContain('### 1.1.1')
    expect(await read('a-concevoir')).not.toContain('### 1.1.1')
    await close()
  })
})

describe('authentification des pages', () => {
  const base = new URL('https://exemple.fr/')
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rgaa-auth-'))
  })

  it('pose un cookie sur le site audité seulement', () => {
    expect(parseCookie('session=abc123', base)).toEqual({
      name: 'session',
      value: 'abc123',
      url: 'https://exemple.fr',
    })
  })

  it('refuse un cookie mal formé sans en répéter la valeur', () => {
    for (const bad of ['sansegal', '=vide', 'a=b c', 'a=b;c=d']) {
      let message = ''
      try {
        parseCookie(bad, base)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message, bad).toMatch(/Cookie invalide/)
      expect(message).not.toContain('b c')
    }
  })

  it('lit aussi les cookies de l’environnement', () => {
    expect(cookieInputs(['a=1'], 'b=2; c=3;')).toEqual(['a=1', 'b=2', 'c=3'])
    expect(cookieInputs(undefined, undefined)).toEqual([])
  })

  it('filtre l’état de session : cookies du domaine et localStorage de l’origine', () => {
    const file = join(dir, 'auth.json')
    writeFileSync(
      file,
      JSON.stringify({
        cookies: [
          { name: 'sid', value: 'ok', domain: 'exemple.fr', path: '/', expires: -1 },
          { name: 'sub', value: 'ok', domain: '.exemple.fr', path: '/' },
          { name: 'autre', value: 'SECRET-AILLEURS', domain: 'ailleurs.example', path: '/' },
          { name: 'piege', value: 'SECRET-PIEGE', domain: 'mauvais-exemple.fr', path: '/' },
        ],
        origins: [
          { origin: 'https://exemple.fr', localStorage: [{ name: 'jeton', value: 'ok' }] },
          { origin: 'https://ailleurs.example', localStorage: [{ name: 'jeton', value: 'X' }] },
        ],
      }),
    )
    const auth = resolveAuth({ storageState: file, cookies: ['extra=1'] }, base)
    expect(auth?.storageState?.cookies.map((cookie) => cookie.name)).toEqual(['sid', 'sub'])
    expect(auth?.storageState?.origins.map((entry) => entry.origin)).toEqual(['https://exemple.fr'])
    expect(auth?.cookies).toHaveLength(1)
    expect(auth?.summary).not.toMatch(/SECRET|=ok|extra=1/)
  })

  it('refuse un état de session sans rien pour ce site, ou illisible', () => {
    const empty = join(dir, 'vide.json')
    writeFileSync(
      empty,
      JSON.stringify({ cookies: [{ name: 'a', value: 'b', domain: 'ailleurs.example' }] }),
    )
    expect(() => resolveAuth({ storageState: empty }, base)).toThrow(/ne contient rien/)
    const broken = join(dir, 'casse.json')
    writeFileSync(broken, '{pas du json')
    expect(() => resolveAuth({ storageState: broken }, base)).toThrow(/illisible/)
  })

  it('sans réglage, aucune authentification', () => {
    expect(resolveAuth(undefined, base)).toBeUndefined()
    expect(resolveAuth({ cookies: [] }, base)).toBeUndefined()
  })
})

describe('journal des modifications de l’IA', () => {
  const known = new Set(catalog.byTest.keys())
  const input = (over: Partial<Parameters<typeof cleanChangeInput>[0]> = {}) => ({
    test: '1.1.1',
    pages: ['/'],
    file: 'src/Logo.tsx',
    before: '<img src="a.png">',
    after: '<img src="a.png" alt="Logo">',
    by: 'IA test',
    ...over,
  })
  const change = (over: Partial<Change> = {}): Change => ({
    id: 'aaaaaaaaaaaa',
    at: '2026-01-01T10:00:00.000Z',
    by: 'IA test',
    test: '1.1.1',
    pages: ['/'],
    file: 'src/Logo.tsx',
    before: 'a',
    after: 'b',
    ...over,
  })
  const judge = (
    changes: Change[],
    now: ReportDocument,
    options: { audited?: string[] | null; before?: ReportDocument; since?: string } = {},
  ) =>
    judgeChanges(changes, now, {
      audited: options.audited ?? null,
      since: options.since ?? '2026-01-01T12:00:00.000Z',
      before: options.before,
      date: '2026-01-01T12:05:00.000Z',
    })

  it('valide l’enregistrement et refuse ce qui n’a pas de sens', () => {
    expect(cleanChangeInput(input({ line: 12, note: ' pour le test ' }), known)).toMatchObject({
      test: '1.1.1',
      line: 12,
      note: 'pour le test',
    })
    const refused = (over: Parameters<typeof input>[0]) =>
      expect(() => cleanChangeInput(input(over), known)).toThrow(ChangeError)
    refused({ test: '99.9.9' })
    refused({ test: '1.1' })
    refused({ pages: [] })
    refused({ pages: ['contact'] })
    refused({ file: '  ' })
    refused({ before: 'x', after: 'x' })
    refused({ before: '', after: '' })
    refused({ after: 'x'.repeat(CHANGE_LIMITS.code + 1) })
    refused({ line: 0 })
    refused({ occurrence: 'pas-une-empreinte' })
  })

  it('garde le code tel quel mais retire les séquences de contrôle', () => {
    const clean = cleanChangeInput(
      input({ before: `\u001b[31m${HOSTILE}\r\nligne 2`, after: 'x\u0007' }),
      known,
    )
    expect(clean.before).toBe(`${HOSTILE}\nligne 2`)
    expect(clean.after).toBe('x')
  })

  it('enregistre, relit et borne le journal sur disque', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rgaa-changes-'))
    const store = new ChangeStore(dir)
    expect(store.exists()).toBe(false)
    expect(store.list()).toEqual([])
    const first = store.add(cleanChangeInput(input(), known))
    expect(store.exists()).toBe(true)
    expect(store.list()).toEqual([first])
    expect(first.id).toMatch(/^[0-9a-f]{12}$/)
    for (let index = 0; index < CHANGE_LIMITS.entries + 5; index++) {
      store.add(cleanChangeInput(input({ after: `v${index}` }), known))
    }
    const kept = store.list()
    expect(kept).toHaveLength(CHANGE_LIMITS.entries)
    expect(kept.some((entry) => entry.id === first.id)).toBe(false)
  })

  it('refuse un journal mal formé plutôt que de l’ignorer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rgaa-changes-bad-'))
    writeFileSync(join(dir, 'corrections.json'), JSON.stringify({ changes: [{ id: 'x' }] }))
    expect(() => new ChangeStore(dir).list()).toThrow()
  })

  it('corrigée quand le test n’échoue plus sur la page', () => {
    const [done] = judge([change()], report([page('/', 'C')]))
    expect(done?.verdict).toMatchObject({ state: 'corrigee', remaining: [], introduced: [] })
  })

  it('persiste quand le test échoue toujours', () => {
    const [done] = judge([change()], report([page('/', 'NC')]))
    expect(done?.verdict).toMatchObject({ state: 'persiste', remaining: ['1.1.1 sur /'] })
  })

  it('régression quand un autre test se met à échouer sur la page', () => {
    const before = report([page('/', 'C')])
    const after = report([page('/', 'NC')])
    const [done] = judge([change({ test: '2.1.1' })], after, { before })
    expect(done?.verdict).toMatchObject({ state: 'regression', introduced: ['1.1.1 sur /'] })
  })

  it('ne juge ni une modification postérieure à l’audit ni une page non revue', () => {
    const now = report([page('/', 'C'), page('/contact', 'C')])
    const later = change({ at: '2026-01-01T13:00:00.000Z' })
    expect(judge([later], now)[0]?.verdict).toBeUndefined()
    expect(judge([change()], now, { audited: ['/contact'] })[0]?.verdict).toBeUndefined()
    // Toutes les pages visées doivent avoir été revues pour conclure.
    const two = change({ pages: ['/', '/contact'] })
    expect(judge([two], now, { audited: ['/'] })[0]?.verdict).toBeUndefined()
    expect(judge([two], now, { audited: ['/', '/contact'] })[0]?.verdict?.state).toBe('corrigee')
  })

  it('met à jour le verdict à chaque audit et ne réécrit rien sans changement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rgaa-changes-verify-'))
    const store = new ChangeStore(dir)
    store.add(cleanChangeInput(input(), known), new Date('2026-01-01T10:00:00.000Z'))
    const options = {
      audited: null,
      since: '2026-01-01T12:00:00.000Z',
      date: '2026-01-01T12:05:00.000Z',
    }
    expect(store.verify(report([page('/', 'NC')]), options)[0]?.verdict?.state).toBe('persiste')
    expect(store.list()[0]?.verdict?.state).toBe('persiste')
    expect(store.verify(report([page('/', 'C')]), options)[0]?.verdict?.state).toBe('corrigee')
    const version = store.version()
    store.verify(report([page('/', 'C')]), options)
    expect(store.version()).toBe(version)
  })

  it('résume les verdicts pour l’IA', () => {
    const text = renderChangeVerdicts([
      change({
        verdict: { state: 'persiste', date: 'd', remaining: ['1.1.1 sur /'], introduced: [] },
      }),
      change({ id: 'bbbbbbbbbbbb', test: '2.1.1' }),
    ])
    expect(text).toContain('1 persistante(s)')
    expect(text).toContain('1 à vérifier')
    expect(text).toContain('PERSISTE (échec restant : 1.1.1 sur /)')
    expect(renderChangeVerdicts([])).toBe('')
  })
})

describe('outil MCP consigner_modification', () => {
  const options = (decide: DecideMode, dir: string) => ({
    outDir: dir,
    decisionsDir: join(dir, 'decisions'),
    concurrency: 1,
    captures: 'aucune' as const,
    sandbox: true,
    sites: ['https://exemple.fr'],
    by: 'Haiku test',
    decide,
    serve: false,
    port: 0,
    log: () => {},
  })
  const context = { progress: () => {} }
  const args = {
    test: '1.1.1',
    chemins: ['/'],
    fichier: 'src/Logo.tsx',
    avant: '<img src="a.png">',
    apres: '<img src="a.png" alt="Logo">',
    ligne: 8,
    note: 'alt ajouté',
  }

  it('est proposé quel que soit le rôle, y compris « aucune »', () => {
    for (const mode of ['tout', 'doute', 'aucune'] as const) {
      expect(toolsFor(mode).map((tool) => tool.name)).toContain('consigner_modification')
    }
  })

  it('enregistre la modification signée du serveur, et la relit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rgaa-mcp-change-'))
    const tools = new RgaaTools(options('aucune', dir))
    const done = await tools.call('consigner_modification', args, context)
    expect(done.content[0]?.text).toContain('auditer_pages')
    const [saved] = new ChangeStore(dir).list()
    expect(saved).toMatchObject({
      test: '1.1.1',
      pages: ['/'],
      file: 'src/Logo.tsx',
      line: 8,
      by: 'Haiku test',
      note: 'alt ajouté',
    })
    expect(saved?.verdict).toBeUndefined()
  })

  it('refuse un test inconnu, un avant identique à l’après, un chemin sans « / »', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rgaa-mcp-change-bad-'))
    const tools = new RgaaTools(options('tout', dir))
    const attempt = (over: Record<string, unknown>) =>
      tools.call('consigner_modification', { ...args, ...over }, context)
    await expect(attempt({ test: '99.9.9' })).rejects.toThrow(/Test inconnu/)
    await expect(attempt({ apres: args.avant })).rejects.toThrow(/identiques/)
    await expect(attempt({ chemins: ['contact'] })).rejects.toThrow(/commencer par/)
    await expect(attempt({ fichier: undefined })).rejects.toThrow()
    expect(new ChangeStore(dir).list()).toEqual([])
  })
})

describe('interface web : modifications de l’IA', () => {
  let dir: string
  let server: UiServer
  let state: LiveState
  const get = (path: string, token: string | undefined = server.token) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers: token ? { 'x-rgaa-jeton': token } : {},
    })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rgaa-ui-changes-'))
    const doc = report([page('/')])
    writeReport(dir, doc, catalog)
    state = new LiveState('https://exemple.fr/', catalog, new DecisionStore(join(dir, 'decisions')))
    state.load(doc)
    state.attachChanges(new ChangeStore(dir))
    server = await startUiServer({ state, outDir: dir, port: 0 })
  })
  afterAll(async () => {
    await server.close()
  })

  it('sans IA connectée ni journal : rien à montrer', async () => {
    const snapshot = (await (await get('/api/etat')).json()) as { mcp: boolean }
    expect(snapshot.mcp).toBe(false)
    const list = (await (await get('/api/modifications')).json()) as {
      mcp: boolean
      changes: unknown[]
    }
    expect(list).toEqual({ mcp: false, changes: [] })
  })

  it('exige le jeton de session', async () => {
    expect((await get('/api/modifications', '')).status).toBe(403)
  })

  it('prévient les clients quand le journal change, même écrit par un autre processus', async () => {
    const events: { type: string; mcp?: boolean }[] = []
    const stop = state.subscribe((event) => events.push(event))
    new ChangeStore(dir).add(
      cleanChangeInput(
        {
          test: '1.1.1',
          pages: ['/'],
          file: 'src/Logo.tsx',
          before: '<img src="a.png">',
          after: '<img src="a.png" alt="Logo">',
          by: 'Haiku test',
        },
        new Set(catalog.byTest.keys()),
      ),
    )
    state.refreshChanges()
    state.refreshChanges()
    stop()
    expect(events).toEqual([{ type: 'modifications', mcp: true }])
  })

  it('donne les modifications avec l’exigence visée, et signale la connexion', async () => {
    const snapshot = (await (await get('/api/etat')).json()) as { mcp: boolean }
    expect(snapshot.mcp).toBe(true)
    const list = (await (await get('/api/modifications')).json()) as {
      mcp: boolean
      changes: { test: string; requirement: string; file: string; after: string }[]
    }
    expect(list.mcp).toBe(true)
    expect(list.changes).toHaveLength(1)
    expect(list.changes[0]).toMatchObject({ test: '1.1.1', file: 'src/Logo.tsx' })
    expect(list.changes[0]?.requirement.length).toBeGreaterThan(10)
  })

  it('sert le script de thème, sans ressource extérieure', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/theme.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    const page = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
    expect(page).not.toMatch(/(?:src|href)="https?:/)
    expect(page).not.toMatch(/\sstyle=/)
  })
})
