import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { disagrees, mergeStatus, parseAsqatasunReport } from '../../src/core/asqatasun.ts'
import { browserEnvironment } from '../../src/core/browser.ts'
import {
  compareIds,
  criterionOf,
  loadCatalog,
  parseCatalog,
  themeOf,
} from '../../src/core/catalog.ts'
import { parseCsv } from '../../src/core/csv.ts'
import { DecisionStore, judgementKey } from '../../src/core/decisions.ts'
import { redirectedAway } from '../../src/core/runner.ts'
import { discoverPages, extractLocations, isSitemapIndex } from '../../src/core/sitemap.ts'

describe('judgementKey', () => {
  it('est stable : insensible à l’ordre des clés et aux espaces', () => {
    const a = judgementKey('image.alt', { alt: 'Une  image', src: '/a.png' })
    const b = judgementKey('image.alt', { src: '/a.png', alt: ' Une image ' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
  })
  it('change avec le contenu et avec le sujet', () => {
    const base = judgementKey('image.alt', { alt: 'x' })
    expect(judgementKey('image.alt', { alt: 'y' })).not.toBe(base)
    expect(judgementKey('frame.title', { alt: 'x' })).not.toBe(base)
  })
})

describe('DecisionStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rgaa-dec-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const decision = {
    answer: 'pass',
    evidence: { title: 'Carte' },
    question: 'Pertinent ?',
    reason: 'Décrit le cadre',
    by: 'humain',
    date: '2026-11-17',
  }

  it('enregistre, relit et trie les décisions', () => {
    const store = new DecisionStore(join(dir, 'decisions'))
    store.set('frame.title', 'bbbbbbbbbbbb', decision)
    store.set('frame.title', 'aaaaaaaaaaaa', decision)
    const reread = new DecisionStore(join(dir, 'decisions'))
    expect(reread.size).toBe(2)
    expect(reread.get('frame.title', 'aaaaaaaaaaaa')?.answer).toBe('pass')
    const file = readFileSync(join(dir, 'decisions', 'frame.title.json'), 'utf8')
    expect(file.indexOf('aaaaaaaaaaaa')).toBeLessThan(file.indexOf('bbbbbbbbbbbb'))
  })

  it('signale les décisions jamais sollicitées', () => {
    const store = new DecisionStore(join(dir, 'decisions'))
    store.set('frame.title', 'aaaaaaaaaaaa', decision)
    store.set('frame.title', 'bbbbbbbbbbbb', decision)
    const fresh = new DecisionStore(join(dir, 'decisions'))
    fresh.get('frame.title', 'aaaaaaaaaaaa')
    expect(fresh.unused().map((entry) => entry.key)).toEqual(['bbbbbbbbbbbb'])
  })

  it('refuse un sujet qui sortirait du dossier', () => {
    const store = new DecisionStore(join(dir, 'decisions'))
    expect(() => store.set('../evil', 'aaaaaaaaaaaa', decision)).toThrow(
      /Sujet de décision invalide/,
    )
  })

  it('refuse une empreinte mal formée', () => {
    const store = new DecisionStore(join(dir, 'decisions'))
    expect(() => store.set('frame.title', '../../x', decision)).toThrow(/empreinte invalide/)
  })

  it('arrête l’outil sur un fichier mal formé au lieu de l’ignorer', () => {
    const folder = join(dir, 'decisions')
    new DecisionStore(folder).set('frame.title', 'aaaaaaaaaaaa', decision)
    writeFileSync(
      join(folder, 'frame.title.json'),
      '{"topic":"frame.title","entries":{"aaaaaaaaaaaa":{"answer":3}}}',
    )
    expect(() => new DecisionStore(folder)).toThrow(/answer doit être une chaîne/)
  })

  it('refuse un fichier dont le sujet ne correspond pas au nom', () => {
    const folder = join(dir, 'decisions')
    new DecisionStore(folder).set('frame.title', 'aaaaaaaaaaaa', decision)
    writeFileSync(join(folder, 'image.alt.json'), readFileSync(join(folder, 'frame.title.json')))
    expect(() => new DecisionStore(folder)).toThrow(/ne correspond pas au nom du fichier/)
  })

  it('refuse un fichier avec une clé de pollution de prototype', () => {
    const folder = join(dir, 'decisions')
    mkdirSync(folder)
    writeFileSync(
      join(folder, 'x.json'),
      '{"topic":"x","entries":{"aaaaaaaaaaaa":{"answer":"pass","evidence":{"__proto__":"y"},"question":"q","reason":"r","by":"b","date":"2026-01-01"}}}',
    )
    expect(() => new DecisionStore(folder)).toThrow(/clé interdite/)
  })
})

