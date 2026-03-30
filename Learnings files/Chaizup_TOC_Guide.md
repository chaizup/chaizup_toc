# Detailed Over View

| CHAIZUP Premix Tea Manufacturing Theory of Constraints (TOC) Buffer Management — Complete Concept & Formula Guide |  |  |
| ----- | :---: | :---: |
| **30–45%** Less Inventory | **97%+** Fill Rate | **Zero** Forecasting Needed |

 

|  | SECTION —    Contents |
| :---- | :---- |

| \# | Section Title | Page |
| :---: | :---- | :---: |
| **1** | What Is TOC — The Big Idea | 3 |
| **2** | Complete Jargon Glossary — Every Term Explained | 4 |
| **3** | Buffer Zones — Two Ways to Measure (SR% vs BP%) | 6 |
| **4** | Chaizup's Three-Layer Buffer Architecture | 8 |
| **5** | All TOC Formulas — Step by Step | 9 |
| **6** | Production Decision — What to Produce First | 12 |
| **7** | Procurement Decision — What to Buy and When | 13 |
| **8** | Dynamic Buffer Management (DBM) | 15 |
| **9** | Daily Operating Rhythm | 17 |
| **10** | TOC versus Traditional MRP | 18 |
| **11** | Quick Reference Card | 19 |

|  | SECTION 1    What Is TOC — The Big Idea |
| :---- | :---- |

Theory of Constraints (TOC) is a management philosophy created by Dr. Eliyahu M. Goldratt, first published in his famous business novel The Goal (1984). It is used by thousands of manufacturers worldwide.

| 💡  One-Line Definition Every system has ONE single bottleneck that limits total output.  Find it.  Fix it.  Then find the next one.  Everything else is secondary. |
| :---- |

**1.1  How TOC Applies to Chaizup**

Every day the Chaizup team must answer two questions:

1. What finished goods (Masala Tea, Ginger Tea, Cardamom Tea — various pack sizes) should we PRODUCE today, and in what order?

2. What raw materials and packaging materials should we PURCHASE today, and how much?

Traditional companies use FORECASTS — predict next month's sales, plan backwards. In FMCG, forecasts are wrong 30–40% of the time. The result: Masala Tea 200g is stocked out while Lemon Tea has 4 months of excess stock with shelf-life ticking away.

| ✅  TOC Solution Abandon forecasting for production and procurement decisions. Use Buffer Management instead. Watch what is actually consumed today and replenish exactly that. No forecasting required. |
| :---- |

**1.2  The Five Focusing Steps**

| Step | Name | What It Means | Chaizup Application |
| :---: | :---- | :---- | :---- |
| **1** | **IDENTIFY** | Find the ONE resource that caps total output | The VFFS pouch-filling machine limits how many pouches Chaizup can make per day. |
| **2** | **EXPLOIT** | Get maximum output — never let it idle | Never run out of premix blend. Always run the highest-priority SKU first. |
| **3** | **SUBORDINATE** | All other processes serve the constraint | Blending exists to keep the VFFS fed. Procurement exists to keep blending fed. |
| **4** | **ELEVATE** | If still insufficient, invest to increase capacity | Add a second VFFS line or reduce changeover time — only after Steps 2–3 are maxed. |
| **5** | **REPEAT** | Once fixed, find the next constraint | After VFFS is solved, the next bottleneck (e.g. QC lab) becomes the new focus. |

| 🔩  What is VFFS? Vertical Form Fill Seal — Chaizup's packaging machine. Vertical (film travels downward), Form (shapes flat film into a pouch), Fill (deposits premix tea powder by auger filler), Seal (heat-seals pouch closed). Runs at \~35 pouches/minute. Every idle minute costs Chaizup money. |
| :---- |

|  | SECTION 2    Complete Jargon Glossary — Every Term Explained |
| :---- | :---- |

Every technical term used in TOC Buffer Management is explained in plain English, with a Chaizup example. Read this once and every formula will make sense.

