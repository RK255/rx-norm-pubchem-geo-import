// src/rollback_selective.ts
import 'dotenv/config'; // Load .env
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';

// --- ESM __dirname FIX ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- GQL HELPER ---
const API_URL = "https://testnet-api.geobrowser.io/graphql";

async function queryGeo(query: string) {
  const res = await fetch(API_URL, { 
    method: "POST", 
    headers: { "Content-Type": "application/json" }, 
    body: JSON.stringify({ query }) 
  });
  const json = await res.json() as { errors?: any[]; data?: any }; // FIX: Type assertion
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function runRollback() {
  // 1. Get Manifest Path from arguments
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('❌ Usage: bun run src/rollback_selective.ts <path_to_manifest.json>');
    console.error('   Example: bun run src/rollback_selective.ts ./data_to_publish/manifest_1715432101234.json');
    process.exit(1);
  }

  const manifestPath = args[0];

  if (!fs.existsSync(manifestPath)) {
    console.error(`❌ Manifest file not found: ${manifestPath}`);
    process.exit(1);
  }

  // 2. Load Manifest
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const targetIds = manifest.entityIds;
  const spaceId = manifest.spaceId;

  console.log(`🚀 Starting Selective Rollback...`);
  console.log(`📋 Manifest: ${manifest.batchName}`);
  console.log(`📍 Target Space: ${spaceId}`);
  console.log(`🎯 Targeting ${targetIds.length} entities.`);

  // 3. Initialize Wallet (Using ENV vars from .env)
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!privateKeyRaw) {
    console.error('❌ Missing GEO_WALLET_PRIVATE_KEY in .env');
    process.exit(1);
  }
  const privateKey: Hex = privateKeyRaw.startsWith('0x') ? privateKeyRaw as Hex : `0x${privateKeyRaw}` as Hex; // FIX: Explicit Hex type
  const smartAccount = await getSmartAccountWalletClient({ privateKey });
  console.log('✅ Smart Account Initialized.');

  // 4. Fetch Data for Targeted Entities
  console.log('📡 Fetching current state from Geo API...');
  
  // A. Fetch Values (filtering by the specific entity IDs)
  // We convert the array of IDs to a GraphQL list string: ["id1", "id2", ...]
  const idsString = JSON.stringify(targetIds);

  const valuesQuery = `
    query GetValues {
      values(filter: { 
        spaceId: { is: "${spaceId}" },
        entityId: { in: ${idsString} }
      }) {
        entityId
        propertyId
      }
    }
  `;

  // B. Fetch Relations (We fetch all and filter locally to be safe)
  const relationsQuery = `
    query GetRelations {
      relations(filter: { spaceId: { is: "${spaceId}" } }) {
        id
        fromEntityId
      }
    }
  `;

  const [valuesData, relationsData] = await Promise.all([
    queryGeo(valuesQuery),
    queryGeo(relationsQuery)
  ]);

  const values = valuesData.values || [];
  const allRelations = relationsData.relations || [];

  // Filter relations: keep only if the 'fromEntityId' is in our target list
  const relations = allRelations.filter((r: any) => targetIds.includes(r.fromEntityId));

  console.log(`📊 Found ${values.length} values and ${relations.length} relations to delete.`);

  if (values.length === 0 && relations.length === 0) {
    console.log('✅ Nothing found to delete. These entities may already be gone.');
    return;
  }

  // 5. Generate Delete Ops
  const ops: any[] = [];

  // A. Unset Values
  const entityMap = new Map<string, Set<string>>();
  for (const v of values) {
    if (!entityMap.has(v.entityId)) entityMap.set(v.entityId, new Set());
    entityMap.get(v.entityId)!.add(v.propertyId);
  }

  for (const [entityId, propertySet] of entityMap.entries()) {
    const propertiesToUnset = Array.from(propertySet).map(p => ({ property: p }));
    try {
      const result = Graph.updateEntity({ id: entityId, unset: propertiesToUnset });
      ops.push(...result.ops);
    } catch (e) {
      console.error(`Failed to unset entity ${entityId}:`, e);
    }
  }

  // B. Delete Relations
  for (const r of relations) {
    try {
      const result = Graph.deleteRelation({ id: r.id });
      ops.push(...result.ops);
    } catch (e) {
      console.error(`Failed to delete relation ${r.id}:`, e);
    }
  }

  console.log(`📝 Generated ${ops.length} delete operations.`);

  // 6. Publish
  console.log(`💣 Publishing Rollback to TESTNET...`);
  try {
    const { cid, editId, to, calldata } = await personalSpace.publishEdit({
      name: `Rollback: ${manifest.batchName}`,
      spaceId: spaceId,
      ops: ops,
      author: spaceId, // Author is the space itself for personal spaces
      network: "TESTNET",
    });

    console.log(`📝 IPFS CID: ${cid}`);
    console.log(`🆔 Edit ID: ${editId}`);
    console.log(`📬 Target: ${to}`);

    const txHash = await smartAccount.sendTransaction({
      to,
      data: calldata,
    });

    console.log(`✅ Rollback Complete. TX: ${txHash}`);
  } catch (e) {
    console.error('❌ Publish failed:', e);
  }
}

runRollback().catch(console.error);
