// src/delete_ndc_entities.ts
import 'dotenv/config';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';
import { TYPE_IDS } from './constants';

const API_URL = "https://testnet-api.geobrowser.io/graphql";
const SPACE_ID = process.env.GEO_SPACE_ID;

const FORCE_DELETE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

const NDC_TYPE_ID = TYPE_IDS.NDC;
const BATCH_SIZE = 500;

interface NdcEntity {
  id: string;
  name: string;
}

async function queryGeo(query: string) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  
  const text = await res.text();
  try {
    const json = JSON.parse(text) as { errors?: any[]; data?: any };
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
  } catch (e) {
    console.error('❌ Raw response:', text.substring(0, 500));
    throw e;
  }
}

async function fetchNdcBatch(): Promise<NdcEntity[]> {
  const query = `{
    entities(filter: { typeIds: { in: ["${NDC_TYPE_ID}"] } }, first: 1000) {
      id
      name
      spaceIds
    }
  }`;
  
  try {
    const data = await queryGeo(query);
    const entities = data.entities || [];
    
    return entities
      .filter((e: any) => e.spaceIds?.includes(SPACE_ID))
      .map((e: any) => ({ id: e.id, name: e.name }));
  } catch (e: any) {
    console.error('  ❌ Fetch failed:', e.message);
    return [];
  }
}

async function deleteEntities(entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;
  
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("GEO_WALLET_PRIVATE_KEY missing");

  const smartAccount = await getSmartAccountWalletClient({
    privateKey: (privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex
  });

  const deleteOps: any[] = [];

  for (const entityId of entityIds) {
    try {
      const result = await Graph.deleteEntity({ 
        id: entityId,
        spaceId: SPACE_ID
      });
      if (result?.ops?.length) {
        deleteOps.push(...result.ops);
      }
    } catch (e) {
      console.error(`  ❌ Failed to generate delete for ${entityId}:`, e);
    }
  }

  if (deleteOps.length === 0) return;

  const publishBatches = [];
  for (let i = 0; i < deleteOps.length; i += BATCH_SIZE) {
    publishBatches.push(deleteOps.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < publishBatches.length; i++) {
    const batch = publishBatches[i];
    console.log(`    Publishing ${i + 1}/${publishBatches.length} (${batch.length} ops)...`);

    try {
      const { to, calldata } = await personalSpace.publishEdit({
        name: `Delete NDCs batch`,
        spaceId: SPACE_ID,
        ops: batch,
        author: SPACE_ID,
        network: "TESTNET",
      });

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      if (i < publishBatches.length - 1) {
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (e: any) {
      console.error(`    ❌ Batch failed:`, e.message || e);
    }
  }
}

async function runDelete() {
  if (!SPACE_ID) throw new Error("GEO_SPACE_ID missing in .env");
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!privateKeyRaw && !DRY_RUN) throw new Error("GEO_WALLET_PRIVATE_KEY missing");

  console.log(`💊 NDC Entity Purge (Batch Mode)`);
  console.log(`🔍 Space: ${SPACE_ID}`);
  console.log(`📋 Mode: ${DRY_RUN ? 'DRY RUN' : FORCE_DELETE ? 'DELETE' : 'PREVIEW'}\n`);

  if (DRY_RUN) {
    const ndcs = await fetchNdcBatch();
    console.log(`\n📊 Sample batch: ${ndcs.length} NDCs found`);
    if (ndcs.length > 0) {
      console.log('\n  Sample NDCs:');
      ndcs.slice(0, 5).forEach((e, i) => {
        console.log(`    ${i + 1}. ${e.name || '(unnamed)'} (${e.id.substring(0, 8)}...)`);
      });
    }
    console.log('\n🔍 DRY RUN. Run with --force to delete in batches until empty.');
    return;
  }

  if (!FORCE_DELETE) {
    console.log('\n⚠️  WARNING: This will delete NDCs in batches of 1000 until none remain.');
    console.log('   Use --force to execute.\n');
    console.log('   bun run src/delete_ndc_entities.ts --force');
    process.exit(1);
  }

  let totalDeleted = 0;
  let batchNum = 0;
  
  while (true) {
    batchNum++;
    
    console.log(`\n📦 Batch ${batchNum}: Fetching...`);
    const ndcs = await fetchNdcBatch();
    
    if (ndcs.length === 0) {
      console.log('\n✅ No more NDCs found. All done!');
      break;
    }
    
    console.log(`🗑️  Deleting ${ndcs.length} NDCs...`);
    await deleteEntities(ndcs.map(e => e.id));
    totalDeleted += ndcs.length;
    
    console.log(`📊 Total deleted so far: ${totalDeleted}`);
    
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n🎉 Complete! Deleted ${totalDeleted} NDCs total.`);
}

runDelete().catch(console.error);
