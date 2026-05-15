// src/reformat_sbd_names_v3.ts
// Reformat SBD names to put brand first with bracketed ingredient
// v3 - Handle ratio+release modifiers, combo products with 3+ ingredients, complex multi-dose, trailing commas in brackets

import 'dotenv/config';
import { Graph, personalSpace, daoSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import { TYPE_IDS, PROPERTY_IDS } from './constants';
import type { Hex } from 'viem';
import * as readline from 'readline';

const API_URL = "https://testnet-api.geobrowser.io/graphql";

// =============================================================================
// PARSING PATTERNS
// =============================================================================

// Sort by length (longest first) so compound units like MG/ML match before MG
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
];

const DURATION_MODIFIERS = [
  '273 DAY',
  '21 DAY', '28 DAY', '30 DAY', '60 DAY', '90 DAY',
  '1 DAY', '2 DAY', '3 DAY', '7 DAY', '14 DAY',
];

const INGREDIENT_PREFIXES = [
  'Preservative-Free',
  'Once-Daily',
  'Twice-Daily',
  'Three-Times-Daily',
  'Immediate-Release',
  'Sustained-Release',
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
      if (earliestPos === -1 || match.index < earliestPos) {
        earliestPos = match.index;
      }
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
      doses.push({
        position: match.index,
        value: match[1],
        unit: match[2].toUpperCase(),
        fullMatch: match[0]
      });
    }
  }

  return doses.sort((a, b) => a.position - b.position);
}

function extractDurationModifier(name: string): { modifier: string | null; cleanName: string } {
  const sortedModifiers = [...DURATION_MODIFIERS].sort((a, b) => b.length - a.length);

  for (const mod of sortedModifiers) {
    const regex = new RegExp(`^${mod.replace(/\s/g, '\\s+')}\\s+`, 'i');
    if (regex.test(name)) {
      return {
        modifier: mod,
        cleanName: name.replace(regex, '').trim()
      };
    }
  }
  return { modifier: null, cleanName: name };
}

function extractDurationModifierFromEnd(name: string): { modifier: string | null; cleanName: string } {
  const sortedModifiers = [...DURATION_MODIFIERS].sort((a, b) => b.length - a.length);

  for (const mod of sortedModifiers) {
    const regex = new RegExp(`\\s+${mod.replace(/\s/g, '\\s+')}$`, 'i');
    if (regex.test(name)) {
      return {
        modifier: mod,
        cleanName: name.replace(regex, '').trim()
      };
    }
  }
  return { modifier: null, cleanName: name };
}

function extractIngredientPrefix(ingredient: string): { prefix: string | null; cleanIngredient: string } {
  for (const prefix of INGREDIENT_PREFIXES) {
    const regex = new RegExp(`^${prefix.replace(/-/g, '\\s*-\\s*')}\\s+`, 'i');
    if (regex.test(ingredient)) {
      const normalizedPrefix = prefix.replace(/-/g, '-');
      return {
        prefix: normalizedPrefix,
        cleanIngredient: ingredient.replace(regex, '').trim()
      };
    }
  }
  return { prefix: null, cleanIngredient: ingredient };
}

function extractReleaseModifierFromStart(text: string): { modifier: string | null; remaining: string } {
  const sortedModifiers = [...RELEASE_MODIFIERS].sort((a, b) => b.length - a.length);

  for (const mod of sortedModifiers) {
    const regex = new RegExp(`^${mod.replace(/\s/g, '\\s+')}\\s+`, 'i');
    if (regex.test(text)) {
      const remaining = text.replace(regex, '').trim();
      if (remaining && (!/^\d/.test(remaining) || /^\d-/.test(remaining) || /^\w+$$/.test(remaining) || /^[A-Za-z]/.test(remaining))) {
        return {
          modifier: mod,
          remaining: remaining
        };
      }
    }
  }
  return { modifier: null, remaining: text };
}

function cleanBrandContent(brandText: string, alreadyExtracted: string[] = []): { brand: string | null; extraDose: string | null; extraModifiers: string[] } {
  if (!brandText) return { brand: null, extraDose: null, extraModifiers: [] };

  let text = brandText.trim();
  const extraModifiers: string[] = [];

  if (/^(NDA|ANDA)\d+$/i.test(text)) {
    return { brand: null, extraDose: null, extraModifiers: [] };
  }

  text = text.replace(/^(NDA|ANDA)\d+\s*/i, '').trim();
  if (!text) return { brand: null, extraDose: null, extraModifiers: [] };

  let remainingText = text;
  let extractedModifier = null;

  do {
    const result = extractReleaseModifierFromStart(remainingText);
    extractedModifier = result.modifier;
    if (extractedModifier && !alreadyExtracted.includes(extractedModifier)) {
      extraModifiers.push(extractedModifier);
      remainingText = result.remaining;
    } else if (extractedModifier) {
      remainingText = result.remaining;
      extractedModifier = null;
    }
  } while (extractedModifier);

  const doseMatch = remainingText.match(/^(\d+(?:\.\d+)?)\s*(ACTUAT|CELLS(?:\/ML)?|MG(?:,)?)\s+(.+)$/i);
  if (doseMatch) {
    const hasComma = doseMatch[2].includes(',');
    const doseValue = `${doseMatch[1]} ${doseMatch[2].replace(',', '').toUpperCase()}`;

    if (hasComma) {
      extraModifiers.push(doseValue);
      remainingText = doseMatch[3];
    } else {
      return {
        extraDose: doseValue,
        brand: doseMatch[3].trim(),
        extraModifiers: extraModifiers
      };
    }
  }

  if (/^\d/.test(remainingText) && !/^\d-/.test(remainingText) && !/$$/.test(remainingText)) {
    return { brand: null, extraDose: null, extraModifiers: [] };
  }

  return { brand: remainingText, extraDose: null, extraModifiers: extraModifiers };
}

