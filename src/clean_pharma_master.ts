// src/clean_pharma_mega.ts
import 'dotenv/config';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';
import { TYPE_IDS } from './constants';

const API_URL = "https://testnet-api.geobrowser.io/graphql";
const SPACE_ID = process.env.GEO_SPACE_ID;
const FORCE_DELETE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

const TARGET_PER_TYPE = 20000; // Accumulate this many per type, then delete

const PHARMA_TYPES = [
  { id: TYPE_IDS.IN, name: 'Ingredient' },
  { id: TYPE_IDS.BN, name: 'Brand' },
  { id: TYPE_IDS.DF, name: 'Dose Form' },
  { id: TYPE_IDS.SCD, name: 'SCD' },
  { id: TYPE_IDS.SBD, name: 'SBD' },
  { id: TYPE_IDS.MIN, name: 'MIN' },
  { id: TYPE_IDS.PIN, name: 'PIN' },
  { id: TYPE_IDS.NDC, name: 'NDC' },
];

async function fetchWithCursor(typeId: string, after: string | null): Promise<{ ids: string[]; hasMore: boolean; endCursor: string | null }> {
  const afterParam = after ? `, after: "${after}"` : "";
  
  const query = `{ 
    entitiesConnection(
      spaceId: "${SPACE_ID}", 
      typeId: "${typeId}", 
      first: 1000${afterParam}
    ) { 
      nodes { id }
      pageInfo {
        hasNextPage
        endCursor
      }
    } 
  }`;
  
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  
  const nodes = json.data?.entitiesConnection?.nodes || [];
  const pageInfo = json.data?.entitiesConnection?.pageInfo;
  
  return {
    ids: nodes.map((e: any) => e.id),
    hasMore: pageInfo?.hasNextPage || false,
    endCursor: pageInfo?.endCursor || null
  };
}

async function deleteMegaBatch(entityIds: string[], typeName: string): Promise<number> {
  if (entityIds.length === 0) return 0;
  
  if (DRY_RUN) {
    console.log(`   (dry run: would delete ${entityIds.length})`);
    return entityIds.length;
  }

  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("GEO_WALLET_PRIVATE_KEY missing");

  const smartAccount = await getSmartAccountWalletClient({
    privateKey: (privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex
  });

  console.log(`  Generating ops for ${entityIds.length} ${typeName}...`);
  
  const deleteOps: any[] = [];
  for (let i = 0; i < entityIds.length; i += 100) {
    const batch = entityIds.slice(i, i + 100);
    const results = await Promise.all(
      batch.map(id => Graph.deleteEntity({ id, spaceId: SPACE_ID! }))
    );
    for (const result of results) {
      if (result?.ops) deleteOps.push(...result.ops);
    }
    process.stdout.write(`.`);
  }
  console.log(`\n  Generated ${deleteOps.length} ops`);

  if (deleteOps.length === 0) return 0;

  const midpoint = Math.ceil(deleteOps.length / 2);
  const batches = [
    deleteOps.slice(0, midpoint),
    deleteOps.slice(midpoint)
  ].filter(b => b.length > 0);

  console.log(`  Publishing ${batches.length} batch(es)...`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const { to, calldata } = await personalSpace.publishEdit({
        name: `Delete ${typeName} ${i + 1}/${batches.length}`,
        spaceId: SPACE_ID,
        ops: batch,
        author: SPACE_ID,
        network: "TESTNET",
      });

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`  ✓ Batch ${i + 1}/${batches.length}: ${txHash.slice(0, 24)}...`);
      
      if (i < batches.length - 1) await new Promise(r => setTimeout(r, 2000));
    } catch (e: any) {
      console.error(`  ❌ Batch ${i + 1} failed:`, e.message);
      throw e;
    }
  }
  
  return entityIds.length;
}

async function processType(typeId: string, typeName: string): Promise<number> {
  console.log(`\n📦 ${typeName}:`);
  let typeTotal = 0;
  let megaBatchNum = 0;

  while (true) {
    megaBatchNum++;
    const accumulatedIds: string[] = [];
    let cursor: string | null = null;
    
    console.log(`  Mega-batch ${megaBatchNum}: Fetching with cursor...`);
    
    // Accumulate up to TARGET_PER_TYPE
    while (accumulatedIds.length < TARGET_PER_TYPE) {
      const result = await fetchWithCursor(typeId, cursor);
      
      if (result.ids.length === 0) break;
      
      accumulatedIds.push(...result.ids);
      cursor = result.endCursor;
      
      process.stdout.write(`${accumulatedIds.length} `);
      
      if (!result.hasMore) break;
      await new Promise(r => setTimeout(r, 100));
    }
    
    console.log(`\n  Found ${accumulatedIds.length} ${typeName}`);
    
    if (accumulatedIds.length === 0) {
      if (typeTotal > 0) {
        console.log(`  ✅ ${typeName} complete (${typeTotal.toLocaleString()} total)`);
      } else {
        console.log(`  none found`);
      }
      break;
    }

    const deleted = await deleteMegaBatch(accumulatedIds, typeName);
    typeTotal += deleted;
    
    console.log(`  📊 ${typeName} progress: ${typeTotal.toLocaleString()}`);
    
    await new Promise(r => setTimeout(r, 2000));
  }

  return typeTotal;
}

async function runDelete() {
  if (!SPACE_ID) {
    console.error('❌ Missing GEO_SPACE_ID');
    process.exit(1);
  }
  
  if (!FORCE_DELETE && !DRY_RUN) {
    console.log('⚠️ PREVIEW MODE - Add --force to delete');
    process.exit(1);
  }

  console.log(`💊 Pharma Entity Mega-Purge`);
  console.log(`🔍 Space: ${SPACE_ID}`);
  console.log(`📋 Mode: ${DRY_RUN ? 'DRY RUN' : 'DELETE'}`);
  console.log(`🎯 Accumulate ${TARGET_PER_TYPE} per type\n`);

  let grandTotal = 0;

  for (const type of PHARMA_TYPES) {
    const count = await processType(type.id, type.name);
    grandTotal += count;
    
    // Pause between types
    if (!DRY_RUN) await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 GRAND TOTAL: ${grandTotal.toLocaleString()} entities ${DRY_RUN ? 'would be' : 'were'} deleted`);
  console.log(`🎉 Done!`);
}

runDelete().catch(console.error);