| Code | Full Name | Plain English Meaning | Chaizup Context & Example |
| :---- | :---- | :---- | :---- |
| **TOC** | **Theory of Constraints** | Find and fix your ONE biggest bottleneck first | Chaizup's bottleneck is the VFFS pouch-filling line. Everything else serves it. |
| **Buffer** | **Safety Stock Cushion** | A planned stock cushion held so you never run out | Chaizup holds 900 units of Masala Tea 1kg as a safety net so distributors never wait. |
| **BP%** | **Buffer Penetration %** | How EMPTY the buffer is. Higher \= more urgent. 0% \= full. 100% \= stockout. | Formula: (Target − IP) ÷ Target × 100\. IP=200, Target=900 → BP%=77.8% → Red Zone. |
| **SR%** | **Stock Remaining %** | How FULL the buffer is. 100% \= full. 0% \= stockout. SR% \+ BP% always \= 100%. | Formula: IP ÷ Target × 100\. IP=200, Target=900 → SR%=22.2% → Red Zone (same conclusion). |
| **FG** | **Finished Goods** | Packed, labelled, QC-passed products ready to ship | Masala Tea 200g/500g/1kg, Ginger Tea 500g, Cardamom Tea 200g — sealed and ready. |
| **SFG** | **Semi-Finished Goods** | Blended premix powder QC-passed but NOT yet packed | Masala Premix Blend in bulk bins — can be packed into any SKU size as needed. |
| **RM** | **Raw Material** | Ingredients used in the premix blend | Tea dust (CTC), sugar, milk powder, cardamom powder, ginger powder. |
| **PM** | **Packaging Material** | Materials that wrap, seal, and box the final product | Printed pouches (200g, 500g, 1kg), corrugated cartons, labels, shrink wrap. |
| **ADU** | **Avg. Daily Usage** | Rolling 90-day average of daily consumption | Masala Tea 1kg: Chaizup ships 200 units/day on average → ADU \= 200\. |
| **RLT** | **Replenishment Lead Time** | Total time from 'we need more' until stock is on the shelf | FG: Blend+Pack+QC+Move \= 3 days. Tea Dust: PO to receipt \= 10 days. |
| **VF** | **Variability Factor** | Safety multiplier — higher unpredictability \= higher VF | Sugar (reliable local supplier) \= 1.3.  Cardamom Powder (seasonal, volatile) \= 1.7. |
| **IP** | **Inventory Position** | TRUE stock: On-Hand \+ WIP − Backorders (FG) or On-Hand \+ On-Order − Committed (RM) | Includes what is being made. Excludes what is already promised to customers. |
| **WIP** | **Work In Progress** | Items being manufactured right now, not yet on shelf | Premix currently being filled on the VFFS — counts toward available supply. |
| **Backorder** | **Promised But Not Shipped** | Distributor orders confirmed but not yet dispatched | 30 units of Masala Tea 1kg committed to a distributor order — deduct from usable stock. |
| **Constraint** | **Bottleneck** | The ONE resource that caps total output of the whole system | At Chaizup: the VFFS pouch-filling machine. |
| **T** | **Throughput** | Selling Price minus ONLY truly variable costs (RM \+ PM only) | Masala Tea 1kg: ₹380 − ₹172 (RM+PM) \= ₹208 throughput per unit. |
| **T/CU** | **Throughput per Constraint Unit** | Rupees earned per minute of VFFS line time — used as tie-breaker | Masala Tea 1kg \= ₹6,303/min. Cardamom Tea 200g \= ₹1,960/min. |
| **DBM** | **Dynamic Buffer Management** | Automatic self-correction: buffers grow or shrink based on real behaviour | If Masala Tea 1kg keeps hitting Red, DBM increases buffer by 33% automatically. |
| **TMR** | **Too Much Red** | Buffer is too small — stockouts keep happening | Stock in Red \> 20% of RLT in one cycle → increase buffer by 33%. |
| **TMG** | **Too Much Green** | Buffer is too large — cash is locked up unnecessarily | Stock in Green for 3 full replenishment cycles → decrease buffer by 33%. |
| **DAF** | **Demand Adjustment Factor** | Planned multiplier for predictable events — festivals, promotions, seasons | Diwali \= 1.6× (buffer \+60%). Summer slowdown \= 0.7× (buffer −30%). |
| **OTIF** | **On Time In Full** | % of supplier deliveries that arrived on time AND in the correct quantity | Supplier OTIF 65% means 35% of deliveries failed — increase that supplier's VF. |
| **OEE** | **Overall Equipment Effectiveness** | How efficiently your VFFS runs vs its theoretical maximum speed | VFFS rated 50 pouches/min but averages 35 → OEE \= 70%. |
| **PO** | **Purchase Order** | Formal document sent to a supplier to order a specific quantity | Chaizup sends a PO to its tea dust supplier for 4,900 kg delivery by a target date. |

|  | SECTION 3    Buffer Zones — Two Ways to Measure the Same Thing |
| :---- | :---- |

This is the section that causes the most confusion. The TOC system can express buffer health in two different ways — and they give DIFFERENT numbers for the exact same situation. Both are correct. They measure from OPPOSITE ends, like calling a glass 'half full' versus 'half empty'.

| ⚠️  Key Insight — Read First Method A (Stock Remaining %):  Asks 'How FULL is the buffer?'  →  High number \= safe.  Low number \= danger.Method B (Buffer Penetration %):  Asks 'How EMPTY is the buffer?'  →  Low number \= safe.  High number \= danger.They always add up to 100%.   SR%  \+  BP%  \=  100%  (always, without exception). |
| :---- |

**3.1  Method A — Stock Remaining % (SR%)**

Measures how much stock is STILL LEFT. Think of a petrol gauge — the number shows what % of the tank is still full.

| Stock Remaining %  (SR%)  \=  Inventory Position  ÷  Target Buffer  ×  100 *100% \= tank completely full (safe)   |   0% \= tank completely empty (stockout)* |
| :---- |

| Zone | SR% Range | What It Means | Action Required |
| :---- | :---- | :---- | :---- |
| **🟢  GREEN** | **66%–100% full** | More than 2/3 of the buffer remains. No stockout risk. | **Do NOTHING. Buffer is healthy. Focus on Red/Yellow items.** |
| **🟡  YELLOW** | **33%–66% full** | Buffer half consumed. Normal operating range. | Plan replenishment. Issue standard Work Order or PO. |
| **🔴  RED** | **0%–33% full** | Critically low. Less than 1/3 remains. Stockout is near. | **URGENT. Produce or order IMMEDIATELY. Expedite.** |
| **⚫  BLACK** | **0% — Stockout** | Zero stock. Production or delivery halted completely. | **EMERGENCY. Alternate suppliers. Escalate to Plant Manager.** |

| 📌  SR% Example — Masala Tea 1kg Target Buffer \= 900 units.   Inventory Position \= 200 units.SR%  \=  200 ÷ 900 × 100  \=  22.2%22.2% is in the RED ZONE (0%–33% full)  →  Only 22% of the tank is left  →  PRODUCE NOW |
| :---- |

**3.2  Method B — Buffer Penetration % (BP%)**

Measures how much stock has been CONSUMED from the buffer. The higher the number, the more urgently you must act. This is the method used in the daily dashboard because it makes sorting easy — sort all SKUs by BP% from highest to lowest, and the most critical item is always at the top.

