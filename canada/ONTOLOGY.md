# Geo Health Space - Canadian DPD Ingestion Ontology

## Overview
This dataset aims to augment the RxNorm dataset and connect product concepts and pricing between the US and Canada leveraging the offical Canadian DPD.

## Schema Strategy

---

Geo Health Space - Canadian DPD Ingestion Ontology

## Types

|               Type	             |                UUID                |
|------------------------------------|------------------------------------|
| Canadian Generic Drug (CGD)	     | `4db10155f8ff42ac8f0cc9f3a73a7b3f` |
| Canadian Branded Drug (CBD)	     | `b4ec40d4a58d4a7eb6438e749d313aac` |
| DIN	                             | `d3562354d6d044d298d2eac2f4db91ff` |
| Ingredient          `from RxNorm`  | `b1bb9b33cdd247dfaf02ad98506c39eb` |
| Multiple Ingredient `from RxNorm`  | `f0250a1cc9e8431980b3e9d7661e08f9` |
| Precise Ingredient  `from RxNorm`  | `4ba36be2740b4f36aa7c31512869bb3c` |

## Relations

|             Relation	             |                UUID	          |
|------------------------------------|------------------------------------|
| Canadian Generic Drugs	     | `d1ce9514f0444f3c8e88d867758afb60` |
| Canadian Branded Drugs	     | `70ad75646de54413bac22df8183379d5` |
| DINs	                             | `333ca631ed2c408a95f1530e32d2cd5e` |
| Ingredients          `from RxNorm` | `42f9691bb3334c058553ab74c5fa4016` |
| Multiple Ingredients `from RxNorm` | `e8885ee2b8674952b2538ad4eee058e2` |
| Precise Ingredients  `from RxNorm` | `5d5602ac0fe64f4dbdc345c0bdf09d72` |

## Properties

|             Property	             |                UUID	          |
|------------------------------------|------------------------------------|
| Name                    	     | `126ca530c8e48d5b88882c734c38935`  |
| Related RxCUI	                     | `88e887d0951240aa8eb2fb4a61d7d8bd` |
| BC Pharmacare Unit Price           | `22a9fba0fe754866afc0c61281d1f1ce` |
| Nova Scotia Unit Price             | `4ebc10d73d154f478d2893b1283db337` |
| Ontario ODB Unit Price             | `0a16db51be7e4e05aa4d691fe219a5e6` |
| ATC Code                           | `3796877237004803b9ebf9cca4267536` |
| Canadian Drug Labeler              | `6bcb4ebd7d334048be2750800b27cb14` |


---


## Entity Hierarchy

### Ingredient (IN)  ***From RxNorm***
- Added Relations: Canadian Generic Drugs, Canadian Branded Drugs

### Multiple Ingredient (MIN)  ***From RxNorm***
- Added Relations: Canadian Generic Drugs, Canadian Branded Drugs

### Precise Ingredient (PIN)  ***From RxNorm***
- Added Relations: Canadian Generic Drugs, Canadian Branded Drugs

### Canadian Generic Drug (CGD)
- Properties: Name, Related RxCUI
- Relations: Ingredients, Multiple Ingredients, Precise Ingredients, DINs

### Canadian Branded Drug (CBD)
- Properties: Name, Related RxCUI
- Relations: Ingredients, Multiple Ingredients, Precise Ingredients, DINs

### DIN
- Properties: Name, ATC Code, Canadian Drug Labeler, BC Pharmacare Unit Price, Ontario ODB Unit Price, Nova Scotia Unit Price
- Relations: Relate to CGD & CBD
