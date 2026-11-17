import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchBrowser } from '../src/core/browser.ts'
import { DecisionStore } from '../src/core/decisions.ts'
import { audit } from '../src/core/runner.ts'
import type { PageReport } from '../src/core/types.ts'
import { checks } from '../src/themes/02-cadres.ts'
import { type Bench, startBench } from './harness.ts'

let bench: Bench
let browser: Browser
beforeAll(async () => {
  bench = await startBench()
  browser = await launchBrowser({ libraries: process.env.RGAA_BROWSER_LIBS })
})
afterAll(async () => {
  await browser.close()
  await bench.stop()
})

describe('runner', () => {
  it('onPage reçoit les résultats de la page, pas un rapport vide', async () => {
    const seen: PageReport[] = []
    await audit({
      browser,
      urls: [`${bench.baseUrl}/02-cadres/ko.html`],
      checks,
      decisions: new DecisionStore(join(mkdtempSync(join(tmpdir(), 'rgaa-run-')), 'd')),
      concurrency: 1,
      onPage: (report) => seen.push(report),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.results['2.1.1']?.status).toBe('NC')
    expect(seen[0]?.results['2.1.1']?.failureCount).toBe(1)
  })

  it('une page qui répond 404 est signalée, pas auditée', async () => {
    const result = await audit({
      browser,
      urls: [`${bench.baseUrl}/absente.html`],
      checks,
      decisions: new DecisionStore(join(mkdtempSync(join(tmpdir(), 'rgaa-run-')), 'd')),
      concurrency: 1,
    })
    expect(result.pages[0]?.error).toMatch(/404/)
    expect(result.pages[0]?.results).toEqual({})
  })
})
