# Geo Health Space - RxNorm RxCUI Ingestion Ontology

## Overview
This project ingests a pharmaceutical knowledge graph derived from RxNorm RxCUI codes and associated TTYs into the Geo Health Space.

## Schema Strategy
Map RxNorm TTY (Term Type) entities and their relationships to the specific Geo Health Space UUIDs defined below.

## Types (TTY Mapping)

| RxNorm TTY  |       Type Name        |                UUID                |
|             |                        |
| `IN`        | Ingredient             | `b1bb9b33cdd247dfaf02ad98506c39eb` |
| `BN`        | Brand name             | `402cae0b9c17472586a2236f70492d7b` |
| `DF`        | Dose form              | `06e2222273114885b32b3a1368d2d266` |
| `SBD`       | Semantic Branded Drug  | `2033a9f3942a4c828dcdfe0411609450` |
| `SCD`       | Semantic Clinical Drug | `a844e0f3a48d4e82b234da893aee4291` |
| `MIN`       | Multiple ingredient    | `f0250a1cc9e8431980b3e9d7661e08f9` |
| `PIN`       | Precise ingredient     | `4ba36be2740b4f36aa7c31512869bb3c` |

## RxNorm Properties

|       Property Name       |                      UUID                      |         Description 
|                           |                                                |
| `RxCUI`                   | `e6c50e227460442cab646a48f235459a`             | The unique RxNorm identifier. |
| `Brand names`             | `3f30135c25394a0bb6ae429ef87337e1`             | Links an Ingredient to its Brand Names. |
| `Dose forms`              | `88a39df4de3542b8a6b0155750617b76`             | Links an Ingredient or Drug to its Dose Forms. |
| `Semantic Branded Drugs`  | `da89d8e2f052468f92ae5e8557ff1e78`             | Links a Brand Name to its Semantic Branded Drugs. |
| `Semantic clinical drugs` | `c1617a1e32844adeb5ff4c4445dc2ba6`             | Links an Ingredient to its Semantic Clinical Drugs. |
| `Multiple ingredients`    | `e8885ee2b8674952b2538ad4eee058e2`             | Links a Drug to its multiple constituent Ingredients. |
| `Precise ingredients`     | `5d5602ac0fe64f4dbdc345c0bdf09d72`             | Links a Precise Ingredient to its base Ingredient. |

## PubChem Properties

|       Property Name        |                      UUID                      |         Description
|                            |                                                |
| `SMILES`                   | `07bc332f2afd4e498d868f4e85ec5cc1`             | The unique RxNorm identif>
| `Inchikey`                 | `93d0ecbc41df4c668d2fb16172002dcb`             | Links an Ingredient to it>
| `Pmid`                     | `1577e86142964c9484c92cf079e330e1`             | Links an Ingredient or Dr>

## Data Files

*   `data/rx_norm_types.json`: Defines the Type entities (IN, BN, DF, etc.).
*   `data/rx_norm_properties.json`: Defines the Property entities (RXCUI, Brand names, etc.).
*   `data/rx_norm_entities.json`: The instance data linking Types, Properties, and RxCUIs.

## Sources
PROVENANCE_SOURCES = {
    "RxNorm": {
        "name": "RxNorm",
        "citation_template": "RxNorm [Internet]. Bethesda (MD): National Library of Medicine (US); [cite>
        "source_url": "https://rxnorm.nlm.nih.gov/",
        "provenance_type": "IMPORTED",
    "PubChem": {
        "name": "PubChem",
        "citation_template": "PubChem [Internet]. Bethesda (MD): National Library of Medicine (US); [cit>
        "source_url": "https://pubchem.ncbi.nlm.nih.gov/",
    },
##    "DailyMed": {
##        "name": "DailyMed",
##        "citation_template": "DailyMed [Internet]. Bethesda (MD): National Library of Medicine (US); [ci>
##        "source_url": "https://dailymed.nlm.nih.gov/",

Hierarchy

Type: Ingredient (IN)

    Has Property: Pubchem (our 3 pubchem properties: SMILES, InChIKey, PMID)
    Has Property: Precise Ingredients (Links to PIN)
    Has Property: Multiple Ingredients (Links to MIN)
    Has Property: Semantic Clinical Drugs (Links to SCD)
    Has Property: Dose Forms (Links to DF)
    Has Property: Semantic Branded Drugs (Links to SBD)
    Has Property: Brand Names (Links to BN)

Type: Precise Ingredient (PIN)

    Has Property: RxCUI

Type: Multiple Ingredient (MIN)

    Has Property: RxCUI
 
Type: Semantic Clinical Drug (SCD)

    Has Property: RxCUI

Type: Semantic Branded Drug (SBD)

    Has Property: RxCUI

Type: Dose Form (DF)

    Has Property: RxCUI

Type: Brand Name (BN)

    Has Property: RxCUI

