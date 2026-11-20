import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchBrowser } from '../src/core/browser.ts'
import { DecisionStore } from '../src/core/decisions.ts'
import { type AuditEvent, audit } from '../src/core/runner.ts'
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

  it('capture les zones, signale échecs et questions en temps réel, garde le doute ouvert', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rgaa-run-'))
    const decisions = new DecisionStore(join(dir, 'd'))
    const events: AuditEvent[] = []
    const url = `${bench.baseUrl}/02-cadres/ko.html`
    const first = await audit({
      browser,
      urls: [url],
      checks,
      decisions,
      outDir: dir,
      concurrency: 1,
      onEvent: (event) => events.push(event),
    })
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['audit-debut', 'page-debut', 'constat', 'question', 'page-fin']),
    )
    const constat = events.find((event) => event.type === 'constat')
    if (constat?.type !== 'constat') throw new Error('aucun constat')
    expect(constat.failure.id).toMatch(/^[0-9a-f]{12}$/)
    expect(constat.failure.screenshot).toBe(`preuves/echecs/${constat.failure.id}.png`)
    const png = readFileSync(join(dir, constat.failure.screenshot ?? ''))
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    // La capture d'une question posée sans localisateur est prise d'après le sélecteur.
    const question = first.pending[0]
    expect(question?.screenshot).toBe(`preuves/frame.title/${question?.key}.png`)
    expect(existsSync(join(dir, question?.screenshot ?? ''))).toBe(true)

    // « Doute » : la décision est enregistrée, la question reste ouverte et le dit.
    decisions.set('frame.title', question?.key ?? '', {
      answer: 'doute',
      evidence: question?.evidence ?? {},
      question: question?.question ?? '',
      reason: 'À vérifier avec le service carto',
      by: 'test',
      date: '2026-01-01',
    })
    const second = await audit({
      browser,
      urls: [url],
      checks,
      decisions: new DecisionStore(join(dir, 'd')),
      concurrency: 1,
      captures: 'aucune',
    })
    // 2.2.1 reste non conforme à cause du cadre au titre vide ; la question, elle, reste posée.
    expect(second.pages[0]?.results['2.2.1']?.pending[0]?.doubt?.by).toBe('test')
    expect(second.pending[0]?.doubt?.reason).toBe('À vérifier avec le service carto')
    expect(second.pages[0]?.results['2.2.1']?.notes.join(' ')).not.toMatch(/ignorée/)
  })
})