| Buffer Penetration %  (BP%)  \=  (Target Buffer  −  Inventory Position)  ÷  Target Buffer  ×  100 *0% \= nothing consumed — completely full (safest)   |   100% \= completely consumed — stockout* |
| :---- |

| Zone | BP% Range | What It Means | Action Required |
| :---- | :---- | :---- | :---- |
| **🟢  GREEN** | **0%–33% consumed** | Very little consumed. Buffer mostly intact. Safe. | **Do NOTHING. Do not produce or order yet.** |
| **🟡  YELLOW** | **33%–66% consumed** | Half consumed. Normal operating range. | Issue standard Work Order or PO at normal priority. |
| **🔴  RED** | **67%–100% consumed** | Mostly consumed. Tiny cushion left. Stockout is near. | **URGENT. Produce or order IMMEDIATELY. Expedite.** |
| **⚫  BLACK** | **100%+ consumed** | Completely consumed. Stockout. Everything halted. | **EMERGENCY. Alternate suppliers. Escalate immediately.** |

| 📌  BP% Example — Masala Tea 1kg Target Buffer \= 900 units.   Inventory Position \= 200 units.BP%  \=  (900 − 200\) ÷ 900 × 100  \=  700 ÷ 900 × 100  \=  77.8%77.8% is in the RED ZONE (67%–100% consumed)  →  Most of the buffer is gone  →  PRODUCE NOW |
| :---- |

**3.3  Direct Comparison — Same Situation, Both Methods**

The table below shows the same Masala Tea 1kg scenario calculated using both methods. The zone conclusion is always identical — only the numbers and direction differ.

|  | Method A — Stock Remaining % (SR%) | Method B — Buffer Penetration % (BP%) |
| :---- | ----- | :---- |
| **Question asked** | How FULL is the buffer? | How EMPTY is the buffer? |
| **Formula** | IP ÷ Target × 100 | (Target − IP) ÷ Target × 100 |
| **Calculation** | 200 ÷ 900 × 100 | (900 − 200\) ÷ 900 × 100 |
| **Result** | **22.2%** | **77.8%** |
| **Zone** | **🔴 RED   (0%–33% \= critically low)** | **🔴 RED   (67%–100% \= critically consumed)** |
| **Conclusion** | Only 22% of the tank is left → PRODUCE NOW | 77.8% of the buffer is gone → PRODUCE NOW |
| **Always true** | **SR%  \+  BP%  \=  100%  always    |    22.2% \+ 77.8% \= 100% ✓** |  |

**3.4  Quick Lookup — All Scenarios**

| Scenario | Target | IP | SR%  (How full?) | BP%  (How empty?) |
| :---- | ----- | ----- | :---- | :---- |
| Just refilled | 900 | 870 | **96.7% 🟢 GREEN** | **3.3% 🟢 GREEN** |
| Healthy stock | 900 | 700 | **77.8% 🟢 GREEN** | **22.2% 🟢 GREEN** |
| Upper Yellow | 900 | 600 | **66.7% 🟡 YELLOW** | **33.3% 🟡 YELLOW** |
| Mid Yellow | 900 | 450 | **50.0% 🟡 YELLOW** | **50.0% 🟡 YELLOW** |
| Lower Yellow | 900 | 310 | **34.4% 🟡 YELLOW** | **65.6% 🟡 YELLOW** |
| RED — urgent | 900 | 200 | **22.2% 🔴 RED** | **77.8% 🔴 RED** |
| Deep RED | 900 | 80 | **8.9% 🔴 RED** | **91.1% 🔴 RED** |
| Stockout | 900 | 0 | **0% ⚫ BLACK** | **100% ⚫ BLACK** |

| 🧠  Which Method Should You Use? Both are valid. The daily dashboard uses BP% because the SKU with the HIGHEST BP% is always the most urgent — easy to sort. When explaining zones to shop floor staff, SR% is more intuitive: 'only 22% left in the tank' is easier to visualise than 'consumed 77.8%'. Know both. |
| :---- |

|  | SECTION 4    Chaizup's Three-Layer Buffer Architecture |
| :---- | :---- |

TOC places strategic stock buffers at three key points in the Chaizup supply chain. Each layer absorbs a different type of variability.

| Layer | Buffer Type | Items Held | Purpose | Replenish |
| ----- | :---- | :---- | :---- | ----- |
| **3** | **Raw & Packaging Materials** | Tea dust, sugar, milk powder, cardamom, ginger, printed pouches, cartons | Protect against SUPPLIER delays and variability | **5–18 days** |
| **2** | **Semi-Finished Goods (SFG)** | Masala / Ginger / Cardamom premix blends — QC-passed, in bulk bins, not yet packed | Decouple blending from packaging. Compress FG lead time from 3 days to 1.5 days. | **1.5 days** |
| **1** | **Finished Goods (FG)** | Masala Tea 200g/500g/1kg, Ginger Tea 500g, Cardamom Tea 200g — packed, sealed, QC-passed | Protect against DEMAND variability. Prevent distributor stockouts. | **1–3 days** |

| ⚙️  Why Have an SFG Buffer? Without it, producing Masala Tea 200g from scratch takes 3 days (blend \+ pack \+ QC \+ move). With a pre-stocked SFG buffer, the VFFS line just pulls from the premix bin — lead time drops to 1.5 days. Shorter lead time \= smaller required FG buffer \= less cash tied up in inventory. The SFG buffer also gives packaging flexibility: the same Masala Premix Blend can be packed into 200g, 500g, or 1kg pouches depending on which SKU needs replenishing most urgently. |
| :---- |

