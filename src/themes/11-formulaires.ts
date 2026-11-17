import type { Page } from 'playwright'
import {
  type Check,
  defineCheck,
  defineSiteCheck,
  type ElementRef,
  type JudgeRequest,
  type Outcome,
  type PageContext,
} from '../core/types.ts'
import { collectForms } from '../lib/formulaires-collect.ts'
import {
  EXAMPLE_HINT,
  FORMAT_HINT,
  GENERIC_BUTTON,
  GENERIC_LABEL,
  inferPurpose,
  isSymbolOnly,
  nameContains,
  parseAutocomplete,
  squash,
} from '../lib/formulaires-logic.ts'
import { type FormProbe, probeForms } from '../lib/formulaires-probe.ts'
import type {
  ButtonInfo,
  FieldInfo,
  FormInfo,
  FormsSnapshot,
  Geometry,
  GroupInfo,
} from '../lib/formulaires-types.ts'

/**
 * Thématique 11 — Formulaires.
 *
 * Un seul relevé de la page (`collectForms`) alimente toutes les vérifications ;
 * les états d'erreur sont obtenus en soumettant réellement les formulaires sur
 * une page `ctx.fresh()` (voir `formulaires-probe.ts`).
 */

// ─── Données partagées ──────────────────────────────────────────────────────

const snapshotOf = (ctx: PageContext): Promise<FormsSnapshot> =>
  ctx.memo('formulaires.relevé', () => ctx.page.evaluate(collectForms, false))

const probesOf = (ctx: PageContext): Promise<FormProbe[]> =>
  ctx.memo('formulaires.sondes', async () => probeForms(ctx, await snapshotOf(ctx)))

/** Étiquette lisible d'un champ, sans astérisque de fin. */
function labelOf(field: FieldInfo): string {
  const text = field.nameText || field.visibleLabel || field.accName || field.placeholder
  return text.replace(/\s*\*+\s*$/, '').trim()
}

const cleanLabel = (text: string): string => text.replace(/\s*\*+\s*$/, '').trim()

/** Question de jugement posée une seule fois par page pour une même empreinte. */
function asker(ctx: PageContext) {
  const seen = new Map<Outcome, Set<string>>()
  return async function ask(
    outcome: Outcome,
    request: Omit<JudgeRequest, 'answers' | 'screenshot'>,
    target?: ElementRef,
  ): Promise<void> {
    const key = `${request.topic}|${JSON.stringify(request.evidence)}`
    let done = seen.get(outcome)
    if (!done) {
      done = new Set()
      seen.set(outcome, done)
    }
    if (done.has(key)) return
    done.add(key)
    await outcome.judgePass({
      ...request,
      ref: request.ref ?? target,
      screenshot: target ? ctx.page.locator(target.selector).first() : undefined,
    })
  }
}

const NEAR_VERTICAL = 40
const NEAR_HORIZONTAL = 150
const NEAR_DIAGONAL = 48

/** L'étiquette est-elle accolée au champ ? Plus tolérant sur une même ligne (colonne d'étiquettes). */
function isNear(geometry: Geometry): boolean {
  switch (geometry.relation) {
    case 'inside':
      return true
    case 'above':
    case 'below':
      return geometry.gap <= NEAR_VERTICAL
    case 'left':
    case 'right':
      return geometry.gap <= NEAR_HORIZONTAL
    default:
      return geometry.distance <= NEAR_DIAGONAL
  }
}

const describe = (f: FieldInfo): string => `Le champ « ${labelOf(f) || f.kind} »`

// ─── 11.1 : étiquettes ──────────────────────────────────────────────────────

const labelling = defineCheck(['11.1.1', '11.1.2', '11.1.3', '11.2.6'], async (ctx, t) => {
  const snap = await snapshotOf(ctx)
  const ask = asker(ctx)

  for (const f of snap.fields) {
    // 11.1.1 — au moins une des techniques d'étiquetage du RGAA.
    t('11.1.1').applicable()
    const labelledby = f.labelledby?.some((p) => p.exists && p.text !== '') ?? false
    const labelFor = f.labels.some((l) => l.forMatches && (l.text !== '' || l.visibleText !== ''))
    if (!(labelledby || f.ariaLabel !== '' || labelFor || f.title !== '')) {
      let why = 'Aucune étiquette (label for/id, aria-label, aria-labelledby ou title).'
      if (f.labelledby && !labelledby) {
        why = 'aria-labelledby ne référence aucun passage de texte existant et non vide.'
      } else if (f.labels.some((l) => l.forMatches)) {
        why = 'L’étiquette <label for> associée est vide.'
      } else if (f.labels.length > 0) {
        why =
          'L’étiquette est implicite (champ à l’intérieur de <label>) : le RGAA exige un <label> avec attribut for égal à l’id du champ.'
      } else if (f.placeholder) {
        why = 'Seul l’attribut placeholder tient lieu d’étiquette (il n’en est pas une).'
      }
      t('11.1.1').fail(`${describe(f)} n’a pas d’étiquette valide : ${why}`, f.ref)
    }

    // 11.1.3 — étiquette non visible, ou visible mais pas accolée au champ.
    const near = f.geometry ? isNear(f.geometry) : f.visibleLabel !== ''
    if (near && f.visibleLabel !== '') continue
    t('11.1.3').applicable()
    const name = labelOf(f) || f.accName
    if (f.adjacentButton) {
      // Le bouton adjacent qui porte l'étiquette visible : même jugement que 11.2.6.
      await ask(
        t('11.1.3'),
        {
          topic: 'form.button-label',
          question: `Le bouton « ${f.adjacentButton.text} », accolé au champ « ${name} » (${f.kind}), fournit son étiquette visible : indique-t-il la fonction exacte du champ ?`,
          evidence: { bouton: f.adjacentButton.text, champ: `${f.kind} « ${name} »` },
        },
        f.ref,
      )
      continue
    }
    const hints = [
      f.title ? `title « ${f.title} »` : null,
      f.adjacentText ? `texte visible « ${f.adjacentText} »` : null,
      f.placeholder ? `placeholder « ${f.placeholder} »` : null,
    ].filter((h): h is string => h !== null)
    if (hints.length === 0) {
      const raison = f.visibleLabel
        ? 'son étiquette n’est pas accolée au champ'
        : 'son étiquette n’est pas visible'
      t('11.1.3').fail(
        `${describe(f)} : ${raison} et ni title, ni texte visible accolé ne permet de comprendre la saisie attendue.`,
        f.ref,
      )
      continue
    }
    await ask(
      t('11.1.3'),
      {
        topic: 'form.label-hidden',
        question: `Le champ « ${name} » (${f.kind}) n’a pas d’étiquette visible accolée. Les indications ci-dessous permettent-elles de comprendre la nature de la saisie attendue ?`,
        evidence: { champ: `${f.kind} « ${name} »`, indications: hints.join(' ; ') },
      },
      f.ref,
    )
  }

  // 11.1.2 — chaque <label for> doit désigner l'id d'un champ.
  for (const lf of snap.labelFors) {
    t('11.1.2').applicable()
    if (!lf.targetExists) {
      t('11.1.2').fail(
        lf.forValue === ''
          ? 'L’attribut for du label est vide.'
          : `La valeur for="${lf.forValue}" du label ne correspond à l’id d’aucun élément.`,
        lf.ref,
      )
    } else if (!lf.targetLabelable) {
      t('11.1.2').fail(
        `Le label for="${lf.forValue}" désigne un <${lf.targetTag}> qui n’est pas un champ de formulaire.`,
        lf.ref,
      )
    } else if (lf.duplicateId) {
      t('11.1.2').fail(
        `L’id="${lf.forValue}" est porté par plusieurs éléments : le label ne désigne que le premier.`,
        lf.ref,
      )
    }
  }

  // 11.2.6 — bouton adjacent qui fournit l'étiquette visible du champ.
  for (const f of snap.fields) {
    if (!f.adjacentButton || (f.visibleLabel !== '' && (!f.geometry || isNear(f.geometry))))
      continue
    const name = labelOf(f) || f.accName
    await ask(
      t('11.2.6'),
      {
        topic: 'form.button-label',
        question: `Le bouton « ${f.adjacentButton.text} », accolé au champ « ${name} » (${f.kind}), fournit son étiquette visible : indique-t-il la fonction exacte du champ ?`,
        evidence: { bouton: f.adjacentButton.text, champ: `${f.kind} « ${name} »` },
      },
      f.ref,
    )
  }
})

