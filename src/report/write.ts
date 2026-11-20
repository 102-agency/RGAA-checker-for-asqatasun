import { mkdirSync } from 'node:fs'
import type { Catalog } from '../core/catalog.ts'
import { containedPath, writeFileAtomic, writeJsonAtomic } from '../security/fs.ts'
import {
  buildToFix,
  type DecisionLookup,
  FULL_RESULTS_MARKDOWN,
  renderFullResults,
  renderToFixMarkdown,
  TO_FIX_JSON,
  TO_FIX_MARKDOWN,
} from './ai.ts'
import { renderHtml } from './html.ts'
import { renderMarkdown } from './markdown.ts'
import type { ReportDocument } from './model.ts'
import { REPORT_JSON } from './parse.ts'

export interface WrittenReport {
  json: string
  html: string
  markdown: string
  /** Non-conformités et doutes, pour corriger (humain ou IA). */
  toFixJson: string
  toFixMarkdown: string
  /** Tous les tests, tous les verdicts. */
  fullResults: string
}

/** Écrit toutes les formes du rapport dans `outDir` (écritures atomiques). */
export function writeReport(
  outDir: string,
  report: ReportDocument,
  catalog: Catalog,
  options: { decisions?: DecisionLookup } = {},
): WrittenReport {
  mkdirSync(outDir, { recursive: true })
  const written: WrittenReport = {
    json: containedPath(outDir, REPORT_JSON),
    html: containedPath(outDir, 'rapport.html'),
    markdown: containedPath(outDir, 'rapport.md'),
    toFixJson: containedPath(outDir, TO_FIX_JSON),
    toFixMarkdown: containedPath(outDir, TO_FIX_MARKDOWN),
    fullResults: containedPath(outDir, FULL_RESULTS_MARKDOWN),
  }
  writeJsonAtomic(written.json, report)
  writeFileAtomic(written.html, renderHtml(report, catalog))
  writeFileAtomic(written.markdown, renderMarkdown(report, catalog))
  writeToFix(outDir, report, catalog, options)
  writeFileAtomic(written.fullResults, renderFullResults(report, catalog))
  return written
}

/** Réécrit seulement les fichiers « à corriger » (après une décision, sans relancer l'audit). */
export function writeToFix(
  outDir: string,
  report: ReportDocument,
  catalog: Catalog,
  options: { decisions?: DecisionLookup } = {},
): void {
  const doc = buildToFix(report, catalog, { outDir, decisions: options.decisions })
  writeJsonAtomic(containedPath(outDir, TO_FIX_JSON), doc)
  writeFileAtomic(containedPath(outDir, TO_FIX_MARKDOWN), renderToFixMarkdown(doc))
}
