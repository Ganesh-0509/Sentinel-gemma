# Datasets — Acquisition & Usage Plan

**Meta-source:** [Google Dataset Search](https://datasetsearch.research.google.com/) indexes
all of the datasets below. Use it as the discovery entry point; the direct links here are the
ones we actually pull from.

**Strategy (honest & non-circular):** our *primary* training data is the SentinelAI **scenario
simulator** (`sentinel/sim/simulator.py`), where incident labels emerge from simulated physics —
not from hand-written risk rules. The real public datasets below are used to (a) **validate** that
our anomaly detector generalises beyond our own simulator, and (b) add **realism** (true sensor
noise, drift, fault signatures) — the credibility anchor when a judge asks "is this just your own
synthetic data?"

---

## Tier A — Anomaly-detection validation (industrial process, labelled faults/attacks)

| Dataset | Why we use it | Access | Direct source |
|---|---|---|---|
| **Tennessee Eastman Process (TEP)** | Chemical process with ~20 fault types → perfect analog for "process abnormality precedes incident." Validate the LSTM-Autoencoder here. | **Free** (CSV) | [Kaggle CSV](https://www.kaggle.com/datasets/afrniomelo/tep-csv) · [GitHub (all 21 faults)](https://github.com/mv-per/tennessee-eastman-dataset) |
| **HAI (HIL-based Augmented ICS)** | Realistic ICS testbed (steam turbine + pumped-storage), 79 sensor features @1 Hz, labelled anomalies. Multivariate = matches our fusion story. | **Free** | [github.com/icsdataset/hai](https://github.com/icsdataset/hai) |
| **SWaT / WADI** | Gold-standard CPS anomaly benchmarks (water treatment/distribution). Cite as validation target. | **Gated** — request from SUTD iTrust; may not arrive in hackathon window. Do **not** depend on it. | [iTrust request](https://itrust.sutd.edu.sg/testbeds/secure-water-treatment-swat/) |

## Tier B — Gas-sensor realism

| Dataset | Why we use it | Access | Direct source |
|---|---|---|---|
| **UCI Gas Sensor Array Drift** | 13,910 real measurements, 16 chemical sensors, 6 gases, over 36 months → real gas-sensor **drift** signatures. Feeds a realistic "sensor drift" anomaly angle and noise model. | **Free** | [UCI](https://archive.ics.uci.edu/ml/datasets/gas+sensor+array+drift+dataset) · [Kaggle](https://www.kaggle.com/datasets/orvile/gas-sensor-array-drift-dataset) |
| **Awesome Industrial Datasets** (index) | Curated catalogue to source additional SCADA/sensor sets on demand. | **Free** | [github.com/jonathanwvd/awesome-industrial-datasets](https://github.com/jonathanwvd/awesome-industrial-datasets) |

## Tier C — Regulatory corpus (for the RAG compliance assistant, Phase 3)

| Document | Role | Notes |
|---|---|---|
| **OISD-STD-105 — Work Permit System** | The core permit logic: hot work, confined space, gas testing in **%LEL / ppm toxic / O₂ %**. Directly grounds the permit-veto rule engine + RAG citations. | Public standard (Oil Industry Safety Directorate). |
| **Factory Act 1948** — hazardous-process sections (Ch. IV-A) | Statutory compliance coverage. | Public (Govt. of India). |
| **DGMS circulars** | Mining-sector safety (breadth). | Public (Directorate General of Mines Safety). |

---

## Download helper (to be added in Phase 2)
`scripts/fetch_datasets.py` will pull the **free** Tier-A/B sets (TEP CSV, HAI, UCI Gas) into
`data/external/`. SWaT/WADI stay manual (access request). Kaggle sets need a Kaggle API token
(`~/.kaggle/kaggle.json`) — or download the CSVs by hand.

> **Note on "everything":** we deliberately do **not** dump every industrial dataset in.
> Two validation sets (TEP + HAI) + one gas-realism set (UCI) is enough to prove generalisation
> without drowning the 2-week build. More can be sourced from the two index links above if a
> specific reviewer question demands it.
