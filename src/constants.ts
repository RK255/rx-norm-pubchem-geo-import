// src/constants.ts

// =============================================================================
// ENTITY TYPE IDs
// =============================================================================
export const TYPE_IDS = {
  IN: 'b1bb9b33cdd247dfaf02ad98506c39eb',
  BN: '402cae0b9c17472586a2236f70492d7b',
  DF: '06e2222273114885b32b3a1368d2d266',
  SBD: '2033a9f3942a4c828dcdfe0411609450',
  SCD: 'a844e0f3a48d4e82b234da893aee4291',
  MIN: 'f0250a1cc9e8431980b3e9d7661e08f9',
  PIN: '4ba36be2740b4f36aa7c31512869bb3c',
  NDC: '285d054d3b524cd2bce119f2d796b259', // NEW: NDC Entity Type
} as const;

// =============================================================================
// RELATION IDs (edges between entities)
// =============================================================================
export const RELATION_IDS = {
  BRAND_NAMES: '3f30135c25394a0bb6ae429ef87337e1',
  DOSE_FORMS: '88a39df4de3542b8a6b0155750617b76',
  SEMANTIC_BRANDED_DRUGS: 'da89d8e2f052468f92ae5e8557ff1e78',
  SEMANTIC_CLINICAL_DRUGS: 'c1617a1e32844adeb5ff4c4445dc2ba6',
  MULTIPLE_INGREDIENTS: 'e8885ee2b8674952b2538ad4eee058e2',
  PRECISE_INGREDIENTS: '5d5602ac0fe64f4dbdc345c0bdf09d72',
  NDCS: '199c04685b3c49d3b09cdb32a40459cc', // NEW: SCD/SBD -> NDC relation
} as const;

// =============================================================================
// PROPERTY IDs (values on entities)
// =============================================================================
export const PROPERTY_IDS = {
  NAME: 'a126ca530c8e48d5b88882c734c38935',
  RXCUI: 'e6c50e227460442cab646a48f235459a',
  SMILES: '07bc332f2afd4e498d868f4e85ec5cc1',
  INCHI_KEY: '93d0ecbc41df4c668d2fb16172002dcb',
  PMID: '1577e86142964c9484c92cf079e330e1',
  NDC10: 'a7f0c739e65946d493993de764fe497e',
  NDC11: '1d9b05ec0ad24423a71257f9ad2e5a26',
  SPL_SET_ID: '97ad7e68cb4547b281655b9666958b45'
  // TODO: Add these when UUIDs are available
  // PUBCHEM_CID: '<NEED_UUID>',
} as const;