|  | SECTION 5    All TOC Formulas — Step by Step |
| :---- | :---- |

**Formula 1 — Target Buffer Sizing**

How big should the buffer be? This foundational formula tells you the maximum stock to hold for each product or material.

| Target Buffer  \=  ADU  ×  RLT  ×  VF *ADU \= Average Daily Usage  |  RLT \= Replenishment Lead Time  |  VF \= Variability Factor* |
| :---- |

| Input | Example | How to Find It for Chaizup |
| :---- | :---- | :---- |
| **ADU** | 200 units/day | Export last 90 days dispatch orders from ERP. Sum total units shipped. Divide by 90\. Review monthly. |
| **RLT** | 3d (FG)  /  10d (Tea Dust)  /  18d (Pouches) | FG: Blending \+ Packaging \+ QC \+ Transfer. RM: PO date to GRN date, averaged over last 10 orders. |
| **VF** | 1.3 (stable) → 1.8 (volatile) | Based on demand variability (CV) and supplier reliability (OTIF%). Higher unpredictability \= higher VF. |

| 📌  Worked Example — Masala Tea 1kg ADU \= 200 units/day   |   RLT \= 3 days   |   VF \= 1.5Target Buffer  \=  200 × 3 × 1.5  \=  900 units→ Green Zone: above 594 units (900 × 66%)   → Yellow Zone: 297–594 units   → Red Zone: below 297 units |
| :---- |

**Full FG Buffer Sizing Table — All Chaizup SKUs**

| Code | SKU | ADU | RLT | VF | Target | 🔴 Red  \<33% | 🟡 Yellow 33–66% | 🟢 Green \>66% |
| :---- | :---- | ----- | ----- | ----- | ----- | :---- | :---- | :---- |
| **FG-001** | **Masala Tea 1kg** | 200 | 3d | **1.5** | **900** | 0–297 | 297–594 | 594–900 |
| **FG-002** | **Masala Tea 500g** | 350 | 3d | **1.5** | **1,575** | 0–520 | 520–1,040 | 1,040–1,575 |
| **FG-003** | **Masala Tea 200g** | 500 | 3d | **1.5** | **2,250** | 0–743 | 743–1,485 | 1,485–2,250 |
| **FG-004** | **Ginger Tea 500g** | 180 | 3d | **1.5** | **810** | 0–267 | 267–535 | 535–810 |
| **FG-005** | **Cardamom Tea 200g** | 280 | 3d | **1.5** | **1,260** | 0–416 | 416–832 | 832–1,260 |

**Formula 2 — Inventory Position (IP)**

Your TRUE stock level — not just what is on the shelf, but everything that counts toward filling demand.

**For Finished Goods (FG):**

| IP (FG)  \=  On-Hand Stock  \+  WIP  −  Backorders *On-Hand \= QC-released in warehouse.  WIP \= on the VFFS line right now.  Backorders \= confirmed distributor orders awaiting dispatch.* |
| :---- |

| 📌  Worked Example — Masala Tea 1kg On-Hand \= 180 units   |   WIP \= 50 units   |   Backorders \= 30 unitsIP  \=  180 \+ 50 − 30  \=  200 units |
| :---- |

**For Raw & Packaging Materials (RM/PM):**

| IP (RM/PM)  \=  On-Hand Stock  \+  On-Order  −  Committed *On-Hand \= QC-cleared in RM warehouse.  On-Order \= open POs in transit.  Committed \= allocated to released work orders.* |
| :---- |

| 📌  Worked Example — Tea Dust (CTC) On-Hand \= 1,800 kg   |   On-Order \= 2,000 kg (en route)   |   Committed \= 1,500 kg (allocated to work orders)IP  \=  1,800 \+ 2,000 − 1,500  \=  2,300 kgIf you only looked at On-Hand (1,800 kg) you might panic and over-order. The true IP of 2,300 kg shows you are fine. |
| :---- |

**Formula 3 — Buffer Penetration % (BP%)**

THE most important number in the system. Drives every production and procurement decision. Sort all items by BP% from highest to lowest — the most critical is always at the top.

| BP%  \=  (Target Buffer  −  Inventory Position)  ÷  Target Buffer  ×  100 *0% \= completely full (safest)   |   100% \= completely empty (stockout)   |   Higher BP% \= more urgent \= act first* |
| :---- |

| SKU | Target  |  IP | BP% Calculation | BP% | Zone |
| :---- | ----- | :---- | ----- | :---- |
| **Cardamom Tea 200g** | 1,260  |  150 | (1260−150)÷1260×100 | **88.1%** | **🔴 RED** |
| **Masala Tea 1kg** | 900  |  200 | (900−200)÷900×100 | **77.8%** | **🔴 RED** |
| **Ginger Tea 500g** | 810  |  360 | (810−360)÷810×100 | **55.6%** | **🟡 YELLOW** |
| **Masala Tea 500g** | 1,575  |  950 | (1575−950)÷1575×100 | **39.7%** | **🟡 YELLOW** |
| **Masala Tea 200g** | 2,250  |  1,900 | (2250−1900)÷2250×100 | **15.6%** | **🟢 GREEN** |

**Formula 4 — Replenishment Quantity**

| Order Qty  \=  Target Buffer  −  Inventory Position *Restores the buffer exactly back to 100%. Never over-produce or under-order.* |
| :---- |

| 📌  Worked Examples Masala Tea 1kg (Red, 77.8%):       900 − 200   \= 700 units   → run VFFS for 700 unitsCardamom Tea 200g (Red, 88.1%):  1,260 − 150 \= 1,110 units  → most urgent, run firstTea Dust (Red):                           7,200 − 2,300 \= 4,900 kg   → call supplier now |
| :---- |

