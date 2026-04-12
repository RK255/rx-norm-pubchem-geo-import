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

|           Entity Type             | Count  |                       Description                        |
|                                   |        |                                                          |
| **Ingredients (IN)**              | 2,893  | Active pharmaceutical ingredients (e.g., Acetaminophen). |
| **Semantic Clinical Drugs (SCD)** | 13,606 | Dose forms as precise clinical concepts.                 |
| **Semantic Branded Drugs (SBD)**  | 8,777  | Branded drug products (e.g., Tylenol PM).                |
| **Brand Names (BN)**              | 5,025  | The brand names associated with drugs.                   |
| **Manufacturers (MIN)**           | 3,225  | Drug manufacturers.                                      |
| **Packagers (PIN)**               | 1,215  | Drug packagers.                                          | 
| **Dose Forms (DF)**               | 3,906  | Physical dose forms (e.g., Tablet, Oral Solution).       |

**Enrichment:**
- **PubChem Integration**: All 2,893 Ingredients are enriched with PubChem CIDs, SMILES, InChIKeys, and PMIDs.

## Scripts

### `src/import_extracted_data.ts`
The primary import script. It processes the `full_geo_extraction.json` file, generates operations for Ingredients and their relations, and publishes them to a Geo space.

**Usage:**
```bash
# Run full master list of Ingredients
bun run src/import_extracted_data.ts

# Run with a custom limit (limits by Ingredient)
bun run src/import_extracted_data.ts --limit 100
