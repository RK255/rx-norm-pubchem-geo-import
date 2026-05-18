**Biosimilar Mappings**
Create a crosswalk mapping biosimilar products to their reference biologics with approval pathway (351(k) vs 351(a)) and interchangeability status.
- Easy: Fill out product Entity profiles for all currently marketed biosimilars (~30-50 or so)
- Hard: Build comprehensive dataset including pipeline biosimilars, patent landscapes, and market status for all reference products

**Clinical Trials (NCT Mapping)**
Link top 300 drugs to their pivotal clinical trials via ClinicalTrials.gov NCT identifiers with outcome data.
- Easy: Map FDA approvals to supporting NCT numbers for 50 drugs
- Hard: Build dataset linking drugs to all registered trials (pivotal and non-pivotal), phases, completion status, and outcome publications for 200+ drugs

**Real-World Evidence (FAERS)**
Build a structured adverse event dataset from FAERS for top 100-300 drugs, capturing signal detection and reporting rates.
- Easy: Compile top 10 adverse events by drug with report counts
- Hard: Create dataset with disproportionality scores, temporal trends, and serious outcome flags for Top 300 drugs

**Manufacturers/Labelers**
Create a comprehensive labeler database linking NDC labeler codes to company names, parent organizations, and manufacturing locations.
- Easy: Compile labeler code lookup with company names for 10 active labelers
- Hard: Build hierarchical dataset with parent company rollup, facility locations, and relationships for all US manufacturers of Top 300 drugs
- International: Publish relevant subsidiary info for 10 US drug manufacturers that also manufacturer and distrubte drugs internationally

**Availability/Shortages**
Build a drug shortage tracking dataset from FDA and ASHP databases with historical shortage timelines and resolution dates.
- Easy: Compile current shortages with affected NDCs for top 10 drugs
- Hard: Create historical shortage information with duration analysis, therapeutic alternatives, and supply impact metrics for 50+ shortage events

**Drug-Drug Interactions (DDI)**
Build a structured DDI dataset for top 300 drugs, capturing interaction severity, mechanism, and clinical guidance.
- Easy: Compile DDI pairs with severity ratings for 50 high-risk drugs
- Hard: Create comprehensive interaction corpus with PK/PD mechanisms, time-to-onset, and management recommendations for 500+ drug pairs

**Mechanism of Action / MeSH Classifications**
Map mechanisms of action for top 300 drugs to MeSH pharmacological action terms and target/receptor annotations.
- Easy: Create MoA reference table with MeSH terms for Top 100 drugs
- Hard: Build structured dataset linking drugs to molecular targets, pathways, and therapeutic classes for Top 300 drugs with evidence citations

**Contraindications**
Extract and structure contraindication data from FDA labels for top 300 drugs, linking to relevant conditions, drug classes, and patient populations.
- Easy: Compile contraindications list with label citations for top 20 drugs
- Hard: Build normalized dataset with MeSH-mapped conditions and severity grading for Top 300 drugs

**Indications (ICD-Mapped)**
Build a dataset mapping approved indications for top 300 drugs to ICD-10-CM diagnosis codes with FDA label citations.
- Easy: Create indication-to-ICD mappings for Top 20 drugs
- Hard: Build comprehensive dataset with primary/secondary indications for Top 300 drugs
- Hard: Map off label indications to top 300 drugs with standardized method of citing evidence to support off label prescribing
