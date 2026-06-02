// src/import_extracted_data_v12.ts
// V12: Full PIN nesting support - Add BPCK + GPCK pack entities
// Change: PIN children use same relation types as IN children (nesting via source entity, not relation UUID)
// V12 additions over V11: --connected-scd-only filter | 12 new NDC metadata fields | bpckSeen dedup

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { Graph, personalSpace, daoSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import { TYPE_IDS, RELATION_IDS, PROPERTY_IDS } from './constants';
import type { Hex } from 'viem';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// CONFIGURATION
// =============================================================================
const DATA_DIR = path.join(__dirname, '..', 'data_to_publish');
const DAO_MANIFEST_DIR = path.join(DATA_DIR, 'DAO_manifests');
const MASTER_FILE = path.join(DATA_DIR, 'full_geo_extraction_v25.jsonl'); // v12: v25
const API_URL = "https://testnet-api.geobrowser.io/graphql";

const BATCH_SIZE_PERSONAL = 80000;
const BATCH_SIZE_DAO = 2000;

// =============================================================================
// ARGUMENT PARSING
// =============================================================================
const args = process.argv.slice(2);
const INGREDIENT_LIMIT = (() => {
  const idx = args.indexOf('--limit');
  return idx !== -1 && args[idx + 1] ? parseInt(args[idx + 1], 10) : undefined;
})();
const TARGET_RXCUIS = (() => {
  const idx = args.indexOf('--import-rxcui');
  return idx !== -1 && args[idx + 1] ? args[idx + 1].split(',').map(s => s.trim()) : undefined;
})();
const PROPOSAL_NAME = (() => {
  const idx = args.indexOf('--proposal-name');
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
})();
const FORCE_PUBLISH   = args.includes('--force');
const CONNECTED_ONLY  = args.includes('--connected-only');
const CONNECTED_SCD_ONLY = args.includes('--connected-scd-only'); // v12 addition
const SET_ID_ONLY     = args.includes('--set-id-only');
const PRICING_ONLY    = args.includes('--pricing-only');
const DRY_RUN         = args.includes('--dry-run');

// =============================================================================
// TYPES
// =============================================================================
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
  NADAC_UNIT_PRICE?: number;
  COSTPLUS_UNIT_PRICE?: number;
  // ── v12: 12 new NDC metadata fields ──────────────────────────────────────
  FDA_DRUG_LABEL_TYPE?: string;
  US_DRUG_LABELER?: string;
  US_DRUG_APPROVAL_TYPE?: string;
  US_DRUG_APPLICATION_APPROVAL_NUMBER?: string;
  US_DRUG_MARKETING_START_DATE?: string;
  DRUG_MARKETING_STATUS?: string;
  DOSAGE_FORM_SIZE?: string;
  DOSAGE_FORM_COLOR_DESCRIPTION?: string;
  DOSAGE_FORM_SHAPE?: string;
  DOSAGE_FORM_COLOR?: string;
  DOSAGE_FORM_SCORE?: string;
  DOSAGE_FORM_IMPRINT_CODE?: string;
  [key: string]: any;
}

const TYPE_NAMES: Record<string, string> = {
  [TYPE_IDS.IN]:   'Ingredient',
  [TYPE_IDS.BN]:   'Brand',
  [TYPE_IDS.DF]:   'Dose Form',
  [TYPE_IDS.SBD]:  'SBD',
  [TYPE_IDS.SCD]:  'SCD',
  [TYPE_IDS.MIN]:  'MIN',
  [TYPE_IDS.PIN]:  'PIN',
  [TYPE_IDS.NDC]:  'NDC',
  [TYPE_IDS.GPCK]: 'GPCK',
  [TYPE_IDS.BPCK]: 'BPCK',
};

