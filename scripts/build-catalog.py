"""
Régénère `src/data/rgaa-4.1.2.json` : les 258 tests du RGAA 4.1.2, avec l'intitulé
complet du test, le critère, le niveau, les cas particuliers et les notes techniques.

    uv run --with pypdf python -I scripts/build-catalog.py "<RGAA-v4.1.2.pdf>"

Source : le référentiel officiel (https://accessibilite.numerique.gouv.fr/).
Le catalogue est versionné : l'outil ne dépend pas du PDF.
"""
import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader

source = sys.argv[1] if len(sys.argv) > 1 else None
if not source:
    sys.exit('Usage : build-catalog.py <RGAA-v4.1.2.pdf>')

pages = [(p.extract_text() or '') for p in PdfReader(source).pages]
text = '\n'.join(pages)
text = re.sub(r'RGAA 4\.1\.2 – \d+/\d+', '', text)
start = text.index('2.2 Critères de contrôle du RGAA')
end = text.index('\n2.3 RGAA – Glossaire', start)
body = text[start:end]

# Les thématiques 10 à 13 sont collées au numéro de section (« 2.2.1010. Présentation… ») :
# on les prend dans l'ordre, la n-ième est la thématique n.
theme_re = re.compile(r'^2\.2\.\d+\s*\d+\. (.+)$', re.M)
themes = {i + 1: m.group(1).strip() for i, m in enumerate(theme_re.finditer(body))}

# Découpe : un bloc par critère.
parts = re.split(r'^(?=Critère \d+\.\d+ )', body, flags=re.M)[1:]
tests = []
for part in parts:
    # Le dernier critère d'une thématique est suivi de l'intitulé de la suivante.
    part = theme_re.split(part)[0]
    head = re.match(r'Critère (\d+)\.(\d+) (.*?)(?=\n• Test )', part, re.S)
    if not head:
        raise SystemExit(f'Critère illisible : {part[:80]!r}')
    theme, number = int(head.group(1)), f'{head.group(1)}.{head.group(2)}'
    title = ' '.join(head.group(3).split())

    rest = part[head.end():]
    tail = re.search(r'^(Cas particuliers?|Notes? techniques?|Références)\s*$', rest, re.M)
    tests_text = rest[: tail.start()] if tail else rest
    after = rest[tail.start():] if tail else ''

    def section(name_re: str) -> str:
        m = re.search(rf'^{name_re}\s*$\n(.*?)(?=^(?:Cas particuliers?|Notes? techniques?|Références|Notes? de ce critère)\s*$|\Z)', after, re.S | re.M)
        return ' '.join(m.group(1).split()) if m else ''

    refs = section('Références')
    level = 'AA' if re.search(r'\(AA\)', refs) else ('AAA' if '(AAA)' in refs else 'A')

    for chunk in re.split(r'^• (?=Test \d+\.\d+\.\d+ :)', tests_text, flags=re.M)[1:]:
        m = re.match(r'Test (\d+\.\d+\.\d+) : (.*)', chunk, re.S)
        lines = [ln.strip() for ln in m.group(2).strip().splitlines() if ln.strip()]
        merged = ' '.join(lines)
        merged = re.sub(r' ◦ ', ' • ', merged)
        tests.append({
            'theme': theme,
            'themeLabel': themes[theme],
            'criterion': number,
            'criterionTitle': title,
            'test': m.group(1),
            'level': level,
            'title': merged,
            'particularCases': section('Cas particuliers?'),
            'technicalNotes': section('Notes? techniques?'),
        })

out = Path(__file__).resolve().parent.parent / 'src' / 'data' / 'rgaa-4.1.2.json'
out.write_text(json.dumps(tests, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{len(tests)} tests, {len({t["criterion"] for t in tests})} critères écrits dans {out}')