function findLastMatchingBracket(str: string): { open: number; close: number } | null {
  const lastClose = str.lastIndexOf(']');
  if (lastClose === -1) {
    const firstOpen = str.indexOf('[');
    if (firstOpen !== -1) {
      return { open: firstOpen, close: -1 };
    }
    return null;
  }

  let depth = 0;
  for (let i = lastClose; i >= 0; i--) {
    if (str[i] === ']') depth++;
    if (str[i] === '[') {
      depth--;
      if (depth === 0) {
        return { open: i, close: lastClose };
      }
    }
  }
  return null;
}

function processBracketContent(
  fullName: string,
  beforeBracket: string,
  bracketContent: string,
  afterBracket: string,
  fallbackBrand?: string | null
): {
  brand: string | null;
  ingredient: string | null;
  extraDose: string | null;
  extraModifiers: string[];
  cleanName: string;
  durationModifier?: string | null;
} {
  const bracketLooksLikeDoses = bracketContent === '' || /^\d+\.?\d*\s*(?:MG|ML)(?:,|\s*$)/i.test(bracketContent);

  if (bracketLooksLikeDoses && afterBracket.length > 0) {
    const dosePos = findFirstDosePosition(afterBracket);
    if (dosePos !== -1) {
      const bracketDoses = bracketContent ? bracketContent.replace(/,$/, '').trim() : null;

      return {
        brand: beforeBracket,
        ingredient: null,
        extraDose: bracketDoses,
        extraModifiers: [],
        cleanName: afterBracket
      };
    }
  }

  const doseBeforeBracket = findFirstDosePosition(beforeBracket) !== -1;

  if (!doseBeforeBracket) {
    const { modifier: bracketDurationMod, cleanName: cleanedBracket1 } = extractDurationModifier(bracketContent);
    const { modifier: bracketReleaseMod, cleanName: cleanedBracket2 } = extractReleaseModifierFromStart(cleanedBracket1 || bracketContent);
    
    const finalBracketContent = cleanedBracket2 || cleanedBracket1 || bracketContent;
    const extractedModifiers: string[] = [];
    if (bracketReleaseMod) extractedModifiers.push(bracketReleaseMod);

    const { brand: cleanedIngredient, extraDose, extraModifiers: brandModifiers } = cleanBrandContent(finalBracketContent, extractedModifiers);

    if (!cleanedIngredient) {
      return { brand: fallbackBrand || null, ingredient: null, extraDose: null, extraModifiers: [], cleanName: fullName };
    }

    return {
      brand: beforeBracket,
      ingredient: cleanedIngredient,
      extraDose: extraDose,
      extraModifiers: [...extractedModifiers, ...brandModifiers],
      cleanName: cleanedIngredient + ' ' + afterBracket,
      durationModifier: bracketDurationMod
    };
  }

  const { brand, extraDose, extraModifiers } = cleanBrandContent(bracketContent);
  return {
    brand: brand || fallbackBrand || null,
    ingredient: null,
    extraDose,
    extraModifiers,
    cleanName: beforeBracket
  };
}

function extractBrand(name: string, fallbackBrand?: string | null): {
  brand: string | null;
  ingredient: string | null;
  extraDose: string | null;
  extraModifiers: string[];
  cleanName: string;
  durationModifier?: string | null;
} {
  let nameStr = name.replace(/^(NDA\d+|ANDA\d+)\s+/i, '').trim();

  const bracketPos = findLastMatchingBracket(nameStr);
  if (!bracketPos) {
    return { brand: fallbackBrand || null, ingredient: null, extraDose: null, extraModifiers: [], cleanName: nameStr };
  }

  const firstOpenBracket = bracketPos.open;
  const closeBracket = bracketPos.close;

  if (closeBracket === -1) {
    const bracketContent = nameStr.substring(firstOpenBracket + 1).trim();
    const beforeBracket = nameStr.substring(0, firstOpenBracket).trim();
    const afterBracket = '';

    const comboResult = parseComboFromBracketContent(beforeBracket, bracketContent);
    if (comboResult) {
      return comboResult;
    }

    return { brand: fallbackBrand || null, ingredient: null, extraDose: null, extraModifiers: [], cleanName: nameStr };
  }

  const bracketContent = nameStr.substring(firstOpenBracket + 1, closeBracket).trim();
  const beforeBracket = nameStr.substring(0, firstOpenBracket).trim();
  const afterBracket = nameStr.substring(closeBracket + 1).trim();

  return processBracketContent(nameStr, beforeBracket, bracketContent, afterBracket, fallbackBrand);
}