describe('catalogue RGAA', () => {
  it('se charge et s’indexe', () => {
    const catalog = loadCatalog()
    expect(catalog.byTest.get('1.1.1')?.criterion).toBe('1.1')
    expect(catalog.criteria.get('1.1')?.title).toMatch(/alternative textuelle/)
    expect(catalog.themes.get(11)).toBe('Formulaires')
  })
  it('refuse un test en double ou un identifiant mal formé', () => {
    const entry = {
      theme: 1,
      themeLabel: 'Images',
      criterion: '1.1',
      test: '1.1.1',
      level: 'A',
      title: 't',
    }
    expect(() => parseCatalog([entry, entry])).toThrow(/en double/)
    expect(() => parseCatalog([{ ...entry, test: 'abc' }])).toThrow(/invalide/)
    expect(() => parseCatalog({})).toThrow(/doit être une liste/)
  })
  it('ordonne naturellement les identifiants', () => {
    expect(['1.10.1', '1.9.2', '1.9.10', '10.1.1', '2.1.1'].sort(compareIds)).toEqual([
      '1.9.2',
      '1.9.10',
      '1.10.1',
      '2.1.1',
      '10.1.1',
    ])
    expect(criterionOf('10.7.1')).toBe('10.7')
    expect(themeOf('10.7.1')).toBe(10)
  })
})

describe('parseCsv', () => {
  it('gère guillemets doublés, virgules et retours à la ligne dans les champs', () => {
    expect(parseCsv('a,"b ""c"", d","e\nf"\r\ng,h')).toEqual([
      ['a', 'b "c", d', 'e\nf'],
      ['g', 'h'],
    ])
  })
})

describe('export Asqatasun', () => {
  const csv = [
    'Audit du 16 novembre 2026 sur la page http://nimes.test/contact/,,,,,,',
    'Note : 87%  -  Référentiel : RGAA 4.0  -  Niveau : AA,,,,,,',
    'Thématique,Critère,Test,Intitulé du test,Niveau,Résultat,Détails',
    'Images,1.1,1.1.1,x,A,Non-conforme,d',
    'Images,1.1,1.1.2,x,A,Pré-qualifié,d',
    'Présentation,10.4,10.4.1,x,AA,Conforme,d',
    'Présentation,10.4,10.4.2,x,AA,Non-conforme,d',
    'Présentation,10.4,10.4.3,x,AA,Conforme,d',
    'Bidon,1.1,__proto__,x,A,Conforme,d',
  ].join('\n')

  it('extrait page, note et verdicts, avec la renumérotation 4.0 → 4.1.2', () => {
    const report = parseAsqatasunReport('Report_12.csv', csv)
    expect(report?.path).toBe('/contact')
    expect(report?.number).toBe(12)
    expect(report?.score).toBe('87%')
    expect(report?.results['1.1.1']).toBe('NC')
    expect(report?.results['1.1.2']).toBe('PQ')
    // 10.4.1 supprimé ; 10.4.2 → 10.4.1 ; 10.4.3 → 10.4.2
    expect(report?.results['10.4.1']).toBe('NC')
    expect(report?.results['10.4.2']).toBe('C')
  })

  it('ignore les identifiants de test invalides et ne pollue pas le prototype', () => {
    const report = parseAsqatasunReport('Report_1.csv', csv)
    expect(Object.keys(report?.results ?? {})).not.toContain('__proto__')
    expect(({} as Record<string, unknown>).C).toBeUndefined()
  })

  it('renvoie null pour un fichier qui n’est pas un export', () => {
    expect(parseAsqatasunReport('Report_1.csv', 'rien\nà voir')).toBeNull()
  })

  it('mergeStatus garde le plus sévère ; disagrees ne compare que les verdicts fermes', () => {
    expect(mergeStatus('C', 'NC')).toBe('NC')
    expect(mergeStatus('AV', 'C')).toBe('AV')
    expect(mergeStatus('C', undefined)).toBe('C')
    expect(disagrees('C', 'NC')).toBe(true)
    expect(disagrees('AV', 'NC')).toBe(false)
    expect(disagrees('C', 'PQ')).toBe(false)
  })
})

