import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser } from 'playwright'
import { launchBrowser } from '../src/core/browser.ts'
import { type Decision, DecisionStore, judgementKey } from '../src/core/decisions.ts'
import { audit } from '../src/core/runner.ts'
import type { Check, TestResult } from '../src/core/types.ts'

/**
 * Banc d'essai des vérifications : sert le dossier `fixtures/` en HTTP et
 * audite une ou plusieurs pages-témoins avec un vrai Chromium.
 *
 *   const bench = await startBench()            // dans beforeAll
 *   const page = await bench.audit(checks, '08-elements-obligatoires/ko.html')
 *   expect(page['8.5.1']?.status).toBe('NC')
 *   await bench.stop()                          // dans afterAll
 */
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.vtt': 'text/vtt; charset=utf-8',
}

export interface BenchOptions {
  /** Décisions de jugement préenregistrées : `{ topic, evidence, answer }`. */
  decisions?: { topic: string; evidence: Record<string, string>; answer: string }[]
}

export interface Bench {
  baseUrl: string
  /** Audite une page-témoin et renvoie ses résultats par test. */
  audit(
    checks: Check[],
    fixture: string,
    options?: BenchOptions,
  ): Promise<Record<string, TestResult>>
  /** Audite plusieurs pages-témoins ensemble (vérifications inter-pages). Résultats par chemin de fixture. */
  auditSite(
    checks: Check[],
    fixtures: string[],
    options?: BenchOptions,
  ): Promise<Record<string, Record<string, TestResult>>>
  stop(): Promise<void>
}

export async function startBench(): Promise<Bench> {
  const server: Server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname))
    try {
      const body = await readFile(join(FIXTURES, path))
      response.writeHead(200, {
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      })
      response.end(body)
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('introuvable')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const browser: Browser = await launchBrowser({ libraries: process.env.RGAA_BROWSER_LIBS })

  const auditSite: Bench['auditSite'] = async (checks, fixtures, options = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'rgaa-bench-'))
    const store = new DecisionStore(join(dir, 'decisions'))
    for (const entry of options.decisions ?? []) {
      const decision: Decision = {
        answer: entry.answer,
        evidence: entry.evidence,
        question: '',
        reason: 'test',
        by: 'test',
        date: '2026-01-01',
      }
      store.set(entry.topic, judgementKey(entry.topic, entry.evidence), decision)
    }
    const result = await audit({
      browser,
      urls: fixtures.map((fixture) => `${baseUrl}/${fixture}`),
      checks,
      decisions: store,
      outDir: join(dir, 'rapport'),
      concurrency: 2,
    })
    const out: Record<string, Record<string, TestResult>> = {}
    result.pages.forEach((page, index) => {
      if (page.error) throw new Error(`${fixtures[index]} : ${page.error}`)
      out[fixtures[index] ?? page.path] = page.results
    })
    return out
  }

  return {
    baseUrl,
    auditSite,
    async audit(checks, fixture, options) {
      const pages = await auditSite(checks, [fixture], options)
      return pages[fixture] ?? {}
    },
    async stop() {
      await browser.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