**Formula 5 — Throughput per Constraint Unit (T/CU)  — Tie-Breaker Only**

Used ONLY when two SKUs have the same BP%. Which earns Chaizup more money per minute of VFFS time?

| T  \=  Selling Price  −  RM Cost  −  PM Cost *Do NOT subtract labour, electricity, rent, or machine costs — these are fixed regardless of what you produce.* |
| :---- |

| T/CU  \=  Throughput (T)  ÷  Constraint Minutes per Unit *Higher T/CU \= earns more per VFFS minute \= runs first when BP% is tied.* |
| :---- |

| SKU | Price | RM+PM | Throughput | min/unit | T/CU (₹/min) | Rank |
| :---- | ----- | ----- | ----- | ----- | ----- | ----- |
| **Masala Tea 1kg** | ₹380 | ₹172 | **₹208** | 0.033 | **₹6,303** | \#1 |
| **Masala Tea 500g** | ₹210 | ₹89 | **₹121** | 0.025 | **₹4,840** | \#2 |
| **Ginger Tea 500g** | ₹195 | ₹81 | **₹114** | 0.025 | **₹4,560** | \#3 |
| **Masala Tea 200g** | ₹95 | ₹41 | **₹54** | 0.022 | **₹2,454** | \#4 |
| **Cardamom Tea 200g** | ₹90 | ₹41 | **₹49** | 0.025 | **₹1,960** | \#5 |

| ⚠️  BP% Always Wins Over T/CU BP% is the PRIMARY sort. T/CU is ONLY a tie-breaker. Cardamom Tea 200g has the lowest T/CU (₹1,960/min) but if its BP% is 88.1% versus Masala Tea 1kg at 77.8%, Cardamom Tea 200g still runs first on the VFFS because its buffer is more depleted. |
| :---- |

**Formula 6 — RM/PM Purchase Quantity**

| RM IP  \=  On-Hand  \+  On-Order  −  Committed     |     PO Qty  \=  Target Buffer  −  RM IP *Same logic as FG. The only difference: you raise a Purchase Order to a supplier instead of a Production Work Order.* |
| :---- |

| 📌  Worked Example — Cardamom Powder (Most Urgent RM) On-Hand \= 80 kg   |   On-Order \= 0 kg   |   Committed \= 60 kgRM IP  \=  80 \+ 0 − 60  \=  20 kgTarget Buffer  \=  35 ADU × 14 days × 1.7 VF  \=  833 kgBP%  \=  (833 − 20\) ÷ 833 × 100  \=  97.6%  →  DEEP REDPO Qty  \=  833 − 20  \=  813 kg  →  ORDER BY AIR FREIGHT TODAY |
| :---- |

|  | SECTION 6    Production Decision — What to Produce First |
| :---- | :---- |

Every morning at 7:00 AM the IT system generates the Production Priority Board. The supervisor runs the VFFS line in this sequence. No guesswork, no politics — just buffer penetration data.

**6.1  The 5-Step Daily Sequence**

3. Step 1:  Update IP for every FG SKU  →  On-Hand \+ WIP − Backorders

4. Step 2:  Calculate BP% for every SKU  →  (Target − IP) ÷ Target × 100

5. Step 3:  Sort all SKUs from HIGHEST BP% to LOWEST

6. Step 4:  If two SKUs tie on BP%, use T/CU as tie-breaker (higher T/CU runs first)

7. Step 5:  Calculate Order Qty for each Red/Yellow item  →  Target − IP

**6.2  Today's Production Priority Board — March 3**

| Rank | Code | SKU | Target | On-Hand | WIP | Backord. | IP | BP% | Action |
| ----- | :---- | :---- | ----- | ----- | ----- | ----- | ----- | ----- | :---- |
| **1** | FG-005 | **Cardamom Tea 200g** | 1,260 | 120 | 80 | 50 | **150** | **88.1%** | **🔴 PRODUCE NOW** |
| **2** | FG-001 | **Masala Tea 1kg** | 900 | 180 | 50 | 30 | **200** | **77.8%** | **🔴 PRODUCE NOW** |
| **3** | FG-004 | **Ginger Tea 500g** | 810 | 280 | 100 | 20 | **360** | **55.6%** | 🟡 This week |
| **4** | FG-002 | **Masala Tea 500g** | 1,575 | 800 | 200 | 50 | **950** | **39.7%** | 🟡 This week |
| **5** | FG-003 | **Masala Tea 200g** | 2,250 | 1,600 | 300 | 0 | **1,900** | **15.6%** | 🟢 Wait |

| 📌  Reading This Board Cardamom Tea 200g at 88.1% BP% is most depleted — run it FIRST on the VFFS line today. Masala Tea 200g at 15.6% is comfortably Green — it may not be produced today at all and that is completely fine. The buffer exists to cover these planned gaps. |
| :---- |

**6.3  VFFS Daily Capacity**

| Factor | Value | Note |
| :---- | ----- | :---- |
| **Total shift time** | **480 minutes** | 8-hour production shift |
| **SKU changeovers (3 today)** | **135 minutes** | 3 changeovers × 45 min each (film roll change, cleaning, calibration) |
| **Net production time** | **345 minutes** | 480 − 135 \= 345 minutes available for actual pouch filling |
| **VFFS effective speed** | **35 pouches/min** | After accounting for micro-stops at OEE \~70% |
| **Total daily capacity** | **\~12,075 pouches** | 345 × 35 — before adjusting for differences in pack sizes |

