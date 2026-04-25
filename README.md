# Geo Pharma Ingestor

Dataset

Source: RxNorm (NIH), DailyMed (FDA), PubChem (NIH)
Method: Filtered to ingredients with active products and NDC mappings; enriched with PubChem CIDs and DailyMed SPL SET IDs.

Totals:

    1,650 active ingredients (IN)
    196,719 entities (IN, BN, DF, SCD, SBD, MIN, PIN, NDC)
    602,364 operations across 8 batches

Filtering: 63,002 NDCs excluded (no DailyMed SPL_SET_ID).

Storage: GRC-20 knowledge graph in DAO space 19f11bc6....
Scripts

    import_extracted_data_v6.ts — Import with --set-id-only and --connected-only flags
    clean_pharma_mega.ts — Cursor-pagination deletion for cleanup
    rollback_mega.ts — Batch rollback by manifest
