// src/delete_pharma_entities.ts
import 'dotenv/config';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';
import { TYPE_IDS, PROPERTY_IDS } from './constants';

const API_URL = "https://testnet-api.geobrowser.io/graphql";
const SPACE_ID = process.env.GEO_SPACE_ID;

const FORCE_DELETE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

const PHARMA_TYPE_IDS = Object.values(TYPE_IDS);

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

async function fetchPharmaEntities(): Promise<string[]> {
  console.log(`🔍 Fetching all entities with RXCUI property...`);
  
  // Use values query (proven in import script) to get entities by property
  const query = `{
    values(filter: { 
      spaceId: { in: ["${SPACE_ID}"] },
      propertyId: { is: "${PROPERTY_IDS.RXCUI}" }
    }, first: 1000) {
      entityId
      entity {
        id
        types { id }
      }
    }
  }`;
  
  const data = await queryGeo(query);
  const values = data.values || [];
  
  console.log(`📊 Found ${values.length} values`);
  
  // Filter to only pharma types
  const entityIds: string[] = [];
  const seen = new Set<string>();
  
  for (const v of values) {
    const entityId = v.entity?.id || v.entityId;
    if (!entityId || seen.has(entityId)) continue;
    seen.add(entityId);
    
    const typeIds = v.entity?.types?.map((t: any) => t.id) || [];
    const isPharma = typeIds.some((id: string) => PHARMA_TYPE_IDS.includes(id));
    
    if (isPharma) entityIds.push(entityId);
  }
  
  return entityIds;
}

async function runDelete() {
  if (!SPACE_ID) throw new Error("GEO_SPACE_ID missing in .env");
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!privateKeyRaw && !DRY_RUN) throw new Error("GEO_WALLET_PRIVATE_KEY missing");

  console.log(`🧹 Pharma Entity Purge`);
  console.log(`🔍 Space: ${SPACE_ID}`);
  console.log(`📋 Dry Run: ${DRY_RUN ? 'YES' : 'NO'}\n`);

  const allEntityIds = await fetchPharmaEntities();
  
  console.log(`\n📊 TOTAL ENTITIES TO DELETE: ${allEntityIds.length}`);

  if (allEntityIds.length === 0) {
    console.log('✅ No pharma entities found. Space is clean!');
    return;
  }

  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN - Would delete:');
    allEntityIds.slice(0, 20).forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
    if (allEntityIds.length > 20) console.log(`  ... and ${allEntityIds.length - 20} more`);
    console.log('\n💡 Run with --force to execute');
    return;
  }

  if (!FORCE_DELETE) {
    console.log('\n⚠️  WARNING: This will PERMANENTLY DELETE all listed entities!');
    console.log('   Use --force to skip confirmation.\n');
    console.log('   bun run src/delete_pharma_entities.ts --force');
    process.exit(1);
  }

  console.log(`\n🔐 Initializing wallet...`);
  const smartAccount = await getSmartAccountWalletClient({
    privateKey: (privateKeyRaw!.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex
  });

  console.log(`🔄 Generating delete operations...`);
  const deleteOps: any[] = [];

  for (const entityId of allEntityIds) {
    try {
      const result = await Graph.deleteEntity({ 
        id: entityId,
        spaceId: SPACE_ID
      });
      if (result?.ops && result.ops.length > 0) {
        deleteOps.push(...result.ops);
      }
    } catch (e) {
      console.error(`  ❌ Failed to generate delete for ${entityId}:`, e);
    }
  }

  console.log(`📊 Generated ${deleteOps.length} operations`);

  if (deleteOps.length === 0) {
    console.log('⚠️  No operations generated. Check if entities are already deleted or if SDK delete method exists.');
    return;
  }

  const BATCH_SIZE = 500;
  const batches = [];
  for (let i = 0; i < deleteOps.length; i += BATCH_SIZE) {
    batches.push(deleteOps.slice(i, i + BATCH_SIZE));
  }

  console.log(`\n🚀 Publishing ${batches.length} batch(es)...`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`  Batch ${i + 1}/${batches.length} (${batch.length} ops)...`);

    try {
      const { to, calldata } = await personalSpace.publishEdit({
        name: `Delete Pharma Entities (${i + 1}/${batches.length})`,
        spaceId: SPACE_ID,
        ops: batch,
        author: SPACE_ID,
        network: "TESTNET",
      });

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`  ✅ TX: ${txHash}`);
      if (i < batches.length - 1) await new Promise(r => setTimeout(r, 3000));
    } catch (e: any) {
      console.error(`  ❌ Batch ${i + 1} failed:`, e.message || e);
    }
  }

  console.log('\n🎉 Done!');
}

runDelete().catch(console.error);
