// src/rollback_canada_v1.ts
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';

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

async function runRollback(): Promise<void> {
  console.log('\n🍁 Canadian Drug Rollback  v2');
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

  if (DRY_RUN) {
    console.log(`🔍 Would delete ${entityIds.length.toLocaleString()} entities.`);
    entityIds.slice(0, 5).forEach(id => console.log(`   ${id}`));
    console.log('\n✅ Dry run complete.\n');
    return;
  }

  const privateKey = (
    privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`
  ) as Hex;
  const smartAccount = await getSmartAccountWalletClient({ privateKey });
  console.log('✅ Wallet ready\n');

  // ── Build delete ops — exact same pattern as rollback_selective_bulk_v2 ──
  console.log(`🔨 Building delete ops for ${entityIds.length.toLocaleString()} entities...`);
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

  if (rollbackOps.length === 0) {
    console.log('⚠️  No ops generated.\n');
    return;
  }

  // ── Publish — same split logic as working script ──────────────────────────
  const TARGET = 80_000;
  const numBatches = Math.ceil(rollbackOps.length / TARGET);
  console.log(`📦 Publishing ${numBatches} batch(es)...\n`);

  for (let i = 0; i < numBatches; i++) {
    const batch    = rollbackOps.slice(i * TARGET, (i + 1) * TARGET);
    const batchNum = i + 1;
    try {
      const { to, calldata } = await personalSpace.publishEdit({
        name:    `Canadian Rollback ${batchNum}/${numBatches}`,
        spaceId: spaceId.replace(/-/g, ''),
        ops:     batch,
        author:  spaceId.replace(/-/g, ''),
        network: 'TESTNET',
      });
      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`  ✅ Batch ${batchNum}/${numBatches}: ${txHash}`);
      if (batchNum < numBatches) await new Promise(r => setTimeout(r, 3000));
    } catch (e: any) {
      console.error(`  ❌ Batch ${batchNum} failed: ${e.message}`);
      throw e;
    }
  }

  console.log('\n🎉 Rollback complete!\n');
}

runRollback().catch(console.error);
