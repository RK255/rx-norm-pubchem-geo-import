Geo Health Space — Canadian Drug Ontology
Types
Type	UUID
Canadian Generic Drug (CGD)	4db10155f8ff42ac8f0cc9f3a73a7b3f
Canadian Branded Drug (CBD)	b4ec40d4a58d4a7eb6438e749d313aac
DIN	d3562354d6d044d298d2eac2f4db91ff
Relations
Relation	UUID	Direction
Canadian Generic Drugs	d1ce9514f0444f3c8e88d867758afb60	IN/MIN/PIN → CGD
Canadian Branded Drugs	70ad75646de54413bac22df8183379d5	IN/MIN/PIN → CBD
DINs	333ca631ed2c408a95f1530e32d2cd5e	CGD/CBD → DIN
Ingredients (reused)	42f9691bb3334c058553ab74c5fa4016	CGD/CBD → IN
Multiple Ingredients (reused)	e8885ee2b8674952b2538ad4eee058e2	CGD/CBD → MIN
Precise Ingredients (reused)	5d5602ac0fe64f4dbdc345c0bdf09d72	CGD/CBD → PIN
Properties
Property	UUID	Notes
Name (reused)	a126ca530c8e48d5b88882c734c38935	All entities
Related RxCUI	88e887d0951240aa8eb2fb4a61d7d8bd	CGD/CBD — plain rxcui integer
Entity Hierarchy
Ingredient (IN) — extended

    New Relations: Canadian Generic Drugs (→ CGD), Canadian Branded Drugs (→ CBD)

Multiple Ingredient (MIN) — extended

    New Relations: Canadian Generic Drugs (→ CGD), Canadian Branded Drugs (→ CBD)

Precise Ingredient (PIN) — extended

    New Relations: Canadian Generic Drugs (→ CGD), Canadian Branded Drugs (→ CBD)

CanadianGenericDrug (CGD)

    Properties: Name, Related RxCUI
    Relations:
        → IN via Ingredients (when parent_tty = IN)
        → MIN via Multiple Ingredients (when parent_tty = MIN)
        → PIN via Precise Ingredients (when parent_tty = PIN)
        → DIN via DINs

CanadianBrandedDrug (CBD)

    Properties: Name, Related RxCUI
    Relations:
        → IN via Ingredients (when parent_tty = IN)
        → MIN via Multiple Ingredients (when parent_tty = MIN)
        → PIN via Precise Ingredients (when parent_tty = PIN)
        → DIN via DINs

DIN

    Properties: Name (= DIN number, e.g. "02230711")
    Relations: (none in v1 — pricing pass later)
