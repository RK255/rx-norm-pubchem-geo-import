// src/cleanup_stale_entities.ts
// Scans the active space for orphaned relations pointing to deleted Canadian
// entities and removes them.
//
// Usage:
//   bun run src/cleanup_stale_entities.ts --dry-run   ← preview only
//   bun run src/cleanup_stale_entities.ts             ← interactive confirm + delete

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(import.meta.dir, '../../.env') });

import {
  Graph,
  personalSpace,
  getSmartAccountWalletClient,
} from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';
import * as readline from 'readline';
import { CAN_TYPE_IDS } from './constants';

// ─── config ──────────────────────────────────────────────────────────────────

const API_URL  = "https://testnet-api.geobrowser.io/graphql";
const SPACE_ID = process.env.GEO_SPACE_ID;
const DRY_RUN  = process.argv.includes('--dry-run');

const PAGE_SIZE       = 1000;
const MEGA_BATCH_SIZE = 20_000;

// ─── fetch one page of relations, return only orphaned IDs ───────────────────

async function fetchWithCursor(
  after: string | null,
): Promise<{ ids: string[]; hasMore: boolean; endCursor: string | null }> {
  const afterClause = after ? `, after: "${after}"` : "";

  const query = `{
    relationsConnection(
      first: ${PAGE_SIZE}${afterClause}
      condition: { spaceId: "${SPACE_ID}" }
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
  const ids = nodes
    .filter((n: any) => !n.toEntity?.name)
    .map((n: any) => n.id as string);

  return {
    ids,
    hasMore:   pageInfo.hasNextPage ?? false,
    endCursor: pageInfo.endCursor   ?? null,
  };
}

// ─── paginate through all space relations, collect stale IDs ─────────────────

async function fetchAllStaleRelations(): Promise<string[]> {
  const allIds: string[] = [];
  let cursor: string | null = null;
  let page = 0;

  while (true) {
    page++;
    process.stdout.write(
      `\r   Relations: page ${page} — ${allIds.length} stale found...   `,
    );

    const result = await fetchWithCursor(cursor);

    allIds.push(...result.ids);

    if (!result.hasMore) break;

    cursor = result.endCursor;
    await new Promise(r => setTimeout(r, 100));
  }

  process.stdout.write(
    `\r   Relations: ✓ ${allIds.length} stale found${' '.repeat(30)}\n`,
  );
  return allIds;
}

// ─── delete a mega-batch of relation IDs ─────────────────────────────────────

async function deleteMegaBatch(entityIds: string[], label: string): Promise<number> {
  if (entityIds.length === 0) return 0;

  if (DRY_RUN) {
    console.log(`   (dry run: would delete ${entityIds.length})`);
    return entityIds.length;
  }

  const rawKey = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!rawKey) throw new Error("GEO_WALLET_PRIVATE_KEY missing from .env");

  const smartAccount = await getSmartAccountWalletClient({
    privateKey: (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex,
  });

  console.log(`   Generating ops for ${entityIds.length} relations...`);

  const deleteOps: any[] = [];
  for (let i = 0; i < entityIds.length; i += 100) {
    const chunk   = entityIds.slice(i, i + 100);
    const results = await Promise.all(
      chunk.map(id => Graph.deleteRelation({ id, spaceId: SPACE_ID! })),
    );
    for (const r of results) {
      if (r?.ops) deleteOps.push(...r.ops);
    }
    process.stdout.write('.');
  }
  console.log(`\n   Generated ${deleteOps.length} ops`);

  if (deleteOps.length === 0) {
    console.log('   ⚠  0 ops — relations may already be clean');
    return 0;
  }

  console.log(`   📦 Single batch (${deleteOps.length} ops)`);

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { to, calldata } = await personalSpace.publishEdit({
        name:    `Cleanup stale relations ${label}`,
        spaceId: SPACE_ID!,
        ops:     deleteOps,
        author:  SPACE_ID!,
        network: "TESTNET",
      });

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`   ✓ Published: ${txHash.slice(0, 24)}...`);
      break;
    } catch (e: any) {
      if (attempt < MAX_RETRIES && e.message?.includes('IPFS')) {
        console.warn(`   ⚠  IPFS error on attempt ${attempt}, retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        console.error(`   ❌ Failed after ${attempt} attempt(s):`, e.message);
        throw e;
      }
    }
  }

  return entityIds.length;
}

// ─── interactive confirm ──────────────────────────────────────────────────────

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${prompt} [y/N] `, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function run() {
  if (!SPACE_ID) {
    console.error('❌ GEO_SPACE_ID missing from .env');
    process.exit(1);
  }

  console.log('🧹 Canadian Space Cleanup');
  console.log(`   ${DRY_RUN ? '🔍 DRY RUN — no transactions will be sent' : '🔴 LIVE MODE'}`);
  console.log(`\n📋 Space: ${SPACE_ID}`);
  console.log(`🎯 Accumulate ${MEGA_BATCH_SIZE.toLocaleString()} per chunk before publishing`);

  console.log('🔍 Scanning space for orphaned relations...\n');

  const staleIds  = await fetchAllStaleRelations();
  const grandTotal = staleIds.length;

  console.log(`\n📊 Scan complete: ${grandTotal.toLocaleString()} orphaned relations found`);

  if (grandTotal === 0) {
    console.log('\n✅ Nothing to delete. Space is clean.');
    return;
  }

  if (DRY_RUN) {
    console.log('\n✅ Dry run complete. Re-run without --dry-run to delete.');
    return;
  }

  const ok = await confirm(
    `\n⚠️  Permanently delete ${grandTotal.toLocaleString()} orphaned relations from ${SPACE_ID}?`,
  );
  if (!ok) {
    console.log('Aborted.');
    return;
  }

  let totalDeleted = 0;
  let chunkNum = 0;

  for (let offset = 0; offset < staleIds.length; offset += MEGA_BATCH_SIZE) {
    chunkNum++;
    const chunk = staleIds.slice(offset, offset + MEGA_BATCH_SIZE);
    console.log(
      `\n🗑  Chunk ${chunkNum}/${Math.ceil(staleIds.length / MEGA_BATCH_SIZE)} (${chunk.length} relations)`,
    );
    const deleted = await deleteMegaBatch(chunk, `chunk-${chunkNum}`);
    totalDeleted += deleted;
    if (offset + MEGA_BATCH_SIZE < staleIds.length) await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n' + '='.repeat(50));
  console.log(`📊 TOTAL DELETED: ${totalDeleted.toLocaleString()} orphaned relations`);
  console.log('🎉 Done!');
}

run().catch(console.error);
