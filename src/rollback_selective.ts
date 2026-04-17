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

// --- ARGUMENT PARSING (Positional) ---
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('❌ Usage: bun run rollback <path_to_manifest.json>');
  console.error('   Example: bun run rollback data_to_publish/manifest_1776227282813.json');
  process.exit(1);
}

let manifestPath = args[0];

// Resolve relative path from project root
if (!path.isAbsolute(manifestPath)) {
  manifestPath = path.join(__dirname, '..', manifestPath);
}

// --- CONFIGURATION ---
const API_URL = "https://testnet-api.geobrowser.io/graphql";

// --- HELPER: Convert space ID to hex ---
function spaceIdToHex(spaceId: string): `0x${string}` {
  const clean = spaceId.replace(/-/g, '');
  return `0x${clean}` as `0x${string}`;
}

// --- DETECT SPACE TYPE ---
async function detectSpaceType(spaceId: string): Promise<{ type: 'PERSONAL' | 'DAO'; address?: string }> {
  const query = `
    query GetSpaceType {
      space(id: "${spaceId}") { id type address }
    }
  `;
  
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  
  const json = await res.json() as { errors?: any[]; data?: any };
  
  if (json.errors) {
    console.error('❌ Failed to query space type:');
    json.errors.forEach((e: any) => console.error(`   ${e.message}`));
    process.exit(1);
  }
  
  if (!json.data?.space) {
    console.error(`❌ Space not found: ${spaceId}`);
    process.exit(1);
  }
  
  if (!json.data.space.type) {
    console.error('❌ Space type not returned by API. Cannot proceed.');
    process.exit(1);
  }
  
  const type = json.data.space.type as string;
  
  if (type !== 'PERSONAL' && type !== 'DAO') {
    console.error(`❌ Unknown space type: ${type}. Expected PERSONAL or DAO.`);
    process.exit(1);
  }
  
  if (type === 'DAO') {
    console.log(`📋 Detected space type: ${type} (address: ${json.data.space.address})`);
  } else {
    console.log(`📋 Detected space type: ${type}`);
  }
  
  return {
    type: type as 'PERSONAL' | 'DAO',
    address: json.data.space.address as string | undefined
  };
}

// --- GQL HELPER ---
async function queryGeo(query: string) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = await res.json() as { errors?: any[]; data?: any };
  if (json.errors) {
    const err = json.errors[0];
    throw new Error(err.message || JSON.stringify(err));
  }
  return json.data;
}

