"""
Régénère `assets/rgaa-4.1.2.json` : les 258 tests du RGAA 4.1.2, avec l'intitulé complet du
test (conditions comprises), le critère, le niveau, les cas particuliers et les notes techniques.

    python3 -I scripts/build-catalog.py RGAA-v4.1.2.odt

Source : le référentiel officiel au format ODT (https://accessibilite.numerique.gouv.fr/),
sous licence ouverte 2.0. L'ODT est lu avec la seule bibliothèque standard (c'est une archive
zip contenant `content.xml`). Le catalogue est versionné : l'outil ne dépend pas de l'ODT.
"""

import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

NS = {
    'text': 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
}
TEXT = '{%s}' % NS['text']
MAX_CONTENT_BYTES = 50 * 1024 * 1024  # un ODT de 175 Ko contient un content.xml de quelques Mo

# Critères de niveau AA (tous les autres sont de niveau A). Le niveau est une propriété du
# critère dans le RGAA (`criteres.json`) : l'ODT ne le dit pas, et on ne peut pas le déduire des
# références WCAG (le critère 11.4 est AA alors que ses références sont toutes de niveau A).
# Table recoupée avec la colonne « Niveau » d'un export Asqatasun : 256 tests comparés, 0 écart.
AA_CRITERIA = frozenset(
    {
        '1.8', '3.2', '3.3', '4.5', '4.6', '7.5', '8.7', '8.8', '10.4', '10.5', '10.11', '10.12',
        '10.13', '11.3', '11.4', '11.11', '11.12', '11.13', '12.1', '12.2', '12.3', '12.4', '12.5',
        '13.9',
    }
)


def paragraph_text(element: ElementTree.Element) -> str:
    """Texte d'un paragraphe, espaces et sauts de ligne ODT compris."""
    parts: list[str] = []

    def walk(node: ElementTree.Element) -> None:
        if node.text:
            parts.append(node.text)
        for child in node:
            if child.tag == TEXT + 's':  # <text:s text:c="n"/> : n espaces
                parts.append(' ' * int(child.get(TEXT + 'c', '1')))
            elif child.tag in (TEXT + 'tab', TEXT + 'line-break'):
                parts.append(' ')
            else:
                walk(child)
            if child.tail:
                parts.append(child.tail)

    walk(element)
    return re.sub(r'\s+', ' ', ''.join(parts)).strip()


def read_paragraphs(odt: Path) -> list[tuple[str, bool]]:
    """Paragraphes dans l'ordre du document, avec « fait partie d'une liste à puces »."""
    with zipfile.ZipFile(odt) as archive:
        info = archive.getinfo('content.xml')
        if info.file_size > MAX_CONTENT_BYTES:
            sys.exit('content.xml anormalement volumineux : fichier refusé.')
        root = ElementTree.fromstring(archive.read('content.xml'))

    found: list[tuple[str, bool]] = []

    def collect(node: ElementTree.Element, in_list: bool) -> None:
        for child in node:
            if child.tag in (TEXT + 'p', TEXT + 'h'):
                text = paragraph_text(child)
                if text:
                    found.append((text, in_list))
            else:
                collect(child, in_list or child.tag == TEXT + 'list-item')

    collect(root, False)
    return found


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit('Usage : build-catalog.py <RGAA-v4.1.2.odt>')
    paragraphs = read_paragraphs(Path(sys.argv[1]))
    lines = [text for text, _ in paragraphs]

    try:
        start = lines.index('Critères de contrôle du RGAA')
        end = lines.index('RGAA – Glossaire', start)
    except ValueError:
        sys.exit("Structure inattendue : « Critères de contrôle du RGAA » ou « RGAA – Glossaire » introuvable.")
    body = paragraphs[start + 1 : end]

    themes: dict[int, str] = {}
    tests: list[dict] = []

    criterion: dict | None = None  # critère en cours : id, titre, tests, sections
    section = 'tests'

    def close_criterion() -> None:
        if criterion is None:
            return
        level = 'AA' if criterion['id'] in AA_CRITERIA else 'A'
        cases = ' '.join(criterion['cases'])
        notes = ' '.join(criterion['notes'])
        for entry in criterion['tests']:
            conditions = entry.pop('conditions')
            title = entry.pop('head')
            if conditions:
                title = f'{title} • ' + ' • '.join(conditions)
            tests.append(
                {
                    'theme': criterion['theme'],
                    'themeLabel': themes[criterion['theme']],
                    'criterion': criterion['id'],
                    'criterionTitle': criterion['title'],
                    'test': entry['test'],
                    'level': level,
                    'title': title,
                    'particularCases': cases,
                    'technicalNotes': notes,
                }
            )

    for line, bullet in body:
        theme = re.fullmatch(r'(\d{1,2})\. (.+)', line)
        if theme and int(theme.group(1)) == len(themes) + 1:
            close_criterion()
            criterion = None
            themes[int(theme.group(1))] = theme.group(2).strip()
            continue
        head = re.fullmatch(r'Critère (\d{1,2})\.(\d{1,2}) (.+)', line)
        if head:
            close_criterion()
            criterion = {
                'theme': int(head.group(1)),
                'id': f'{head.group(1)}.{head.group(2)}',
                'title': head.group(3).strip(),
                'tests': [],
                'cases': [],
                'notes': [],
            }
            section = 'tests'
            continue
        if criterion is None:
            continue
        test = re.fullmatch(r'Test (\d{1,2}\.\d{1,2}\.\d{1,2}) : (.+)', line)
        if test:
            criterion['tests'].append({'test': test.group(1), 'head': test.group(2).strip(), 'conditions': []})
            section = 'tests'
        elif line in ('Cas particulier', 'Cas particuliers'):
            section = 'cases'
        elif line in ('Note technique', 'Notes techniques'):
            section = 'notes'
        elif line == 'Références':
            section = 'refs'  # références WCAG / EN 301 549 : non reprises dans le catalogue
        elif section == 'tests':
            if not criterion['tests']:
                sys.exit(f'Ligne inattendue avant le premier test de {criterion["id"]} : {line[:80]!r}')
            criterion['tests'][-1]['conditions'].append(line)
        elif section in ('cases', 'notes'):
            criterion[section].append(('• ' if bullet else '') + line)
    close_criterion()

    ids = [t['test'] for t in tests]
    if len(ids) != len(set(ids)):
        sys.exit('Identifiants de test en double.')
    if len(themes) != 13:
        sys.exit(f'13 thématiques attendues, {len(themes)} trouvées.')

    out = Path(__file__).resolve().parent.parent / 'assets' / 'rgaa-4.1.2.json'
    out.write_text(json.dumps(tests, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{len(tests)} tests, {len({t["criterion"] for t in tests})} critères, {len(themes)} thématiques écrits dans {out}')


main()