// =============================================================================
// UUID GENERATION
// =============================================================================
function generateUuid(rxcui: string, typeId: string): string {
  const seed = `${typeId}:${rxcui}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return [hash.slice(0,8), hash.slice(8,12), hash.slice(12,16), hash.slice(16,20), hash.slice(20,32)].join('-');
}

function generateNdcUuid(ndcCode: string): string {
  const seed = `${TYPE_IDS.NDC}:${ndcCode}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return [hash.slice(0,8), hash.slice(8,12), hash.slice(12,16), hash.slice(16,20), hash.slice(20,32)].join('-');
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
// FETCH EXISTING ENTITIES
// =============================================================================
async function fetchExistingEntityIds(spaceId: string): Promise<Set<string>> {
  console.log('\n🔍 Fetching existing entities from space...\n');
  const existingIds = new Set<string>();

  const typeIds = [
    { id: TYPE_IDS.IN,   name: 'Ingredient', short: 'IN'   },
    { id: TYPE_IDS.BN,   name: 'Brand',      short: 'BN'   },
    { id: TYPE_IDS.DF,   name: 'Dose Form',  short: 'DF'   },
    { id: TYPE_IDS.SCD,  name: 'SCD',        short: 'SCD'  },
    { id: TYPE_IDS.SBD,  name: 'SBD',        short: 'SBD'  },
    { id: TYPE_IDS.MIN,  name: 'MIN',        short: 'MIN'  },
    { id: TYPE_IDS.PIN,  name: 'PIN',        short: 'PIN'  },
    { id: TYPE_IDS.NDC,  name: 'NDC',        short: 'NDC'  },
    { id: TYPE_IDS.GPCK, name: 'GPCK',       short: 'GPCK' },
    { id: TYPE_IDS.BPCK, name: 'BPCK',       short: 'BPCK' },
  ];

  for (const type of typeIds) {
    let cursor: string | null = null;
    let count = 0;

    while (true) {
      const afterParam = cursor ? `, after: "${cursor}"` : '';
      const query = `{
        entitiesConnection(
          spaceId: "${spaceId}",
          typeId: "${type.id}",
          first: 1000${afterParam}
        ) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }`;

      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });

        const json = await res.json() as any;

        if (json.errors) {
          console.error(`  ⚠️  ${type.name}: ${json.errors[0].message}`);
          break;
        }

        const nodes    = json.data?.entitiesConnection?.nodes    || [];
        const pageInfo = json.data?.entitiesConnection?.pageInfo;

        nodes.forEach((e: any) => existingIds.add(e.id.replace(/-/g, '')));
        count += nodes.length;

        if (!pageInfo?.hasNextPage) break;
        cursor = pageInfo.endCursor;

        await new Promise(r => setTimeout(r, 50));
      } catch (e: any) {
        console.error(`  ⚠️  ${type.name}: ${e.message}`);
        break;
      }
    }

    if (count > 0) {
      console.log(`  ${type.short.padEnd(5)} ${count.toLocaleString().padStart(7)} existing`);
    }
  }

  console.log(`\n  Total: ${existingIds.size.toLocaleString()} existing entities\n`);
  return existingIds;
}

// =============================================================================
// ENTITY HELPERS
// =============================================================================
function getEntity(id: string, typeId: string, rxcui: string, name: string, entityMap: Map<string, Entity>): Entity {
  if (!entityMap.has(id)) {
    entityMap.set(id, { id, typeId, rxcui, name, relations: {} });
  }
  return entityMap.get(id)!;
}

function addRelation(entity: Entity, relationId: string, targetId: string): void {
  if (!entity.relations[relationId]) {
    entity.relations[relationId] = new Set<string>();
  }
  entity.relations[relationId].add(targetId);
}

function createNdcEntity(ndcData: any, entityMap: Map<string, Entity>, setIdOnly: boolean, pricingOnly: boolean): Entity | null {
  if (setIdOnly && !ndcData.spl_set_id) return null;

  if (pricingOnly) {
    const hasNadac    = ndcData.nadac_unit_price    !== undefined && ndcData.nadac_unit_price    !== null;
    const hasCostPlus = ndcData.costplus_unit_price !== undefined && ndcData.costplus_unit_price !== null;
    if (!hasNadac && !hasCostPlus) return null;
  }

  const ndcCanonical  = ndcData.ndc11_no_hyphens;
  const ndcId         = generateNdcUuid(ndcCanonical);
  const ndcDisplayName = `${ndcCanonical.slice(0,5)}-${ndcCanonical.slice(5,9)}-${ndcCanonical.slice(9,11)}`;

  const ndcEntity = getEntity(ndcId, TYPE_IDS.NDC, ndcCanonical, ndcDisplayName, entityMap);

  // ── v11 fields ─────────────────────────────────────────────────────────────
  if (ndcData.ndc10)              ndcEntity.NDC10              = ndcData.ndc10;
  if (ndcData.ndc11_no_hyphens)   ndcEntity.NDC11              = ndcData.ndc11_no_hyphens;
  if (ndcData.spl_set_id)         ndcEntity.SPL_SET_ID         = ndcData.spl_set_id;
  if (ndcData.nadac_unit_price    !== undefined) ndcEntity.NADAC_UNIT_PRICE    = ndcData.nadac_unit_price;
  if (ndcData.costplus_unit_price !== undefined) ndcEntity.COSTPLUS_UNIT_PRICE = ndcData.costplus_unit_price;

  // ── v12: 12 new NDC metadata fields ────────────────────────────────────────
  if (ndcData.label_type)                    ndcEntity.FDA_DRUG_LABEL_TYPE                    = ndcData.label_type;
  if (ndcData.labeler)                        ndcEntity.US_DRUG_LABELER                        = ndcData.labeler;
  if (ndcData.approval_type)                  ndcEntity.US_DRUG_APPROVAL_TYPE                  = ndcData.approval_type;
  if (ndcData.approval_number)    ndcEntity.US_DRUG_APPLICATION_APPROVAL_NUMBER    = ndcData.approval_number;
  if (ndcData.marketing_start)           ndcEntity.US_DRUG_MARKETING_START_DATE           = ndcData.marketing_start;
  if (ndcData.marketing_status)                  ndcEntity.DRUG_MARKETING_STATUS                  = ndcData.marketing_status;
  if (ndcData.size)                       ndcEntity.DOSAGE_FORM_SIZE                       = ndcData.size;
  if (ndcData.colortext)          ndcEntity.DOSAGE_FORM_COLOR_DESCRIPTION          = ndcData.colortext;
  if (ndcData.shape)                      ndcEntity.DOSAGE_FORM_SHAPE                      = ndcData.shape;
  if (ndcData.color)                      ndcEntity.DOSAGE_FORM_COLOR                      = ndcData.color;
  if (ndcData.score)                      ndcEntity.DOSAGE_FORM_SCORE                      = ndcData.score;
  if (ndcData.imprint)               ndcEntity.DOSAGE_FORM_IMPRINT_CODE               = ndcData.imprint;
  return ndcEntity;
}

