// src/update_live_pricing_v2.ts
// Updates NADAC and Cost Plus pricing properties on existing NDC entities
// Supports both DAO and personal spaces

import 'dotenv/config';
import { Graph, personalSpace, daoSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';
import fs from 'fs';
import { TYPE_IDS, RELATION_IDS, PROPERTY_IDS } from './constants';

// =============================================================================
// CONFIGURATION (all from .env)
// =============================================================================
const API_URL = process.env.GEO_API_URL || "https://testnet-api.geobrowser.io/graphql";
const SPACE_ID = process.env.GEO_SPACE_ID || "";
const PERSONAL_SPACE_ID = process.env.GEO_PERSONAL_SPACE_ID || "";
const PRIVATE_KEY_RAW = process.env.GEO_WALLET_PRIVATE_KEY || "";
const IMPORT_FILE = process.env.GEO_IMPORT_FILE || "data_to_publish/full_geo_extraction_v22.4.jsonl";

// Pricing property IDs
const NADAC_PROPERTY_ID = "866fe5eeda584f1aba92522cfeccfac0";
const COSTPLUS_PROPERTY_ID = "a8c3eeb8f1ba45fca53094ccbe77351d";

// =============================================================================
// INTERFACES
// =============================================================================

interface PricingRecord {
  ndc11: string;
  nadac_unit_price: number | null;
  costplus_unit_price: number | null;
}

interface CurrentValues {
  nadac?: number;
  costplus?: number;
}

// =============================================================================
// CLI ARGUMENTS
// =============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {
    dryRun: false,
    batchSize: 2000,
    skipChangeDetection: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--dry-run":
      case "-d":
        flags.dryRun = true;
        break;
      case "--batch-size":
      case "-b":
        const size = parseInt(args[++i], 10);
        if (!isNaN(size) && size > 0) {
          flags.batchSize = size;
        } else {
          console.error('Invalid batch size: ' + args[i]);
          process.exit(1);
        }
        break;
      case "--skip-change-detection":
      case "-s":
        flags.skipChangeDetection = true;
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
    }
  }

  return flags;
}

function printHelp() {
  console.log(`
NDC Pricing Refresh Tool v2

Usage: bun run src/update_live_pricing_v2.ts [options]

Options:
  -d, --dry-run                  Preview changes without publishing
  -b, --batch-size <number>      Entities per batch (default: 2000)
  -s, --skip-change-detection    Update all matched entities regardless of current value
  -h, --help                     Show this help

Examples:
  bun run src/update_live_pricing_v2.ts --dry-run
  bun run src/update_live_pricing_v2.ts
  bun run src/update_live_pricing_v2.ts --skip-change-detection
`);
}

// =============================================================================
// SPACE DETECTION
// =============================================================================

async function detectSpaceType(spaceId: string): Promise<{ type: 'PERSONAL' | 'DAO'; address?: string }> {
  const query = 'query GetSpaceType { space(id: "' + spaceId + '") { id type address } }';
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
    console.error('❌ Space not found:', spaceId);
    process.exit(1);
  }
  return {
    type: json.data.space.type as 'PERSONAL' | 'DAO',
    address: json.data.space.address
  };
}

// =============================================================================
// GQL HELPERS
// =============================================================================

