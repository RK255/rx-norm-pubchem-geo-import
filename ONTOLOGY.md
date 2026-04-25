# Geo Health Space - RxNorm RxCUI Ingestion Ontology

## Overview
This project ingests a pharmaceutical knowledge graph derived from RxNorm RxCUI codes and associated TTYs into the Geo Health Space.

## Schema Strategy
Map RxNorm TTY (Term Type) entities and their relationships to the specific Geo Health Space UUIDs defined below.

---

Geo Health Space - RxNorm RxCUI Ingestion Ontology

## Types

|             Type             |                UUID                |
|------------------------------|------------------------------------|
| Ingredient (IN)              | `b1bb9b33cdd247dfaf02ad98506c39eb` |
| Brand Name (BN)              | `402cae0b9c17472586a2236f70492d7b` |
| Dose Form (DF)               | `06e2222273114885b32b3a1368d2d266` |
| Semantic Branded Drug (SBD)  | `2033a9f3942a4c828dcdfe0411609450` |
| Semantic Clinical Drug (SCD) | `a844e0f3a48d4e82b234da893aee4291` |
| Multiple Ingredient (MIN)    | `f0250a1cc9e8431980b3e9d7661e08f9` |
| Precise Ingredient (PIN)     | `4ba36be2740b4f36aa7c31512869bb3c` |
| NDC                          | `285d054d3b524cd2bce119f2d796b259` |

## Relations

|         Relation        |                UUID                |
|-------------------------|------------------------------------|
| Brand Names             | `3f30135c25394a0bb6ae429ef87337e1` |
| Dose Forms              | `88a39df4de3542b8a6b0155750617b76` |
| Semantic Branded Drugs  | `da89d8e2f052468f92ae5e8557ff1e78` |
| Semantic Clinical Drugs | `c1617a1e32844adeb5ff4c4445dc2ba6` |
| Multiple Ingredients    | `e8885ee2b8674952b2538ad4eee058e2` |
| Precise Ingredients     | `5d5602ac0fe64f4dbdc345c0bdf09d72` |
| NDCs                    | `199c04685b3c49d3b09cdb32a40459cc` |

## Properties

| Property  |                UUID                |
|-----------|------------------------------------|
| Name      | `a126ca530c8e48d5b88882c734c38935` |
| RxCUI     | `e6c50e227460442cab646a48f235459a` |
| SMILES    | `07bc332f2afd4e498d868f4e85ec5cc1` |
| InChI Key | `93d0ecbc41df4c668d2fb16172002dcb` |
| PMID      | `1577e86142964c9484c92cf079e330e1` |
| NDC10     | `a7f0c739e65946d493993de764fe497e` |
| NDC11     | `1d9b05ec0ad24423a71257f9ad2e5a26` |
| SPL_SET_ID| `97ad7e68cb4547b281655b9666958b45` |
<!-- | PubChem CID | `<NEED_UUID>` | -->

## Entity Hierarchy

### Ingredient (IN)
- Properties: Name, RxCUI, SMILES, InChI Key, PMID
- Relations: Brand Names, Dose Forms, Semantic Clinical Drugs, Semantic Branded Drugs, Precise Ingredients, Multiple Ingredients

### Multiple Ingredient (MIN)
- Properties: Name, RxCUI
- Relations: Multiple Ingredients, Semantic Clinical Drugs, Semantic Branded Drugs, Brand Names

### Brand Name (BN)
- Properties: Name, RxCUI
- Relations: Semantic Branded Drugs

### Dose Form (DF)
- Properties: Name, RxCUI

### Semantic Clinical Drug (SCD)
- Properties: Name, RxCUI
- Relations: NDCs

### Semantic Branded Drug (SBD)
- Properties: Name, RxCUI
- Relations: NDCs, Brand Names

### Precise Ingredient (PIN)
- Properties: Name, RxCUI

### NDC
- Properties: Name, NDC10, NDC11, SPL Set ID
- Relations: Link to from SCD, SBD