// =============================================================================
// REPORTING
// =============================================================================
function generateReport(
  existingCount: number,
  newEntities: Entity[],
  skippedRelations: number,
  spaceType: string
): string {
  const lines: string[] = [];

  const newByType: Record<string, number> = {};
  newEntities.forEach(e => {
    const name = TYPE_NAMES[e.typeId] || e.typeId.substring(0,8);
    newByType[name] = (newByType[name] || 0) + 1;
  });

  lines.push('\n' + '='.repeat(60));
  lines.push(`IMPORT SUMMARY (${spaceType} SPACE)`);
  lines.push('='.repeat(60));
  lines.push(`  Found in space:     ${existingCount.toLocaleString().padStart(10)} existing`);
  lines.push(`  Will create:        ${newEntities.length.toLocaleString().padStart(10)} new`);
  if (skippedRelations > 0) {
    lines.push(`  Will skip:          ${skippedRelations.toLocaleString().padStart(10)} dup relations`);
  }

  if (newEntities.length > 0) {
    lines.push('\n' + '-'.repeat(60));
    lines.push('NEW ENTITIES BY TYPE');
    lines.push('-'.repeat(60));

    Object.entries(newByType)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        lines.push(`  ${type.padEnd(20)} ${count.toLocaleString().padStart(10)}`);
      });
  }

  if (newEntities.length > 0) {
    lines.push('\n' + '-'.repeat(60));
    lines.push('SAMPLE NEW ENTITIES');
    lines.push('-'.repeat(60));
    newEntities.slice(0, 10).forEach((e, i) => {
      const name = TYPE_NAMES[e.typeId] || 'Unknown';
      lines.push(`  ${i + 1}. ${e.name.substring(0,40).padEnd(42)} [${name}]`);
    });
    if (newEntities.length > 10) {
      lines.push(`  ... and ${(newEntities.length - 10).toLocaleString()} more`);
    }
  }

  lines.push('\n' + '='.repeat(60));

  return lines.join('\n');
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
  targetRxcuis: string[] | undefined,
  proposalName: string | undefined
): Promise<void> {

  const batchSize    = spaceInfo.type === 'DAO' ? BATCH_SIZE_DAO : BATCH_SIZE_PERSONAL;
  const totalBatches = Math.ceil(allOps.length / batchSize);

  console.log(`\n📦 Publishing ${totalBatches} batch(es) to ${spaceInfo.type} space...`);
  console.log(`   Batch size: ${batchSize.toLocaleString()} ops\n`);

  for (let i = 0; i < totalBatches; i++) {
    const batch    = allOps.slice(i * batchSize, (i + 1) * batchSize);
    const batchNum = i + 1;

    const batchName = proposalName
      ? `${proposalName} (Batch ${batchNum}/${totalBatches})`
      : `Import v12 ${targetRxcuis || 'Full'} Batch ${batchNum}/${totalBatches}`;

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
        cid      = result.cid;
        to       = result.to;
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
        cid      = result.cid;
        to       = result.to;
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
// MAIN IMPORT
// =============================================================================
async function runImport() {
  const rxcuiStr = TARGET_RXCUIS  ? ` (${TARGET_RXCUIS.join(', ')})` : '';
  const limitStr = INGREDIENT_LIMIT ? ` [limit: ${INGREDIENT_LIMIT}]` : '';
  const nameStr  = PROPOSAL_NAME  ? ` [name: "${PROPOSAL_NAME}"]`   : '';

  console.log(`\n🚀 Geo Import v12${rxcuiStr}${limitStr}${nameStr}`);
  console.log(`   🧬 PIN-nested biosimilars + GPCK/BPCK pack entities`);
  if (CONNECTED_SCD_ONLY) console.log('   🔗 Filter: connected SCDs only (no placeholders)');
  if (SET_ID_ONLY)        console.log('   🧩 Filter: NDCs with SPL_SET_ID only');
  if (PRICING_ONLY)       console.log('   💰 Filter: NDCs with pricing data only');
  if (DRY_RUN)            console.log('   🔍 DRY RUN');
  console.log('');

  const spaceId        = process.env.GEO_SPACE_ID;
  const personalSpaceId = process.env.GEO_PERSONAL_SPACE_ID;
  const privateKeyRaw  = process.env.GEO_WALLET_PRIVATE_KEY;

  if (!spaceId) {
    console.error('❌ Missing GEO_SPACE_ID');
    process.exit(1);
  }

  const spaceInfo = await detectSpaceType(spaceId);

  if (spaceInfo.type === 'DAO' && !personalSpaceId) {
    console.error('❌ GEO_PERSONAL_SPACE_ID required for DAO space');
    process.exit(1);
  }

  console.log(`📋 Space: ${spaceId} (${spaceInfo.type})`);
  if (spaceInfo.type === 'DAO') {
    console.log(`🏛️  DAO Address: ${spaceInfo.address}`);
    console.log(`👤 Author: ${personalSpaceId}`);
    if (PROPOSAL_NAME) console.log(`📝 Proposal Name: "${PROPOSAL_NAME}"`);
    console.log('');
  }

  let smartAccount: any = null;
  if (!DRY_RUN) {
    if (!privateKeyRaw) {
      console.error('❌ Missing GEO_WALLET_PRIVATE_KEY');
      process.exit(1);
    }
    const privateKey = (privateKeyRaw?.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
    smartAccount = await getSmartAccountWalletClient({ privateKey });
    console.log(`✅ Wallet ready\n`);
  }

  const existingIds = FORCE_PUBLISH ? new Set<string>() : await fetchExistingEntityIds(spaceId);

  if (!fs.existsSync(MASTER_FILE)) {
    console.error(`❌ File not found: ${MASTER_FILE}`);
    process.exit(1);
  }

  const rawData = fs.readFileSync(MASTER_FILE, 'utf-8');
  let allIngredients: any[] = rawData
    .split('\n')
    .filter(line => line.trim())
    .map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        console.error(`❌ Parse error line ${idx + 1}`);
        throw e;
      }
    });

  console.log(`📊 Found ${allIngredients.length} IN entries`);

  if (TARGET_RXCUIS) {
    const before = allIngredients.length;
    allIngredients = allIngredients.filter((ing: any) => TARGET_RXCUIS!.includes(String(ing.rxcui)));
    console.log(`📋 Filtered to ${allIngredients.length}/${before} target ingredients\n`);
  }

  let ingredientsToImport = INGREDIENT_LIMIT ? allIngredients.slice(0, INGREDIENT_LIMIT) : allIngredients;

  // v11: --connected-only filter (preserved exactly)
  if (CONNECTED_ONLY) {
    const before = ingredientsToImport.length;
    ingredientsToImport = ingredientsToImport.filter((ing: any) => {
      const conns = ing.connections || {};
      return Object.values(conns).some((arr: any) => Array.isArray(arr) && arr.length > 0);
    });
    console.log(`📋 Filtered to ${ingredientsToImport.length}/${before} with connections\n`);
  }

  console.log(`🏗️  Building entity graph from ${ingredientsToImport.length} ingredients...`);
  const entityMap = new Map<string, Entity>();
  let filteredNdcCount = 0;
  let pinNestedCount   = 0;
  const bpckSeen = new Set<string>(); // v12 addition

  ingredientsToImport.forEach((ing: any) => {
    const ingId     = generateUuid(ing.rxcui, TYPE_IDS.IN);
    const ingEntity = getEntity(ingId, TYPE_IDS.IN, ing.rxcui, ing.name, entityMap);

    if (ing.smiles)     ingEntity.SMILES   = ing.smiles;
    if (ing.pmid)       ingEntity.PMID     = ing.pmid;
    if (ing.inchi_key)  ingEntity.INCHIKEY = ing.inchi_key;

    const connections = ing.connections || {};

    // MIN processing (combo drugs)
    (connections.min || []).forEach((min: any) => {
      const minId     = generateUuid(min.rxcui, TYPE_IDS.MIN);
      const minEntity = getEntity(minId, TYPE_IDS.MIN, min.rxcui, min.name, entityMap);
      addRelation(ingEntity, RELATION_IDS.MULTIPLE_INGREDIENTS, minId);

      (min.combo_scds || []).forEach((scd: any) => {
        if (CONNECTED_SCD_ONLY && scd.placeholder) return;
        const scdId     = generateUuid(scd.rxcui, TYPE_IDS.SCD);
        const scdEntity = getEntity(scdId, TYPE_IDS.SCD, scd.rxcui, scd.name, entityMap);
        addRelation(minEntity, RELATION_IDS.SEMANTIC_CLINICAL_DRUGS, scdId);
        filteredNdcCount += processGpck(scdEntity, scd, entityMap, SET_ID_ONLY, PRICING_ONLY);
        filteredNdcCount += processBpck(scdEntity, scd, entityMap, SET_ID_ONLY, PRICING_ONLY, bpckSeen); // v12: bpckSeen
        (scd.ndcs || []).forEach((ndc: any) => {
          const ndcEnt = createNdcEntity(ndc, entityMap, SET_ID_ONLY, PRICING_ONLY);
          if (ndcEnt) addRelation(scdEntity, RELATION_IDS.NDCS, ndcEnt.id);
          else filteredNdcCount++;
        });
      });

      (min.combo_sbds || []).forEach((sbd: any) => {
        const sbdId     = generateUuid(sbd.rxcui, TYPE_IDS.SBD);
        const sbdEntity = getEntity(sbdId, TYPE_IDS.SBD, sbd.rxcui, sbd.name, entityMap);
        addRelation(minEntity, RELATION_IDS.SEMANTIC_BRANDED_DRUGS, sbdId);

        (sbd.ndcs || []).forEach((ndc: any) => {
          const ndcEnt = createNdcEntity(ndc, entityMap, SET_ID_ONLY, PRICING_ONLY);
          if (ndcEnt) addRelation(sbdEntity, RELATION_IDS.NDCS, ndcEnt.id);
          else filteredNdcCount++;
        });

        if (sbd.brand_name) {
          const bnId = generateUuid(sbd.brand_name.rxcui, TYPE_IDS.BN);
          getEntity(bnId, TYPE_IDS.BN, sbd.brand_name.rxcui, sbd.brand_name.name, entityMap);
          addRelation(sbdEntity, RELATION_IDS.BRAND_NAMES, bnId);
        }
        filteredNdcCount += processBpck(sbdEntity, sbd, entityMap, SET_ID_ONLY, PRICING_ONLY, bpckSeen); // v12: bpckSeen
      });
    });

    // V10: FLAT PIN processing (legacy v21 format - empty PINs)
    (connections.pin || []).forEach((pin: any) => {
      if (pin.scd?.length || pin.sbd?.length || pin.bn?.length || pin.df?.length) {
        return; // Skip nested PINs, process below
      }

      const pinId = generateUuid(pin.rxcui, TYPE_IDS.PIN);
      getEntity(pinId, TYPE_IDS.PIN, pin.rxcui, pin.name, entityMap);
      addRelation(ingEntity, RELATION_IDS.PRECISE_INGREDIENTS, pinId);
    });

    // V10: NESTED PIN processing (v23 PIN-nested biosimilars + GPCK/BPCK pack entities)
    (connections.pin || []).forEach((pin: any) => {
      if (!pin.scd?.length && !pin.sbd?.length && !pin.bn?.length && !pin.df?.length) {
        return; // Skip flat PINs, processed above
      }

      pinNestedCount++;
      const pinId     = generateUuid(pin.rxcui, TYPE_IDS.PIN);
      const pinEntity = getEntity(pinId, TYPE_IDS.PIN, pin.rxcui, pin.name, entityMap);

      addRelation(ingEntity, RELATION_IDS.PRECISE_INGREDIENTS, pinId);

      (pin.scd || []).forEach((scd: any) => {
        if (CONNECTED_SCD_ONLY && scd.placeholder) return;
        const scdId     = generateUuid(scd.rxcui, TYPE_IDS.SCD);
        const scdEntity = getEntity(scdId, TYPE_IDS.SCD, scd.rxcui, scd.name, entityMap);
        addRelation(pinEntity, RELATION_IDS.SEMANTIC_CLINICAL_DRUGS, scdId);
        filteredNdcCount += processGpck(scdEntity, scd, entityMap, SET_ID_ONLY, PRICING_ONLY);
        filteredNdcCount += processBpck(scdEntity, scd, entityMap, SET_ID_ONLY, PRICING_ONLY, bpckSeen); // v12: bpckSeen
        (scd.ndcs || []).forEach((ndc: any) => {
          const ndcEnt = createNdcEntity(ndc, entityMap, SET_ID_ONLY, PRICING_ONLY);
          if (ndcEnt) addRelation(scdEntity, RELATION_IDS.NDCS, ndcEnt.id);
          else filteredNdcCount++;
        });
      });

      (pin.bn || []).forEach((bn: any) => {
        const bnId = generateUuid(bn.rxcui, TYPE_IDS.BN);
        getEntity(bnId, TYPE_IDS.BN, bn.rxcui, bn.name, entityMap);
        addRelation(pinEntity, RELATION_IDS.BRAND_NAMES, bnId);
      });

      (pin.sbd || []).forEach((sbd: any) => {
        const sbdId     = generateUuid(sbd.rxcui, TYPE_IDS.SBD);
        const sbdEntity = getEntity(sbdId, TYPE_IDS.SBD, sbd.rxcui, sbd.name, entityMap);
        addRelation(pinEntity, RELATION_IDS.SEMANTIC_BRANDED_DRUGS, sbdId);
        filteredNdcCount += processBpck(sbdEntity, sbd, entityMap, SET_ID_ONLY, PRICING_ONLY, bpckSeen); // v12: bpckSeen

        (sbd.ndcs || []).forEach((ndc: any) => {
          const ndcEnt = createNdcEntity(ndc, entityMap, SET_ID_ONLY, PRICING_ONLY);
          if (ndcEnt) addRelation(sbdEntity, RELATION_IDS.NDCS, ndcEnt.id);
          else filteredNdcCount++;
        });

        if (sbd.brand_name) {
          const bnId = generateUuid(sbd.brand_name.rxcui, TYPE_IDS.BN);
          getEntity(bnId, TYPE_IDS.BN, sbd.brand_name.rxcui, sbd.brand_name.name, entityMap);
          addRelation(sbdEntity, RELATION_IDS.BRAND_NAMES, bnId);
        }
      });

      (pin.df || []).forEach((df: any) => {
        const dfId = generateUuid(df.rxcui, TYPE_IDS.DF);
        getEntity(dfId, TYPE_IDS.DF, df.rxcui, df.name, entityMap);
        addRelation(pinEntity, RELATION_IDS.DOSE_FORMS, dfId);
      });
    });

    // DFs (flat)
    (connections.df || []).forEach((df: any) => {
      const dfId = generateUuid(df.rxcui, TYPE_IDS.DF);
      getEntity(dfId, TYPE_IDS.DF, df.rxcui, df.name, entityMap);
      addRelation(ingEntity, RELATION_IDS.DOSE_FORMS, dfId);
    });

    // SCDs (flat)
    (connections.scd || []).forEach((scd: any) => {
      if (CONNECTED_SCD_ONLY && scd.placeholder) return;
      const scdId     = generateUuid(scd.rxcui, TYPE_IDS.SCD);
      const scdEntity = getEntity(scdId, TYPE_IDS.SCD, scd.rxcui, scd.name, entityMap);
      addRelation(ingEntity, RELATION_IDS.SEMANTIC_CLINICAL_DRUGS, scdId);
      filteredNdcCount += processGpck(scdEntity, scd, entityMap, SET_ID_ONLY, PRICING_ONLY);
      filteredNdcCount += processBpck(scdEntity, scd, entityMap, SET_ID_ONLY, PRICING_ONLY, bpckSeen); // v12: bpckSeen
      (scd.ndcs || []).forEach((ndc: any) => {
        const ndcEnt = createNdcEntity(ndc, entityMap, SET_ID_ONLY, PRICING_ONLY);
        if (ndcEnt) addRelation(scdEntity, RELATION_IDS.NDCS, ndcEnt.id);
        else filteredNdcCount++;
      });
    });

    // SBDs (flat)
    (connections.sbd || []).forEach((sbd: any) => {
      const sbdId     = generateUuid(sbd.rxcui, TYPE_IDS.SBD);
      const sbdEntity = getEntity(sbdId, TYPE_IDS.SBD, sbd.rxcui, sbd.name, entityMap);
      addRelation(ingEntity, RELATION_IDS.SEMANTIC_BRANDED_DRUGS, sbdId);
      filteredNdcCount += processBpck(sbdEntity, sbd, entityMap, SET_ID_ONLY, PRICING_ONLY, bpckSeen); // v12: bpckSeen

      (sbd.ndcs || []).forEach((ndc: any) => {
        const ndcEnt = createNdcEntity(ndc, entityMap, SET_ID_ONLY, PRICING_ONLY);
        if (ndcEnt) addRelation(sbdEntity, RELATION_IDS.NDCS, ndcEnt.id);
        else filteredNdcCount++;
      });

      if (sbd.brand_name) {
        const bnId = generateUuid(sbd.brand_name.rxcui, TYPE_IDS.BN);
        getEntity(bnId, TYPE_IDS.BN, sbd.brand_name.rxcui, sbd.brand_name.name, entityMap);
        addRelation(sbdEntity, RELATION_IDS.BRAND_NAMES, bnId);
      }
    });

    // BNs (flat)
    (connections.bn || []).forEach((bn: any) => {
      const bnId = generateUuid(bn.rxcui, TYPE_IDS.BN);
      getEntity(bnId, TYPE_IDS.BN, bn.rxcui, bn.name, entityMap);
      if (bn.is_combo !== true) {
        addRelation(ingEntity, RELATION_IDS.BRAND_NAMES, bnId);
      }
    });
  });

  // Explicit pass 1: MIN combo SBD brand names (v11 exact)
  for (const ing of ingredientsToImport) {
    for (const min of (ing.connections?.min || [])) {
      for (const sbd of (min.combo_sbds || [])) {
        if (!sbd.brand_name) continue;
        const sbdId     = generateUuid(sbd.rxcui, TYPE_IDS.SBD);
        const sbdEntity = entityMap.get(sbdId);
        if (!sbdEntity) continue;
        const bnId = generateUuid(sbd.brand_name.rxcui, TYPE_IDS.BN);
        getEntity(bnId, TYPE_IDS.BN, sbd.brand_name.rxcui, sbd.brand_name.name, entityMap);
        addRelation(sbdEntity, RELATION_IDS.BRAND_NAMES, bnId);
      }
    }
  }

  if (filteredNdcCount > 0) {
    console.log(`   Filtered out ${filteredNdcCount.toLocaleString()} NDCs`);
  }
  console.log(`   ${pinNestedCount} PINs with nested biosimilars\n`);

  // Explicit pass 2: MIN combo SBD brand names + direct MIN→BN (v11 exact)
  for (const ing of ingredientsToImport) {
    for (const min of (ing.connections?.min || [])) {
      const minId     = generateUuid(min.rxcui, TYPE_IDS.MIN);
      const minEntity = entityMap.get(minId);
      for (const sbd of (min.combo_sbds || [])) {
        if (!sbd.brand_name) continue;
        const sbdId     = generateUuid(sbd.rxcui, TYPE_IDS.SBD);
        const sbdEntity = entityMap.get(sbdId);
        const bnId      = generateUuid(sbd.brand_name.rxcui, TYPE_IDS.BN);
        getEntity(bnId, TYPE_IDS.BN, sbd.brand_name.rxcui, sbd.brand_name.name, entityMap);
        if (sbdEntity) addRelation(sbdEntity, RELATION_IDS.BRAND_NAMES, bnId);
        if (minEntity) addRelation(minEntity, RELATION_IDS.BRAND_NAMES, bnId);
      }
    }
  }

  // ===========================================================================
  // CLASSIFY
  // ===========================================================================
  const allEntities   = Array.from(entityMap.values());
  const newEntities: Entity[] = [];
  let skippedRelations = 0;

  allEntities.forEach((entity) => {
    const normalizedId = entity.id.replace(/-/g, '');
    if (existingIds.has(normalizedId)) {
      if (Object.keys(entity.relations).length > 0) skippedRelations++;
    } else {
      newEntities.push(entity);
      existingIds.add(normalizedId);
    }
  });

  const report = generateReport(existingIds.size - newEntities.length, newEntities, skippedRelations, spaceInfo.type);
  console.log(report);

  // ===========================================================================
  // GENERATE OPS
  // ===========================================================================
  const allOps: any[] = [];

  for (const entity of newEntities) {
    const values: any[] = [];

    if (entity.typeId !== TYPE_IDS.NDC) {
      values.push({ property: PROPERTY_IDS.RXCUI, type: 'text', value: entity.rxcui });
    }

    if (entity.typeId === TYPE_IDS.NDC) {
      if (entity.NDC10)             values.push({ property: PROPERTY_IDS.NDC10,             type: 'text',  value: entity.NDC10 });
      if (entity.NDC11)             values.push({ property: PROPERTY_IDS.NDC11,             type: 'text',  value: entity.NDC11 });
      if (entity.SPL_SET_ID)        values.push({ property: PROPERTY_IDS.SPL_SET_ID,        type: 'text',  value: entity.SPL_SET_ID });
      if (entity.NADAC_UNIT_PRICE    !== undefined) values.push({ property: PROPERTY_IDS.NADAC_UNIT_PRICE,    type: 'float', value: entity.NADAC_UNIT_PRICE });
      if (entity.COSTPLUS_UNIT_PRICE !== undefined) values.push({ property: PROPERTY_IDS.COST_PLUS_UNIT_PRICE, type: 'float', value: entity.COSTPLUS_UNIT_PRICE });
      // ── v12: 12 new NDC metadata fields ──────────────────────────────────
      if (entity.FDA_DRUG_LABEL_TYPE)                 values.push({ property: PROPERTY_IDS.FDA_DRUG_LABEL_TYPE,                 type: 'text', value: entity.FDA_DRUG_LABEL_TYPE });
      if (entity.US_DRUG_LABELER)                     values.push({ property: PROPERTY_IDS.US_DRUG_LABELER,                     type: 'text', value: entity.US_DRUG_LABELER });
      if (entity.US_DRUG_APPROVAL_TYPE)               values.push({ property: PROPERTY_IDS.US_DRUG_APPROVAL_TYPE,               type: 'text', value: entity.US_DRUG_APPROVAL_TYPE });
      if (entity.US_DRUG_APPLICATION_APPROVAL_NUMBER) values.push({ property: PROPERTY_IDS.US_DRUG_APPLICATION_APPROVAL_NUMBER, type: 'text', value: entity.US_DRUG_APPLICATION_APPROVAL_NUMBER });
      if (entity.US_DRUG_MARKETING_START_DATE)        values.push({ property: PROPERTY_IDS.US_DRUG_MARKETING_START_DATE,        type: 'text', value: entity.US_DRUG_MARKETING_START_DATE });
      if (entity.DRUG_MARKETING_STATUS)               values.push({ property: PROPERTY_IDS.DRUG_MARKETING_STATUS,               type: 'text', value: entity.DRUG_MARKETING_STATUS });
      if (entity.DOSAGE_FORM_SIZE)                    values.push({ property: PROPERTY_IDS.DOSAGE_FORM_SIZE,                    type: 'text', value: entity.DOSAGE_FORM_SIZE });
      if (entity.DOSAGE_FORM_COLOR_DESCRIPTION)       values.push({ property: PROPERTY_IDS.DOSAGE_FORM_COLOR_DESCRIPTION,       type: 'text', value: entity.DOSAGE_FORM_COLOR_DESCRIPTION });
      if (entity.DOSAGE_FORM_SHAPE)                   values.push({ property: PROPERTY_IDS.DOSAGE_FORM_SHAPE,                   type: 'text', value: entity.DOSAGE_FORM_SHAPE });
      if (entity.DOSAGE_FORM_COLOR)                   values.push({ property: PROPERTY_IDS.DOSAGE_FORM_COLOR,                   type: 'text', value: entity.DOSAGE_FORM_COLOR });
      if (entity.DOSAGE_FORM_SCORE)                   values.push({ property: PROPERTY_IDS.DOSAGE_FORM_SCORE,                   type: 'text', value: entity.DOSAGE_FORM_SCORE });
      if (entity.DOSAGE_FORM_IMPRINT_CODE)            values.push({ property: PROPERTY_IDS.DOSAGE_FORM_IMPRINT_CODE,            type: 'text', value: entity.DOSAGE_FORM_IMPRINT_CODE });
    }

    if (entity.typeId === TYPE_IDS.IN) {
      if (entity.SMILES)   values.push({ property: PROPERTY_IDS.SMILES,    type: 'text', value: String(entity.SMILES)   });
      if (entity.PMID)     values.push({ property: PROPERTY_IDS.PMID,      type: 'text', value: String(entity.PMID)     });
      if (entity.INCHIKEY) values.push({ property: PROPERTY_IDS.INCHI_KEY, type: 'text', value: String(entity.INCHIKEY) });
    }

    const relations: Record<string, Array<{toEntity: string}>> = {};
    for (const [relId, targetSet] of Object.entries(entity.relations)) {
      if (targetSet instanceof Set && targetSet.size > 0) {
        relations[relId] = Array.from(targetSet).map((id: string) => ({ toEntity: id }));
      }
    }

    try {
      const result = Graph.createEntity({
        id: entity.id,
        name: entity.name,
        types: [entity.typeId],
        values,
        relations
      });
      allOps.push(...result.ops);

    } catch (e: any) {
      console.error(`❌ Error creating ${entity.name}: ${e.message}`);
    }
  }
  const batchSize     = spaceInfo.type === 'DAO' ? BATCH_SIZE_DAO : BATCH_SIZE_PERSONAL;
  const batchesNeeded = Math.ceil(allOps.length / batchSize);

  console.log(`📊 Generated ${allOps.length.toLocaleString()} operations`);
  console.log(`   Batch size: ${batchSize.toLocaleString()}`);
  console.log(`   Batches: ${batchesNeeded}\n`);

  // ===========================================================================
  // MANIFEST
  // ===========================================================================
  const timestamp    = Date.now();
  const manifestData = {
    timestamp:    new Date().toISOString(),
    version:      'v12',
    spaceId,
    spaceType:    spaceInfo.type,
    proposalName: PROPOSAL_NAME || null,
    dryRun:       DRY_RUN,
    filters: {
      connectedScdOnly: CONNECTED_SCD_ONLY, // v12 addition
      setIdOnly:        SET_ID_ONLY,
      pricingOnly:      PRICING_ONLY,
    },
    stats: {
      existingTotal: existingIds.size - newEntities.length,
      newEntities:   newEntities.length,
      newByType:     newEntities.reduce((acc: any, e) => {
        const name = TYPE_NAMES[e.typeId] || 'Unknown';
        acc[name] = (acc[name] || 0) + 1;
        return acc;
      }, {}),
      pinNestedCount,
      operations: allOps.length,
      batchSize,
      batches:    batchesNeeded,
    },
    newEntityIds:      newEntities.map(e => e.id),
    sampleNewEntities: newEntities.slice(0, 20).map(e => ({
      id:   e.id,
      name: e.name,
      type: TYPE_NAMES[e.typeId],
    })),
  };

  let manifestDir = DATA_DIR;
  if (spaceInfo.type === 'DAO') {
    if (!fs.existsSync(DAO_MANIFEST_DIR)) {
      fs.mkdirSync(DAO_MANIFEST_DIR, { recursive: true });
      console.log(`📁 Created DAO manifest directory\n`);
    }
    manifestDir = DAO_MANIFEST_DIR;
  }

  const manifestPath = path.join(manifestDir,
    `${DRY_RUN ? 'dry_run' : 'publish'}_manifest_v12_${timestamp}.json`
  );

  fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));
  console.log(`💾 Manifest: ${path.relative(DATA_DIR, manifestPath)}\n`);

  // ===========================================================================
  // DRY RUN — stop here
  // ===========================================================================
  if (DRY_RUN || allOps.length === 0) {
    if (allOps.length === 0) console.log('✅ No new entities to create.\n');
    return;
  }

  // ===========================================================================
  // PUBLISH — confirm + broadcast
  // ===========================================================================
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirmed = await new Promise<boolean>((resolve) => {
    rl.question(`Publish to ${spaceInfo.type} space? [y/N]: `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });

  if (!confirmed) {
    console.log('❌ Aborted.\n');
    return;
  }

  await publishInBatches(allOps, spaceInfo, spaceId, smartAccount, personalSpaceId, TARGET_RXCUIS, PROPOSAL_NAME);
}