async function gql(query: string, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      if ((res.status >= 500 || res.status === 429) && attempt < maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.log('  ⚠ API ' + res.status + ', retry ' + attempt + '/' + maxRetries + ' in ' + delay + 'ms');
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        throw new Error('API error: ' + res.status + ' ' + res.statusText);
      }

      const json = await res.json();
      if (json.errors) {
        const msg = json.errors[0]?.message ?? 'Unknown';
        const isServerError = msg.includes('Unexpected error') || msg.includes('Internal');
        if (isServerError && attempt < maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          console.log('  ⚠ GraphQL: "' + msg + '", retry ' + attempt + '/' + maxRetries + ' in ' + delay + 'ms');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error('GraphQL: ' + msg);
      }
      return json.data;
    } catch (error: any) {
      const isRetryable = error instanceof SyntaxError ||
        error.message?.includes('fetch failed') ||
        error.message?.includes('ECONNRESET');
      if (isRetryable && attempt < maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.log('  ⚠ ' + error.message + ', retry ' + attempt + '/' + maxRetries + ' in ' + delay + 'ms');
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error('gql: exhausted all retries');
}

// =============================================================================
// NDC NORMALIZATION
// =============================================================================

function normalizeNdc(name: string): string {
  const raw = name.replace(/-/g, '');
  return raw.padStart(11, '0');
}

// =============================================================================
// LOAD PRICING DATA FROM JSONL
// =============================================================================

function loadPricingData(filePath: string): Map<string, PricingRecord> {
  console.log('\n📂 Loading pricing data from ' + filePath + '...');
  
  if (!fs.existsSync(filePath)) {
    throw new Error('JSONL file not found: ' + filePath);
  }
  
  const pricingMap = new Map<string, PricingRecord>();
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  
  console.log('  Parsing ' + lines.length.toLocaleString() + ' lines...');
  
  const extractFromScdArray = (scdArray: any[]) => {
    for (const scd of scdArray) {
      const ndcs = scd.ndcs || [];
      for (const ndc of ndcs) {
        const ndc11 = ndc.ndc11_no_hyphens;
        if (!ndc11) continue;
        
        const hasPricing = ndc.nadac_unit_price != null || ndc.costplus_unit_price != null;
        if (hasPricing) {
          pricingMap.set(ndc11, {
            ndc11,
            nadac_unit_price: ndc.nadac_unit_price ?? null,
            costplus_unit_price: ndc.costplus_unit_price ?? null,
          });
        }
      }
    }
  };
  
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const connections = record.connections || {};
      
      // Extract from direct SCD and SBD
      extractFromScdArray(connections.scd || []);
      extractFromScdArray(connections.sbd || []);
      
      // Extract from PINs (which have nested SCDs)
      for (const pin of (connections.pin || [])) {
        extractFromScdArray(pin.scd || []);
      }
      
      // Extract from MINs (which have nested SCDs)
      for (const min of (connections.min || [])) {
        extractFromScdArray(min.scd || []);
      }
    } catch (e) {
      // Skip malformed lines
    }
  }
  
  console.log('  ✓ Loaded ' + pricingMap.size.toLocaleString() + ' NDCs with pricing data');
  
  // Show sample
  const samples = Array.from(pricingMap.values()).slice(0, 3);
  console.log('  Sample records:');
  for (const s of samples) {
    console.log('    ' + s.ndc11 + ': NADAC=$' + (s.nadac_unit_price ?? 'null') + ', CostPlus=$' + (s.costplus_unit_price ?? 'null'));
  }
  
  return pricingMap;
}

// =============================================================================
// FETCH NDC ENTITIES WITH NDC11 PROPERTY VALUES
// =============================================================================

async function fetchNdcEntities(spaceId: string): Promise<Map<string, { entityId: string; name: string }>> {
  console.log('\n🔍 Fetching NDC entities with NDC11 property values...');
  
  const ndcMap = new Map<string, { entityId: string; name: string }>();
  const entities: any[] = [];
  let cursor: string | null = null;
  
  do {
    const afterParam = cursor ? ', after: "' + cursor + '"' : '';
    const query = '{ entitiesConnection(spaceId: "' + spaceId + '", typeId: "' + TYPE_IDS.NDC + '", first: 1000' + afterParam + ') { nodes { id name valuesList { propertyId text integer } } pageInfo { hasNextPage endCursor } } }';
    
    const data = await gql(query);
    const nodes = data?.entitiesConnection?.nodes || [];
    entities.push(...nodes);
    cursor = data?.entitiesConnection?.pageInfo?.endCursor;
    
    process.stdout.write('\r  Fetched ' + entities.length.toLocaleString() + ' NDC entities...');
    
    if (!data?.entitiesConnection?.pageInfo?.hasNextPage) break;
    await new Promise(r => setTimeout(r, 100));
  } while (true);
  
  console.log('\n  Total: ' + entities.length.toLocaleString() + ' NDC entities');
  
  // Build NDC11 -> entityId map using property values
  let matchedByProperty = 0;
  let matchedByName = 0;
  
  for (const entity of entities) {
    // First try to get NDC11 from property values
    const ndc11Prop = entity.valuesList?.find(
      (v: any) => v.propertyId === PROPERTY_IDS.NDC11
    );
    
    let ndc11: string | null = null;
    
    if (ndc11Prop) {
      ndc11 = ndc11Prop.text ?? ndc11Prop.integer?.toString() ?? null;
    }
    
    if (ndc11) {
      ndcMap.set(ndc11, { entityId: entity.id, name: entity.name });
      matchedByProperty++;
    } else {
      // Fallback: extract from entity name
      const nameNdc = normalizeNdc(entity.name);
      if (nameNdc && /^\d{11}$/.test(nameNdc)) {
        ndcMap.set(nameNdc, { entityId: entity.id, name: entity.name });
        matchedByName++;
      }
    }
  }
  
  console.log('  Matched by NDC11 property: ' + matchedByProperty.toLocaleString());
  console.log('  Matched by name extraction: ' + matchedByName.toLocaleString());
  console.log('  Total NDC11 -> entity mappings: ' + ndcMap.size.toLocaleString());
  
  return ndcMap;
}

