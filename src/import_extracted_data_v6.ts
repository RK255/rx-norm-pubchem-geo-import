// src/import_extracted_data_v6.ts
// Changes: Added --set-id-only filter and batching

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { Graph, personalSpace, daoSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import { TYPE_IDS, RELATION_IDS, PROPERTY_IDS } from './constants';
import type { Hex } from 'viem';

// --- ESM __dirname POLYFIX ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- ARGUMENT PARSING ---
const args = process.argv.slice(2);
const limitArgIndex = args.indexOf('--limit');
let INGREDIENT_LIMIT: number | undefined = undefined; 

if (limitArgIndex !== -1 && args[limitArgIndex + 1]) {
  INGREDIENT_LIMIT = parseInt(args[limitArgIndex + 1], 10);
  if (isNaN(INGREDIENT_LIMIT)) {
    console.error('❌ Invalid value for --limit. Please provide a number.');
    process.exit(1);
  }
}

const FORCE_PUBLISH = args.includes('--force');
const CONNECTED_ONLY = args.includes('--connected-only');
const SET_ID_ONLY = args.includes('--set-id-only'); // <-- NEW FLAG
const DRY_RUN = args.includes('--dry-run');

// --- CONFIGURATION ---
const DATA_DIR = path.join(__dirname, '..', 'data_to_publish');
const MASTER_FILE = path.join(DATA_DIR, 'full_geo_extraction_v3.jsonl');
const API_URL = "https://testnet-api.geobrowser.io/graphql";

// --- BATCH CONFIGURATION ---
const BATCH_SIZE = 80000; // ~8MB target to stay under 10MB limit

// --- TYPES ---
interface Entity {
  id: string;
  typeId: string;
  rxcui: string;
  name: string;
  relations: { [key: string]: Set<string> };
  SMILES?: string;
  PMID?: string;
  INCHIKEY?: string;
  NDC10?: string;
  NDC11?: string;
  SPL_SET_ID?: string;
  [key: string]: any;
}

// --- TYPE NAME LOOKUP ---
const TYPE_NAMES: Record<string, string> = {
  [TYPE_IDS.IN]: 'Ingredient',
  [TYPE_IDS.BN]: 'Brand',
  [TYPE_IDS.DF]: 'Dose Form',
  [TYPE_IDS.SBD]: 'Semantic Brand Drug',
  [TYPE_IDS.SCD]: 'Semantic Clinical Drug',
  [TYPE_IDS.MIN]: 'Multiple Ingredient',
  [TYPE_IDS.PIN]: 'Precise Ingredient',
  [TYPE_IDS.NDC]: 'NDC',
};

// --- HELPER: Deduplicate array by a key ---
function dedupeByKey<T>(arr: T[], key: keyof T): T[] {
  const seen = new Set();
  return arr.filter((item) => {
    const val = item[key];
    if (seen.has(val)) return false;
    seen.add(val);
    return true;
  });
}

// --- HELPER: Format NDC11 (11 digits no hyphens) to display format (5-4-2 with hyphens) ---
function formatNdc11(ndc11NoHyphens: string): string {
  if (!ndc11NoHyphens || ndc11NoHyphens.length !== 11) {
    return ndc11NoHyphens;
  }
  return `${ndc11NoHyphens.slice(0, 5)}-${ndc11NoHyphens.slice(5, 9)}-${ndc11NoHyphens.slice(9, 11)}`;
}

// --- DETECT SPACE TYPE ---
async function detectSpaceType(spaceId: string): Promise<{ type: 'PERSONAL' | 'DAO'; address?: string }> {
  const query = `
    query GetSpaceType {
      space(id: "${spaceId}") { id type address }
    }
  `;
  
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  
  const json = await res.json() as { errors?: any[]; data?: any };
  
  if (json.errors) {
    console.error('❌ Failed to query space type:');
    json.errors.forEach((e: any) => console.error(`   ${e.message}`));
    process.exit(1);
  }
  
  if (!json.data?.space) {
    console.error(`❌ Space not found: ${spaceId}`);
    process.exit(1);
  }
  
  const type = json.data.space.type as string;
  
  if (type !== 'PERSONAL' && type !== 'DAO') {
    console.error(`❌ Unknown space type: ${type}`);
    process.exit(1);
  }
  
  console.log(`📋 Space type: ${type}${type === 'DAO' ? ` (address: ${json.data.space.address})` : ''}`);
  
  return {
    type: type as 'PERSONAL' | 'DAO',
    address: json.data.space.address as string | undefined
  };
}

// --- PRE-FLIGHT CHECK ---
async function fetchExistingEntityIds(spaceId: string): Promise<Set<string>> {
  console.log(`🔍 Pre-flight check: Fetching existing entities...`);
  const existingIds = new Set<string>();
  
  const typeIds = [
    { id: TYPE_IDS.IN, name: 'IN' },
    { id: TYPE_IDS.BN, name: 'BN' },
    { id: TYPE_IDS.DF, name: 'DF' },
    { id: TYPE_IDS.SCD, name: 'SCD' },
    { id: TYPE_IDS.SBD, name: 'SBD' },
    { id: TYPE_IDS.MIN, name: 'MIN' },
    { id: TYPE_IDS.PIN, name: 'PIN' },
    { id: TYPE_IDS.NDC, name: 'NDC' },
  ];

  for (const type of typeIds) {
    let batchNum = 0;
    
    while (true) {
      batchNum++;
      
      const query = `{
        entities(filter: { 
          spaceIds: { is: ["${spaceId}"] }, 
          typeIds: { in: ["${type.id}"] } 
        }, first: 1000) {
          id
        }
      }`;
      
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        
        const json = await res.json();
        
        if (json.errors) {
          console.error(`  ⚠️  ${type.name} failed:`, json.errors[0].message);
          break;
        }
        
        const entities = json.data?.entities || [];
        
        entities.forEach((e: any) => {
          existingIds.add(e.id.replace(/-/g, ''));
        });
        
        if (entities.length > 0) {
          console.log(`  ${type.name} batch ${batchNum}: ${entities.length} entities (total: ${existingIds.size})`);
        }
        
        if (entities.length < 1000) break;
        
        await new Promise(r => setTimeout(r, 500));
      } catch (e: any) {
        console.error(`  ⚠️  ${type.name} error:`, e.message);
        break;
      }
    }
  }
  
  console.log(`📦 Found ${existingIds.size} total existing entities.`);
  return existingIds;
}

