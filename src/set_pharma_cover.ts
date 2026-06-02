// src/set_pharma_cover.ts
// Set Cover image on all entities in Pharma space

import 'dotenv/config';
import { Graph, personalSpace, daoSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import type { Hex } from 'viem';
import * as readline from 'readline';

const API_URL = "https://testnet-api.geobrowser.io/graphql";
const SPACE_ID = process.env.GEO_SPACE_ID;
const PERSONAL_SPACE_ID = process.env.GEO_PERSONAL_SPACE_ID;

const DRY_RUN = process.argv.includes('--dry-run');
const limitArgIndex = process.argv.indexOf('--limit');
const LIMIT = limitArgIndex !== -1 ? parseInt(process.argv[limitArgIndex + 1]) || null : null;

const COVER_PROPERTY = '34f535072e6b42c5a84443981a77cfa2';
const IMAGE_TYPE = 'ba4e41460010499da0a3caaa7f579d0e';
const IMAGE_URL_PROPERTY = '8a743832c0944a62b6650c3cc2f9c7bc';
const TYPES_PROPERTY = '8f151ba4de204e3c9cb499ddf96f48f1';

const PHARMA_IMAGE_URL = 'https://magenta-naval-crow-536.mypinata.cloud/files/bafybeigpymddhtqrqniw5wr27cnsdqjqizpemlnueyiwmuvcwlpaclhrwu';
const PHARMA_COVER_IMAGE_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const BATCH_SIZE = 500;
const PAGE_SIZE = 1000;

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

async function createImageEntity(): Promise<string> {
  console.log('🔍 Checking for existing Image entity...');

  const checkQuery = `{
    entity(id: "${PHARMA_COVER_IMAGE_ID}") {
      id
      values(filter: { propertyId: { is: "${IMAGE_URL_PROPERTY}" } }) {
        text
      }
    }
  }`;
  
  const checkRes = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: checkQuery }),
  });
  const checkJson = await checkRes.json() as any;
  
  if (checkJson.data?.entity) {
    const existingUrl = checkJson.data.entity.values?.[0]?.text;
    console.log(`✅ Image entity exists: ${PHARMA_COVER_IMAGE_ID}`);
    console.log(`   URL: ${existingUrl || 'not set'}`);
    return PHARMA_COVER_IMAGE_ID;
  }

  console.log('🆕 Creating new Image entity...');

  const ops: any[] = [];

  const imgResult = Graph.createEntity({
    id: PHARMA_COVER_IMAGE_ID,
    name: 'Pharma Space Cover',
  });
  ops.push(...imgResult.ops);

  const typeRel = Graph.createRelation({
    fromEntity: PHARMA_COVER_IMAGE_ID,
    toEntity: IMAGE_TYPE,
    type: TYPES_PROPERTY,
  });
  ops.push(...typeRel.ops);

  const urlResult = Graph.updateEntity({
    id: PHARMA_COVER_IMAGE_ID,
    values: [{ property: IMAGE_URL_PROPERTY, type: 'text', value: PHARMA_IMAGE_URL }],
  });
  ops.push(...urlResult.ops);

  console.log(`📦 Generated ${ops.length} ops for Image entity creation`);

  if (DRY_RUN) {
    console.log('   [DRY RUN] Would publish Image entity creation');
    return PHARMA_COVER_IMAGE_ID;
  }

  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("GEO_WALLET_PRIVATE_KEY missing");
  const privateKey = (privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const smartAccount = await getSmartAccountWalletClient({ privateKey });

  const { to, calldata } = await personalSpace.publishEdit({
    name: 'Create pharma cover image entity',
    spaceId: SPACE_ID!.replace(/-/g, ''),
    ops,
    author: SPACE_ID!.replace(/-/g, ''),
    network: 'TESTNET',
  });

  const txHash = await smartAccount.sendTransaction({ to, data: calldata });
  console.log(`✅ Image entity created: ${txHash}`);
  
  return PHARMA_COVER_IMAGE_ID;
}

