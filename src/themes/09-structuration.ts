import { type Check, defineCheck, type ElementRef } from '../core/types.ts'

/**
 * Thématique 9 — Structuration de l'information.
 *
 * Mesuré : niveaux de titres, repères de page (`header`, `nav`, `main`, `footer`),
 * structure des listes de description, présence de titres, listes et citations
 * « faits main » (texte mis en forme comme un titre, tirets en début de ligne,
 * guillemets). Les détections de contenus mal balisés reposent sur des indices : un
 * indice n'est jamais déclaré fautif d'office, il est soumis au jugement.
 */

/** Plafond de questions posées par type de détection et par page. */
const MAX_QUESTIONS = 12

const GENERIC_HEADINGS = new Set([
  'titre',
  'title',
  'heading',
  'sans titre',
  'untitled',
  'lorem ipsum',
  'titre de la page',
  'titre de la section',
  'nouveau titre',
])

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// ─── 9.1 : titres ───────────────────────────────────────────────────────────

interface Heading {
  level: number
  tag: string
  text: string
  ref: ElementRef
}

const headings = defineCheck(['9.1.1', '9.1.2', '9.1.3'], async (ctx, t) => {
  const data = await ctx.page.evaluate(() => {
    const { ref, norm, isRendered, isVisible, isHiddenFromAT, accName, visibleText } = window.__rgaa

    const list: Heading[] = []
    for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')) {
      if (isHiddenFromAT(el)) continue
      const declared = Number.parseInt(el.getAttribute('aria-level') ?? '', 10)
      const native = /^h([1-6])$/.exec(el.localName)
      const level = Number.isFinite(declared) ? declared : native ? Number(native[1]) : 2
      list.push({
        level,
        tag:
          el.getAttribute('role') === 'heading'
            ? `role="heading" aria-level="${level}"`
            : el.localName,
        text: accName(el) || visibleText(el),
        ref: ref(el),
      })
    }

    // Texte mis en forme comme un titre sans en être un.
    const bodySize = Number.parseFloat(getComputedStyle(document.body).fontSize) || 16
    const BLOCK_CHILDREN =
      'p, div, ul, ol, dl, table, section, article, nav, header, footer, form, blockquote, pre, h1, h2, h3, h4, h5, h6, figure'
    const EXCLUDED =
      'h1, h2, h3, h4, h5, h6, [role="heading"], a, button, label, legend, summary, th, caption, figcaption, dt, nav, pre, code, select, textarea, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [aria-hidden="true"], script, style, svg'
    const fake: {
      text: string
      size: number
      bold: boolean
      ref: { selector: string; snippet: string }
    }[] = []
    const seen = new Set<Element>()
    for (const el of document.body.querySelectorAll('p, div, span, strong, b, font')) {
      if (el.closest(EXCLUDED) || !isRendered(el) || el.querySelector(BLOCK_CHILDREN)) continue
      const text = norm(el.textContent)
      if (text.length < 3 || text.length > 90 || /[.,;:!?…]$/.test(text)) continue
      // Un passage en ligne ne compte que s'il est seul dans son bloc (sinon c'est une mise en valeur).
      let block: Element = el
      if (getComputedStyle(el).display === 'inline') {
        const parent = el.parentElement
        if (!parent || norm(parent.textContent) !== text) continue
        block = parent
      }
      if (seen.has(block) || block.closest(EXCLUDED) || !isVisible(block)) continue
      seen.add(block)
      const style = getComputedStyle(block)
      const size = Number.parseFloat(style.fontSize) / bodySize
      const bold = Number.parseInt(style.fontWeight, 10) >= 600
      const followed = block.nextElementSibling !== null
      if (size >= 1.3 || (bold && size >= 1 && followed)) {
        fake.push({ text, size: Math.round(size * 100) / 100, bold, ref: ref(block) })
      }
    }
    fake.sort((a, b) => b.size - a.size)
    return { list, fake }
  })

  // 9.1.1 — hiérarchie : aucun saut de niveau, et le plan commence par un titre de niveau 1.
  if (data.list.length > 0) {
    t('9.1.1').applicable()
    let previous = 0
    for (const heading of data.list) {
      if (previous > 0 && heading.level > previous + 1) {
        t('9.1.1').fail(
          `Saut de niveau de titre : niveau ${heading.level} (« ${heading.text.slice(0, 60)} ») après un niveau ${previous}.`,
          heading.ref,
        )
      }
      previous = heading.level
    }
    const first = data.list[0]
    if (first && first.level !== 1) {
      await t('9.1.1').judgePass({
        topic: 'heading.outline',
        question:
          'Le plan de la page ne commence pas par un titre de niveau 1. La hiérarchie des titres reste-t-elle pertinente ?',
        evidence: {
          page: ctx.path,
          plan: data.list
            .slice(0, 25)
            .map((heading) => `h${heading.level} ${heading.text.slice(0, 40)}`)
            .join(' | '),
        },
        ref: first.ref,
      })
    }
  }

  // 9.1.2 — contenu des titres : un titre vide ou creux n'annonce rien.
  for (const heading of data.list) {
    t('9.1.2').applicable()
    const key = fold(heading.text)
    if (heading.text === '' || key === '') {
      t('9.1.2').fail(`Titre vide (${heading.tag}) : il ne présente aucun contenu.`, heading.ref)
    } else if (GENERIC_HEADINGS.has(key)) {
      await t('9.1.2').judgePass({
        topic: 'heading.content',
        question: `Le titre « ${heading.text} » annonce-t-il pertinemment le contenu qui le suit ?`,
        evidence: { niveau: String(heading.level), titre: heading.text },
        ref: heading.ref,
      })
    }
  }
  if (data.list.length > 0) {
    t('9.1.2').note(
      'Seuls les titres vides ou génériques sont relevés : la pertinence éditoriale des autres n’est pas vérifiée.',
    )
  }

  // 9.1.3 — texte qui joue le rôle d'un titre sans balise de titre.
  for (const candidate of data.fake.slice(0, MAX_QUESTIONS)) {
    const answer = await t('9.1.3').judge({
      topic: 'heading.missing',
      question: `Le passage « ${candidate.text} » est mis en forme comme un titre (taille ×${candidate.size}${candidate.bold ? ', gras' : ''}) sans balise de titre. Est-ce un titre ?`,
      answers: ['pas-un-titre', 'titre-non-balise'],
      evidence: {
        texte: candidate.text,
        taille: String(candidate.size),
        gras: String(candidate.bold),
      },
      ref: candidate.ref,
    })
    if (answer === 'titre-non-balise') {
      t('9.1.3').fail(
        `« ${candidate.text} » est un titre qui n’est pas balisé comme tel.`,
        candidate.ref,
      )
    }
  }
  if (data.fake.length > MAX_QUESTIONS) {
    t('9.1.3').note(
      `${data.fake.length - MAX_QUESTIONS} autre(s) passage(s) mis en forme comme un titre n’ont pas été soumis au jugement (plafond de ${MAX_QUESTIONS} par page).`,
    )
  }
})

