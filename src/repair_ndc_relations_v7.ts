// src/repair_ndc_relations_v7.ts
// Repairs missing NDC→Parent relations by matching NDCs to their SCD/SBD parents via RxCUI
// Uses relationsConnection to get ALL existing NDCS relations (avoids 100-relation truncation)
// Relations go: SCD/SBD --NDCS--> NDC

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

async function gql(query: string) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  
  if (!res.ok) throw new Error('API error: ' + res.status);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

// =============================================================================
// NDC NORMALIZATION
// =============================================================================

function normalizeNdc(name: string): string {
  const raw = name.replace(/-/g, '');
  return raw.padStart(11, '0');
}

// =============================================================================
// IMPORT FILE PARSING
// =============================================================================

function buildNdcParentMap(filePath: string): Map<string, { parentRxcui: string; parentName: string; parentTty: string }> {
  console.log('\n📂 Building NDC→Parent mapping from ' + filePath + '...');
  
  if (!fs.existsSync(filePath)) {
    console.log('  ⚠️  File not found:', filePath);
    return new Map();
  }
  
  const ndcMap = new Map<string, { parentRxcui: string; parentName: string; parentTty: string }>();
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  
  for (const line of lines) {
    try {
      const ingredient = JSON.parse(line);
      const connections = ingredient.connections || {};
      
      for (const scd of (connections.scd || [])) {
        for (const ndc of (scd.ndcs || [])) {
          if (ndc.ndc11_no_hyphens && scd.rxcui) {
            ndcMap.set(ndc.ndc11_no_hyphens, {
              parentRxcui: String(scd.rxcui),
              parentName: scd.name,
              parentTty: 'SCD',
            });
          }
        }
      }
      
      for (const sbd of (connections.sbd || [])) {
        for (const ndc of (sbd.ndcs || [])) {
          if (ndc.ndc11_no_hyphens && sbd.rxcui) {
            ndcMap.set(ndc.ndc11_no_hyphens, {
              parentRxcui: String(sbd.rxcui),
              parentName: sbd.name,
              parentTty: 'SBD',
            });
          }
        }
      }
      
      for (const pin of (connections.pin || [])) {
        for (const scd of (pin.scd || [])) {
          for (const ndc of (scd.ndcs || [])) {
            if (ndc.ndc11_no_hyphens && scd.rxcui) {
              ndcMap.set(ndc.ndc11_no_hyphens, {
                parentRxcui: String(scd.rxcui),
                parentName: scd.name,
                parentTty: 'SCD',
              });
            }
          }
        }
        for (const sbd of (pin.sbd || [])) {
          for (const ndc of (sbd.ndcs || [])) {
            if (ndc.ndc11_no_hyphens && sbd.rxcui) {
              ndcMap.set(ndc.ndc11_no_hyphens, {
                parentRxcui: String(sbd.rxcui),
                parentName: sbd.name,
                parentTty: 'SBD',
              });
            }
          }
        }
      }
    } catch {}
  }
  
  console.log('  Built ' + ndcMap.size.toLocaleString() + ' NDC→Parent mappings');
  return ndcMap;
}

// =============================================================================
// ENTITY FETCHING (with values for RxCUI lookup)
// =============================================================================

async function getAllEntities(spaceId: string) {
  const entities: any[] = [];
  let cursor: string | null = null;
  
  console.log('\n🔍 Fetching entities from space (with values)...');
  
  do {
    const afterParam = cursor ? ', after: "' + cursor + '"' : '';
    const query = '{ entitiesConnection(spaceId: "' + spaceId + '", first: 1000' + afterParam + ') { nodes { id name typeIds valuesList { propertyId text integer decimal } } pageInfo { hasNextPage endCursor } } }';
    
    const data = await gql(query);
    
    entities.push(...(data?.entitiesConnection?.nodes || []));
    cursor = data?.entitiesConnection?.pageInfo?.endCursor;
    
    process.stdout.write('\r  Fetched ' + entities.length.toLocaleString() + ' entities...');
    
    if (!data?.entitiesConnection?.pageInfo?.hasNextPage) break;
    await new Promise(r => setTimeout(r, 100));
  } while (true);
  
  console.log('\n  Total: ' + entities.length.toLocaleString() + ' entities');
  return entities;
}

