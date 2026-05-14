// src/clean_and_compare_drugs.ts
// Filter non-drugs and compare against ingredients

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data_to_publish');
const DRUGS_FILE = path.join(__dirname, '..', 'exports', 'drugs_996487d85cc097dffff4b672d3247841.json');
const INGREDIENTS_FILE = path.join(DATA_DIR, 'full_geo_extraction_v22.jsonl');
const OUTPUT_DIR = path.join(__dirname, '..', 'exports');

// Non-drug patterns to filter out
const NON_DRUG_PATTERNS = [
  /^(No|None|Not)\s/i, // "No FDA-approved...", "No disease-modifying..."
  /\b(therapy|therapies|treatment)\b/i, // Contains therapy/treatment
  /\b(procedure|surgery|surgical)\b/i,
  /^(ICD|ERCP|Pacemaker|Appendectomy|Cholecystectomy|Herniorrhaphy|Nephrolithotomy|Ureteroscopy|Phlebotomy|Transplant)/i,
  /\b(infusion|resuscitation|cooling|immersion)\b/i,
  /^Hyperbaric oxygen/i,
  /^Supportive (ICU|care)/i,
  /^Wound care/i,
  /^Dietary/i,
  /diet\b/i,
  /^Fat-soluble/i,
  /^Protein-restricted/i,
  /restriction\b/i,
  /^Emergency glucose/i,
  /^Hydration$/i,
  /^Glucose$/i,
  /^\d+$/, // Just numbers like "3"
  /^H[12]$/, // "H1", "H2" by themselves (not H1/H2 antihistamines)
  /^Gene therapy/i,
  /^Tumor treating fields/i,
  /^Hematopoietic stem cell/i,
  /^(Combined )?Oral contraceptives$/i,
  /^Antibiotics$/i,
  /^Anticoagulants$/i,
  /^Anticonvulsants$/i,
  /^Corticosteroids$/i,
  /^NSAIDs?$/i,
  /^H[12] antihistamines$/i,
  /^Lipid-lowering/i,
  /^Antimicrobial prophylaxis$/i,
  /^Antioxidants$/i,
  /^Androgens$/i,
  /^Hormone replacement$/i,
  /^Iron$/i,
  /^Copper$/i,
  /^Zinc$/i,
  /^Selenium$/i,
  /^Cysteine$/i,
  /^Phosphate$/i,
  /^Mannose$/i,
  /^Biotin$/i,
  /^Zinc supplementation$/i,
  /^Vitamin [CD] supplementation$/i,
  /^Thiamine supplementation$/i,
  /^Carnitine supplementation$/i,
  /^Cysteine supplementation$/i,
  /^Mannose supplementation$/i,
  /^Iron supplementation$/i,
  /^Calcium supplementation$/i,
];

// =============================================================================
// LOAD DATA
// =============================================================================

function loadDrugs(): any[] {
  console.log('\n📂 Loading Drugs...');
  const data = JSON.parse(fs.readFileSync(DRUGS_FILE, 'utf-8'));
  console.log(`   Loaded ${data.drugs.length} drug entries`);
  return data.drugs;
}

