// src/clean_pharma_types.ts
import 'dotenv/config';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';

// --- CONFIGURATION ---
const API_URL = "https://testnet-api.geobrowser.io/graphql";
const SPACE_ID = process.env.GEO_SPACE_ID;
const RX_CUI_PROPERTY_ID = 'e6c50e227460442cab646a48f235459a'; // Fingerprint property

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

async function runClean() {
  if (!SPACE_ID) throw new Error("GEO_SPACE_ID missing in .env");

  console.log(`🧹 Smart Clean: Identifying Pharma entities via RxCUI fingerprint...`);

  // 1. Identify Targets
  const data = await queryGeo(`
    query GetPharmaEntities {
      values(filter: { spaceId: { is: "${SPACE_ID}" }, propertyId: { is: "${RX_CUI_PROPERTY_ID}" } }) {
        entityId
      }
    }
  `);

  const targetIds = new Set<string>((data.values || []).map((v: any) => v.entityId));
  
  if (targetIds.size === 0) {
    console.log('✅ Space is already clean.');
    return;
  }
  console.log(`🎯 Found ${targetIds.size} target entities.\n`);

  // 2. Fetch Data to Delete
  const idList = JSON.stringify(Array.from(targetIds));
  console.log(`📡 Fetching data to delete...`);
  
  const [valuesData, relationsData] = await Promise.all([
    queryGeo(`query GetValues { values(filter: { spaceId: { is: "${SPACE_ID}" }, entityId: { in: ${idList} } }) { entityId propertyId } }`),
    queryGeo(`query GetRelations { relations(filter: { spaceId: { is: "${SPACE_ID}" }, fromEntityId: { in: ${idList} } }) { id } }`)
  ]);

  const values = valuesData.values || [];
  const relations = relationsData.relations || [];
  console.log(`   ✅ Found ${values.length} values and ${relations.length} relations.\n`);

  // 3. Generate Ops
  console.log(`⚙️  Generating delete operations...`);
  const ops: any[] = [];

  // Unset Values
  const entityMap = new Map<string, Set<string>>();
  values.forEach((v: any) => {
    if (!entityMap.has(v.entityId)) entityMap.set(v.entityId, new Set());
    entityMap.get(v.entityId)!.add(v.propertyId);
  });

  for (const [entityId, propertySet] of entityMap.entries()) {
    try {
      ops.push(...Graph.updateEntity({ id: entityId, unset: Array.from(propertySet).map(p => ({ property: p })) }).ops);
    } catch (e: any) {
      console.error(`   ❌ Failed to unset entity ${entityId}:`, e.message);
    }
  }

  // Delete Relations
  for (const r of relations) {
    try {
      ops.push(...Graph.deleteRelation({ id: r.id }).ops);
    } catch (e: any) {
      console.error(`   ❌ Failed to delete relation ${r.id}:`, e.message);
    }
  }

  if (ops.length === 0) {
    console.log('✅ Nothing to delete.');
    return;
  }
  console.log(`📝 Generated ${ops.length} operations.\n`);

  // 4. Publish
  console.log(`🚀 Publishing clean operation...`);
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("GEO_WALLET_PRIVATE_KEY missing");
  
  const smartAccount = await getSmartAccountWalletClient({
    privateKey: (privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex
  });

  const { cid, editId, to, calldata } = await personalSpace.publishEdit({
    name: `Clean Pharma Data`,
    spaceId: SPACE_ID,
    ops: ops,
    author: SPACE_ID,
    network: "TESTNET",
  });

  const txHash = await smartAccount.sendTransaction({ to, data: calldata });
  console.log(`✅ Clean Complete. TX: ${txHash}`);
}

runClean().catch(console.error);
