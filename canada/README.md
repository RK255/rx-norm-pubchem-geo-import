# Canadian Drug Pricing Pipeline

Extracts Health Canada DPD products, normalizes to RxNorm, and affixes provincial pricing.

---

## Dataset

|                Metric               |        Count    |
|-------------------------------------|-----------------|
| Canadian products matched to RxNorm |      5,016      |
| DINs with pricing                   |      11,883     |
| Provinces                           | BC, NS, Ontario |

---

## Pipeline

**Step 1: DPD Extract** → DINs, brand/generic names, ingredients  
**Step 2: RxNorm Match** → SCD/SBD/PIN clinical concepts  
**Step 3: Pricing Affix** → Unit costs from provincial formularies

---

## Geo Schema

### Entity Types

|  Type |                   ID               |       Description          |
|-------|------------------------------------|----------------------------|
| `CGD` | `4db10155f8ff42ac8f0cc9f3a73a7b3f` | Canadian Generic Drug      |
| `CBD` | `b4ec40d4a58d4a7eb6438e749d313aac` | Canadian Branded Drug      |
| `DIN` | `d3562354d6d044d298d2eac2f4db91ff` | Drug Identification Number |

### Relations

|          Relation        |                 ID                 |    From    |  To |
|--------------------------|------------------------------------|------------|-----|
| `CANADIAN_GENERIC_DRUGS` | `d1ce9514f0444f3c8e88d867758afb60` | IN/MIN/PIN | CGD |
| `CANADIAN_BRANDED_DRUGS` | `70ad75646de54413bac22df8183379d5` | IN/MIN/PIN | CBD |
| `DINS`                   | `333ca631ed2c408a95f1530e32d2cd5e` | CGD/CBD    | DIN |

### Properties

|          Property          |                  ID                | Type |
|----------------------------|------------------------------------|--------|
| `RELATED_RXCUI`            | `88e887d0951240aa8eb2fb4a61d7d8bd` | String |
| `CANADIAN_DRUG_LABELER`    | `6bcb4ebd7d334048be2750800b27cb14` | String |
| `ATC_CODE`                 | `3796877237004803b9ebf9cca4267536` | String |
| `BC_PHARMACARE_UNIT_PRICE` | `22a9fba0fe754866afc0c61281d1f1ce` | Float  |
| `ONTARIO_ODB_UNIT_PRICE`   | `0a16db51be7e4e05aa4d691fe219a5e6` | Float  |
| `NOVA_SCOTIA_UNIT_PRICE`   | `4ebc10d73d154f478d2893b1283db337` | Float  |

---

## Data Sources

    Health Canada DPD: https://health-products.canada.ca/api/drug/
    BC PharmaCare: https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare
    NS Open Data: https://data.novascotia.ca/
    Ontario ODB: https://www.formulary.health.gov.on.ca/
