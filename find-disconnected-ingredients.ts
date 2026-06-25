// filters/find-disconnected-ingredients.ts
//
// Finds IN/MIN/PIN entities NOT connected to any SBD/SCD product that has an NDC.
// Outputs them as blacklist candidates.
//
// Usage:
//   npx tsx filters/find-disconnected-ingredients.ts --dry-run
//   npx tsx filters/find-disconnected-ingredients.ts --output disconnected-review.json
//   npx tsx filters/find-disconnected-ingredients.ts --merge
//
// Flags:
//   --dry-run          Print candidates without writing files
//   --merge            Merge candidates into existing ingredient-blacklist.json
//   --output <path>    Write candidates to a separate file (default: disconnected-ingredients.json)

import fs from 'fs';

// ─── Constants (from geo-ingestor/src/constants.ts) ─────────────────
const SPACE_ID = 'e8173628fb65f0957475a58933040614';
const GEO_API = 'https://testnet-api.geobrowser.io/graphql';
const PAGE_SIZE = 200;

// Product Type IDs
const SCD_TYPE_ID = 'a844e0f3a48d4e82b234da893aee4291';
const SBD_TYPE_ID = '2033a9f3942a4c828dcdfe0411609450';

// Ingredient Type IDs
const IN_TYPE_ID = 'b1bb9b33cdd247dfaf02ad98506c39eb';
const MIN_TYPE_ID = 'f0250a1cc9e8431980b3e9d7661e08f9';
const PIN_TYPE_ID = '4ba36be2740b4f36aa7c31512869bb3c';

// Relation IDs
const NDCS_RELATION_ID = '199c04685b3c49d3b09cdb32a40459cc';
const INGREDIENTS_RELATION_ID = '42f9691bb3334c058553ab74c5fa4016';
const MULTIPLE_INGREDIENTS_RELATION_ID = 'e8885ee2b8674952b2538ad4eee058e2';
const PRECISE_INGREDIENTS_RELATION_ID = '5d5602ac0fe64f4dbdc345c0bdf09d72';

// All three ingredient relations — we traverse all of them
const INGREDIENT_RELATION_IDS = [
  INGREDIENTS_RELATION_ID,
  MULTIPLE_INGREDIENTS_RELATION_ID,
  PRECISE_INGREDIENTS_RELATION_ID,
];

const BLACKLIST_PATH = 'public/data/ingredient-blacklist.json';

