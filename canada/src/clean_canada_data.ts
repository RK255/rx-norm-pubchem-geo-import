// src/clean_canada_data.ts
// Wipes all Canadian entities (CGD/CBD/DIN) from a space by querying the API directly.
// Use this when you don't have a manifest file.
//
// Usage:
//   bun run src/clean_canada_data.ts
//   bun run src/clean_canada_data.ts --dry-run

import 'dotenv/config';
import { fileURLToPath } from 'url';
import path from 'path';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import { CAN_TYPE_IDS } from './constants';
import type { Hex } from 'viem';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const API_URL             = 'https://testnet-api.geobrowser.io/graphql';
const BATCH_SIZE_OPS      = 80_000;
const QUERY_PAGE_SIZE     = 1000;
const DELETE_CONCURRENCY  = 10;
const MAX_RETRIES         = 3;

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

async function fetchEntitiesByType(spaceId: string, typeId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;

  while (true) {
    const afterParam = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      entitiesConnection(
        spaceId: "${spaceId}",
        typeId:  "${typeId}",
        first:   ${QUERY_PAGE_SIZE}${afterParam}
      ) {
        nodes    { id }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    const res  = await fetch(API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query }),
    });
    const json = await res.json() as any;

    if (json.errors) {
      console.error(`  ⚠️  Query error: ${json.errors[0].message}`);
      break;
    }

    const nodes    = json.data?.entitiesConnection?.nodes    || [];
    const pageInfo = json.data?.entitiesConnection?.pageInfo;

    nodes.forEach((e: any) => ids.push(e.id));
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 50));
  }

  return ids;
}

async function deleteEntityWithRetry(id: string, spaceId: string, retries = MAX_RETRIES): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await Graph.deleteEntity({ id: id.replace(/-/g, ''), spaceId });
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (attempt < retries && (msg.includes('socket') || msg.includes('fetch') || msg.includes('ECONNRESET') || msg.includes('429'))) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.error(`  ⚠️  Retry ${attempt}/${retries} for ${id.slice(0, 8)}... (${msg.slice(0, 60)})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
}

async function runClean(): Promise<void> {
  console.log('\n🍁 Canadian Data Cleaner  v1');
  if (DRY_RUN) console.log('   🔍 DRY RUN — no transactions will be sent');
  console.log('');

  const spaceId       = process.env.GEO_SPACE_ID;
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;

  if (!spaceId || !privateKeyRaw) {
    console.error('❌ Missing GEO_SPACE_ID or GEO_WALLET_PRIVATE_KEY');
    process.exit(1);
  }

  // ── Fetch Canadian entity IDs ────────────────────────────────────────────
  console.log('🔍 Fetching Canadian entities from space...\n');

  const typesToCheck = [
    { id: CAN_TYPE_IDS.CGD, short: 'CGD', name: 'CanadianGenericDrug' },
    { id: CAN_TYPE_IDS.CBD, short: 'CBD', name: 'CanadianBrandedDrug' },
    { id: CAN_TYPE_IDS.DIN, short: 'DIN', name: 'DIN' },
  ];

  const allEntityIds: string[] = [];
  for (const type of typesToCheck) {
    const ids = await fetchEntitiesByType(spaceId, type.id);
    console.log(`  ${type.short.padEnd(5)} ${ids.length.toLocaleString().padStart(7)} entities  (${type.name})`);
    allEntityIds.push(...ids);
  }

  console.log(`\n  Total: ${allEntityIds.length.toLocaleString()} Canadian entities\n`);

  if (allEntityIds.length === 0) {
    console.log('✅ Nothing to clean — space is already empty.\n');
    return;
  }

  // ── Generate deletion ops ────────────────────────────────────────────────
  console.log('🗑️  Generating deletion ops...\n');

  const allOps: any[] = [];
  let failed = 0;

  for (let i = 0; i < allEntityIds.length; i += DELETE_CONCURRENCY) {
    const chunk = allEntityIds.slice(i, i + DELETE_CONCURRENCY);

    const results = await Promise.all(
      chunk.map(async (id) => {
        try {
          return await deleteEntityWithRetry(id, spaceId);
        } catch (e: any) {
          console.error(`  ❌ Failed ${id.slice(0, 8)}...: ${e?.message?.slice(0, 80) || e}`);
          failed++;
          return null;
        }
      })
    );

    results.forEach(r => {
      if (r?.ops) allOps.push(...r.ops);
    });

    const processed = Math.min(i + DELETE_CONCURRENCY, allEntityIds.length);
    if (processed % 500 === 0 || processed >= allEntityIds.length) {
      process.stdout.write(`  ${processed}/${allEntityIds.length} entities processed\r`);
    }
  }

  console.log(`\n  Generated ${allOps.length.toLocaleString()} ops`);
  if (failed > 0) {
    console.log(`  ⚠️  ${failed} entities failed (will be missing from cleanup)`);
  }
  console.log('');

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('='.repeat(60));
  console.log('CLEANUP SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Entities to delete:  ${allEntityIds.length.toLocaleString()}`);
  console.log(`  Total ops:           ${allOps.length.toLocaleString()}`);
  if (failed > 0) console.log(`  Failed entities:     ${failed}`);
  console.log('='.repeat(60) + '\n');

  if (allOps.length === 0) {
    console.log('✅ No ops generated — nothing to publish.\n');
    return;
  }

  if (DRY_RUN) {
    console.log('🔍 First 5 ops:');
    allOps.slice(0, 5).forEach((op, i) =>
      console.log(`  [${i}] ${JSON.stringify(op).slice(0, 200)}`)
    );
    console.log('\n✅ Dry run complete — nothing published.\n');
    return;
  }

  // ── Wallet ───────────────────────────────────────────────────────────────
  const privateKey = (
    privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`
  ) as Hex;
  const smartAccount = await getSmartAccountWalletClient({ privateKey });
  console.log('✅ Wallet ready\n');

  // ── Publish ──────────────────────────────────────────────────────────────
  const numBatches = Math.ceil(allOps.length / BATCH_SIZE_OPS);
  console.log(`📦 Publishing ${numBatches} batch(es)...\n`);

  for (let i = 0; i < numBatches; i++) {
    const batch    = allOps.slice(i * BATCH_SIZE_OPS, (i + 1) * BATCH_SIZE_OPS);
    const batchNum = i + 1;

    console.log(`Batch ${batchNum}/${numBatches}  (${batch.length.toLocaleString()} ops)...`);

    try {
      const { to, calldata } = await personalSpace.publishEdit({
        name:    `Canadian Data Cleanup Batch ${batchNum}/${numBatches}`,
        spaceId: spaceId.replace(/-/g, ''),
        ops:     batch,
        author:  spaceId.replace(/-/g, ''),
        network: 'TESTNET',
      });

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`  ✅ ${txHash}`);
      console.log(`  🔍 https://sepolia.basescan.org/tx/${txHash}\n`);

      if (batchNum < numBatches) await new Promise(r => setTimeout(r, 3000));
    } catch (e: any) {
      console.error(`  ❌ Batch ${batchNum} failed: ${e.message}`);
      throw e;
    }
  }

  console.log('🎉 Cleanup complete!\n');
}

runClean().catch(console.error);