// ─── 9.2 : structure du document ────────────────────────────────────────────

/** Doctype HTML5 (`<!DOCTYPE html>`, avec ou sans l'identifiant de compatibilité). */
const HTML5_DOCTYPE =
  /<!DOCTYPE\s+html(\s+SYSTEM\s+("about:legacy-compat"|'about:legacy-compat'))?\s*>/i

const documentStructure = defineCheck(['9.2.1'], async (ctx, t) => {
  const declared = /<!DOCTYPE[^>]*>/i.exec(ctx.source)
  // Cas particulier : hors doctype HTML5, le critère est non applicable.
  if (declared && !HTML5_DOCTYPE.test(declared[0])) return

  const o = t('9.2.1')
  o.applicable()
  const problems = await ctx.page.evaluate(() => {
    const { ref, isHiddenFromAT } = window.__rgaa
    const found: { message: string; ref?: { selector: string; snippet: string } }[] = []
    const sectioning = 'article, aside, main, nav, section'
    const shown = (el: Element) => !isHiddenFromAT(el) && !el.hasAttribute('hidden')

    // Un <header> ou <footer> placé dans un <article>/<section>… n'est pas celui de la page.
    const headers = Array.from(document.querySelectorAll('header, [role="banner"]')).filter(
      (el) => shown(el) && !el.parentElement?.closest(sectioning),
    )
    if (headers.length === 0) {
      found.push({ message: 'Aucune zone d’en-tête de page structurée par une balise <header>.' })
    }
    const footers = Array.from(document.querySelectorAll('footer, [role="contentinfo"]')).filter(
      (el) => shown(el) && !el.parentElement?.closest(sectioning),
    )
    if (footers.length === 0) {
      found.push({ message: 'Aucune zone de pied de page structurée par une balise <footer>.' })
    }

    const navs = Array.from(document.querySelectorAll('nav, [role="navigation"]')).filter(shown)
    const linkCount = Array.from(document.querySelectorAll('a[href]')).filter(shown).length
    if (navs.length === 0 && linkCount >= 5) {
      found.push({
        message: `Aucune zone de navigation structurée par une balise <nav>, alors que la page compte ${linkCount} liens.`,
      })
    }
    for (const nav of navs) {
      if (!nav.querySelector('a[href], [role="link"]')) {
        found.push({
          message: '<nav> réservé aux zones de navigation : celui-ci ne contient aucun lien.',
          ref: ref(nav),
        })
      }
    }

    const mains = Array.from(document.querySelectorAll('main, [role="main"]')).filter(shown)
    if (mains.length === 0) {
      found.push({ message: 'Aucune zone de contenu principal structurée par une balise <main>.' })
    } else if (mains.length > 1) {
      for (const main of mains.slice(1)) {
        found.push({
          message: `Plusieurs balises <main> visibles (${mains.length}) : une seule est admise à la fois.`,
          ref: ref(main),
        })
      }
    }
    return found
  })
  for (const problem of problems) o.fail(problem.message, problem.ref)
})

