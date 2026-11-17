/**
 * Validation minimale des données lues sur disque (décisions, rapport, réponses).
 *
 * Volontairement sans dépendance : quelques gardes de type suffisent, et chaque
 * dépendance en moins est une surface d'attaque en moins. Les objets produits
 * sont reconstruits champ par champ : une clé inattendue (`__proto__`,
 * `constructor`…) n'est jamais recopiée.
 */
import { UserError } from '../core/errors.ts'

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export class Reader {
  constructor(private readonly where: string) {}

  fail(message: string): never {
    throw new UserError(`${this.where} : ${message}`)
  }

  record(value: unknown, path: string): JsonRecord {
    if (!isRecord(value)) this.fail(`${path} doit être un objet.`)
    return value
  }

  array(value: unknown, path: string, max = 100_000): unknown[] {
    if (!Array.isArray(value)) this.fail(`${path} doit être une liste.`)
    if (value.length > max)
      this.fail(`${path} contient trop d'éléments (${value.length} > ${max}).`)
    return value
  }

  string(value: unknown, path: string, max = 20_000): string {
    if (typeof value !== 'string') this.fail(`${path} doit être une chaîne.`)
    if (value.length > max)
      this.fail(`${path} est trop long (${value.length} > ${max} caractères).`)
    return value
  }

  optionalString(value: unknown, path: string, max = 20_000): string | undefined {
    return value === undefined || value === null ? undefined : this.string(value, path, max)
  }

  number(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value))
      this.fail(`${path} doit être un nombre.`)
    return value
  }

  nullableNumber(value: unknown, path: string): number | null {
    return value === null ? null : this.number(value, path)
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') this.fail(`${path} doit être un booléen.`)
    return value
  }

  oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      this.fail(`${path} doit valoir ${allowed.join(', ')}.`)
    }
    return value as T
  }

  matching(value: unknown, pattern: RegExp, path: string, description: string): string {
    const text = this.string(value, path, 200)
    if (!pattern.test(text)) this.fail(`${path} invalide (${description}).`)
    return text
  }

  /** Dictionnaire chaîne → chaîne, reconstruit sans prototype hérité. */
  stringMap(value: unknown, path: string, maxEntries = 200): Record<string, string> {
    const source = this.record(value, path)
    const entries = Object.entries(source)
    if (entries.length > maxEntries) this.fail(`${path} contient trop d'entrées.`)
    const out: Record<string, string> = Object.create(null)
    for (const [key, item] of entries) {
      if (FORBIDDEN_KEYS.has(key)) this.fail(`${path} contient la clé interdite « ${key} ».`)
      out[key] = this.string(item, `${path}.${key}`)
    }
    // Objet ordinaire en sortie (pour JSON.stringify et les comparaisons), clés déjà filtrées.
    return { ...out }
  }

  stringList(value: unknown, path: string, max = 10_000): string[] {
    return this.array(value, path, max).map((item, index) => this.string(item, `${path}[${index}]`))
  }
}
