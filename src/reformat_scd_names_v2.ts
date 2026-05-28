// src/reformat_scd_names_v2.ts
// Reformat SCD names to move leading modifiers/container sizes to the end
// v2 - Adds total-dose calculation for Prefilled Syringe / Auto-Injector,
//      adds 3-Bead release modifier

import 'dotenv/config';
import { Graph, personalSpace, daoSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import { TYPE_IDS, PROPERTY_IDS } from './constants';
import type { Hex } from 'viem';
import * as readline from 'readline';

const API_URL = "https://testnet-api.geobrowser.io/graphql";

// =============================================================================
// PARSING PATTERNS
// =============================================================================

const DOSE_UNITS = [
  'MG/ACTUAT', 'MCG/ACTUAT', 'MG/ML', 'MCG/ML', 'MG/HR', 'MCG/HR',
  'VIRAL-PARTICLES/ML', 'VECTOR-GENOMES/ML', 'VIRAL -PARTICLES/ML',
  'CELLS/ML', 'UNT/ML', 'EIN/ML',
  'MG/MG', 'MCG/MCG', 'UNT/UNT', 'U/U',
  'MG', 'MCG', 'ML', 'UNT', 'Unit', 'Units', 'IU', 'U', 'MEQ',
  '%', 'MG/G', 'MCG/G',
  'CELLS', 'ACTUAT', 'BAU', 'SQCM', 'Amb a 1-U',
  'SQ-HDM', 'CM', 'IR',
].sort((a, b) => b.length - a.length);

const RELEASE_MODIFIERS = [
  '9 HR', '12 HR', '24 HR', '72 HR', '84 HR', '168 HR',
  '8 HR',
  'SR', 'ER', 'XR', 'CR', 'LA', 'SA', 'XL',
  '40/60 Release 24 HR', '50/50 Release 24 HR', '30/70 Release 24 HR',
  '40/60 Release', '50/50 Release', '30/70 Release',
  '40/60', '50/50', '30/70',
  '3-Bead',  // NEW
];

const DURATION_MODIFIERS = [
  '273 DAY',
  '21 DAY', '28 DAY', '30 DAY', '60 DAY', '90 DAY',
  '1 DAY', '2 DAY', '3 DAY', '7 DAY', '14 DAY',
];

const INGREDIENT_PREFIXES_RAW = [
  'Preservative-Free', 'Preservative Free',
  'Once-Daily', 'Once Daily',
  'Twice-Daily', 'Twice Daily',
  'Three-Times-Daily', 'Three Times Daily',
  'Immediate-Release', 'Immediate Release',
  'Sustained-Release', 'Sustained Release',
];

// Forms where total dose per device is clinically meaningful
const INJECTABLE_DOSE_FORMS = [
  'Auto-Injector',
  'Prefilled Syringe',
];

// =============================================================================
// PARSING FUNCTIONS
// =============================================================================

function findFirstDosePosition(name: string): number {
  let earliestPos = -1;
  for (const unit of DOSE_UNITS) {
    const escapedUnit = unit.replace(/\//g, '\\/').replace(/\-/g, '\\-');
    const regex = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${escapedUnit}(?:\\s|[,]|/|$)`, 'i');
    const match = name.match(regex);
    if (match && match.index !== undefined) {
      if (earliestPos === -1 || match.index < earliestPos) earliestPos = match.index;
    }
  }
  return earliestPos;
}

function findAllDoses(name: string): { position: number; value: string; unit: string; fullMatch: string }[] {
  const doses: { position: number; value: string; unit: string; fullMatch: string }[] = [];
  for (const unit of DOSE_UNITS) {
    const escapedUnit = unit.replace(/\//g, '\\/').replace(/\-/g, '\\-');
    const regex = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${escapedUnit})(?:\\s|[,]|$)`, 'gi');
    let match;
    while ((match = regex.exec(name)) !== null) {
      doses.push({ position: match.index, value: match[1], unit: match[2].toUpperCase(), fullMatch: match[0] });
    }
  }
  return doses.sort((a, b) => a.position - b.position);
}

function extractDurationModifier(name: string): { modifier: string | null; cleanName: string } {
  const sortedModifiers = [...DURATION_MODIFIERS].sort((a, b) => b.length - a.length);
  for (const mod of sortedModifiers) {
    const regex = new RegExp(`^${mod.replace(/\s/g, '\\s+')}\\s+`, 'i');
    if (regex.test(name)) return { modifier: mod, cleanName: name.replace(regex, '').trim() };
  }
  return { modifier: null, cleanName: name };
}

function extractDurationModifierFromEnd(name: string): { modifier: string | null; cleanName: string } {
  const sortedModifiers = [...DURATION_MODIFIERS].sort((a, b) => b.length - a.length);
  for (const mod of sortedModifiers) {
    const regex = new RegExp(`\\s+${mod.replace(/\s/g, '\\s+')}$`, 'i');
    if (regex.test(name)) return { modifier: mod, cleanName: name.replace(regex, '').trim() };
  }
  return { modifier: null, cleanName: name };
}

function extractReleaseModifier(name: string): { modifier: string | null; cleanName: string } {
  const sortedModifiers = [...RELEASE_MODIFIERS].sort((a, b) => b.length - a.length);
  for (const mod of sortedModifiers) {
    // Escape hyphens for safety even though they're literal outside char classes
    const escaped = mod.replace(/\s/g, '\\s+').replace(/-/g, '\\-');
    const regex = new RegExp(`^${escaped}\\s+`, 'i');
    if (regex.test(name)) return { modifier: mod, cleanName: name.replace(regex, '').trim() };
  }
  return { modifier: null, cleanName: name };
}

function extractIngredientPrefixFromStart(name: string): { prefix: string; normalizedPrefix: string; cleanName: string } | null {
  const sortedPrefixes = [...INGREDIENT_PREFIXES_RAW].sort((a, b) => b.length - a.length);
  for (const prefix of sortedPrefixes) {
    const regex = new RegExp(`^${prefix.replace(/[-\s]/g, '[-\\s]+')}\\s+`, 'i');
    if (regex.test(name)) {
      const normalizedPrefix = prefix.replace(/\s+/g, '-');
      return { prefix, normalizedPrefix, cleanName: name.replace(regex, '').trim() };
    }
  }
  return null;
}

function extractIngredientPrefix(ingredient: string): { prefix: string | null; cleanIngredient: string } {
  const sortedPrefixes = [...INGREDIENT_PREFIXES_RAW].sort((a, b) => b.length - a.length);
  for (const prefix of sortedPrefixes) {
    const regex = new RegExp(`^${prefix.replace(/[-\s]/g, '[-\\s]+')}\\s+`, 'i');
    if (regex.test(ingredient)) {
      const normalizedPrefix = prefix.replace(/\s+/g, '-');
      return { prefix: normalizedPrefix, cleanIngredient: ingredient.replace(regex, '').trim() };
    }
  }
  return { prefix: null, cleanIngredient: ingredient };
}

function extractContainerSize(name: string): { container: string | null; cleanName: string } {
  const match = name.match(/^(\d+(?:\.\d+)?)\s*(ML|L|ACTUAT|MG)\s+(.+)$/i);
  if (match) {
    const rest = match[3];
    if (findFirstDosePosition(rest) !== -1) {
      return { container: `${match[1]} ${match[2].toUpperCase()}`, cleanName: rest.trim() };
    }
  }
  return { container: null, cleanName: name };
}

function extractLeadingDoseInfo(name: string): { doseInfo: string | null; cleanName: string } {
  const doseInfoMatch = name.match(/^((?:\d+(?:\.\d+)?\s*(?:MG|MCG|ML|ACTUAT|UNT|IU|U)(?:,?\s*)?)+\s*(?:Dose\s+\d+(?:\.\d+)?\s*(?:MG|ML|ACTUAT))?)\s+(.+)$/i);
  if (doseInfoMatch) {
    const doseInfo = doseInfoMatch[1].trim();
    const rest = doseInfoMatch[2];
    if (findFirstDosePosition(rest) !== -1) return { doseInfo, cleanName: rest.trim() };
  }
  const simpleDoseMatch = name.match(/^((?:\d+(?:\.\d+)?\s*(?:MG|MCG|ML)(?:,\s*)?)+)\s+(.+)$/i);
  if (simpleDoseMatch) {
    const doseInfo = simpleDoseMatch[1].trim();
    const rest = simpleDoseMatch[2];
    if (!/^\d/.test(rest) && findFirstDosePosition(rest) !== -1) return { doseInfo, cleanName: rest.trim() };
  }
  return { doseInfo: null, cleanName: name };
}

function parseComboProduct(name: string): { ingredients: string; doses: string; doseForm: string; modifiers: string[] } | null {
  const parts = name.split(' / ');
  if (parts.length < 2) return null;

  const ingredients: string[] = [];
  const doses: string[] = [];
  const modifiers: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    let earliestPos = -1, matchedUnit = '', matchedValue = '';

    for (const unit of DOSE_UNITS) {
      const escapedUnit = unit.replace(/\//g, '\\/').replace(/\-/g, '\\-');
      const regex = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${escapedUnit})(?:\\s|[,]|$)`, 'i');
      const m = part.match(regex);
      if (m && m.index !== undefined) {
        if (earliestPos === -1 || m.index < earliestPos) {
          earliestPos = m.index;
          matchedUnit = m[2];
          matchedValue = m[1];
        }
      }
    }

    if (earliestPos === -1) return null;

    ingredients.push(part.substring(0, earliestPos).trim());
    doses.push(`${matchedValue} ${matchedUnit.toUpperCase()}`);

    if (i === parts.length - 1) {
      let remaining = part.substring(earliestPos + `${matchedValue} ${matchedUnit}`.length).trim();
      for (const mod of [...RELEASE_MODIFIERS].sort((a, b) => b.length - a.length)) {
        const escaped = mod.replace(/\s/g, '\\s+').replace(/-/g, '\\-');
        const modRegex = new RegExp(`\\s+${escaped}$`, 'i');
        if (modRegex.test(remaining)) {
          modifiers.push(mod);
          remaining = remaining.replace(modRegex, '').trim();
          break;
        }
      }
      return { ingredients: ingredients.join(' / '), doses: doses.join(' / '), doseForm: remaining, modifiers };
    }
  }
  return null;
}

// =============================================================================
// INJECTABLE TOTAL-DOSE CALCULATION
// =============================================================================
//
// For Prefilled Syringe / Auto-Injector forms only, transforms:
//   "<prefix> CONC MG/ML <FORM> <VOL> ML <suffix>"
// into:
//   "<prefix> TOTAL MG (CONC MG/ML) <FORM> <VOL> ML <suffix>"
//
// where TOTAL = CONC × VOL.
//
// Intentionally narrow: requires MG/ML to be directly adjacent to the form
// and the volume in ML directly adjacent to the form. This excludes powders
// for reconstitution, generic "Injection" forms, and combo products (where
// there's "/ X MG/ML" between concentration and form).
// =============================================================================

function formatCalculatedDose(value: number): string {
  // Round to 6 decimal places to handle float math, then strip trailing zeros
  const rounded = Math.round(value * 1000000) / 1000000;
  return rounded.toString();
}

function applyInjectableDoseCalculation(name: string): string {
  // Skip if already transformed (contains pattern "<num> MG (")
  if (/\d+(?:\.\d+)?\s*MG\s*\(/i.test(name)) return name;

  const formsPattern = INJECTABLE_DOSE_FORMS
    .map(f => f.replace(/[-\s]/g, '[-\\s]'))
    .join('|');

  const regex = new RegExp(
    `^(.*?\\s)(\\d+(?:\\.\\d+)?)\\s*MG\\/ML\\s+(${formsPattern})\\s+(\\d+(?:\\.\\d+)?)\\s*ML\\b(.*)$`,
    'i'
  );

  const match = name.match(regex);
  if (!match) return name;

  const before = match[1];
  // Skip combos — if there's already a MG/ML or " / " in the prefix, it's a combo
  if (/MG\/ML/i.test(before) || / \/ /.test(before)) return name;

  const concStr = match[2];
  const conc = parseFloat(concStr);
  const form = match[3];
  const volStr = match[4];
  const vol = parseFloat(volStr);
  const after = match[5];

  const total = formatCalculatedDose(conc * vol);

  return `${before}${total} MG (${concStr} MG/ML) ${form} ${volStr} ML${after}`;
}

// =============================================================================
// MAIN REFORMAT
// =============================================================================

function reformatSCDName(name: string, debug: boolean = false): string | null {
  if (debug) console.log(`\n🔍 Parsing: "${name}"`);

  let workingName = name;
  const trailingParts: string[] = [];

  while (true) {
    const { modifier, cleanName } = extractDurationModifier(workingName);
    if (modifier) { trailingParts.push(modifier); workingName = cleanName; } else break;
  }

  while (true) {
    const { modifier, cleanName } = extractReleaseModifier(workingName);
    if (modifier) { trailingParts.push(modifier); workingName = cleanName; } else break;
  }

  while (true) {
    const prefixResult = extractIngredientPrefixFromStart(workingName);
    if (prefixResult) { trailingParts.push(prefixResult.normalizedPrefix); workingName = prefixResult.cleanName; } else break;
  }

  while (true) {
    const { container, cleanName } = extractContainerSize(workingName);
    if (container) { trailingParts.push(container); workingName = cleanName; } else break;
  }

  while (true) {
    const { modifier, cleanName } = extractReleaseModifier(workingName);
    if (modifier) { trailingParts.push(modifier); workingName = cleanName; } else break;
  }

  const { doseInfo, cleanName: afterDoseInfo } = extractLeadingDoseInfo(workingName);
  if (doseInfo) { trailingParts.push(doseInfo); workingName = afterDoseInfo; }

  const dosePos = findFirstDosePosition(workingName);

  if (dosePos === -1) {
    if (trailingParts.length > 0) return applyInjectableDoseCalculation(`${workingName} ${trailingParts.join(' ')}`);
    return applyInjectableDoseCalculation(workingName);
  }

  if (workingName.includes(' / ')) {
    const parsed = parseComboProduct(workingName);
    if (parsed) {
      let finalIngredients = parsed.ingredients;
      let comboDurationMod: string | null = null;

      const { modifier: durMod, cleanName: cleanIngs } = extractDurationModifierFromEnd(parsed.ingredients);
      if (durMod) { comboDurationMod = durMod; finalIngredients = cleanIngs; }

      const cleanIngredients: string[] = [];
      const prefixes: string[] = [];
      for (const ing of finalIngredients.split(' / ')) {
        const { prefix, cleanIngredient } = extractIngredientPrefix(ing);
        cleanIngredients.push(cleanIngredient);
        if (prefix) prefixes.push(prefix);
      }

      let doseForm = parsed.doseForm;
      if (prefixes.length > 0) doseForm = doseForm + ' ' + prefixes.join(' ');

      let result = `${cleanIngredients.join(' / ')} ${parsed.doses} ${doseForm}`;
      if (parsed.modifiers.length > 0) result += ' ' + parsed.modifiers.join(' ');
      if (comboDurationMod) trailingParts.push(comboDurationMod);
      if (trailingParts.length > 0) result += ' ' + trailingParts.join(' ');

      return applyInjectableDoseCalculation(result);
    }
  }

  const ingredient = workingName.substring(0, dosePos).trim();
  const { prefix: ingredientPrefix, cleanIngredient: finalIngredient } = extractIngredientPrefix(ingredient);
  const afterIngredient = workingName.substring(dosePos);
  const doseFormMatch = afterIngredient.match(/^(\d+(?:\.\d+)?)\s*(\S+(?:\/\S+)?)\s*(.*)$/);
  if (!doseFormMatch) return null;

  const dose = `${doseFormMatch[1]} ${doseFormMatch[2].toUpperCase()}`;
  let doseForm = doseFormMatch[3].trim();
  if (ingredientPrefix) doseForm = doseForm + ' ' + ingredientPrefix;

  let result = `${finalIngredient} ${dose} ${doseForm}`;
  if (trailingParts.length > 0) result += ' ' + trailingParts.join(' ');

  return applyInjectableDoseCalculation(result);
}

// =============================================================================
// TESTS
// =============================================================================

function runTests(): void {
  console.log('\n🧪 Running test cases:\n');

  const testCases = [
    // Injectable dose calc — Prefilled Syringe
    { input: '0.1 ML adalimumab-aaty 100 MG/ML Prefilled Syringe', expected: 'adalimumab-aaty 10 MG (100 MG/ML) Prefilled Syringe 0.1 ML' },
    { input: '0.05 ML aflibercept-ayyh 40 MG/ML Prefilled Syringe', expected: 'aflibercept-ayyh 2 MG (40 MG/ML) Prefilled Syringe 0.05 ML' },
    { input: '1 ML spesolimab-sbzo 150 MG/ML Prefilled Syringe', expected: 'spesolimab-sbzo 150 MG (150 MG/ML) Prefilled Syringe 1 ML' },
    { input: '0.25 ML tick-borne encephalitis purified antigen 0.0048 MG/ML Prefilled Syringe', expected: 'tick-borne encephalitis purified antigen 0.0012 MG (0.0048 MG/ML) Prefilled Syringe 0.25 ML' },
    { input: 'adalimumab 100 MG/ML Prefilled Syringe 0.8 ML', expected: 'adalimumab 80 MG (100 MG/ML) Prefilled Syringe 0.8 ML' },
    { input: 'adalimumab 50 MG/ML Prefilled Syringe 0.8 ML', expected: 'adalimumab 40 MG (50 MG/ML) Prefilled Syringe 0.8 ML' },

    // Injectable dose calc — Auto-Injector (including container-first)
    { input: '0.8 ML adalimumab-aaty 100 MG/ML Auto-Injector', expected: 'adalimumab-aaty 80 MG (100 MG/ML) Auto-Injector 0.8 ML' },
    { input: '0.4 ML adalimumab 100 MG/ML Auto-Injector', expected: 'adalimumab 40 MG (100 MG/ML) Auto-Injector 0.4 ML' },
    { input: 'adalimumab 100 MG/ML Auto-Injector 0.4 ML', expected: 'adalimumab 40 MG (100 MG/ML) Auto-Injector 0.4 ML' },

    // Should NOT apply dose calc — generic Injection
    { input: '26 ML ustekinumab 5 MG/ML Injection', expected: 'ustekinumab 5 MG/ML Injection 26 ML' },
    { input: '68 ML brexucabtagene autoleucel 2940000 CELLS/ML Injection', expected: 'brexucabtagene autoleucel 2940000 CELLS/ML Injection 68 ML' },
    { input: '250 ML albumin human, USP 50 MG/ML Injection', expected: 'albumin human, USP 50 MG/ML Injection 250 ML' },
    { input: '30 ML eculizumab-aeeb 10 MG/ML Injection', expected: 'eculizumab-aeeb 10 MG/ML Injection 30 ML' },
    { input: '20 ML donanemab-azbt 17.5 MG/ML Injection', expected: 'donanemab-azbt 17.5 MG/ML Injection 20 ML' },

    // Should NOT apply dose calc — combo injectable
    { input: '14 ML bupivacaine 29.3 MG/ML / meloxicam 0.88 MG/ML Injection', expected: 'bupivacaine / meloxicam 29.3 MG/ML / 0.88 MG/ML Injection 14 ML' },

    // 3-Bead modifier (new)
    { input: '3-Bead 24 HR amphetamine aspartate / amphetamine sulfate / dextroamphetamine saccharate / dextroamphetamine sulfate 3.125 MG / 3.125 MG / 3.125 MG / 3.125 MG Extended Release Oral Capsule', expected: 'amphetamine aspartate / amphetamine sulfate / dextroamphetamine saccharate / dextroamphetamine sulfate 3.125 MG / 3.125 MG / 3.125 MG / 3.125 MG Extended Release Oral Capsule 3-Bead 24 HR' },

    // Complex dose info at start (existing behavior preserved)
    { input: '0.25 MG, 0.5 MG Dose 1.5 ML semaglutide 1.34 MG/ML Pen Injector', expected: 'semaglutide 1.34 MG/ML Pen Injector 0.25 MG, 0.5 MG Dose 1.5 ML' },
    { input: '0.25 MG, 0.5 MG Dose 3 ML semaglutide 0.68 MG/ML Pen Injector', expected: 'semaglutide 0.68 MG/ML Pen Injector 0.25 MG, 0.5 MG Dose 3 ML' },

    // Already correct
    { input: 'atorvastatin 10 MG Oral Tablet', expected: 'atorvastatin 10 MG Oral Tablet' },
    { input: 'metformin 500 MG Oral Tablet', expected: 'metformin 500 MG Oral Tablet' },
    { input: 'semaglutide 1.34 MG/ML Pen Injector', expected: 'semaglutide 1.34 MG/ML Pen Injector' },

    // Duration modifier at start
    { input: '21 DAY ethinyl estradiol 0.000625 MG/HR / etonogestrel 0.005 MG/HR Vaginal System', expected: 'ethinyl estradiol / etonogestrel 0.000625 MG/HR / 0.005 MG/HR Vaginal System 21 DAY' },
    { input: '28 DAY testosterone 150 MG/ML Topical Gel', expected: 'testosterone 150 MG/ML Topical Gel 28 DAY' },
    { input: '273 DAY ethinyl estradiol 0.000542 MG/HR / segesterone acetate 0.00625 MG/HR Vaginal System', expected: 'ethinyl estradiol / segesterone acetate 0.000542 MG/HR / 0.00625 MG/HR Vaginal System 273 DAY' },

    // Release modifier at start
    { input: '12 HR carbamazepine 200 MG Extended Release Oral Capsule', expected: 'carbamazepine 200 MG Extended Release Oral Capsule 12 HR' },
    { input: '24 HR amphetamine aspartate / amphetamine sulfate / dextroamphetamine saccharate / dextroamphetamine sulfate 5 MG / 5 MG / 5 MG / 5 MG Extended Release Oral Capsule', expected: 'amphetamine aspartate / amphetamine sulfate / dextroamphetamine saccharate / dextroamphetamine sulfate 5 MG / 5 MG / 5 MG / 5 MG Extended Release Oral Capsule 24 HR' },

    // Combo products
    { input: 'acetaminophen 325 MG / oxycodone 5 MG Oral Tablet', expected: 'acetaminophen / oxycodone 325 MG / 5 MG Oral Tablet' },
    { input: 'budesonide 0.16 MG/ACTUAT / formoterol fumarate 0.0045 MG/ACTUAT Metered Dose Inhaler', expected: 'budesonide / formoterol fumarate 0.16 MG/ACTUAT / 0.0045 MG/ACTUAT Metered Dose Inhaler' },
    { input: 'hyaluronidase, human recombinant 2000 UNT/ML / rituximab 120 MG/ML Injection', expected: 'hyaluronidase, human recombinant / rituximab 2000 UNT/ML / 120 MG/ML Injection' },

    // Ingredient prefix at start
    { input: 'Preservative Free timolol 5 MG/ML Ophthalmic Solution', expected: 'timolol 5 MG/ML Ophthalmic Solution Preservative-Free' },
    { input: 'Once Daily clindamycin 0.01 MG/MG Topical Gel', expected: 'clindamycin 0.01 MG/MG Topical Gel Once-Daily' },

    // Already correct combo
    { input: 'empagliflozin / metformin hydrochloride 12.5 MG / 1000 MG Extended Release Oral Tablet', expected: 'empagliflozin / metformin hydrochloride 12.5 MG / 1000 MG Extended Release Oral Tablet' },

    // Multi-modifier injectable (release after container)
    { input: '0.1 ML 12 HR adalimumab 100 MG/ML Prefilled Syringe', expected: 'adalimumab 10 MG (100 MG/ML) Prefilled Syringe 0.1 ML 12 HR' },
  ];

  let passed = 0, failed = 0;
  for (const tc of testCases) {
    const result = reformatSCDName(tc.input, false);
    if (result === tc.expected) {
      passed++;
      console.log(`✅ PASS: ${tc.input}\n   → ${result}`);
    } else {
      failed++;
      console.log(`❌ FAIL: ${tc.input}\n   Expected: ${tc.expected}\n   Got:      ${result}`);
    }
    console.log('');
  }
  console.log(`📊 Test Results: ${passed} passed, ${failed} failed\n`);
}

// =============================================================================
// SPACE HELPERS / FETCH / PUBLISH / MAIN (unchanged)
// =============================================================================

async function detectSpaceType(spaceId: string): Promise<{ type: 'PERSONAL' | 'DAO'; address?: string }> {
  const query = `query GetSpaceType { space(id: "${spaceId}") { id type address } }`;
  const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  const json = await res.json() as any;
  if (json.errors) { console.error('❌ Failed to query space:', json.errors[0].message); process.exit(1); }
  if (!json.data?.space) { console.error(`❌ Space not found: ${spaceId}`); process.exit(1); }
  return { type: json.data.space.type as 'PERSONAL' | 'DAO', address: json.data.space.address };
}

async function fetchSCDEntities(spaceId: string): Promise<Array<{ id: string; name: string }>> {
  const SCD_TYPE_ID = TYPE_IDS.SCD;
  console.log(`\n🔍 Querying SCD entities (type: ${SCD_TYPE_ID})...`);
  const entities: Array<{ id: string; name: string }> = [];
  let cursor: string | null = null;
  let batchNum = 0;
  while (true) {
    batchNum++;
    const afterParam = cursor ? `, after: "${cursor}"` : '';
    const query = `{ entitiesConnection(spaceId: "${spaceId}", typeId: "${SCD_TYPE_ID}", first: 1000${afterParam}) { nodes { id name } pageInfo { hasNextPage endCursor } } }`;
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
    const json = await res.json() as any;
    if (json.errors) { console.error(`❌ Query error on batch ${batchNum}:`, json.errors[0].message); break; }
    const nodes = json.data?.entitiesConnection?.nodes || [];
    const pageInfo = json.data?.entitiesConnection?.pageInfo;
    entities.push(...nodes);
    console.log(`   Batch ${batchNum}: ${nodes.length} SCDs (total: ${entities.length.toLocaleString()})`);
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 50));
  }
  return entities;
}

async function publishInBatches(allOps: any[], spaceInfo: { type: 'PERSONAL' | 'DAO'; address?: string }, spaceId: string, smartAccount: any, personalSpaceId: string | undefined, proposalName: string): Promise<void> {
  const batchSize = spaceInfo.type === 'DAO' ? 2000 : 80000;
  const totalBatches = Math.ceil(allOps.length / batchSize);
  console.log(`\n📦 Publishing ${totalBatches} batch(es) to ${spaceInfo.type} space...`);
  console.log(`   Batch size: ${batchSize.toLocaleString()} ops\n`);
  for (let i = 0; i < totalBatches; i++) {
    const batch = allOps.slice(i * batchSize, (i + 1) * batchSize);
    const batchNum = i + 1;
    const batchName = `${proposalName} (Batch ${batchNum}/${totalBatches})`;
    console.log(`Batch ${batchNum}/${totalBatches} (${batch.length.toLocaleString()} ops)...`);
    try {
      let to: `0x${string}`, calldata: `0x${string}`, cid: string;
      if (spaceInfo.type === 'DAO') {
        const result = await daoSpace.proposeEdit({
          name: batchName, ops: batch, author: personalSpaceId!.replace(/-/g, ''),
          daoSpaceAddress: spaceInfo.address as `0x${string}`,
          callerSpaceId: '0x' + personalSpaceId!.replace(/-/g, ''),
          daoSpaceId: '0x' + spaceId.replace(/-/g, ''), network: 'TESTNET',
        });
        cid = result.cid; to = result.to; calldata = result.calldata;
        console.log(`   📝 Proposal ID: ${result.proposalId}`);
      } else {
        const result = await personalSpace.publishEdit({
          name: batchName, spaceId: spaceId.replace(/-/g, ''), ops: batch,
          author: spaceId.replace(/-/g, ''), network: 'TESTNET',
        });
        cid = result.cid; to = result.to; calldata = result.calldata;
        console.log(`   📝 IPFS: ${cid}`);
      }
      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`   ✅ Broadcast: ${txHash}`);
      console.log(`   🔍 https://sepolia.basescan.org/tx/${txHash}\n`);
      if (batchNum < totalBatches) await new Promise(r => setTimeout(r, 3000));
    } catch (e: any) { console.error(`   ❌ Batch ${batchNum} failed:`, e.message); throw e; }
  }
  console.log('✅ All batches broadcast!\n');
}

