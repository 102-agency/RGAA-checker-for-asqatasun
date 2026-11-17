import { parse } from 'parse5'
import { type Check, defineCheck, defineSiteCheck } from '../core/types.ts'
import { guessLanguage, isValidLanguageCode, primarySubtag } from '../lib/language.ts'

/**
 * Thématique 8 — Éléments obligatoires.
 *
 * Sert aussi de modèle pour les autres thématiques : contrôle sur le code
 * source servi (`ctx.source`), contrôle dans la page (`page.evaluate` +
 * `window.__rgaa`), jugement enregistré (`judgePass`) et contrôle inter-pages
 * (`defineSiteCheck`).
 */

// ─── 8.1 : type de document ─────────────────────────────────────────────────

/** Doctypes admis par la spécification HTML (le doctype HTML5 et les doctypes hérités valides). */
const LEGACY_DOCTYPE =
  /^<!DOCTYPE\s+html\s+PUBLIC\s+"-\/\/W3C\/\/DTD (X?HTML [^"]+)"(\s+"http:\/\/www\.w3\.org\/TR\/[^"]+")?\s*>$/i
const HTML5_DOCTYPE =
  /^<!DOCTYPE\s+html(\s+SYSTEM\s+("about:legacy-compat"|'about:legacy-compat'))?\s*>$/i

const doctype = defineCheck(['8.1.1', '8.1.2', '8.1.3'], async (ctx, t) => {
  const source = ctx.source
  const declaration = /<!DOCTYPE[^>]*>/i.exec(source)

  t('8.1.1').applicable()
  if (!declaration) {
    t('8.1.1').fail(
      'Aucune déclaration de type de document (`<!DOCTYPE html>`) dans le code source.',
    )
    return // 8.1.2 et 8.1.3 ne s'appliquent qu'en présence d'un doctype.
  }

  t('8.1.2').applicable()
  if (!HTML5_DOCTYPE.test(declaration[0]) && !LEGACY_DOCTYPE.test(declaration[0])) {
    t('8.1.2').fail(`Type de document invalide : ${declaration[0]}`)
  }

  t('8.1.3').applicable()
  const htmlTag = /<html[\s>]/i.exec(source)
  if (htmlTag && declaration.index > htmlTag.index) {
    t('8.1.3').fail('La déclaration de type de document est placée après la balise `<html>`.')
  }
  // Avant le doctype, seuls des espaces, un BOM ou des commentaires sont admis.
  const before = source
    .slice(0, declaration.index)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\ufeff/, '')
  if (before.trim() !== '') {
    t('8.1.3').fail('Du contenu précède la déclaration de type de document.')
  }
})

// ─── 8.2 : validité du code source ──────────────────────────────────────────

/**
 * Erreurs d'analyse HTML qui relèvent des points du test 8.2.1 (écriture des
 * balises et attributs, imbrication, ouverture/fermeture, attributs doublés).
 * Les autres codes (caractères de contrôle, entités ambiguës…) n'en relèvent pas.
 */
const SYNTAX_ERRORS = new Set([
  'duplicate-attribute',
  'missing-attribute-value',
  'missing-whitespace-between-attributes',
  'unexpected-character-in-attribute-name',
  'unexpected-character-in-unquoted-attribute-value',
  'unexpected-equals-sign-before-attribute-name',
  'unexpected-solidus-in-tag',
  'invalid-first-character-of-tag-name',
  'missing-end-tag-name',
  'eof-in-tag',
  'end-tag-with-attributes',
  'end-tag-with-trailing-solidus',
  'non-void-html-element-start-tag-with-trailing-solidus',
  'nested-comment',
  'incorrectly-closed-comment',
  'incorrectly-opened-comment',
  'abrupt-closing-of-empty-comment',
  'closing-of-element-with-open-child-elements',
  'end-tag-without-matching-open-element',
  'misplaced-start-tag-for-head-element',
  'nested-noscript-in-head',
  'open-elements-left-after-eof',
  'disallowed-content-in-noscript-in-head',
  'non-conforming-doctype',
  'misplaced-doctype',
  'missing-doctype',
])

