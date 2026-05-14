// src/export_space_drugs.ts
// Export all Drug entities from any space to local JSON

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_URL = "https://testnet-api.geobrowser.io/graphql";

// Drug type ID (same across spaces)
const DRUG_TYPE_ID = "1115f250e2a953ee8c8e4cfd0ae7a297";

const OUTPUT_DIR = path.join(__dirname, '..', 'exports');

// =============================================================================
// QUERY DRUGS FROM SPACE
// =============================================================================

interface DrugEntity {
  id: string;
  name: string;
  values: {
    nodes: Array<{
      property: { id: string; name: string };
      text?: string;
      integer?: string;
      float?: string;
      boolean?: boolean;
    }>;
  };
  relations: {
    nodes: Array<{
      id: string;
      typeId: string;
      toEntityId: string;
      toEntity?: { id: string; name: string };
      type?: { id: string; name: string };
    }>;
  };
  backlinks: {
    nodes: Array<{
      id: string;
      typeId: string;
      fromEntityId: string;
      fromEntity?: { id: string; name: string };
      type?: { id: string; name: string };
    }>;
  };
}

async function fetchAllDrugs(spaceId: string): Promise<DrugEntity[]> {
  console.log(`\n🔍 Querying Drug entities...`);
  console.log(`   Space: ${spaceId}`);
  console.log(`   Type: ${DRUG_TYPE_ID}\n`);

  const drugs: DrugEntity[] = [];
  let cursor: string | null = null;
  let batchNum = 0;

  while (true) {
    batchNum++;
    const afterParam = cursor ? `, after: "${cursor}"` : '';
    
    const query = `{
      entitiesConnection(
        spaceId: "${spaceId}",
        typeId: "${DRUG_TYPE_ID}",
        first: 100${afterParam}
      ) {
        nodes {
          id
          name
          values {
            nodes {
              property { id name }
              text
              integer
              float
              boolean
            }
          }
          relations {
            nodes {
              id
              typeId
              toEntityId
              toEntity { id name }
              type { id name }
            }
          }
          backlinks {
            nodes {
              id
              typeId
              fromEntityId
              fromEntity { id name }
              type { id name }
            }
          }
        }
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
      console.error(`❌ Query error on batch ${batchNum}:`, json.errors[0].message);
      break;
    }

    const nodes = json.data?.entitiesConnection?.nodes || [];
    const pageInfo = json.data?.entitiesConnection?.pageInfo;

    drugs.push(...nodes);
    console.log(`   Batch ${batchNum}: ${nodes.length} drugs (total: ${drugs.length.toLocaleString()})`);

    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;

    await new Promise(r => setTimeout(r, 100));
  }

  return drugs;
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const spaceId = args.find(a => !a.startsWith('--')) || '996487d85cc097dffff4b672d3247841';

  console.log('\n🚀 Export Space Drugs v1\n');

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`📁 Created output directory: ${OUTPUT_DIR}\n`);
  }

  // Fetch all drugs
  const drugs = await fetchAllDrugs(spaceId);

  if (drugs.length === 0) {
    console.log('\n⚠️  No Drug entities found in space.\n');
    return;
  }

  // Calculate statistics
  const stats = {
    totalDrugs: drugs.length,
    withValues: drugs.filter(d => d.values?.nodes?.length > 0).length,
    withRelations: drugs.filter(d => d.relations?.nodes?.length > 0).length,
    withBacklinks: drugs.filter(d => d.backlinks?.nodes?.length > 0).length,
    propertyCounts: {} as Record<string, number>,
    relationTypeCounts: {} as Record<string, { id: string; name: string; count: number }>,
    sampleNames: drugs.slice(0, 10).map(d => d.name),
  };

  // Count property usage
  for (const drug of drugs) {
    for (const v of drug.values?.nodes || []) {
      const propName = v.property?.name || v.property?.id || 'unknown';
      stats.propertyCounts[propName] = (stats.propertyCounts[propName] || 0) + 1;
    }
  }

  // Count relation types
  for (const drug of drugs) {
    for (const r of drug.relations?.nodes || []) {
      const key = r.typeId;
      if (!stats.relationTypeCounts[key]) {
        stats.relationTypeCounts[key] = {
          id: r.typeId,
          name: r.type?.name || 'unknown',
          count: 0
        };
      }
      stats.relationTypeCounts[key].count++;
    }
  }

  // Output file named by space ID
  const outputFile = path.join(OUTPUT_DIR, `drugs_${spaceId}.json`);

  // Prepare output
  const output = {
    exportedAt: new Date().toISOString(),
    spaceId: spaceId,
    typeId: DRUG_TYPE_ID,
    statistics: stats,
    drugs: drugs,
  };

  // Write to file
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

  console.log(`\n📊 Export Statistics:`);
  console.log(`   Total Drugs: ${stats.totalDrugs.toLocaleString()}`);
  console.log(`   With Values: ${stats.withValues.toLocaleString()}`);
  console.log(`   With Relations: ${stats.withRelations.toLocaleString()}`);
  console.log(`   With Backlinks: ${stats.withBacklinks.toLocaleString()}`);
  
  console.log(`\n   📋 Property Usage:`);
  Object.entries(stats.propertyCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([prop, count]) => {
      console.log(`      ${prop}: ${count.toLocaleString()}`);
    });

  console.log(`\n   🔗 Relation Types:`);
  Object.values(stats.relationTypeCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .forEach(r => {
      console.log(`      ${r.name}: ${r.count.toLocaleString()}`);
    });

  console.log(`\n   📝 Sample Drug Names:`);
  stats.sampleNames.forEach((name, i) => {
    console.log(`      ${i + 1}. ${name}`);
  });

  console.log(`\n💾 Saved to: ${outputFile}\n`);
}

main().catch(console.error);
