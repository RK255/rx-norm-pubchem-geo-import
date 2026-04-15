# Geo Pharma Ingestor

This project ingests a curated subset of US pharmaceutical product data into the Geo Knowledge Graph, specifically targeting actively marketed ingredients.

Early emphasis has been placed on extracting a list of active ingredients and mapping them out to their product level with the help of the RxNorm RxCUI dataset.

## Data Sources

*   **RxNorm**: `rxnorm_entities_FULLY_ENRICHED.jsonl` (Entities & Relations)
##*   **NDC Bridge**: `ndc_bridge_relations.jsonl` (Links RxNorm to NDCs) **future import**
*   **PubChem**: `pubchem_cid_mapping.json` (Chemical Identifiers)

## Extraction Logic

The import is a surgical extraction of US-marketed chemicals, filtering the full RxNorm graph (5,788 ingredients) down to a clean subset via two intersection steps:

1.  **Market Activity (NDC Filter)**: A full graph traversal identifies ingredients connected to at least one NDC. This filters out non-marketed chemicals (e.g., "Air", "Water"). Result: **5,788 ingredients**.
2.  **Chemical Identity (PubChem Filter)**: The active ingredients are intersected with the PubChem CID mapping to ensure valid chemical identities and allow integration with external chemical data. Result: **2,893 ingredients**.

**Data Totals:**

*   **Ingredients (IN)**: 2,893 (1,790 w/ --connected-only)
*   **Semantic Clinical Drugs (SCD)**: 13,606
*   **Semantic Branded Drugs (SBD)**: 8,777
*   **Brand Names (BN)**: 5,025
*   **Manufacturers (MIN)**: 3,225
*   **Packagers (PIN)**: 1,215
*   **Dose Forms (DF)**: 3,906

**Enrichment:**
- **PubChem Integration**: All 2,893 Ingredients are enriched with PubChem CIDs, SMILES, InChIKeys, and PMIDs.

## Scripts

### `bun run import`
**Source:** `src/import_extracted_data.ts`

Ingests RxNorm data into Geo with auto-deduplication.

**Flags:**
- `--limit N` – Process only the first N ingredients (useful for testing).
- `--connected-only` – Filter out isolated ingredients (38%) that have no clinical relations (products, brands, dose forms). This reduces the dataset from 2,893 to ~1,790 ingredients with full connectivity.
- `--force` – Skip deduplication check and publish regardless of existing entities.

**Examples:**

bun run import                          # Import all 2,893 ingredients
bun run import --connected-only         # Import only ~1,790 connected ingredients
bun run import --limit 50              # Test with first 50 ingredients
bun run import --limit 10 --force       # Force import 10 (skip dedup check)


### `bun run rollback`

**Source:** `src/rollback_selective.ts`

Reverts a specific batch safely using its manifest file.

Usage:

bun run rollback --file data_to_publish/manifest_123456789.json

### `bun run clean_all`

**Source:** `src/clean_pharma_types.ts`

Clears all Pharma entities from the space using RxCUI fingerprint detection.

Usage:

bun run clean_all