const validity = defineCheck(['8.2.1'], async (ctx, t) => {
  const o = t('8.2.1')
  o.applicable()

  // 1. Erreurs de syntaxe du code source servi, relevées par un analyseur conforme à la spec HTML.
  const lines = ctx.source.split('\n')
  const seen = new Set<string>()
  parse(ctx.source, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => {
      if (!SYNTAX_ERRORS.has(error.code)) return
      const line = lines[error.startLine - 1] ?? ''
      const excerpt = line.slice(Math.max(0, error.startCol - 60), error.startCol + 80).trim()
      const key = `${error.code}|${excerpt}`
      if (seen.has(key)) return
      seen.add(key)
      o.fail(`Erreur de syntaxe HTML « ${error.code} » (ligne ${error.startLine}).`, {
        selector: `ligne ${error.startLine}, colonne ${error.startCol}`,
        snippet: excerpt,
      })
    },
  })

  // 2. Dans le DOM généré : identifiants en double et imbrications interdites.
  const problems = await ctx.page.evaluate(() => {
    const { ref } = window.__rgaa
    const found: { message: string; ref: { selector: string; snippet: string } }[] = []

    const byId = new Map<string, Element[]>()
    for (const el of document.querySelectorAll('[id]')) {
      // Les `id` internes des SVG (dégradés, masques) comptent aussi : ils partagent l'espace de noms du document.
      const list = byId.get(el.id) ?? []
      list.push(el)
      byId.set(el.id, list)
    }
    for (const [id, elements] of byId) {
      const second = elements[1]
      if (second) {
        found.push({
          message: `L’identifiant id="${id}" est utilisé ${elements.length} fois dans la page.`,
          ref: ref(second),
        })
      }
    }

    const interactive =
      'a[href], button, input:not([type="hidden"]), select, textarea, label, details, iframe, [tabindex]:not([tabindex="-1"])'
    for (const el of document.querySelectorAll('a[href], button')) {
      const nested = el.querySelector(interactive)
      if (nested) {
        found.push({
          message: `Imbrication non conforme : un élément interactif <${nested.localName}> est contenu dans un <${el.localName}>.`,
          ref: ref(nested),
        })
      }
    }
    for (const el of document.querySelectorAll('li')) {
      const parent = el.parentElement?.localName
      if (parent !== 'ul' && parent !== 'ol' && parent !== 'menu') {
        found.push({
          message: 'Un <li> n’est pas enfant direct de <ul>, <ol> ou <menu>.',
          ref: ref(el),
        })
      }
    }
    for (const el of document.querySelectorAll('ul > *, ol > *')) {
      if (!['li', 'script', 'template'].includes(el.localName)) {
        found.push({
          message: `Une liste a un enfant direct <${el.localName}> : seuls des <li> sont admis.`,
          ref: ref(el),
        })
      }
    }
    for (const el of document.querySelectorAll('dt, dd')) {
      const parent = el.parentElement
      const inList =
        parent?.localName === 'dl' ||
        (parent?.localName === 'div' && parent.parentElement?.localName === 'dl')
      if (!inList) {
        found.push({
          message: `Un <${el.localName}> est placé hors d’une liste <dl>.`,
          ref: ref(el),
        })
      }
    }
    return found
  })
  for (const problem of problems) o.fail(problem.message, problem.ref)
})

// ─── 8.3 / 8.4 : langue par défaut ──────────────────────────────────────────