// ─── 9.3 : listes ───────────────────────────────────────────────────────────

interface FakeList {
  kind: 'ordered' | 'unordered' | 'description'
  lines: string[]
  ref: ElementRef
}

const lists = defineCheck(['9.3.1', '9.3.2', '9.3.3'], async (ctx, t) => {
  const data = await ctx.page.evaluate(() => {
    const { ref, norm, isRendered, isHiddenFromAT } = window.__rgaa
    const BULLET =
      /^[\u2022\u25cf\u25e6\u25aa\u25ab\u2023\u2043\u2219\u00b7\u25ba\u25b6\u27a4\u27a2*\u2013\u2014-]\s+\S/
    const NUMBER = /^(\d{1,2}|[a-z])\s*[.)]\s+\S/i
    const TERM = /^[^:\n]{2,40}\s:\s+\S/
    const BLOCK =
      'p, div, ul, ol, dl, table, section, article, nav, header, footer, form, blockquote, pre, h1, h2, h3, h4, h5, h6, figure, li'
    const SKIP = 'ul, ol, dl, pre, code, textarea, script, style, [role="list"], [contenteditable]'

    /** Lignes d'un conteneur : ses enfants blocs, ou ses segments séparés par des <br>. */
    const linesOf = (container: Element): { text: string }[] => {
      const blocks = Array.from(container.children).filter((child) => {
        const display = getComputedStyle(child).display
        return display !== 'inline' && display !== 'none' && child.localName !== 'br'
      })
      if (blocks.length >= 2 && blocks.length === container.children.length) {
        return blocks
          .filter((child) => !child.querySelector(BLOCK))
          .map((child) => ({ text: norm(child.textContent) }))
      }
      if (container.querySelector(':scope > br')) {
        const lines: { text: string }[] = []
        let current = ''
        for (const node of container.childNodes) {
          if (node instanceof Element && node.localName === 'br') {
            lines.push({ text: norm(current) })
            current = ''
          } else if (
            node.nodeType === 3 ||
            (node instanceof Element && getComputedStyle(node).display === 'inline')
          ) {
            current += node.textContent ?? ''
          }
        }
        lines.push({ text: norm(current) })
        return lines
      }
      return []
    }

    /** Plus longue suite de lignes consécutives qui vérifient `test`. */
    const run = (lines: { text: string }[], test: RegExp): string[] => {
      let best: string[] = []
      let current: string[] = []
      for (const line of lines) {
        if (test.test(line.text)) current.push(line.text)
        else current = []
        if (current.length > best.length) best = [...current]
      }
      return best
    }

    const fakes: {
      kind: 'ordered' | 'unordered' | 'description'
      lines: string[]
      ref: { selector: string; snippet: string }
    }[] = []
    for (const container of document.body.querySelectorAll(
      'p, div, td, dd, blockquote, section, article, span',
    )) {
      if (container.closest(SKIP) || !isRendered(container)) continue
      const lines = linesOf(container)
      if (lines.length < 2) continue
      const unordered = run(lines, BULLET)
      const ordered = run(lines, NUMBER)
      const description = run(lines, TERM)
      if (unordered.length >= 2)
        fakes.push({ kind: 'unordered', lines: unordered, ref: ref(container) })
      else if (ordered.length >= 2)
        fakes.push({ kind: 'ordered', lines: ordered, ref: ref(container) })
      else if (description.length >= 3)
        fakes.push({ kind: 'description', lines: description, ref: ref(container) })
    }

    // Listes balisées mais dont la numérotation est écrite à la main.
    const numberedUnordered = Array.from(document.querySelectorAll('ul'))
      .filter((ul) => {
        const items = Array.from(ul.children).filter((child) => child.localName === 'li')
        return items.length >= 2 && items.every((item) => NUMBER.test(norm(item.textContent)))
      })
      .map((ul) => ref(ul))

    const shownLists = Array.from(document.querySelectorAll('ul, ol, menu, [role="list"]')).filter(
      (el) => !isHiddenFromAT(el),
    )
    const definitions = Array.from(document.querySelectorAll('dl'))
      .filter((el) => !isHiddenFromAT(el))
      .map((dl) => {
        const names: string[] = []
        for (const child of dl.children) {
          if (child.localName === 'div')
            names.push(...Array.from(child.children).map((c) => c.localName))
          else names.push(child.localName)
        }
        const foreign = names.filter((name) => !['dt', 'dd', 'script', 'template'].includes(name))
        const firstDd = names.indexOf('dd')
        const lastDt = names.lastIndexOf('dt')
        return {
          ref: ref(dl),
          foreign: foreign[0] ?? null,
          noTerm: !names.includes('dt'),
          noDescription: !names.includes('dd'),
          ddBeforeDt: firstDd !== -1 && names.indexOf('dt') > firstDd,
          dtAtEnd: lastDt !== -1 && lastDt === names.length - 1,
        }
      })

    return {
      fakes,
      numberedUnordered,
      hasUnordered: shownLists.some((el) => el.localName !== 'ol'),
      hasOrdered: shownLists.some((el) => el.localName === 'ol'),
      definitions,
    }
  })

  const fakes: FakeList[] = data.fakes
  const questions = new Map<FakeList['kind'], number>()
  const tests = { unordered: '9.3.1', ordered: '9.3.2', description: '9.3.3' } as const
  const noun = {
    unordered: 'liste à puces',
    ordered: 'liste numérotée',
    description: 'liste de description',
  }

  if (data.hasUnordered) t('9.3.1').applicable()
  if (data.hasOrdered) t('9.3.2').applicable()

  for (const fake of fakes) {
    const asked = questions.get(fake.kind) ?? 0
    if (asked >= MAX_QUESTIONS) continue
    questions.set(fake.kind, asked + 1)
    const test = tests[fake.kind]
    const answer = await t(test).judge({
      topic: `list.${fake.kind}`,
      question: `Ces ${fake.lines.length} lignes ressemblent à une ${noun[fake.kind]} qui n’est pas balisée comme telle. Forment-elles une liste ?`,
      answers: ['pas-une-liste', 'liste-non-balisee'],
      evidence: { lignes: fake.lines.slice(0, 5).join(' | ') },
      ref: fake.ref,
    })
    if (answer === 'liste-non-balisee') {
      t(test).fail(
        `${noun[fake.kind]} écrite à la main (« ${fake.lines[0]?.slice(0, 50)} »…).`,
        fake.ref,
      )
    }
  }
  for (const ref of data.numberedUnordered) {
    t('9.3.2').fail(
      'Liste numérotée à la main dans une liste non ordonnée <ul> : utiliser <ol>.',
      ref,
    )
  }

  // 9.3.3 — structure des listes de description.
  for (const dl of data.definitions) {
    t('9.3.3').applicable()
    if (dl.foreign) {
      t('9.3.3').fail(
        `La liste de description contient un élément <${dl.foreign}> : seuls <dt> et <dd> sont admis.`,
        dl.ref,
      )
    } else if (dl.noTerm || dl.noDescription) {
      t('9.3.3').fail(
        `Liste de description sans ${dl.noTerm ? 'terme <dt>' : 'description <dd>'} : les deux vont ensemble.`,
        dl.ref,
      )
    } else if (dl.ddBeforeDt) {
      t('9.3.3').fail('Une description <dd> précède le premier terme <dt>.', dl.ref)
    } else if (dl.dtAtEnd) {
      t('9.3.3').fail(
        'La liste de description se termine par un terme <dt> sans description.',
        dl.ref,
      )
    }
  }
  const handmade = fakes.filter((fake) => fake.kind === 'description').length
  if (data.definitions.length === 0 && handmade === 0) {
    t('9.3.3').note(
      'Aucune liste de description <dl> ni suite de lignes « terme : valeur » détectée.',
    )
  }
  t('9.3.1').note(
    'Les listes visuelles sans tiret ni numéro (cartes, vignettes en grille) ne sont pas détectables automatiquement.',
  )
})

