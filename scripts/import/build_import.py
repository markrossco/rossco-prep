#!/usr/bin/env python3
"""Builds the CurrentRMS import SQL files from the CSV exports.

Usage:  python3 scripts/import/build_import.py <folder with the CSV exports> [output folder]

The output (default: import-data/) holds real customer and equipment data. It is ignored by git
and must never be committed. Each generated file is safe to run once, and re-running a file does
not duplicate anything.

Rules (agreed with Mark):
- Quantities come from the stock records, not the product page.
- Products with no stock records load as owned 0 (sub-hire only).
- Products with no stock method: kits if they have contents, otherwise consumables.
- Switched-off products load as inactive, with their stock kept.
- Accessory links: quantity 0 becomes 1.
- Duplicate organisations and venues are merged (the active, most complete record wins).
  "Test Organisation" is dropped. Contacts load as they are.
- Product pictures are not imported (the export links expire).
"""
import csv
import glob
import os
import re
import sys
from collections import defaultdict


def load(folder, pattern):
    files = sorted(glob.glob(os.path.join(folder, pattern)))
    if not files:
        sys.exit(f'No file matching {pattern} in {folder}')
    with open(files[-1], encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def q(s):
    return 'null' if s is None else "'" + str(s).replace("'", "''") + "'"


def clean(s):
    return re.sub(r'\s+', ' ', (s or '')).strip()


DEPTS = {
    'Audio': 'Audio', 'Video': 'Video', 'IT': 'IT', 'Power': 'Power', 'Backline': 'Backline',
    'Set': 'Set', 'Lighting': 'Lighting', 'Rigging': 'Rigging', 'Cases': 'Cases',
    'Tools': 'Tools and consumables',
}


def parse_group(group):
    m = re.match(r'^(\d)\s*-\s*(.*)$', group.strip())
    if not m:
        return 'Tools and consumables', 'General'
    rest = m.group(2).strip()
    first = re.split(r'\s*-\s*|,|\s', rest, maxsplit=1)[0]
    dept = DEPTS.get(first, 'Tools and consumables')
    sub = rest.split(' - ', 1)[1].strip() if ' - ' in rest else 'General'
    return dept, clean(sub) or 'General'


def num(s, default=0.0):
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', '..', 'import-data')
    os.makedirs(out, exist_ok=True)

    products = load(src, '*Product-*.csv')
    stock = load(src, '*StockLevel-*.csv')
    access = load(src, '*Accessory-*.csv')
    orgs = load(src, '*Organisation-*.csv')
    contacts = load(src, '*Contact-*.csv')
    venues = load(src, '*Venue-*.csv')
    report = []

    # ---- equipment types ---------------------------------------------------------------------
    by_name = {p['Name']: p for p in products}
    parents = {a['Product'] for a in access}
    stock_by_product = defaultdict(list)
    for s in stock:
        stock_by_product[s['Product']].append(s)

    names_seen = {}
    for p in products:
        key = clean(p['Name']).lower()
        if key in names_seen:
            sys.exit(f"Duplicate product name after tidying: {p['Name']!r}")
        names_seen[key] = p['Id']

    cats = defaultdict(set)
    types = []
    for p in products:
        dept, cat = parse_group(p['Product Group'])
        cats[dept].add(cat)
        method = p['Stock Method']
        if method == 'None':
            kind = 'kit' if p['Name'] in parents else 'consumable'
        else:
            kind = 'stock'
        qty = 0
        if kind == 'stock':
            qty = int(sum(num(s['Current Balance']) for s in stock_by_product.get(p['Name'], [])))
        tags = [clean(t) for t in (p['Tags'] or '').split(',') if clean(t)]
        weight = num(p['Weight'])
        types.append(dict(
            cid=int(p['Id']), name=clean(p['Name']), kind=kind, dept=dept, cat=cat, tags=tags,
            active=p['Active'] == 'Yes', acc_only=p['Accessory Only'] == 'Yes',
            barcode=clean(p['Barcode']) or None, desc=(p['Description'] or '').strip() or None,
            weight=weight if weight > 0 else None, qty=qty))
    kind_of = {t['cid']: t['kind'] for t in types}
    cid_of = {p['Name']: int(p['Id']) for p in products}

    cat_rows = []
    for dept in sorted(cats):
        for i, cat in enumerate(sorted(cats[dept], key=lambda c: (c != 'General', c.lower()))):
            cat_rows.append((dept, cat, (i + 1) * 10))

    def type_row(t):
        tags = 'array[' + ', '.join(q(x) for x in t['tags']) + ']::text[]' if t['tags'] else "'{}'::text[]"
        return (
            f"  ({t['cid']}, {q(t['name'])}, {q(t['kind'])}, {q(t['dept'])}, {q(t['cat'])}, {tags}, "
            f"{'true' if t['active'] else 'false'}, {'true' if t['acc_only'] else 'false'}, {q(t['barcode'])}, "
            f"{q(t['desc'])}, {t['weight'] if t['weight'] is not None else 'null'}::numeric)")

    def types_insert(rows):
        lines = ['insert into public.equipment_types (name, kind, category_id, tags, active, accessory_only, barcode, description, weight_kg, currentrms_id)',
                 'select s.name, s.kind, c.id, s.tags, s.active, s.acc_only, s.barcode, s.descr, s.weight, s.cid from (values',
                 ',\n'.join(type_row(t) for t in rows),
                 ') s(cid, name, kind, dept, cat, tags, active, acc_only, barcode, descr, weight)',
                 'left join public.departments d on d.name = s.dept',
                 'left join public.categories c on c.department_id = d.id and c.name = s.cat',
                 'on conflict (currentrms_id) do nothing;']
        return lines

    half = len(types) // 2
    f1 = ['-- Equipment import, part 1 of 2: categories and the first half of the items. Safe to re-run.', 'begin;']
    f1.append('insert into public.categories (department_id, name, sort)\nselect d.id, v.cat, v.sort from (values')
    f1.append(',\n'.join(f'  ({q(d)}, {q(c)}, {s})' for d, c, s in cat_rows))
    f1.append(') v(dept, cat, sort) join public.departments d on d.name = v.dept\non conflict (department_id, name) do nothing;')
    f1.extend(types_insert(types[:half]))
    f1.append('commit;')
    open(os.path.join(out, 'import_1_equipment_a.sql'), 'w', encoding='utf-8').write('\n'.join(f1) + '\n')

    f1b = ['-- Equipment import, part 2 of 2: the rest of the items and the opening quantities. Run after part 1. Safe to re-run.', 'begin;']
    f1b.extend(types_insert(types[half:]))
    f1b.append("insert into public.stock_adjustments (type_id, delta, reason, note)")
    f1b.append("select t.id, v.qty, 'import', 'Opening balance from CurrentRMS' from (values")
    f1b.append(',\n'.join(f"  ({t['cid']}, {t['qty']})" for t in types if t['qty'] > 0))
    f1b.append(') v(cid, qty) join public.equipment_types t on t.currentrms_id = v.cid')
    f1b.append("where not exists (select 1 from public.stock_adjustments a where a.type_id = t.id and a.reason = 'import');")
    f1b.append('commit;')
    open(os.path.join(out, 'import_2_equipment_b.sql'), 'w', encoding='utf-8').write('\n'.join(f1b) + '\n')

    # ---- asset numbers and kit contents ------------------------------------------------------------
    assets = []
    for s in stock:
        if s['Asset Number'] and s['Asset Number'] != 'Bulk Stock':
            c = cid_of.get(s['Product'])
            if c and kind_of[c] == 'stock':
                assets.append((c, clean(s['Asset Number']), clean(s['Serial Number']) or None))
    asset_nos = [a[1] for a in assets]
    assert len(asset_nos) == len(set(asset_nos)), 'duplicate asset numbers'

    links = []
    for a in access:
        pc, cc = cid_of.get(a['Product']), cid_of.get(a['Accessory Product'])
        if pc is None or cc is None:
            continue
        inc = a['Inclusion Type'] if a['Inclusion Type'] in ('mandatory', 'default', 'optional') else 'optional'
        qty = int(num(a['Quantity'])) or 1
        links.append((pc, cc, inc, qty, int(num(a['Sort Order']))))

    f2 = ['-- Equipment import, part 3: asset numbers and kit contents. Run after parts 1 and 2. Safe to re-run.', 'begin;']
    f2.append('insert into public.asset_register (type_id, asset_no, serial_no)')
    f2.append('select t.id, v.asset_no, v.serial_no from (values')
    f2.append(',\n'.join(f"  ({c}, {q(n)}, {q(s)})" for c, n, s in assets))
    f2.append(') v(cid, asset_no, serial_no) join public.equipment_types t on t.currentrms_id = v.cid')
    f2.append('on conflict (asset_no) do nothing;')
    f2.append('insert into public.type_accessories (parent_type_id, child_type_id, inclusion, qty_per_parent, sort)')
    f2.append('select p.id, c.id, v.inclusion, v.qty, v.sort from (values')
    f2.append(',\n'.join(f"  ({p}, {c}, {q(i)}, {n}, {s})" for p, c, i, n, s in links))
    f2.append(') v(pcid, ccid, inclusion, qty, sort)')
    f2.append('join public.equipment_types p on p.currentrms_id = v.pcid')
    f2.append('join public.equipment_types c on c.currentrms_id = v.ccid')
    f2.append('on conflict (parent_type_id, child_type_id) do nothing;')
    f2.append('commit;')
    open(os.path.join(out, 'import_3_assets_and_kits.sql'), 'w', encoding='utf-8').write('\n'.join(f2) + '\n')

    # ---- organisations, venues, contacts -----------------------------------------------------------
    def best(group, score):
        return sorted(group, key=lambda r: (-score(r), int(r['Id'])))[0]

    org_groups = defaultdict(list)
    for o in orgs:
        key = clean(o['Name']).lower()
        if key == 'test organisation':
            continue
        org_groups[key].append(o)
    org_rows = []
    for g in org_groups.values():
        keep = best(g, lambda r: (r['Active'] == 'Yes') * 1000 + len(r['Work Email']) + len(r['Postcode']))
        active = any(r['Active'] == 'Yes' for r in g)
        org_rows.append((int(keep['Id']), clean(keep['Name']), active))

    ven_groups = defaultdict(list)
    for v in venues:
        name = clean(v['Name']).rstrip('\\').strip()
        ven_groups[name.lower()].append((name, v))
    ven_rows = []
    for g in ven_groups.values():
        name, keep = best([r for _, r in g], lambda r: len(r['Postcode'].strip()) * 3 + len(r['Street']) + len(r['City'])), None
        keep = name
        nm = [n for n, r in g if r is keep][0]
        ven_rows.append((int(keep['Id']), nm, clean(keep['Street']) or None, clean(keep['City']) or None,
                         clean(keep['Postcode']) or None, clean(keep['Country']) or None, keep['Active'] == 'Yes'))

    f3 = ['-- Customer import: organisations, venues and contacts. CONTAINS PERSONAL DATA. Never commit. Safe to re-run.', 'begin;']
    f3.append('insert into public.organisations (currentrms_id, name, is_client, active) values')
    f3.append(',\n'.join(f"  ({i}, {q(n)}, true, {'true' if a else 'false'})" for i, n, a in org_rows))
    f3.append('on conflict (currentrms_id) do nothing;')
    f3.append('insert into public.venues (currentrms_id, name, street, city, postcode, country, active) values')
    f3.append(',\n'.join(f"  ({i}, {q(n)}, {q(s)}, {q(c)}, {q(p)}, {q(co)}, {'true' if a else 'false'})" for i, n, s, c, p, co, a in ven_rows))
    f3.append('on conflict (currentrms_id) do nothing;')
    f3.append('insert into public.contacts (currentrms_id, name, work_phone, mobile, work_email, active, bookable_crew) values')
    f3.append(',\n'.join(
        f"  ({int(c['Id'])}, {q(clean(c['Name']))}, {q(clean(c['Work Telephone']) or None)}, {q(clean(c['Mobile Telephone']) or None)}, "
        f"{q(clean(c['Work Email']) or None)}, {'true' if c['Active'] == 'Yes' else 'false'}, {'true' if c['Bookable Resource'] == 'Yes' else 'false'})"
        for c in contacts))
    f3.append('on conflict (currentrms_id) do nothing;')
    f3.append('commit;')
    open(os.path.join(out, 'import_4_customers.sql'), 'w', encoding='utf-8').write('\n'.join(f3) + '\n')

    # ---- summary -------------------------------------------------------------------------------------
    kinds = defaultdict(int)
    for t in types:
        kinds[t['kind']] += 1
    summary = {
        'items': len(types), 'kinds': dict(kinds), 'categories': len(cat_rows),
        'units owned': sum(t['qty'] for t in types), 'items owned 0 (stock)': sum(1 for t in types if t['kind'] == 'stock' and t['qty'] == 0),
        'inactive': sum(1 for t in types if not t['active']), 'assets': len(assets), 'kit/accessory links': len(links),
        'organisations': len(org_rows), 'venues': len(ven_rows), 'contacts': len(contacts),
    }
    for k, v in summary.items():
        print(f'{k}: {v}')


if __name__ == '__main__':
    main()