|  | SECTION 7    Procurement Decision — What to Buy and When |
| :---- | :---- |

At 7:30 AM the same system generates the Procurement Action List. The purchasing manager acts on this — no spreadsheets, no guesswork.

**7.1  RM and PM Buffer Sizing Table**

| Code | Material | ADU | RLT | VF | Target | 🔴 Red \<33% | 🟡 Yellow 33–66% | 🟢 Green \>66% |
| :---- | :---- | ----- | ----- | ----- | ----- | :---- | :---- | :---- |
| **RM-001** | **Tea Dust (CTC)** | 450 kg | 10d | **1.6** | **7,200 kg** | 0–2,376 | 2,376–4,752 | 4,752+ |
| **RM-002** | **Sugar** | 1,500 kg | 5d | **1.3** | **9,750 kg** | 0–3,218 | 3,218–6,435 | 6,435+ |
| **RM-003** | **Milk Powder** | 750 kg | 10d | **1.5** | **11,250 kg** | 0–3,713 | 3,713–7,425 | 7,425+ |
| **RM-004** | **Cardamom Powder** | 35 kg | 14d | **1.7** | **833 kg** | 0–275 | 275–550 | 550+ |
| **RM-005** | **Ginger Powder** | 50 kg | 10d | **1.4** | **700 kg** | 0–231 | 231–462 | 462+ |
| **PM-001** | **200g Pouches** | 800 u | 18d | **1.5** | **21,600 u** | 0–7,128 | 7,128–14,256 | 14,256+ |
| **PM-002** | **500g Pouches** | 530 u | 18d | **1.5** | **14,310 u** | 0–4,722 | 4,722–9,445 | 9,445+ |
| **PM-003** | **1kg Pouches** | 200 u | 18d | **1.5** | **5,400 u** | 0–1,782 | 1,782–3,564 | 3,564+ |
| **PM-004** | **Cartons** | 600 u | 12d | **1.3** | **9,360 u** | 0–3,089 | 3,089–6,178 | 6,178+ |

**7.2  Today's Procurement Action List — March 3**

| Material | Target | On-Hand | On-Order | Committed | IP | BP% | Zone | Action |
| :---- | ----- | ----- | ----- | ----- | ----- | ----- | :---- | :---- |
| **Cardamom Powder** | 833 kg | 80 kg | 0 kg | 60 kg | **20 kg** | **97.6%** | **🔴 RED** | **ORDER \+ AIR FREIGHT** |
| **Tea Dust (CTC)** | 7,200 kg | 1,800 kg | 2,000 kg | 1,500 kg | **2,300 kg** | **68.1%** | **🔴 RED** | **Expedite \+ New PO** |
| **Milk Powder** | 11,250 kg | 4,500 kg | 3,000 kg | 1,200 kg | **6,300 kg** | **44.0%** | **🟡 YELLOW** | Standard PO |
| **200g Pouches** | 21,600 u | 9,000 u | 8,000 u | 3,500 u | **13,500 u** | **37.5%** | **🟡 YELLOW** | Standard PO |
| **Sugar** | 9,750 kg | 6,000 kg | 3,000 kg | 1,200 kg | **7,800 kg** | **20.0%** | **🟢 GREEN** | No action |

**7.3  Procurement Decision Rules by Zone**

| Zone | BP% Range | Action Required |
| :---- | :---- | :---- |
| **🟢  GREEN** | **0–33%** | No action. Adequate stock. Do NOT place a new order. Avoid over-stocking — it wastes cash and hides true demand. |
| **🟡  YELLOW** | **33–66%** | Place a normal replenishment PO. Quantity \= Target Buffer − RM IP. Standard freight terms. No expediting. |
| **🔴  RED** | **67–100%** | Expedite open POs — call supplier directly. Place emergency PO if none exists. Authorise premium freight. Flag in daily review. |
| **⚫  BLACK** | **100%+** | Emergency procurement. Contact alternate suppliers immediately. Production at risk — escalate to Plant Manager. |

|  | SECTION 8    Dynamic Buffer Management (DBM) |
| :---- | :---- |

Buffers set on day one will eventually become wrong. DBM automatically adjusts buffer sizes based on real observed behaviour — not forecasts or assumptions.

**8.1  The Two DBM Triggers**

| Condition | Monitor Window | Trigger | Action | New Formula |
| :---- | :---- | :---- | :---- | :---- |
| **🔴 Too Much Red (TMR)** | 1 replenishment cycle | On-hand in Red \> 20% of RLT | **INCREASE by 33%** | **Target × 1.33** |
| **🟢 Too Much Green (TMG)** | 3 replenishment cycles | On-hand in Green for all 3 full cycles | **DECREASE by 33%** | **Target × 0.67** |

**8.2  DBM Examples for Chaizup**

| 📌  TMR ( Too Much Red ) Example — Masala Tea 1kg Current Buffer \= 900 units.  RLT \= 3 days.  TMR threshold \= 3 × 20% \= 0.6 days in Red.In the last cycle, stock spent 1.2 days in Red (\> 0.6) → TMR triggered.New Buffer \= 900 × 1.33 \= 1,197 units  (rounded to 1,200 units) |
| :---- |

| 📌  TMG Example ( Too Much Green ) — Sugar Current Buffer \= 9,750 kg.  RLT \= 5 days.  Sugar stayed above Green threshold for 15+ consecutive days (3 complete cycles).New Buffer \= 9,750 × 0.67 \= 6,533 kg  (rounded to 6,500 kg)  →  Frees up working capital |
| :---- |