const defaultLanguage = defineCheck(['8.3.1', '8.4.1'], async (ctx, t) => {
  const info = await ctx.page.evaluate(() => {
    const { norm, isRendered } = window.__rgaa
    const root = document.documentElement
    // Texte de la page hors passages qui déclarent leur propre langue.
    let text = ''
    const walker = document.createTreeWalker(
      document.querySelector('main') ?? document.body,
      NodeFilter.SHOW_TEXT,
    )
    for (let node = walker.nextNode(); node && text.length < 4000; node = walker.nextNode()) {
      const parent = node.parentElement
      // `aria-hidden` : lettres séparées d'un effet de survol, icônes… ne sont pas du texte lu.
      if (
        !parent ||
        parent.closest('[lang]') !== root ||
        parent.closest('script, style, noscript, [aria-hidden="true"]')
      )
        continue
      if (isRendered(parent)) text += ` ${node.nodeValue}`
    }
    return { lang: root.getAttribute('lang') ?? root.getAttribute('xml:lang'), text: norm(text) }
  })

  t('8.3.1').applicable()
  if (!info.lang || info.lang.trim() === '') {
    t('8.3.1').fail('L’élément <html> n’a pas d’attribut lang.')
    return // 8.4.1 ne s'applique qu'aux pages ayant une langue par défaut.
  }

  t('8.4.1').applicable()
  if (!isValidLanguageCode(info.lang)) {
    t('8.4.1').fail(`Le code de langue « ${info.lang} » n’est pas valide.`)
    return
  }
  // Pertinence : la langue déclarée est-elle celle du contenu ?
  const guess = guessLanguage(info.text, 30)
  if (guess && guess.lang === primarySubtag(info.lang)) return
  if (guess) {
    t('8.4.1').fail(
      `Le contenu de la page semble rédigé en « ${guess.lang} » alors que la langue déclarée est « ${info.lang} ».`,
    )
    return
  }
  // Trop peu de texte pour se prononcer automatiquement.
  await t('8.4.1').judgePass({
    topic: 'lang.default',
    question: `La langue déclarée « ${info.lang} » est-elle bien la langue principale de cette page ?`,
    evidence: { lang: info.lang, extrait: info.text.slice(0, 300) },
  })
})

// ─── 8.5 / 8.6 : titre de page ──────────────────────────────────────────────

/** Minuscules, sans accents ni ponctuation : pour comparer un titre et un <h1>. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const pageTitle = defineCheck(['8.5.1', '8.6.1'], async (ctx, t) => {
  const info = await ctx.page.evaluate(() => {
    const { norm, visibleText } = window.__rgaa
    const titles = Array.from(document.querySelectorAll('head > title'))
    const h1 = document.querySelector('h1')
    return {
      count: titles.length,
      title: norm(document.title),
      h1: h1 ? visibleText(h1) : '',
    }
  })

  t('8.5.1').applicable()
  if (info.count === 0 || info.title === '') {
    t('8.5.1').fail('La page n’a pas de titre (balise <title> absente ou vide).')
    return
  }

  t('8.6.1').applicable()
  ctx.record('page.title', info.title)
  // Un titre qui reprend le <h1> de la page identifie son contenu : pertinent sans jugement.
  if (info.h1 && fold(info.title).includes(fold(info.h1))) return
  await t('8.6.1').judgePass({
    topic: 'page.title',
    question: 'Ce titre de page permet-il d’identifier le contenu de la page et le site ?',
    evidence: { page: ctx.path, title: info.title, h1: info.h1 },
  })
})

/** Deux pages différentes ne peuvent pas porter le même titre : il ne les identifierait plus. */
const uniqueTitles = defineSiteCheck(['8.6.1'], async (site, t) => {
  const byTitle = new Map<string, string[]>()
  for (const record of site.records('page.title')) {
    const title = String(record.value)
    byTitle.set(title, [...(byTitle.get(title) ?? []), record.url])
  }
  for (const [title, urls] of byTitle) {
    if (urls.length < 2) continue
    const paths = urls.map((url) => new URL(url).pathname).join(', ')
    for (const url of urls) {
      t(url, '8.6.1').fail(
        `Le titre « ${title} » est partagé par plusieurs pages (${paths}) : il n’identifie pas la page.`,
      )
    }
  }
})

// ─── 8.7 / 8.8 : changements de langue ──────────────────────────────────────