// ─── 9.4 : citations ────────────────────────────────────────────────────────

const quotes = defineCheck(['9.4.1', '9.4.2'], async (ctx, t) => {
  const data = await ctx.page.evaluate(() => {
    const { ref, norm, isRendered } = window.__rgaa
    const SKIP =
      'q, blockquote, cite, code, pre, script, style, noscript, textarea, a, button, label, h1, h2, h3, h4, h5, h6, [aria-hidden="true"]'
    const PAIR = /«\s?([^»«]{12,400}?)\s?»|“([^”“]{12,400})”|"([^"]{12,400})"/g

    const short: { text: string; ref: { selector: string; snippet: string } }[] = []
    const block: { text: string; ref: { selector: string; snippet: string } }[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      const value = node.nodeValue ?? ''
      if (!parent || parent.closest(SKIP) || !isRendered(parent) || !/[«“"]/.test(value)) continue
      const whole = norm(parent.textContent)
      for (const match of value.matchAll(PAIR)) {
        const text = norm(match[1] ?? match[2] ?? match[3])
        if (text.split(' ').length < 3) continue
        // Un paragraphe presque entièrement entre guillemets est un bloc de citation.
        const isBlock =
          whole.length >= 120 &&
          (parent.localName === 'p' || parent.localName === 'div') &&
          norm(match[0]).length >= whole.length - 3
        ;(isBlock ? block : short).push({ text: text.slice(0, 200), ref: ref(parent) })
      }
    }
    return {
      short,
      block,
      hasQ: document.querySelector('q') !== null,
      hasBlockquote: document.querySelector('blockquote') !== null,
    }
  })

  if (data.hasQ) t('9.4.1').applicable()
  if (data.hasBlockquote) t('9.4.2').applicable()

  for (const [test, found, topic, noun] of [
    ['9.4.1', data.short, 'quote.short', 'une citation courte (balise <q>)'],
    ['9.4.2', data.block, 'quote.block', 'un bloc de citation (balise <blockquote>)'],
  ] as const) {
    for (const quote of found.slice(0, MAX_QUESTIONS)) {
      const answer = await t(test).judge({
        topic,
        question: `Ce passage entre guillemets est-il ${noun} ? Une expression mise entre guillemets sans citer personne n’en est pas une.`,
        answers: ['pas-une-citation', 'citation-non-balisee'],
        evidence: { texte: quote.text },
        ref: quote.ref,
      })
      if (answer === 'citation-non-balisee') {
        t(test).fail(`Citation non balisée : « ${quote.text.slice(0, 80)} ».`, quote.ref)
      }
    }
  }
})

export const checks: Check[] = [headings, documentStructure, lists, quotes]
