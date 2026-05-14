 // src/capitalize_entity_names.ts
// Capitalize first letter of IN, PIN, and MIN entity names

import 'dotenv/config';
import { Graph, personalSpace, daoSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import { TYPE_IDS, PROPERTY_IDS } from './constants';
import type { Hex } from 'viem';

const API_URL = "https://testnet-api.geobrowser.io/graphql";

const TYPE_NAMES: Record<string, string> = {
  [TYPE_IDS.IN]: 'Ingredient',
  [TYPE_IDS.PIN]: 'PIN',
  [TYPE_IDS.MIN]: 'MIN',
};

// =============================================================================
// SPACE HELPERS
// =============================================================================

async function detectSpaceType(spaceId: string): Promise<{ type: 'PERSONAL' | 'DAO'; address?: string }> {
  const query = `query GetSpaceType { space(id: "${spaceId}") { id type address } }`;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
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
    type: json.data.space.type as 'PERSONAL' | 'DAO',
    address: json.data.space.address
  };
}

// =============================================================================
// QUERY ENTITIES
// =============================================================================

async function fetchEntitiesNeedingCapitalization(spaceId: string): Promise<Array<{ id: string; name: string; typeId: string }>> {
  const typeIds = [TYPE_IDS.IN, TYPE_IDS.PIN, TYPE_IDS.MIN];
  const results: Array<{ id: string; name: string; typeId: string }> = [];
  
  for (const typeId of typeIds) {
    const typeName = TYPE_NAMES[typeId] || typeId.substring(0, 8);
    console.log(`\n🔍 Querying ${typeName} entities...`);
    
    let cursor: string | null = null;
    let count = 0;
    let needsCapitalization = 0;
    
    while (true) {
      const afterParam = cursor ? `, after: "${cursor}"` : '';
      const query = `{
        entitiesConnection(
          spaceId: "${spaceId}",
          typeId: "${typeId}",
          first: 1000${afterParam}
        ) {
          nodes { id name }
          pageInfo { hasNextPage endCursor }
        }
      }`;
      
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      
      const json = await res.json() as any;
      if (json.errors) {
        console.error(`  ⚠️ Query error: ${json.errors[0].message}`);
        break;
      }
      
      const nodes = json.data?.entitiesConnection?.nodes || [];
      const pageInfo = json.data?.entitiesConnection?.pageInfo;
      
      for (const entity of nodes) {
        count++;
        const name = entity.name || '';
        // Check if first character is lowercase letter
        if (name.length > 0 && /^[a-z]/.test(name)) {
          needsCapitalization++;
          results.push({
            id: entity.id,
            name: name,
            typeId: typeId
          });
        }
      }
      
      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor;
      await new Promise(r => setTimeout(r, 50));
    }
    
    console.log(`  ${count.toLocaleString()} total, ${needsCapitalization.toLocaleString()} need capitalization`);
  }
  
  return results;
}

// =============================================================================
// PUBLISHING
// =============================================================================