// ─── 11.2 : pertinence des étiquettes ───────────────────────────────────────

const SOURCE_TEST = {
  'aria-labelledby': '11.2.4',
  'aria-label': '11.2.3',
  label: '11.2.1',
  title: '11.2.2',
} as const

/** Nom de l'ensemble de champs (légende) qui contient le champ : sert à juger « Oui » / « Non ». */
function groupNameOf(snap: FormsSnapshot, f: FieldInfo): string {
  for (const g of f.groups) {
    const name = snap.groups[g]?.name
    if (name) return name
  }
  return ''
}

const relevance = defineCheck(
  ['11.2.1', '11.2.2', '11.2.3', '11.2.4', '11.2.5'],
  async (ctx, t) => {
    const snap = await snapshotOf(ctx)
    const ask = asker(ctx)

    for (const f of snap.fields) {
      // 11.2.1 à 11.2.4 — l'étiquette retenue (ordre aria-labelledby, aria-label, label, title).
      if (f.nameSource !== 'none') {
        const o = t(SOURCE_TEST[f.nameSource])
        o.applicable()
        const text = cleanLabel(f.nameText)
        const squashed = squash(text)
        if (
          GENERIC_LABEL.test(squashed) ||
          /_/.test(text) ||
          /^(field|input|champ|text|textfield|label)[-_ ]?\d+$/i.test(text)
        ) {
          o.fail(`${describe(f)} a une étiquette sans signification : « ${text} ».`, f.ref)
        } else if (squashed === '') {
          o.fail(
            `${describe(f)} a une étiquette sans texte exploitable : « ${f.nameText} ».`,
            f.ref,
          )
        } else {
          const group = groupNameOf(snap, f)
          const evidence: Record<string, string> = { étiquette: text, champ: f.kind }
          if (group) evidence.groupe = group
          await ask(
            o,
            {
              topic: 'form.label',
              question: `L’étiquette « ${text} »${group ? ` (dans l’ensemble « ${group} »)` : ''} permet-elle de connaître la fonction exacte du champ (${f.kind}) ?`,
              evidence,
            },
            f.ref,
          )
        }
      }

      // 11.2.5 — l'étiquette (sous toutes ses formes) contient l'intitulé visible.
      if (f.visibleLabels.length === 0) continue
      const o = t('11.2.5')
      o.applicable()
      const techniques: { kind: string; text: string }[] = []
      const labelledText = (f.labelledby ?? [])
        .filter((p) => p.exists)
        .map((p) => p.text)
        .join(' ')
      if (labelledText) techniques.push({ kind: 'aria-labelledby', text: labelledText })
      if (f.ariaLabel) techniques.push({ kind: 'aria-label', text: f.ariaLabel })
      if (f.title) techniques.push({ kind: 'title', text: f.title })
      const labelText = f.labels.map((l) => l.text).join(' ')
      if (labelText) techniques.push({ kind: 'label', text: labelText })
      for (const visible of f.visibleLabels) {
        if (isSymbolOnly(visible.replace(/\s*\*+\s*$/, ''))) {
          // Le texte sert de symbole : le nom doit exprimer la fonction, pas l'épeler.
          await ask(
            o,
            {
              topic: 'form.label.symbol',
              question: `Le texte visible « ${visible} » sert de symbole : le nom accessible « ${f.accName} » exprime-t-il sa fonction ?`,
              evidence: { symbole: visible, nom: f.accName },
            },
            f.ref,
          )
          continue
        }
        for (const technique of techniques) {
          if (!nameContains(technique.text, visible)) {
            o.fail(
              `${describe(f)} : l’intitulé visible « ${cleanLabel(visible)} » n’est pas repris dans ${technique.kind} (« ${technique.text} »).`,
              f.ref,
            )
          }
        }
      }
    }
  },
)

// ─── 11.3 : cohérence des étiquettes ────────────────────────────────────────

/** Fonction d'un champ : sa finalité autocomplete ou « recherche ». `null` s'il n'en a pas de déclarée. */
function functionOf(f: FieldInfo): string | null {
  if (f.checkable) return null
  if (f.autocomplete) {
    const parsed = parseAutocomplete(f.autocomplete)
    if (parsed.valid && parsed.field) return parsed.field
  }
  if (f.kind === 'search' || f.role === 'searchbox') return 'recherche'
  return null
}

const consistency = defineCheck(['11.3.1'], async (ctx, t) => {
  const snap = await snapshotOf(ctx)
  const ask = asker(ctx)
  const byFunction = new Map<string, FieldInfo[]>()
  const facts: { fonction: string; etiquette: string }[] = []
  for (const f of snap.fields) {
    const fn = functionOf(f)
    const label = cleanLabel(f.visibleLabel || f.nameText)
    if (!fn || !label) continue
    byFunction.set(fn, [...(byFunction.get(fn) ?? []), f])
    facts.push({ fonction: fn, etiquette: label })
  }
  ctx.record('form.fonctions', facts)

  for (const [fn, list] of byFunction) {
    if (list.length < 2) continue
    t('11.3.1').applicable()
    const labels = new Map<string, string>()
    for (const f of list) {
      const label = cleanLabel(f.visibleLabel || f.nameText)
      if (!labels.has(squash(label))) labels.set(squash(label), label)
    }
    if (labels.size < 2) continue
    const distinct = Array.from(labels.values()).sort()
    await ask(
      t('11.3.1'),
      {
        topic: 'form.label.coherence',
        question: `Ces ${list.length} champs ont la même fonction (${fn}) mais des étiquettes différentes : sont-elles cohérentes (on comprend qu’il s’agit de la même information) ?`,
        evidence: { fonction: fn, étiquettes: distinct.join(' | ') },
      },
      list[0]?.ref,
    )
  }
  if (snap.fields.length > 0) {
    t('11.3.1').note(
      'Seuls les champs dont la fonction est déclarée (attribut autocomplete valide, champ de recherche) sont rapprochés.',
    )
  }
})