function parseComboFromBracketContent(
  beforeBracket: string,
  bracketContent: string
): {
  brand: string | null;
  ingredient: string | null;
  extraDose: string | null;
  extraModifiers: string[];
  cleanName: string;
} | null {
  if (!bracketContent.includes(' / ')) {
    return null;
  }

  const brand = beforeBracket.trim();
  if (!brand) {
    return null;
  }

  const parts = bracketContent.split(' / ');

  const parsed = parseComboProduct(bracketContent);
  if (parsed) {
    const cleanIngredients: string[] = [];
    let durationMod: string | null = null;

    for (const ing of parsed.ingredients.split(' / ')) {
      const { modifier: durMod, cleanName: cleanIng } = extractDurationModifier(ing);
      if (durMod) durationMod = durMod;
      cleanIngredients.push(cleanIng);
    }

    let result = `${brand} [${cleanIngredients.join(' / ')}] ${parsed.doses} ${parsed.doseForm}`;
    if (parsed.modifiers.length > 0) result += ' ' + parsed.modifiers.join(' ');
    if (durationMod) result += ` ${durationMod}`;

    return {
      brand: brand,
      ingredient: null,
      extraDose: null,
      extraModifiers: [],
      cleanName: result
    };
  }

  if (parts.length >= 3) {
    const ingredients: string[] = [];
    const doses: { value: string; unit: string }[] = [];
    let doseForm = '';
    let container = '';
    let durationMod: string | null = null;

    const firstDose = findFirstDosePosition(parts[0]);
    if (firstDose === -1) {
      const { modifier: durMod, cleanName: cleanFirstIng } = extractDurationModifier(parts[0].trim());
      ingredients.push(cleanFirstIng);
      durationMod = durMod;

      const remainingText = parts.slice(1).join(' / ');
      const allDoses = findAllDoses(remainingText);

      if (allDoses.length >= 2) {
        doses.push({ value: allDoses[0].value, unit: allDoses[0].unit });
        doses.push({ value: allDoses[1].value, unit: allDoses[1].unit });

        const part1 = parts[1];
        const dose1Pos = findFirstDosePosition(part1);
        if (dose1Pos !== -1) {
          ingredients.push(part1.substring(0, dose1Pos).trim());
        }

        const afterSecondDoseStart = allDoses[1].position + allDoses[1].fullMatch.length;
        const afterSecondDose = remainingText.substring(afterSecondDoseStart).trim();

        const containerMatch = afterSecondDose.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*(ML|L|ACTUAT)$/i);
        if (containerMatch) {
          doseForm = containerMatch[1].trim();
          container = `${containerMatch[2]} ${containerMatch[3].toUpperCase()}`;
        } else {
          doseForm = afterSecondDose;
        }

        const dosesStr = doses.map(d => `${d.value} ${d.unit}`).join(' / ');
        let result = `${brand} [${ingredients.join(' / ')}] ${dosesStr} ${doseForm}`;
        if (container) result += ` ${container}`;
        if (durationMod) result += ` ${durationMod}`;

        return {
          brand: brand,
          ingredient: null,
          extraDose: null,
          extraModifiers: [],
          cleanName: result
        };
      }
    }
  }

  return null;
}

function extractContainerSize(name: string): { container: string | null; cleanName: string } {
  const match = name.match(/^(\d+(?:\.\d+)?)\s*(ML|L|ACTUAT)\s+([^,^].*)/i);
  if (match) {
    const rest = match[3];
    if (findFirstDosePosition(rest) !== -1) {
      return {
        container: `${match[1]} ${match[2].toUpperCase()}`,
        cleanName: rest.trim()
      };
    }
  }
  const mgMatch = name.match(/^(\d+(?:\.\d+)?)\s*MG\s+([^,^].*)/i);
  if (mgMatch) {
    const rest = mgMatch[2];
    if (findFirstDosePosition(rest) !== -1) {
      return {
        container: `${mgMatch[1]} MG`,
        cleanName: rest.trim()
      };
    }
  }
  return { container: null, cleanName: name };
}

function extractReleaseModifier(ingredient: string): { modifier: string | null; cleanIngredient: string } {
  const sortedModifiers = [...RELEASE_MODIFIERS].sort((a, b) => b.length - a.length);

  for (const mod of sortedModifiers) {
    const regex = new RegExp(`^${mod.replace(/\s/g, '\\s+')}\\s+`, 'i');
    if (regex.test(ingredient)) {
      return {
        modifier: mod,
        cleanIngredient: ingredient.replace(regex, '').trim()
      };
    }
  }
  return { modifier: null, cleanIngredient: ingredient };
}

