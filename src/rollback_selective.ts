// src/rollback_and_clean.ts
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Graph, personalSpace, daoSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import { PROPERTY_IDS } from './constants';
import type { Hex } from 'viem';

// --- ESM __dirname FIX ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CONFIGURATION ---
const API_URL = "https://testnet-api.geobrowser.io/graphql";
const BATCH_SIZE = 500; // Process 500 entities at a time (API Limit safe)

// --- ARGUMENT PARSING ---
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('❌ Usage: bun run rollback <path_to_manifest.json>');
  process.exit(1);
}
let manifestPath = args[0];
if (!path.isAbsolute(manifestPath)) {
  manifestPath = path.join(__dirname, '..', manifestPath);
}

// --- HELPERS ---
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Query Helper
async function queryGeo(query: string) {
  let retries = 3;
  while (retries > 0) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const json = await res.json() as { errors?: any[]; data?: any };
      if (json.errors?.[0]?.message.includes("429")) {
        console.warn(`   ⚠️  Rate limited. Waiting 2s...`);
        await sleep(2000);
        retries--;
        continue;
      }
      if (json.errors) throw new Error(json.errors[0].message);
      return json.data;
    } catch (e) {
      retries--;
      if (retries === 0) throw e;
      console.warn(`   ⚠️  Query failed, retrying... (${retries} left)`);
      await sleep(1000);
    }
  }
}

async function detectSpaceType(spaceId: string) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `query { space(id: "${spaceId}") { id type address } }` }),
  });
  const json = await res.json() as { errors?: any[]; data?: any };
  if (json.errors || !json.data?.space) {
    console.error('❌ Failed to detect space type');
    process.exit(1);
  }
  return {
    type: json.data.space.type as 'PERSONAL' | 'DAO',
    address: json.data.space.address as string | undefined
  };
}

async function runCleanRollback() {
  // 1. Load Manifest
  if (!fs.existsSync(manifestPath)) {
    console.error(`❌ Manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const { spaceId: manifestSpaceId, entityIds, batchName } = manifest;
  const envSpaceId = process.env.GEO_SPACE_ID;
  const personalSpaceId = process.env.GEO_PERSONAL_SPACE_ID;

  if (!envSpaceId || manifestSpaceId !== envSpaceId) {
    console.error('❌ Space ID Mismatch');
    process.exit(1);
  }

  const spaceInfo = await detectSpaceType(envSpaceId);
  if (spaceInfo.type === 'DAO' && !personalSpaceId) {
    console.error('❌ Personal Space ID required for DAO');
    process.exit(1);
  }

  console.log(`🧹 Starting DEEP CLEAN for: ${batchName}`);
  console.log(`🎯 Entities: ${entityIds.length}`);
  console.log(`🔍 Strategy: Query Relations + Delete + Unset Properties.\n`);

  const ids = entityIds.filter((id: string) => id && typeof id === 'string' && id.trim() !== '');
  const totalBatches = Math.ceil(ids.length / BATCH_SIZE);
  const normalizedSpaceId = envSpaceId.replace(/-/g, '');
  
  // 2. Process in Batches
  for (let i = 0; i < totalBatches; i++) {
    const batchIds = ids.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    console.log(`🔄 Processing batch ${i + 1}/${totalBatches} (${batchIds.length} entities)...`);

    const ops: any[] = [];

    // A. Fetch Relations (In and Out)
    const relQuery = `
      query GetRels {
        relationsFrom: relations(filter: { spaceId: { is: "${envSpaceId}" }, fromEntityId: { in: ${JSON.stringify(batchIds)} } }) { id }
        relationsTo: relations(filter: { spaceId: { is: "${envSpaceId}" }, toEntityId: { in: ${JSON.stringify(batchIds)} } }) { id }
      }
    `;
    
    let relData: any;
    try {
      relData = await queryGeo(relQuery);
    } catch (e) {
      console.error(`   ⚠️  Could not fetch relations for batch. Skipping relations.`, (e as Error).message);
      relData = { relationsFrom: [], relationsTo: [] };
    }

    const allRelIds = [
      ...(relData.relationsFrom || []).map((r: any) => r.id),
      ...(relData.relationsTo || []).map((r: any) => r.id)
    ];

    // B. Delete Relations
    if (allRelIds.length > 0) {
      console.log(`   🔗 Deleting ${allRelIds.length} relations...`);
      allRelIds.forEach(rid => {
        try {
          const result = Graph.deleteRelation({ id: rid });
          if (result?.ops) ops.push(...result.ops);
        } catch (e) { /* ignore */ }
      });
    }

    // C. Unset Properties
    const propsToUnset = [
      PROPERTY_IDS.NAME, PROPERTY_IDS.RXCUI, PROPERTY_IDS.SMILES, PROPERTY_IDS.PMID, PROPERTY_IDS.INCHI_KEY
    ].filter(Boolean);

    console.log(`   🧼 Stripping properties from ${batchIds.length} entities...`);
    batchIds.forEach(eid => {
      try {
        const result = Graph.updateEntity({ id: eid, unset: propsToUnset.map(p => ({ property: p })) });
        if (result?.ops) ops.push(...result.ops);
      } catch (e) { /* ignore */ }
    });

    if (ops.length === 0) {
      console.log(`   ✅ Batch clean (empty).`);
      continue;
    }

    // 3. Publish Batch
    try {
      console.log(`   🚀 Publishing ${ops.length} ops...`);
      const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
      const privateKey = privateKeyRaw?.startsWith('0x') ? privateKeyRaw as Hex : `0x${privateKeyRaw}` as Hex;
      const smartAccount = await getSmartAccountWalletClient({ privateKey });

      let cid: string, editId: string, to: `0x${string}`, calldata: `0x${string}`;

      if (spaceInfo.type === 'DAO') {
        const result = await daoSpace.proposeEdit({
          name: `Clean Batch ${i+1}/${totalBatches}`,
          ops,
          author: personalSpaceId!.replace(/-/g, ''), 
          daoSpaceAddress: spaceInfo.address as `0x${string}`,
          callerSpaceId: personalSpaceId!.replace(/-/g, ''), 
          daoSpaceId: normalizedSpaceId,
          network: "TESTNET",
        });
        cid = result.cid; editId = result.editId; to = result.to; calldata = result.calldata;
      } else {
        const result = await personalSpace.publishEdit({
          name: `Clean Batch ${i+1}/${totalBatches}`,
          spaceId: normalizedSpaceId, 
          ops,
          author: normalizedSpaceId,
          network: "TESTNET",
        });
        cid = result.cid; editId = result.editId; to = result.to; calldata = result.calldata;
      }

      await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`   ✅ TX Sent. CID: ${cid.slice(0, 10)}...`);
      
      // Wait a bit between batches to be safe
      await sleep(500); 
    } catch (e) {
      console.error(`   ❌ Failed to publish batch: ${(e as Error).message}`);
    }
  }

  console.log(`\n🎉 Cleanup Complete.`);
}

runCleanRollback().catch(console.error);
