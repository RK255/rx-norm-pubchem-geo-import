// src/validate_connections.ts
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data_to_publish');
const MASTER_FILE = path.join(DATA_DIR, 'full_geo_extraction.json');

console.log(`🔍 Analyzing: ${MASTER_FILE}\n`);

if (!fs.existsSync(MASTER_FILE)) {
  console.error('❌ Master file not found.');
  process.exit(1);
}

const rawData = fs.readFileSync(MASTER_FILE, 'utf-8');
const ingredients = JSON.parse(rawData);

let orphans: any[] = [];
let connected: any[] = [];

ingredients.forEach((ing: any) => {
  const conns = ing.connections || {};
  
  // FIX: Iterate through the values to check if arrays are actually empty
  let hasAnyRelation = false;
  
  Object.values(conns).forEach((list: any) => {
    if (Array.isArray(list) && list.length > 0) {
      hasAnyRelation = true;
    }
  });

  if (hasAnyRelation) {
    connected.push(ing);
  } else {
    orphans.push(ing);
  }
});

console.log(`📊 Analysis Report (Checking Empty Arrays):`);
console.log(`   Total Ingredients:     ${ingredients.length}`);
console.log(`   Connected (have data): ${connected.length}`);
console.log(`   Orphans (no data):     ${orphans.length} (${(orphans.length/ingredients.length*100).toFixed(1)}%)`);

if (orphans.length > 0) {
  console.log(`\n🔍 Sample Orphans (First 10 - RxCUI only, no relations):`);
  orphans.slice(0, 10).forEach(o => console.log(`   - ${o.name} (RxCUI: ${o.rxcui})`));
}