function parseComboProduct(cleanName: string): { ingredients: string; doses: string; doseForm: string; modifiers: string[] } | null {
  const parts = cleanName.split(' / ');
  if (parts.length < 2) return null;

  const ingredients: string[] = [];
  const doses: string[] = [];
  const modifiers: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();

    let earliestPos = -1;
    let matchedUnit = '';
    let matchedValue = '';

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

    if (earliestPos === -1) {
      return null;
    }

    const ingredient = part.substring(0, earliestPos).trim();
    const dose = `${matchedValue} ${matchedUnit.toUpperCase()}`;

    ingredients.push(ingredient);
    doses.push(dose);

    if (i === parts.length - 1) {
      let remaining = part.substring(earliestPos + `${matchedValue} ${matchedUnit}`.length).trim();
      remaining = remaining.replace(/^,^\s*/, '');

      const releaseResult = extractReleaseModifier(remaining);
      if (releaseResult.modifier) {
        modifiers.push(releaseResult.modifier);
        remaining = releaseResult.cleanIngredient;
      }

      return {
        ingredients: ingredients.join(' / '),
        doses: doses.join(' / '),
        doseForm: remaining,
        modifiers: modifiers
      };
    }
  }

  return null;
}

function parseBrandFirstFormat(
  brand: string,
  extraDose: string | null,
  extraModifiers: string[],
  cleanName: string
): string | null {
  const dosePos = findFirstDosePosition(cleanName);
  if (dosePos === -1) return null;

  let preIngredient = '';
  let nameAfterContainer = cleanName;

  const complexMatch = cleanName.match(/^(\d+(?:\.\d+)?\s*(?:MG|ML|ACTUAT)(?:\s+(?:Dose)\s+\d+(?:\.\d+)?\s*(?:MG|ML|ACTUAT))?)\s+(.+)$/i);
  if (complexMatch) {
    preIngredient = complexMatch[1];
    nameAfterContainer = complexMatch[2];
  }

  const newDosePos = findFirstDosePosition(nameAfterContainer);
  if (newDosePos === -1) return null;

  const ingredient = nameAfterContainer.substring(0, newDosePos).trim();
  const afterIngredient = nameAfterContainer.substring(newDosePos);

  const doseFormMatch = afterIngredient.match(/^(\d+(?:\.\d+)?)\s*(\S+(?:\/\S+)?)\s*(.*)$/);
  if (!doseFormMatch) return null;

  const dose = `${doseFormMatch[1]} ${doseFormMatch[2].toUpperCase()}`;
  const doseForm = doseFormMatch[3].trim();

  let result = `${brand} [${ingredient}] ${dose} ${doseForm}`;
  if (extraModifiers.length > 0) result += ' ' + extraModifiers.join(' ');
  if (extraDose) result += ` ${extraDose}`;
  if (preIngredient) result += ` ${preIngredient}`;

  return result;
}

