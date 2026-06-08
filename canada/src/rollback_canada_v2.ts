// src/rollback_canada_v1.ts
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';
import * as readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const args             = process.argv.slice(2);
const DRY_RUN          = args.includes('--dry-run');
const argsWithoutFlags = args.filter(a => !a.startsWith('--'));

if (argsWithoutFlags.length === 0) {
  console.error('❌ Usage: tsx src/rollback_canada_v1.ts <manifest.json> [--dry-run]');
  process.exit(1);
}

let manifestPath = argsWithoutFlags[0];
if (!path.isAbsolute(manifestPath)) {
  manifestPath = path.join(__dirname, '..', manifestPath);
}

// ─── Config ─────────────────────────────────────────────────────────────────
const API_URL         = "https://testnet-api.geobrowser.io/graphql";
const PAGE_SIZE       = 1000;
const MEGA_BATCH_SIZE = 20_000;

// ─── Fetch stale relations (orphaned relations pointing to deleted entities) ──
async function fetchStaleRelations(spaceId: string): Promise<string[]> {
  const allIds: string[] = [];
  let cursor: string | null = null;
  let page = 0;

  console.log('\n🔍 Scanning for orphaned relations...');

  while (true) {
    page++;
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    
    const query = `{
      relationsConnection(
        first: ${PAGE_SIZE}${afterClause}
        condition: { spaceId: "${spaceId}" }
      ) {
        nodes {
          id
          toEntity {
            id
            name
          }
        }
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
    if (json.errors) throw new Error(`GraphQL error: ${json.errors[0].message}`);

    const nodes    = json.data?.relationsConnection?.nodes    ?? [];
    const pageInfo = json.data?.relationsConnection?.pageInfo ?? {};
    
    // Stale = relation pointing to a fully deleted entity (null target)
    const staleIds = nodes
      .filter((n: any) => !n.toEntity?.name)
      .map((n: any) => n.id as string);

    allIds.push(...staleIds);

    process.stdout.write(`\r   Page ${page} — ${allIds.length} orphaned found...   `);

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\r   ✓ Found ${allIds.length.toLocaleString()} orphaned relations${' '.repeat(20)}`);
  return allIds;
}

