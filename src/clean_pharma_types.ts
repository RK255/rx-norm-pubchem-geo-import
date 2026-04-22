import 'dotenv/config';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';
import { TYPE_IDS, PROPERTY_IDS } from './constants'; // FIXED: Removed the extra 'src/'

// --- CONFIGURATION ---
const API_URL = "https://testnet-api.geobrowser.io/graphql";
const SPACE_ID = process.env.GEO_SPACE_ID;

// --- GQL HELPER ---
async function queryGeo(query: string) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = await res.json() as { errors?: any[]; data?: any };
    if (json.errors) {
    const err = json.errors[0];
    throw new Error(err.message || JSON.stringify(err));
  }
  return json.data;
}

async function runClean() {
  if (!SPACE_ID) throw new Error("GEO_SPACE_ID missing in .env");

  console.log(`🧹 Starting "Final Clean Sweep" (Proven Method)...`);
  console.log(`🎯 Strategy: Unset NAME property for all Pharma types.\n`);

  const targetTypeIds = Object.values(TYPE_IDS);

  for (const typeId of targetTypeIds) {
    console.log(`\n🔍 Scanning Type ID: ${typeId}`);
    
    // LOOP PROTECTION: Track IDs we have processed
    const seenIds = new Set<string>();
    let hasMore = true;
    let loopCount = 0;
    const MAX_LOOPS = 5;

    while (hasMore && loopCount < MAX_LOOPS) {
      loopCount++;
      console.log(`   🔄 Loop #${loopCount}...`);

      // 1. QUERY: Get entities of this type
      const query = `{
        entities(filter: { typeIds: { in: ["${typeId}"] } }, first: 1000) {
          id
        }
      }`;

      const data = await queryGeo(query);
      const entities = data.entities || [];

      if (entities.length === 0) {
        console.log(`   ✅ No entities found for this type.`);
        hasMore = false;
        continue;
      }

      // 2. FILTER: Only keep entities we haven't processed yet
      const newEntities = entities.filter((e: any) => !seenIds.has(e.id));
      
      if (newEntities.length === 0) {
        console.log(`   ✅ All entities processed. No new work.`);
        hasMore = false;
        continue;
      }

      console.log(`   🎯 Found ${newEntities.length} new entities. Stripping Names...`);
      
      // Mark them as seen immediately
      newEntities.forEach((e: any) => seenIds.add(e.id));

      // 3. GENERATE OPS: Unset the Name property
      const ops: any[] = [];

      for (const entity of newEntities) {
        const entityId = entity.id;
        
        try {
          // PROVEN STRATEGY: Use updateEntity to unset NAME
          const result = Graph.updateEntity({ 
            id: entityId, 
            unset: [{ property: PROPERTY_IDS.NAME }] 
          });
          
          if (result && result.ops && result.ops.length > 0) {
            ops.push(...result.ops);
          } else {
            // If it returns no ops, it's likely already stripped (shouldn't happen with logic above)
            console.warn(`   ⚠️  No ops generated for ${entityId}.`);
          }
        } catch (e) {
          console.error(`   ❌ Error updating entity ${entityId}:`, e);
        }
      }

      if (ops.length === 0) {
        console.log(`   ⚠️  No operations generated. Skipping publish.`);
        continue;
      }

      // 4. PUBLISH
      const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
      if (!privateKeyRaw) throw new Error("GEO_WALLET_PRIVATE_KEY missing");
      
      const smartAccount = await getSmartAccountWalletClient({
        privateKey: (privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex
      });

      console.log(`   🚀 Publishing batch (${ops.length} ops)...`);
      try {
        const { to, calldata } = await personalSpace.publishEdit({
          name: `Strip Pharma Names (${typeId})`,
          spaceId: SPACE_ID,
          ops: ops,
          author: SPACE_ID,
          network: "TESTNET",
        });

        const txHash = await smartAccount.sendTransaction({ to, data: calldata });
        console.log(`   ✅ Batch Deleted. TX: ${txHash}`);
      } catch (txError) {
        console.error(`   ❌ Transaction failed:`, txError);
      }
      
      // 5s delay for propagation
      console.log(`   ⏳ Waiting 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }

    if (loopCount >= MAX_LOOPS) {
        console.log(`   ⚠️  Hit max loop limit.`);
    }
  }

  console.log('\n🎉 All types processed. Space should be clean.');
}

runClean().catch(console.error);