async function runRollback() {
  // 1. Load Manifest
  if (!fs.existsSync(manifestPath)) {
    console.error(`❌ Manifest file not found: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const { spaceId: manifestSpaceId, entityIds, batchName } = manifest;

  // 2. Validate Environment
  const envSpaceId = process.env.GEO_SPACE_ID;
  const personalSpaceId = process.env.GEO_PERSONAL_SPACE_ID;
  
  if (!envSpaceId) {
    console.error('❌ GEO_SPACE_ID not found in .env');
    process.exit(1);
  }

  // SAFETY CHECK
  if (manifestSpaceId !== envSpaceId) {
    console.error(`❌ Space ID Mismatch!`);
    console.error(`   Manifest Space: ${manifestSpaceId}`);
    console.error(`   .env Space:      ${envSpaceId}`);
    console.error(`   Aborting to prevent data loss.`);
    process.exit(1);
  }

  // 3. Detect space type
  const spaceInfo = await detectSpaceType(envSpaceId);

  // For DAO spaces, require personal space ID
  if (spaceInfo.type === 'DAO' && !personalSpaceId) {
    console.error('❌ GEO_PERSONAL_SPACE_ID required in .env for DAO spaces.');
    console.error('   DAO proposals must be signed by your personal space.');
    process.exit(1);
  }

  console.log(`🧹 Starting Rollback for Batch: ${batchName}`);
  console.log(`🎯 Target Entities: ${entityIds.length}`);

  // Validate entity IDs
  const validEntityIds = entityIds.filter((id: string) => id && typeof id === 'string' && id.trim() !== '');
  console.log(`   ✅ Valid entity IDs: ${validEntityIds.length}`);

  if (validEntityIds.length === 0) {
    console.log('✅ No entities listed in manifest. Nothing to do.');
    return;
  }

  // 4. Fetch Current State
  console.log(`📡 Fetching current data on-chain...`);

  const valuesQuery = `
    query GetValues {
      values(filter: { spaceId: { is: "${envSpaceId}" }, entityId: { in: ${JSON.stringify(validEntityIds)} } }) {
        entityId
        propertyId
      }
    }
  `;
  const valuesData = await queryGeo(valuesQuery);
  const values = valuesData.values || [];

  const relationsQuery = `
    query GetRelations {
      relations(filter: { spaceId: { is: "${envSpaceId}" }, fromEntityId: { in: ${JSON.stringify(validEntityIds)} } }) {
        id
      }
    }
  `;
  const relationsData = await queryGeo(relationsQuery);
  const relations = relationsData.relations || [];

  console.log(`   📦 Found ${values.length} values and ${relations.length} relations to delete.`);

  // 5. Generate Deletion ops
  const allOps: any[] = [];

  // A. Unset Values
  const entityValueMap = new Map<string, Set<string>>();
  values.forEach((v: any) => {
    if (!entityValueMap.has(v.entityId)) entityValueMap.set(v.entityId, new Set());
    entityValueMap.get(v.entityId)!.add(v.propertyId);
  });

  entityValueMap.forEach((props, id) => {
    try {
      const result = Graph.updateEntity({ id, unset: Array.from(props).map(p => ({ property: p })) });
      if (result?.ops) allOps.push(...result.ops);
    } catch (e: any) {
      console.error(`   ⚠️  Failed to unset values for ${id}: ${e.message}`);
    }
  });

  // B. Delete Relations
  relations.forEach((r: any) => {
    try {
      const result = Graph.deleteRelation({ id: r.id });
      if (result?.ops) allOps.push(...result.ops);
    } catch (e: any) {
      console.error(`   ⚠️  Failed to delete relation ${r.id}: ${e.message}`);
    }
  });

  // NOTE: Entities are not explicitly deleted - they become empty shells
  // after all their properties and relations are removed.
  // Future imports can reuse these IDs via the deduplication check.

  console.log(`📊 Generated ${allOps.length} deletion operations.`);
  console.log(`   (Entities will remain as empty shells - this is expected behavior)`);

  if (allOps.length === 0) {
    console.log('✅ No active data found on-chain. Rollback complete.');
    return;
  }

  // 6. Publish
  console.log(`🚀 Publishing Rollback (${spaceInfo.type} space)...`);
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("Missing private key");
  const privateKey = privateKeyRaw.startsWith('0x') ? privateKeyRaw as Hex : `0x${privateKeyRaw}` as Hex;
  const smartAccount = await getSmartAccountWalletClient({ privateKey });

  let cid: string;
  let editId: string;
  let to: `0x${string}`;
  let calldata: `0x${string}`;

  if (spaceInfo.type === 'DAO') {
    const result = await daoSpace.proposeEdit({
      name: `Rollback: ${batchName}`,
      ops: allOps,
      author: spaceIdToHex(personalSpaceId!),
      daoSpaceAddress: spaceInfo.address as `0x${string}`,
      callerSpaceId: spaceIdToHex(personalSpaceId!),
      daoSpaceId: spaceIdToHex(envSpaceId),
      network: "TESTNET",
    });
    cid = result.cid;
    editId = result.editId;
    to = result.to;
    calldata = result.calldata;
    console.log(`📝 Proposal created. CID: ${cid}`);
    console.log(`🆔 Edit ID: ${editId}`);
    console.log(`🗳️  Proposal ID: ${result.proposalId}`);
    console.log(`⚠️  DAO Proposal submitted. Voting may be required before execution.`);
  } else {
    const result = await personalSpace.publishEdit({
      name: `Rollback: ${batchName}`,
      spaceId: spaceIdToHex(envSpaceId),
      ops: allOps,
      author: spaceIdToHex(envSpaceId),
      network: "TESTNET",
    });
    cid = result.cid;
    editId = result.editId;
    to = result.to;
    calldata = result.calldata;
    console.log(`📝 IPFS CID: ${cid}`);
    console.log(`🆔 Edit ID: ${editId}`);
  }

  console.log(`📬 Target: ${to}`);

  const txHash = await smartAccount.sendTransaction({ to, data: calldata });
  console.log(`\n✅ Rollback Complete. TX: ${txHash}`);
}

runRollback().catch(console.error);
