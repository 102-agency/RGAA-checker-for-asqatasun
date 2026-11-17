import type {
  ButtonInfo,
  FieldInfo,
  FormInfo,
  FormsSnapshot,
  FormText,
  Geometry,
  GroupInfo,
  LabelForInfo,
  LabelInfo,
  Passage,
  Ref,
  Relation,
  SelectInfo,
} from './formulaires-types.ts'

/**
 * Relevé de tous les champs, formulaires, regroupements et boutons de la page.
 *
 * S'exécute DANS la page (`page.evaluate(collectForms, withTexts)`) : la fonction
 * doit rester autonome, sans référence à un import. Elle ne modifie pas le DOM.
 * `withTexts` ajoute les blocs de texte des formulaires (sondes d'erreur).
 */
export function collectForms(withTexts: boolean): FormsSnapshot {
  const R = window.__rgaa
  const { norm, ref, isRendered, isVisible, isHiddenFromAT } = R

  const FIELD_ROLES = new Set([
    'textbox',
    'searchbox',
    'combobox',
    'listbox',
    'checkbox',
    'radio',
    'switch',
    'slider',
    'spinbutton',
    'progressbar',
  ])
  const EXCLUDED_INPUT = new Set(['hidden', 'submit', 'reset', 'button', 'image'])
  const CONTROLS = 'input, select, textarea, button, meter, progress, output'
  const NATIVE_FIELDS =
    'input:not([type=hidden]):not([type=submit]):not([type=reset]):not([type=button]):not([type=image]), textarea, select'
  const BUTTONS =
    'button, input[type=submit], input[type=reset], input[type=button], input[type=image], [role=button]'
  const LIVE = '[role=alert], [role=status], [aria-live]:not([aria-live=off])'

  const firstRole = (el: Element): string =>
    (el.getAttribute('role') ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''

  // ─── Texte visible ────────────────────────────────────────────────────────

  function isTextVisible(node: Text): boolean {
    const range = document.createRange()
    range.selectNodeContents(node)
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1)
    if (rects.length === 0) return false
    for (let n = node.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
      if (s.clipPath === 'inset(50%)' || s.clip === 'rect(0px, 0px, 0px, 0px)') return false
      if (s.display !== 'contents' && s.overflow !== 'visible') {
        const r = n.getBoundingClientRect()
        if (r.width <= 1 || r.height <= 1) return false
      }
    }
    return true
  }

  interface TextOptions {
    visibleOnly: boolean
    skipAriaHidden: boolean
    exclude?: Set<Element>
  }

  /** Texte d'un élément : contenu restitué (`visibleOnly: false`) ou réellement affiché. */
  function textOf(root: Element, options: TextOptions): string {
    let out = ''
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        if (!options.visibleOnly || isTextVisible(node as Text)) out += (node as Text).nodeValue
        return
      }
      if (node.nodeType !== 1) return
      const el = node as Element
      if (options.exclude?.has(el)) return
      const tag = el.localName
      if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript') return
      if (el !== root && !isRendered(el)) return
      if (options.skipAriaHidden && el !== root && el.getAttribute('aria-hidden') === 'true') return
      if (tag === 'img') {
        const alt = el.getAttribute('alt')
        if (alt && !options.visibleOnly) out += ` ${alt} `
        return
      }
      const block = getComputedStyle(el).display !== 'inline'
      if (block || tag === 'br') out += ' '
      for (const child of Array.from(el.childNodes)) walk(child)
      if (block) out += ' '
    }
    walk(root)
    return norm(out)
  }

  type Box = { left: number; top: number; right: number; bottom: number }

  /** Boîte englobante du texte visible d'un élément (sans les contrôles qu'il contient). */
  function textBox(root: Element, exclude: Set<Element>): Box | null {
    let box: Box | null = null
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        const text = node as Text
        if (norm(text.nodeValue) === '' || !isTextVisible(text)) return
        const range = document.createRange()
        range.selectNodeContents(text)
        for (const r of Array.from(range.getClientRects())) {
          if (r.width <= 1 || r.height <= 1) continue
          box = box
            ? {
                left: Math.min(box.left, r.left),
                top: Math.min(box.top, r.top),
                right: Math.max(box.right, r.right),
                bottom: Math.max(box.bottom, r.bottom),
              }
            : { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
        }
        return
      }
      if (node.nodeType !== 1) return
      const el = node as Element
      if (exclude.has(el) || !isRendered(el)) return
      for (const child of Array.from(el.childNodes)) walk(child)
    }
    walk(root)
    return box
  }

  const boxOf = (el: Element): Box => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }

  const distanceBetween = (a: Box, b: Box): number => {
    const dx = Math.max(0, a.left - b.right, b.left - a.right)
    const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom)
    return Math.hypot(dx, dy)
  }

  const controlsIn = (root: Element): Set<Element> =>
    new Set(Array.from(root.querySelectorAll(CONTROLS)))

  // ─── Passages liés par aria-* ─────────────────────────────────────────────

  function passages(el: Element, attribute: string): Passage[] | null {
    const raw = el.getAttribute(attribute)
    if (raw === null) return null
    return raw
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => {
        const node = document.getElementById(id)
        if (!node) return { id, exists: false, text: '', visible: false }
        return {
          id,
          exists: true,
          text: norm(node.textContent),
          visible:
            isVisible(node) && textOf(node, { visibleOnly: true, skipAriaHidden: false }) !== '',
        }
      })
  }

  const passageElements = (el: Element, attribute: string): Element[] =>
    (el.getAttribute(attribute) ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null)

  // ─── Regroupements ────────────────────────────────────────────────────────

  const groupElements = Array.from(
    document.querySelectorAll('fieldset, [role=group], [role=radiogroup]'),
  ).filter((el) => {
    if (!isRendered(el)) return false
    return el.localName === 'fieldset' || ['group', 'radiogroup'].includes(firstRole(el))
  })
  const groupIndex = new Map<Element, number>(groupElements.map((el, i) => [el, i]))

  // ─── Formulaires ──────────────────────────────────────────────────────────

  const formElements = Array.from(
    document.querySelectorAll('form, [role=form], [role=search]'),
  ).filter((el) => isRendered(el))
  const formIndex = new Map<Element, number>(formElements.map((el, i) => [el, i]))
  const containerOf = (el: Element): number => {
    const native = (el as HTMLInputElement).form
    if (native && formIndex.has(native)) return formIndex.get(native) ?? -1
    for (let node: Element | null = el.parentElement; node; node = node.parentElement) {
      const index = formIndex.get(node)
      if (index !== undefined) return index
    }
    return -1
  }

  // ─── Champs ───────────────────────────────────────────────────────────────

  const fieldElements: Element[] = []
  let skippedHidden = 0
  for (const el of Array.from(
    document.querySelectorAll('input, textarea, select, meter, progress, output, [role]'),
  )) {
    const tag = el.localName
    const role = firstRole(el)
    let isField = false
    if (tag === 'input') {
      isField = !EXCLUDED_INPUT.has((el as HTMLInputElement).type)
    } else if (['textarea', 'select', 'meter', 'progress', 'output'].includes(tag)) {
      isField = true
    } else if (FIELD_ROLES.has(role)) {
      isField = true
      // Une liste ouverte par un champ combiné n'est pas un champ à part.
      if (role === 'listbox' && el.id) {
        const owner = document.querySelector(
          `[role=combobox][aria-controls~="${CSS.escape(el.id)}"]`,
        )
        if (owner) isField = false
      }
      // Un rôle posé sur un conteneur dont le vrai contrôle est un champ natif.
      if (isField && el.querySelector(NATIVE_FIELDS)) isField = false
    }
    if (!isField || !isRendered(el)) continue
    if (isHiddenFromAT(el)) {
      skippedHidden += 1
      continue
    }
    fieldElements.push(el)
  }
  const fieldIndex = new Map<Element, number>(fieldElements.map((el, i) => [el, i]))

  const relate = (l: Box, f: Box): { relation: Relation; gap: number; distance: number } => {
    const TOL = 2
    const dx = Math.max(0, l.left - f.right, f.left - l.right)
    const dy = Math.max(0, l.top - f.bottom, f.top - l.bottom)
    const distance = Math.hypot(dx, dy)
    const overlapX = Math.min(l.right, f.right) - Math.max(l.left, f.left)
    const overlapY = Math.min(l.bottom, f.bottom) - Math.max(l.top, f.top)
    if (overlapX > TOL && overlapY > TOL) return { relation: 'inside', gap: 0, distance: 0 }
    if (overlapX > 0 && overlapY <= TOL) {
      return { relation: l.bottom <= f.top + TOL ? 'above' : 'below', gap: dy, distance }
    }
    if (overlapY > 0 && overlapX <= TOL) {
      return { relation: l.right <= f.left + TOL ? 'left' : 'right', gap: dx, distance }
    }
    return { relation: 'diagonal', gap: distance, distance }
  }

  const RTL_CHARS = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
  const LTR_LETTERS = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/

  /** Boutons et textes accolés au champ (même parent, ou parent qui ne contient que ce champ). */
  function neighbours(el: Element): { nodes: Node[] } {
    const nodes: Node[] = []
    let node: Element = el
    for (let depth = 0; depth < 2; depth++) {
      for (let s = node.previousSibling; s; s = s.previousSibling) {
        nodes.push(s)
        if (s.nodeType === 1) break
      }
      for (let s = node.nextSibling; s; s = s.nextSibling) {
        nodes.push(s)
        if (s.nodeType === 1) break
      }
      const parent = node.parentElement
      if (!parent || parent.localName === 'form' || parent.localName === 'body') break
      if (parent.querySelectorAll(NATIVE_FIELDS).length > 1) break
      node = parent
    }
    return { nodes }
  }

  function buttonText(btn: Element): string {
    if (btn.localName === 'input') return norm(btn.getAttribute('value'))
    // Lettres séparées d'un effet de survol (`aria-hidden`) : leur texte, doublé, n'est pas l'intitulé du
    // bouton. Seul le texte lu par les technologies d'assistance se compare au nom accessible.
    return textOf(btn, { visibleOnly: true, skipAriaHidden: true })
  }

  function adjacency(
    el: Element,
    box: Box,
  ): { button: { text: string; ref: Ref } | null; text: string | null } {
    let button: { text: string; ref: Ref } | null = null
    let text: string | null = null
    for (const n of neighbours(el).nodes) {
      if (n.nodeType === 3) {
        const value = norm(n.nodeValue)
        if (value && !text && isTextVisible(n as Text)) {
          const range = document.createRange()
          range.selectNodeContents(n)
          const r = range.getBoundingClientRect()
          if (
            distanceBetween({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, box) <=
            48
          ) {
            text = value
          }
        }
        continue
      }
      if (n.nodeType !== 1) continue
      const other = n as Element
      if (!isRendered(other) || !isVisible(other) || other === el) continue
      if (other.localName === 'label' || other.localName === 'legend') continue
      let btn: Element | null = null
      if (other.matches(BUTTONS)) btn = other
      else if (!other.querySelector(NATIVE_FIELDS)) {
        const inner = other.querySelectorAll(BUTTONS)
        if (inner.length === 1) btn = inner[0] ?? null
      }
      if (btn) {
        const label = buttonText(btn)
        if (label && !button && distanceBetween(boxOf(btn), box) <= 48) {
          button = { text: label, ref: ref(btn) }
        }
        continue
      }
      if (other.querySelector(NATIVE_FIELDS) || other.matches('[role=alert]')) continue
      const value = textOf(other, { visibleOnly: true, skipAriaHidden: false })
      if (value && value.length <= 120 && !text && distanceBetween(boxOf(other), box) <= 48) {
        text = value
      }
    }
    return { button, text }
  }

  const requiredPattern = /\*|obligatoire|requis|required|mandatory/i
  const optionalPattern = /facultatif|optionnel|optional/i

  function selectInfo(select: HTMLSelectElement): SelectInfo {
    const options = Array.from(select.options).map((o) => ({ text: norm(o.text), value: o.value }))
    const optgroups = Array.from(select.querySelectorAll('optgroup')).map((g) => ({
      ref: ref(g),
      label: g.hasAttribute('label') ? g.getAttribute('label') : null,
      options: Array.from(g.querySelectorAll('option')).map((o) => norm(o.text)),
    }))
    const ungrouped = Array.from(select.querySelectorAll(':scope > option'))
      .filter((o, i) => !(i === 0 && (o as HTMLOptionElement).value === ''))
      .map((o) => norm((o as HTMLOptionElement).text))
    return { options, optgroups, ungrouped }
  }

  const passageEls = new Map<number, Element[]>()

  const fields: FieldInfo[] = fieldElements.map((el, index) => {
    const tag = el.localName
    let role: string | null = null
    try {
      role = R.role(el)
    } catch {
      role = null
    }
    const explicitRole = firstRole(el)
    const input = el as HTMLInputElement
    const kind =
      tag === 'input'
        ? input.type
        : ['textarea', 'select', 'meter', 'progress', 'output'].includes(tag)
          ? tag
          : explicitRole
    const checkable =
      kind === 'checkbox' ||
      kind === 'radio' ||
      ['checkbox', 'radio', 'switch'].includes(explicitRole) ||
      ['checkbox', 'radio', 'switch'].includes(role ?? '')

    const nativeLabels = Array.from((el as HTMLInputElement).labels ?? [])
    const labels: LabelInfo[] = nativeLabels.map((label) => {
      const exclude = controlsIn(label)
      const visibleText = textOf(label, { visibleOnly: true, skipAriaHidden: false, exclude })
      return {
        text: textOf(label, { visibleOnly: false, skipAriaHidden: true, exclude }),
        visibleText,
        visible: visibleText.replace(/[*\s]/g, '') !== '',
        hasFor: label.hasAttribute('for'),
        forMatches: el.id !== '' && label.getAttribute('for') === el.id,
        implicit: label.contains(el),
        ref: ref(label),
      }
    })

    const labelledby = passages(el, 'aria-labelledby')
    const describedby = passages(el, 'aria-describedby') ?? []
    const errormessage = passages(el, 'aria-errormessage') ?? []
    const ariaLabel = norm(el.getAttribute('aria-label'))
    const title = norm(el.getAttribute('title'))

    const labelledText = norm(
      (labelledby ?? [])
        .filter((p) => p.exists)
        .map((p) => p.text)
        .join(' '),
    )
    const labelText = norm(
      labels
        .map((l) => l.text)
        .filter(Boolean)
        .join(' '),
    )
    let nameSource: FieldInfo['nameSource'] = 'none'
    let nameText = ''
    if (labelledText) {
      nameSource = 'aria-labelledby'
      nameText = labelledText
    } else if (ariaLabel) {
      nameSource = 'aria-label'
      nameText = ariaLabel
    } else if (labelText) {
      nameSource = 'label'
      nameText = labelText
    } else if (title) {
      nameSource = 'title'
      nameText = title
    }

    let accName = ''
    try {
      accName = R.accName(el)
    } catch {
      accName = ''
    }

    // Intitulé visible : étiquettes affichées, sinon passages liés par aria-labelledby affichés.
    const visibleLabelEls: { el: Element; text: string }[] = []
    for (const [i, label] of labels.entries()) {
      const labelEl = nativeLabels[i]
      if (label.visible && labelEl) visibleLabelEls.push({ el: labelEl, text: label.visibleText })
    }
    if (visibleLabelEls.length === 0) {
      for (const node of passageElements(el, 'aria-labelledby')) {
        const text = textOf(node, {
          visibleOnly: true,
          skipAriaHidden: false,
          exclude: controlsIn(node),
        })
        if (text.replace(/[*\s]/g, '') !== '') visibleLabelEls.push({ el: node, text })
      }
    }
    const visibleLabels = visibleLabelEls.map((v) => v.text)

    // Position de l'étiquette visible la plus proche.
    const rect = boxOf(el)
    const fieldVisible = isVisible(el)
    let geometry: Geometry | null = null
    if (fieldVisible) {
      let best: { box: Box; el: Element } | null = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const candidate of visibleLabelEls) {
        const box = textBox(candidate.el, controlsIn(candidate.el))
        if (!box) continue
        const d = distanceBetween(box, rect)
        if (d < bestDistance) {
          best = { box, el: candidate.el }
          bestDistance = d
        }
      }
      if (best) {
        const found = relate(best.box, rect)
        let gap = found.gap
        if (found.relation === 'above') {
          // Les textes d'aide du champ, intercalés, ne comptent pas dans l'espace.
          let between = 0
          for (const node of [
            ...passageElements(el, 'aria-describedby'),
            ...passageElements(el, 'aria-errormessage'),
          ]) {
            const b = boxOf(node)
            if (b.top >= best.box.bottom - 2 && b.bottom <= rect.top + 2)
              between += b.bottom - b.top
          }
          gap = Math.max(0, gap - between)
        }
        const labelText = norm(best.el.textContent)
        geometry = {
          relation: found.relation,
          gap: Math.round(gap),
          distance: Math.round(found.distance),
          rtl: getComputedStyle(best.el).direction === 'rtl',
          mixedDirection: RTL_CHARS.test(labelText) && LTR_LETTERS.test(labelText),
        }
      }
    }

    const nearby = fieldVisible ? adjacency(el, rect) : { button: null, text: null }

    // Indications visibles (obligatoire / facultatif) : étiquette, passages de texte liés, légende.
    const indicationSources = [...visibleLabels]
    for (const node of [
      ...passageElements(el, 'aria-describedby'),
      ...passageElements(el, 'aria-labelledby'),
    ]) {
      if (isVisible(node))
        indicationSources.push(textOf(node, { visibleOnly: true, skipAriaHidden: false }))
    }
    const chain: number[] = []
    for (let node = el.parentElement; node; node = node.parentElement) {
      const g = groupIndex.get(node)
      if (g === undefined) continue
      chain.push(g)
      if (node.localName === 'fieldset') {
        const legend = node.querySelector(':scope > legend')
        if (legend)
          indicationSources.push(textOf(legend, { visibleOnly: true, skipAriaHidden: false }))
      }
    }
    const requiredMatch =
      indicationSources.map((t) => requiredPattern.exec(t)?.[0]).find(Boolean) ?? null

    passageEls.set(index, [
      ...passageElements(el, 'aria-describedby'),
      ...passageElements(el, 'aria-errormessage'),
      ...passageElements(el, 'aria-labelledby'),
      ...nativeLabels,
    ])

    let valueEmpty = true
    if (kind === 'radio' && input.name) {
      const root: ParentNode = input.form ?? document
      valueEmpty =
        root.querySelector(`input[type=radio][name="${CSS.escape(input.name)}"]:checked`) === null
    } else if (kind === 'checkbox') {
      valueEmpty = !input.checked
    } else if (['checkbox', 'radio', 'switch'].includes(explicitRole)) {
      valueEmpty = el.getAttribute('aria-checked') !== 'true'
    } else if (tag === 'select') {
      valueEmpty =
        (el as HTMLSelectElement).selectedOptions.length === 0 ||
        (el as HTMLSelectElement).value === ''
    } else if (tag === 'input' || tag === 'textarea') {
      valueEmpty = input.value === ''
    }

    let invalidPseudo = false
    try {
      invalidPseudo = el.matches(':invalid')
    } catch {
      invalidPseudo = false
    }

    return {
      index,
      ref: ref(el),
      tag,
      kind,
      role,
      checkable,
      id: el.id,
      name: el.getAttribute('name') ?? '',
      formIndex: containerOf(el),
      required: input.required === true || el.hasAttribute('required'),
      ariaRequired: el.getAttribute('aria-required') === 'true',
      autocomplete: el.hasAttribute('autocomplete')
        ? (el.getAttribute('autocomplete') ?? '').trim().toLowerCase()
        : null,
      title,
      placeholder: norm(el.getAttribute('placeholder')),
      ariaLabel,
      labelledby,
      labels,
      describedby,
      errormessage,
      nameSource,
      nameText,
      accName,
      visibleLabel: norm(visibleLabels.join(' ')),
      visibleLabels,
      fieldVisible,
      geometry,
      adjacentButton: nearby.button,
      adjacentText: nearby.text,
      requiredIndication: requiredMatch,
      optionalIndication: indicationSources.some((t) => optionalPattern.test(t)),
      pattern: el.getAttribute('pattern'),
      min: el.getAttribute('min'),
      max: el.getAttribute('max'),
      minLength: el.getAttribute('minlength'),
      maxLength: el.getAttribute('maxlength'),
      disabled: (el as HTMLInputElement).disabled === true,
      groups: chain,
      select: tag === 'select' ? selectInfo(el as HTMLSelectElement) : null,
      valueEmpty,
      ariaInvalid: el.getAttribute('aria-invalid'),
      invalidPseudo,
      validationMessage: (el as HTMLInputElement).validationMessage ?? '',
    }
  })

  // ─── Formulaires ──────────────────────────────────────────────────────────

  const asteriskRule =
    /(ast[ée]risque|\*)[^.]{0,80}(obligatoire|requis)|(obligatoire|requis)[^.]{0,80}(ast[ée]risque|\*)/i
  const allRequiredRule =
    /tous les champs[^.]{0,40}(sont )?(obligatoires|requis)|all fields[^.]{0,20}required/i

  const forms: FormInfo[] = formElements.map((el, index) => {
    const submits = Array.from(
      el instanceof HTMLFormElement
        ? el.elements
        : el.querySelectorAll('button, input[type=submit], input[type=image]'),
    ).filter((e) =>
      e.matches(
        'button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]',
      ),
    )
    const submit = submits.find((e) => isRendered(e) && isVisible(e)) ?? null
    let context = R.visibleText(el)
    for (let s = el.previousElementSibling, n = 0; s && n < 2; s = s.previousElementSibling, n++) {
      context += ` ${R.visibleText(s)}`
    }
    return {
      index,
      ref: ref(el),
      tag: el.localName,
      noValidate: el instanceof HTMLFormElement ? el.noValidate : false,
      method: el instanceof HTMLFormElement ? el.method.toLowerCase() : '',
      fields: fields.filter((f) => f.formIndex === index).map((f) => f.index),
      submit: submit ? ref(submit) : null,
      search:
        firstRole(el) === 'search' ||
        el.closest('[role=search]') !== null ||
        el.querySelector('input[type=search], [role=searchbox]') !== null,
      asteriskExplained: asteriskRule.test(context),
      allRequiredNotice: allRequiredRule.exec(context)?.[0] ?? null,
    }
  })

  // ─── Regroupements ────────────────────────────────────────────────────────

  const groups: GroupInfo[] = groupElements.map((el, index) => {
    const kind: GroupInfo['kind'] =
      el.localName === 'fieldset'
        ? 'fieldset'
        : firstRole(el) === 'radiogroup'
          ? 'radiogroup'
          : 'group'
    const legendEl = kind === 'fieldset' ? el.querySelector(':scope > legend') : null
    const legend = legendEl ? norm(legendEl.textContent) : null
    const ariaLabel = norm(el.getAttribute('aria-label'))
    const labelledby = passages(el, 'aria-labelledby')
    const labelledText = norm(
      (labelledby ?? [])
        .filter((p) => p.exists)
        .map((p) => p.text)
        .join(' '),
    )
    return {
      index,
      ref: ref(el),
      kind,
      legend,
      ariaLabel,
      labelledby,
      name: legend || labelledText || ariaLabel,
      fields: fields.filter((f) => f.groups.includes(index)).map((f) => f.index),
    }
  })

  // ─── Boutons ──────────────────────────────────────────────────────────────

  const buttons: ButtonInfo[] = []
  for (const el of Array.from(document.querySelectorAll(BUTTONS))) {
    if (!isRendered(el) || isHiddenFromAT(el)) continue
    // Un <button role="combobox"> ou role="checkbox" est un champ, pas un bouton.
    const explicit = firstRole(el)
    if (explicit && explicit !== 'button') continue
    const tag = el.localName
    const type = tag === 'input' ? (el as HTMLInputElement).type : ''
    const kind: ButtonInfo['kind'] =
      tag === 'input'
        ? type === 'submit'
          ? 'submit'
          : type === 'reset'
            ? 'reset'
            : type === 'image'
              ? 'image'
              : 'input-button'
        : tag === 'button'
          ? 'button'
          : 'role'
    let inForm =
      (el as HTMLButtonElement).form !== null && (el as HTMLButtonElement).form !== undefined
    if (!inForm) inForm = el.closest('form, [role=form], [role=search], fieldset') !== null
    if (!inForm) {
      let node: Element | null = el.parentElement
      for (let depth = 0; node && depth < 2 && !inForm; depth++, node = node.parentElement) {
        if (node.querySelector(NATIVE_FIELDS)) inForm = true
      }
    }
    let accName = ''
    try {
      accName = R.accName(el)
    } catch {
      accName = ''
    }
    const visibleText = buttonText(el)
    buttons.push({
      ref: ref(el),
      kind,
      inForm,
      formIndex: containerOf(el),
      accName,
      ariaLabel: norm(el.getAttribute('aria-label')),
      labelledby: passages(el, 'aria-labelledby'),
      value: norm(el.getAttribute('value')),
      content: tag === 'input' ? '' : norm(el.textContent),
      alt: norm(el.getAttribute('alt')),
      title: norm(el.getAttribute('title')),
      visibleText,
      iconOnly:
        visibleText === '' &&
        (kind === 'image' || el.querySelector('img, svg, [role=img], canvas, object') !== null),
    })
  }

  // ─── Étiquettes avec for ──────────────────────────────────────────────────

  const labelFors: LabelForInfo[] = []
  for (const label of Array.from(document.querySelectorAll('label[for]'))) {
    if (!isRendered(label)) continue
    const forValue = label.getAttribute('for') ?? ''
    const target = document.getElementById(forValue)
    labelFors.push({
      ref: ref(label),
      forValue,
      targetExists: target !== null,
      targetTag: target?.localName ?? '',
      targetLabelable:
        target?.matches(
          'input:not([type=hidden]), select, textarea, button, meter, output, progress',
        ) ?? false,
      duplicateId:
        forValue !== '' && document.querySelectorAll(`[id="${CSS.escape(forValue)}"]`).length > 1,
    })
  }

  // ─── Textes des formulaires (sondes d'erreur) ─────────────────────────────

  const texts: FormText[] = []
  if (withTexts) {
    const roots = new Set<Element>([
      ...formElements.filter((f) => f.localName === 'form' || firstRole(f) === 'form'),
      ...Array.from(document.querySelectorAll(LIVE)).filter((el) => isRendered(el)),
    ])
    const seen = new Set<Element>()
    for (const root of roots) {
      for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
        if (seen.has(el) || texts.length >= 400) continue
        seen.add(el)
        if (!isRendered(el)) continue
        const own = Array.from(el.childNodes).filter(
          (n): n is Text =>
            n.nodeType === 3 && norm(n.nodeValue) !== '' && isTextVisible(n as Text),
        )
        if (own.length === 0) continue
        if (
          el.matches('script, style, option, textarea') ||
          el.closest('button, a, [role=button], summary')
        )
          continue
        const text = norm(own.map((n) => n.nodeValue).join(' '))
        const box = boxOf(el)
        const assoc: number[] = []
        for (const [fieldNo, els] of passageEls) {
          if (els.some((p) => p === el || p.contains(el))) assoc.push(fieldNo)
        }
        let nearest = -1
        let nearestDistance = Number.POSITIVE_INFINITY
        for (const [i, f] of fieldElements.entries()) {
          const d = distanceBetween(box, boxOf(f))
          if (d < nearestDistance) {
            nearest = i
            nearestDistance = d
          }
        }
        texts.push({
          text,
          ref: ref(el),
          inAlert: el.closest(LIVE) !== null,
          assoc,
          nearestField: nearest,
          nearestDistance: Math.round(nearestDistance),
        })
      }
    }
  }

  const active = document.activeElement
  const activeField = active ? (fieldIndex.get(active) ?? -1) : -1

  const body = R.visibleText(document.body)
  return {
    fields,
    forms,
    groups,
    buttons,
    labelFors,
    texts,
    active:
      active && active !== document.body
        ? { fieldIndex: activeField, tag: active.localName, ref: ref(active) }
        : null,
    skippedHidden,
    page: {
      asteriskExplained: asteriskRule.test(body),
      allRequiredNotice: allRequiredRule.exec(body)?.[0] ?? null,
    },
    url: location.href,
  }
}
