// src/rollback_import.ts
import fs from 'fs';
import path from 'path';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';

// --- Configuration ---
const DATA_DIR = path.join(__dirname, '..', 'data_to_publish');
const OPS_FILE = process.argv[2] || 'test_publish_ops.txt'; // Default to test file

// --- Helper: Convert byte array (from JSON) to UUID string ---
function bytesToUuid(encodedId: any): string | null {
  if (!encodedId) return null;
  
  // If it's already a string, return it
  if (typeof encodedId === 'string') return encodedId;

  // Reconstruct Uint8Array from the object keys
  const keys = Object.keys(encodedId).map(k => parseInt(k)).sort((a, b) => a - b);
  const bytes = new Uint8Array(keys.length);
  
  let valid = true;
  for (const k of keys) {
    if (typeof encodedId[k] !== 'number') {
      valid = false;
      break;
    }
    bytes[k] = encodedId[k];
  }

  if (!valid || bytes.length !== 16) return null;

  // Convert bytes to hex string
  const hexBytes = Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Format as UUID: 8-4-4-4-12
  return [
    hexBytes.substring(0, 8),
    hexBytes.substring(8, 12),
    hexBytes.substring(12, 16),
    hexBytes.substring(16, 20),
    hexBytes.substring(20, 32)
  ].join('-');
}

async function runRollback() {
  console.log('🗑️  Starting Rollback...');
  console.log(`📂 Target File: ${OPS_FILE}`);

  // 1. Load Environment Variables
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  const spaceId = process.env.GEO_SPACE_ID;

  if (!privateKeyRaw || !spaceId) {
    console.error('❌ Missing GEO_WALLET_PRIVATE_KEY or GEO_SPACE_ID in .env');
    process.exit(1);
  }

  const privateKey = privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`;

  // 2. Initialize Smart Account
  const smartAccount = await getSmartAccountWalletClient({ privateKey });
  console.log('✅ Smart Account Initialized.');

  // 3. Read Ops File
  const filePath = path.join(DATA_DIR, OPS_FILE);

  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    return;
  }

  const fileContents = fs.readFileSync(filePath, 'utf-8');
  let ops: any[];
  
  try {
    ops = JSON.parse(fileContents);
    console.log(`✅ Read ${ops.length} ops from ${OPS_FILE}`);
  } catch (err) {
    console.error(`❌ Failed to parse JSON from ${OPS_FILE}`, err);
    return;
  }

  const delOps: any[] = [];

  // 4. Identify Entities to Delete
  const entityIds: string[] = [];
  ops.filter((op: any) => op.type === "createEntity").forEach((op: any) => {
    const decodedId = bytesToUuid(op.id);
    if (decodedId) entityIds.push(decodedId);
  });

  const uniqueEntityIds = [...new Set(entityIds)];
  console.log(`📦 Found ${uniqueEntityIds.length} unique entities to delete.`);

  // 5. Generate Ops to Unset Properties
  for (const entityId of uniqueEntityIds) {
    // Find the createEntity op for this ID
    const createOp = ops.find((op: any) => {
      if (op.type !== "createEntity") return false;
      const decoded = bytesToUuid(op.id);
      return decoded === entityId;
    });
    
    if (createOp && Array.isArray(createOp.values)) {
      const properties: string[] = [];
      createOp.values.forEach((v: any) => {
        const decodedProp = bytesToUuid(v.property);
        if (decodedProp) properties.push(decodedProp);
      });
        
      if (properties.length > 0) {
        // Use Graph.updateEntity with 'unset' to remove properties
        const updateOps = Graph.updateEntity({
          id: entityId,
          unset: properties.map(p => ({ property: p }))
        });
        delOps.push(...updateOps.ops);
      }
    }
  }

  // 6. Identify Relations to Delete
  const relationIds: string[] = [];
  ops.filter((op: any) => op.type === "createRelation").forEach((op: any) => {
    const decodedId = bytesToUuid(op.id);
    if (decodedId) relationIds.push(decodedId);
  });

  const uniqueRelationIds = [...new Set(relationIds)];
  console.log(`🔗 Found ${uniqueRelationIds.length} unique relations to delete.`);

  for (const relationId of uniqueRelationIds) {
    // Use Graph.deleteRelation
    const relOps = Graph.deleteRelation({ id: relationId });
    delOps.push(...relOps.ops);
  }

  if (delOps.length === 0) {
    console.log('✅ No delete operations needed. Log was empty or contained no deletable data.');
    return;
  }

  console.log(`💾 Generated ${delOps.length} delete operations. Saving to rollback_ops.txt...`);

  // Save to file for inspection
  fs.writeFileSync(path.join(DATA_DIR, "rollback_ops.txt"), JSON.stringify(delOps, null, 2));

  // 7. Publish Rollback
  console.log(`🚀 Publishing rollback operations to Geo...`);
  
  const { cid, editId, to, calldata } = await personalSpace.publishEdit({
    name: `Rollback: ${OPS_FILE}`,
    spaceId,
    ops: delOps,
    author: spaceId,
    network: "TESTNET",
  });

  console.log(`📝 IPFS CID: ${cid}`);
  console.log(`🆔 Edit ID: ${editId}`);
  console.log(`📬 Calldata Target: ${to}`);

  const txHash = await smartAccount.sendTransaction({
    to,
    data: calldata,
  });

  console.log(`✅ Rollback Complete. TX Hash: ${txHash}`);
}

runRollback().catch(console.error);
