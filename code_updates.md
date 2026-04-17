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

## NEW UPDATES (2026-04-16)

16. Malformed semver in `package.json`
FIX: Replaced corrupted versions with correct ones from lockfile. dotenv `^1^.4.0` → `17.4.2` (exact, no caret), added viem `2.37.6` (exact, no caret). Removed unused `fs-extra` dependency. Also removed `@types/node` from devDependencies since bun/tsx handles types separately. Fresh installs now resolve correctly.

17. TypeScript `fetch` type errors
FIX: Added `"DOM"` to tsconfig.json `"lib"` array: `"lib": ["ES2022", "DOM"]`. The `fetch` API is available from ES2023/DOM, and Node.js 18+ provides native fetch. Now `npx tsc --noEmit` compiles without errors.

18. PubChem CID values still not published
STATUS: SKIPPED — CID property is not yet in the ontology. All 1,790 ingredients have CID values in source data, but publishing will wait until the CID property is added to the Geo schema. Issue #7 remains open.

19. No space type detection — personal vs DAO
FIX: Added `detectSpaceType()` function that queries the Geo API for `space.type` at startup. Routes to `personalSpace.publishEdit()` for PERSONAL spaces and `daoSpace.proposeEdit()` for DAO spaces. Also fixed GraphQL variable type mismatch (`UUID!` vs `String!`) by using inline interpolation. Exits with error if space type cannot be determined.

20. `clean_pharma_types.ts` hardcodes RxCUI property ID
FIX: Replaced hardcoded `'e6c50e227460442cab646a48f235459a'` with `PROPERTY_IDS.RXCUI` imported from `constants.ts`. Maintains single source of truth for all property/relation IDs.

