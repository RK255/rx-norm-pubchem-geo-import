1. Entity `name` not passed to `Graph.createEntity`
FIX: Added `name: entity.name` parameter to the createEntity call and removed the duplicate Name property from the values array.

2. TypeScript doesn't compile — 55+ errors
FIX: Added `"types": ["node"]` to tsconfig.json compilerOptions to include Node.js type definitions.

3. All 3 npm scripts reference non-existent files
FIX: Updated package.json scripts to use actual filenames: `import` and `rollback`.

4. `dotenv` dependency never imported
FIX: Added `import 'dotenv/config';` at the top of both import_extracted_data.ts and rollback_selective.ts.

5. Published entities have zero property values
FIX: Root cause was the missing name parameter (issue #1). After fixing that, values persist correctly on republish.

6. No deduplication — entities created without checking existence
FIX: Added fetchExistingEntityIds() function to query the API before publishing, plus --force flag to skip the check.

7. PubChem CID values not published
FIX: PENDING — Will add CID property publishing after the CID property is added to the ontology.

8. 16 `REL_IDS` in constants don't exist as entities
FIX: Removed all unused relation IDs from constants.ts during the cleanup.

9. `__dirname` and `require('crypto')` used in ESM project
FIX: Added ESM polyfill for __dirname using fileURLToPath, changed require to import statement.

10. Default `--limit 5` — only imports 5 ingredients
FIX: Changed default to undefined so all ingredients are processed unless user explicitly sets --limit.

11. 1,103 ingredients (38%) have zero connections
FIX: Added --connected-only flag to filter out isolated ingredients with no relations.

12. No dry-run / preview mode
FIX: Added --dry-run flag that generates a human-readable summary file, plus interactive confirmation prompt before publishing.

13. Dual RXCUI IDs — source vs property
FIX: Renamed PROP_IDS to RELATION_IDS, merged SOURCE_DATA_IDS into PROPERTY_IDS, removed unused provenance IDs.

14. Dual lockfiles (bun.lock and package-lock.json)
FIX: Removed bun.lockb from .gitignore since bun.lock should be committed for reproducible builds.

15. Constants defined but never used (IUPAC, FORMULA, CID)
FIX: Removed all unused constants during the constants.ts cleanup.
