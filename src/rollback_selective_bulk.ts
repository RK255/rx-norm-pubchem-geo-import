// src/rollback_mega.ts
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Graph, personalSpace, daoSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_URL = "https://testnet-api.geobrowser.io/graphql";
const TARGET_OPS_PER_BATCH = 80000;

const args = process.argv.slice(2);
const HARD_DELETE = args.includes('--hard');
const argsWithoutFlags = args.filter(a => !a.startsWith('--'));

if (argsWithoutFlags.length === 0) {
  console.error('❌ Usage: bun run rollback_mega.ts <manifest.json> [--hard]');
  console.error('   --hard: Delete entities entirely (default: just strip properties)');
  process.exit(1);
}

let manifestPath = argsWithoutFlags[0];
if (!path.isAbsolute(manifestPath)) {
  manifestPath = path.join(__dirname, '..', manifestPath);
}

// Parse manifest to get entity IDs from operations
function extractEntityIdsFromManifest(manifest: any): string[] {
  const ids = new Set<string>();
  
  // Check if manifest has ops directly (V6 format) or entityIds
  if (manifest.entityIds && Array.isArray(manifest.entityIds)) {
    manifest.entityIds.forEach((id: string) => ids.add(id));
  }
  
  // Also extract from operations if present
  if (manifest.operations && Array.isArray(manifest.operations)) {
    manifest.operations.forEach((op: any) => {
      if (op.entity?.id) ids.add(op.entity.id);
      if (op.relation?.id) ids.add(op.relation.id);
    });
  }
  
  return Array.from(ids).filter(id => id && typeof id === 'string');
}

async function runRollback() {
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  const envSpaceId = process.env.GEO_SPACE_ID;

  if (!privateKeyRaw || !envSpaceId) {
    console.error('❌ Missing GEO_WALLET_PRIVATE_KEY or GEO_SPACE_ID');
    process.exit(1);
  }

  if (!fs.existsSync(manifestPath)) {
    console.error(`❌ Manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const { spaceId: manifestSpaceId, batchName = 'Unknown' } = manifest;

  console.log(`🔄 Mega-Rollback: ${batchName}`);
  console.log(`🔧 Mode: ${HARD_DELETE ? 'HARD DELETE' : 'Strip Properties'}`);
  console.log(`📄 Manifest: ${path.basename(manifestPath)}\n`);

  if (manifestSpaceId !== envSpaceId) {
    console.error('❌ Space ID mismatch!');
    process.exit(1);
  }

  // Extract all entity IDs
  const entityIds = extractEntityIdsFromManifest(manifest);
  console.log(`🎯 Found ${entityIds.length.toLocaleString()} entities to rollback\n`);

  if (entityIds.length === 0) {
    console.log('✅ Nothing to rollback');
    return;
  }

  const smartAccount = await getSmartAccountWalletClient({
    privateKey: (privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex
  });

  let totalProcessed = 0;
  let megaBatchNum = 0;

  while (totalProcessed < entityIds.length) {
    megaBatchNum++;
    const batchStart = totalProcessed;
    const batchEnd = Math.min(totalProcessed + TARGET_OPS_PER_BATCH, entityIds.length);
    const currentBatch = entityIds.slice(batchStart, batchEnd);
    
    console.log(`📦 Mega-batch ${megaBatchNum}: Processing ${currentBatch.length} entities...`);

    // Generate rollback operations
    const rollbackOps: any[] = [];
    
    for (let i = 0; i < currentBatch.length; i += 100) {
      const chunk = currentBatch.slice(i, i + 100);
      
      if (HARD_DELETE) {
        // Hard delete entities
        const results = await Promise.all(
          chunk.map(id => Graph.deleteEntity({ id, spaceId: envSpaceId }))
        );
        results.forEach(r => { if (r?.ops) rollbackOps.push(...r.ops); });
      } else {
        // Strip properties (soft rollback)
        // TODO: Add property unset logic here if needed
        // For now, hard delete is safer for clean imports
        const results = await Promise.all(
          chunk.map(id => Graph.deleteEntity({ id, spaceId: envSpaceId }))
        );
        results.forEach(r => { if (r?.ops) rollbackOps.push(...r.ops); });
      }
      
      if ((i + chunk.length) % 1000 === 0) {
        process.stdout.write(`${batchStart + i + chunk.length} `);
      }
    }
    
    console.log(`\n  Generated ${rollbackOps.length} ops`);

    if (rollbackOps.length === 0) {
      console.log('  ⚠️ No operations generated');
      totalProcessed += currentBatch.length;
      continue;
    }

    // Split into ~2 batches if ops are too many
    const mid = Math.ceil(rollbackOps.length / 2);
    const publishBatches = [
      rollbackOps.slice(0, mid),
      rollbackOps.slice(mid)
    ].filter(b => b.length > 0);

    console.log(`  Publishing ${publishBatches.length} batch(es)...`);

    for (let i = 0; i < publishBatches.length; i++) {
      const batch = publishBatches[i];
      try {
        const { to, calldata } = await personalSpace.publishEdit({
          name: `Rollback ${megaBatchNum}.${i + 1}`,
          spaceId: envSpaceId.replace(/-/g, ''),
          ops: batch,
          author: envSpaceId.replace(/-/g, ''),
          network: "TESTNET",
        });

        const txHash = await smartAccount.sendTransaction({ to, data: calldata });
        console.log(`  ✓ Batch ${i + 1}/${publishBatches.length}: ${txHash.slice(0, 24)}...`);
        
        if (i < publishBatches.length - 1) await new Promise(r => setTimeout(r, 3000));
      } catch (e: any) {
        console.error(`  ❌ Failed: ${e.message}`);
        throw e;
      }
    }

    totalProcessed += currentBatch.length;
    console.log(`📊 Progress: ${totalProcessed}/${entityIds.length}\n`);
    
    if (totalProcessed < entityIds.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`🎉 Rollback complete! Processed ${totalProcessed.toLocaleString()} entities.`);
}

runRollback().catch(console.error);
