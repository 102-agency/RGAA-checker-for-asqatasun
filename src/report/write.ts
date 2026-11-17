import { mkdirSync } from 'node:fs'
import type { Catalog } from '../core/catalog.ts'
import { containedPath, writeFileAtomic, writeJsonAtomic } from '../security/fs.ts'
import { renderHtml } from './html.ts'
import { renderMarkdown } from './markdown.ts'
import type { ReportDocument } from './model.ts'
import { REPORT_JSON } from './parse.ts'

export interface WrittenReport {
  json: string
  html: string
  markdown: string
}

/** Écrit les trois formes du rapport dans `outDir` (écritures atomiques). */
export function writeReport(
  outDir: string,
  report: ReportDocument,
  catalog: Catalog,
): WrittenReport {
  mkdirSync(outDir, { recursive: true })
  const written: WrittenReport = {
    json: containedPath(outDir, REPORT_JSON),
    html: containedPath(outDir, 'rapport.html'),
    markdown: containedPath(outDir, 'rapport.md'),
  }
  writeJsonAtomic(written.json, report)
  writeFileAtomic(written.html, renderHtml(report, catalog))
  writeFileAtomic(written.markdown, renderMarkdown(report, catalog))
  return written
}
