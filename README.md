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

*   **Ingredients (IN)**: 2,893
*   **Semantic Clinical Drugs (SCD)**: 13,606
*   **Semantic Branded Drugs (SBD)**: 8,777
*   **Brand Names (BN)**: 5,025
*   **Manufacturers (MIN)**: 3,225
*   **Packagers (PIN)**: 1,215
*   **Dose Forms (DF)**: 3,906

**Enrichment:**
- **PubChem Integration**: All 2,893 Ingredients are enriched with PubChem CIDs, SMILES, InChIKeys, and PMIDs.

**Scripts**
bun run import → src/import_extracted_data.ts – Ingests data with auto-deduplication.
bun run rollback → src/rollback_selective.ts – Reverts a specific batch safely.
bun run clean_all → src/clean_pharma_types.ts – Clears Pharma entities.