const languageChanges = defineCheck(['8.7.1', '8.8.1'], async (ctx, t) => {
  const data = await ctx.page.evaluate(() => {
    const { ref, visibleText, isHiddenFromAT } = window.__rgaa
    const pageLang = document.documentElement.getAttribute('lang') ?? ''

    // Blocs de texte de premier niveau : paragraphes, titres, items, cellules, liens, boutons…
    const blocks: { text: string; lang: string; ref: { selector: string; snippet: string } }[] = []
    const candidates = document.body.querySelectorAll(
      'p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, blockquote, figcaption, caption, label, legend, button, a, summary',
    )
    for (const el of candidates) {
      if (isHiddenFromAT(el)) continue
      // On ne garde que les blocs « feuilles » pour ne pas juger deux fois le même texte.
      if (el.querySelector('p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, blockquote')) continue
      const text = window.__rgaa.readableText(el)
      if (text.length < 20) continue
      const lang = el.closest('[lang]')?.getAttribute('lang') ?? ''
      blocks.push({ text, lang, ref: ref(el) })
    }

    const changes: { lang: string; text: string; ref: { selector: string; snippet: string } }[] = []
    for (const el of document.body.querySelectorAll('[lang]')) {
      if (isHiddenFromAT(el)) continue
      changes.push({ lang: el.getAttribute('lang') ?? '', text: visibleText(el), ref: ref(el) })
    }
    return { pageLang, blocks, changes }
  })
  const pageLang = primarySubtag(data.pageLang)

  // 8.7.1 — passages rédigés dans une autre langue que celle qui leur est déclarée.
  // La détection ne voit que les passages d'au moins six mots : un mot étranger isolé
  // relève des cas particuliers (nom propre, mot passé dans l'usage) ou d'une relecture éditoriale.
  for (const block of data.blocks) {
    const guess = guessLanguage(block.text)
    if (!guess) continue
    const declared = primarySubtag(block.lang || data.pageLang)
    if (guess.lang === declared) continue
    const answer = await t('8.7.1').judge({
      topic: 'lang.passage',
      question: `Ce passage semble rédigé en « ${guess.lang} » mais il est déclaré en « ${declared} ». Est-il réellement dans une autre langue (hors nom propre ou mot d’usage courant) ?`,
      answers: ['meme-langue', 'autre-langue'],
      evidence: { text: block.text.slice(0, 300), declared },
      ref: block.ref,
    })
    if (answer === 'autre-langue') {
      t('8.7.1').fail(
        `Passage en « ${guess.lang} » sans indication de langue : « ${block.text.slice(0, 120)} ».`,
        block.ref,
      )
    }
  }
  if (data.blocks.length > 0) t('8.7.1').applicable()
  t('8.7.1').note(
    'Détection automatique limitée aux passages d’au moins six mots : les mots étrangers isolés ne sont pas repérés.',
  )

  // 8.8.1 — validité et pertinence de chaque changement de langue déclaré.
  for (const change of data.changes) {
    t('8.8.1').applicable()
    if (!isValidLanguageCode(change.lang)) {
      t('8.8.1').fail(`Le code de langue « ${change.lang} » n’est pas valide.`, change.ref)
      continue
    }
    const declared = primarySubtag(change.lang)
    const guess = guessLanguage(change.text)
    if (guess && guess.lang === declared) continue
    if (guess && guess.lang !== declared) {
      t('8.8.1').fail(
        `Le passage est déclaré en « ${change.lang} » mais semble rédigé en « ${guess.lang} ».`,
        change.ref,
      )
      continue
    }
    if (declared === pageLang) continue // Rappel de la langue de la page : sans effet.
    await t('8.8.1').judgePass({
      topic: 'lang.change',
      question: `Ce texte est-il bien rédigé dans la langue déclarée « ${change.lang} » ?`,
      evidence: { lang: change.lang, text: change.text.slice(0, 300) },
      ref: change.ref,
    })
  }
})

// ─── 8.9 : balises détournées à des fins de présentation ────────────────────