| 🧠  Why Is DBM Asymmetric? Increasing buffers triggers faster (just 20% of RLT in Red) than decreasing (3 full cycles in Green). The cost of a stockout — lost sales, angry distributors, emergency freight — almost always exceeds the cost of a bit of extra inventory. DBM is deliberately biased toward protection. |
| :---- |

**8.3  Demand Adjustment Factors (DAF) — Planned Seasonal Events**

For predictable events, the planning team sets a DAF multiplier at the monthly S\&OP meeting. This temporarily adjusts the buffer without overriding automatic DBM logic.

| Adjusted Buffer  \=  Current Target Buffer  ×  DAF *Applied manually by the Planning team before the event window begins.* |
| :---- |

| Event | DAF | Period | Effect on Masala Tea 1kg (base \= 900 units) |
| :---- | ----- | :---- | :---- |
| **Diwali Festival Season** | **1.6×** | Oct 15 – Nov 15 | 900 × 1.6 \= 1,440 units  →  Gifting and retail demand surges. |
| **Summer Slowdown** | **0.7×** | Apr 1 – Jun 30 | 900 × 0.7 \= 630 units  →  Hot-beverage demand dips. Frees cash. |
| **Trade Channel Promotion** | **1.8×** | Any 2-week window | 900 × 1.8 \= 1,620 units  →  Promotional offtake \~80% higher. |
| **Year-End Distributor Stocking** | **1.3×** | Nov 15 – Dec 31 | 900 × 1.3 \= 1,170 units  →  Distributors stock up for targets. |
| **Normal Operations** | **1.0×** | All other periods | 900 units  →  Baseline buffer. No adjustment applied. |

|  | SECTION 9    Daily Operating Rhythm |
| :---- | :---- |

TOC Buffer Management is a daily ritual, not a monthly planning exercise. The IT system must support this rhythm every single day.

| Time | Who | Activity | Action Required |
| ----- | :---- | :---- | :---- |
| **7:00 AM** | **Production Supervisor** | Review Production Priority List | Run VFFS on highest BP% SKU first. Assign blending team to replenish depleted SFG buffers. |
| **7:30 AM** | **Purchasing Manager** | Review Procurement Action List | Place POs for Yellow/Red RM/PM. Call suppliers for Red items. Expedite open Red POs. |
| **Real-time** | **IT System** | Live inventory updates | Every sale/shipment updates FG buffers. Every GRN updates RM position instantly. |
| **5:00 PM** | **Plant Manager** | Review Constraint Utilisation | Effective VFFS minutes? Changeovers? Downtime? Were Red SKUs produced today? |
| **Weekly** | **Supply Chain Manager** | Dynamic Buffer Review | Check DBM scores. Apply increases for TMR. Reduce for TMG. Confirm DAF for upcoming events. |

|  | SECTION 10    TOC versus Traditional MRP — What Changes |
| :---- | :---- |

| Dimension | ❌  Traditional MRP — Old Way | ✅  TOC Buffer Management — Chaizup Way |
| :---- | ----- | ----- |
| **What drives production?** | Forecast: guess next month's sales. PUSH orders. | Buffer Penetration %: produce what was actually consumed today. |
| **Planning approach** | PUSH — make products based on prediction. | PULL — make only when actual consumption depletes the buffer. |
| **Batch sizing** | Large batches (EOQ) to minimise unit cost. | Small, frequent batches. Replenish only what was sold. |
| **Safety stock** | Fixed static quantity. Set once, rarely reviewed. | Dynamic 3-zone buffer, auto-resized by DBM based on real behaviour. |
| **Priority system** | Due-date based: oldest order runs first. | BP% based: most endangered buffer runs first. |
| **Forecast accuracy** | 60–70% at SKU level. Wrong 1 in 3 times. | No forecast needed. React to what actually happened today. |
| **Inventory outcome** | Bimodal trap: too much wrong SKUs \+ stockouts of fast movers. | Right-sized buffers. 30–45% less inventory. 97%+ service levels. |
| **System behaviour** | Nervous — plans change with every forecast update. | Stable — managers act only on Red zone items by exception. |

| 💡  Key Insight for the IT Team TOC does not replace your ERP system. It replaces the PLANNING LOGIC sitting on top of ERP. Your ERP still manages inventory records, purchase orders, and bills of materials. TOC replaces the monthly forecasting spreadsheets and gut-feel decisions with a mathematically driven, colour-coded daily priority engine. |
| :---- |

|  | SECTION 11    Quick Reference Card |
| :---- | :---- |

*All formulas, both measurement methods, and all zone actions on one page. Print and keep at your workstation.*

**All Formulas at a Glance**

| F1 — Target Buffer  \=  ADU (Avg. Daily Usage)  ×  RLT (Replenishment Lead Time)  ×  VF (Variability Factor) *Size of your safety cushion.* |
| :---- |

| F2a — IP (FG Inventory Position)  \=  On-Hand  \+  WIP  −  Backorders *True finished goods inventory.* |
| :---- |

| F2b — IP (RM/PM Inventory Position)  \=  On-Hand  \+  On-Order (PO)  −  Committed (Will be Used on Production) *True raw/packaging material inventory.* |
| :---- |

| F3  — BP% (Buffer Penetration %)  \=  (Target Buffer − IP)  ÷  Target Buffer ×  100 *How EMPTY is the buffer? 0%=full, 100%=stockout. Sort highest first — most urgent at top.* |
| :---- |

| F3 alt — SR% (Stock Remaining %) \=  IP  ÷  Target Buffer  ×  100 *How FULL is the buffer? 100%=full, 0%=stockout.   SR% \+ BP% \= 100% always.* |
| :---- |

