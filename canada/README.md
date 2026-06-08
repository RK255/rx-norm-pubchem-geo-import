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

## Key Concepts

|  Term |                    Meaning                    |
|-------|-----------------------------------------------|
| DIN   | Drug Identification Number (Health Canada)    |
| RxCUI | RxNorm Concept Unique Identifier              |
| LCA   | Low Cost Alternative (BC price cap policy)    |
| DBP   | Drug Benefit Price (Ontario max reimbursable) |
| SCD   | Semantic Clinical Drug (generic)              |
| SBD   | Semantic Branded Drug (brand-name)            |

---

## Data Sources

    Health Canada DPD: https://health-products.canada.ca/api/drug/
    BC PharmaCare: https://www2.gov.bc.ca/gov/content/health/practitioner-professional-resources/pharmacare
    NS Open Data: https://data.novascotia.ca/
    Ontario ODB: https://www.formulary.health.gov.on.ca/
