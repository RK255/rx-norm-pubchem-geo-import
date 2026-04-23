// src/delete_all_pharma.ts
import 'dotenv/config';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';
import { TYPE_IDS } from './constants';

const API_URL = "https://testnet-api.geobrowser.io/graphql";
const SPACE_ID = process.env.GEO_SPACE_ID;
const BATCH_SIZE = 500;

const FORCE_DELETE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

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

async function fetchEntitiesByType(typeId: string, label: string): Promise<string[]> {
  const query = `{ entities(filter: { typeIds: { in: ["${typeId}"] } }, first: 1000) { id spaceIds } }`;
  
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    
    const text = await res.text();
    const json = JSON.parse(text);
    
    if (json.errors) {
      throw new Error(json.errors[0].message);
    }
    
    const entities = json.data?.entities || [];
    const spaceEntities = entities.filter((e: any) => e.spaceIds?.includes(SPACE_ID));
    
    console.log(`  ${label}: ${spaceEntities.length} entities`);
    return spaceEntities.map((e: any) => e.id);
  } catch (e: any) {
    console.error(`  ❌ ${label} failed:`, e.message);
    return [];
  }
}

async function deleteEntities(entityIds: string[], typeName: string): Promise<void> {
  if (entityIds.length === 0) return;
  
  if (DRY_RUN) {
    console.log(`   (dry run: would delete ${entityIds.length})`);
    return;
  }

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

  console.log(`    Publishing ${publishBatches.length} batches...`);

  for (let i = 0; i < publishBatches.length; i++) {
    const batch = publishBatches[i];
    try {
      const { to, calldata } = await personalSpace.publishEdit({
        name: `Delete ${typeName} batch ${i+1}`,
        spaceId: SPACE_ID,
        ops: batch,
        author: SPACE_ID,
        network: "TESTNET",
      });

      await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`    ✓ Batch ${i+1}/${publishBatches.length} complete (${batch.length} ops)`);
      
      if (i < publishBatches.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e: any) {
      console.error(`    ❌ Batch ${i+1} failed:`, e.message);
    }
  }
}

async function runDelete() {
  if (!SPACE_ID) {
    console.error('❌ Missing GEO_SPACE_ID');
    process.exit(1);
  }
  
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!privateKeyRaw && !DRY_RUN) {
    console.error('❌ Missing GEO_WALLET_PRIVATE_KEY');
    process.exit(1);
  }
  
  console.log(`🧹 Pharma Entity Purge (Loop Until Empty)`);
  console.log(`🔍 Space: ${SPACE_ID}`);
  console.log(`📋 Mode: ${DRY_RUN ? 'DRY RUN' : FORCE_DELETE ? 'DELETE' : 'PREVIEW'}\n`);

  if (!FORCE_DELETE && !DRY_RUN) {
    console.log('⚠️  PREVIEW MODE - Add --force to actually delete\n');
  }

  let grandTotal = 0;

  for (const type of PHARMA_TYPES) {
    console.log(`\n📦 ${type.name}:`);
    let typeTotal = 0;
    let batchNum = 0;
    
    // LOOP until this type is empty
    while (true) {
      batchNum++;
      const ids = await fetchEntitiesByType(type.id, `batch ${batchNum}`);
      
      if (ids.length === 0) {
        if (typeTotal > 0) {
          console.log(`   ✅ ${type.name} cleared (${typeTotal} total)`);
        } else {
          console.log(`   (none found)`);
        }
        break;
      }
      
      if (FORCE_DELETE || DRY_RUN) {
        await deleteEntities(ids, type.name);
        typeTotal += ids.length;
        grandTotal += ids.length;
        
        if (DRY_RUN) {
          break; // Dry run only does one preview batch
        }
        
        // If we got 1000, there might be more
        if (ids.length === 1000) {
          console.log(`   🔍 Checking for more ${type.name}...`);
          await new Promise(r => setTimeout(r, 1500));
        } else {
          break; // Less than 1000 means we're done
        }
      } else {
        // Preview mode - just show and move on
        console.log(`   Found ${ids.length} entities`);
        break;
      }
    }
    
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 GRAND TOTAL: ${grandTotal} entities ${DRY_RUN ? 'would be' : 'were'} deleted`);
  
  if (!FORCE_DELETE && !DRY_RUN) {
    console.log(`\n⚠️  Run with --force to execute deletion`);
  }
}

runDelete().catch(console.error);