| F4  — Order Qty  \=  Target Buffer  −  IP *Exactly how much to produce or purchase to refill the buffer.* |
| :---- |

| F5  — T/CU  \=  (Price − RM − PM)  ÷  Constraint Minutes *Tie-breaker only: higher T/CU runs first when BP% is equal.* |
| :---- |

**Zone Summary — Both Methods Side by Side**

| Zone | BP%(How empty?) | SR%(How full?) | Meaning | FG Action | RM Action |
| :---- | :---: | :---: | :---- | :---- | :---- |
| **🟢 GREEN** | **0–33%** | **66–100%** | Mostly full. Safe. | **Do NOT produce** | **Do NOT order** |
| **🟡 YELLOW** | **33–66%** | **33–66%** | Half consumed. | **Standard WO** | **Standard PO** |
| **🔴 RED** | **67–100%** | **0–33%** | Critically low. | **PRODUCE NOW** | **CALL SUPPLIER** |
| **⚫ BLACK** | **100%+** | **0%** | Stockout. | **EMERGENCY** | **ESCALATE NOW** |

| 📚  Recommended Reading 'The Goal' by Eliyahu M. Goldratt (1984) — A business novel. Read it over a weekend and every formula in this guide becomes completely intuitive.'Demand Driven Material Requirements Planning' by Carol Ptak & Chad Smith — The definitive technical guide to buffer-based supply chain management. |
| :---- |

| *"The goal of a company is to make money — now and in the future."* — Dr. Eliyahu M. Goldratt,  Theory of Constraints |
| :---: |

# FORMULA

## **5.1  Formula 1: Target Buffer Sizing — How Big Should the Buffer Be?**

The foundational formula. It tells you the maximum stock to hold for each product or material.

**Target Buffer  \=  Average Daily Usage (ADU)  x  Replenishment Lead Time (RLT)  x  Variability Factor (VF)**

| Component | What It Is | Chaizup Example |
| :---- | :---- | :---- |
| **ADU (Avg. Daily Usage)** | Rolling 90-day average of actual daily consumption. For FG: daily sales. For RM: daily production use. | Masala Tea 1kg: 200 units shipped per day averaged over 90 days. |
| **RLT (Replenishment Lead Time)** | Total time from 'we need to replenish' until the stock is on the shelf — including all steps in the process. | FG: Blend 0.5 day \+ Pack 0.5 day \+ QC 1 day \+ Move 1 day \= 3 days total.RM Tea Dust: Order placed \+ transit \+ receive \+ QC \= 10 days total. |
| **VF (Variability Factor)** | A safety multiplier. The more unpredictable the demand or supply, the higher the VF. | Sugar (reliable local supplier) \= 1.3x.Cardamom Powder (volatile prices, unreliable delivery) \= 1.7x. |

## **5.2  Formula 2: Inventory Position — What Is the TRUE Stock Level?**

Before calculating urgency, you must know your true inventory position — not just what is on the shelf today.

**FG Inventory Position  \=  On-Hand Stock  \+  Work-in-Progress (WIP)  \-  Backorders**

| Component | What It Is | Masala Tea 1kg Example |
| :---- | :---- | :---- |
| **On-Hand Stock** | Finished, QC-released stock physically in the warehouse, available to ship. | 180 units in the finished goods store. |
| **Work-in-Progress (WIP)** | Premix blend currently being filled/packed on the VFFS line. Not on shelf yet but will be very soon. | 50 units of Masala Tea 1kg currently on the packaging line. |
| **Backorders** | Confirmed distributor orders that are due to ship but have not yet been dispatched. These are spoken for. | 30 units are committed to a distributor order awaiting dispatch today. |

## **5.3  Formula 3: Buffer Penetration % — How Urgent Is This Product?**

This is the single most important number in the entire TOC system. It tells you exactly how 'empty' each buffer is and drives every production and procurement decision automatically.

**Buffer Penetration %  \=  (Target Buffer  \-  Inventory Position)  /  Target Buffer  x  100**

**Higher penetration \= more urgent \= act FIRST.**  0% means completely full (Green). 90% means only 10% remains — deep Red emergency.

## **5.4  Formula 4: Replenishment Quantity — How Much to Produce or Order?**

Once you decide to produce or order, the quantity is simply the amount needed to restore the buffer to its target level. No more, no less.

**Replenishment Quantity  \=  Target Buffer  \-  Inventory Position**

You do not over-produce. You do not under-produce. You restore exactly what was consumed.

## **5.5  Formula 5: Throughput per Constraint Unit (T/CU) — The Tie-Breaker**

When two products have nearly identical buffer penetration (e.g., both at 75-80%), which one should the VFFS line run first? The answer: whichever earns the most money per minute of the bottleneck machine's time.

**Throughput (T)  \=  Selling Price  \-  Truly Variable Costs (RM \+ PM only)**

**T/CU  \=  Throughput per Unit  /  Constraint Minutes per Unit**

*IMPORTANT: Truly Variable Costs include ONLY raw materials and packaging materials — costs that literally change per unit produced. Labour, electricity, rent, and machine depreciation are NOT deducted. They are fixed regardless of what you pro*

## **5.6  Formula 6: RM/PM Inventory Position and Purchase Quantity**

Procurement uses the exact same buffer logic as production. The only difference is that replenishment means placing a Purchase Order to a supplier rather than a production order to the factory floor.

**RM Inventory Position  \=  On-Hand Stock  \+  On-Order (open POs in transit)  \-  Committed to Production**

**Purchase Order Quantity  \=  Target Buffer  \-  RM Inventory Position**

'Committed to Production' means materials already allocated to released production orders — they are spoken for and not available for future orders.