async function fetchAllEntities(spaceId: string, limit: number | null): Promise<Array<{ id: string; name: string; hasCover: boolean }>> {
  console.log(`\n🔍 Fetching entities from space...`);
  if (limit) console.log(`   ⚠️  LIMIT MODE: Will stop after ${limit} entities`);
  
  const entities: Array<{ id: string; name: string; hasCover: boolean }> = [];
  let cursor: string | null = null;
  let batchNum = 0;

  // Fetch all entities
  while (true) {
    if (limit && entities.length >= limit) {
      console.log(`   ⏹️  Reached limit of ${limit} entities`);
      break;
    }

    batchNum++;
    const afterParam = cursor ? `, after: "${cursor}"` : '';
    const fetchSize = limit ? Math.min(PAGE_SIZE, limit - entities.length) : PAGE_SIZE;

    const query = `{
      entitiesConnection(
        spaceId: "${spaceId}",
        first: ${fetchSize}${afterParam}
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
      console.error(`❌ Query error batch ${batchNum}:`, json.errors[0].message);
      break;
    }

    const nodes = json.data?.entitiesConnection?.nodes || [];
    const pageInfo = json.data?.entitiesConnection?.pageInfo;

    for (const node of nodes) {
      entities.push({ id: node.id, name: node.name, hasCover: false });
    }

    console.log(`   Batch ${batchNum}: ${nodes.length} entities (total: ${entities.length.toLocaleString()})`);

    if (!pageInfo?.hasNextPage) break;
    if (nodes.length === 0) break;
    cursor = pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 50));
  }

  // Check for existing Cover relations with retry logic
  console.log(`\n🔍 Checking for existing Cover relations...`);
  const entityIds = entities.map(e => e.id);
  const withCover = new Set<string>();
  let checkErrors = 0;

  for (let i = 0; i < entityIds.length; i += 100) {
    const chunk = entityIds.slice(i, i + 100);
    const idsFilter = chunk.map(id => `"${id}"`).join(', ');
    
    const checkQuery = `{
      relationsConnection(
        filter: {
          spaceId: { is: "${spaceId}" }
          typeId: { is: "${COVER_PROPERTY}" }
          entityId: { in: [${idsFilter}] }
        }
        first: 1000
      ) {
        nodes { entityId }
      }
    }`;

    // Retry logic for each chunk
    let success = false;
    let retries = 0;
    const maxRetries = 3;

    while (!success && retries < maxRetries) {
      try {
        const checkRes = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: checkQuery }),
        });
        
        if (!checkRes.ok) {
          throw new Error(`HTTP ${checkRes.status}`);
        }

        const checkJson = await checkRes.json() as any;
        
        if (checkJson.errors) {
          throw new Error(checkJson.errors[0].message);
        }
        
        if (checkJson.data?.relationsConnection?.nodes) {
          for (const rel of checkJson.data.relationsConnection.nodes) {
            withCover.add(rel.entityId);
          }
        }
        
        success = true;
        checkErrors = 0; // Reset error counter on success
      } catch (e: any) {
        retries++;
        checkErrors++;
        console.error(`   ⚠️  Chunk ${i/100 + 1} failed (attempt ${retries}/${maxRetries}): ${e.message}`);
        
        if (retries >= maxRetries) {
          console.error(`   ❌ Skipping chunk after ${maxRetries} retries`);
        } else {
          await new Promise(r => setTimeout(r, 1000 * retries)); // Exponential backoff
        }
      }
    }

    // Progress every 50 chunks
    if (i % 5000 === 0 && i > 0) {
      console.log(`   Checked ${i}/${entityIds.length} entities...`);
    }

    // Small delay between requests to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  for (const entity of entities) {
    entity.hasCover = withCover.has(entity.id);
  }

  console.log(`   Found ${withCover.size} entities with existing Cover`);
  return entities;
}

async function publishCoverBatches(
  entityIds: string[],
  imageEntityId: string,
  spaceInfo: { type: 'PERSONAL' | 'DAO'; address?: string }
): Promise<void> {
  
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  if (!privateKeyRaw) throw new Error("GEO_WALLET_PRIVATE_KEY missing");
  const privateKey = (privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const smartAccount = await getSmartAccountWalletClient({ privateKey });

  // Build all ops
  const allOps: any[] = [];
  for (const entityId of entityIds) {
    const rel = Graph.createRelation({
      fromEntity: entityId,
      toEntity: imageEntityId,
      type: COVER_PROPERTY,
    });
    allOps.push(...rel.ops);
  }

  // Different batch sizes per space type
  const batchSize = spaceInfo.type === 'DAO' ? 2000 : 80000;
  const totalBatches = Math.ceil(allOps.length / batchSize);

  console.log(`\n📦 Publishing ${totalBatches} batch(es) to ${spaceInfo.type} space...`);
  console.log(`   Total ops: ${allOps.length.toLocaleString()}`);
  console.log(`   Batch size: ${batchSize.toLocaleString()}\n`);

  for (let i = 0; i < totalBatches; i++) {
    const batch = allOps.slice(i * batchSize, (i + 1) * batchSize);
    const batchNum = i + 1;
    console.log(`Batch ${batchNum}/${totalBatches} (${batch.length.toLocaleString()} ops)...`);

    if (DRY_RUN) {
      console.log('   [DRY RUN] Skipped');
      continue;
    }

    try {
      let to: `0x${string}`;
      let calldata: `0x${string}`;

      if (spaceInfo.type === 'DAO') {
        const result = await daoSpace.proposeEdit({
          name: `Set pharma cover image (batch ${batchNum}/${totalBatches})`,
          ops: batch,
          author: PERSONAL_SPACE_ID!.replace(/-/g, ''),
          daoSpaceAddress: spaceInfo.address as `0x${string}`,
          callerSpaceId: '0x' + PERSONAL_SPACE_ID!.replace(/-/g, ''),
          daoSpaceId: '0x' + SPACE_ID!.replace(/-/g, ''),
          network: 'TESTNET',
        });
        to = result.to;
        calldata = result.calldata;
      } else {
        const result = await personalSpace.publishEdit({
          name: `Set pharma cover image (batch ${batchNum}/${totalBatches})`,
          spaceId: SPACE_ID!.replace(/-/g, ''),
          ops: batch,
          author: SPACE_ID!.replace(/-/g, ''),
          network: 'TESTNET',
        });
        to = result.to;
        calldata = result.calldata;
      }

      const txHash = await smartAccount.sendTransaction({ to, data: calldata });
      console.log(`   ✅ ${txHash.slice(0, 24)}...`);
      
      // Longer delay between batches for personal space (larger batches)
      if (batchNum < totalBatches) {
        const delay = spaceInfo.type === 'DAO' ? 2000 : 3000;
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (e: any) {
      console.error(`   ❌ Batch ${batchNum} failed:`, e.message);
      throw e;
    }
  }
  console.log('\n✅ All batches complete!\n');
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PHARMA COVER IMAGE SETTER');
  console.log(`DRY_RUN: ${DRY_RUN}`);
  if (LIMIT) console.log(`LIMIT: ${LIMIT} entities`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (!SPACE_ID) {
    console.error('❌ Missing GEO_SPACE_ID');
    process.exit(1);
  }

  const spaceInfo = await detectSpaceType(SPACE_ID);

  if (spaceInfo.type === 'DAO' && !PERSONAL_SPACE_ID) {
    console.error('❌ GEO_PERSONAL_SPACE_ID required for DAO space');
    process.exit(1);
  }

  console.log(`📋 Space: ${SPACE_ID} (${spaceInfo.type})`);

  const imageId = await createImageEntity();
  const entities = await fetchAllEntities(SPACE_ID, LIMIT);

  const toUpdate = entities.filter(e => !e.hasCover);
  const alreadyHave = entities.filter(e => e.hasCover);

  console.log(`\n📊 Summary:`);
  console.log(`   Total entities scanned: ${entities.length.toLocaleString()}`);
  console.log(`   Already have Cover: ${alreadyHave.length.toLocaleString()}`);
  console.log(`   Need Cover set: ${toUpdate.length.toLocaleString()}`);

  if (toUpdate.length === 0) {
    console.log('\n✅ All entities already have Cover set. Done!\n');
    return;
  }

  console.log(`\n📝 Sample entities to update (first ${Math.min(10, toUpdate.length)}):`);
  console.log('   (Click these URLs to verify in Geo UI)\n');
  
  toUpdate.slice(0, 10).forEach((e, i) => {
    const url = `https://www.geobrowser.io/space/${SPACE_ID}/${e.id}`;
    const name = e.name.length > 45 ? e.name.substring(0, 45) + '...' : e.name;
    console.log(`   ${i + 1}. ${name}`);
    console.log(`      → ${url}`);
  });
  
  if (toUpdate.length > 10) {
    console.log(`\n   ... and ${toUpdate.length - 10} more`);
  }

  if (DRY_RUN) {
    console.log('\n✅ Dry run complete. No changes published.\n');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirmed = await new Promise<boolean>((resolve) => {
    rl.question(`\nSet Cover on ${toUpdate.length.toLocaleString()} entities? [y/N]: `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });

  if (!confirmed) {
    console.log('❌ Aborted.\n');
    return;
  }

  await publishCoverBatches(toUpdate.map(e => e.id), imageId, spaceInfo);
  console.log('🎉 Done!\n');
}

main().catch(console.error);
