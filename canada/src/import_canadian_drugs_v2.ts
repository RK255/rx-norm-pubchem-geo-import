// src/import_canadian_drugs_v1.ts
// V1: CanadianGenericDrug (CGD), CanadianBrandedDrug (CBD), DIN entities
//     + bidirectional relations to existing RxNorm IN/MIN/PIN anchor layer
//
// Usage:
//   tsx src/import_canadian_drugs_v1.ts
//   tsx src/import_canadian_drugs_v1.ts --dry-run
//   tsx src/import_canadian_drugs_v1.ts --force          # skip existing-entity prefetch
//   tsx src/import_canadian_drugs_v1.ts --proposal-name "My name"
//
// .env keys: GEO_SPACE_ID, GEO_PERSONAL_SPACE_ID (DAO only), GEO_WALLET_PRIVATE_KEY

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { Graph, personalSpace, daoSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import {
  RXNORM_TYPE_IDS,
  RXNORM_RELATION_IDS,
  CAN_TYPE_IDS,
  CAN_RELATION_IDS,
  CAN_PROPERTY_IDS,
} from './constants';
import type { Hex } from 'viem';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// =============================================================================
// CONFIGURATION
// =============================================================================

const DATA_DIR         = path.join(__dirname, '..', 'data_to_publish');
const DAO_MANIFEST_DIR = path.join(DATA_DIR, 'DAO_manifests');
const JSONL_FILE       = path.join(DATA_DIR, 'canada_products_v1.jsonl');
const API_URL          = 'https://testnet-api.geobrowser.io/graphql';

const BATCH_SIZE_PERSONAL = 80_000;
const BATCH_SIZE_DAO      = 2_000;

// =============================================================================
// ARGUMENT PARSING
// =============================================================================

const args  = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE   = args.includes('--force');

const PROPOSAL_NAME = (() => {
  const i = args.indexOf('--proposal-name');
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
})();

// =============================================================================
// TYPES  — matches actual canada_products_v1.jsonl structure
// =============================================================================

interface DinEntry {
  din:      string;   // e.g. "02295318"
  can_name: string;   // e.g. "atorvastatin 80 mg Tablet"
}

interface ProductRecord {
  rx_rxcui:     string;
  rx_name:      string;
  rx_tty:       'SCD' | 'SBD';
  parent_rxcui: string;
  parent_tty:   'IN' | 'MIN' | 'PIN';
  parent_name:  string;
  top300_rank?: number;
  top300_drug?: string;
  dins:         DinEntry[];
}

interface CanadianEntity {
  id:        string;
  typeId:    string;
  name:      string;
  values:    Array<{ property: string; type: string; value: string | number }>;
  relations: Record<string, Array<{ toEntity: string }>>;
}

const TYPE_NAMES: Record<string, string> = {
  [CAN_TYPE_IDS.CGD]: 'CanadianGenericDrug',
  [CAN_TYPE_IDS.CBD]: 'CanadianBrandedDrug',
  [CAN_TYPE_IDS.DIN]: 'DIN',
};

// =============================================================================
// UUID HELPERS
// rxnormUuid seed must match v10's generateUuid: `${typeId}:${rxcui}`
// =============================================================================

function sha256Uuid(seed: string): string {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return [h.slice(0,8), h.slice(8,12), h.slice(12,16), h.slice(16,20), h.slice(20,32)].join('-');
}

/** Points at an existing RxNorm IN/MIN/PIN published by v10 */
function rxnormUuid(rxcui: string, tty: 'IN' | 'MIN' | 'PIN'): string {
  return sha256Uuid(`${RXNORM_TYPE_IDS[tty]}:${rxcui}`);
}

function cgdUuid(rxcui: string): string { return sha256Uuid(`CAN:CGD:${rxcui}`); }
function cbdUuid(rxcui: string): string { return sha256Uuid(`CAN:CBD:${rxcui}`); }
function dinEntityUuid(dinNumber: string): string { return sha256Uuid(`CAN:DIN:${dinNumber}`); }

function resolveProduct(
  rxcui: string,
  rxTty: 'SCD' | 'SBD'
): { uuid: string; typeId: string } {
  if (rxTty === 'SCD') return { uuid: cgdUuid(rxcui), typeId: CAN_TYPE_IDS.CGD };
  else                 return { uuid: cbdUuid(rxcui), typeId: CAN_TYPE_IDS.CBD };
}

// =============================================================================
// RELATION HELPERS
// =============================================================================

/** Back-relation: CGD/CBD → parent IN/MIN/PIN */
function backRelId(parentTty: 'IN' | 'MIN' | 'PIN'): string {
  switch (parentTty) {
    case 'IN':  return RXNORM_RELATION_IDS.INGREDIENTS;
    case 'MIN': return RXNORM_RELATION_IDS.MULTIPLE_INGREDIENTS;
    case 'PIN': return RXNORM_RELATION_IDS.PRECISE_INGREDIENTS;
  }
}

// =============================================================================
// SPACE HELPERS
// =============================================================================

async function detectSpaceType(
  spaceId: string
): Promise<{ type: 'PERSONAL' | 'DAO'; address?: string }> {
  const query = `query GetSpaceType { space(id: "${spaceId}") { id type address } }`;
  const res   = await fetch(API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query }),
  });
  const json = await res.json() as any;
  if (json.errors) {
    console.error('❌ Failed to query space:', json.errors[0].message);
    process.exit(1);
  }
  if (!json.data?.space) {
    console.error(`❌ Space not found: ${spaceId}`);
    process.exit(1);
  }
  return {
    type:    json.data.space.type as 'PERSONAL' | 'DAO',
    address: json.data.space.address,
  };
}

