#!/usr/bin/env python3
"""
diagnose.py — Look up the 34 missing BPCKs and report their path in the JSONL.
"""
import json

MASTER_FILE = 'data_to_publish/full_geo_extraction_v25.jsonl'

MISSING = {
    '1291987', '1422896', '1430383', '1495092', '1539953', '1539955',
    '1811763', '1998481', '1998482', '2043465', '2052064', '2118829',
    '2118835', '2121735', '2171002', '2387356', '2397128', '2475416',
    '2475418', '2587899', '2599543', '2604802', '2604804', '2626828',
    '2676107', '2704560', '2704987', '2716571', '748962', '748977',
    '748987', '831533', '883810', '977836'
}

def check(drug, path, ing_rxcui, results):
    for b in drug.get('bpck', []):
        rxcui = str(b.get('rxcui', ''))
        if rxcui in MISSING:
            results.append({
                'bpck_rxcui': rxcui,
                'bpck_name': b.get('name', ''),
                'parent_rxcui': str(drug.get('rxcui', '')),
                'parent_name': drug.get('name', ''),
                'path': path,
                'ingredient': ing_rxcui,
            })

def main():
    results = []
    with open(MASTER_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            ing = str(entry.get('rxcui', ''))
            conns = entry.get('connections') or {}

            for scd in conns.get('scd', []):
                check(scd, 'flat_scd', ing, results)

            for sbd in conns.get('sbd', []):
                check(sbd, 'flat_sbd', ing, results)

            for pin in conns.get('pin', []):
                pin_rx = str(pin.get('rxcui', ''))
                for scd in pin.get('scd', []):
                    check(scd, f'pin({pin_rx}).scd', ing, results)
                for sbd in pin.get('sbd', []):
                    check(sbd, f'pin({pin_rx}).sbd', ing, results)

            for min_e in conns.get('min', []):
                min_rx = str(min_e.get('rxcui', ''))
                for scd in min_e.get('combo_scds', []):
                    check(scd, f'min({min_rx}).combo_scds', ing, results)
                for sbd in min_e.get('combo_sbds', []):
                    check(sbd, f'min({min_rx}).combo_sbds', ing, results)

    print(f'Found {len(results)} path hits for {len(MISSING)} missing BPCKs\n')
    for r in sorted(results, key=lambda x: x['path']):
        print(f"BPCK {r['bpck_rxcui']:>10}  path={r['path']}")
        print(f"               parent={r['parent_rxcui']} ({r['parent_name']})")
        print()

if __name__ == '__main__':
    main()