// =============================================================================
// QUERY CURRENT PRICING VALUES
// =============================================================================

async function queryCurrentPricingValues(
  entityIds: string[],
  spaceId: string
): Promise<Map<string, CurrentValues>> {
  console.log('\n💰 Querying current pricing values for ' + entityIds.length.toLocaleString() + ' entities...');
  
  const values = new Map<string, CurrentValues>();
  const BATCH = 100;
  
  for (let i = 0; i < entityIds.length; i += BATCH) {
    const batch = entityIds.slice(i, i + BATCH);
    const idsFilter = batch.map(id => '"' + id + '"').join(',');
    
    const data = await gql('{ values(filter: { entityId: { in: [' + idsFilter + '] }, spaceId: { is: "' + spaceId + '" }, propertyId: { in: ["' + NADAC_PROPERTY_ID + '", "' + COSTPLUS_PROPERTY_ID + '"] } }) { entityId propertyId float decimal } }');
    
    const valueRows = data?.values ?? [];
    for (const row of valueRows) {
      const existing = values.get(row.entityId) || {};
      const priceValue = row.float ?? row.decimal;
      if (row.propertyId === NADAC_PROPERTY_ID && priceValue != null) {
        existing.nadac = parseFloat(priceValue);
      } else if (row.propertyId === COSTPLUS_PROPERTY_ID && priceValue != null) {
        existing.costplus = parseFloat(priceValue);
      }
      values.set(row.entityId, existing);
    }
    
    process.stdout.write('\r  Queried ' + Math.min(i + BATCH, entityIds.length).toLocaleString() + '/' + entityIds.length.toLocaleString() + ' entities...');
  }
  
  console.log('\n  ✓ Retrieved current values for ' + values.size.toLocaleString() + ' entities');
  return values;
}

// =============================================================================
// COMPARE VALUES
// =============================================================================

function hasValueChanged(current: number | undefined, proposed: number | null | undefined): boolean {
  if (current == null && proposed == null) return false;
  if (current == null || proposed == null) return true;
  return Math.abs(current - proposed) > 0.0001;
}

// =============================================================================
// BUILD UPDATE OPERATIONS
// =============================================================================

function buildPricingUpdateOps(
  entityId: string,
  pricing: PricingRecord,
  currentValues?: CurrentValues,
  skipChangeDetection: boolean = false
): { ops: any[]; stats: { needsNadacUpdate: boolean; needsCostPlusUpdate: boolean; currentNadac?: number; currentCostPlus?: number; newNadac?: number; newCostPlus?: number } } | null {
  
  const values: any[] = [];
  const stats = {
    needsNadacUpdate: false,
    needsCostPlusUpdate: false,
    currentNadac: currentValues?.nadac,
    currentCostPlus: currentValues?.costplus,
    newNadac: pricing.nadac_unit_price ?? undefined,
    newCostPlus: pricing.costplus_unit_price ?? undefined,
  };
  
  // Check NADAC
  if (pricing.nadac_unit_price != null && !isNaN(pricing.nadac_unit_price)) {
    if (skipChangeDetection || hasValueChanged(currentValues?.nadac, pricing.nadac_unit_price)) {
      values.push({
        property: NADAC_PROPERTY_ID,
        type: "float",
        value: pricing.nadac_unit_price,
      });
      stats.needsNadacUpdate = true;
    }
  }
  
  // Check Cost Plus
  if (pricing.costplus_unit_price != null && !isNaN(pricing.costplus_unit_price)) {
    if (skipChangeDetection || hasValueChanged(currentValues?.costplus, pricing.costplus_unit_price)) {
      values.push({
        property: COSTPLUS_PROPERTY_ID,
        type: "float",
        value: pricing.costplus_unit_price,
      });
      stats.needsCostPlusUpdate = true;
    }
  }
  
  if (values.length === 0) {
    return null;
  }
  
  const result = Graph.updateEntity({
    id: entityId,
    values: values,
  });
  
  return { ops: result.ops, stats };
}