// ─── Delete relations batch ──────────────────────────────────────────────────
async function deleteRelationsBatch(
  relationIds: string[], 
  spaceId: string, 
  label: string,
  smartAccount: any
): Promise<number> {
  if (relationIds.length === 0) return 0;

  if (DRY_RUN) {
    console.log(`   (dry run: would delete ${relationIds.length} relations)`);
    return relationIds.length;
  }

  console.log(`   Generating delete ops for ${relationIds.length} relations...`);

  const deleteOps: any[] = [];
  for (let i = 0; i < relationIds.length; i += 100) {
    const chunk   = relationIds.slice(i, i + 100);
    const results = await Promise.all(
      chunk.map(id => Graph.deleteRelation({ id, spaceId })),
    );
    for (const r of results) {
      if (r?.ops) deleteOps.push(...r.ops);
    }
    process.stdout.write('.');
  }
  console.log(`\n   Generated ${deleteOps.length} ops`);

  if (deleteOps.length === 0) {
    console.log('   ⚠️  0 ops — relations may already be clean');
    return 0;
  }

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { to, calldata } = await personalSpace.publishEdit({
        name:    `Cleanup stale relations ${label}`,
        spaceId: spaceId,
        ops:     deleteOps,
        author:  spaceId,
        network: "TESTNET",
      });

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`   ✓ Published: ${txHash.slice(0, 24)}...`);
      break;
    } catch (e: any) {
      if (attempt < MAX_RETRIES && e.message?.includes('IPFS')) {
        console.warn(`   ⚠️  IPFS error on attempt ${attempt}, retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        console.error(`   ❌ Failed after ${attempt} attempt(s):`, e.message);
        throw e;
      }
    }
  }

  return relationIds.length;
}

// ─── Main rollback function ──────────────────────────────────────────────────
async function runRollback(): Promise<void> {
  console.log('\n🍁 Canadian Drug Rollback  v3 (with stale relation cleanup)');
  if (DRY_RUN) console.log('   🔍 DRY RUN — no transactions will be sent');
  console.log('');

  const spaceId       = process.env.GEO_SPACE_ID!;
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY!;

  if (!spaceId || !privateKeyRaw) {
    console.error('❌ Missing GEO_SPACE_ID or GEO_WALLET_PRIVATE_KEY');
    process.exit(1);
  }

  if (!fs.existsSync(manifestPath)) {
    console.error(`❌ Manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  if (manifest.spaceId !== spaceId) {
    console.error(`❌ Space ID mismatch: manifest=${manifest.spaceId} env=${spaceId}`);
    process.exit(1);
  }

  const entityIds: string[] = manifest.newEntityIds ?? manifest.entityIds ?? [];

  console.log(`📄 Manifest : ${path.basename(manifestPath)}`);
  console.log(`   Version  : ${manifest.version ?? 'unknown'}`);
  console.log(`   Created  : ${manifest.timestamp ?? 'unknown'}`);
  console.log(`   Entities : ${entityIds.length.toLocaleString()}\n`);

  if (entityIds.length === 0) {
    console.log('✅ Nothing to rollback.\n');
    return;
  }

  // ── PHASE 1: Delete Entities ──────────────────────────────────────────────
  console.log(`🗑️  PHASE 1: Deleting ${entityIds.length.toLocaleString()} entities...`);
  
  if (DRY_RUN) {
    console.log(`🔍 Would delete ${entityIds.length.toLocaleString()} entities.`);
    entityIds.slice(0, 5).forEach(id => console.log(`   ${id}`));
  } else {
    const privateKey = (
      privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`
    ) as Hex;
    const smartAccount = await getSmartAccountWalletClient({ privateKey });
    console.log('✅ Wallet ready\n');

    // Build delete ops for entities
    const rollbackOps: any[] = [];
    let processed = 0;

    for (let i = 0; i < entityIds.length; i += 100) {
      const chunk = entityIds.slice(i, i + 100);
      const results = await Promise.all(
        chunk.map(id => Graph.deleteEntity({ id, spaceId }))
      );
      results.forEach(r => { if (r?.ops) rollbackOps.push(...r.ops); });
      processed += chunk.length;
      if (processed % 500 === 0 || processed >= entityIds.length) {
        process.stdout.write(`  ${processed}/${entityIds.length}\r`);
      }
    }
    console.log(`\n  Generated ${rollbackOps.length.toLocaleString()} ops\n`);

    if (rollbackOps.length > 0) {
      // Publish entity deletions
      const TARGET = 80_000;
      const numBatches = Math.ceil(rollbackOps.length / TARGET);
      console.log(`📦 Publishing ${numBatches} batch(es) for entity deletion...`);

      for (let i = 0; i < numBatches; i++) {
        const batch    = rollbackOps.slice(i * TARGET, (i + 1) * TARGET);
        const batchNum = i + 1;
        try {
          const { to, calldata } = await personalSpace.publishEdit({
            name:    `Canadian Rollback Entities ${batchNum}/${numBatches}`,
            spaceId: spaceId.replace(/-/g, ''),
            ops:     batch,
            author:  spaceId.replace(/-/g, ''),
            network: 'TESTNET',
          });
          const txHash = await smartAccount.sendTransaction({ to, data: calldata });
          console.log(`  ✅ Entity Batch ${batchNum}/${numBatches}: ${txHash}`);
          if (batchNum < numBatches) await new Promise(r => setTimeout(r, 3000));
        } catch (e: any) {
          console.error(`  ❌ Entity Batch ${batchNum} failed: ${e.message}`);
          throw e;
        }
      }
    }
    console.log('✅ Phase 1 complete: Entities deleted\n');

    // 15-second delay before Phase 2 to allow index propagation
    await new Promise(r => setTimeout(r, 30000));

    // ── PHASE 2: Cleanup Stale Relations ───────────────────────────────────
    console.log('🧹 PHASE 2: Cleaning up orphaned relations...');
    
    const staleIds = await fetchStaleRelations(spaceId);
    
    if (staleIds.length === 0) {
      console.log('✅ No orphaned relations found. Space is clean.\n');
    } else {
      console.log(`\n📊 Found ${staleIds.length.toLocaleString()} orphaned relations to delete`);
      
      // Process in mega-batches
      let totalDeleted = 0;
      let chunkNum = 0;

      for (let offset = 0; offset < staleIds.length; offset += MEGA_BATCH_SIZE) {
        chunkNum++;
        const chunk = staleIds.slice(offset, offset + MEGA_BATCH_SIZE);
        console.log(`\n🗑️  Relation Chunk ${chunkNum}/${Math.ceil(staleIds.length / MEGA_BATCH_SIZE)} (${chunk.length} relations)`);
        const deleted = await deleteRelationsBatch(chunk, spaceId, `chunk-${chunkNum}`, smartAccount);
        totalDeleted += deleted;
        if (offset + MEGA_BATCH_SIZE < staleIds.length) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      console.log(`\n✅ Phase 2 complete: ${totalDeleted.toLocaleString()} orphaned relations deleted\n`);
    }
  }

  console.log('🎉 Rollback complete!\n');
}

runRollback().catch(console.error);