function reformatSBDName(name: string, debug: boolean = false): string | null {
  if (debug) console.log(`\n🔍 Parsing: "${name}"`);

  const { modifier: durationMod, cleanName: nameAfterDuration } = extractDurationModifier(name);
  if (durationMod && debug) {
    console.log(`   ✅ Duration modifier: "${durationMod}"`);
    console.log(`   📝 After duration extraction: "${nameAfterDuration}"`);
  }

  const { brand, ingredient: extractedIngredient, extraDose, extraModifiers, cleanName: nameAfterBrand, durationModifier: bracketDurationMod } = extractBrand(nameAfterDuration);
  if (!brand) {
    if (debug) console.log(`   ❌ No brand found`);
    return null;
  }
  if (debug) {
    console.log(`   ✅ Brand: "${brand}"`);
    if (extractedIngredient) console.log(`   📝 Ingredient extracted from bracket: "${extractedIngredient}"`);
    if (extraDose) console.log(`   ✅ Extra dose from bracket: "${extraDose}"`);
    if (extraModifiers.length > 0) console.log(`   ✅ Extra modifiers: [${extraModifiers.join(', ')}]`);
    console.log(`   📝 After brand extraction: "${nameAfterBrand}"`);
  }

  if (nameAfterBrand.includes('[') && nameAfterBrand.includes(']') && nameAfterBrand.includes(' / ')) {
    if (!extractedIngredient && !extraDose) {
      let result = nameAfterBrand;
      if (durationMod) result += ` ${durationMod}`;
      if (debug) console.log(`   ✅ Final Result: "${result}"`);
      return result;
    }
  }

  if (extraDose && !extractedIngredient) {
    if (debug) console.log(`   🔄 Detected brand-first format with dose in bracket`);

    const result = parseBrandFirstFormat(brand, extraDose, extraModifiers, nameAfterBrand);
    if (result) {
      let finalResult = result;
      if (durationMod) finalResult += ` ${durationMod}`;
      if (debug) console.log(`   ✅ Final Result: "${finalResult}"`);
      return finalResult;
    }
  }

  const { container, cleanName: nameAfterContainer } = extractContainerSize(nameAfterBrand);
  if (container && debug) {
    console.log(`   ✅ Container: "${container}"`);
    console.log(`   📝 After container extraction: "${nameAfterContainer}"`);
  }

  if (nameAfterContainer.includes(' / ')) {
    if (debug) console.log(`   🔀 Detected combo product`);
    const parsed = parseComboProduct(nameAfterContainer);

    if (parsed) {
      const cleanIngredients: string[] = [];
      const prefixes: string[] = [];
      let comboDurationMod: string | null = null;

      for (const ing of parsed.ingredients.split(' / ')) {
        const { modifier: durMod1, cleanName: cleanIng1 } = extractDurationModifierFromEnd(ing);
        if (durMod1) comboDurationMod = durMod1;
        const { modifier: durMod2, cleanName: cleanIng2 } = extractDurationModifier(cleanIng1);
        if (durMod2) comboDurationMod = durMod2;
        const { prefix, cleanIngredient } = extractIngredientPrefix(cleanIng2);
        cleanIngredients.push(cleanIngredient);
        if (prefix) prefixes.push(prefix);
      }

      let doseForm = parsed.doseForm;
      if (prefixes.length > 0) {
        doseForm = doseForm + ' ' + prefixes.join(' ');
      }

      let result = `${brand} [${cleanIngredients.join(' / ')}] ${parsed.doses} ${doseForm}`;

      const allModifiers = [...extraModifiers, ...parsed.modifiers];
      if (allModifiers.length > 0) result += ' ' + allModifiers.join(' ');
      if (container) result += ` ${container}`;
      const finalDuration = durationMod || bracketDurationMod || comboDurationMod;
      if (finalDuration) result += ` ${finalDuration}`;
      if (extraDose) result += ` ${extraDose}`;

      if (debug) console.log(`   ✅ Result: "${result}"`);
      return result;
    }
    if (debug) console.log(`   ⚠️ Combo parsing failed, trying single-ingredient logic`);
  }

  const dosePos = findFirstDosePosition(nameAfterContainer);
  if (dosePos === -1) {
    if (debug) console.log(`   ❌ Could not find dose position`);
    return null;
  }
  if (debug) console.log(`   ✅ Dose position: ${dosePos}`);

  let ingredientPart = nameAfterContainer.substring(0, dosePos).trim();
  if (debug) console.log(`   📝 Raw ingredient: "${ingredientPart}"`);

  if (extractedIngredient) {
    ingredientPart = extractedIngredient;
    if (debug) console.log(`   📝 Using extracted ingredient: "${ingredientPart}"`);
  }

  const { modifier: ingDurationMod, cleanName: cleanIngredient1 } = extractDurationModifierFromEnd(ingredientPart);
  if (ingDurationMod) {
    if (debug) console.log(`   ✅ Duration modifier from ingredient: "${ingDurationMod}"`);
    ingredientPart = cleanIngredient1;
  }

  const { modifier: releaseMod, cleanIngredient } = extractReleaseModifier(ingredientPart);
  if (releaseMod) {
    if (debug) console.log(`   ✅ Release modifier: "${releaseMod}"`);
    ingredientPart = cleanIngredient;
  }

  const { prefix: ingredientPrefix, cleanIngredient: finalIngredient } = extractIngredientPrefix(ingredientPart);
  if (ingredientPrefix && debug) {
    console.log(`   ✅ Ingredient prefix: "${ingredientPrefix}"`);
  }
  ingredientPart = finalIngredient;

  const afterIngredient = nameAfterContainer.substring(dosePos);
  if (debug) console.log(`   📝 After ingredient: "${afterIngredient}"`);

  const doseFormMatch = afterIngredient.match(/^(\d+(?:\.\d+)?)\s*(\S+(?:\/\S+)?)\s*(.*)$/);
  if (!doseFormMatch) {
    if (debug) console.log(`   ❌ Could not parse dose/doseform`);
    return null;
  }

  const dose = `${doseFormMatch[1]} ${doseFormMatch[2].toUpperCase()}`;
  let doseForm = doseFormMatch[3].trim();

  if (ingredientPrefix) {
    doseForm = doseForm + ' ' + ingredientPrefix;
  }

  if (debug) console.log(`   ✅ Dose: "${dose}", DoseForm: "${doseForm}"`);

  let result = `${brand} [${ingredientPart}] ${dose} ${doseForm}`;
  if (releaseMod) result += ` ${releaseMod}`;
  if (extraModifiers.length > 0) result += ' ' + extraModifiers.join(' ');
  if (container) result += ` ${container}`;
  const finalDuration = durationMod || ingDurationMod || bracketDurationMod;
  if (finalDuration) result += ` ${finalDuration}`;
  if (extraDose) result += ` ${extraDose}`;

  if (debug) console.log(`   ✅ Final Result: "${result}"`);
  return result;
}

