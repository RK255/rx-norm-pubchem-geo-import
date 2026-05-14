// src/update_pricing_live.ts
// Updates existing NDCs with v21 pricing by querying live Geo state

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Graph, personalSpace, getSmartAccountWalletClient } from '@geoprotocol/geo-sdk';
import { PROPERTY_IDS } from './constants';
import type { Hex } from 'viem';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data_to_publish');
const BATCH_SIZE = 80000;

async function runPricingUpdate() {
  console.log('🚀 Starting Pricing Update (Live Query v21)\n');
  
  const privateKeyRaw = process.env.GEO_WALLET_PRIVATE_KEY;
  const spaceId = process.env.GEO_SPACE_ID;
  
  if (!privateKeyRaw || !spaceId) {
    console.error('Missing GEO_WALLET_PRIVATE_KEY or GEO_SPACE_ID');
    process.exit(1);
  }

  // Check if we have existing NDC entities file
  const entitiesPath = path.join(DATA_DIR, 'existing_ndc_entities.json');
  if (!fs.existsSync(entitiesPath)) {
    console.error('Run query_existing_ndcs.ts first to get NDC entity IDs');
    process.exit(1);
  }
  
  const ndcEntities: { id: string; ndc11: string }[] = JSON.parse(fs.readFileSync(entitiesPath, 'utf-8'));
  console.log(`Loaded ${ndcEntities.length} existing NDC entities from Geo`);
  
  // Load v21 pricing data
  const v21Path = path.join(DATA_DIR, 'full_geo_extraction_v21.jsonl');
  const v21Data = fs.readFileSync(v21Path, 'utf-8');
  
  const pricingMap = new Map<string, { nadac?: number; costplus?: number }>();
  
  v21Data.split('\n').forEach(line => {
    if (!line.trim()) return;
    try {
      const ing = JSON.parse(line);
      const connections = ing.connections || {};
      
      const allNdcs = [
        ...(connections.scd || []).flatMap((s: any) => s.ndcs || []),
        ...(connections.sbd || []).flatMap((s: any) => s.ndcs || []),
        ...(connections.min || []).flatMap((m: any) => [
          ...(m.combo_scds || []).flatMap((s: any) => s.ndcs || []),
          ...(m.combo_sbds || []).flatMap((s: any) => s.ndcs || [])
        ])
      ];
      
      allNdcs.forEach((ndc: any) => {
        if (ndc.nadac_unit_price !== undefined || ndc.costplus_unit_billing_price !== undefined) {
          pricingMap.set(ndc.ndc11_no_hyphens, {
            nadac: ndc.nadac_unit_price,
            costplus: ndc.costplus_unit_billing_price
          });
        }
      });
    } catch (e) {}
  });
  
  console.log(`Loaded pricing data for ${pricingMap.size} NDCs from v21\n`);

  // Build update operations
  const privateKey = (privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`) as Hex;
  const smartAccount = await getSmartAccountWalletClient({ privateKey });
  
  const ops: any[] = [];
  let matched = 0;
  let noMatch = 0;
  let nadacUpdates = 0;
  let costplusUpdates = 0;
  
  for (const entity of ndcEntities) {
    const pricing = pricingMap.get(entity.ndc11);
    
    if (!pricing) {
      noMatch++;
      continue;
    }
    
    matched++;
    const values: any[] = [];
    
    if (pricing.nadac !== undefined) {
      values.push({
        property: PROPERTY_IDS.NADAC_UNIT_PRICE,
        type: 'float',
        value: pricing.nadac
      });
      nadacUpdates++;
    }
    
    if (pricing.costplus !== undefined) {
      values.push({
        property: PROPERTY_IDS.COST_PLUS_UNIT_PRICE,
        type: 'float',
        value: pricing.costplus
      });
      costplusUpdates++;
    }
    
    try {
      const result = Graph.updateEntity({
        id: entity.id,
        values: values
      });
      
      if (result?.ops) {
        ops.push(...result.ops);
      }
    } catch (e: any) {
      console.error(`Failed to prepare update for ${entity.ndc11}: ${e.message}`);
    }
  }
  
  console.log(`📊 Match Summary:`);
  console.log(`  NDC entities queried: ${ndcEntities.length}`);
  console.log(`  Matched with pricing: ${matched}`);
  console.log(`  No pricing match: ${noMatch}`);
  console.log(`  NADAC updates: ${nadacUpdates}`);
  console.log(`  CostPlus updates: ${costplusUpdates}`);
  console.log(`  Total operations: ${ops.length}\n`);
  
  if (ops.length === 0) {
    console.log('No updates to publish.');
    return;
  }

  // Confirm before publishing
  console.log(`Ready to publish ${ops.length} operations.`);
  console.log('Publishing in batches...\n');
  
  const totalBatches = Math.ceil(ops.length / BATCH_SIZE);
  
  for (let i = 0; i < totalBatches; i++) {
    const batch = ops.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    const batchNum = i + 1;
    
    console.log(`Batch ${batchNum}/${totalBatches} (${batch.length} ops)...`);
    
    const { cid, editId, to, calldata } = await personalSpace.publishEdit({
      name: `Pricing Update v21 Batch ${batchNum}`,
      spaceId: spaceId.replace(/-/g, ''),
      ops: batch,
      author: spaceId.replace(/-/g, ''),
      network: 'TESTNET',
    });
    
    console.log(`  IPFS: ${cid}`);
    console.log(`  Edit: ${editId}`);
    
    const txHash = await smartAccount.sendTransaction({ to, data: calldata });
    console.log(`  TX: ${txHash}\n`);
    
    if (batchNum < totalBatches) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  
  console.log('✅ Pricing updates complete!');
}

runPricingUpdate().catch(console.error);
