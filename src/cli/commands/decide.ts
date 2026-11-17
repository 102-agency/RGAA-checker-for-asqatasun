import { createInterface } from 'node:readline/promises'
import { loadCatalog } from '../../core/catalog.ts'
import { type Decision, DecisionStore, LIMITS } from '../../core/decisions.ts'
import { EXIT, UserError } from '../../core/errors.ts'
import type { PendingQuestion } from '../../report/model.ts'
import { REPORT_JSON, readReport } from '../../report/parse.ts'
import { paint, plural, type Style } from '../../report/style.ts'
import { containedPath, readJsonFile } from '../../security/fs.ts'
import { safeLine } from '../../security/text.ts'
import { Reader } from '../../security/validate.ts'
import { DECIDE_HELP } from '../help.ts'
import { absolute, DEFAULTS, outputStyle, parseCommand } from '../options.ts'
import { describeQuestion } from './pending.ts'

interface Answer {
  key: string
  answer: string
  reason: string
  by?: string
}

function readAnswers(file: string): Answer[] {
  const read = new Reader(file)
  return read.array(readJsonFile(file, 5 * 1024 * 1024), 'racine', 10_000).map((item, index) => {
    const entry = read.record(item, `[${index}]`)
    return {
      key: read.string(entry.key, `[${index}].key`, 40),
      answer: read.string(entry.answer, `[${index}].answer`, LIMITS.answer),
      reason: read.string(entry.reason ?? '', `[${index}].reason`, LIMITS.reason),
      by: read.optionalString(entry.by, `[${index}].by`, LIMITS.by),
    }
  })
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Contrôle une réponse et renvoie la décision à enregistrer, ou le motif du refus. */
function toDecision(
  item: PendingQuestion | undefined,
  answer: Answer,
  defaultBy: string,
): { decision: Decision; item: PendingQuestion } | { refused: string } {
  if (!item)
    return { refused: 'aucune question en attente avec cette empreinte dans le dernier rapport.' }
  if (!item.answers.includes(answer.answer)) {
    return {
      refused: `réponse « ${safeLine(answer.answer, 60)} » refusée (admises : ${item.answers.join(' | ')}).`,
    }
  }
  const reason = safeLine(answer.reason, LIMITS.reason)
  if (!reason) return { refused: 'une justification est obligatoire (--reason).' }
  const by = safeLine(answer.by ?? defaultBy, LIMITS.by) || defaultBy
  return {
    item,
    decision: {
      answer: answer.answer,
      evidence: item.evidence,
      question: item.question,
      reason,
      by,
      date: today(),
    },
  }
}

async function interactive(
  pending: PendingQuestion[],
  store: DecisionStore,
  by: string,
  outDir: string,
  style: Style,
): Promise<number> {
  const open = pending.filter((item) => !store.get(item.topic, item.key))
  if (open.length === 0) {
    process.stdout.write(
      `${paint(style, 'green', '✓')} Toutes les questions du dernier rapport ont une décision. Relancer l'audit pour les appliquer.\n`,
    )
    return EXIT.OK
  }
  const catalog = loadCatalog()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let saved = 0
  try {
    process.stdout.write(
      `${plural(open.length, 'question', 'questions')} sans décision. Pour chacune : tapez une réponse admise, « s » pour passer, « q » pour quitter.\n`,
    )
    for (const [index, item] of open.entries()) {
      process.stdout.write(
        `\n${describeQuestion(item, catalog, style, outDir, { position: index + 1, total: open.length })}\n\n`,
      )
      let answer = ''
      for (;;) {
        answer = (await rl.question(`  Réponse (${item.answers.join(' | ')} | s | q) : `)).trim()
        if (answer === 'q' || answer === 's' || item.answers.includes(answer)) break
        process.stdout.write(
          paint(style, 'red', `  Réponse non admise : ${safeLine(answer, 60)}\n`),
        )
      }
      if (answer === 'q') break
      if (answer === 's') continue
      let reason = ''
      while (!reason) {
        reason = safeLine(await rl.question('  Justification (obligatoire) : '), LIMITS.reason)
      }
      const result = toDecision(item, { key: item.key, answer, reason }, by)
      if ('refused' in result) {
        process.stdout.write(paint(style, 'red', `  ✗ ${result.refused}\n`))
        continue
      }
      store.set(item.topic, item.key, result.decision)
      saved += 1
      process.stdout.write(paint(style, 'green', `  ✓ Décision enregistrée (${item.topic}).\n`))
    }
  } finally {
    rl.close()
  }
  process.stdout.write(
    `\n${plural(saved, 'décision enregistrée', 'décisions enregistrées')} dans ${store.dir}. Relancer l'audit pour les appliquer.\n`,
  )
  return EXIT.OK
}

export async function commandDecide(args: string[]): Promise<number> {
  const { values, positionals } = parseCommand('decide', args, {
    reason: { type: 'string' },
    by: { type: 'string' },
    file: { type: 'string' },
    out: { type: 'string' },
    decisions: { type: 'string' },
    color: { type: 'boolean' },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) {
    process.stdout.write(DECIDE_HELP)
    return EXIT.OK
  }
  const outDir = absolute(values.out ?? DEFAULTS.out)
  const report = readReport(containedPath(outDir, REPORT_JSON))
  // Par défaut, les décisions vont là où l'audit les a lues.
  const store = new DecisionStore(
    values.decisions ? absolute(values.decisions) : report.meta.decisionsDir,
  )
  const by = safeLine(values.by ?? 'humain', LIMITS.by) || 'humain'
  const style = outputStyle(process.stdout, values.color)
  const byKey = new Map(report.pending.map((item) => [item.key, item]))

  let answers: Answer[]
  if (values.file) {
    if (positionals.length)
      throw new UserError('--file et une réponse en arguments sont exclusifs.')
    answers = readAnswers(absolute(values.file))
  } else if (positionals.length === 0) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new UserError(
        'Mode interactif impossible hors d’un terminal : rgaa decide <empreinte> <réponse> --reason "…" ou --file.',
      )
    }
    return interactive(report.pending, store, by, outDir, style)
  } else {
    if (positionals.length !== 2)
      throw new UserError('Attendu : rgaa decide <empreinte> <réponse> --reason "…"')
    answers = [
      { key: positionals[0] ?? '', answer: positionals[1] ?? '', reason: values.reason ?? '' },
    ]
  }

  let saved = 0
  for (const answer of answers) {
    const result = toDecision(byKey.get(answer.key), answer, by)
    if ('refused' in result) {
      process.stderr.write(
        `${paint(style, 'red', '✗')} ${safeLine(answer.key, 40)} : ${result.refused}\n`,
      )
      continue
    }
    store.set(result.item.topic, result.item.key, result.decision)
    saved += 1
    process.stdout.write(
      `${paint(style, 'green', '✓')} ${result.item.key} : « ${result.decision.answer} » enregistrée (${result.item.topic}).\n`,
    )
  }
  process.stdout.write(
    `${plural(saved, 'décision enregistrée', 'décisions enregistrées')} dans ${store.dir}. Relancer l'audit pour les appliquer.\n`,
  )
  return saved < answers.length ? EXIT.USAGE : EXIT.OK
}