async function publishInBatches(
  allOps: any[],
  spaceInfo: { type: 'PERSONAL' | 'DAO'; address?: string },
  spaceId: string,
  smartAccount: any,
  personalSpaceId: string | undefined,
  proposalName: string
): Promise<void> {
  
  const batchSize = spaceInfo.type === 'DAO' ? 2000 : 80000;
  const totalBatches = Math.ceil(allOps.length / batchSize);
  
  console.log(`\n📦 Publishing ${totalBatches} batch(es) to ${spaceInfo.type} space...`);
  console.log(`   Batch size: ${batchSize.toLocaleString()} ops\n`);

  for (let i = 0; i < totalBatches; i++) {
    const batch = allOps.slice(i * batchSize, (i + 1) * batchSize);
    const batchNum = i + 1;
    
    const batchName = `${proposalName} (Batch ${batchNum}/${totalBatches})`;
    console.log(`Batch ${batchNum}/${totalBatches} (${batch.length.toLocaleString()} ops)...`);
    console.log(`   Name: "${batchName.substring(0, 60)}${batchName.length > 60 ? '...' : ''}"`);
    
    try {
      let to: `0x${string}`;
      let calldata: `0x${string}`;
      let cid: string;

      if (spaceInfo.type === 'DAO') {
        const result = await daoSpace.proposeEdit({
          name: batchName,
          ops: batch,
          author: personalSpaceId!.replace(/-/g, ''),
          daoSpaceAddress: spaceInfo.address as `0x${string}`,
          callerSpaceId: '0x' + personalSpaceId!.replace(/-/g, ''),
          daoSpaceId: '0x' + spaceId.replace(/-/g, ''),
          network: 'TESTNET',
        });
        cid = result.cid;
        to = result.to;
        calldata = result.calldata;
        console.log(`   📝 Proposal ID: ${result.proposalId}`);
      } else {
        const result = await personalSpace.publishEdit({
          name: batchName,
          spaceId: spaceId.replace(/-/g, ''),
          ops: batch,
          author: spaceId.replace(/-/g, ''),
          network: 'TESTNET',
        });
        cid = result.cid;
        to = result.to;
        calldata = result.calldata;
        console.log(`   📝 IPFS: ${cid}`);
      }

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`   ✅ Broadcast: ${txHash}`);
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
// CAPITALALIZATION HELPERS
// =============================================================================

function capitalizeName(name: string, typeId: string): string {
  // For MIN entities with "/" separator, capitalize each part
  if (typeId === TYPE_IDS.MIN && name.includes('/')) {
    return name
      .split('/')
      .map(part => part.trim())
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' / ');
  }
  
  // Standard capitalization: first letter only
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes('--dry-run');
  const proposalName = (() => {
    const idx = args.indexOf('--proposal-name');
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : 'Capitalize entity names';
  })();

  console.log(`\n🚀 Capitalize Entity Names v1`);
  if (DRY_RUN) console.log('   🔍 DRY RUN - no changes will be published');
  console.log('');

  const spaceId = process.env.GEO_SPACE_ID;
  const personalSpaceId = process.env.GEO_PERSONAL_SPACE_ID;
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;

  if (!spaceId) {
    console.error('❌ Missing GEO_SPACE_ID');
    process.exit(1);
  }

  const spaceInfo = await detectSpaceType(spaceId);
  
  if (spaceInfo.type === 'DAO' && !personalSpaceId) {
    console.error('❌ GEO_PERSONAL_SPACE_ID required for DAO space');
    process.exit(1);
  }

  console.log(`📋 Space: ${spaceId} (${spaceInfo.type})\n`);

  // Fetch entities needing capitalization
  const entities = await fetchEntitiesNeedingCapitalization(spaceId);
  
  if (entities.length === 0) {
    console.log('\n✅ No entities need capitalization. Done.\n');
    return;
  }

  console.log(`\n📊 Found ${entities.length.toLocaleString()} entities needing capitalization`);
  console.log('\n📝 Sample entities:');
  entities.slice(0, 10).forEach((e, i) => {
    const typeName = TYPE_NAMES[e.typeId] || e.typeId.substring(0, 8);
    const newName = capitalizeName(e.name, e.typeId);
    console.log(`   ${i + 1}. "${e.name}" → "${newName}" [${typeName}]`);
  });
  if (entities.length > 10) {
    console.log(`   ... and ${(entities.length - 10).toLocaleString()} more`);
  }

  // Generate ops
  const allOps: any[] = [];
  
  for (const entity of entities) {
    const newName = capitalizeName(entity.name, entity.typeId);
    
    const result = Graph.updateEntity({
      id: entity.id,
      name: newName,
    });
    allOps.push(...result.ops);
  }

  console.log(`\n📊 Generated ${allOps.length.toLocaleString()} operations`);

  if (DRY_RUN) {
    console.log('\n✅ Dry run complete. No changes published.\n');
    return;
  }

  let smartAccount: any = null;
  if (!privateKeyRaw) {
    console.error('❌ Missing GEO_WALLET_PRIVATE_KEY');
    process.exit(1);
  }
  const privateKey = (privateKeyRaw?.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  smartAccount = await getSmartAccountWalletClient({ privateKey });
  console.log(`✅ Wallet ready\n`);

  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirmed = await new Promise<boolean>((resolve) => {
    rl.question(`\nPublish ${allOps.length.toLocaleString()} ops to ${spaceInfo.type} space? [y/N]: `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });

  if (!confirmed) {
    console.log('❌ Aborted.\n');
    return;
  }

  await publishInBatches(allOps, spaceInfo, spaceId, smartAccount, personalSpaceId, proposalName);
}

main().catch(console.error);