// --- INTERACTIVE PROMPT ---
async function confirmPublish(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Publish to blockchain? [y/N]: ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// --- GENERATE SUMMARY ---
function generateSummary(entities: Entity[], ingredients: any[]): string {
  const lines: string[] = [];
  
  const typeCounts: Record<string, number> = {};
  entities.forEach(e => {
    const typeName = TYPE_NAMES[e.typeId] || e.typeId;
    typeCounts[typeName] = (typeCounts[typeName] || 0) + 1;
  });

  lines.push('='.repeat(60));
  lines.push('ENTITY BREAKDOWN');
  lines.push('='.repeat(60));
  Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
    lines.push(`  ${type}: ${count}`);
  });

  let totalRelations = 0;
  entities.forEach(e => {
    if (e.relations) {
      Object.values(e.relations).forEach((set) => {
        if (set instanceof Set) totalRelations += set.size;
      });
    }
  });

  lines.push('');
  lines.push('='.repeat(60));
  lines.push('SUMMARY');
  lines.push('='.repeat(60));
  lines.push(`  Total Entities: ${entities.length}`);
  lines.push(`  Total Relations: ${totalRelations}`);
  lines.push(`  Source Ingredients: ${ingredients.length}`);

  lines.push('');
  lines.push('='.repeat(60));
  lines.push('SAMPLE ENTITIES (First 10)');
  lines.push('='.repeat(60));
  entities.slice(0, 10).forEach((e, i) => {
    const typeName = TYPE_NAMES[e.typeId] || 'Unknown';
    const relCount = e.relations ? Object.values(e.relations).reduce((sum, s) => sum + (s instanceof Set ? s.size : 0), 0) : 0;
    lines.push(`  ${i + 1}. ${e.name} [${typeName}] (ID: ${e.rxcui}, Relations: ${relCount})`);
  });

  if (entities.length > 10) {
    lines.push(`  ... and ${entities.length - 10} more`);
  }

  return lines.join('\n');
}

