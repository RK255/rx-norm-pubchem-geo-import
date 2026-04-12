// src/extract_from_master.ts
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

// --- Configuration ---
const DATA_DIR = path.join(__dirname, '..', 'data_to_publish');
const MASTER_FILE = path.join(DATA_DIR, 'full_geo_extraction.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'test_5_from_master.json');

// --- Types ---
interface Ingredient {
  rxcui: string;
  name: string;
  cid: string;
  smiles: string;
  inchi_key: string;
  pmid: string;
  connections: {
    scd?: Array<{ rxcui: string; name: string; tty: string }>;
    sbd?: Array<{ rxcui: string; name: string; tty: string; brand_name?: { rxcui: string; name: string; tty: string } }>;
    bn?: Array<{ rxcui: string; name: string; tty: string }>;
    min?: Array<{ rxcui: string; name: string; tty: string }>;
    pin?: Array<{ rxcui: string; name: string; tty: string }>;
    df?: Array<{ rxcui: string; name: string; tty: string }>;
    [key: string]: any;
  };
}

interface OutputEntity {
  id: string;
  typeId: string;
  rxcui: string;
  name: string;
  relations: { [key: string]: any }; 
  [key: string]: any;
}

async function runExtraction() {
  console.log('🔨 Extracting 5 Ingredients (Forward Links Only)...');

  if (!fs.existsSync(MASTER_FILE)) {
    console.error(`❌ Master file not found: ${MASTER_FILE}`);
    process.exit(1);
  }

  const rawData = fs.readFileSync(MASTER_FILE, 'utf-8');
  const ingredients: Ingredient[] = JSON.parse(rawData);
  console.log(`📦 Loaded ${ingredients.length} ingredients from Master.`);

  // Isolate first 5
  const testIngredients = ingredients.slice(0, 5);
  console.log(`🧪 Isolated ${testIngredients.length} ingredients for testing.`);

  const entityMap = new Map<string, OutputEntity>();

  const TTY_TO_TYPE_ID: { [key: string]: string } = {
    'in': 'b1bb9b33cdd247dfaf02ad98506c39eb',
    'bn': '402cae0b9c17472586a2236f70492d7b',
    'df': '06e2222273114885b32b3a1368d2d266',
    'sbd': '2033a9f3942a4c828dcdfe0411609450',
    'scd': 'a844e0f3a48d4e82b234da893aee4291',
    'min': 'f0250a1cc9e8431980b3e9d7661e08f9',
    'pin': '4ba36be2740b4f36aa7c31512869bb3c',
  };

  const TTY_TO_RELATION_ID: { [key: string]: string } = {
    'scd': 'c1617a1e32844adeb5ff4c4445dc2ba6',
    'sbd': 'da89d8e2f052468f92ae5e8557ff1e78',
    'bn': '3f30135c25394a0bb6ae429ef87337e1',
    'min': 'e8885ee2b8674952b2538ad4eee058e2',
    'pin': '5d5602ac0fe64f4dbdc345c0bdf09d72',
    'df': '88a39df4de3542b8a6b0155750617b76',
  };

  function generateUuid(rxcui: string, typeId: string): string {
    const seed = `${typeId}:${rxcui}`;
    const hash = createHash('sha256').update(seed).digest('hex');
    return [
      hash.substring(0, 8),
      hash.substring(8, 12),
      hash.substring(12, 16),
      hash.substring(16, 20),
      hash.substring(20, 32)
    ].join('-');
  }

  function getEntity(id: string, typeId: string, rxcui: string, name: string): OutputEntity {
    if (!entityMap.has(id)) {
      const entity: OutputEntity = {
        id,
        typeId,
        rxcui,
        name,
        relations: {}, // <--- ENSURE EVERY ENTITY HAS A RELATIONS OBJECT
      };
      entityMap.set(id, entity);
    }
    return entityMap.get(id)!;
  }

  testIngredients.forEach((ing) => {
    // 1. Create the Ingredient Entity
    const ingId = generateUuid(ing.rxcui, TTY_TO_TYPE_ID['in']);
    const ingEntity = getEntity(ingId, TTY_TO_TYPE_ID['in'], ing.rxcui, ing.name);
    
    // Add PubChem Properties
    ingEntity.CID = ing.cid;
    ingEntity.SMILES = ing.smiles;
    ingEntity.INCHIKEY = ing.inchi_key;
    ingEntity.PMID = ing.pmid;

    // 2. Process Connections (Create Related Entities)
    Object.entries(ing.connections).forEach(([tty, connList]) => {
      if (!Array.isArray(connList) || connList.length === 0) return;
      
      const relatedTypeId = TTY_TO_TYPE_ID[tty];
      const relationId = TTY_TO_RELATION_ID[tty];
      
      if (!relatedTypeId || !relationId) return;

      // Initialize the relation array on the ingredient
      if (!ingEntity.relations[relationId]) {
        ingEntity.relations[relationId] = [];
      }

      connList.forEach((conn: any) => {
        // Create the Related Entity
        const connId = generateUuid(conn.rxcui, relatedTypeId);
        const relatedEntity = getEntity(connId, relatedTypeId, conn.rxcui, conn.name);

        // Link Ingredient -> Related Entity
        (ingEntity.relations[relationId] as string[]).push(connId);

        // NO RECIPROCAL LINKS FOR NOW
      });
    });
  });

  const allEntities = Array.from(entityMap.values());

  console.log(`✅ Extracted ${allEntities.length} entities (Ingredients + Related).`);
  console.log(`📝 Saving to ${OUTPUT_FILE}...`);
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allEntities, null, 2));
  console.log('✅ Done.');
}

runExtraction().catch(console.error);
