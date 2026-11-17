import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { assertSafeSegment, containedPath, readJsonFile, writeJsonAtomic } from '../security/fs.ts'
import { Reader } from '../security/validate.ts'

/**
 * Décisions de jugement, à versionner avec le site audité.
 *
 * Certains tests RGAA ne se décident pas mécaniquement (« cette alternative
 * est-elle pertinente ? », « cette image est-elle décorative ? »). L'outil pose
 * alors une question, identifiée par une empreinte de son sujet et de ses
 * éléments de preuve. La réponse est enregistrée ici, une fois, et vaut pour
 * toutes les pages qui présentent le même contenu. Si le contenu change,
 * l'empreinte change et la question est reposée.
 *
 * Un fichier par sujet : `<dossier>/<sujet>.json`. Les fichiers sont validés à
 * la lecture : un fichier mal formé arrête l'outil plutôt que d'être ignoré en
 * silence, et un nom de sujet ne peut jamais désigner un fichier hors du dossier.
 */
export interface Decision {
  answer: string
  /** Copie lisible de ce qui a été jugé. */
  evidence: Record<string, string>
  question: string
  /** Justification du verdict. */
  reason: string
  /** Qui a tranché. */
  by: string
  /** Date de la décision, `AAAA-MM-JJ`. */
  date: string
}

/** Empreinte d'une question : 12 caractères hexadécimaux. */
export const KEY_PATTERN = /^[0-9a-f]{12}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_DECISION_FILE = 10 * 1024 * 1024

export const LIMITS = {
  reason: 2_000,
  by: 100,
  answer: 100,
} as const

export function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Empreinte stable d'une question : sujet + preuves triées par clé, espaces normalisés. */
export function judgementKey(topic: string, evidence: Record<string, string>): string {
  const canonical = Object.keys(evidence)
    .sort()
    .map((name) => `${name}=${normalize(evidence[name] ?? '')}`)
    .join('\n')
  return createHash('sha1').update(`${topic}\n${canonical}`).digest('hex').slice(0, 12)
}

export function parseDecision(read: Reader, value: unknown, path: string): Decision {
  const entry = read.record(value, path)
  return {
    answer: read.string(entry.answer, `${path}.answer`, LIMITS.answer),
    evidence: read.stringMap(entry.evidence, `${path}.evidence`),
    question: read.string(entry.question, `${path}.question`),
    reason: read.string(entry.reason, `${path}.reason`, LIMITS.reason),
    by: read.string(entry.by, `${path}.by`, LIMITS.by),
    date: read.matching(entry.date, DATE_PATTERN, `${path}.date`, 'AAAA-MM-JJ'),
  }
}

function parseDecisionFile(
  file: string,
  data: unknown,
  expectedTopic: string,
): Map<string, Decision> {
  const read = new Reader(file)
  const root = read.record(data, 'racine')
  const topic = read.string(root.topic, 'topic', 128)
  if (topic !== expectedTopic) {
    read.fail(`le sujet « ${topic} » ne correspond pas au nom du fichier (${expectedTopic}.json).`)
  }
  const entries = read.record(root.entries, 'entries')
  const out = new Map<string, Decision>()
  for (const [key, value] of Object.entries(entries)) {
    if (!KEY_PATTERN.test(key)) read.fail(`empreinte invalide « ${key.slice(0, 40)} ».`)
    out.set(key, parseDecision(read, value, `entries.${key}`))
  }
  return out
}

export class DecisionStore {
  private readonly topics = new Map<string, Map<string, Decision>>()
  private readonly used = new Set<string>()

  constructor(readonly dir: string) {
    if (!existsSync(dir)) return
    if (!lstatSync(dir).isDirectory()) {
      throw new Reader(dir).fail("le dossier des décisions n'est pas un dossier.")
    }
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue
      const topic = name.slice(0, -'.json'.length)
      assertSafeSegment(topic, `Nom de fichier de décisions (${name})`)
      const file = join(dir, name)
      this.topics.set(topic, parseDecisionFile(file, readJsonFile(file, MAX_DECISION_FILE), topic))
    }
  }

  get(topic: string, key: string): Decision | undefined {
    const decision = this.topics.get(topic)?.get(key)
    if (decision) this.used.add(`${topic}:${key}`)
    return decision
  }

  /** Nombre total de décisions enregistrées. */
  get size(): number {
    let total = 0
    for (const entries of this.topics.values()) total += entries.size
    return total
  }

  set(topic: string, key: string, decision: Decision): void {
    assertSafeSegment(topic, 'Sujet de décision')
    if (!KEY_PATTERN.test(key)) throw new Reader('décision').fail(`empreinte invalide « ${key} ».`)
    const entries = this.topics.get(topic) ?? new Map<string, Decision>()
    entries.set(key, decision)
    this.topics.set(topic, entries)
    const sorted = Array.from(entries).sort(([a], [b]) => a.localeCompare(b))
    writeJsonAtomic(containedPath(this.dir, `${topic}.json`), {
      topic,
      entries: Object.fromEntries(sorted),
    })
  }

  /** Décisions qu'aucune page auditée n'a sollicitées (contenu disparu ou modifié). */
  unused(): { topic: string; key: string; decision: Decision }[] {
    const stale: { topic: string; key: string; decision: Decision }[] = []
    for (const [topic, entries] of this.topics) {
      for (const [key, decision] of entries) {
        if (!this.used.has(`${topic}:${key}`)) stale.push({ topic, key, decision })
      }
    }
    return stale
  }
}