// =============================================================================
// FETCH ALL NDCS RELATIONS (paginated, avoids 100-relation truncation)
// =============================================================================

async function getAllNdcsRelations(spaceEntityIds: Set<string>): Promise<Set<string>> {
  const existingRelations = new Set<string>();
  let cursor: string | null = null;
  
  console.log('\n🔗 Fetching ALL NDCS relations (paginated)...');
  
  do {
    const afterParam = cursor ? ', after: "' + cursor + '"' : '';
    const query = '{ relationsConnection(first: 1000' + afterParam + ', filter: { typeId: { is: "' + RELATION_IDS.NDCS + '" } }) { nodes { id fromEntityId toEntityId } pageInfo { hasNextPage endCursor } } }';
    
    const data = await gql(query);
    const nodes = data?.relationsConnection?.nodes || [];
    
    let spaceCount = 0;
    for (const rel of nodes) {
      // Only count relations where both entities are in our space
      if (spaceEntityIds.has(rel.fromEntityId) && spaceEntityIds.has(rel.toEntityId)) {
        existingRelations.add(rel.fromEntityId + ':' + rel.toEntityId);
        spaceCount++;
      }
    }
    
    cursor = data?.relationsConnection?.pageInfo?.endCursor;
    const totalFetched = existingRelations.size;
    
    process.stdout.write('\r  Fetched ' + totalFetched.toLocaleString() + ' NDCS relations (in-space)...');
    
    if (!data?.relationsConnection?.pageInfo?.hasNextPage) break;
    await new Promise(r => setTimeout(r, 100));
  } while (true);
  
  console.log('\n  Total NDCS relations in space: ' + existingRelations.size.toLocaleString());
  return existingRelations;
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
  proposalName: string
): Promise<void> {
  
  const batchSize = spaceInfo.type === 'DAO' ? 2000 : 80000;
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
      let cid: string;

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
        cid = result.cid;
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
        cid = result.cid;
        to = result.to;
        calldata = result.calldata;
        console.log('   📝 IPFS: ' + cid);
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
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes('--dry-run');
  const PRUNE_ORPHANS = args.includes('--prune-orphans');
  const proposalName = (() => {
    const idx = args.indexOf('--proposal-name');
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : 
      (PRUNE_ORPHANS ? 'Repair NDC relations + prune orphans' : 'Repair NDC parent relations');
  })();

  console.log('\n🔧 Repair NDC Parent Relations v7 (RxCUI + paginated relations)');
  console.log('   Relation: SCD/SBD --NDCS--> NDC');
  if (DRY_RUN) console.log('   🔍 DRY RUN - no changes will be published');
  if (PRUNE_ORPHANS) console.log('   🗑️  PRUNE MODE - will delete NDCs with no parent in import file');
  console.log('');

  // Validate env vars
  if (!SPACE_ID) {
    console.error('❌ Missing GEO_SPACE_ID in .env');
    process.exit(1);
  }
  if (!PRIVATE_KEY_RAW) {
    console.error('❌ Missing GEO_WALLET_PRIVATE_KEY in .env');
    process.exit(1);
  }

  const spaceInfo = await detectSpaceType(SPACE_ID);
  
  if (spaceInfo.type === 'DAO' && !PERSONAL_SPACE_ID) {
    console.error('❌ GEO_PERSONAL_SPACE_ID required for DAO space');
    process.exit(1);
  }

  console.log('📋 Space: ' + SPACE_ID + ' (' + spaceInfo.type + ')\n');

  // Load NDC→Parent mapping from import file
  const ndcParentMap = buildNdcParentMap(IMPORT_FILE);
  
  if (ndcParentMap.size === 0) {
    console.error('❌ No NDC mappings loaded - check file path: ' + IMPORT_FILE);
    process.exit(1);
  }

  // Fetch all entities (with values for RxCUI matching)
  const entities = await getAllEntities(SPACE_ID);
  
  // Build sets for lookups
  const spaceEntityIds = new Set<string>();
  const entityByRxcui = new Map<string, string>();
  const entityById = new Map<string, any>();
  let rxcuiCount = 0;
  
  for (const entity of entities) {
    spaceEntityIds.add(entity.id);
    entityById.set(entity.id, entity);
    
    const rxcuiEntry = entity.valuesList?.find(
      (v: any) => v.propertyId === PROPERTY_IDS.RXCUI
    );
    
    const rxcuiValue = rxcuiEntry?.text 
      ?? rxcuiEntry?.integer?.toString() 
      ?? rxcuiEntry?.decimal?.toString();
    
    if (rxcuiValue) {
      entityByRxcui.set(String(rxcuiValue), entity.id);
      rxcuiCount++;
    }
  }
  console.log('  Entities with RxCUI: ' + rxcuiCount.toLocaleString());
  
  // Fetch ALL NDCS relations (paginated, avoids 100-relation truncation)
  const existingRelations = await getAllNdcsRelations(spaceEntityIds);
  
  // Find NDC entities missing parent relation
  console.log('\n🔎 Finding orphaned NDCs (matching parents by RxCUI)...');
  
  const missing: Array<{ ndcEntityId: string; ndcName: string; parentId: string; parentName: string; parentRxcui: string }> = [];
  const alreadyLinked: Array<{ ndcEntityId: string; ndcName: string; parentId: string; parentName: string }> = [];
  const toPrune: Array<{ ndcEntityId: string; ndcName: string; reason: string }> = [];
  const stats = { totalNdc: 0, hasParent: 0, noParent: 0, noMapping: 0, parentNotInSpace: 0, alreadyLinked: 0 };
  
  for (const entity of entities) {
    if (!entity.typeIds?.includes(TYPE_IDS.NDC)) continue;
    stats.totalNdc++;
    
    const ndcCode = normalizeNdc(entity.name);
    const parentInfo = ndcParentMap.get(ndcCode);
    
    if (!parentInfo) {
      stats.noMapping++;
      toPrune.push({ ndcEntityId: entity.id, ndcName: entity.name, reason: 'no mapping for ' + ndcCode });
      continue;
    }
    
    // Match parent by RxCUI
    const parentId = entityByRxcui.get(parentInfo.parentRxcui);
    if (!parentId) {
      stats.parentNotInSpace++;
      toPrune.push({ 
        ndcEntityId: entity.id, 
        ndcName: entity.name, 
        reason: 'parent RxCUI ' + parentInfo.parentRxcui + ' (' + parentInfo.parentName + ') not in space' 
      });
      continue;
    }
    
    // Check if relation already exists: parentId -> ndcEntityId
    const relationKey = parentId + ':' + entity.id;
    if (existingRelations.has(relationKey)) {
      stats.hasParent++;
      stats.alreadyLinked++;
      continue;
    }
    
    stats.noParent++;
    
    missing.push({
      ndcEntityId: entity.id,
      ndcName: entity.name,
      parentId,
      parentName: parentInfo.parentName,
      parentRxcui: parentInfo.parentRxcui,
    });
  }
  
  console.log('\n📊 Statistics:');
  console.log('  Total NDC entities: ' + stats.totalNdc.toLocaleString());
  console.log('  Already linked to parent (via NDCS relation): ' + stats.hasParent.toLocaleString());
  console.log('  Missing parent (need to create relation): ' + stats.noParent.toLocaleString());
  console.log('    - No mapping in import file: ' + stats.noMapping.toLocaleString());
  console.log('    - Parent not in space (RxCUI lookup failed): ' + stats.parentNotInSpace.toLocaleString());
  console.log('  Ready to repair (link to parent): ' + missing.length.toLocaleString());
  console.log('  Could be pruned (orphans): ' + toPrune.length.toLocaleString());
  
  if (toPrune.length > 0 && toPrune.length <= 20) {
    console.log('\n⚠️  Orphans (showing all):');
    for (const nf of toPrune) {
      console.log('  ' + nf.ndcName + ' (' + nf.reason + ')');
    }
  } else if (toPrune.length > 20) {
    console.log('\n⚠️  Sample orphans (first 20):');
    for (const nf of toPrune.slice(0, 20)) {
      console.log('  ' + nf.ndcName + ' (' + nf.reason + ')');
    }
    console.log('  ... and ' + (toPrune.length - 20).toLocaleString() + ' more');
  }
  
  if (missing.length === 0 && (!PRUNE_ORPHANS || toPrune.length === 0)) {
    console.log('\n✅ Nothing to do. Done.\n');
    return;
  }
  
  if (missing.length > 0) {
    console.log('\n📋 Sample repairs (first 10):');
    for (const rel of missing.slice(0, 10)) {
      console.log('  ' + rel.parentName + ' [RxCUI: ' + rel.parentRxcui + ']');
      console.log('    --NDCS--> ' + rel.ndcName);
    }
  }
  
  // Generate ops
  console.log('\n📝 Generating ops...');
  const allOps: any[] = [];
  
  // Create relation ops
  let relSuccess = 0;
  let relError = 0;
  
  for (const rel of missing) {
    try {
      const result = Graph.createRelation({
        fromEntity: rel.parentId,
        toEntity: rel.ndcEntityId,
        type: RELATION_IDS.NDCS,
      });
      allOps.push(...result.ops);
      relSuccess++;
    } catch (e: any) {
      relError++;
      if (relError <= 5) {
        console.error('  ⚠️ Relation error for ' + rel.ndcName + ': ' + e.message);
      }
    }
  }
  
  console.log('  Create relation ops: ' + relSuccess.toLocaleString() + ' (' + relError + ' errors)');
  
  // Delete orphan ops
  let delSuccess = 0;
  let delError = 0;
  
  if (PRUNE_ORPHANS) {
    for (const orphan of toPrune) {
      try {
        const result = Graph.deleteEntity({ id: orphan.ndcEntityId });
        allOps.push(...result.ops);
        delSuccess++;
      } catch (e: any) {
        delError++;
        if (delError <= 5) {
          console.error('  ⚠️ Delete error for ' + orphan.ndcName + ': ' + e.message);
        }
      }
    }
    console.log('  Delete orphan ops: ' + delSuccess.toLocaleString() + ' (' + delError + ' errors)');
  }
  
  console.log('  Total ops: ' + allOps.length.toLocaleString());
  
  if (allOps.length === 0) {
    console.log('\n❌ No ops generated. Cannot proceed.\n');
    return;
  }

  if (DRY_RUN) {
    console.log('\n✅ Dry run complete. No changes published.\n');
    console.log('   Would create ' + relSuccess.toLocaleString() + ' relations');
    if (PRUNE_ORPHANS) console.log('   Would delete ' + delSuccess.toLocaleString() + ' orphan NDCs');
    console.log('   Would generate ' + allOps.length.toLocaleString() + ' ops\n');
    return;
  }

  // Setup wallet
  const privateKey = (PRIVATE_KEY_RAW.startsWith('0x') ? PRIVATE_KEY_RAW : '0x' + PRIVATE_KEY_RAW) as Hex;
  const smartAccount = await getSmartAccountWalletClient({ privateKey });
  console.log('✅ Wallet ready\n');

  // Confirmation prompt
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  const promptParts = [];
  if (relSuccess > 0) promptParts.push(relSuccess.toLocaleString() + ' relations');
  if (PRUNE_ORPHANS && delSuccess > 0) promptParts.push('delete ' + delSuccess.toLocaleString() + ' orphan NDCs');
  
  const confirmed = await new Promise<boolean>((resolve) => {
    rl.question('\nPublish ' + allOps.length.toLocaleString() + ' ops (' + promptParts.join(' + ') + ') to ' + spaceInfo.type + ' space? [y/N]: ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });

  if (!confirmed) {
    console.log('❌ Aborted.\n');
    return;
  }

  await publishInBatches(allOps, spaceInfo, SPACE_ID, smartAccount, PERSONAL_SPACE_ID, proposalName);
}

main().catch(console.error);