async function main() {
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes('--dry-run');
  const TEST_ONLY = args.includes('--test');
  const proposalName = (() => {
    const idx = args.indexOf('--proposal-name');
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : 'Reformat SCD names';
  })();

  console.log('\n🚀 Reformat SCD Names v2');

  if (TEST_ONLY) { runTests(); console.log('✅ Test-only mode complete.\n'); return; }
  if (DRY_RUN) console.log('   🔍 DRY RUN - no changes will be published');

  const spaceId = process.env.GEO_SPACE_ID;
  const personalSpaceId = process.env.GEO_PERSONAL_SPACE_ID;
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;

  if (!spaceId) { console.error('❌ Missing GEO_SPACE_ID'); process.exit(1); }
  if (!TYPE_IDS.SCD) { console.error('❌ TYPE_IDS.SCD not defined in constants.ts'); process.exit(1); }

  const spaceInfo = await detectSpaceType(spaceId);
  if (spaceInfo.type === 'DAO' && !personalSpaceId) { console.error('❌ GEO_PERSONAL_SPACE_ID required for DAO space'); process.exit(1); }

  console.log(`📋 Space: ${spaceId} (${spaceInfo.type})\n`);
  const entities = await fetchSCDEntities(spaceId);
  if (entities.length === 0) { console.log('\n⚠️  No SCD entities found.\n'); return; }

  const reformattable: Array<{ id: string; oldName: string; newName: string }> = [];
  const failed: Array<{ id: string; name: string }> = [];

  for (const entity of entities) {
    const newName = reformatSCDName(entity.name);
    if (newName) {
      if (newName !== entity.name) reformattable.push({ id: entity.id, oldName: entity.name, newName });
    } else {
      failed.push({ id: entity.id, name: entity.name });
    }
  }

  console.log(`\n📊 Parsing Results:`);
  console.log(`   Total SCDs: ${entities.length}`);
  console.log(`   Need reformatting: ${reformattable.length}`);
  console.log(`   Already correct: ${entities.length - reformattable.length - failed.length}`);
  console.log(`   Failed to parse: ${failed.length}`);

  console.log('\n✅ Sample transformations (first 20):');
  reformattable.slice(0, 20).forEach((e, i) => {
    console.log(`   ${i + 1}. "${e.oldName}"`);
    console.log(`      → "${e.newName}"`);
  });

  if (failed.length > 0 && failed.length <= 50) {
    console.log(`\n❌ Failed to parse (${failed.length}):`);
    failed.forEach((e, i) => console.log(`   ${i + 1}. "${e.name}"`));
  } else if (failed.length > 50) {
    console.log(`\n❌ Failed to parse: ${failed.length} (showing first 30)`);
    failed.slice(0, 30).forEach((e, i) => console.log(`   ${i + 1}. "${e.name}"`));
  }

  if (DRY_RUN) { console.log('\n✅ Dry run complete. No changes published.\n'); return; }
  if (reformattable.length === 0) { console.log('\n✅ No entities need reformatting. Done.\n'); return; }

  if (!privateKeyRaw) { console.error('❌ Missing GEO_WALLET_PRIVATE_KEY'); process.exit(1); }
  const privateKey = (privateKeyRaw?.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const smartAccount = await getSmartAccountWalletClient({ privateKey });
  console.log(`✅ Wallet ready\n`);

  const allOps: any[] = [];
  for (const entity of reformattable) {
    const result = Graph.updateEntity({ id: entity.id, name: entity.newName });
    allOps.push(...result.ops);
  }

  console.log(`📊 Generated ${allOps.length.toLocaleString()} operations`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirmed = await new Promise<boolean>((resolve) => {
    rl.question(`\nPublish ${allOps.length.toLocaleString()} ops to ${spaceInfo.type} space? [y/N]: `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });

  if (!confirmed) { console.log('❌ Aborted.\n'); return; }
  await publishInBatches(allOps, spaceInfo, spaceId, smartAccount, personalSpaceId, proposalName);
}

main().catch(console.error);
