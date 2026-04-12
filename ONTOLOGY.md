# Geo Health Space - RxNorm RxCUI Ingestion Ontology

## Overview
This project ingests a pharmaceutical knowledge graph derived from RxNorm RxCUI codes and associated TTYs into the Geo Health Space.

## Schema Strategy
Map RxNorm TTY (Term Type) entities and their relationships to the specific Geo Health Space UUIDs defined below.

---

## Types (TTY Mapping)

**Ingredient (IN)**
`UUID: b1bb9b33cdd247dfaf02ad98506c39eb`

**Brand Name (BN)**
`UUID: 402cae0b9c17472586a2236f70492d7b`

**Dose Form (DF)**
`UUID: 06e2222273114885b32b3a1368d2d266`

**Semantic Branded Drug (SBD)**
`UUID: 2033a9f3942a4c828dcdfe0411609450`

**Semantic Clinical Drug (SCD)**
`UUID: a844e0f3a48d4e82b234da893aee4291`

**Multiple Ingredient (MIN)**
`UUID: f0250a1cc9e8431980b3e9d7661e08f9`

**Precise Ingredient (PIN)**
`UUID: 4ba36be2740b4f36aa7c31512869bb3c`

---

## Properties

### RxNorm Properties

**RxCUI**
`UUID: e6c50e227460442cab646a48f235459a`
*   The unique RxNorm identifier.

**Brand names**
`UUID: 3f30135c25394a0bb6ae429ef87337e1`
*   Links an Ingredient to its Brand Names.

**Dose forms**
`UUID: 88a39df4de3542b8a6b0155750617b76`
*   Links an Ingredient or Drug to its Dose Forms.

**Semantic Branded Drugs**
`UUID: da89d8e2f052468f92ae5e8557ff1e78`
*   Links a Brand Name to its Semantic Branded Drugs.

**Semantic clinical drugs**
`UUID: c1617a1e32844adeb5ff4c4445dc2ba6`
*   Links an Ingredient to its Semantic Clinical Drugs.

**Multiple ingredients**
`UUID: e8885ee2b8674952b2538ad4eee058e2`
*   Links a Drug to its multiple constituent Ingredients.

**Precise ingredients**
`UUID: 5d5602ac0fe64f4dbdc345c0bdf09d72`
*   Links a Precise Ingredient to its base Ingredient.

### PubChem Properties

**SMILES**
`UUID: 07bc332f2afd4e498d868f4e85ec5cc1`
*   The Simplified Molecular Input Line Entry System.

**InChIKey**
`UUID: 93d0ecbc41df4c668d2fb16172002dcb`
*   The InChIKey for the Ingredient.

**PMID**
`UUID: 1577e86142964c9484c92cf079e330e1`
*   The PubMed ID for the Ingredient.

---

## Entity Hierarchy

### Type: Ingredient (IN)
*   Has Property: RxCUI
*   Has Property: SMILES
*   Has Property: InChIKey
*   Has Property: PMID
*   Has Relation: Brand Names (BN)
*   Has Relation: Dose Forms (DF)
*   Has Relation: Semantic Clinical Drugs (SCD)
*   Has Relation: Semantic Branded Drugs (SBD)
*   Has Relation: Precise Ingredients (PIN)
*   Has Relation: Multiple Ingredients (MIN)

### Type: Brand Name (BN)
*   Has Property: RxCUI

### Type: Dose Form (DF)
*   Has Property: RxCUI

### Type: Semantic Clinical Drug (SCD)
*   Has Property: RxCUI

### Type: Semantic Branded Drug (SBD)
*   Has Property: RxCUI

### Type: Precise Ingredient (PIN)
*   Has Property: RxCUI

### Type: Multiple Ingredient (MIN)
*   Has Property: RxCUI