const siteConsistency = defineSiteCheck(['11.3.2'], async (site, t) => {
  interface Fact {
    fonction: string
    etiquette: string
  }
  const perFunction = new Map<string, { labels: Map<string, string>; pages: Set<string> }>()
  for (const record of site.records('form.fonctions')) {
    for (const fact of record.value as Fact[]) {
      const entry = perFunction.get(fact.fonction) ?? { labels: new Map(), pages: new Set() }
      if (!entry.labels.has(squash(fact.etiquette)))
        entry.labels.set(squash(fact.etiquette), fact.etiquette)
      entry.pages.add(record.url)
      perFunction.set(fact.fonction, entry)
    }
  }
  for (const [fn, entry] of perFunction) {
    if (entry.pages.size < 2) continue
    const distinct = Array.from(entry.labels.values()).sort()
    for (const url of entry.pages) {
      const o = t(url, '11.3.2')
      o.applicable()
      if (distinct.length < 2) continue
      await o.judgePass({
        topic: 'form.label.coherence',
        question: `Le champ de fonction « ${fn} » est étiqueté différemment selon les pages : ces étiquettes sont-elles cohérentes (même information) ?`,
        evidence: { fonction: fn, étiquettes: distinct.join(' | ') },
      })
    }
  }
})

// ─── 11.4 : étiquette accolée au champ ──────────────────────────────────────

const placement = defineCheck(['11.4.1', '11.4.2', '11.4.3'], async (ctx, t) => {
  const snap = await snapshotOf(ctx)

  // Cas particulier : formulaire qui mêle des étiquettes de sens de lecture opposés.
  const directions = new Map<number, Set<boolean>>()
  for (const f of snap.fields) {
    if (!f.geometry) continue
    const set = directions.get(f.formIndex) ?? new Set<boolean>()
    set.add(f.geometry.rtl)
    directions.set(f.formIndex, set)
  }

  let floating = 0
  for (const f of snap.fields) {
    const g = f.geometry
    if (!g) continue
    if (g.mixedDirection || (directions.get(f.formIndex)?.size ?? 0) > 1) {
      t('11.4.2').note(
        'Étiquettes de sens de lecture mêlés : 11.4.2 et 11.4.3 non applicables (cas particulier).',
      )
      continue
    }
    t('11.4.1').applicable()
    if (!isNear(g)) {
      t('11.4.1').fail(
        `${describe(f)} : l’étiquette est à ${g.gap} px (${g.relation === 'diagonal' ? 'en diagonale' : g.relation === 'above' || g.relation === 'below' ? 'au-dessus ou au-dessous' : 'sur le côté'}) du champ, elle n’est pas accolée.`,
        f.ref,
      )
    }
    if (g.relation === 'inside') {
      floating += 1
      continue
    }
    if (f.checkable) {
      // Case à cocher / bouton radio : à droite ou au-dessous (à gauche en sens RTL).
      const allowed = g.rtl ? ['left', 'above', 'below'] : ['right', 'above', 'below']
      t('11.4.3').applicable()
      if (g.relation !== 'diagonal' && !allowed.includes(g.relation)) {
        t('11.4.3').fail(
          `${describe(f)} : l’étiquette est ${positionLabel(g.relation)} de la case, alors qu’elle doit être à ${g.rtl ? 'gauche' : 'droite'} ou au-dessous.`,
          f.ref,
        )
      }
    } else {
      // Autre champ : au-dessus ou à gauche (à droite en sens RTL).
      const allowed = g.rtl ? ['right', 'above'] : ['left', 'above']
      t('11.4.2').applicable()
      if (g.relation !== 'diagonal' && !allowed.includes(g.relation)) {
        t('11.4.2').fail(
          `${describe(f)} : l’étiquette est ${positionLabel(g.relation)} du champ, alors qu’elle doit être au-dessus ou à ${g.rtl ? 'droite' : 'gauche'}.`,
          f.ref,
        )
      }
    }
  }
  if (floating > 0) {
    t('11.4.2').note(
      `${floating} étiquette(s) superposée(s) au champ (étiquette flottante ?) : leur position n’est pas vérifiable.`,
    )
  }
  for (const f of snap.fields) {
    if (!f.fieldVisible && f.visibleLabel) {
      t('11.4.3').note(
        'Contrôle natif masqué (case ou radio personnalisé) : la position de l’étiquette n’est pas mesurée.',
      )
      break
    }
  }
})

function positionLabel(relation: Geometry['relation']): string {
  return {
    above: 'au-dessus',
    below: 'au-dessous',
    left: 'à gauche',
    right: 'à droite',
    inside: 'dans',
    diagonal: 'en diagonale',
  }[relation]
}

// ─── 11.5 à 11.7 : regroupements de champs ──────────────────────────────────

/** Familles de champs de même nature repérées par leur finalité autocomplete. */
const FAMILIES: Record<string, string[]> = {
  identité: [
    'honorific-prefix',
    'given-name',
    'additional-name',
    'family-name',
    'honorific-suffix',
  ],
  adresse: [
    'street-address',
    'address-line1',
    'address-line2',
    'address-line3',
    'address-level1',
    'address-level2',
    'address-level3',
    'address-level4',
    'postal-code',
    'country',
    'country-name',
  ],
  date: ['bday-day', 'bday-month', 'bday-year', 'cc-exp-month', 'cc-exp-year'],
  téléphone: [
    'tel-country-code',
    'tel-national',
    'tel-area-code',
    'tel-local',
    'tel-local-prefix',
    'tel-local-suffix',
    'tel-extension',
  ],
  'carte bancaire': ['cc-name', 'cc-number', 'cc-exp', 'cc-csc', 'cc-type'],
}

/** Plus proche regroupement commun à tous les champs, ou -1. */
function commonGroup(snap: FormsSnapshot, fields: FieldInfo[], acceptRadiogroup: boolean): number {
  const first = fields[0]
  if (!first) return -1
  for (const g of first.groups) {
    const group = snap.groups[g]
    if (!group) continue
    if (group.kind === 'radiogroup' && !acceptRadiogroup) continue
    if (fields.every((f) => f.groups.includes(g))) return g
  }
  return -1
}

/** Un regroupement au sens du RGAA : fieldset, ou role=group qui réunit des champs. */
function isRealGrouping(group: GroupInfo): boolean {
  if (group.fields.length === 0) return false
  if (group.kind === 'fieldset') return true
  return group.fields.length >= 2 || group.name !== '' || group.labelledby !== null
}