describe('sitemap', () => {
  it('extrait les <loc>, CDATA et entités compris', () => {
    const xml = `<urlset><url><loc>https://x.fr/a?x=1&amp;y=2</loc></url><url><loc><![CDATA[https://x.fr/b]]></loc></url></urlset>`
    expect(extractLocations(xml)).toEqual(['https://x.fr/a?x=1&y=2', 'https://x.fr/b'])
    expect(isSitemapIndex('<sitemapindex>')).toBe(true)
    expect(isSitemapIndex(xml)).toBe(false)
  })

  const fakeFetch = (bodies: Record<string, string>) =>
    (async (input: URL | string) => {
      const path = new URL(String(input)).pathname
      const body = bodies[path]
      return body === undefined
        ? new Response('', { status: 404 })
        : new Response(body, { status: 200 })
    }) as typeof fetch

  it('ne garde que les chemins et ramène tout sur le site audité', async () => {
    const base = new URL('http://localhost:3000')
    const xml = `<urlset>
      <url><loc>https://prod.exemple.fr/contact/</loc></url>
      <url><loc>https://prod.exemple.fr/a-propos</loc></url>
      <url><loc>//evil.example/piege</loc></url></urlset>`
    const found = await discoverPages(base, [], {
      maxPages: 100,
      fetch: fakeFetch({ '/sitemap.xml': xml }),
    })
    expect(found.urls.every((url) => url.startsWith('http://localhost:3000/'))).toBe(true)
    expect(found.urls).toContain('http://localhost:3000/contact')
    expect(found.urls).toContain('http://localhost:3000/a-propos')
    expect(found.urls).toContain('http://localhost:3000/')
  })

  it('applique le plafond de pages et le signale', async () => {
    const base = new URL('http://localhost:3000')
    const xml = `<urlset>${Array.from({ length: 10 }, (_, i) => `<url><loc>/p${i}</loc></url>`).join('')}</urlset>`
    const found = await discoverPages(base, [], {
      maxPages: 3,
      fetch: fakeFetch({ '/sitemap.xml': xml }),
    })
    expect(found.urls).toHaveLength(3)
    expect(found.dropped).toBe(8)
  })

  it('suit un index de sitemaps, sur le site audité seulement', async () => {
    const base = new URL('http://localhost:3000')
    const found = await discoverPages(base, [], {
      maxPages: 100,
      fetch: fakeFetch({
        '/sitemap.xml':
          '<sitemapindex><sitemap><loc>https://prod.fr/s1.xml</loc></sitemap></sitemapindex>',
        '/s1.xml': '<urlset><url><loc>https://prod.fr/x</loc></url></urlset>',
      }),
    })
    expect(found.urls).toContain('http://localhost:3000/x')
  })

  it('refuse un sitemap absent avec un message qui dit quoi faire', async () => {
    await expect(
      discoverPages(new URL('http://localhost:3000'), [], { maxPages: 5, fetch: fakeFetch({}) }),
    ).rejects.toThrow(/donner les chemins/)
  })

  const site = (pages: Record<string, string>, extra: Record<string, () => Response> = {}) =>
    (async (input: URL | string) => {
      const url = new URL(String(input))
      const key = `${url.pathname}${url.search}`
      const other = extra[key]
      if (other) return other()
      const body = pages[url.pathname]
      return body === undefined
        ? new Response('introuvable', { status: 404 })
        : new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
    }) as typeof fetch
  const links = (...hrefs: string[]) =>
    `<html><body>${hrefs.map((href) => `<a href="${href}">x</a>`).join('')}</body></html>`

  it('sans sitemap, suit les liens internes depuis l’adresse donnée', async () => {
    const found = await discoverPages(new URL('http://localhost:3000/'), [], {
      maxPages: 50,
      fetch: site({
        '/': links(
          '/a',
          '/b/',
          'https://autre.fr/x',
          'mailto:a@b.fr',
          '/doc.pdf',
          '#haut',
          '/a?x=1',
        ),
        '/a': links('/c', '/'),
        '/b': links('/a'),
        '/c': links(),
        '/doc.pdf': '%PDF',
      }),
    })
    expect(found.via).toBe('liens')
    expect(found.urls).toEqual([
      'http://localhost:3000/',
      'http://localhost:3000/a',
      'http://localhost:3000/b',
      'http://localhost:3000/c',
    ])
  })

  it('reste dans la partie du site donnée (/fr/) et applique le plafond', async () => {
    const pages = {
      '/fr': links('/fr/a', '/en/a', '/fr/b', '/fr/c'),
      '/fr/a': links(),
      '/fr/b': links(),
      '/fr/c': links(),
      '/en/a': links(),
    }
    const found = await discoverPages(new URL('http://localhost:3000/fr/'), [], {
      maxPages: 50,
      fetch: site(pages),
    })
    expect(found.urls).toEqual([
      'http://localhost:3000/fr',
      'http://localhost:3000/fr/a',
      'http://localhost:3000/fr/b',
      'http://localhost:3000/fr/c',
    ])
    const capped = await discoverPages(new URL('http://localhost:3000/fr/'), [], {
      maxPages: 2,
      fetch: site(pages),
    })
    expect(capped.urls).toHaveLength(2)
    expect(capped.dropped).toBeGreaterThan(0)
  })

  it('ignore les pages qui ne sont pas du HTML', async () => {
    const found = await discoverPages(new URL('http://localhost:3000/'), [], {
      maxPages: 10,
      fetch: site(
        { '/': links('/json', '/ok'), '/ok': links() },
        {
          '/json': () =>
            new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
        },
      ),
    })
    expect(found.urls).toEqual(['http://localhost:3000/', 'http://localhost:3000/ok'])
  })

  it('un « sitemap » qui est une page HTML n’en est pas un ; robots.txt est lu avec sa requête', async () => {
    const urlset = '<urlset><url><loc>https://prod.fr/vrai</loc></url></urlset>'
    const found = await discoverPages(new URL('http://localhost:3000/'), [], {
      maxPages: 10,
      fetch: site(
        { '/sitemap.xml': '<html>accueil</html>', '/': links('/a'), '/a': links() },
        {
          '/robots.txt': () => new Response('Sitemap: /th/?sitemap.xml', { status: 200 }),
          '/th/?sitemap.xml': () => new Response(urlset, { status: 200 }),
        },
      ),
    })
    expect(found.via).toBe('sitemap')
    expect(found.urls).toContain('http://localhost:3000/vrai')
    // Sans le sitemap de robots.txt, c'est l'exploration des liens qui prend le relais.
    const crawled = await discoverPages(new URL('http://localhost:3000/'), [], {
      maxPages: 10,
      fetch: site({ '/sitemap.xml': '<html>accueil</html>', '/': links('/a'), '/a': links() }),
    })
    expect(crawled.via).toBe('liens')
    expect(crawled.urls).toEqual(['http://localhost:3000/', 'http://localhost:3000/a'])
  })

  it('refuse un sitemap trop volumineux', async () => {
    const big = `<urlset>${'x'.repeat(5_000)}</urlset>`
    await expect(
      discoverPages(new URL('http://localhost:3000'), [], {
        maxPages: 5,
        maxBytes: 1_000,
        fetch: fakeFetch({ '/sitemap.xml': big }),
      }),
    ).rejects.toThrow(/trop volumineux/)
  })

  it('les chemins donnés en arguments restent sur le site', async () => {
    const base = new URL('http://localhost:3000')
    const found = await discoverPages(base, ['/a', '/a'], { maxPages: 5 })
    expect(found.urls).toEqual(['http://localhost:3000/a'])
    await expect(discoverPages(base, ['https://autre.fr/'], { maxPages: 5 })).rejects.toThrow(
      /n'est pas sur le site/,
    )
  })
})

