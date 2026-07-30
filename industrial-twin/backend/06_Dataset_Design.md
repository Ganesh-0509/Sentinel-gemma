# Dataset Design & Synthetic Data Generation

# SentinelAI
### AI-Powered Industrial Safety Intelligence Platform

Version: 1.0

---

# 1. Overview

The SentinelAI platform uses a hybrid dataset approach by combining publicly available industrial datasets with synthetic datasets.

Since real industrial SCADA and safety datasets are confidential, synthetic data is generated to simulate real factory operations while preserving realistic industrial conditions.

The final dataset consists of:

- Public Industrial Datasets
- Synthetic Sensor Data
- Synthetic Permit Data
- Synthetic Maintenance Logs
- Synthetic Shift Records
- Historical Incident Data
- Regulatory Documents (RAG)

---

# 2. Dataset Architecture

```
                Public Datasets
                        │
                        ▼

Synthetic Data Generator

        │

        ├──────── Sensor Data

        ├──────── Maintenance Logs

        ├──────── Permit Logs

        ├──────── Worker Data

        ├──────── Shift Data

        └──────── Incident Data

                        │
                        ▼

             Unified Training Dataset

                        │
                        ▼

                 Feature Engineering

                        │
                        ▼

                  Machine Learning
```

---

# 3. Dataset Modules

The project dataset consists of seven independent modules.

| Module | Purpose |
|----------|---------|
| Sensor Dataset | SCADA Simulation |
| Maintenance Dataset | Equipment Maintenance |
| Permit Dataset | Permit-to-Work Records |
| Worker Dataset | Shift & Worker Details |
| Incident Dataset | Historical Accidents |
| Plant Layout Dataset | Machine Coordinates |
| Regulations Dataset | RAG Knowledge Base |

---

# 4. Sensor Dataset

Purpose

Simulate SCADA sensor readings.

Columns

| Column | Type |
|----------|------|
| timestamp | DateTime |
| machine_id | String |
| sensor_id | String |
| gas_ppm | Float |
| temperature | Float |
| pressure | Float |
| humidity | Float |
| vibration | Float |
| machine_status | Boolean |

Example

| Time | Gas | Temp | Pressure |
|------|------|------|----------|
|10:00|12|55|8.4|
|10:01|13|56|8.5|
|10:02|14|57|8.6|

Frequency

Every minute.

---

# 5. Maintenance Dataset

Purpose

Store maintenance activities.

Columns

| Column | Type |
|----------|------|
| maintenance_id | String |
| machine_id | String |
| maintenance_type | String |
| engineer | String |
| start_time | DateTime |
| end_time | DateTime |
| status | String |

Types

- Preventive
- Corrective
- Emergency

---

# 6. Permit Dataset

Purpose

Store Permit-to-Work information.

Columns

| Column | Type |
|----------|------|
| permit_id | String |
| permit_type | String |
| machine_id | String |
| work_zone | String |
| start_time | DateTime |
| end_time | DateTime |
| permit_status | String |

Permit Types

- Hot Work
- Electrical
- Confined Space
- Height Work
- Excavation

---

# 7. Worker Dataset

Purpose

Track workforce allocation.

Columns

| Column | Type |
|----------|------|
| worker_id | String |
| department | String |
| shift | String |
| machine_id | String |
| supervisor | String |

---

# 8. Incident Dataset

Purpose

Store previous accidents and near misses.

Columns

| Column | Type |
|----------|------|
| incident_id | String |
| incident_type | String |
| machine_id | String |
| severity | String |
| gas_level | Float |
| temperature | Float |
| maintenance_active | Boolean |
| permit_active | Boolean |
| root_cause | String |

Severity Levels

- Low
- Medium
- High
- Critical

---

# 9. Plant Layout Dataset

Purpose

Generate the plant heatmap.

Columns

| Column | Type |
|----------|------|
| machine_id | String |
| x_coordinate | Float |
| y_coordinate | Float |
| zone | String |

Used for

- Risk Heatmap
- Worker Allocation
- Zone Risk Calculation

---

# 10. Regulation Dataset

Purpose

Provide knowledge to the RAG assistant.

Documents

- Factory Act
- OISD Standards
- Safety SOPs
- Emergency Guidelines
- Company Manuals

These documents are converted into embeddings and stored in the vector database.

---

# 11. Synthetic Data Generation

The synthetic dataset generator creates realistic industrial scenarios.

Generated Parameters

- Gas Leakage
- Temperature Rise
- Pressure Increase
- Machine Failure
- Maintenance Activity
- Permit Activation
- Shift Change
- Worker Presence

Each scenario follows predefined industrial safety rules.

---

# 12. Risk Scenario Generation

Example Scenario 1

```
Gas Increasing

+

Hot Work Permit

+

Maintenance Active

↓

Risk = Critical
```

---

Example Scenario 2

```
Temperature High

+

Pressure Stable

↓

Risk = Medium
```

---

Example Scenario 3

```
Gas Normal

+

Machine Running

↓

Risk = Low
```

---

# 13. Feature Engineering

Raw sensor data is transformed into AI-ready features.

Generated Features

- Current Gas
- Gas Average (10 min)
- Gas Trend
- Gas Rate of Change
- Temperature Trend
- Pressure Trend
- Machine Health
- Maintenance Status
- Permit Status
- Shift Type
- Historical Incident Count

---

# 14. Dataset Labels

The AI model predicts four classes.

| Risk Score | Label |
|------------|--------|
| 0-30 | Low |
| 31-60 | Medium |
| 61-80 | High |
| 81-100 | Critical |

---

# 15. Training Dataset

The final ML dataset combines all engineered features.

| Feature | Description |
|----------|-------------|
| Gas Trend | Sensor Trend |
| Temperature Trend | Sensor Trend |
| Pressure Trend | Sensor Trend |
| Permit Status | Operational Feature |
| Maintenance Status | Operational Feature |
| Shift Type | Operational Feature |
| Worker Count | Operational Feature |
| Previous Incident Count | Historical Feature |

Target Variable

```
Risk Level
```

---

# 16. Dataset Split

| Dataset | Percentage |
|----------|------------|
| Training | 70% |
| Validation | 15% |
| Testing | 15% |

---

# 17. Data Validation

Before training, every dataset is validated.

Validation Rules

- Missing Values
- Duplicate Records
- Invalid Sensor Values
- Timestamp Consistency
- Invalid Permit Records
- Incorrect Machine IDs

---

# 18. Dataset Pipeline

```
Public Dataset

+

Synthetic Dataset

↓

Cleaning

↓

Validation

↓

Feature Engineering

↓

Training Dataset

↓

XGBoost

↓

Evaluation

↓

Deployment
```

---

# 19. Dataset Sources

Public datasets may include:

- Industrial Control System (ICS) datasets
- SCADA simulation datasets
- Public industrial incident reports
- Government safety regulations
- Factory Act documentation

Synthetic datasets are generated for:

- Sensor readings
- Maintenance logs
- Permit records
- Worker shifts
- Machine operations

---

# 20. Expected Dataset Size

| Dataset | Records |
|----------|---------|
| Sensor Readings | 1,000,000+ |
| Maintenance Logs | 10,000 |
| Permit Records | 5,000 |
| Worker Records | 2,000 |
| Incident Reports | 3,000 |
| Plant Layout | 500 Machines |

---

# End of Document