// =============================================================================
// FETCH EXISTING ENTITIES
// =============================================================================

async function fetchExistingEntityIds(spaceId: string): Promise<Set<string>> {
  console.log('\n🔍 Fetching existing Canadian entities from space...\n');
  const existingIds = new Set<string>();

  const typesToCheck = [
    { id: CAN_TYPE_IDS.CGD, short: 'CGD' },
    { id: CAN_TYPE_IDS.CBD, short: 'CBD' },
    { id: CAN_TYPE_IDS.DIN, short: 'DIN' },
  ];

  for (const type of typesToCheck) {
    let cursor: string | null = null;
    let count = 0;

    while (true) {
      const afterParam = cursor ? `, after: "${cursor}"` : '';
      const query = `{
        entitiesConnection(
          spaceId: "${spaceId}",
          typeId:  "${type.id}",
          first:   1000${afterParam}
        ) {
          nodes    { id }
          pageInfo { hasNextPage endCursor }
        }
      }`;

      try {
        const res  = await fetch(API_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ query }),
        });
        const json = await res.json() as any;

        if (json.errors) {
          console.error(`  ⚠️  ${type.short}: ${json.errors[0].message}`);
          break;
        }

        const nodes    = json.data?.entitiesConnection?.nodes    || [];
        const pageInfo = json.data?.entitiesConnection?.pageInfo;

        nodes.forEach((e: any) => existingIds.add(e.id.replace(/-/g, '')));
        count += nodes.length;

        if (!pageInfo?.hasNextPage) break;
        cursor = pageInfo.endCursor;
        await new Promise(r => setTimeout(r, 50));
      } catch (e: any) {
        console.error(`  ⚠️  ${type.short}: ${e.message}`);
        break;
      }
    }

    console.log(`  ${type.short.padEnd(5)} ${count.toLocaleString().padStart(7)} existing`);
  }

  console.log(`\n  Total: ${existingIds.size.toLocaleString()} existing Canadian entities\n`);
  return existingIds;
}

// =============================================================================
// REPORTING
// =============================================================================

