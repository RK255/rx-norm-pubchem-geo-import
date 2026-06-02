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
| Brand Pack (BPCK)            | `78adf4017a5745e5a024771ae123d77b` |
| Generic Pack (GPCK)          | `c71ac4f342354c1d82da3ccfae274786` |

## Relations

|           Relation           |                UUID                |
|------------------------------|------------------------------------|
| Brand Names                  | `3f30135c25394a0bb6ae429ef87337e1` |
| Dose Forms                   | `88a39df4de3542b8a6b0155750617b76` |
| Semantic Branded Drugs       | `da89d8e2f052468f92ae5e8557ff1e78` |
| Semantic Clinical Drugs      | `c1617a1e32844adeb5ff4c4445dc2ba6` |
| Multiple Ingredients         | `e8885ee2b8674952b2538ad4eee058e2` |
| Precise Ingredients          | `5d5602ac0fe64f4dbdc345c0bdf09d72` |
| NDCs                         | `199c04685b3c49d3b09cdb32a40459cc` |
| Ingredients                  | `42f9691bb3334c058553ab74c5fa4016` |
| Brand Packs                  | `80913eb0c104490391bfbfe25ef71e7c` |
| Generic Packs                | `3490c0442f3e49819cde4293356d89e2` |

## Properties

|        Property                                |                UUID                |
|------------------------------------------------|------------------------------------|
| Name                                           | `a126ca530c8e48d5b88882c734c38935` |
| RxCUI                                          | `e6c50e227460442cab646a48f235459a` |
| SMILES                                         | `07bc332f2afd4e498d868f4e85ec5cc1` |
| InChI Key                                      | `93d0ecbc41df4c668d2fb16172002dcb` |
| PMID                                           | `1577e86142964c9484c92cf079e330e1` |
### NDC Properties ###
| NDC10                                          | `a7f0c739e65946d493993de764fe497e` |
| NDC11                                          | `1d9b05ec0ad24423a71257f9ad2e5a26` |
| SPL_SET_ID                                     | `97ad7e68cb4547b281655b9666958b45` |
| NADAC Unit Price                               | `866fe5eeda584f1aba92522cfeccfac0` |
| Cost Plus Unit Price                           | `a8c3eeb8f1ba45fca53094ccbe77351d` |
| FDA Drug Label Type                            | `a26efc874172411fb67293730e1fa19c` |
| US Drug Labeler                                | `a1ddd4b931e743aa8a4bf3ae90dd89b5` |
| US Drug Approval Type                          | `1064611317da4067aa77dfb62f664b93` |
| US Drug Application Approval Number            | `42c53702bb234d549e1ca8de7d358b50` |
| US Drug Marketing Start Date                   | `76018890666340b88ea9d3dc6b261839` |
| Drug Marketing Status                          | `42fb2cb81aaa4c92ba95b6ae6a0b1c4f` |
| Dosage Form Size                               | `e35a0231116744cd86ce47fada688eb7` |
| Dosage Form Score                              | `bde08b44479e422d8948f7ffa4f4258f` |
| Dosage Form Color                              | `35418df366654f45b2f149ab080a03d1` |
| Dosage Form Color Description                  | `e39e964fa3fa4d76bef2ba049db30444` |
| Dosage Form Imprint Code                       | `5e566908df1441869a1ac4b44d7f26cb` |
| Dosage Form Shape                              | `017ab18b8a8c484a87f5d1955634ad68` |
<!-- | PubChem CID | `<NEED_UUID>` | -->

## Entity Hierarchy

### Ingredient (IN)
- Properties: Name, RxCUI, SMILES, InChI Key, PMID, Description
- Relations: Brand Names, Dose Forms, Semantic Clinical Drugs, Semantic Branded Drugs, Precise Ingredients, Multiple Ingredients, Canadian Branded Drugs, Canadian Generic Drugs

### Multiple Ingredient (MIN)
- Properties: Name, RxCUI
- Relations: Ingredients, Precise Ingredients, Semantic Clinical Drugs, Semantic Branded Drugs, Brand Names, Dose Forms, Canadian Branded Drugs, Canadian Generic Drugs

### Precise Ingredient (PIN)
- Properties: Name, RxCUI
- Relations: Ingredients, Multiple Ingredients, Semantic Clinical Drugs, Semantic Branded Drugs, Brand Names, Dose forms, Canadian Branded Drugs, Canadian Generic Drugs

### Brand Name (BN)
- Properties: Name, RxCUI
- Relations: Semantic Branded Drugs, Ingredients, Multiple Ingredients, Precise Ingredients

### Dose Form (DF)
- Properties: Name, RxCUI
- Relations: Ingredients, Multiple Ingredients, Precise Ingredients

### Semantic Clinical Drug (SCD)
- Properties: Name, RxCUI
- Relations: NDCs, Generic Packs, Ingredients, Multiple Ingredients, Precise Ingredients

### Semantic Branded Drug (SBD)
- Properties: Name, RxCUI
- Relations: NDCs, Brand Names, Brand Packs, Ingredients, Multiple Ingredients, Precise Ingredients

### NDC
- Properties: Name, NDC10, NDC11, SPL Set ID, NADAC Unit Price, Cost Plus Unit Price, Drug Marketing Status,
FDA Drug Label Type, US Drug Marketing Start Date, US Drug Application Number, US Drug Approval Type, 
Dosage Form Size, Dosage Form Color Description, Dosage Form Imprint Code, Dosage Form Color, 
Dosage Form Size, Dosage Form Shape, Dosage Form Score 
- Relations: Link to from SCD, SBD

### Brand Pack (BPCK)
- Properties: Name, RxCUI
- Relations: NDCs, Brand names, Dose forms, Semantic Branded Drugs

### Generic Pack (GPCK)
- Properties: Name, RxCUI
- Relations: NDCs, Dose forms, Semantic Clinical Drugs
