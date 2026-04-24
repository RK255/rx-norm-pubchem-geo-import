// src/delete_ndc_entities_fast.ts
import 'dotenv/config';
import { personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import { parseId, deleteEntity } from '@geoprotocol/grc-20';
import type { Hex } from 'viem';
import { TYPE_IDS } from './constants';

const API_URL = "https://testnet-api.geobrowser.io/graphql";
const SPACE_ID = process.env.GEO_SPACE_ID;

const FORCE_DELETE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

const NDC_TYPE_ID = TYPE_IDS.NDC;
const PUBLISH_BATCH_SIZE = 500; // Ops per transaction
const FETCH_PAGE_SIZE = 1000;   // Entities per query

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
  const json = JSON.parse(text) as { errors?: any[]; data?: any };
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function fetchNdcPage(offset: number = 0): Promise<NdcEntity[]> {
  const query = `{
    entities(
      filter: { typeIds: { in: ["${NDC_TYPE_ID}"] } }, 
      first: ${FETCH_PAGE_SIZE},
      offset: ${offset}
    ) {
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

// FAST: Generate delete ops using grc-20 deleteEntity function
function generateDeleteOps(entityIds: string[], spaceId: string): any[] {
  const spaceIdBytes = parseId(spaceId);
  
  return entityIds.map(entityId => ({
    type: 'deleteEntity',  // lowercase, from your test
    id: parseId(entityId), // raw Uint8Array
    space: spaceIdBytes     // raw Uint8Array
  }));
}

async function deleteEntities(entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;
  
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("GEO_WALLET_PRIVATE_KEY missing");

  const smartAccount = await getSmartAccountWalletClient({
    privateKey: (privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex
  });

  // Generate ops FAST (no async!)
  console.log(`    Generating ${entityIds.length} delete ops...`);
  const deleteOps = generateDeleteOps(entityIds, SPACE_ID!);
  
  // Publish in batches
  const totalBatches = Math.ceil(deleteOps.length / PUBLISH_BATCH_SIZE);
  console.log(`    Publishing ${totalBatches} batches...`);

  for (let i = 0; i < totalBatches; i++) {
    const batch = deleteOps.slice(i * PUBLISH_BATCH_SIZE, (i + 1) * PUBLISH_BATCH_SIZE);
    
    try {
      const { to, calldata } = await personalSpace.publishEdit({
        name: `Delete NDCs batch ${i + 1}/${totalBatches}`,
        spaceId: SPACE_ID,
        ops: batch,
        author: SPACE_ID,
        network: "TESTNET",
      });

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      process.stdout.write(`✓`);
      
      if (i < totalBatches - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e: any) {
      console.error(`\n    ❌ Batch ${i + 1} failed:`, e.message);
    }
  }
  console.log(); // Newline after progress dots
}

async function runDelete() {
  if (!SPACE_ID) throw new Error("GEO_SPACE_ID missing in .env");

  console.log(`💊 NDC Entity Purge (FAST Mode)`);
  console.log(`🔍 Space: ${SPACE_ID}`);
  console.log(`⚡ Always fetching page 1 (offset 0) - deleted entities slide up!\n`);

  if (!FORCE_DELETE) {
    console.log('⚠️  PREVIEW MODE - Add --force to delete');
    process.exit(1);
  }

  let totalDeleted = 0;
  let pageNum = 0;

  // Loop until empty - always fetch page 1 (offset 0)
  while (true) {
    pageNum++;
    console.log(`\n📦 Batch ${pageNum}: Fetching first ${FETCH_PAGE_SIZE} NDCs...`);

    // ALWAYS offset 0 - deleted entities are gone, next batch slides into position!
    const ndcs = await fetchNdcPage(0);

    if (ndcs.length === 0) {
      if (totalDeleted === 0) {
        console.log('✅ No NDCs found. Space is clean!');
      } else {
        console.log('\n✅ No more NDCs found. All done!');
      }
      break;
    }

    console.log(`🗑️  Found ${ndcs.length} NDCs`);
    await deleteEntities(ndcs.map(e => e.id));
    totalDeleted += ndcs.length;

    console.log(`📊 Total deleted: ${totalDeleted.toLocaleString()}`);

    // Small delay before next batch
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n🎉 Complete! Deleted ${totalDeleted.toLocaleString()} NDCs total.`);
}

runDelete().catch(console.error);