// =============================================================================
// PUBLISHING
// =============================================================================

async function publishInBatches(
  allOps: any[],
  spaceInfo: { type: 'PERSONAL' | 'DAO'; address?: string },
  spaceId: string,
  smartAccount: any,
  personalSpaceId: string,
  proposalName: string,
  batchSize: number
): Promise<void> {
  
  const totalBatches = Math.ceil(allOps.length / batchSize);
  
  console.log('\n📦 Publishing ' + totalBatches + ' batch(es) to ' + spaceInfo.type + ' space...');
  console.log('   Batch size: ' + batchSize.toLocaleString() + ' ops\n');

  for (let i = 0; i < totalBatches; i++) {
    const batch = allOps.slice(i * batchSize, (i + 1) * batchSize);
    const batchNum = i + 1;
    
    const batchName = proposalName + ' (Batch ' + batchNum + '/' + totalBatches + ')';
    console.log('Batch ' + batchNum + '/' + totalBatches + ' (' + batch.length.toLocaleString() + ' ops)...');
    console.log('   Name: "' + batchName.substring(0, 60) + (batchName.length > 60 ? '...' : '') + '"');
    
    try {
      let to: `0x${string}`;
      let calldata: `0x${string}`;

      if (spaceInfo.type === 'DAO') {
        const result = await daoSpace.proposeEdit({
          name: batchName,
          ops: batch,
          author: personalSpaceId.replace(/-/g, ''),
          daoSpaceAddress: spaceInfo.address as `0x${string}`,
          callerSpaceId: '0x' + personalSpaceId.replace(/-/g, ''),
          daoSpaceId: '0x' + spaceId.replace(/-/g, ''),
          network: 'TESTNET',
        });
        to = result.to;
        calldata = result.calldata;
        console.log('   📝 Proposal ID: ' + result.proposalId);
      } else {
        const result = await personalSpace.publishEdit({
          name: batchName,
          spaceId: spaceId.replace(/-/g, ''),
          ops: batch,
          author: spaceId.replace(/-/g, ''),
          network: 'TESTNET',
        });
        to = result.to;
        calldata = result.calldata;
        console.log('   📝 IPFS: ' + result.cid);
      }

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log('   ✅ Broadcast: ' + txHash);
      console.log('   🔍 https://sepolia.basescan.org/tx/' + txHash + '\n');
      
      if (batchNum < totalBatches) await new Promise(r => setTimeout(r, 3000));
    } catch (e: any) {
      console.error('   ❌ Batch ' + batchNum + ' failed:', e.message);
      throw e;
    }
  }

  console.log('✅ All batches broadcast!\n');
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const flags = parseArgs();
  
  if (flags.help) {
    printHelp();
    return;
  }

  console.log('='.repeat(70));
  console.log('NDC PRICING REFRESH TOOL v2');
  console.log('='.repeat(70));
  console.log('Space ID: ' + SPACE_ID);
  console.log('Dry Run: ' + flags.dryRun);
  console.log('Batch Size: ' + flags.batchSize);
  console.log('Change Detection: ' + (flags.skipChangeDetection ? 'DISABLED' : 'ENABLED'));
  console.log('='.repeat(70));
  
  // Validate env vars
  if (!SPACE_ID) {
    console.error('❌ Missing GEO_SPACE_ID in .env');
    process.exit(1);
  }
  if (!PRIVATE_KEY_RAW) {
    console.error('❌ Missing GEO_WALLET_PRIVATE_KEY in .env');
    process.exit(1);
  }

  // Detect space type
  const spaceInfo = await detectSpaceType(SPACE_ID);
  
  if (spaceInfo.type === 'DAO' && !PERSONAL_SPACE_ID) {
    console.error('❌ GEO_PERSONAL_SPACE_ID required for DAO space');
    process.exit(1);
  }

  console.log('📋 Space: ' + SPACE_ID + ' (' + spaceInfo.type + ')\n');

  // Load pricing data
  const pricingData = loadPricingData(IMPORT_FILE);
  
  // Fetch NDC entities with NDC11 property values
  const existingNDCs = await fetchNdcEntities(SPACE_ID);
  
  // Find intersection
  const matchedNDCs: Array<{ ndc11: string; entityId: string; name: string; pricing: PricingRecord }> = [];
  const unmatchedPricing: PricingRecord[] = [];
  
  for (const [ndc11, pricing] of pricingData) {
    const existing = existingNDCs.get(ndc11);
    if (existing) {
      matchedNDCs.push({ ndc11, entityId: existing.entityId, name: existing.name, pricing });
    } else {
      unmatchedPricing.push(pricing);
    }
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('MATCH SUMMARY');
  console.log('='.repeat(70));
  console.log('NDCs in space: ' + existingNDCs.size.toLocaleString());
  console.log('NDCs with pricing data: ' + pricingData.size.toLocaleString());
  console.log('NDCs matched for potential update: ' + matchedNDCs.length.toLocaleString());
  console.log('NDCs in pricing data but not in space: ' + unmatchedPricing.length.toLocaleString());
  console.log('='.repeat(70) + '\n');
  
  if (matchedNDCs.length === 0) {
    console.log('No NDCs to update. Exiting.');
    return;
  }
  
  // Query current values for change detection
  let currentValuesMap = new Map<string, CurrentValues>();
  if (!flags.skipChangeDetection) {
    const entityIds = matchedNDCs.map(m => m.entityId);
    currentValuesMap = await queryCurrentPricingValues(entityIds, SPACE_ID);
  }
  
  // Determine what actually needs updating
  console.log('\n📊 Analyzing changes needed...');
  const toUpdate: typeof matchedNDCs = [];
  const unchanged: typeof matchedNDCs = [];
  const updateDetails = new Map<string, { needsNadacUpdate: boolean; needsCostPlusUpdate: boolean; currentNadac?: number; currentCostPlus?: number; newNadac?: number; newCostPlus?: number }>();
  
  for (const item of matchedNDCs) {
    const current = currentValuesMap.get(item.entityId);
    const result = buildPricingUpdateOps(item.entityId, item.pricing, current, flags.skipChangeDetection);
    
    if (result) {
      toUpdate.push(item);
      updateDetails.set(item.ndc11, result.stats);
    } else {
      unchanged.push(item);
    }
  }
  
  // Report analysis
  console.log('\n' + '='.repeat(70));
  console.log('CHANGE ANALYSIS');
  console.log('='.repeat(70));
  console.log('Entities needing updates: ' + toUpdate.length.toLocaleString());
  console.log('Entities already correct: ' + unchanged.length.toLocaleString());
  console.log('='.repeat(70));
  
  if (toUpdate.length === 0) {
    console.log('\n✓ All pricing values are already up to date. No changes needed.');
    return;
  }
  
  // Show breakdown by change type
  let nadacUpdates = 0;
  let costPlusUpdates = 0;
  let bothUpdates = 0;
  let nadacNew = 0;
  let costplusNew = 0;
  
  for (const stats of updateDetails.values()) {
    if (stats.needsNadacUpdate) {
      nadacUpdates++;
      if (stats.currentNadac == null) nadacNew++;
    }
    if (stats.needsCostPlusUpdate) {
      costPlusUpdates++;
      if (stats.currentCostPlus == null) costplusNew++;
    }
    if (stats.needsNadacUpdate && stats.needsCostPlusUpdate) bothUpdates++;
  }
  
  console.log('\nBreakdown of ' + toUpdate.length.toLocaleString() + ' updates:');
  console.log('  NADAC updates: ' + nadacUpdates.toLocaleString() + ' (' + nadacNew.toLocaleString() + ' new)');
  console.log('  Cost Plus updates: ' + costPlusUpdates.toLocaleString() + ' (' + costplusNew.toLocaleString() + ' new)');
  console.log('  Both properties: ' + bothUpdates.toLocaleString());
  
  // Preview sample changes
  console.log('\n📋 Sample changes:');
  
  const nadacExample = toUpdate.find(item => {
    const stats = updateDetails.get(item.ndc11);
    return stats?.needsNadacUpdate && !stats?.needsCostPlusUpdate;
  });
  
  const costPlusExample = toUpdate.find(item => {
    const stats = updateDetails.get(item.ndc11);
    return stats?.needsCostPlusUpdate && !stats?.needsNadacUpdate;
  });
  
  const bothExample = toUpdate.find(item => {
    const stats = updateDetails.get(item.ndc11);
    return stats?.needsNadacUpdate && stats?.needsCostPlusUpdate;
  });
  
  if (nadacExample) {
    const stats = updateDetails.get(nadacExample.ndc11)!;
    console.log('  NADAC only - ' + nadacExample.name + ':');
    console.log('    NADAC: $' + (stats.currentNadac ?? 'null') + ' → $' + stats.newNadac);
  }
  
  if (costPlusExample) {
    const stats = updateDetails.get(costPlusExample.ndc11)!;
    console.log('  Cost Plus only - ' + costPlusExample.name + ':');
    console.log('    Cost Plus: $' + (stats.currentCostPlus ?? 'null') + ' → $' + stats.newCostPlus);
  }
  
  if (bothExample) {
    const stats = updateDetails.get(bothExample.ndc11)!;
    console.log('  Both - ' + bothExample.name + ':');
    console.log('    NADAC: $' + (stats.currentNadac ?? 'null') + ' → $' + stats.newNadac);
    console.log('    Cost Plus: $' + (stats.currentCostPlus ?? 'null') + ' → $' + stats.newCostPlus);
  }
  
  if (unchanged.length > 0) {
    console.log('\n  Sample unchanged (first 3):');
    for (let i = 0; i < Math.min(3, unchanged.length); i++) {
      const { ndc11, name, pricing } = unchanged[i];
      const current = currentValuesMap.get(unchanged[i].entityId);
      console.log('    ' + name + ': NADAC=$' + (current?.nadac ?? 'null') + ' (new=$' + (pricing.nadac_unit_price ?? 'null') + '), CostPlus=$' + (current?.costplus ?? 'null') + ' (new=$' + (pricing.costplus_unit_price ?? 'null') + ')');
    }
  }
  
  // Generate all ops
  console.log('\n📝 Generating ops...');
  const allOps: any[] = [];
  
  for (const { ndc11, entityId, pricing } of toUpdate) {
    const current = currentValuesMap.get(entityId);
    const result = buildPricingUpdateOps(entityId, pricing, current, flags.skipChangeDetection);
    if (result) {
      allOps.push(...result.ops);
    }
  }
  
  console.log('  Total ops: ' + allOps.length.toLocaleString());
  
  if (flags.dryRun) {
    console.log('\n' + '='.repeat(70));
    console.log('🔍 DRY RUN MODE - No changes published');
    console.log('Would update ' + toUpdate.length.toLocaleString() + ' entities');
    console.log('Would generate ' + allOps.length.toLocaleString() + ' ops');
    console.log('Would create ' + Math.ceil(allOps.length / flags.batchSize) + ' proposal(s)');
    console.log('='.repeat(70) + '\n');
    return;
  }

  // Setup wallet
  const privateKey = (PRIVATE_KEY_RAW.startsWith('0x') ? PRIVATE_KEY_RAW : '0x' + PRIVATE_KEY_RAW) as Hex;
  const smartAccount = await getSmartAccountWalletClient({ privateKey });
  console.log('✅ Wallet ready\n');

  // Confirmation prompt
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  const confirmed = await new Promise<boolean>((resolve) => {
    rl.question('\n⚠️  Update pricing on ' + toUpdate.length.toLocaleString() + ' entities? [y/N]: ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });

  if (!confirmed) {
    console.log('❌ Aborted.\n');
    return;
  }

  const proposalName = 'Update NDC pricing (' + toUpdate.length.toLocaleString() + ' entities)';
  await publishInBatches(allOps, spaceInfo, SPACE_ID, smartAccount, PERSONAL_SPACE_ID, proposalName, flags.batchSize);
}

main().catch((error) => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