const presentationalTags = defineCheck(['8.9.1'], async (ctx, t) => {
  const o = t('8.9.1')
  o.applicable()
  const problems = await ctx.page.evaluate(() => {
    const { ref, norm, isRendered } = window.__rgaa
    const found: { message: string; ref: { selector: string; snippet: string } }[] = []

    // Éléments de texte vides : un paragraphe, un titre ou un item sans contenu ne sert qu'à espacer.
    for (const el of document.body.querySelectorAll(
      'p, h1, h2, h3, h4, h5, h6, li, blockquote, dt, dd',
    )) {
      if (!isRendered(el)) continue
      const hasContent =
        norm(el.textContent).replace(/ /g, '') !== '' ||
        el.querySelector(
          'img, svg, picture, video, audio, iframe, object, canvas, input, button, select, textarea',
        )
      if (!hasContent) {
        found.push({
          message: `Élément <${el.localName}> vide, utilisé pour créer de l’espacement.`,
          ref: ref(el),
        })
      }
    }

    // Suites de <br> : retours à la ligne utilisés pour simuler des paragraphes ou des marges.
    for (const br of document.body.querySelectorAll('br')) {
      let next = br.nextSibling
      while (next && next.nodeType === 3 && norm(next.nodeValue) === '') next = next.nextSibling
      if (next instanceof Element && next.localName === 'br') {
        found.push({
          message: 'Deux <br> consécutifs, utilisés pour créer de l’espacement.',
          ref: ref(br),
        })
      }
    }

    // Balises et attributs de présentation obsolètes.
    for (const el of document.body.querySelectorAll(
      'font, center, big, strike, tt, marquee, blink, basefont',
    )) {
      found.push({ message: `Balise de présentation obsolète <${el.localName}>.`, ref: ref(el) })
    }
    return found
  })
  for (const problem of problems) o.fail(problem.message, problem.ref)
})

// ─── 8.10 : sens de lecture ─────────────────────────────────────────────────

const readingDirection = defineCheck(['8.10.1', '8.10.2'], async (ctx, t) => {
  const data = await ctx.page.evaluate(() => {
    const { ref, visibleText, isHiddenFromAT } = window.__rgaa
    // Écritures de droite à gauche : hébreu, arabe, syriaque, thâna, n'ko…
    const rtl = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/
    const pageDir = (document.documentElement.getAttribute('dir') ?? 'ltr').toLowerCase()

    const unmarked: { text: string; ref: { selector: string; snippet: string } }[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent || !rtl.test(node.nodeValue ?? '') || isHiddenFromAT(parent)) continue
      const dir = (parent.closest('[dir]')?.getAttribute('dir') ?? pageDir).toLowerCase()
      if (dir !== 'rtl' && dir !== 'auto') {
        unmarked.push({ text: (node.nodeValue ?? '').trim().slice(0, 80), ref: ref(parent) })
      }
    }

    const declared: {
      dir: string
      hasRtl: boolean
      hasText: boolean
      ref: { selector: string; snippet: string }
    }[] = []
    for (const el of document.querySelectorAll('[dir]')) {
      const text = visibleText(el)
      declared.push({
        dir: el.getAttribute('dir') ?? '',
        hasRtl: rtl.test(text),
        hasText: text !== '',
        ref: ref(el),
      })
    }
    return { unmarked, declared }
  })

  for (const item of data.unmarked) {
    t('8.10.1').fail(
      `Texte écrit de droite à gauche sans attribut dir="rtl" : « ${item.text} ».`,
      item.ref,
    )
  }
  // Sans texte de sens différent, 8.10.1 est non applicable (aucun `applicable()`).

  for (const item of data.declared) {
    t('8.10.2').applicable()
    const dir = item.dir.toLowerCase()
    if (dir !== 'rtl' && dir !== 'ltr') {
      // `auto` est valide en HTML mais le test n'admet que `rtl` ou `ltr`.
      t('8.10.2').fail(`Valeur dir="${item.dir}" non conforme (attendu : rtl ou ltr).`, item.ref)
    } else if (dir === 'rtl' && item.hasText && !item.hasRtl) {
      t('8.10.2').fail('dir="rtl" appliqué à un texte qui se lit de gauche à droite.', item.ref)
    }
  }
})

export const checks: Check[] = [
  doctype,
  validity,
  defaultLanguage,
  pageTitle,
  uniqueTitles,
  languageChanges,
  presentationalTags,
  readingDirection,
]
