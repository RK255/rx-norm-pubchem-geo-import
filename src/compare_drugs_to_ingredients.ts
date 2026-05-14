// src/compare_drugs_to_ingredients.ts
// Compare Drug entities against our Ingredient dataset

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data_to_publish');
const DEFAULT_DRUGS_FILE = path.join(__dirname, '..', 'exports', 'drugs_996487d85cc097dffff4b672d3247841.json');
const INGREDIENTS_FILE = path.join(DATA_DIR, 'full_geo_extraction_v22.jsonl');
const OUTPUT_DIR = path.join(__dirname, '..', 'exports');

// =============================================================================
// LOAD DATA
// =============================================================================

interface DrugEntity {
  id: string;
  name: string;
  values: { nodes: Array<{ property: { id: string; name: string }; text?: string }> };
  relations: { nodes: Array<{ typeId: string; toEntityId: string; toEntity?: { id: string; name: string } }> };
}

interface Ingredient {
  rxcui: string;
  name: string;
  connections?: any;
}

function loadDrugs(drugsFile: string): DrugEntity[] {
  console.log('\n📂 Loading Drugs...');
  
  if (!fs.existsSync(drugsFile)) {
    console.error(`❌ Drugs file not found: ${drugsFile}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(drugsFile, 'utf-8'));
  console.log(`   Loaded ${data.drugs.length} drugs from ${path.basename(drugsFile)}`);
  return data.drugs;
}

function loadIngredients(): Map<string, Ingredient> {
  console.log('\n📂 Loading Ingredients...');
  const ingredientMap = new Map<string, Ingredient>();
  
  if (!fs.existsSync(INGREDIENTS_FILE)) {
    console.error(`❌ Ingredients file not found: ${INGREDIENTS_FILE}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(INGREDIENTS_FILE, 'utf-8').split('\n').filter(l => l.trim());
  
  // Track unique entity types for stats
  const typeCounts: Record<string, number> = {};
  
  for (const line of lines) {
    try {
      const entity = JSON.parse(line);
      const entityType = entity.entity_type || 'unknown';
      typeCounts[entityType] = (typeCounts[entityType] || 0) + 1;
      
      // Load INs (Ingredients)
      if (entityType === 'IN' && entity.name && entity.rxcui) {
        const normalizedName = entity.name.toLowerCase().trim();
        ingredientMap.set(normalizedName, {
          rxcui: entity.rxcui,
          name: entity.name,
          connections: entity.connections
        });
      }
    } catch (e) {
      // Skip parse errors
    }
  }

  console.log(`   Loaded ${ingredientMap.size} ingredients (IN entities)`);
  console.log(`   Entity types in file: ${Object.entries(typeCounts).map(([t, c]) => `${t}: ${c}`).join(', ')}`);
  return ingredientMap;
}

// =============================================================================
// COMPARISON
// =============================================================================

interface ComparisonResult {
  drugId: string;
  drugName: string;
  matched: boolean;
  matchedRxcui?: string;
  matchedIngredientName?: string;
  matchType?: 'exact' | 'normalized';
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function compareDrugsToIngredients(
  drugs: DrugEntity[],
  ingredientMap: Map<string, Ingredient>
): { results: ComparisonResult[]; stats: any } {
  
  console.log('\n🔍 Comparing Drugs to Ingredients...');
  
  const results: ComparisonResult[] = [];
  const matched: ComparisonResult[] = [];
  const unmatched: ComparisonResult[] = [];

  for (const drug of drugs) {
    const drugName = drug.name?.trim() || '';
    const drugNameNormalized = normalizeName(drugName);
    
    // Try exact match first
    let ingredient = ingredientMap.get(drugNameNormalized);
    let matchType: 'exact' | 'normalized' | undefined = 'exact';
    
    if (!ingredient) {
      // Try variations: remove parentheses content, handle "X / Y" combos
      const baseName = drugNameNormalized.replace(/\s*$$[^)].*$$\s*/g, '').trim();
      ingredient = ingredientMap.get(baseName);
      if (ingredient) matchType = 'normalized';
    }
    
    if (!ingredient) {
      // Try matching just the first word (for cases like "Vitamin D3 supplementation")
      const firstWord = drugNameNormalized.split(/\s+/)[0];
      if (firstWord && firstWord.length > 3) { // Avoid matching short words
        ingredient = ingredientMap.get(firstWord);
        if (ingredient) matchType = 'normalized';
      }
    }
    
    const result: ComparisonResult = {
      drugId: drug.id,
      drugName: drugName,
      matched: !!ingredient,
      matchedRxcui: ingredient?.rxcui,
      matchedIngredientName: ingredient?.name,
      matchType: ingredient ? matchType : undefined
    };
    
    results.push(result);
    
    if (ingredient) {
      matched.push(result);
    } else {
      unmatched.push(result);
    }
  }

  const stats = {
    totalDrugs: drugs.length,
    matched: matched.length,
    unmatched: unmatched.length,
    matchRate: ((matched.length / drugs.length) * 100).toFixed(1),
    matchedExact: matched.filter(r => r.matchType === 'exact').length,
    matchedNormalized: matched.filter(r => r.matchType === 'normalized').length,
  };

  return { results, stats };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const drugsFile = args.find(a => !a.startsWith('--')) || DEFAULT_DRUGS_FILE;

  console.log('\n🚀 Compare Drugs to Ingredients v1\n');

  // Load data
  const drugs = loadDrugs(drugsFile);
  const ingredientMap = loadIngredients();

  // Compare
  const { results, stats } = compareDrugsToIngredients(drugs, ingredientMap);

  // Print results
  console.log(`\n📊 Comparison Results:`);
  console.log(`   Total Drugs: ${stats.totalDrugs}`);
  console.log(`   Matched: ${stats.matched} (${stats.matchRate}%)`);
  console.log(`      - Exact match: ${stats.matchedExact}`);
  console.log(`      - Normalized match: ${stats.matchedNormalized}`);
  console.log(`   Unmatched: ${stats.unmatched}`);

  // Show unmatched drugs
  const unmatchedResults = results.filter(r => !r.matched);
  if (unmatchedResults.length > 0) {
    console.log(`\n❌ Unmatched Drugs (${unmatchedResults.length}):`);
    unmatchedResults.forEach((r, i) => {
      console.log(`   ${i + 1}. "${r.drugName}"`);
    });
  }

  // Show matched drugs sample
  const matchedResults = results.filter(r => r.matched);
  if (matchedResults.length > 0) {
    console.log(`\n✅ Matched Drugs (sample of 20):`);
    matchedResults.slice(0, 20).forEach((r, i) => {
      const matchType = r.matchType === 'normalized' ? ' [normalized]' : '';
      console.log(`   ${i + 1}. "${r.drugName}" → "${r.matchedIngredientName}" (RxCUI: ${r.matchedRxcui})${matchType}`);
    });
    if (matchedResults.length > 20) {
      console.log(`   ... and ${matchedResults.length - 20} more`);
    }
  }

  // Save results
  const baseName = path.basename(drugsFile, '.json');
  const outputFile = path.join(OUTPUT_DIR, `comparison_${baseName}.json`);
  
  const output = {
    comparedAt: new Date().toISOString(),
    statistics: stats,
    matched: matchedResults,
    unmatched: unmatchedResults,
    allResults: results
  };

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`\n💾 Results saved to: ${outputFile}\n`);
}

main().catch(console.error);