const grouping = defineCheck(['11.5.1', '11.6.1', '11.7.1'], async (ctx, t) => {
  const snap = await snapshotOf(ctx)
  const ask = asker(ctx)
  const fieldAt = (i: number) => snap.fields[i]

  // 11.5.1 — ensembles de champs de même nature.
  const sets = new Map<string, FieldInfo[]>()
  for (const f of snap.fields) {
    if (f.kind === 'radio' && f.name)
      sets.set(`radio|${f.formIndex}|${f.name}`, [
        ...(sets.get(`radio|${f.formIndex}|${f.name}`) ?? []),
        f,
      ])
    if (f.kind === 'checkbox' && f.name)
      sets.set(`checkbox|${f.formIndex}|${f.name}`, [
        ...(sets.get(`checkbox|${f.formIndex}|${f.name}`) ?? []),
        f,
      ])
  }
  for (const [key, list] of sets) {
    if (list.length < 2) continue
    const [kind] = key.split('|')
    t('11.5.1').applicable()
    if (commonGroup(snap, list, kind === 'radio') < 0) {
      t('11.5.1').fail(
        `Les ${list.length} ${kind === 'radio' ? 'boutons radio' : 'cases à cocher'} « ${list[0]?.name} » ne sont pas regroupés dans un <fieldset> ou un élément role="group"${kind === 'radio' ? ' / "radiogroup"' : ''}.`,
        list[0]?.ref,
      )
    }
  }
  const forms = new Set(snap.fields.map((f) => f.formIndex))
  for (const formIndex of forms) {
    for (const [family, tokens] of Object.entries(FAMILIES)) {
      const members = snap.fields.filter((f) => {
        if (f.formIndex !== formIndex) return false
        const parsed = f.autocomplete ? parseAutocomplete(f.autocomplete) : null
        return parsed?.valid === true && parsed.field !== null && tokens.includes(parsed.field)
      })
      if (members.length < 2) continue
      t('11.5.1').applicable()
      if (commonGroup(snap, members, false) >= 0) continue
      const labels = members.map(labelOf).sort()
      await ask(
        t('11.5.1'),
        {
          topic: 'form.group-needed',
          question: `Les champs « ${labels.join(' », « ')} » sont de même nature (${family}) et ne sont pas regroupés (fieldset ou role="group") : le regroupement est-il inutile ici ?`,
          evidence: { famille: family, champs: labels.join(' | ') },
        },
        members[0]?.ref,
      )
    }
  }

  // 11.6.1 et 11.7.1 — légende de chaque regroupement.
  let singles = 0
  for (const group of snap.groups) {
    if (!isRealGrouping(group)) {
      if (group.kind !== 'fieldset' && group.fields.length === 1) singles += 1
      continue
    }
    t('11.6.1').applicable()
    if (group.kind === 'fieldset') {
      if (group.legend === null) {
        t('11.6.1').fail('Le <fieldset> n’a pas de <legend>.', group.ref)
        continue
      }
      if (group.legend === '') {
        t('11.6.1').fail('Le <legend> du <fieldset> est vide.', group.ref)
        continue
      }
    } else if (group.name === '') {
      t('11.6.1').fail(
        group.labelledby
          ? `Le regroupement role="${group.kind}" a un aria-labelledby qui ne référence aucun texte existant.`
          : `Le regroupement role="${group.kind}" de ${group.fields.length} champs n’a ni aria-label ni aria-labelledby.`,
        group.ref,
      )
      continue
    }
    const labels = group.fields
      .map((i) => fieldAt(i))
      .filter((f): f is FieldInfo => f !== undefined)
      .map(labelOf)
      .filter(Boolean)
      .slice(0, 8)
    await ask(
      t('11.7.1'),
      {
        topic: 'form.group-legend',
        question: `La légende « ${group.name} » est-elle pertinente pour ce regroupement de champs ?`,
        evidence: { légende: group.name, champs: labels.join(' | ') },
      },
      group.ref,
    )
  }
  if (singles > 0) {
    t('11.6.1').note(
      `${singles} élément(s) role="group" sans nom ne contiennent qu’un seul champ : conteneur d’un champ et non regroupement de champs de même nature, ignorés.`,
    )
  }
  if (snap.fields.length > 0) {
    t('11.5.1').note(
      'Seuls sont repérés : boutons radio et cases à cocher de même name, champs de même famille d’autocomplete (identité, adresse, date, téléphone, carte). Les autres séries de champs ne sont pas détectées.',
    )
  }
})

// ─── 11.8 : listes de choix ─────────────────────────────────────────────────

/** Seuil de longueur au-delà duquel une liste sans <optgroup> est soumise à un jugement. */
const LONG_LIST = 6

interface OpenedList {
  ref: ElementRef
  label: string
  options: string[]
  hasGroups: boolean
}

