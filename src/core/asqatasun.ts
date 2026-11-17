import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readTextFile } from '../security/fs.ts'
import { canonicalPath } from '../security/url.ts'
import { parseCsv } from './csv.ts'
import { UserError } from './errors.ts'
import type { Status } from './types.ts'

/** Taille maximale d'un export CSV d'Asqatasun (les exports réels font quelques centaines de Ko). */
const MAX_EXPORT_BYTES = 50 * 1024 * 1024

/** Verdict d'Asqatasun pour un test. `PQ` (pré-qualifié) et `NT` (non testé) ne statuent pas. */
export type AsqatasunStatus = 'C' | 'NC' | 'NA' | 'PQ' | 'NT'

export interface AsqatasunReport {
  file: string
  /** Numéro de l'export (`Report_12.csv` → 12) : le plus grand l'emporte pour une même page. */
  number: number
  url: string
  path: string
  score: string
  results: Record<string, AsqatasunStatus>
}

export const ASQATASUN_LABEL: Record<AsqatasunStatus, string> = {
  C: 'Conforme',
  NC: 'Non-conforme',
  NA: 'Non-Applicable',
  PQ: 'Pré-qualifié',
  NT: 'Non testé',
}

const STATUS: Record<string, AsqatasunStatus> = {
  Conforme: 'C',
  'Non-conforme': 'NC',
  'Non-Applicable': 'NA',
  'Pré-qualifié': 'PQ',
  'Non testé': 'NT',
}

/**
 * Asqatasun audite le RGAA 4.0 ; le RGAA 4.1 a supprimé le test des unités relatives
 * (10.4.1) et renuméroté les deux suivants. Les autres tests gardent leur numéro.
 */
const RENUMBERED: Record<string, string | null> = {
  '10.4.1': null,
  '10.4.2': '10.4.1',
  '10.4.3': '10.4.2',
}

export function parseAsqatasunReport(file: string, text: string): AsqatasunReport | null {
  const rows = parseCsv(text)
  const url = /sur la page\s+(\S+)/.exec(rows[0]?.[0] ?? '')?.[1]
  if (!url) return null
  const results: Record<string, AsqatasunStatus> = Object.create(null)
  for (const row of rows.slice(3)) {
    const raw = row[2]
    const status = STATUS[row[5] ?? '']
    const test = raw && Object.hasOwn(RENUMBERED, raw) ? RENUMBERED[raw] : raw
    if (test && status && /^\d{1,2}\.\d{1,2}\.\d{1,2}$/.test(test)) results[test] = status
  }
  let path = '/'
  try {
    path = canonicalPath(new URL(url))
  } catch {
    return null
  }
  return {
    file,
    number: Number(/(\d+)\.csv$/.exec(file)?.[1] ?? 0),
    url,
    path,
    score: /Note\s*:\s*(\d+\s*%)/.exec(rows[1]?.[0] ?? '')?.[1] ?? '',
    results,
  }
}

/** Dernier export Asqatasun de chaque page (clé : chemin de l'URL, l'hôte est ignoré). */
export function loadAsqatasunReports(dir: string): Map<string, AsqatasunReport> {
  const latest = new Map<string, AsqatasunReport>()
  if (!existsSync(dir)) return latest
  if (!lstatSync(dir).isDirectory()) {
    throw new UserError(`${dir} n'est pas un dossier d'exports Asqatasun.`)
  }
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.csv')) continue
    const file = join(dir, name)
    if (!lstatSync(file).isFile()) continue
    const report = parseAsqatasunReport(name, readTextFile(file, MAX_EXPORT_BYTES))
    if (!report) continue
    const known = latest.get(report.path)
    if (!known || report.number > known.number) latest.set(report.path, report)
  }
  return latest
}

/**
 * Verdict final d'un test : le plus sévère des deux outils. Un « Non-conforme »
 * d'Asqatasun reste un échec même si l'outil conclut autrement ; pour le reste,
 * c'est le verdict de l'outil, qui statue là où Asqatasun ne le fait pas.
 */
export function mergeStatus(tool: Status, asqatasun: AsqatasunStatus | undefined): Status {
  if (asqatasun === 'NC') return 'NC'
  return tool
}

/** Les deux outils se contredisent-ils sur un test que tous deux statuent ? */
export function disagrees(tool: Status, asqatasun: AsqatasunStatus | undefined): boolean {
  if (!asqatasun || asqatasun === 'PQ' || asqatasun === 'NT') return false
  if (tool === 'AV' || tool === 'NT' || tool === 'ERR') return false
  const failing = (status: string) => status === 'NC'
  return failing(tool) !== failing(asqatasun)
}