// --- UUID GENERATION ---
function generateUuid(rxcui: string, typeId: string): string {
  const seed = `${typeId}:${rxcui}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return [hash.substring(0, 8), hash.substring(8, 12), hash.substring(12, 16), hash.substring(16, 20), hash.substring(20, 32)].join('-');
}

// --- NDC UUID GENERATION ---
function generateNdcUuid(ndcCode: string): string {
  const seed = `${TYPE_IDS.NDC}:${ndcCode}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return [hash.substring(0, 8), hash.substring(8, 12), hash.substring(12, 16), hash.substring(16, 20), hash.substring(20, 32)].join('-');
}

// --- ENTITY LOOKUP ---
function getEntity(id: string, typeId: string, rxcui: string, name: string, entityMap: Map<string, Entity>): Entity {
  if (!entityMap.has(id)) {
    const entity: Entity = { id, typeId, rxcui, name, relations: {} };
    entityMap.set(id, entity);
  }
  return entityMap.get(id)!;
}

// --- ADD RELATION HELPER ---
function addRelation(entity: Entity, relationId: string, targetId: string): void {
  if (!entity.relations[relationId]) {
    entity.relations[relationId] = new Set<string>();
  }
  entity.relations[relationId].add(targetId);
}

// --- HELPER: Create NDC entity with set_id filtering ---
// Returns null if SET_ID_ONLY is enabled and no spl_set_id exists
function createNdcEntity(ndcData: any, entityMap: Map<string, Entity>, setIdOnly: boolean): Entity | null {
  // Filter out NDCs without SPL_SET_ID if flag is enabled
  if (setIdOnly && !ndcData.spl_set_id) {
    return null;
  }

  const ndcCanonical = ndcData.ndc11_no_hyphens;
  const ndcId = generateNdcUuid(ndcCanonical);
  const ndcDisplayName = formatNdc11(ndcCanonical);
  
  const ndcEntity = getEntity(ndcId, TYPE_IDS.NDC, ndcCanonical, ndcDisplayName, entityMap);
  
  if (ndcData.ndc10) ndcEntity.NDC10 = ndcData.ndc10;
  if (ndcData.ndc11_no_hyphens) ndcEntity.NDC11 = ndcData.ndc11_no_hyphens;
  if (ndcData.spl_set_id) ndcEntity.SPL_SET_ID = ndcData.spl_set_id;
  
  return ndcEntity;
}