/** Ouvre les listes de choix personnalisées (role=combobox non natif) sur une page jetable. */
async function openCustomLists(ctx: PageContext, snap: FormsSnapshot): Promise<OpenedList[]> {
  const triggers = snap.fields.filter(
    (f) =>
      f.tag !== 'select' &&
      f.tag !== 'input' &&
      f.tag !== 'textarea' &&
      (f.role === 'combobox' || f.role === 'listbox'),
  )
  if (triggers.length === 0) return []
  const page: Page = await ctx.fresh()
  const lists: OpenedList[] = []
  for (const trigger of triggers.slice(0, 6)) {
    try {
      const locator = page.locator(trigger.ref.selector).first()
      await locator.click({ timeout: 3_000 })
      await page.waitForSelector('[role=listbox]', { state: 'visible', timeout: 2_000 })
      const found = await page.evaluate(() => {
        const box = Array.from(document.querySelectorAll('[role=listbox]')).find((el) =>
          window.__rgaa.isVisible(el),
        )
        if (!box) return null
        return {
          options: Array.from(box.querySelectorAll('[role=option]')).map((o) =>
            window.__rgaa.norm(o.textContent),
          ),
          hasGroups: box.querySelector('[role=group], [role=presentation] [role=group]') !== null,
        }
      })
      if (found) {
        lists.push({ ref: trigger.ref, label: labelOf(trigger), ...found })
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
    } catch {
      // Liste qui ne s'ouvre pas : ignorée (angle mort signalé plus bas).
    }
  }
  return lists
}

const selects = defineCheck(['11.8.1', '11.8.2', '11.8.3'], async (ctx, t) => {
  const snap = await snapshotOf(ctx)
  const ask = asker(ctx)

  for (const f of snap.fields) {
    const s = f.select
    if (!s) continue
    const name = labelOf(f)
    t('11.8.1').applicable()
    if (s.optgroups.length === 0) {
      if (s.options.length >= LONG_LIST) {
        const options = s.options.map((o) => o.text).filter(Boolean)
        await ask(
          t('11.8.1'),
          {
            topic: 'form.select-grouping',
            question: `La liste de choix « ${name} » propose ${options.length} options sans <optgroup> : contient-elle des groupes d’items de même nature qui devraient être regroupés ?`,
            evidence: { liste: options.slice(0, 40).join(' | ') },
          },
          f.ref,
        )
      }
    } else if (s.ungrouped.length > 0) {
      await ask(
        t('11.8.1'),
        {
          topic: 'form.select-grouping',
          question: `La liste « ${name} » mêle des options groupées et des options hors de tout <optgroup> : est-ce légitime ?`,
          evidence: {
            liste: s.ungrouped.slice(0, 20).join(' | '),
            groupes: s.optgroups.map((g) => g.label ?? '').join(' | '),
          },
        },
        f.ref,
      )
    }
    for (const group of s.optgroups) {
      t('11.8.2').applicable()
      if (group.label === null || group.label.trim() === '') {
        t('11.8.2').fail(
          group.label === null
            ? 'Le <optgroup> n’a pas d’attribut label.'
            : 'L’attribut label du <optgroup> est vide.',
          group.ref,
        )
        continue
      }
      await ask(
        t('11.8.3'),
        {
          topic: 'form.optgroup-label',
          question: `Le libellé « ${group.label} » du <optgroup> est-il pertinent pour les options qu’il regroupe ?`,
          evidence: { libellé: group.label, options: group.options.slice(0, 3).join(' | ') },
        },
        group.ref,
      )
    }
  }

  // Listes personnalisées (role=listbox) : ouvertes sur une page jetable.
  const open = snap.fields.some(
    (f) =>
      f.tag !== 'select' &&
      f.tag !== 'input' &&
      f.tag !== 'textarea' &&
      (f.role === 'combobox' || f.role === 'listbox'),
  )
  if (open) {
    const lists = await ctx.memo('formulaires.listes', () => openCustomLists(ctx, snap))
    for (const list of lists) {
      t('11.8.1').applicable()
      if (list.hasGroups) {
        t('11.8.1').fail(
          `La liste « ${list.label} » regroupe ses options avec role="group" : WAI-ARIA ne permet pas de regrouper les options d’un role="listbox", il faut un <select> avec <optgroup>.`,
          list.ref,
        )
      } else if (list.options.length >= LONG_LIST) {
        await ask(
          t('11.8.1'),
          {
            topic: 'form.select-grouping',
            question: `La liste « ${list.label} » propose ${list.options.length} options sans regroupement : contient-elle des groupes d’items de même nature ?`,
            evidence: { liste: list.options.slice(0, 40).join(' | ') },
          },
          list.ref,
        )
      }
    }
    if (
      lists.length < snap.fields.filter((f) => f.role === 'combobox' || f.role === 'listbox').length
    ) {
      t('11.8.1').note(
        'Certaines listes personnalisées ne se sont pas ouvertes au clic : options non relevées.',
      )
    }
  }
})

// ─── 11.9 : boutons ─────────────────────────────────────────────────────────

const buttonsCheck = defineCheck(['11.9.1', '11.9.2'], async (ctx, t) => {
  const snap = await snapshotOf(ctx)
  const ask = asker(ctx)
  let iconOnly = 0

  for (const b of snap.buttons) {
    if (!b.inForm) continue
    const name = b.accName
    t('11.9.1').applicable()
    if (name === '') {
      t('11.9.1').fail(
        `Le bouton ${buttonKind(b)} n’a pas d’intitulé (nom accessible vide).`,
        b.ref,
      )
    } else if (GENERIC_BUTTON.test(squash(name))) {
      t('11.9.1').fail(
        `Le bouton ${buttonKind(b)} a un intitulé sans signification : « ${name} ».`,
        b.ref,
      )
    } else {
      await ask(
        t('11.9.1'),
        {
          topic: 'form.button',
          question: `L’intitulé « ${name} » du bouton (${b.kind}) décrit-il l’action qu’il déclenche ?`,
          evidence: { intitulé: name, bouton: b.kind },
        },
        b.ref,
      )
    }

    // 11.9.2 — le nom accessible reprend l'intitulé visible.
    if (b.visibleText.replace(/\s/g, '') === '') {
      if (b.iconOnly) iconOnly += 1
      continue
    }
    const o = t('11.9.2')
    o.applicable()
    if (isSymbolOnly(b.visibleText)) {
      await ask(
        o,
        {
          topic: 'form.button.symbol',
          question: `Le texte visible « ${b.visibleText} » du bouton sert de symbole : son nom accessible « ${name} » exprime-t-il sa fonction ?`,
          evidence: { symbole: b.visibleText, nom: name },
        },
        b.ref,
      )
      continue
    }
    const techniques: { kind: string; text: string }[] = []
    const labelledText = (b.labelledby ?? [])
      .filter((p) => p.exists)
      .map((p) => p.text)
      .join(' ')
    if (labelledText) techniques.push({ kind: 'aria-labelledby', text: labelledText })
    if (b.ariaLabel) techniques.push({ kind: 'aria-label', text: b.ariaLabel })
    if (b.alt) techniques.push({ kind: 'alt', text: b.alt })
    if (b.title) techniques.push({ kind: 'title', text: b.title })
    if (b.content) techniques.push({ kind: 'contenu', text: b.content })
    if (b.value) techniques.push({ kind: 'value', text: b.value })
    for (const technique of techniques) {
      if (!nameContains(technique.text, b.visibleText)) {
        o.fail(
          `Le bouton ${buttonKind(b)} affiche « ${b.visibleText} » mais son ${technique.kind} est « ${technique.text} » : le nom accessible doit contenir l’intitulé visible.`,
          b.ref,
        )
      }
    }
  }
  if (iconOnly > 0) {
    t('11.9.2').note(
      `${iconOnly} bouton(s) de formulaire n’affichent qu’une image : un texte inclus dans l’image n’est pas contrôlé.`,
    )
  }
})

function buttonKind(b: ButtonInfo): string {
  return b.kind === 'role'
    ? 'role="button"'
    : b.kind === 'button'
      ? '<button>'
      : `<input type="${b.kind === 'input-button' ? 'button' : b.kind}">`
}

// ─── 11.10 : champs obligatoires, avant validation ──────────────────────────

/** Indication de format placée seulement dans un placeholder : chiffres, @, exemple, jj/mm… */
const FORMAT_LIKE = /[@\d]|\bjj\b|\bmm\b|aaaa|exemple|\bex\b/i

const isDeclaredRequired = (f: FieldInfo): boolean => f.required || f.ariaRequired

/** Champs d'un même formulaire (ou de la page, hors formulaire). */
function byContainer(snap: FormsSnapshot): Map<number, FieldInfo[]> {
  const map = new Map<number, FieldInfo[]>()
  for (const f of snap.fields) {
    if (f.disabled) continue
    map.set(f.formIndex, [...(map.get(f.formIndex) ?? []), f])
  }
  return map
}

function containerInfo(
  snap: FormsSnapshot,
  index: number,
): { asteriskExplained: boolean; notice: string | null; ref?: ElementRef } {
  const form = snap.forms[index]
  if (form)
    return {
      asteriskExplained: form.asteriskExplained,
      notice: form.allRequiredNotice,
      ref: form.ref,
    }
  return { asteriskExplained: snap.page.asteriskExplained, notice: snap.page.allRequiredNotice }
}

const requiredFields = defineCheck(['11.10.1', '11.10.2', '11.10.5'], async (ctx, t) => {
  const snap = await snapshotOf(ctx)
  const ask = asker(ctx)

  // Comportement réel : champs qui réclament une saisie à l'envoi du formulaire vide.
  const behavior = new Set<string>()
  if (snap.fields.length > 0) {
    for (const probe of await probesOf(ctx)) {
      if (!probe.baseline || !probe.empty || probe.empty.navigated) continue
      for (const f of probe.baseline.fields) {
        if (!f.valueEmpty || f.formIndex !== probe.form.index) continue
        const after = probe.empty.snapshot.fields.find((a) => a.ref.selector === f.ref.selector)
        if (after && showsError(probe.baseline, probe.empty.snapshot, probe.form, after)) {
          behavior.add(f.ref.selector)
        }
      }
    }
  }

  for (const [container, fields] of byContainer(snap)) {
    // Cas particulier : un formulaire d'un seul champ, ou qui signale visiblement ses champs facultatifs.
    if (fields.length < 2) continue
    const optionalMarked = fields.filter((f) => !isDeclaredRequired(f))
    if (optionalMarked.length > 0 && optionalMarked.every((f) => f.optionalIndication)) {
      t('11.10.1').note(
        'Champs facultatifs signalés visiblement : 11.10.1 et 11.10.2 non applicables (cas particulier).',
      )
      continue
    }
    const info = containerInfo(snap, container)
    for (const f of fields) {
      const declared = isDeclaredRequired(f)
      const indicated = f.requiredIndication !== null
      const detected = behavior.has(f.ref.selector)
      const starOnly = f.requiredIndication === '*'
      const unexplainedStar = starOnly && !info.asteriskExplained

      // 11.10.1 — le champ obligatoire est identifiable avant la validation.
      if (declared || indicated || detected) {
        t('11.10.1').applicable()
        if (!declared) {
          if (!indicated) {
            t('11.10.1').fail(
              `${describe(f)} est obligatoire (l’envoi à vide réclame une saisie) mais n’a ni required / aria-required, ni indication visible.`,
              f.ref,
            )
          } else if (unexplainedStar) {
            t('11.10.1').fail(
              `${describe(f)} est signalé par un astérisque dont la signification n’est expliquée nulle part, et n’a ni required ni aria-required.`,
              f.ref,
            )
          }
        }
      }

      // 11.10.2 — le champ qui porte required / aria-required l'indique aussi visiblement.
      if (declared) {
        t('11.10.2').applicable()
        if (!indicated) {
          if (info.notice) {
            await ask(
              t('11.10.2'),
              {
                topic: 'form.required-notice',
                question: `Le formulaire annonce « ${info.notice} » sans marque dans chaque étiquette : cette mention suffit-elle comme indication visible du caractère obligatoire ?`,
                evidence: { mention: info.notice },
              },
              f.ref,
            )
          } else {
            t('11.10.2').fail(
              `${describe(f)} est obligatoire (required / aria-required) mais aucune indication visible n’est dans son étiquette ou son passage de texte lié.`,
              f.ref,
            )
          }
        } else if (unexplainedStar) {
          t('11.10.2').fail(
            `${describe(f)} : l’astérisque qui signale le champ obligatoire n’est pas expliqué (aucune mention « champs obligatoires » avant le formulaire).`,
            f.ref,
          )
        }
      }
    }
  }
  if (snap.fields.some((f) => f.formIndex >= 0 && snap.forms[f.formIndex]?.tag !== 'form')) {
    t('11.10.1').note(
      'Champs hors balise <form> : l’envoi à vide n’a pas pu être simulé pour détecter les champs obligatoires non déclarés.',
    )
  }

  // 11.10.5 — instructions de type / format : visibles avant validation, dans l'étiquette ou son passage de texte.
  for (const f of snap.fields) {
    if (!f.fieldVisible && f.visibleLabel === '') continue
    const passages = [
      ...f.visibleLabels.map((text) => ({ text, visible: true })),
      ...f.describedby
        .filter((p) => p.exists && p.text)
        .map((p) => ({ text: p.text, visible: p.visible })),
    ]
    const formatPassages = passages.filter((p) => FORMAT_HINT.test(p.text))
    const visibleFormat = formatPassages.some((p) => p.visible)
    const placeholderFormat = f.placeholder !== '' && FORMAT_LIKE.test(f.placeholder)
    const titleFormat = f.title !== '' && FORMAT_HINT.test(f.title)
    if (visibleFormat) {
      t('11.10.5').applicable()
    } else if (formatPassages.length > 0) {
      t('11.10.5').applicable()
      t('11.10.5').fail(
        `${describe(f)} : l’indication de format « ${formatPassages[0]?.text} » n’est pas visible à l’écran.`,
        f.ref,
      )
    } else if (placeholderFormat || titleFormat) {
      t('11.10.5').applicable()
      t('11.10.5').fail(
        `${describe(f)} : l’indication de format n’est donnée que par ${placeholderFormat ? `le placeholder « ${f.placeholder} »` : `le title « ${f.title} »`}, qui n’est ni visible en permanence ni dans l’étiquette ou son passage de texte lié.`,
        f.ref,
      )
    } else if (f.pattern) {
      t('11.10.5').applicable()
      t('11.10.5').fail(
        `${describe(f)} impose un format (pattern="${f.pattern}") sans indication visible dans l’étiquette ou son passage de texte lié.`,
        f.ref,
      )
    } else if (['email', 'tel', 'url'].includes(f.kind)) {
      t('11.10.5').note(
        `Champ de type ${f.kind} sans indication de format visible : le RGAA ne l’exige que lorsqu’une instruction existe, mais elle est recommandée.`,
      )
    }
  }
})

// ─── 11.10 et 11.11 : contrôle de saisie, sondes d'erreur ───────────────────

interface FieldMessages {
  /** Textes d'erreur apparus dans l'étiquette ou un passage lié au champ. */
  associated: string[]
  /** Textes apparus à côté du champ sans lien programmatique avec lui. */
  orphans: string[]
}

function passageTexts(f: FieldInfo | undefined): string[] {
  if (!f) return []
  return [...(f.labelledby ?? []), ...f.describedby, ...f.errormessage]
    .filter((p) => p.exists && p.visible && p.text)
    .map((p) => p.text)
    .concat(f.visibleLabels)
}

/** Messages apparus pour ce champ entre deux relevés. */
function messagesFor(before: FormsSnapshot, after: FormsSnapshot, field: FieldInfo): FieldMessages {
  const index = after.fields.findIndex((f) => f.ref.selector === field.ref.selector)
  const b = before.fields.find((f) => f.ref.selector === field.ref.selector)
  const a = after.fields[index]
  const beforeTexts = new Set(before.texts.map((x) => x.text))
  const beforePassages = new Set(passageTexts(b))
  const associated = new Set<string>()
  for (const text of passageTexts(a)) if (!beforePassages.has(text)) associated.add(text)
  for (const block of after.texts) {
    if (!beforeTexts.has(block.text) && block.assoc.includes(index)) associated.add(block.text)
  }
  const orphans = after.texts
    .filter(
      (block) =>
        !beforeTexts.has(block.text) &&
        block.assoc.length === 0 &&
        block.nearestField === index &&
        block.nearestDistance <= 96,
    )
    .map((block) => block.text)
  return { associated: Array.from(associated), orphans }
}

/** Le champ signale-t-il une erreur après l'envoi (aria-invalid, message, blocage natif) ? */
function showsError(
  before: FormsSnapshot,
  after: FormsSnapshot,
  form: FormInfo,
  field: FieldInfo,
): boolean {
  if (field.ariaInvalid === 'true') return true
  if (!form.noValidate && form.tag === 'form' && field.invalidPseudo) return true
  const m = messagesFor(before, after, field)
  return m.associated.length > 0 || m.orphans.length > 0
}

const namesField = (message: string, f: FieldInfo): boolean => {
  const label = squash(cleanLabel(f.nameText || f.visibleLabel))
  return label.length >= 3 && squash(message).includes(label)
}

const errorChecks = defineCheck(
  ['11.10.3', '11.10.4', '11.10.6', '11.10.7', '11.11.1', '11.11.2'],
  async (ctx, t) => {
    const snap = await snapshotOf(ctx)
    if (snap.fields.length === 0) return
    const ask = asker(ctx)

    for (const probe of await probesOf(ctx)) {
      if (probe.skipped) {
        const reason = `Formulaire non sondé (${probe.skipped}) : ses états d’erreur ne sont pas audités.`
        for (const test of [
          '11.10.3',
          '11.10.4',
          '11.10.6',
          '11.10.7',
          '11.11.1',
          '11.11.2',
        ] as const) {
          t(test).note(reason)
        }
      }
      const { baseline, empty, invalid, form } = probe
      if (!baseline || !empty) continue
      const formFields = baseline.fields.filter((f) => f.formIndex === form.index)
      const native = form.tag === 'form' && !form.noValidate

      // ── Envoi du formulaire vide ──
      const mandatory = formFields.filter((f) => {
        if (!f.valueEmpty || f.disabled) return false
        if (isDeclaredRequired(f)) return true
        const after = empty.snapshot.fields.find((a) => a.ref.selector === f.ref.selector)
        return after ? !empty.navigated && showsError(baseline, empty.snapshot, form, after) : false
      })
      if (mandatory.length > 0) {
        if (empty.navigated || empty.requests > 0) {
          t('11.10.3').applicable()
          t('11.10.3').fail(
            `Le formulaire vide est accepté (${empty.navigated ? 'la page change' : 'une requête d’envoi est émise'}) alors que ${mandatory.length} champ(s) sont obligatoires : aucune erreur de saisie n’est signalée.`,
            form.ref,
          )
        } else {
          for (const f of mandatory) {
            const after = empty.snapshot.fields.find((a) => a.ref.selector === f.ref.selector)
            if (!after) continue
            t('11.10.3').applicable()
            const messages = messagesFor(baseline, empty.snapshot, after)
            const all = [...messages.associated, ...messages.orphans]
            if (after.ariaInvalid === 'true' || (native && after.invalidPseudo)) {
              // 11.10.3 satisfait par aria-invalid (ou par la validation native du navigateur).
            } else if (all.length === 0) {
              t('11.10.3').fail(
                `${describe(f)} est obligatoire : après l’envoi du formulaire vide, aucun message d’erreur ni aria-invalid ne le signale.`,
                f.ref,
              )
            } else if (!all.some((m) => namesField(m, f))) {
              t('11.10.3').fail(
                `${describe(f)} : le message d’erreur « ${all[0]} » ne nomme pas le champ et le champ n’a pas aria-invalid="true".`,
                f.ref,
              )
            }

            // 11.10.4 — champ obligatoire en aria-invalid : message visible dans l'étiquette ou un passage lié.
            if (after.ariaInvalid === 'true') {
              t('11.10.4').applicable()
              if (messages.associated.length === 0) {
                t('11.10.4').fail(
                  `${describe(f)} est en aria-invalid="true" mais aucun message d’erreur visible n’est dans son étiquette ni dans un passage lié (aria-describedby / aria-errormessage)${messages.orphans.length > 0 ? ` ; le message « ${messages.orphans[0]} » est à côté sans lien avec le champ` : ''}.`,
                  f.ref,
                )
              }
            }
          }
          // Gestion du focus et annonce : remarques sans effet sur le verdict.
          const focused = empty.snapshot.active
          if (!native && (!focused || focused.fieldIndex < 0)) {
            t('11.10.3').note(
              'Après l’envoi du formulaire vide, le focus n’est pas déplacé vers un champ en erreur.',
            )
          }
        }
      }

      // ── Envoi avec des valeurs de format invalide ──
      if (!invalid) continue
      for (const index of invalid.filled) {
        const f = baseline.fields[index]
        if (!f) continue
        const after = invalid.snapshot.fields.find((a) => a.ref.selector === f.ref.selector)
        if (!after) continue
        const messages = messagesFor(baseline, invalid.snapshot, after)
        const own = [...messages.associated, ...messages.orphans]
        // Messages présents en permanence (aide) ou apparus à l'envoi.
        const current = [...passageTexts(after), ...own]
        const flagged = after.ariaInvalid === 'true' || (native && after.invalidPseudo)

        if (!flagged && own.length === 0) {
          if (invalid.requests > 0 || invalid.navigated) {
            t('11.10.6').note(
              `${describe(f)} : une valeur invalide est acceptée côté navigateur (requête émise, bloquée par l’outil) ; la validation côté serveur n’est pas auditée.`,
            )
          } else {
            t('11.10.6').applicable()
            t('11.10.6').fail(
              `${describe(f)} : après saisie d’une valeur au format invalide, aucun message ni aria-invalid ne signale l’erreur.`,
              f.ref,
            )
          }
          continue
        }

        // 11.10.6 — erreur de format : message qui nomme le champ, ou aria-invalid.
        t('11.10.6').applicable()
        if (!flagged && !own.some((m) => namesField(m, f))) {
          t('11.10.6').fail(
            `${describe(f)} : le message d’erreur de format « ${own[0]} » ne nomme pas le champ et le champ n’a pas aria-invalid="true".`,
            f.ref,
          )
        }

        // 11.10.7 — champ en aria-invalid : instruction de format visible dans l'étiquette ou un passage lié.
        if (after.ariaInvalid === 'true') {
          t('11.10.7').applicable()
          const pool = passageTexts(after)
          if (!pool.some((text) => FORMAT_HINT.test(text))) {
            await ask(
              t('11.10.7'),
              {
                topic: 'form.error.instruction',
                question: `Le champ « ${labelOf(f)} » (${f.kind}) est en erreur de format. Les textes visibles de son étiquette et des passages liés indiquent-ils le type ou le format attendu ?`,
                evidence: {
                  étiquette: labelOf(f),
                  champ: f.kind,
                  textes: Array.from(new Set(pool)).sort().join(' | '),
                },
              },
              f.ref,
            )
          }
        }

        // 11.11 — suggestions de type, de format et d'exemples.
        const nativeMessage = native && after.invalidPseudo && own.length === 0
        t('11.11.1').applicable()
        t('11.11.2').applicable()
        if (nativeMessage) {
          t('11.11.1').note(
            'Message natif du navigateur (validation HTML5) : il indique le type attendu.',
          )
          t('11.11.2').note(
            'Message natif du navigateur (validation HTML5) : accepté comme suggestion par la note technique du RGAA.',
          )
          continue
        }
        if (own.length === 0) {
          t('11.11.1').fail(
            `${describe(f)} est en aria-invalid="true" sans aucun message : aucun type ni format n’est suggéré.`,
            f.ref,
          )
          t('11.11.2').fail(
            `${describe(f)} est en aria-invalid="true" sans aucun message : aucun exemple de valeur n’est suggéré.`,
            f.ref,
          )
          continue
        }
        const message = own.join(' ')
        if (!current.some((text) => FORMAT_HINT.test(text))) {
          await ask(
            t('11.11.1'),
            {
              topic: 'form.error.suggest-format',
              question: `Le message d’erreur « ${message} » (champ « ${labelOf(f)} », ${f.kind}) suggère-t-il le type ou le format de données attendu ?`,
              evidence: { champ: f.kind, étiquette: labelOf(f), message },
            },
            f.ref,
          )
        }
        if (!current.some((text) => EXAMPLE_HINT.test(text))) {
          await ask(
            t('11.11.2'),
            {
              topic: 'form.error.suggest-example',
              question: `Le message d’erreur « ${message} » (champ « ${labelOf(f)} », ${f.kind}) ou le texte d’aide du champ donne-t-il un exemple de valeur attendue ?`,
              evidence: { champ: f.kind, étiquette: labelOf(f), message },
            },
            f.ref,
          )
        }
      }
    }
  },
)

// ─── 11.12 : formulaires à conséquences ─────────────────────────────────────

const consequences = defineCheck(['11.12.1', '11.12.2'], async (ctx, t) => {
  const snap = await snapshotOf(ctx)
  const ask = asker(ctx)

  for (const form of snap.forms) {
    const fields = snap.fields.filter((f) => f.formIndex === form.index)
    if (fields.length === 0) continue
    const labels = fields.map(labelOf).filter(Boolean).sort()
    const submits = snap.buttons
      .filter(
        (b) =>
          b.formIndex === form.index &&
          (b.kind === 'submit' || b.kind === 'button' || b.kind === 'input-button'),
      )
      .map((b) => b.accName)
      .filter(Boolean)
    const evidence = { champs: labels.join(' | '), envoi: submits.join(' | ') }
    const question = `Ce formulaire (champs : ${labels.join(', ')} ; envoi : ${submits.join(', ') || 'aucun bouton'}) modifie-t-il ou supprime-t-il des données, transmet-il un examen, ou a-t-il des conséquences financières ou juridiques ? Si oui, peut-on modifier/annuler après envoi, vérifier avant, ou confirmer explicitement, et récupérer les données ? (pass : mécanisme présent ou formulaire non concerné)`
    for (const test of ['11.12.1', '11.12.2'] as const) {
      await ask(t(test), { topic: 'form.consequences', question, evidence }, form.ref)
    }
  }
})

// ─── 11.13 : finalité des champs (autocomplete) ─────────────────────────────

/** Types de champ qui ne portent pas une donnée de l'utilisateur à pré-remplir. */
const NO_AUTOFILL_KINDS = new Set([
  'checkbox',
  'radio',
  'file',
  'range',
  'color',
  'search',
  'meter',
  'progress',
  'output',
  'progressbar',
  'slider',
  'switch',
  'listbox',
])

const autocomplete = defineCheck(['11.13.1'], async (ctx, t) => {
  const snap = await snapshotOf(ctx)
  const ask = asker(ctx)
  const o = t('11.13.1')

  for (const f of snap.fields) {
    if (f.checkable || NO_AUTOFILL_KINDS.has(f.kind)) continue
    const purpose = inferPurpose(f)
    if (purpose === 'neutre') continue
    const name = labelOf(f) || f.accName
    const ac = f.autocomplete

    if (ac === null) {
      if (purpose && !purpose.weak) {
        o.applicable()
        o.fail(`${describe(f)} (${purpose.why}) n’a pas d’attribut autocomplete.`, f.ref)
      } else if (name) {
        await ask(
          o,
          {
            topic: 'form.autocomplete',
            question: `Le champ « ${name} » (${f.kind}) n’a pas d’attribut autocomplete : concerne-t-il une information relative à l’utilisateur (alors NC) ?`,
            evidence: { étiquette: name, champ: f.kind, autocomplete: '(absent)' },
          },
          f.ref,
        )
      }
      continue
    }

    const parsed = parseAutocomplete(ac)
    if (!parsed.valid) {
      if (purpose && !purpose.weak) {
        o.applicable()
        o.fail(
          `${describe(f)} (${purpose.why}) : autocomplete="${ac}" est invalide, ${parsed.reason}.`,
          f.ref,
        )
      } else if (name) {
        await ask(
          o,
          {
            topic: 'form.autocomplete',
            question: `Le champ « ${name} » (${f.kind}) porte autocomplete="${ac}", valeur absente de la liste du RGAA : concerne-t-il une information relative à l’utilisateur (alors NC) ?`,
            evidence: { étiquette: name, champ: f.kind, autocomplete: ac },
          },
          f.ref,
        )
      }
      continue
    }

    o.applicable()
    if (purpose && parsed.field && !purpose.tokens.includes(parsed.field)) {
      await ask(
        o,
        {
          topic: 'form.autocomplete-relevance',
          question: `autocomplete="${ac}" est-il pertinent pour le champ « ${name} » (${f.kind}) ? (la finalité attendue semble être : ${purpose.tokens.join(', ')})`,
          evidence: { étiquette: name, champ: f.kind, autocomplete: ac },
        },
        f.ref,
      )
    } else if (!purpose && name) {
      await ask(
        o,
        {
          topic: 'form.autocomplete-relevance',
          question: `autocomplete="${ac}" est-il pertinent pour le champ « ${name} » (${f.kind}) ?`,
          evidence: { étiquette: name, champ: f.kind, autocomplete: ac },
        },
        f.ref,
      )
    }
  }
  if (snap.fields.some((f) => f.checkable)) {
    o.note(
      'Cases à cocher et boutons radio non contrôlés (pas de finalité de remplissage automatique).',
    )
  }
})

export const checks: Check[] = [
  labelling,
  relevance,
  consistency,
  siteConsistency,
  placement,
  grouping,
  selects,
  buttonsCheck,
  requiredFields,
  errorChecks,
  consequences,
  autocomplete,
]