function generateReport(
  existingCount: number,
  newEntities:   CanadianEntity[],
  spaceType:     string,
): string {
  const lines: string[] = [];

  const byType: Record<string, number> = {};
  for (const e of newEntities) {
    const label = TYPE_NAMES[e.typeId] || e.typeId.slice(0, 8);
    byType[label] = (byType[label] || 0) + 1;
  }

  lines.push('\n' + '='.repeat(60));
  lines.push(`CANADIAN IMPORT SUMMARY  (${spaceType} SPACE)`);
  lines.push('='.repeat(60));
  lines.push(`  Existing Canadian:  ${existingCount.toLocaleString().padStart(10)}`);
  lines.push(`  Will create:        ${newEntities.length.toLocaleString().padStart(10)} new entities`);

  if (Object.keys(byType).length > 0) {
    lines.push('\n' + '-'.repeat(60));
    lines.push('NEW ENTITIES BY TYPE');
    lines.push('-'.repeat(60));
    Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        lines.push(`  ${type.padEnd(25)} ${count.toLocaleString().padStart(8)}`);
      });
  }

  if (newEntities.length > 0) {
    lines.push('\n' + '-'.repeat(60));
    lines.push('SAMPLE NEW ENTITIES (products only)');
    lines.push('-'.repeat(60));
    newEntities
      .filter(e => e.typeId !== CAN_TYPE_IDS.DIN)
      .slice(0, 10)
      .forEach((e, i) => {
        const label = TYPE_NAMES[e.typeId] || 'Unknown';
        lines.push(`  ${i + 1}. ${e.name.substring(0, 42).padEnd(44)} [${label}]`);
      });
    const productCount = newEntities.filter(e => e.typeId !== CAN_TYPE_IDS.DIN).length;
    if (productCount > 10) {
      lines.push(`  ... and ${(productCount - 10).toLocaleString()} more`);
    }
  }

  lines.push('\n' + '='.repeat(60));
  return lines.join('\n');
}

// =============================================================================
// PUBLISHING
// =============================================================================

async function publishInBatches(
  allOps:          any[],
  spaceInfo:       { type: 'PERSONAL' | 'DAO'; address?: string },
  spaceId:         string,
  smartAccount:    any,
  personalSpaceId: string | undefined,
  proposalName:    string | undefined,
): Promise<void> {
  const batchSize    = spaceInfo.type === 'DAO' ? BATCH_SIZE_DAO : BATCH_SIZE_PERSONAL;
  const totalBatches = Math.ceil(allOps.length / batchSize);

  console.log(`\n📦 Publishing ${totalBatches} batch(es) to ${spaceInfo.type} space...`);
  console.log(`   Batch size: ${batchSize.toLocaleString()} ops\n`);

  for (let i = 0; i < totalBatches; i++) {
    const batch    = allOps.slice(i * batchSize, (i + 1) * batchSize);
    const batchNum = i + 1;
    const name     = proposalName
      ? `${proposalName} (Batch ${batchNum}/${totalBatches})`
      : `Canadian Drugs v1 Batch ${batchNum}/${totalBatches}`;

    console.log(`Batch ${batchNum}/${totalBatches}  (${batch.length.toLocaleString()} ops)...`);
    console.log(`   Name: "${name.substring(0, 60)}${name.length > 60 ? '...' : ''}"`);

    try {
      let to:       `0x${string}`;
      let calldata: `0x${string}`;
      let cid:      string;

      if (spaceInfo.type === 'DAO') {
        const result = await daoSpace.proposeEdit({
          name,
          ops:             batch,
          author:          personalSpaceId!.replace(/-/g, ''),
          daoSpaceAddress: spaceInfo.address as `0x${string}`,
          callerSpaceId:   '0x' + personalSpaceId!.replace(/-/g, ''),
          daoSpaceId:      '0x' + spaceId.replace(/-/g, ''),
          network:         'TESTNET',
        });
        cid      = result.cid;
        to       = result.to;
        calldata = result.calldata;
        console.log(`   📝 Proposal: ${result.proposalId}`);
      } else {
        const result = await personalSpace.publishEdit({
          name,
          spaceId: spaceId.replace(/-/g, ''),
          ops:     batch,
          author:  spaceId.replace(/-/g, ''),
          network: 'TESTNET',
        });
        cid      = result.cid;
        to       = result.to;
        calldata = result.calldata;
        console.log(`   📝 IPFS: ${cid}`);
      }

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`   ✅ ${txHash}`);
      console.log(`   🔍 https://sepolia.basescan.org/tx/${txHash}\n`);

      if (batchNum < totalBatches) await new Promise(r => setTimeout(r, 3000));
    } catch (e: any) {
      console.error(`   ❌ Batch ${batchNum} failed:`, e.message);
      throw e;
    }
  }

  console.log('✅ All batches broadcast!\n');
}

// =============================================================================
// MAIN
// =============================================================================

