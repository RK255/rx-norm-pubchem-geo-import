// src/delete_ndc_cursor.ts
import 'dotenv/config';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';
import { TYPE_IDS } from './constants';

const API_URL = "https://testnet-api.geobrowser.io/graphql";
const SPACE_ID = process.env.GEO_SPACE_ID;
const FORCE_DELETE = process.argv.includes('--force');

const NDC_TYPE_ID = TYPE_IDS.NDC;
const TARGET_ACCUMULATE = 20000;

async function fetchNDCsCursor(after: string | null): Promise<{ ids: string[]; hasMore: boolean; endCursor: string | null }> {
  const afterParam = after ? `, after: "${after}"` : "";
  
  // Use entitiesConnection for cursor pagination
  const query = `{ 
    entitiesConnection(
      spaceId: "${SPACE_ID}", 
      typeId: "${NDC_TYPE_ID}", 
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

async function deleteBatch(entityIds: string[]): Promise<number> {
  if (entityIds.length === 0) return 0;

  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("GEO_WALLET_PRIVATE_KEY missing");

  const smartAccount = await getSmartAccountWalletClient({
    privateKey: (privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex
  });

  console.log(`  Generating ops for ${entityIds.length} entities...`);
  
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
        name: `Delete NDCs ${i + 1}/${batches.length}`,
        spaceId: SPACE_ID,
        ops: batch,
        author: SPACE_ID,
        network: "TESTNET",
      });

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`  ✓ Batch ${i + 1}/${batches.length}: ${txHash.slice(0, 24)}...`);
      
      if (i < batches.length - 1) await new Promise(r => setTimeout(r, 3000));
    } catch (e: any) {
      console.error(`  ❌ Batch ${i + 1} failed:`, e.message);
      throw e;
    }
  }
  
  return entityIds.length;
}

async function main() {
  if (!SPACE_ID) throw new Error("GEO_SPACE_ID missing");
  if (!FORCE_DELETE) {
    console.log('⚠️ PREVIEW MODE - Add --force to delete');
    process.exit(1);
  }

  console.log(`💊 NDC Cursor Pagination Delete`);
  console.log(`🔍 Space: ${SPACE_ID}`);
  console.log(`🎯 Accumulate ${TARGET_ACCUMULATE} using cursor pagination\n`);

  let totalDeleted = 0;
  let megaBatchNum = 0;

  while (true) {
    megaBatchNum++;
    const accumulatedIds: string[] = [];
    let cursor: string | null = null;
    
    console.log(`\n📦 Mega-batch ${megaBatchNum}: Fetching with cursor...`);
    
    while (accumulatedIds.length < TARGET_ACCUMULATE) {
      const result = await fetchNDCsCursor(cursor);
      
      if (result.ids.length === 0) break;
      
      accumulatedIds.push(...result.ids);
      cursor = result.endCursor;
      
      process.stdout.write(`${accumulatedIds.length} `);
      
      if (!result.hasMore) break;
      await new Promise(r => setTimeout(r, 100));
    }
    
    console.log(`\n🗑️  Accumulated ${accumulatedIds.length} NDCs`);
    
    if (accumulatedIds.length === 0) {
      console.log(`\n✅ Complete! Total deleted: ${totalDeleted.toLocaleString()}`);
      break;
    }

    const deleted = await deleteBatch(accumulatedIds);
    totalDeleted += deleted;
    
    console.log(`📊 Total: ${totalDeleted.toLocaleString()}`);
    
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`\n🎉 Deleted ${totalDeleted.toLocaleString()} NDCs total`);
}

main().catch(console.error);
