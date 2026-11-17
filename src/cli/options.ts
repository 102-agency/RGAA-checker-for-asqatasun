import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type ParseArgsConfig, parseArgs } from 'node:util'
import type { Catalog } from '../core/catalog.ts'
import { UserError } from '../core/errors.ts'
import { ASSETS } from '../core/paths.ts'
import { type Style, shouldColor, terminalWidth } from '../report/style.ts'

/** Analyse stricte des arguments : toute option inconnue est une erreur, avec un message clair. */
export function parseCommand<T extends NonNullable<ParseArgsConfig['options']>>(
  command: string,
  args: string[],
  options: T,
) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true, allowNegative: true })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    throw new UserError(`${text.split('\n')[0]}\n  Aide : rgaa ${command} --help`)
  }
}

/** Entier borné, avec un message qui dit ce qui est attendu. */
export function integerOption(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value.trim())) {
    throw new UserError(`--${name} attend un nombre entier (reçu « ${value.slice(0, 40)} »).`)
  }
  const number = Number(value)
  if (number < min || number > max) {
    throw new UserError(`--${name} doit être compris entre ${min} et ${max} (reçu ${number}).`)
  }
  return number
}

export function choiceOption<T extends string>(
  value: string | undefined,
  name: string,
  choices: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback
  if (!(choices as readonly string[]).includes(value)) {
    throw new UserError(
      `--${name} accepte : ${choices.join(', ')} (reçu « ${value.slice(0, 40)} »).`,
    )
  }
  return value as T
}

/** Valeurs d'une option répétable, chacune pouvant contenir une liste séparée par des virgules. */
export function listOption(values: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  )
}

export interface Scope {
  themes: string[]
  criteria: string[]
  tests: string[]
}

/** Valide le périmètre (thématiques, critères, tests) contre le référentiel. */
export function resolveScope(catalog: Catalog, raw: Scope): Scope {
  const unknown: string[] = []
  for (const theme of raw.themes) {
    if (!/^\d{1,2}$/.test(theme) || !catalog.themes.has(Number(theme)))
      unknown.push(`thématique ${theme}`)
  }
  for (const criterion of raw.criteria) {
    if (!catalog.criteria.has(criterion)) unknown.push(`critère ${criterion}`)
  }
  for (const test of raw.tests) {
    if (!catalog.byTest.has(test)) unknown.push(`test ${test}`)
  }
  if (unknown.length) {
    throw new UserError(
      `Hors du référentiel RGAA 4.1.2 : ${unknown.join(', ')}. Les thématiques vont de 1 à 13 ; « rgaa explain <n> » liste les critères et tests.`,
    )
  }
  return {
    themes: raw.themes.map((theme) => String(Number(theme))),
    criteria: raw.criteria,
    tests: raw.tests,
  }
}

export function scopeFilter(scope: Scope): (test: string) => boolean {
  if (scope.themes.length + scope.criteria.length + scope.tests.length === 0) return () => true
  return (test) => {
    const [theme, criterion] = test.split('.')
    return (
      scope.themes.includes(theme ?? '') ||
      scope.criteria.includes(`${theme}.${criterion}`) ||
      scope.tests.includes(test)
    )
  }
}

export function outputStyle(stream: NodeJS.WriteStream, color: boolean | undefined): Style {
  return { color: shouldColor(stream, process.env, color), width: terminalWidth(stream) }
}

export function absolute(path: string): string {
  return resolve(process.cwd(), path)
}

let version: string | undefined
export function toolVersion(): string {
  if (version === undefined) {
    try {
      const data = JSON.parse(readFileSync(ASSETS.packageJson, 'utf8')) as { version?: unknown }
      version = typeof data.version === 'string' ? data.version : '0.0.0'
    } catch {
      version = '0.0.0'
    }
  }
  return version
}

export const TOOL_NAME = 'rgaa-checker'

/** Dossiers par défaut, relatifs au dossier courant. */
export const DEFAULTS = {
  out: 'rgaa-report',
  decisions: 'rgaa-decisions',
} as const