async function runImport(): Promise<void> {
  console.log('\n🍁 Canadian Drug Importer  v1');
  if (DRY_RUN) console.log('   🔍 DRY RUN — no transactions will be sent');
  console.log('');

  // ── Env ───────────────────────────────────────────────────────────────────
  const spaceId         = process.env.GEO_SPACE_ID;
  const personalSpaceId = process.env.GEO_PERSONAL_SPACE_ID;
  const privateKeyRaw   = process.env.GEO_WALLET_PRIVATE_KEY;

  if (!spaceId) {
    console.error('❌ Missing GEO_SPACE_ID in .env');
    process.exit(1);
  }

  // ── Detect space type ─────────────────────────────────────────────────────
  const spaceInfo = await detectSpaceType(spaceId);

  if (spaceInfo.type === 'DAO' && !personalSpaceId) {
    console.error('❌ GEO_PERSONAL_SPACE_ID required for DAO space');
    process.exit(1);
  }

  console.log(`📋 Space:    ${spaceId}  (${spaceInfo.type})`);
  if (spaceInfo.type === 'DAO') {
    console.log(`🏛️  DAO Addr: ${spaceInfo.address}`);
    console.log(`👤 Author:   ${personalSpaceId}`);
  }
  if (PROPOSAL_NAME) console.log(`📝 Name:     "${PROPOSAL_NAME}"`);
  console.log('');

  // ── Wallet ────────────────────────────────────────────────────────────────
  let smartAccount: any = null;
  if (!DRY_RUN) {
    if (!privateKeyRaw) {
      console.error('❌ Missing GEO_WALLET_PRIVATE_KEY');
      process.exit(1);
    }
    const privateKey = (
      privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`
    ) as Hex;
    smartAccount = await getSmartAccountWalletClient({ privateKey });
    console.log('✅ Wallet ready\n');
  }

  // ── Fetch existing Canadian entities ──────────────────────────────────────
  const existingIds = FORCE ? new Set<string>() : await fetchExistingEntityIds(spaceId);

  // ── Load + filter JSONL ───────────────────────────────────────────────────
  if (!fs.existsSync(JSONL_FILE)) {
    console.error(`❌ JSONL not found: ${JSONL_FILE}`);
    process.exit(1);
  }

  const records = fs
    .readFileSync(JSONL_FILE, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l) as ProductRecord)
    .filter(r => r.rx_tty === 'SCD' || r.rx_tty === 'SBD');

  const cgdRecords = records.filter(r => r.rx_tty === 'SCD');
  const cbdRecords = records.filter(r => r.rx_tty === 'SBD');
  const totalDins  = records.reduce((n, r) => n + (r.dins?.length ?? 0), 0);

  console.log(`📊 Loaded JSONL:`);
  console.log(`   CGD (SCD → CanadianGenericDrug) : ${cgdRecords.length.toLocaleString()}`);
  console.log(`   CBD (SBD → CanadianBrandedDrug) : ${cbdRecords.length.toLocaleString()}`);
  console.log(`   DINs (embedded)                 : ${totalDins.toLocaleString()}\n`);

  // ── Build entity list ─────────────────────────────────────────────────────
  console.log('🏗️  Building entity graph...');

  const newEntities: CanadianEntity[] = [];
  const seenIds = new Set<string>(existingIds);

  for (const rec of records) {
    const { rx_rxcui, rx_name, rx_tty, parent_rxcui, parent_tty, dins } = rec;

    const { uuid, typeId } = resolveProduct(rx_rxcui, rx_tty);
    const parentUuid       = rxnormUuid(parent_rxcui, parent_tty);
    const uuidNorm         = uuid.replace(/-/g, '');

    if (seenIds.has(uuidNorm)) continue;
    seenIds.add(uuidNorm);

    // ── DIN entities ──────────────────────────────────────────────────────
    const dinTargets: Array<{ toEntity: string }> = [];

    for (const din of (dins ?? [])) {
      const dUuid     = dinEntityUuid(din.din);
      const dUuidNorm = dUuid.replace(/-/g, '');

      if (!seenIds.has(dUuidNorm)) {
        seenIds.add(dUuidNorm);
        newEntities.push({
          id:        dUuid,
          typeId:    CAN_TYPE_IDS.DIN,
          name:      din.din,
          values:    [],
          relations: {},
        });
      }

      dinTargets.push({ toEntity: dUuid });
    }

    // ── CGD / CBD entity ──────────────────────────────────────────────────
    const relations: Record<string, Array<{ toEntity: string }>> = {
      [backRelId(parent_tty)]: [{ toEntity: parentUuid }],
    };
    if (dinTargets.length > 0) {
      relations[CAN_RELATION_IDS.DINS] = dinTargets;
    }

    newEntities.push({
      id:     uuid,
      typeId: typeId,
      name:   rx_name,
      values: [
        { property: CAN_PROPERTY_IDS.RELATED_RXCUI, type: 'text', value: rx_rxcui },
      ],
      relations,
    });
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const report = generateReport(existingIds.size, newEntities, spaceInfo.type);
  console.log(report);

  // ── Build ops ─────────────────────────────────────────────────────────────
  const allOps: any[] = [];

  for (const entity of newEntities) {
    try {
      const { ops } = Graph.createEntity({
        id:        entity.id,
        name:      entity.name,
        types:     [entity.typeId],
        values:    entity.values,
        relations: entity.relations,
      });
      allOps.push(...ops);
    } catch (e: any) {
      console.error(`❌ Error building ops for "${entity.name}": ${e.message}`);
    }
  }

  const batchSize  = spaceInfo.type === 'DAO' ? BATCH_SIZE_DAO : BATCH_SIZE_PERSONAL;
  const numBatches = Math.ceil(allOps.length / batchSize);

  console.log(`📊 Generated ${allOps.length.toLocaleString()} operations`);
  console.log(`   Batch size : ${batchSize.toLocaleString()}`);
  console.log(`   Batches    : ${numBatches}\n`);

  // ── Manifest ──────────────────────────────────────────────────────────────
  const timestamp   = Date.now();
  const manifestDir = spaceInfo.type === 'DAO' ? DAO_MANIFEST_DIR : DATA_DIR;

  if (spaceInfo.type === 'DAO' && !fs.existsSync(DAO_MANIFEST_DIR)) {
    fs.mkdirSync(DAO_MANIFEST_DIR, { recursive: true });
    console.log(`📁 Created DAO manifest directory\n`);
  }

  const manifestData = {
    timestamp:    new Date().toISOString(),
    version:      'canada_v1',
    spaceId,
    spaceType:    spaceInfo.type,
    proposalName: PROPOSAL_NAME ?? null,
    dryRun:       DRY_RUN,
    flags:        { force: FORCE },
    stats: {
      existingCanadian: existingIds.size,
      newEntities:      newEntities.length,
      newByType:        newEntities.reduce((acc: any, e) => {
        const label = TYPE_NAMES[e.typeId] ?? 'Unknown';
        acc[label]  = (acc[label] ?? 0) + 1;
        return acc;
      }, {}),
      totalOps:  allOps.length,
      batchSize,
      batches:   numBatches,
    },
    newEntityIds: newEntities.map(e => e.id.replace(/-/g, '')),
    sampleNewEntities: newEntities
      .filter(e => e.typeId !== CAN_TYPE_IDS.DIN)
      .slice(0, 20)
      .map(e => ({ id: e.id, name: e.name, type: TYPE_NAMES[e.typeId] })),
  };

  const manifestPath = path.join(
    manifestDir,
    `${DRY_RUN ? 'dry_run' : 'publish'}_manifest_canada_v1_${timestamp}.json`
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));
  console.log(`💾 Manifest: ${path.relative(DATA_DIR, manifestPath)}\n`);

  // ── Dry run / nothing-to-do exit ──────────────────────────────────────────
  if (allOps.length === 0) {
    console.log('✅ Nothing new to publish — space is already up to date.\n');
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

  // ── Y/N prompt ────────────────────────────────────────────────────────────
  const rl        = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirmed = await new Promise<boolean>(resolve =>
    rl.question(`Publish to ${spaceInfo.type} space? [y/N]: `, ans => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'y');
    })
  );

  if (!confirmed) {
    console.log('❌ Aborted.\n');
    return;
  }

  // ── Publish ───────────────────────────────────────────────────────────────
  await publishInBatches(
    allOps,
    spaceInfo,
    spaceId,
    smartAccount,
    personalSpaceId,
    PROPOSAL_NAME,
  );
}

runImport().catch(console.error);