// ─── GraphQL Helper ─────────────────────────────────────────────────
async function gqlQuery(query: string, variables: Record<string, any>) {
  const res = await fetch(GEO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL error: ${res.status} ${res.statusText}\n${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
  }
  return json.data;
}

// ─── Step 1: Get all SBD/SCD product IDs that have NDCs ─────────────
async function getNDCProductIds(): Promise<Set<string>> {
  const productIds = new Set<string>();
  let after: string | null = null;

  const query = `
    query GetProductsWithNDCs($spaceId: ID!, $first: Int!, $after: String) {
      space(id: $spaceId) {
        entities(
          first: $first
          after: $after
          filter: {
            typeIds: ["${SCD_TYPE_ID}", "${SBD_TYPE_ID}"]
          }
        ) {
          edges {
            node {
              id
              relations(filter: { relationId: "${NDCS_RELATION_ID}" }) {
                edges {
                  node {
                    toEntity { id }
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  let pageCount = 0;
  while (true) {
    const data = await gqlQuery(query, { spaceId: SPACE_ID, first: PAGE_SIZE, after });

    const edges = data.space.entities.edges;
    for (const edge of edges) {
      const node = edge.node;
      const ndcEdges = node.relations?.edges ?? [];
      if (ndcEdges.length > 0) {
        productIds.add(node.id);
      }
    }

    pageCount++;
    console.log(`  Products page ${pageCount}: ${edges.length} entries, ${productIds.size} with NDCs so far`);

    if (!data.space.entities.pageInfo.hasNextPage) break;
    after = data.space.entities.pageInfo.endCursor;
  }

  console.log(`✓ Found ${productIds.size} products with NDCs`);
  return productIds;
}

// ─── Step 2: Traverse from NDC products to ingredients ─────────────
// Query each product for all three ingredient relation types and collect
// the connected ingredient entity IDs.
async function getConnectedIngredientIds(productIds: Set<string>): Promise<Set<string>> {
  const ingredientIds = new Set<string>();
  const allProductIds = [...productIds];
  const BATCH_SIZE = 50;

  // Build relation filter string for all three ingredient relations
  const relationIdsStr = INGREDIENT_RELATION_IDS.map(id => `"${id}"`).join(', ');

  const query = `
    query GetProductIngredients($spaceId: ID!, $first: Int!, $after: String, $entityIds: [ID!]) {
      space(id: $spaceId) {
        entities(
          first: $first
          after: $after
          filter: {
            entityIds: $entityIds
          }
        ) {
          edges {
            node {
              id
              relations(filter: { relationIds: [${relationIdsStr}] }) {
                edges {
                  node {
                    toEntity {
                      id
                      name
                      type { id name }
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  for (let i = 0; i < allProductIds.length; i += BATCH_SIZE) {
    const batch = allProductIds.slice(i, i + BATCH_SIZE);
    const data = await gqlQuery(query, {
      spaceId: SPACE_ID,
      first: PAGE_SIZE,
      after: null,
      entityIds: batch,
    });

    for (const edge of data.space.entities.edges) {
      const relEdges = edge.node.relations?.edges ?? [];
      for (const rel of relEdges) {
        const ing = rel.node.toEntity;
        if (ing && ing.id) {
          ingredientIds.add(ing.id);
        }
      }
    }

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allProductIds.length / BATCH_SIZE);
    console.log(`  Ingredient traversal batch ${batchNum}/${totalBatches}: ${ingredientIds.size} connected ingredients so far`);
  }

  console.log(`✓ Found ${ingredientIds.size} ingredients connected to NDC products`);
  return ingredientIds;
}

// ─── Step 3: Get ALL ingredient entities (IN/MIN/PIN) ──────────────
async function getAllIngredients(): Promise<Array<{ id: string; name: string; typeName: string }>> {
  const ingredients: Array<{ id: string; name: string; typeName: string }> = [];
  let after: string | null = null;

  const query = `
    query GetAllIngredients($spaceId: ID!, $first: Int!, $after: String) {
      space(id: $spaceId) {
        entities(
          first: $first
          after: $after
          filter: {
            typeIds: ["${IN_TYPE_ID}", "${MIN_TYPE_ID}", "${PIN_TYPE_ID}"]
          }
        ) {
          edges {
            node {
              id
              name
              type { id name }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  let pageCount = 0;
  while (true) {
    const data = await gqlQuery(query, { spaceId: SPACE_ID, first: PAGE_SIZE, after });

    const edges = data.space.entities.edges;
    for (const edge of edges) {
      const node = edge.node;
      ingredients.push({
        id: node.id,
        name: node.name,
        typeName: node.type?.name ?? 'UNKNOWN',
      });
    }

    pageCount++;
    console.log(`  All ingredients page ${pageCount}: ${edges.length} entries, ${ingredients.length} total so far`);

    if (!data.space.entities.pageInfo.hasNextPage) break;
    after = data.space.entities.pageInfo.endCursor;
  }

  console.log(`✓ Found ${ingredients.length} total ingredient entities (IN/MIN/PIN)`);
  return ingredients;
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const merge = args.includes('--merge');
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : 'disconnected-ingredients.json';

  console.log('═'.repeat(70));
  console.log('  Find Disconnected Ingredients (IN/MIN/PIN not linked to NDC products)');
  console.log('═'.repeat(70));
  console.log(`  Space: ${SPACE_ID}`);
  console.log(`  API:   ${GEO_API}`);
  console.log(`  Mode:  ${dryRun ? 'DRY RUN' : merge ? 'MERGE' : 'OUTPUT FILE'}`);
  console.log('');

  // Step 1: Get products with NDCs
  console.log('Step 1: Fetching SBD/SCD products with NDCs...');
  const ndcProductIds = await getNDCProductIds();

  // Step 2: Traverse to ingredients via all three ingredient relations
  console.log('\nStep 2: Traversing from NDC products to connected ingredients...');
  console.log('  (Traversing INGREDIENTS + MULTIPLE_INGREDIENTS + PRECISE_INGREDIENTS relations)');
  const connectedIngredientIds = await getConnectedIngredientIds(ndcProductIds);

  // Step 3: Get ALL ingredients
  console.log('\nStep 3: Fetching all IN/MIN/PIN entities in the space...');
  const allIngredients = await getAllIngredients();

  // Step 4: Find disconnected
  console.log('\nStep 4: Identifying disconnected ingredients...');
  const disconnected = allIngredients.filter(ing => !connectedIngredientIds.has(ing.id));

  // Breakdown by type
  const byType: Record<string, number> = {};
  for (const ing of disconnected) {
    byType[ing.typeName] = (byType[ing.typeName] ?? 0) + 1;
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log('  RESULTS');
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Total ingredients (IN/MIN/PIN):       ${allIngredients.length}`);
  console.log(`  Connected to NDC products:            ${connectedIngredientIds.size}`);
  console.log(`  DISCONNECTED (blacklist candidates):  ${disconnected.length}`);
  console.log(`${'─'.repeat(70)}`);
  console.log('  Disconnected breakdown by type:');
  for (const [type, count] of Object.entries(byType)) {
    console.log(`    ${type}: ${count}`);
  }
  console.log(`${'─'.repeat(70)}\n`);

  // Print sample
  console.log('Sample disconnected ingredients (first 50):');
  console.log('─'.repeat(70));
  for (const ing of disconnected.slice(0, 50)) {
    console.log(`  [${ing.typeName}] ${ing.name}  (${ing.id})`);
  }
  if (disconnected.length > 50) {
    console.log(`  ... and ${disconnected.length - 50} more`);
  }
  console.log('');

  // Extract lowercase names for blacklist format
  const disconnectedNames = disconnected
    .map(ing => ing.name.toLowerCase().trim())
    .filter(name => name.length > 0);

  // Deduplicate
  const uniqueNames = [...new Set(disconnectedNames)];

  console.log(`Unique blacklist name candidates: ${uniqueNames.length}\n`);

  if (dryRun) {
    console.log('[DRY RUN] Not writing any files.');
    console.log(`Would ${merge ? 'merge' : 'write'} ${uniqueNames.length} ingredient names.`);
    return;
  }

  if (merge) {
    // Merge with existing blacklist
    let existing: string[] = [];
    if (fs.existsSync(BLACKLIST_PATH)) {
      existing = JSON.parse(fs.readFileSync(BLACKLIST_PATH, 'utf-8'));
    }
    const existingSet = new Set(existing.map(s => s.toLowerCase().trim()));
    const newEntries = uniqueNames.filter(n => !existingSet.has(n));
    const merged = [...new Set([...existing, ...uniqueNames])].sort();
    fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(merged, null, 2) + '\n');
    console.log(`✓ Merged into ${BLACKLIST_PATH}`);
    console.log(`  Previous blacklist size: ${existing.length}`);
    console.log(`  New blacklist size:      ${merged.length}`);
    console.log(`  New entries added:       ${newEntries.length}`);
    if (newEntries.length > 0 && newEntries.length <= 50) {
      console.log(`  New entries:`);
      for (const name of newEntries) {
        console.log(`    + ${name}`);
      }
    }
  } else {
    // Write to separate file
    const output = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalIngredients: allIngredients.length,
        connectedToNDC: connectedIngredientIds.size,
        disconnected: disconnected.length,
        uniqueBlacklistNames: uniqueNames.length,
        breakdownByType: byType,
      },
      ingredients: disconnected.map(ing => ({
        id: ing.id,
        name: ing.name,
        type: ing.typeName,
      })),
      blacklistNames: uniqueNames,
    };
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`✓ Wrote ${disconnected.length} disconnected ingredients to ${outputPath}`);
    console.log(`  Blacklist-format names: ${uniqueNames.length}`);
  }

  console.log('\nNext steps:');
  console.log('  1. Review the disconnected ingredients list');
  console.log('  2. Re-run with --merge to add to ingredient-blacklist.json');
  console.log('  3. Run: npm run build:ndc-index');
  console.log('  4. Run: npm run build');
  console.log('  5. Run: sudo systemctl restart pharma-frontend.service');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
