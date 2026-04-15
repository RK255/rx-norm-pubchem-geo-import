// src/import_extracted_data.ts
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto'; // FIX: Use standard import
import { fileURLToPath } from 'url';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import { TYPE_IDS, SOURCE_DATA_IDS } from './constants';
import type { Hex } from 'viem';

// --- ESM __dirname POLYFIX ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- ARGUMENT PARSING ---
const args = process.argv.slice(2);
const limitArgIndex = args.indexOf('--limit');
// Default to undefined (Import All) unless --limit is specified
let INGREDIENT_LIMIT: number | undefined = undefined; 

if (limitArgIndex !== -1 && args[limitArgIndex + 1]) {
  INGREDIENT_LIMIT = parseInt(args[limitArgIndex + 1], 10);
  if (isNaN(INGREDIENT_LIMIT)) {
    console.error('❌ Invalid value for --limit. Please provide a number.');
    process.exit(1);
  }
}

const FORCE_PUBLISH = args.includes('--force'); // Skip deduplication if present

// --- CONFIGURATION ---
const DATA_DIR = path.join(__dirname, '..', 'data_to_publish');
const MASTER_FILE = path.join(DATA_DIR, 'full_geo_extraction.json'); 
const API_URL = "https://testnet-api.geobrowser.io/graphql";

// --- TYPES ---
interface Entity {
  id: string;
  typeId: string;
  rxcui: string;
  name: string;
  relations: { [key: string]: any };
  [key: string]: any;
}

// --- PRE-FLIGHT CHECK (DEDUPLICATION FIX) ---
// Fetches existing entity IDs to prevent duplicates.
async function fetchExistingEntityIds(spaceId: string): Promise<Set<string>> {
  console.log(`🔍 Pre-flight check: Fetching existing entities...`);
  const existingIds = new Set<string>();
  const RX_CUI_PROPERTY_ID = 'e6c50e227460442cab646a48f235459a'; // Fingerprint property

  try {
    const query = `
      query GetPharmaEntities {
        values(filter: { spaceId: { is: "${spaceId}" }, propertyId: { is: "${RX_CUI_PROPERTY_ID}" } }) {
          entityId
        }
      }
    `;
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
    const json = await res.json() as { errors?: any[]; data?: any };

    if (json.errors) {
      console.error('⚠️  Warning: Could not fetch existing entities. Proceeding without check.');
      return existingIds;
    }

    const values = json.data?.values || [];
    values.forEach((v: any) => existingIds.add(v.entityId.replace(/-/g, ''))); // Normalize: Remove hyphens
    console.log(`📦 Found ${existingIds.size} existing entities.`);
  } catch (e) {
    console.error('⚠️  Warning: Fetch failed. Proceeding without check.');
  }
  return existingIds;
}

