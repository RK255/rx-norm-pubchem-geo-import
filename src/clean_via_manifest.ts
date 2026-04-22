import 'dotenv/config';
import fs from 'fs';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';
import { PROPERTY_IDS } from './constants'; 

// --- CONFIGURATION ---
const SPACE_ID = process.env.GEO_SPACE_ID;
const MANIFEST_PATH = 'data_to_publish/manifest_1776818432036.json';
const BATCH_SIZE = 2000; // Increased to 2000 for speed. 5000 might fail due to block gas limits.

async function runManifestClean() {
  if (!SPACE_ID) throw new Error("GEO_SPACE_ID missing in .env");

  console.log(`📂 Loading manifest from ${MANIFEST_PATH}...`);

  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest file not found at ${MANIFEST_PATH}`);
  }

  const fileContent = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  let manifestData;

  try {
    manifestData = JSON.parse(fileContent);
  } catch (e) {
    throw new Error("Failed to parse manifest JSON");
  }

  // Extract entityIds from the manifest
  const entityIds = manifestData.entityIds || [];

  if (!Array.isArray(entityIds) || entityIds.length === 0) {
    console.log('No entity IDs found in manifest.');
    return;
  }

  console.log(`✅ Found ${entityIds.length} entities in manifest.\n`);

  // --- PROCESS IN BATCHES ---
  // Normalize IDs: Remove hyphens to match the UI format (SDK prefers this format)
  const normalizedIds = entityIds.map((id: string) => id.replace(/-/g, ''));
  
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  
  if (!privateKeyRaw) throw new Error("GEO_WALLET_PRIVATE_KEY missing");
  
  const smartAccount = await getSmartAccountWalletClient({
    privateKey: (privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex
  });

  for (let i = 0; i < normalizedIds.length; i += BATCH_SIZE) {
    const batch = normalizedIds.slice(i, i + BATCH_SIZE);
    const ops: any[] = [];

    console.log(`🔄 Processing batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(normalizedIds.length / BATCH_SIZE)} (${batch.length} entities)...`);

    for (const entityId of batch) {
      try {
        // PROVEN STRATEGY: Use updateEntity to unset NAME
        const result = Graph.updateEntity({ 
          id: entityId, 
          unset: [{ property: PROPERTY_IDS.NAME }] 
        });

        if (result && result.ops && result.ops.length > 0) {
          ops.push(...result.ops);
        }
      } catch (e) {
        console.error(`   ❌ Failed to generate op for ${entityId}:`, (e as Error).message);
      }
    }

    if (ops.length > 0) {
      console.log(`   🚀 Publishing ${ops.length} operations...`);
      try {
        const { to, calldata } = await personalSpace.publishEdit({
          name: `Manifest Cleanup (Batch ${Math.floor(i / BATCH_SIZE) + 1})`,
          spaceId: SPACE_ID,
          ops: ops,
          author: SPACE_ID,
          network: "TESTNET",
        });

        const txHash = await smartAccount.sendTransaction({ to, data: calldata });
        console.log(`   ✅ Success. TX: ${txHash}`);
      } catch (txError) {
        console.error(`   ❌ Transaction failed. The batch size might be too big. Try reducing BATCH_SIZE.`, txError);
      }
      
      // Wait 2s between batches
      await new Promise(r => setTimeout(r, 2000));
    } else {
      console.log(`   ⏭️  No ops generated for this batch.`);
    }
  }

  console.log('\n🎉 Manifest cleanup complete.');
}

runManifestClean().catch(console.error);