function loadIngredients(): Map<string, { rxcui: string; name: string }> {
  console.log('\n📂 Loading Ingredients...');
  const ingredientMap = new Map<string, { rxcui: string; name: string }>();
  
  if (!fs.existsSync(INGREDIENTS_FILE)) {
    console.error(`❌ Ingredients file not found: ${INGREDIENTS_FILE}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(INGREDIENTS_FILE, 'utf-8').split('\n').filter(l => l.trim());
  
  // First, let's see the structure
  let sampleParsed: any = null;
  const fieldStats: Record<string, number> = {};
  
  for (const line of lines.slice(0, 5)) {
    try {
      sampleParsed = JSON.parse(line);
      console.log(`   Sample record fields: ${Object.keys(sampleParsed).join(', ')}`);
      break;
    } catch (e) {}
  }
  
  // Count all unique fields
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      for (const key of Object.keys(obj)) {
        fieldStats[key] = (fieldStats[key] || 0) + 1;
      }
    } catch (e) {}
  }
  
  console.log(`   File has ${lines.length} lines`);
  console.log(`   Fields found: ${Object.entries(fieldStats).map(([k, v]) => `${k}(${v})`).join(', ')}`);

  // Now load - check for common field names
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      
      // Try common field name variations
      const name = obj.name || obj.ingredient_name || obj.IN || obj.drug_name || '';
      const rxcui = obj.rxcui || obj.RxCUI || obj.rxcui_code || obj.id || '';
      
      if (name && rxcui) {
        const normalizedName = name.toLowerCase().trim();
        ingredientMap.set(normalizedName, { rxcui, name });
      } else if (name) {
        // Some entries might not have rxcui
        const normalizedName = name.toLowerCase().trim();
        if (!ingredientMap.has(normalizedName)) {
          ingredientMap.set(normalizedName, { rxcui: rxcui || 'unknown', name });
        }
      }
    } catch (e) {}
  }

  console.log(`   Loaded ${ingredientMap.size} unique ingredients`);
  
  // Show some sample names
  const sampleNames = [...ingredientMap.keys()].slice(0, 10);
  console.log(`   Sample ingredients: ${sampleNames.map(n => `"${n}"`).join(', ')}`);
  
  return ingredientMap;
}

// =============================================================================
// FILTER & COMPARE
// =============================================================================

function isNonDrug(name: string): boolean {
  for (const pattern of NON_DRUG_PATTERNS) {
    if (pattern.test(name)) {
      return true;
    }
  }
  return false;
}

function filterAndCompare(drugs: any[], ingredientMap: Map<string, any>) {
  console.log('\n🔍 Filtering non-drugs and comparing...');
  
  const filtered: { drug: any; reason: string }[] = [];
  const validDrugs: any[] = [];
  
  for (const drug of drugs) {
    const name = drug.name?.trim() || '';
    
    if (isNonDrug(name)) {
      filtered.push({ drug, reason: 'Non-drug pattern' });
    } else {
      validDrugs.push(drug);
    }
  }
  
  console.log(`\n📊 Filtering Results:`);
  console.log(`   Total entries: ${drugs.length}`);
  console.log(`   Filtered out: ${filtered.length}`);
  console.log(`   Valid drugs: ${validDrugs.length}`);
  
  // Show filtered items
  if (filtered.length > 0) {
    console.log(`\n   🚫 Filtered out (sample):`);
    filtered.slice(0, 20).forEach((f, i) => {
      console.log(`      ${i + 1}. "${f.drug.name}"`);
    });
    if (filtered.length > 20) {
      console.log(`      ... and ${filtered.length - 20} more`);
    }
  }
  
  // Now compare valid drugs to ingredients
  console.log(`\n🔍 Comparing ${validDrugs.length} valid drugs to ingredients...`);
  
  const matched: any[] = [];
  const unmatched: any[] = [];
  
  for (const drug of validDrugs) {
    const drugName = drug.name?.trim() || '';
    const drugNameLower = drugName.toLowerCase();
    
    // Try exact match
    let ingredient = ingredientMap.get(drugNameLower);
    let matchType = 'exact';
    
    // Try normalized (remove parentheses content)
    if (!ingredient) {
      const baseName = drugNameLower.replace(/\s*$$[^)]*$$\s*/g, ' ').trim();
      ingredient = ingredientMap.get(baseName);
      if (ingredient) matchType = 'normalized';
    }
    
    // Try matching first word for compounds
    if (!ingredient && drugNameLower.includes(' / ')) {
      const parts = drugNameLower.split(' / ').map(p => p.trim());
      for (const part of parts) {
        if (ingredientMap.has(part)) {
          ingredient = ingredientMap.get(part);
          matchType = 'partial';
          break;
        }
      }
    }
    
    const result = {
      drugId: drug.id,
      drugName,
      matched: !!ingredient,
      matchedRxcui: ingredient?.rxcui,
      matchedIngredientName: ingredient?.name,
      matchType
    };
    
    if (ingredient) {
      matched.push(result);
    } else {
      unmatched.push(result);
    }
  }
  
  console.log(`\n📊 Comparison Results:`);
  console.log(`   Matched: ${matched.length} (${((matched.length / validDrugs.length) * 100).toFixed(1)}%)`);
  console.log(`   Unmatched: ${unmatched.length}`);
  
  // Show matched sample
  if (matched.length > 0) {
    console.log(`\n   ✅ Matched (sample of 30):`);
    matched.slice(0, 30).forEach((m, i) => {
      const typeLabel = m.matchType !== 'exact' ? ` [${m.matchType}]` : '';
      console.log(`      ${i + 1}. "${m.drugName}" → "${m.matchedIngredientName}"${typeLabel}`);
    });
    if (matched.length > 30) {
      console.log(`      ... and ${matched.length - 30} more`);
    }
  }
  
  // Show unmatched
  if (unmatched.length > 0) {
    console.log(`\n   ❌ Unmatched valid drugs (${unmatched.length}):`);
    unmatched.forEach((u, i) => {
      console.log(`      ${i + 1}. "${u.drugName}"`);
    });
  }
  
  return { validDrugs, filtered, matched, unmatched };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log('\n🚀 Clean and Compare Drugs v1\n');

  const drugs = loadDrugs();
  const ingredientMap = loadIngredients();
  
  const results = filterAndCompare(drugs, ingredientMap);
  
  // Save results
  const outputFile = path.join(OUTPUT_DIR, 'drug_comparison_cleaned.json');
  fs.writeFileSync(outputFile, JSON.stringify({
    validDrugCount: results.validDrugs.length,
    filteredCount: results.filtered.length,
    matchedCount: results.matched.length,
    unmatchedCount: results.unmatched.length,
    matched: results.matched,
    unmatched: results.unmatched,
    filtered: results.filtered
  }, null, 2));
  
  console.log(`\n💾 Results saved to: ${outputFile}\n`);
}

main().catch(console.error);