async function runImport() {
  console.log(`🚀 Starting Import${INGREDIENT_LIMIT ? ` (Limit: ${INGREDIENT_LIMIT})` : ' (All Data)'}...`);
  if (FORCE_PUBLISH) console.warn('⚠️  --force flag detected: Skipping existence check!');

  // 1. Init Environment
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  const spaceId = process.env.GEO_SPACE_ID;
  if (!privateKeyRaw || !spaceId) {
    console.error('❌ Missing GEO_WALLET_PRIVATE_KEY or GEO_SPACE_ID in .env');
    process.exit(1);
  }
  const privateKey = privateKeyRaw.startsWith('0x') ? privateKeyRaw as Hex : `0x${privateKeyRaw}` as Hex; // FIX: Explicit Hex type
  const smartAccount = await getSmartAccountWalletClient({ privateKey });
  console.log('✅ Smart Account Initialized.');

  // 2. Fetch Existing IDs
  const existingIds = FORCE_PUBLISH ? new Set<string>() : await fetchExistingEntityIds(spaceId);

  // 3. Load Data
  if (!fs.existsSync(MASTER_FILE)) {
    console.error(`❌ Master file not found: ${MASTER_FILE}`);
    process.exit(1);
  }
  const rawData = fs.readFileSync(MASTER_FILE, 'utf-8');
  const allIngredients: Entity[] = JSON.parse(rawData);
  console.log(`📦 Loaded ${allIngredients.length} total ingredients from Master.`);

  // 4. Slice Data
  const ingredientsToImport = INGREDIENT_LIMIT ? allIngredients.slice(0, INGREDIENT_LIMIT) : allIngredients;
  console.log(`🧪 Isolated ${ingredientsToImport.length} ingredients for import.\n`);

  // 5. Expand Ingredients -> All Entities (Ingredients + Brands + Forms + Drugs)
  const entityMap = new Map<string, Entity>();
  const crypto = await import('crypto');
  
  function generateUuid(rxcui: string, typeId: string): string {
    const seed = `${typeId}:${rxcui}`;
    const hash = crypto.createHash('sha256').update(seed).digest('hex');
    return [hash.substring(0, 8), hash.substring(8, 12), hash.substring(12, 16), hash.substring(16, 20), hash.substring(20, 32)].join('-');
  }

  const TTY_TO_TYPE_ID: { [key: string]: string } = {
    'in': 'b1bb9b33cdd247dfaf02ad98506c39eb', // Ingredient
    'bn': '402cae0b9c17472586a2236f70492d7b', // Brand Name
    'df': '06e2222273114885b32b3a1368d2d266', // Dose Form
    'sbd': '2033a9f3942a4c828dcdfe0411609450', // Semantic Branded Drug
    'scd': 'a844e0f3a48d4e82b234da893aee4291', // Semantic Clinical Drug
    'min': 'f0250a1cc9e8431980b3e9d7661e08f9', // Multiple Ingredient
    'pin': '4ba36be2740b4f36aa7c31512869bb3c', // Precise Ingredient
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
      const entity: Entity = { id, typeId, rxcui, name, relations: {} };
      entityMap.set(id, entity);
    }
    return entityMap.get(id)!;
  }

  // Expansion Logic
  ingredientsToImport.forEach((ing) => {
    const ingId = generateUuid(ing.rxcui, TTY_TO_TYPE_ID['in']);
    const ingEntity = getEntity(ingId, TTY_TO_TYPE_ID['in'], ing.rxcui, ing.name);
    
    // Attach PubChem props
    if ((ing as any).smiles) ingEntity.SMILES = (ing as any).smiles;
    if ((ing as any).pmid) ingEntity.PMID = (ing as any).pmid;
    if ((ing as any).inchi_key) ingEntity.INCHIKEY = (ing as any).inchi_key;

    const connections = (ing as any).connections || {};
    Object.entries(connections).forEach(([tty, connList]) => {
      if (!Array.isArray(connList) || connList.length === 0) return;
      const relatedTypeId = TTY_TO_TYPE_ID[tty];
      const relationId = TTY_TO_RELATION_ID[tty];
      if (!relatedTypeId || !relationId) return;

      if (!ingEntity.relations[relationId]) ingEntity.relations[relationId] = [];
      connList.forEach((conn: any) => {
        const connId = generateUuid(conn.rxcui, relatedTypeId);
        getEntity(connId, relatedTypeId, conn.rxcui, conn.name);
        (ingEntity.relations[relationId] as string[]).push(connId);
      });
    });
  });

  const allEntities = Array.from(entityMap.values());
  const entityLookup = new Map<string, string>(allEntities.map(e => [e.id, e.typeId]));
  const allOps: any[] = [];

  const PROP_IDS = {
    NAME: 'a126ca530c8e48d5b88882c734c38935',
    RXCUI: 'e6c50e227460442cab646a48f235459a',
    SMILES: SOURCE_DATA_IDS.SMILES,
    PMID: SOURCE_DATA_IDS.PMID,
    INCHIKEY: SOURCE_DATA_IDS.INCHI_KEY,
  };

  console.log(`🔄 Generating operations for ${allEntities.length} total entities...`);

  // 6. Generate Operations
  allEntities.forEach((entity) => {
    // FIX: Deduplication Check (Normalize ID to match API format)
    const normalizedId = entity.id.replace(/-/g, '');
    if (existingIds.has(normalizedId)) {
      return; // Skip silently or log count later
    }
    
    existingIds.add(normalizedId); // Mark as seen in this run

    const values: any[] = [{ property: PROP_IDS.RXCUI, type: 'text', value: entity.rxcui }];
    
    if (entity.typeId === TYPE_IDS.IN) {
      if (entity.SMILES) values.push({ property: PROP_IDS.SMILES, type: 'text', value: String(entity.SMILES) });
      if (entity.PMID) values.push({ property: PROP_IDS.PMID, type: 'text', value: String(entity.PMID) });
      if (entity.INCHIKEY) values.push({ property: PROP_IDS.INCHIKEY, type: 'text', value: String(entity.INCHIKEY) });
    }

    const relations: Record<string, Array<{ toEntity: string }>> = {};
    if (entity.relations && typeof entity.relations === 'object') {
      for (const [relationId, rawValue] of Object.entries(entity.relations)) {
        if (Array.isArray(rawValue)) {
          const cleanList = rawValue
            .filter((id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) && entityLookup.has(id))
            .map((id: string) => ({ toEntity: id }));
          if (cleanList.length > 0) relations[relationId] = cleanList;
        }
      }
    }

    try {
      const result = Graph.createEntity({ id: entity.id, name: entity.name, types: [entity.typeId], values, relations });
      allOps.push(...result.ops);
    } catch (e: any) {
      console.error(`❌ Error creating entity ${entity.name}: ${e.message}`);
    }
  });

  console.log(`📊 Generated ${allOps.length} operations.`);

  if (allOps.length === 0) {
    console.log('✅ No new entities to publish. Everything is up to date.');
    return;
  }

  // 7. Save Artifacts
  const manifestPath = path.join(DATA_DIR, `manifest_${Date.now()}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    batchName: `Import Limit ${INGREDIENT_LIMIT || 'ALL'}`,
    spaceId: spaceId,
    entityIds: allEntities.map(e => e.id)
  }, null, 2));
  console.log(`💾 Saved manifest to: ${manifestPath}`);

  const opsPath = path.join(DATA_DIR, "extracted_data_ops.txt");
  fs.writeFileSync(opsPath, JSON.stringify(allOps, null, 2));
  console.log(`💾 Saved raw ops to: ${opsPath}`);

  // 8. Publish
  console.log(`🚀 Publishing operations to Geo...`);
  try {
    const { cid, editId, to, calldata } = await personalSpace.publishEdit({
      name: `Import ${INGREDIENT_LIMIT ? `(Limit ${INGREDIENT_LIMIT})` : '(All)'}`,
      spaceId,
      ops: allOps,
      author: spaceId,
      network: "TESTNET",
    });

    console.log(`📝 IPFS CID: ${cid}`);
    console.log(`🆔 Edit ID: ${editId}`);
    console.log(`📬 Target: ${to}`);

    const txHash = await smartAccount.sendTransaction({ to, data: calldata });
    console.log(`✅ Import Complete. TX: ${txHash}`);
  } catch (e) {
    console.error('❌ Publish failed:', e);
  }
}

runImport().catch(console.error);
