// src/constants.ts
// Canada geo-ingestor
//
// Two layers:
//   RXNORM_*  — existing IDs from the US ontology, reused here
//   CAN_*     — new Canadian-specific IDs registered in Geo

// =============================================================================
// EXISTING RXNORM IDs
// =============================================================================

// Type IDs — used to generate deterministic UUIDs for parent anchor entities
// (IN/MIN/PIN already exist in the space; we reference them, not create them)
export const RXNORM_TYPE_IDS = {
  IN:  'b1bb9b33cdd247dfaf02ad98506c39eb',
  MIN: 'f0250a1cc9e8431980b3e9d7661e08f9',
  PIN: '4ba36be2740b4f36aa7c31512869bb3c',
} as const;

// Relation IDs — two uses:
//   1. On IN/MIN/PIN entities: add CANADIAN_GENERIC/BRANDED_DRUGS pointing to CGD/CBD
//   2. On CGD/CBD entities:    add back-relation to parent anchor, type chosen by parent_tty:
//        parent_tty = IN  → INGREDIENTS
//        parent_tty = MIN → MULTIPLE_INGREDIENTS
//        parent_tty = PIN → PRECISE_INGREDIENTS
export const RXNORM_RELATION_IDS = {
  INGREDIENTS:          '42f9691bb3334c058553ab74c5fa4016',
  MULTIPLE_INGREDIENTS: 'e8885ee2b8674952b2538ad4eee058e2',
  PRECISE_INGREDIENTS:  '5d5602ac0fe64f4dbdc345c0bdf09d72',
} as const;

// Property IDs — Name is general enough to reuse across all entity types
export const RXNORM_PROPERTY_IDS = {
  NAME: 'a126ca530c8e48d5b88882c734c38935',
} as const;

// =============================================================================
// CANADIAN TYPE IDs
// =============================================================================

export const CAN_TYPE_IDS = {
  CGD: '4db10155f8ff42ac8f0cc9f3a73a7b3f',   // CanadianGenericDrug
  CBD: 'b4ec40d4a58d4a7eb6438e749d313aac',   // CanadianBrandedDrug
  DIN: 'd3562354d6d044d298d2eac2f4db91ff',   // DIN  (Name = DIN number string)
} as const;

// =============================================================================
// CANADIAN RELATION IDs
// =============================================================================

export const CAN_RELATION_IDS = {
  // Added to IN/MIN/PIN entities — forward direction anchor → product
  CANADIAN_GENERIC_DRUGS:  'd1ce9514f0444f3c8e88d867758afb60',
  CANADIAN_BRANDED_DRUGS:  '70ad75646de54413bac22df8183379d5',

  // Added to CGD/CBD entities — product → its DINs
  DINS:                    '333ca631ed2c408a95f1530e32d2cd5e',
} as const;

// =============================================================================
// CANADIAN PROPERTY IDs
// =============================================================================

export const CAN_PROPERTY_IDS = {
  // Stores the plain rxcui integer string (e.g. "617311").
  // "CAN:CGD:" prefix used only locally as UUID seed — never published.
  RELATED_RXCUI: '88e887d0951240aa8eb2fb4a61d7d8bd',
  CANADIAN_DRUG_LABELER: '6bcb4ebd7d334048be2750800b27cb14',
  ATC_CODE: '3796877237004803b9ebf9cca4267536',
  // DIN Properties
  BC_PHARMACARE_UNIT_PRICE: '22a9fba0fe754866afc0c61281d1f1ce',
  ONTARIO_ODB_UNIT_PRICE: '0a16db51be7e4e05aa4d691fe219a5e6',
  NOVA_SCOTIA_UNIT_PRICE: '4ebc10d73d154f478d2893b1283db337',
} as const;

// =============================================================================
// TYPE NAME MAP  (dry-run / reporting)
// =============================================================================

export const TYPE_NAMES: Record<string, string> = {
  [RXNORM_TYPE_IDS.IN]:  'Ingredient (IN)',
  [RXNORM_TYPE_IDS.MIN]: 'Multiple Ingredient (MIN)',
  [RXNORM_TYPE_IDS.PIN]: 'Precise Ingredient (PIN)',
  [CAN_TYPE_IDS.CGD]:    'CanadianGenericDrug',
  [CAN_TYPE_IDS.CBD]:    'CanadianBrandedDrug',
  [CAN_TYPE_IDS.DIN]:    'DIN',
};

// =============================================================================
// UUID HELPERS
// =============================================================================

import crypto from 'crypto';

// Parent anchor UUID — mirrors the main importer's generateUuid exactly.
// IN/MIN/PIN UUIDs must match what the US import created or relations break.
export function anchorUuid(rxcui: string, typeId: string): string {
  const seed = `${typeId}:${rxcui}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return [hash.slice(0,8), hash.slice(8,12), hash.slice(12,16),
          hash.slice(16,20), hash.slice(20,32)].join('-');
}

// Canadian product UUID — namespaced to avoid collision with US SCD/SBD.
// "CAN:CGD:" / "CAN:CBD:" prefix is the only difference from the US seed.
export function canadianProductUuid(rxcui: string, tty: 'SCD' | 'SBD'): string {
  const prefix = tty === 'SBD' ? 'CAN:CBD:' : 'CAN:CGD:';
  const seed   = `${prefix}${rxcui}`;
  const hash   = crypto.createHash('sha256').update(seed).digest('hex');
  return [hash.slice(0,8), hash.slice(8,12), hash.slice(12,16),
          hash.slice(16,20), hash.slice(20,32)].join('-');
}

// DIN UUID
export function dinUuid(din: string): string {
  const hash = crypto.createHash('sha256').update(`CAN:DIN:${din}`).digest('hex');
  return [hash.slice(0,8), hash.slice(8,12), hash.slice(12,16),
          hash.slice(16,20), hash.slice(20,32)].join('-');
}
