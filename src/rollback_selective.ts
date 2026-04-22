// src/rollback_selective.ts
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
const BATCH_SIZE = 500;

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

async function detectSpaceType(spaceId: string) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      query: `query { space(id: "${spaceId}") { id type address } }` 
    }),
  });
  const json = await res.json() as { errors?: any[]; data?: any };
  
  // Show actual error if there is one
  if (json.errors) {
    console.error('❌ API Error:');
    json.errors.forEach((e: any) => console.error(`   ${e.message}`));
    process.exit(1);
  }
  
  if (!json.data?.space) {
    console.error(`❌ Space not found: ${spaceId}`);
    process.exit(1);
  }
  
  const type = json.data.space.type as string;
  
  if (type !== 'PERSONAL' && type !== 'DAO') {
    console.error(`❌ Unknown space type: ${type}`);
    process.exit(1);
  }
  
  console.log(`📋 Space type: ${type}${type === 'DAO' ? ` (address: ${json.data.space.address})` : ''}`);
  
  return {
    type: type as 'PERSONAL' | 'DAO',
    address: json.data.space.address as string | undefined
  };
}

async function runCleanRollback() {
  // 1. Validate Environment
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  const envSpaceId = process.env.GEO_SPACE_ID;
  const personalSpaceId = process.env.GEO_PERSONAL_SPACE_ID;

  if (!privateKeyRaw || !envSpaceId) {
    console.error('❌ Missing GEO_WALLET_PRIVATE_KEY or GEO_SPACE_ID in .env');
    process.exit(1);
  }

  // 2. Load Manifest
  if (!fs.existsSync(manifestPath)) {
    console.error(`❌ Manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const { spaceId: manifestSpaceId, entityIds, batchName } = manifest;

  console.log(`📄 Manifest: ${path.basename(manifestPath)}`);
  console.log(`   Batch: ${batchName || 'Unknown'}`);
  console.log(`   Entities: ${entityIds.length}`);
  console.log(`   Space ID: ${manifestSpaceId}`);

  if (manifestSpaceId !== envSpaceId) {
    console.error('❌ Space ID mismatch!');
    console.error(`   Manifest: ${manifestSpaceId}`);
    console.error(`   .env: ${envSpaceId}`);
    process.exit(1);
  }

  // 3. Detect Space Type
  const spaceInfo = await detectSpaceType(envSpaceId);
  
  if (spaceInfo.type === 'DAO' && !personalSpaceId) {
    console.error('❌ GEO_PERSONAL_SPACE_ID required for DAO spaces');
    process.exit(1);
  }

  // 4. Init Wallet
  const privateKey = privateKeyRaw.startsWith('0x') ? privateKeyRaw as Hex : `0x${privateKeyRaw}` as Hex;
  const smartAccount = await getSmartAccountWalletClient({ privateKey });
  console.log('✅ Smart Account Initialized.\n');

  // 5. Process Entities
  console.log(`🧹 Starting ROLLBACK for: ${batchName || 'Unknown Batch'}`);
  console.log(`🎯 Entities: ${entityIds.length}`);
  console.log(`📦 Processing in batches of ${BATCH_SIZE}...\n`);

  const ids = entityIds.filter((id: string) => id && typeof id === 'string' && id.trim() !== '');
  const totalBatches = Math.ceil(ids.length / BATCH_SIZE);
  const normalizedSpaceId = envSpaceId.replace(/-/g, '');

  for (let i = 0; i < totalBatches; i++) {
    const batchIds = ids.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    console.log(`🔄 Batch ${i + 1}/${totalBatches} (${batchIds.length} entities)...`);

    const ops: any[] = [];

    // A. Fetch Relations
    const relQuery = `
      query GetRels {
        relationsFrom: relations(filter: { spaceId: { is: "${envSpaceId}" }, fromEntityId: { in: ${JSON.stringify(batchIds)} } }) { id }
        relationsTo: relations(filter: { spaceId: { is: "${envSpaceId}" }, toEntityId: { in: ${JSON.stringify(batchIds)} } }) { id }
      }
    `;
    
    let relData: any;
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: relQuery }),
      });
      const json = await res.json() as { errors?: any[]; data?: any };
      if (json.errors) throw new Error(json.errors[0].message);
      relData = json.data || { relationsFrom: [], relationsTo: [] };
    } catch (e) {
      console.log(`   ⚠️  Could not fetch relations: ${(e as Error).message}`);
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
        } catch (e) { /* skip */ }
      });
    }

    // C. Unset Properties
    const propsToUnset = [
      PROPERTY_IDS.NAME,
      PROPERTY_IDS.RXCUI,
      PROPERTY_IDS.SMILES,
      PROPERTY_IDS.PMID,
      PROPERTY_IDS.INCHI_KEY
    ].filter(Boolean);

    console.log(`   🧼 Stripping properties from ${batchIds.length} entities...`);
    batchIds.forEach(eid => {
      try {
        const result = Graph.updateEntity({ id: eid, unset: propsToUnset.map(p => ({ property: p })) });
        if (result?.ops) ops.push(...result.ops);
      } catch (e) { /* skip */ }
    });

    if (ops.length === 0) {
      console.log(`   ✅ Batch clean (no ops needed).`);
      continue;
    }

    // D. Publish
    try {
      console.log(`   🚀 Publishing ${ops.length} ops...`);

      let cid: string, editId: string, to: `0x${string}`, calldata: `0x${string}`;

      if (spaceInfo.type === 'DAO') {
        const result = await daoSpace.proposeEdit({
          name: `Rollback Batch ${i + 1}/${totalBatches}`,
          ops,
          author: personalSpaceId!.replace(/-/g, ''),
          daoSpaceAddress: spaceInfo.address as `0x${string}`,
          callerSpaceId: personalSpaceId!.replace(/-/g, ''),
          daoSpaceId: normalizedSpaceId,
          network: "TESTNET",
        });
        cid = result.cid;
        editId = result.editId;
        to = result.to;
        calldata = result.calldata;
      } else {
        const result = await personalSpace.publishEdit({
          name: `Rollback Batch ${i + 1}/${totalBatches}`,
          spaceId: normalizedSpaceId,
          ops,
          author: normalizedSpaceId,
          network: "TESTNET",
        });
        cid = result.cid;
        editId = result.editId;
        to = result.to;
        calldata = result.calldata;
      }

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`   ✅ TX: ${txHash.slice(0, 10)}... CID: ${cid.slice(0, 10)}...`);

      await sleep(500);
    } catch (e) {
      console.error(`   ❌ Failed: ${(e as Error).message}`);
    }
  }

  console.log(`\n🎉 Rollback Complete. Processed ${entityIds.length} entities.`);
}

runCleanRollback().catch(console.error);
