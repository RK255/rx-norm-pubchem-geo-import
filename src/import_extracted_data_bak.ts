// src/import_extracted_data.ts
import fs from 'fs';
import path from 'path';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import { TYPE_IDS, SOURCE_DATA_IDS } from './constants';

// --- Argument Parsing ---
const args = process.argv.slice(2);
const limitArgIndex = args.indexOf('--limit');
let INGREDIENT_LIMIT = 5; // Default

if (limitArgIndex !== -1 && args[limitArgIndex + 1]) {
  INGREDIENT_LIMIT = parseInt(args[limitArgIndex + 1], 10);
  if (isNaN(INGREDIENT_LIMIT)) {
    console.error('❌ Invalid value for --limit. Please provide a number.');
    process.exit(1);
  }
}

// --- Configuration ---
const DATA_DIR = path.join(__dirname, '..', 'data_to_publish');
const MASTER_FILE = path.join(DATA_DIR, 'full_geo_extraction.json'); 

// --- Types ---
interface Entity {
  id: string;
  typeId: string;
  rxcui: string;
  name: string;
  relations: { [key: string]: any };
  [key: string]: any;
}

async function runImport() {
  console.log(`🚀 Starting Import (Limit: ${INGREDIENT_LIMIT})...`);

  // 1. Load Environment Variables
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  const spaceId = process.env.GEO_SPACE_ID;

  if (!privateKeyRaw || !spaceId) {
    console.error('❌ Missing GEO_WALLET_PRIVATE_KEY or GEO_SPACE_ID in .env');
    process.exit(1);
  }

  const privateKey = privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`;

  // 2. Initialize Smart Account
  const smartAccount = await getSmartAccountWalletClient({ privateKey });
  console.log('✅ Smart Account Initialized.');

  // 3. Load Data
  if (!fs.existsSync(MASTER_FILE)) {
    console.error(`❌ Master file not found: ${MASTER_FILE}`);
    process.exit(1);
  }

  const rawData = fs.readFileSync(MASTER_FILE, 'utf-8');
  const allIngredients: Entity[] = JSON.parse(rawData);
  console.log(`📦 Loaded ${allIngredients.length} total ingredients from Master.`);

  // 4. Slice the data based on the limit
  const ingredientsToImport = allIngredients.slice(0, INGREDIENT_LIMIT);
  console.log(`🧪 Isolated ${ingredientsToImport.length} ingredients for import.`);

  // 4b. PRINT THE INGREDIENTS
  console.log('\n📋 Ingredients to be imported:');
  ingredientsToImport.forEach((ing, index) => {
    console.log(`   ${index + 1}. ${ing.name} (RxCUI: ${ing.rxcui})`);
  });
  console.log('');

  // 5. Expand these ingredients into ALL entities (Ingredients + Related)
  const entityMap = new Map<string, Entity>();
  const processedEntityIds = new Set<string>(); // FIX: Track processed IDs to avoid duplicates
  
  // Helper to generate IDs
  const crypto = require('crypto');
  function generateUuid(rxcui: string, typeId: string): string {
    const seed = `${typeId}:${rxcui}`;
    const hash = crypto.createHash('sha256').update(seed).digest('hex');
    return [
      hash.substring(0, 8),
      hash.substring(8, 12),
      hash.substring(12, 16),
      hash.substring(16, 20),
      hash.substring(20, 32)
    ].join('-');
  }

  // Type ID Mapping
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

  function getEntity(id: string, typeId: string, rxcui: string, name: string): Entity {
    if (!entityMap.has(id)) {
      const entity: Entity = {
        id,
        typeId,
        rxcui,
        name,
        relations: {},
      };
      entityMap.set(id, entity);
    } else {
      // If the entity already exists in our map, we need to MERGE relations, not overwrite them.
      // But for this script structure, we are building the relations map incrementally in the main loop.
      // So we can just return the existing entity.
    }
    return entityMap.get(id)!;
  }

  // Process the limited ingredients
  ingredientsToImport.forEach((ing) => {
    // 1. Create the Ingredient Entity
    const ingId = generateUuid(ing.rxcui, TTY_TO_TYPE_ID['in']);
    const ingEntity = getEntity(ingId, TTY_TO_TYPE_ID['in'], ing.rxcui, ing.name);
    
    // Copy Properties from master file if they exist
    if ((ing as any).smiles) ingEntity.SMILES = (ing as any).smiles;
    if ((ing as any).pmid) ingEntity.PMID = (ing as any).pmid;
    if ((ing as any).inchi_key) ingEntity.INCHIKEY = (ing as any).inchi_key;

    // 2. Process Connections (Create Related Entities)
    const connections = (ing as any).connections || {};
    
    Object.entries(connections).forEach(([tty, connList]) => {
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
      });
    });
  });

  const allEntities = Array.from(entityMap.values());

  // 6. Create a lookup of ID -> TypeID for ALL entities in this batch
  const entityLookup = new Map<string, string>();
  allEntities.forEach(e => entityLookup.set(e.id, e.typeId));

  console.log(`🔄 Generating operations for ${allEntities.length} total entities...`);
  const allOps: any[] = [];

  // --- Property IDs ---
  const PROP_IDS = {
    NAME: 'a126ca530c8e48d5b88882c734c38935',
    RXCUI: 'e6c50e227460442cab646a48f235459a',
    SMILES: SOURCE_DATA_IDS.SMILES,
    PMID: SOURCE_DATA_IDS.PMID,
    INCHIKEY: SOURCE_DATA_IDS.INCHI_KEY,
  };

  allEntities.forEach((entity) => {
    // FIX: Check if we've already processed this entity ID
    if (processedEntityIds.has(entity.id)) {
      console.log(`⏭️  Skipping duplicate entity processing: ${entity.name} (${entity.id})`);
      return; // Skip this iteration entirely
    }
    
    // Mark as processed
    processedEntityIds.add(entity.id);

    // 1. Set Values
    const values: any[] = [];
    
    // Add RxCUI (common to all entities)
    values.push({ property: PROP_IDS.RXCUI, type: 'text', value: entity.rxcui });
    
    // Add Name (common to all entities)
    values.push({ property: PROP_IDS.NAME, type: 'text', value: entity.name });

    // Add Properties ONLY if this is an Ingredient
    if (entity.typeId === TYPE_IDS.IN) {
      if (entity.SMILES) values.push({ property: PROP_IDS.SMILES, type: 'text', value: String(entity.SMILES) });
      if (entity.PMID) values.push({ property: PROP_IDS.PMID, type: 'text', value: String(entity.PMID) });
      if (entity.INCHIKEY) values.push({ property: PROP_IDS.INCHIKEY, type: 'text', value: String(entity.INCHIKEY) });
    }

    // 2. Set Relations
    const relations: Record<string, Array<{ toEntity: string }>> = {};
    
    if (entity.relations && typeof entity.relations === 'object') {
      for (const [relationId, rawValue] of Object.entries(entity.relations)) {
        if (Array.isArray(rawValue)) {
            const cleanList: Array<{ toEntity: string }> = [];
            
            for (const id of rawValue) {
                if (id && typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) && entityLookup.has(id)) {
                    cleanList.push({ toEntity: id });
                }
            }

            if (cleanList.length > 0) {
                relations[relationId] = cleanList;
            }
        }
      }
    }

    // 3. Create the Entity Operation
    try {
        const result = Graph.createEntity({
          id: entity.id,
          types: [entity.typeId],
          values,
          relations 
        });

        allOps.push(...result.ops);
    } catch (e: any) {
        console.error(`❌ Error creating entity ${entity.name} (${entity.id}): ${e.message}`);
    }
  });

  console.log(`📊 Generated ${allOps.length} operations.`);

  if (allOps.length === 0) {
    console.error('❌ No operations generated. Aborting publish.');
    return;
  }

  // 5. Save Ops
  fs.writeFileSync(path.join(DATA_DIR, "extracted_data_ops.txt"), JSON.stringify(allOps, null, 2));

  // 6. Publish
  console.log(`🚀 Publishing operations to Geo...`);
  const { cid, editId, to, calldata } = await personalSpace.publishEdit({
    name: `Import (Limit ${INGREDIENT_LIMIT})`,
    spaceId,
    ops: allOps,
    author: spaceId,
    network: "TESTNET",
  });

  console.log(`📝 IPFS CID: ${cid}`);
  console.log(`🆔 Edit ID: ${editId}`);
  console.log(`📬 Calldata Target: ${to}`);

  const txHash = await smartAccount.sendTransaction({
    to,
    data: calldata,
  });

  console.log(`✅ Import Complete. TX Hash: ${txHash}`);
}

runImport().catch(console.error);