// =============================================================================
// PACK HELPERS  — exact copy of v11; only processBpck gains bpckSeen param
// =============================================================================
function processGpck(scdEntity: Entity, scd: any, entityMap: Map<string, Entity>, SET_ID_ONLY: boolean, PRICING_ONLY: boolean): number {
  let filtered = 0;
  for (const pack of (scd.gpck || [])) {
    const packId     = generateUuid(pack.rxcui, TYPE_IDS.GPCK);
    const packEntity = getEntity(packId, TYPE_IDS.GPCK, pack.rxcui, pack.name, entityMap);
    addRelation(scdEntity, RELATION_IDS.GENERIC_PACKS, packId);
    for (const ndc of (pack.ndcs || [])) {
      const ndcEnt = createNdcEntity(ndc, entityMap, SET_ID_ONLY, PRICING_ONLY);
      if (ndcEnt) addRelation(packEntity, RELATION_IDS.NDCS, ndcEnt.id);
      else filtered++;
    }
  }
  return filtered;
}

function processBpck(sbdEntity: Entity, sbd: any, entityMap: Map<string, Entity>, SET_ID_ONLY: boolean, PRICING_ONLY: boolean, bpckSeen: Set<string>): number {
  let filtered = 0;
  for (const pack of (sbd.bpck || [])) {
    if (bpckSeen.has(pack.rxcui)) continue;  // v12: skip already-processed BPCKs
    bpckSeen.add(pack.rxcui);                 // v12: mark as seen
    const packId     = generateUuid(pack.rxcui, TYPE_IDS.BPCK);
    const packEntity = getEntity(packId, TYPE_IDS.BPCK, pack.rxcui, pack.name, entityMap);
    addRelation(sbdEntity, RELATION_IDS.BRAND_PACKS, packId);
    for (const ndc of (pack.ndcs || [])) {
      const ndcEnt = createNdcEntity(ndc, entityMap, SET_ID_ONLY, PRICING_ONLY);
      if (ndcEnt) addRelation(packEntity, RELATION_IDS.NDCS, ndcEnt.id);
      else filtered++;
    }
  }
  return filtered;
}

runImport().catch(console.error);