// --- BATCH PUBLISH HELPER ---
async function publishInBatches(
  allOps: any[],
  spaceInfo: { type: 'PERSONAL' | 'DAO'; address?: string },
  spaceId: string,
  smartAccount: any,
  personalSpaceId: string | undefined,
  INGREDIENT_LIMIT: number | undefined,
  CONNECTED_ONLY: boolean
): Promise<void> {
  const totalBatches = Math.ceil(allOps.length / BATCH_SIZE);
  console.log(`\n📦 Splitting ${allOps.length.toLocaleString()} operations into ${totalBatches} batches (max ${BATCH_SIZE.toLocaleString()} per batch)\n`);

  for (let i = 0; i < totalBatches; i++) {
    const start = i * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, allOps.length);
    const batch = allOps.slice(start, end);
    const batchNum = i + 1;
    
    console.log(`\n🚀 Publishing batch ${batchNum}/${totalBatches} (${batch.length.toLocaleString()} operations)...`);
    
    try {
      let cid: string;
      let editId: string;
      let to: `0x${string}`;
      let calldata: `0x${string}`;

      const batchName = `Import V4 ${INGREDIENT_LIMIT ? `(Limit ${INGREDIENT_LIMIT})` : '(All)'}${CONNECTED_ONLY ? ' [Connected Only)' : ''} - Batch ${batchNum}/${totalBatches}`;

      if (spaceInfo.type === 'DAO') {
        const result = await daoSpace.proposeEdit({
          name: batchName,
          ops: batch,
          author: personalSpaceId!.replace(/-/g, ''),
          daoSpaceAddress: spaceInfo.address as `0x${string}`,
          callerSpaceId: "0x" + personalSpaceId!.replace(/-/g, ''),
          daoSpaceId: "0x" + spaceId.replace(/-/g, ''),
          network: "TESTNET",
        });
        cid = result.cid;
        editId = result.editId;
        to = result.to;
        calldata = result.calldata;
        console.log(`📝 Proposal created. CID: ${cid}`);
        console.log(`🆔 Edit ID: ${editId}`);
        console.log(`🗳️  Proposal ID: ${result.proposalId}`);
      } else {
        const result = await personalSpace.publishEdit({
          name: batchName,
          spaceId: spaceId.replace(/-/g, ''),
          ops: batch,
          author: spaceId.replace(/-/g, ''),
          network: "TESTNET",
        });
        cid = result.cid;
        editId = result.editId;
        to = result.to;
        calldata = result.calldata;
        console.log(`📝 IPFS CID: ${cid}`);
        console.log(`🆔 Edit ID: ${editId}`);
      }

      console.log(`📬 Target: ${to}`);

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`✅ Batch ${batchNum}/${totalBatches} complete. TX: ${txHash}`);
      
      // Delay between batches to avoid rate limiting
      if (batchNum < totalBatches) {
        console.log(`⏳ Waiting 3 seconds before next batch...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
    } catch (e: any) {
      console.error(`❌ Batch ${batchNum} failed:`, e.message);
      throw e;
    }
  }

  console.log(`\n🎉 All ${totalBatches} batches published successfully!`);
}

async function runImport() {
  const limitStr = INGREDIENT_LIMIT ? ` (Limit: ${INGREDIENT_LIMIT})` : ' (All Data)';
  const setIdStr = SET_ID_ONLY ? ' [SET_ID_ONLY = Only NDCs with SPL_SET_ID]' : '';
  console.log(`🚀 Starting Import V4${limitStr}${setIdStr}...`);
  if (FORCE_PUBLISH) console.warn('⚠️  --force flag detected: Skipping existence check!');
  if (CONNECTED_ONLY) console.log('🧹 --connected-only flag detected: Filtering isolated ingredients.');
  if (SET_ID_ONLY) console.log('🧹 --set-id-only flag detected: Filtering NDCs without SPL_SET_ID (~ removes 63k NDCs)');
  if (DRY_RUN) console.log('🔍 --dry-run flag detected: Preview mode (no publish).');

  // 1. Validate Environment
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  const spaceId = process.env.GEO_SPACE_ID;
  const personalSpaceId = process.env.GEO_PERSONAL_SPACE_ID;
  
  if (DRY_RUN) {
    if (!spaceId) {
      console.error('❌ Missing GEO_SPACE_ID in .env');
      process.exit(1);
    }
  } else {
    if (!privateKeyRaw || !spaceId) {
      console.error('❌ Missing GEO_WALLET_PRIVATE_KEY or GEO_SPACE_ID in .env');
      process.exit(1);
    }
  }

  const privateKey = privateKeyRaw?.startsWith('0x') ? privateKeyRaw as Hex : `0x${privateKeyRaw}` as Hex;

  // 2. Detect space type
  const spaceInfo = await detectSpaceType(spaceId!);

  if (spaceInfo.type === 'DAO' && !personalSpaceId) {
    console.error('❌ GEO_PERSONAL_SPACE_ID required in .env for DAO spaces.');
    process.exit(1);
  }

  // 3. Init Wallet
  let smartAccount: Awaited<ReturnType<typeof getSmartAccountWalletClient>> | null = null;
  if (!DRY_RUN) {
    smartAccount = await getSmartAccountWalletClient({ privateKey: privateKey! });
    console.log('✅ Smart Account Initialized.');
  }

  // 4. Fetch Existing IDs
  const existingIds = (DRY_RUN || FORCE_PUBLISH) ? new Set<string>() : await fetchExistingEntityIds(spaceId!);

  // 5. Load Data
  if (!fs.existsSync(MASTER_FILE)) {
    console.error(`❌ Master file not found: ${MASTER_FILE}`);
    process.exit(1);
  }
  const rawData = fs.readFileSync(MASTER_FILE, 'utf-8');
  
  const allIngredients: any[] = rawData
    .split('\n')
    .filter(line => line.trim())
    .map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        console.error(`❌ Failed to parse line ${idx + 1}:`, line.substring(0, 100));
        throw e;
      }
    });
  
  console.log(`📦 Loaded ${allIngredients.length} total ingredients from Master V4 (JSONL format).`);

  // 6. Slice & Filter
  let ingredientsToImport = INGREDIENT_LIMIT ? allIngredients.slice(0, INGREDIENT_LIMIT) : allIngredients;

  if (CONNECTED_ONLY) {
    const originalCount = ingredientsToImport.length;
    ingredientsToImport = ingredientsToImport.filter((ing: any) => {
      const conns = ing.connections || {};
      return Object.values(conns).some((arr: any) => Array.isArray(arr) && arr.length > 0);
    });
    console.log(`🧹 Filtered out ${originalCount - ingredientsToImport.length} isolated ingredients.`);
  }

  console.log(`🧪 Processing ${ingredientsToImport.length} ingredients.\n`);

  // 7. Build Entity Graph
  const entityMap = new Map<string, Entity>();
  const dedupeStats = { df: 0, scd: 0, sbd: 0, bn: 0, pin: 0, min: 0, ndc: 0, combo_scd: 0, combo_sbd: 0 };
  let filteredNdcCount = 0; // Track filtered NDCs

  ingredientsToImport.forEach((ing: any) => {
    const ingId = generateUuid(ing.rxcui, TYPE_IDS.IN);
    const ingEntity = getEntity(ingId, TYPE_IDS.IN, ing.rxcui, ing.name, entityMap);
    
    if (ing.smiles) ingEntity.SMILES = ing.smiles;
    if (ing.pmid) ingEntity.PMID = ing.pmid;
    if (ing.inchi_key) ingEntity.INCHIKEY = ing.inchi_key;

    const connections = ing.connections || {};

    // Deduplicate all arrays by RxCUI
    const minList = dedupeByKey(connections.min || [], 'rxcui');
    const pinList = dedupeByKey(connections.pin || [], 'rxcui');
    const dfList = dedupeByKey(connections.df || [], 'rxcui');
    const scdList = dedupeByKey(connections.scd || [], 'rxcui');
    const sbdList = dedupeByKey(connections.sbd || [], 'rxcui');
    const bnList = dedupeByKey(connections.bn || [], 'rxcui');

    // Track duplicates
    if ((connections.min || []).length !== minList.length) dedupeStats.min += (connections.min || []).length - minList.length;
    if ((connections.pin || []).length !== pinList.length) dedupeStats.pin += (connections.pin || []).length - pinList.length;
    if ((connections.df || []).length !== dfList.length) dedupeStats.df += (connections.df || []).length - dfList.length;
    if ((connections.scd || []).length !== scdList.length) dedupeStats.scd += (connections.scd || []).length - scdList.length;
    if ((connections.sbd || []).length !== sbdList.length) dedupeStats.sbd += (connections.sbd || []).length - sbdList.length;
    if ((connections.bn || []).length !== bnList.length) dedupeStats.bn += (connections.bn || []).length - bnList.length;

    // Process MIN with combo products
    minList.forEach((minData: any) => {
      const minId = generateUuid(minData.rxcui, TYPE_IDS.MIN);
      const minEntity = getEntity(minId, TYPE_IDS.MIN, minData.rxcui, minData.name, entityMap);
      addRelation(ingEntity, RELATION_IDS.MULTIPLE_INGREDIENTS, minId);

      const minIngredients = minData.ingredients || [];
      minIngredients.forEach((minIng: any) => {
        if (minIng.rxcui === ing.rxcui) return;
        
        const minIngId = generateUuid(minIng.rxcui, TYPE_IDS.IN);
        getEntity(minIngId, TYPE_IDS.IN, minIng.rxcui, minIng.name, entityMap);
        addRelation(minEntity, RELATION_IDS.MULTIPLE_INGREDIENTS, minIngId);
      });

      const comboScdList = dedupeByKey(minData.combo_scds || [], 'rxcui');
      if ((minData.combo_scds || []).length !== comboScdList.length) {
        dedupeStats.combo_scd += (minData.combo_scds || []).length - comboScdList.length;
      }
      
      comboScdList.forEach((comboScd: any) => {
        const comboScdId = generateUuid(comboScd.rxcui, TYPE_IDS.SCD);
        const comboScdEntity = getEntity(comboScdId, TYPE_IDS.SCD, comboScd.rxcui, comboScd.name, entityMap);
        addRelation(minEntity, RELATION_IDS.SEMANTIC_CLINICAL_DRUGS, comboScdId);

        const ndcList = dedupeByKey(comboScd.ndcs || [], 'ndc');
        if ((comboScd.ndcs || []).length !== ndcList.length) dedupeStats.ndc += (comboScd.ndcs || []).length - ndcList.length;

        ndcList.forEach((ndcData: any) => {
          const ndcEntity = createNdcEntity(ndcData, entityMap, SET_ID_ONLY);
          if (ndcEntity) {
            addRelation(comboScdEntity, RELATION_IDS.NDCS, ndcEntity.id);
          } else {
            filteredNdcCount++;
          }
        });
      });

      const comboSbdList = dedupeByKey(minData.combo_sbds || [], 'rxcui');
      if ((minData.combo_sbds || []).length !== comboSbdList.length) {
        dedupeStats.combo_sbd += (minData.combo_sbds || []).length - comboSbdList.length;
      }
      
      comboSbdList.forEach((comboSbd: any) => {
        const comboSbdId = generateUuid(comboSbd.rxcui, TYPE_IDS.SBD);
        const comboSbdEntity = getEntity(comboSbdId, TYPE_IDS.SBD, comboSbd.rxcui, comboSbd.name, entityMap);
        addRelation(minEntity, RELATION_IDS.SEMANTIC_BRANDED_DRUGS, comboSbdId);

        const ndcList = dedupeByKey(comboSbd.ndcs || [], 'ndc');
        if ((comboSbd.ndcs || []).length !== ndcList.length) dedupeStats.ndc += (comboSbd.ndcs || []).length - ndcList.length;

        ndcList.forEach((ndcData: any) => {
          const ndcEntity = createNdcEntity(ndcData, entityMap, SET_ID_ONLY);
          if (ndcEntity) {
            addRelation(comboSbdEntity, RELATION_IDS.NDCS, ndcEntity.id);
          } else {
            filteredNdcCount++;
          }
        });

        if (comboSbd.brand_name) {
          const brandName = typeof comboSbd.brand_name === 'string' ? comboSbd.brand_name : comboSbd.brand_name.name;
          const brandRxcui = typeof comboSbd.brand_name === 'string' ? comboSbd.rxcui : comboSbd.brand_name.rxcui;
          const bnId = generateUuid(brandRxcui, TYPE_IDS.BN);
          getEntity(bnId, TYPE_IDS.BN, brandRxcui, brandName, entityMap);
          addRelation(comboSbdEntity, RELATION_IDS.BRAND_NAMES, bnId);
          addRelation(minEntity, RELATION_IDS.BRAND_NAMES, bnId);
        }
      });
    });

    pinList.forEach((pinData: any) => {
      const pinId = generateUuid(pinData.rxcui, TYPE_IDS.PIN);
      getEntity(pinId, TYPE_IDS.PIN, pinData.rxcui, pinData.name, entityMap);
      addRelation(ingEntity, RELATION_IDS.PRECISE_INGREDIENTS, pinId);
    });

    dfList.forEach((dfData: any) => {
      const dfId = generateUuid(dfData.rxcui, TYPE_IDS.DF);
      getEntity(dfId, TYPE_IDS.DF, dfData.rxcui, dfData.name, entityMap);
      addRelation(ingEntity, RELATION_IDS.DOSE_FORMS, dfId);
    });

    scdList.forEach((scdData: any) => {
      const scdId = generateUuid(scdData.rxcui, TYPE_IDS.SCD);
      const scdEntity = getEntity(scdId, TYPE_IDS.SCD, scdData.rxcui, scdData.name, entityMap);
      addRelation(ingEntity, RELATION_IDS.SEMANTIC_CLINICAL_DRUGS, scdId);

      const ndcList = dedupeByKey(scdData.ndcs || [], 'ndc');
      if ((scdData.ndcs || []).length !== ndcList.length) dedupeStats.ndc += (scdData.ndcs || []).length - ndcList.length;

      ndcList.forEach((ndcData: any) => {
        const ndcEntity = createNdcEntity(ndcData, entityMap, SET_ID_ONLY);
        if (ndcEntity) {
          addRelation(scdEntity, RELATION_IDS.NDCS, ndcEntity.id);
        } else {
          filteredNdcCount++;
        }
      });
    });

    sbdList.forEach((sbdData: any) => {
      const sbdId = generateUuid(sbdData.rxcui, TYPE_IDS.SBD);
      const sbdEntity = getEntity(sbdId, TYPE_IDS.SBD, sbdData.rxcui, sbdData.name, entityMap);
      addRelation(ingEntity, RELATION_IDS.SEMANTIC_BRANDED_DRUGS, sbdId);

      const ndcList = dedupeByKey(sbdData.ndcs || [], 'ndc');
      if ((sbdData.ndcs || []).length !== ndcList.length) dedupeStats.ndc += (sbdData.ndcs || []).length - ndcList.length;

      ndcList.forEach((ndcData: any) => {
        const ndcEntity = createNdcEntity(ndcData, entityMap, SET_ID_ONLY);
        if (ndcEntity) {
          addRelation(sbdEntity, RELATION_IDS.NDCS, ndcEntity.id);
        } else {
          filteredNdcCount++;
        }
      });

      if (sbdData.brand_name) {
        const bnId = generateUuid(sbdData.brand_name.rxcui, TYPE_IDS.BN);
        getEntity(bnId, TYPE_IDS.BN, sbdData.brand_name.rxcui, sbdData.brand_name.name, entityMap);
        addRelation(sbdEntity, RELATION_IDS.BRAND_NAMES, bnId);
      }
    });

    bnList.forEach((bnData: any) => {
      const bnId = generateUuid(bnData.rxcui, TYPE_IDS.BN);
      getEntity(bnId, TYPE_IDS.BN, bnData.rxcui, bnData.name, entityMap);
      if (bnData.is_combo !== true) {
        addRelation(ingEntity, RELATION_IDS.BRAND_NAMES, bnId);
      }
    });
  });

  const totalDupes = Object.values(dedupeStats).reduce((a, b) => a + b, 0);
  if (totalDupes > 0) {
    console.log(`📊 Deduplication stats:`);
    Object.entries(dedupeStats).forEach(([key, val]) => {
      if (val > 0) console.log(`   ${key}: ${val} duplicates removed`);
    });
  }

  if (SET_ID_ONLY && filteredNdcCount > 0) {
    console.log(`🧹 --set-id-only filtered out ${filteredNdcCount.toLocaleString()} NDCs without SPL_SET_ID`);
  }

  const allEntities = Array.from(entityMap.values());
  const entityLookup = new Map<string, string>(allEntities.map(e => [e.id, e.typeId]));
  const allOps: any[] = [];

  console.log(`🔄 Generating operations for ${allEntities.length} total entities...`);

  let skippedCount = 0;
  allEntities.forEach((entity) => {
    const normalizedId = entity.id.replace(/-/g, '');
    
    if (!DRY_RUN && existingIds.has(normalizedId)) {
      skippedCount++;
      return;
    }
    existingIds.add(normalizedId);

    const values: any[] = [];
    
    if (entity.typeId !== TYPE_IDS.NDC) {
      values.push({ property: PROPERTY_IDS.RXCUI, type: 'text', value: entity.rxcui });
    }
    
    if (entity.typeId === TYPE_IDS.NDC) {
      if (entity.NDC10) values.push({ property: PROPERTY_IDS.NDC10, type: 'text', value: entity.NDC10 });
      if (entity.NDC11) values.push({ property: PROPERTY_IDS.NDC11, type: 'text', value: entity.NDC11 });
      if (entity.SPL_SET_ID) values.push({ property: PROPERTY_IDS.SPL_SET_ID, type: 'text', value: entity.SPL_SET_ID });
    }
    
    if (entity.typeId === TYPE_IDS.IN) {
      if (entity.SMILES) values.push({ property: PROPERTY_IDS.SMILES, type: 'text', value: String(entity.SMILES) });
      if (entity.PMID) values.push({ property: PROPERTY_IDS.PMID, type: 'text', value: String(entity.PMID) });
      if (entity.INCHIKEY) values.push({ property: PROPERTY_IDS.INCHI_KEY, type: 'text', value: String(entity.INCHIKEY) });
    }

    const relations: Record<string, Array<{ toEntity: string }>> = {};
    if (entity.relations && typeof entity.relations === 'object') {
      for (const [relationId, targetSet] of Object.entries(entity.relations)) {
        if (targetSet instanceof Set && targetSet.size > 0) {
          const cleanList = Array.from(targetSet)
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
  if (!DRY_RUN && skippedCount > 0) {
    console.log(`   ⏭️  Skipped ${skippedCount} entities (already exist on-chain).`);
  }

  const timestamp = Date.now();

  if (DRY_RUN) {
    const summary = generateSummary(allEntities, ingredientsToImport);
    const summaryPath = path.join(DATA_DIR, `dry_run_summary_v4_${timestamp}.txt`);
    fs.writeFileSync(summaryPath, summary);
    console.log(`\n💾 Saved summary to: ${summaryPath}`);
  } else {
    const manifestPath = path.join(DATA_DIR, `manifest_v4_${timestamp}.json`);
    const manifest = {
      timestamp: new Date().toISOString(),
      batchName: `Import V4 ${INGREDIENT_LIMIT ? `Limit ${INGREDIENT_LIMIT}` : 'All'}${CONNECTED_ONLY ? ' (Connected Only)' : ''}${SET_ID_ONLY ? ' (SET_ID_ONLY)' : ''}`,
      spaceId: spaceId,
      spaceType: spaceInfo.type,
      entityIds: allEntities.map(e => e.id),
      entityCount: allEntities.length,
      opsCount: allOps.length,
      skippedCount,
      filteredNdcCount: SET_ID_ONLY ? filteredNdcCount : 0,
      dedupeStats
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\n💾 Saved manifest to: ${manifestPath}`);
  }

  if (DRY_RUN) {
    console.log('\n' + '='.repeat(60));
    console.log('DRY RUN COMPLETE');
    console.log('='.repeat(60));
    console.log(`\n📊 Summary:`);
    console.log(`   Ingredients processed: ${ingredientsToImport.length}`);
    console.log(`   Total entities generated: ${allEntities.length}`);
    console.log(`   Operations: ${allOps.length}`);
    if (SET_ID_ONLY) {
      console.log(`   NDCs filtered (no SPL_SET_ID): ${filteredNdcCount}`);
    }
    console.log(`\n📁 Review summary file. Re-run without --dry-run to publish.`);
    return;
  }

  if (allOps.length === 0) {
    console.log('\n✅ No new entities to publish. Everything is up to date.');
    return;
  }

  console.log('\n' + '='.repeat(60));
  console.log('PUBLISH PREVIEW');
  console.log('='.repeat(60));
  console.log(`   Space ID: ${spaceId}`);
  console.log(`   Space Type: ${spaceInfo.type}`);
  if (spaceInfo.type === 'DAO') {
    console.log(`   DAO Address: ${spaceInfo.address}`);
    console.log(`   Author: ${personalSpaceId}`);
  }
  console.log(`   Ingredients: ${ingredientsToImport.length}`);
  console.log(`   Total entities: ${allEntities.length}`);
  console.log(`   Operations: ${allOps.length}`);
  console.log(`   Skipped (already exist): ${skippedCount}`);
  if (SET_ID_ONLY) {
    console.log(`   Filtered NDCs (no SPL_SET_ID): ${filteredNdcCount}`);
  }
  if (spaceInfo.type === 'DAO') {
    console.log(`   ⚠️  DAO Space: This will create a PROPOSAL that requires voting.`);
  }
  console.log('='.repeat(60));

  const confirmed = await confirmPublish();
  if (!confirmed) {
    console.log('\n❌ Aborted. No data was published.');
    return;
  }

  // --- BATCHED PUBLISH ---
  await publishInBatches(
    allOps,
    spaceInfo,
    spaceId!,
    smartAccount!,
    personalSpaceId,
    INGREDIENT_LIMIT,
    CONNECTED_ONLY
  );
}

runImport().catch(console.error);