describe('environnement du navigateur', () => {
  it('ne transmet aucun secret', () => {
    const env = browserEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'fr_FR.UTF-8',
      GITHUB_TOKEN: 'ghp_secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      ANTHROPIC_API_KEY: 'sk-secret',
      NPM_TOKEN: 'secret',
    })
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH'])
  })
  it('ajoute les bibliothèques en tête du LD_LIBRARY_PATH', () => {
    const env = browserEnvironment({ LD_LIBRARY_PATH: '/a' }, '/libs')
    expect(env.LD_LIBRARY_PATH).toBe('/libs:/a')
  })
})

describe('redirectedAway', () => {
  it('ne signale ni la barre finale ni l’absence de redirection', () => {
    expect(redirectedAway('https://a.fr/compte', 'https://a.fr/compte')).toBeUndefined()
    expect(redirectedAway('https://a.fr/compte', 'https://a.fr/compte/')).toBeUndefined()
    expect(redirectedAway('https://a.fr/', 'https://a.fr')).toBeUndefined()
  })
  it('signale une autre page ou un autre site (connexion, SSO)', () => {
    expect(redirectedAway('https://a.fr/compte', 'https://a.fr/connexion?next=%2Fcompte')).toBe(
      '/connexion',
    )
    expect(redirectedAway('https://a.fr/compte', 'https://sso.example/login')).toBe(
      'https://sso.example/login',
    )
  })
})
