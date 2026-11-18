import type { BrowserContext } from 'playwright'
import { readJsonFile } from '../security/fs.ts'
import { Reader } from '../security/validate.ts'
import { UserError } from './errors.ts'

/**
 * Audit de pages derrière une connexion.
 *
 * Deux moyens, combinables :
 * - `--storage-state <fichier>` : l'état de session de Playwright (cookies et
 *   localStorage), obtenu une fois par une connexion manuelle
 *   (`npx playwright codegen --save-storage=auth.json <url>`) ;
 * - `--cookie nom=valeur` (répétable, ou `RGAA_COOKIES="a=1; b=2"`) : cookies
 *   posés sur le site audité.
 *
 * Les secrets ne sortent jamais du site audité : l'état de session est filtré
 * (cookies du domaine, localStorage de l'origine), les cookies sont posés
 * pour l'adresse du site seulement, et rien de tout cela n'est écrit dans les
 * rapports, les journaux ni les messages d'erreur.
 */

export interface AuthSettings {
  /** Chemin absolu d'un fichier d'état de session Playwright. */
  storageState?: string
  /** Cookies `nom=valeur` à poser sur le site audité. */
  cookies?: string[]
}

type StorageCookie = Parameters<BrowserContext['addCookies']>[0][number]

/** Cookie complet d'un fichier d'état de session (forme exigée par Playwright). */
export interface StateCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

export interface StorageState {
  cookies: StateCookie[]
  origins: { origin: string; localStorage: { name: string; value: string }[] }[]
}

/** Authentification prête à servir : relue, validée et filtrée sur le site. */
export interface ResolvedAuth {
  storageState?: StorageState
  cookies: StorageCookie[]
  /** Pour le journal (jamais les valeurs). */
  summary: string
}

const COOKIE_NAME = /^[\w!#$%&'*+.^`|~-]+$/
const MAX_COOKIES = 50

function hostMatches(host: string, domain: string): boolean {
  const clean = domain.replace(/^\./, '').toLowerCase()
  return host === clean || host.endsWith(`.${clean}`)
}

export function parseCookie(input: string, base: URL): StorageCookie {
  const index = input.indexOf('=')
  const name = input.slice(0, index).trim()
  const value = input.slice(index + 1).trim()
  if (index < 1 || !COOKIE_NAME.test(name) || /[\s;,]/.test(value)) {
    // Le message ne reprend jamais la valeur : c'est un secret.
    throw new UserError(
      'Cookie invalide : attendu « nom=valeur » (sans espace, point-virgule ni virgule dans la valeur).',
    )
  }
  return { name, value, url: base.origin }
}

/** Cookies de `--cookie` et de `RGAA_COOKIES` (séparés par des points-virgules). */
export function cookieInputs(flags: string[] | undefined, env: string | undefined): string[] {
  const fromEnv = (env ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
  return [...(flags ?? []), ...fromEnv]
}

function readStorageState(file: string, base: URL): StorageState {
  let raw: unknown
  try {
    raw = readJsonFile(file, 5 * 1024 * 1024)
  } catch (error) {
    throw new UserError(
      `État de session illisible (${file}) : ${error instanceof Error ? error.message.split('\n')[0] : 'erreur inconnue'}`,
    )
  }
  const read = new Reader('état de session')
  const root = read.record(raw, 'racine')
  const host = base.hostname.toLowerCase()
  const cookies: StateCookie[] = []
  for (const [index, item] of read.array(root.cookies ?? [], 'cookies', 2_000).entries()) {
    const cookie = read.record(item, `cookies[${index}]`)
    const domain = read.string(cookie.domain, `cookies[${index}].domain`, 300)
    if (!hostMatches(host, domain)) continue
    const sameSite = cookie.sameSite
    cookies.push({
      name: read.string(cookie.name, `cookies[${index}].name`, 300),
      value: read.optionalString(cookie.value, `cookies[${index}].value`, 20_000) ?? '',
      domain,
      path: read.optionalString(cookie.path, `cookies[${index}].path`, 1_000) ?? '/',
      expires: typeof cookie.expires === 'number' ? cookie.expires : -1,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === true,
      sameSite:
        sameSite === 'Strict' || sameSite === 'Lax' || sameSite === 'None' ? sameSite : 'Lax',
    })
  }
  const origins: StorageState['origins'] = []
  for (const [index, item] of read.array(root.origins ?? [], 'origins', 200).entries()) {
    const entry = read.record(item, `origins[${index}]`)
    const origin = read.string(entry.origin, `origins[${index}].origin`, 500)
    if (origin !== base.origin) continue
    const storage = read.array(entry.localStorage ?? [], `origins[${index}].localStorage`, 2_000)
    origins.push({
      origin,
      localStorage: storage.map((pair, at) => {
        const record = read.record(pair, `origins[${index}].localStorage[${at}]`)
        return {
          name: read.string(record.name, 'name', 1_000),
          value: read.optionalString(record.value, 'value', 200_000) ?? '',
        }
      }),
    })
  }
  return { cookies, origins }
}

/** Valide et prépare l'authentification, avant de lancer le navigateur. */
export function resolveAuth(
  settings: AuthSettings | undefined,
  base: URL,
): ResolvedAuth | undefined {
  if (!settings || (!settings.storageState && !settings.cookies?.length)) return undefined
  const cookieList = (settings.cookies ?? []).map((item) => parseCookie(item, base))
  if (cookieList.length > MAX_COOKIES) {
    throw new UserError(`Trop de cookies (${cookieList.length}, maximum ${MAX_COOKIES}).`)
  }
  const storageState = settings.storageState
    ? readStorageState(settings.storageState, base)
    : undefined
  if (storageState && storageState.cookies.length + storageState.origins.length === 0) {
    throw new UserError(
      `L'état de session ne contient rien pour ${base.hostname} : se connecter à ce site avant de l'enregistrer.`,
    )
  }
  const parts: string[] = []
  if (storageState) {
    parts.push(
      `état de session (${storageState.cookies.length} cookie(s), ${storageState.origins.length} origine(s))`,
    )
  }
  if (cookieList.length) parts.push(`${cookieList.length} cookie(s)`)
  return {
    storageState,
    cookies: cookieList,
    summary: `Authentification : ${parts.join(' + ')} pour ${base.origin}.`,
  }
}