// =============================================================================
// TEST CASES
// =============================================================================

function runTests(): void {
  console.log('\n🧪 Running test cases:\n');

  const testCases = [
    { input: '12 HR carbamazepine 200 MG Extended Release Oral Capsule [Equetro]', expected: 'Equetro [carbamazepine] 200 MG Extended Release Oral Capsule 12 HR' },
    { input: 'chlorambucil 2 MG Oral Tablet [Leukeran]', expected: 'Leukeran [chlorambucil] 2 MG Oral Tablet' },
    { input: 'acetaminophen 325 MG / oxycodone 5 MG Oral Tablet [Percocet]', expected: 'Percocet [acetaminophen / oxycodone] 325 MG / 5 MG Oral Tablet' },
    { input: '0.1 ML adalimumab 100 MG/ML Prefilled Syringe [Humira]', expected: 'Humira [adalimumab] 100 MG/ML Prefilled Syringe 0.1 ML' },
    { input: '26 ML ustekinumab 5 MG/ML Injection [Stelara]', expected: 'Stelara [ustekinumab] 5 MG/ML Injection 26 ML' },
    { input: 'NDA020983 200 ACTUAT albuterol 0.09 MG/ACTUAT Metered Dose Inhaler [Ventolin]', expected: 'Ventolin [albuterol] 0.09 MG/ACTUAT Metered Dose Inhaler 200 ACTUAT' },
    { input: 'ProAir [NDA021457 200 ACTUAT albuterol] 0.09 MG/ACTUAT Metered Dose Inhaler', expected: 'ProAir [albuterol] 0.09 MG/ACTUAT Metered Dose Inhaler 200 ACTUAT' },
    { input: 'Albenza [albendazole] 200 MG Oral Tablet', expected: 'Albenza [albendazole] 200 MG Oral Tablet' },
    { input: '21 DAY ethinyl estradiol 0.000625 MG/HR / etonogestrel 0.005 MG/HR Vaginal System [NuvaRing]', expected: 'NuvaRing [ethinyl estradiol / etonogestrel] 0.000625 MG/HR / 0.005 MG/HR Vaginal System 21 DAY' },
    { input: 'Aptensio [40/60 Release 24 HR methylphenidate hydrochloride] 50 MG Extended Release Oral Capsule', expected: 'Aptensio [methylphenidate hydrochloride] 50 MG Extended Release Oral Capsule 40/60 Release 24 HR' },
    { input: 'Rytary [8 HR carbidopa / levodopa] 48.75 MG / 195 MG Extended Release Oral Capsule', expected: 'Rytary [carbidopa / levodopa] 48.75 MG / 195 MG Extended Release Oral Capsule 8 HR' },
    { input: 'Ozempic [0.25 MG,] 0.5 MG Dose 1.5 ML semaglutide 1.34 MG/ML Pen Injector', expected: 'Ozempic [semaglutide] 1.34 MG/ML Pen Injector 0.25 MG 0.5 MG Dose 1.5 ML' },
    { input: 'Ozempic [0.25 MG,] 0.5 MG Dose 3 ML semaglutide 0.68 MG/ML Pen Injector', expected: 'Ozempic [semaglutide] 0.68 MG/ML Pen Injector 0.25 MG 0.5 MG Dose 3 ML' },
    { input: 'rotavirus vaccine, live attenuated, G1P[8] human 89-12 strain 667000 UNT/ML Oral Suspension [Rotarix]', expected: 'Rotarix [rotavirus vaccine, live attenuated, G1P[8] human 89-12 strain] 667000 UNT/ML Oral Suspension' },
    { input: 'Rituxan Hycela [hyaluronidase, human recombinant / rituximab 2000 UNT/ML / 120 MG/ML Injection 11.7 ML', expected: 'Rituxan Hycela [hyaluronidase, human recombinant / rituximab] 2000 UNT/ML / 120 MG/ML Injection 11.7 ML' },
    { input: 'capsaicin 0.35 MG/ML / lidocaine 20 MG/ML / menthol 50 MG/ML / methyl salicylate 200 MG/ML Topical Cream [Medi-Derm with Lidocaine]', expected: 'Medi-Derm with Lidocaine [capsaicin / lidocaine / menthol / methyl salicylate] 0.35 MG/ML / 20 MG/ML / 50 MG/ML / 200 MG/ML Topical Cream' },
    { input: '120 ACTUAT budesonide 0.16 MG/ACTUAT / formoterol fumarate 0.0045 MG/ACTUAT Metered Dose Inhaler [Symbicort]', expected: 'Symbicort [budesonide / formoterol fumarate] 0.16 MG/ACTUAT / 0.0045 MG/ACTUAT Metered Dose Inhaler 120 ACTUAT' },
    { input: 'Annovera [273 DAY ethinyl estradiol] 0.000542 MG/HR / segesterone acetate 0.00625 MG/HR Vaginal System', expected: 'Annovera [ethinyl estradiol / segesterone acetate] 0.000542 MG/HR / 0.00625 MG/HR Vaginal System 273 DAY' },
    { input: 'Tylenol [acetaminophen] 500 MG Oral Tablet', expected: 'Tylenol [acetaminophen] 500 MG Oral Tablet' },
    { input: 'Xanax [alprazolam] 1 MG Extended Release Oral Tablet 24 HR', expected: 'Xanax [alprazolam] 1 MG Extended Release Oral Tablet 24 HR' },
    { input: 'Gocovri [amantadine] 137 MG Extended Release Oral Capsule 24 HR', expected: 'Gocovri [amantadine] 137 MG Extended Release Oral Capsule 24 HR' },
    { input: '250 ML sipuleucel-T 200000 CELLS/ML Injection [Provenge]', expected: 'Provenge [sipuleucel-T] 200000 CELLS/ML Injection 250 ML' },
    { input: '68 ML axicabtagene ciloleucel 2940000 CELLS/ML Injection [Yescarta]', expected: 'Yescarta [axicabtagene ciloleucel] 2940000 CELLS/ML Injection 68 ML' },
    { input: 'Preservative-Free timolol 5 MG/ML Ophthalmic Solution [Timoptic]', expected: 'Timoptic [timolol] 5 MG/ML Ophthalmic Solution Preservative-Free' },
    { input: 'Once-Daily clindamycin 0.01 MG/MG Topical Gel [Clindagel]', expected: 'Clindagel [clindamycin] 0.01 MG/MG Topical Gel Once-Daily' },
    { input: 'acetaminophen 325 MG Oral Tablet', expected: null },
  ];

  let passed = 0, failed = 0;

  for (const tc of testCases) {
    const result = reformatSBDName(tc.input, false);
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
// SPACE HELPERS
// =============================================================================

async function detectSpaceType(spaceId: string): Promise<{ type: 'PERSONAL' | 'DAO'; address?: string }> {
  const query = `query GetSpaceType { space(id: "${spaceId}") { id type address } }`;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = await res.json() as any;
  if (json.errors) {
    console.error('❌ Failed to query space:', json.errors[0].message);
    process.exit(1);
  }
  if (!json.data?.space) {
    console.error(`❌ Space not found: ${spaceId}`);
    process.exit(1);
  }
  return {
    type: json.data.space.type as 'PERSONAL' | 'DAO',
    address: json.data.space.address
  };
}

// =============================================================================
// QUERY SBD ENTITIES
// =============================================================================

async function fetchSBDEntities(spaceId: string): Promise<Array<{ id: string; name: string }>> {
  const SBD_TYPE_ID = TYPE_IDS.SBD;
  console.log(`\n🔍 Querying SBD entities (type: ${SBD_TYPE_ID})...`);

  const entities: Array<{ id: string; name: string }> = [];
  let cursor: string | null = null;
  let batchNum = 0;

  while (true) {
    batchNum++;
    const afterParam = cursor ? `, after: "${cursor}"` : '';

    const query = `{
      entitiesConnection(
        spaceId: "${spaceId}",
        typeId: "${SBD_TYPE_ID}",
        first: 1000${afterParam}
      ) {
        nodes { id name }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    const json = await res.json() as any;

    if (json.errors) {
      console.error(`❌ Query error on batch ${batchNum}:`, json.errors[0].message);
      break;
    }

    const nodes = json.data?.entitiesConnection?.nodes || [];
    const pageInfo = json.data?.entitiesConnection?.pageInfo;

    entities.push(...nodes);
    console.log(`   Batch ${batchNum}: ${nodes.length} SBDs (total: ${entities.length.toLocaleString()})`);

    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;

    await new Promise(r => setTimeout(r, 50));
  }

  return entities;
}

// =============================================================================
// PUBLISHING
// =============================================================================

async function publishInBatches(
  allOps: any[],
  spaceInfo: { type: 'PERSONAL' | 'DAO'; address?: string },
  spaceId: string,
  smartAccount: any,
  personalSpaceId: string | undefined,
  proposalName: string
): Promise<void> {

  const batchSize = spaceInfo.type === 'DAO' ? 2000 : 80000;
  const totalBatches = Math.ceil(allOps.length / batchSize);

  console.log(`\n📦 Publishing ${totalBatches} batch(es) to ${spaceInfo.type} space...`);
  console.log(`   Batch size: ${batchSize.toLocaleString()} ops\n`);

  for (let i = 0; i < totalBatches; i++) {
    const batch = allOps.slice(i * batchSize, (i + 1) * batchSize);
    const batchNum = i + 1;

    const batchName = `${proposalName} (Batch ${batchNum}/${totalBatches})`;
    console.log(`Batch ${batchNum}/${totalBatches} (${batch.length.toLocaleString()} ops)...`);
    console.log(`   Name: "${batchName.substring(0, 60)}${batchName.length > 60 ? '...' : ''}"`);

    try {
      let to: `0x${string}`;
      let calldata: `0x${string}`;
      let cid: string;

      if (spaceInfo.type === 'DAO') {
        const result = await daoSpace.proposeEdit({
          name: batchName,
          ops: batch,
          author: personalSpaceId!.replace(/-/g, ''),
          daoSpaceAddress: spaceInfo.address as `0x${string}`,
          callerSpaceId: '0x' + personalSpaceId!.replace(/-/g, ''),
          daoSpaceId: '0x' + spaceId.replace(/-/g, ''),
          network: 'TESTNET',
        });
        cid = result.cid;
        to = result.to;
        calldata = result.calldata;
        console.log(`   📝 Proposal ID: ${result.proposalId}`);
      } else {
        const result = await personalSpace.publishEdit({
          name: batchName,
          spaceId: spaceId.replace(/-/g, ''),
          ops: batch,
          author: spaceId.replace(/-/g, ''),
          network: 'TESTNET',
        });
        cid = result.cid;
        to = result.to;
        calldata = result.calldata;
        console.log(`   📝 IPFS: ${cid}`);
      }

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`   ✅ Broadcast: ${txHash}`);
      console.log(`   🔍 https://sepolia.basescan.org/tx/${txHash}\n`);

      if (batchNum < totalBatches) await new Promise(r => setTimeout(r, 3000));
    } catch (e: any) {
      console.error(`   ❌ Batch ${batchNum} failed:`, e.message);
      throw e;
    }
  }

  console.log('✅ All batches broadcast!\n');
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes('--dry-run');
  const TEST_ONLY = args.includes('--test');
  const proposalName = (() => {
    const idx = args.indexOf('--proposal-name');
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : 'Reformat SBD names';
  })();

  console.log('\n🚀 Reformat SBD Names v3');

  if (TEST_ONLY) {
    runTests();
    console.log('✅ Test-only mode complete.\n');
    return;
  }

  if (DRY_RUN) console.log('   🔍 DRY RUN - no changes will be published');
  console.log('');

  const spaceId = process.env.GEO_SPACE_ID;
  const personalSpaceId = process.env.GEO_PERSONAL_SPACE_ID;
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;

  if (!spaceId) {
    console.error('❌ Missing GEO_SPACE_ID');
    process.exit(1);
  }

  if (!TYPE_IDS.SBD) {
    console.error('❌ TYPE_IDS.SBD not defined in constants.ts');
    process.exit(1);
  }

  const spaceInfo = await detectSpaceType(spaceId);

  if (spaceInfo.type === 'DAO' && !personalSpaceId) {
    console.error('❌ GEO_PERSONAL_SPACE_ID required for DAO space');
    process.exit(1);
  }

  console.log(`📋 Space: ${spaceId} (${spaceInfo.type})\n`);

  const entities = await fetchSBDEntities(spaceId);

  if (entities.length === 0) {
    console.log('\n⚠️  No SBD entities found.\n');
    return;
  }

  const reformattable: Array<{ id: string; oldName: string; newName: string }> = [];
  const failed: Array<{ id: string; name: string }> = [];

  for (const entity of entities) {
    const newName = reformatSBDName(entity.name);

    if (newName) {
      if (newName !== entity.name) {
        reformattable.push({
          id: entity.id,
          oldName: entity.name,
          newName: newName
        });
      }
    } else {
      failed.push({
        id: entity.id,
        name: entity.name
      });
    }
  }

  console.log(`\n📊 Parsing Results:`);
  console.log(`   Total SBDs: ${entities.length}`);
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
    failed.forEach((e, i) => {
      console.log(`   ${i + 1}. "${e.name}"`);
    });
  } else if (failed.length > 50) {
    console.log(`\n❌ Failed to parse: ${failed.length} (showing first 30)`);
    failed.slice(0, 30).forEach((e, i) => {
      console.log(`   ${i + 1}. "${e.name}"`);
    });
  }

  if (DRY_RUN) {
    console.log('\n✅ Dry run complete. No changes published.\n');
    return;
  }

  if (reformattable.length === 0) {
    console.log('\n✅ No entities need reformatting. Done.\n');
    return;
  }

  let smartAccount: any = null;
  if (!privateKeyRaw) {
    console.error('❌ Missing GEO_WALLET_PRIVATE_KEY');
    process.exit(1);
  }
  const privateKey = (privateKeyRaw?.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  smartAccount = await getSmartAccountWalletClient({ privateKey });
  console.log(`✅ Wallet ready\n`);

  const allOps: any[] = [];

  for (const entity of reformattable) {
    const result = Graph.updateEntity({
      id: entity.id,
      name: entity.newName,
    });
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

  if (!confirmed) {
    console.log('❌ Aborted.\n');
    return;
  }

  await publishInBatches(allOps, spaceInfo, spaceId, smartAccount, personalSpaceId, proposalName);
}

main().catch(console.error);
