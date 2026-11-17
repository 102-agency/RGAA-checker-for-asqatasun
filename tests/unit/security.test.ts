import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UserError } from '../../src/core/errors.ts'
import {
  assertSafeSegment,
  containedPath,
  isSafeSegment,
  readJsonFile,
  readTextFile,
  writeFileAtomic,
} from '../../src/security/fs.ts'
import {
  escapeHtml,
  escapeMarkdown,
  markdownBlock,
  markdownCode,
  safeLine,
  safeText,
  truncate,
} from '../../src/security/text.ts'
import { canonicalPath, parseSiteUrl, resolvePageUrl } from '../../src/security/url.ts'
import { Reader } from '../../src/security/validate.ts'

describe('safeText : texte venu d’une page', () => {
  it('retire les séquences ANSI (couleur, curseur, titre de fenêtre, lien OSC 8)', () => {
    expect(safeText('a\u001b[31mrouge\u001b[0mb')).toBe('arougeb')
    expect(safeText('x\u001b[2J\u001b[Hy')).toBe('xy')
    expect(safeText('x\u001b]0;pwned\u0007y')).toBe('xy')
    expect(safeText('\u001b]8;;http://evil\u001b\\lien\u001b]8;;\u001b\\')).toBe('lien')
  })

  it('retire les caractères de contrôle mais garde sauts de ligne et tabulations', () => {
    expect(safeText('a\u0000b\u0007c\u007fd\u009be')).toBe('abcde')
    expect(safeText('a\tb\nc')).toBe('a\tb\nc')
    expect(safeText('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('retire les contrôles bidirectionnels (Trojan Source)', () => {
    expect(safeText('user\u202eevil\u2066x\u2069')).toBe('userevilx')
  })

  it('safeLine tient sur une ligne et tronque', () => {
    expect(safeLine('a \n\n  b\t c')).toBe('a b c')
    expect(safeLine('x'.repeat(50), 10)).toHaveLength(10)
    expect(safeLine('x'.repeat(50), 10).endsWith('…')).toBe(true)
  })

  it('truncate ne coupe pas une paire de substitution', () => {
    const text = '😀'.repeat(10)
    const cut = truncate(text, 4)
    expect(Array.from(cut)).toHaveLength(4)
    expect(cut).toBe('😀😀😀…')
  })
})

describe('échappements de sortie', () => {
  it('escapeHtml neutralise balises, guillemets et apostrophes', () => {
    expect(escapeHtml(`<img src=x onerror="a()">'&`)).toBe(
      '&lt;img src=x onerror=&quot;a()&quot;&gt;&#39;&amp;',
    )
  })

  it('escapeMarkdown rend inerte tout ce qui a un sens en Markdown ou en HTML', () => {
    const out = escapeMarkdown('[lien](http://x) <script> `code` **gras** | # &')
    expect(out).not.toMatch(/(^|[^\\])[[\]<>`*|#]/)
    expect(out).toContain('&amp;')
  })

  it('markdownCode ne peut pas être refermé par son contenu', () => {
    expect(markdownCode('a`b')).toBe('``a`b``')
    expect(markdownCode('`x`')).toBe('`` `x` ``')
  })

  it('markdownBlock ne peut pas être refermé par son contenu', () => {
    const block = markdownBlock('``` fin ```\n# titre')
    expect(block.startsWith('````')).toBe(true)
    expect(block.endsWith('````')).toBe(true)
  })
})

describe('parseSiteUrl', () => {
  it('accepte http et https', () => {
    expect(parseSiteUrl('https://exemple.fr/x#frag').href).toBe('https://exemple.fr/x')
    expect(parseSiteUrl('http://localhost:3000').origin).toBe('http://localhost:3000')
  })

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,x',
    'chrome://settings',
    'ftp://x',
  ])('refuse %s', (url) => {
    expect(() => parseSiteUrl(url)).toThrow(UserError)
  })

  it('refuse les identifiants dans l’adresse', () => {
    expect(() => parseSiteUrl('https://user:secret@exemple.fr')).toThrow(/Identifiants/)
  })

  it('refuse le texte qui n’est pas une URL', () => {
    expect(() => parseSiteUrl('pas une url')).toThrow(UserError)
  })
})

describe('resolvePageUrl', () => {
  const base = new URL('https://exemple.fr')
  it('résout un chemin sur le site', () => {
    expect(resolvePageUrl(base, '/contact').href).toBe('https://exemple.fr/contact')
  })
  it('refuse une page d’un autre site', () => {
    expect(() => resolvePageUrl(base, 'https://autre.fr/x')).toThrow(/n'est pas sur le site/)
    expect(() => resolvePageUrl(base, '//autre.fr/x')).toThrow(/n'est pas sur le site/)
  })
  it('canonicalPath retire la barre finale', () => {
    expect(canonicalPath(new URL('https://x.fr/a/b/'))).toBe('/a/b')
    expect(canonicalPath(new URL('https://x.fr/'))).toBe('/')
  })
})

describe('chemins et fichiers', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rgaa-sec-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('isSafeSegment accepte les sujets réels, accents compris', () => {
    for (const ok of ['image.alt', 'form.button.symbol', 'presentation.forme.média-temporel']) {
      expect(isSafeSegment(ok)).toBe(true)
    }
  })

  it.each([
    '',
    '..',
    '../x',
    'a/b',
    'a\\b',
    '.cache',
    '-x',
    'a..b',
    'a b',
    'a\u0000b',
    'x'.repeat(200),
  ])('isSafeSegment refuse %j', (value) => {
    expect(isSafeSegment(value)).toBe(false)
  })

  it('assertSafeSegment lève une UserError claire', () => {
    expect(() => assertSafeSegment('../../etc', 'Sujet')).toThrow(/Sujet invalide/)
  })

  it('containedPath garde le résultat dans le dossier', () => {
    expect(containedPath(dir, 'a', 'b.json')).toBe(join(dir, 'a', 'b.json'))
    expect(() => containedPath(dir, '..', 'x')).toThrow(/sort du dossier/)
    expect(() => containedPath(dir, '/etc/passwd')).toThrow(/sort du dossier/)
    expect(() => containedPath(dir, 'a/../../x')).toThrow(/sort du dossier/)
  })

  it('readTextFile refuse un fichier trop gros, un dossier, un fichier absent', () => {
    const file = join(dir, 'gros.txt')
    writeFileSync(file, 'x'.repeat(2_000))
    expect(() => readTextFile(file, 1_000)).toThrow(/trop volumineux/)
    expect(() => readTextFile(dir)).toThrow(/pas un fichier/)
    expect(() => readTextFile(join(dir, 'absent'))).toThrow(/introuvable/)
  })

  it('readTextFile refuse un lien symbolique', () => {
    const target = join(dir, 'cible.txt')
    writeFileSync(target, 'secret')
    const link = join(dir, 'lien.txt')
    symlinkSync(target, link)
    expect(() => readTextFile(link)).toThrow(/pas un fichier ordinaire/)
  })

  it('readJsonFile nomme le fichier en cas de JSON invalide', () => {
    const file = join(dir, 'x.json')
    writeFileSync(file, '{pas du json')
    expect(() => readJsonFile(file)).toThrow(/x\.json n'est pas un JSON valide/)
  })

  it('writeFileAtomic écrit, remplace, et ne laisse aucun fichier temporaire', () => {
    const file = join(dir, 'sous', 'rapport.json')
    writeFileAtomic(file, 'un')
    writeFileAtomic(file, 'deux')
    expect(readFileSync(file, 'utf8')).toBe('deux')
    expect(readdirSync(join(dir, 'sous'))).toEqual(['rapport.json'])
  })

  it('writeFileAtomic n’écrit pas au travers d’un lien symbolique', () => {
    const target = join(dir, 'cible.txt')
    writeFileSync(target, 'intact')
    const link = join(dir, 'lien.txt')
    symlinkSync(target, link)
    writeFileAtomic(link, 'nouveau')
    expect(readFileSync(target, 'utf8')).toBe('intact')
    expect(readFileSync(link, 'utf8')).toBe('nouveau')
  })

  it('writeFileAtomic crée les dossiers manquants', () => {
    mkdirSync(join(dir, 'a'))
    writeFileAtomic(join(dir, 'a', 'b', 'c.txt'), 'x')
    expect(readFileSync(join(dir, 'a', 'b', 'c.txt'), 'utf8')).toBe('x')
  })
})

describe('Reader', () => {
  const read = new Reader('test.json')

  it('refuse un type inattendu avec le chemin du champ', () => {
    expect(() => read.string(12, 'a.b')).toThrow(/test\.json : a\.b doit être une chaîne/)
    expect(() => read.record([], 'x')).toThrow(/doit être un objet/)
    expect(() => read.number(Number.NaN, 'n')).toThrow(/doit être un nombre/)
  })

  it('plafonne la taille des chaînes et des listes', () => {
    expect(() => read.string('x'.repeat(11), 's', 10)).toThrow(/trop long/)
    expect(() => read.array([1, 2, 3], 'l', 2)).toThrow(/trop d'éléments/)
  })

  it('stringMap refuse les clés de pollution de prototype et ne pollue rien', () => {
    const hostile = JSON.parse('{"__proto__": "x"}')
    expect(() => read.stringMap(hostile, 'e')).toThrow(/clé interdite/)
    expect(() => read.stringMap(JSON.parse('{"constructor":"x"}'), 'e')).toThrow(/clé interdite/)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('oneOf et matching valident', () => {
    expect(read.oneOf('C', ['C', 'NC'] as const, 's')).toBe('C')
    expect(() => read.oneOf('Z', ['C', 'NC'] as const, 's')).toThrow(/doit valoir/)
    expect(() => read.matching('zz', /^[0-9a-f]{12}$/, 'k', 'empreinte')).toThrow(/invalide/)
  })
})
