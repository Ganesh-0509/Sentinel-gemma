# Database Design Document

# SentinelAI
### AI-Powered Industrial Safety Intelligence Platform

Version: 1.0

---

# 1. Overview

The SentinelAI database is designed to store industrial operational data, AI predictions, maintenance activities, permit records, incident history, user information, and regulatory documents.

The architecture follows a hybrid database approach.

| Database | Purpose |
|----------|---------|
| PostgreSQL | Transactional Data |
| TimescaleDB | Time-Series Sensor Data |
| Neo4j | Knowledge Graph |
| ChromaDB | Vector Storage for RAG |

---

# 2. Database Architecture

```

Industrial Data

↓

PostgreSQL

↓

TimescaleDB

↓

Neo4j

↓

ChromaDB

↓

AI Models

↓

Dashboard

```

---

# 3. Database Modules

The database consists of the following modules.

```
Users

Plants

Machines

Sensors

Sensor Readings

Maintenance

Permits

Workers

Shifts

Incidents

Risk Scores

Alerts

Reports

Regulations

Audit Logs

```

---

# 4. Entity Relationship Overview

```
Plant
 │
 ├──── Machine
 │        │
 │        ├──── Sensor
 │        │         │
 │        │         └──── SensorReading
 │        │
 │        ├──── Maintenance
 │        │
 │        └──── Permit
 │
 ├──── Worker
 │
 ├──── Shift
 │
 ├──── Incident
 │
 └──── RiskScore

```

---

# 5. Table Design

---

## Plant

Stores factory information.

| Field | Type |
|--------|------|
| plant_id | UUID |
| plant_name | VARCHAR |
| location | VARCHAR |
| industry_type | VARCHAR |
| created_at | TIMESTAMP |

---

## Machine

Stores all industrial equipment.

| Field | Type |
|--------|------|
| machine_id | UUID |
| plant_id | UUID |
| machine_name | VARCHAR |
| machine_type | VARCHAR |
| installation_date | DATE |
| status | VARCHAR |

---

## Sensor

Stores sensor metadata.

| Field | Type |
|--------|------|
| sensor_id | UUID |
| machine_id | UUID |
| sensor_type | VARCHAR |
| unit | VARCHAR |
| threshold | FLOAT |
| status | VARCHAR |

Examples

- Gas
- Temperature
- Pressure
- Humidity

---

## SensorReading

Time-series sensor readings.

| Field | Type |
|--------|------|
| reading_id | UUID |
| sensor_id | UUID |
| timestamp | TIMESTAMP |
| value | FLOAT |
| quality | VARCHAR |

Stored inside

TimescaleDB

---

## Maintenance

Stores maintenance activities.

| Field | Type |
|--------|------|
| maintenance_id | UUID |
| machine_id | UUID |
| maintenance_type | VARCHAR |
| engineer | VARCHAR |
| start_time | TIMESTAMP |
| end_time | TIMESTAMP |
| status | VARCHAR |

---

## Permit

Stores Permit-to-Work information.

| Field | Type |
|--------|------|
| permit_id | UUID |
| permit_type | VARCHAR |
| machine_id | UUID |
| issued_by | VARCHAR |
| start_time | TIMESTAMP |
| end_time | TIMESTAMP |
| status | VARCHAR |

Permit Types

- Hot Work
- Confined Space
- Electrical
- Height Work
- Excavation

---

## Worker

Stores worker details.

| Field | Type |
|--------|------|
| worker_id | UUID |
| name | VARCHAR |
| role | VARCHAR |
| department | VARCHAR |
| shift_id | UUID |

---

## Shift

Stores shift schedules.

| Field | Type |
|--------|------|
| shift_id | UUID |
| shift_name | VARCHAR |
| supervisor | VARCHAR |
| start_time | TIMESTAMP |
| end_time | TIMESTAMP |

---

## Incident

Stores historical accident reports.

| Field | Type |
|--------|------|
| incident_id | UUID |
| machine_id | UUID |
| incident_type | VARCHAR |
| severity | VARCHAR |
| cause | TEXT |
| occurred_at | TIMESTAMP |

---

## RiskScore

Stores AI predictions.

| Field | Type |
|--------|------|
| risk_id | UUID |
| machine_id | UUID |
| timestamp | TIMESTAMP |
| risk_score | FLOAT |
| risk_level | VARCHAR |
| prediction_reason | TEXT |

---

## Alert

Stores generated alerts.

| Field | Type |
|--------|------|
| alert_id | UUID |
| risk_id | UUID |
| alert_type | VARCHAR |
| priority | VARCHAR |
| created_at | TIMESTAMP |
| status | VARCHAR |

Priority

- Low
- Medium
- High
- Critical

---

## Regulation

Stores documents used for RAG.

| Field | Type |
|--------|------|
| regulation_id | UUID |
| title | VARCHAR |
| document_type | VARCHAR |
| source | VARCHAR |
| embedding_id | UUID |

Examples

- Factory Act
- OISD
- SOP
- Safety Manual

---

## AuditLog

Stores system activities.

| Field | Type |
|--------|------|
| log_id | UUID |
| user_id | UUID |
| activity | TEXT |
| timestamp | TIMESTAMP |

---

# 6. Database Relationships

```
Plant

1 ---- N Machine

Machine

1 ---- N Sensor

Sensor

1 ---- N SensorReading

Machine

1 ---- N Maintenance

Machine

1 ---- N Permit

Machine

1 ---- N Incident

Machine

1 ---- N RiskScore

RiskScore

1 ---- N Alert

Shift

1 ---- N Worker

```

---

# 7. Knowledge Graph (Neo4j)

The Knowledge Graph stores relationships between industrial entities.

```
Worker

↓

WORKS_ON

↓

Machine

↓

HAS_SENSOR

↓

Sensor

↓

GENERATES

↓

Risk

↓

CAUSES

↓

Incident

↓

FOLLOWS

↓

Regulation
```

---

# 8. Vector Database (ChromaDB)

The vector database stores document embeddings.

Documents include

- Factory Act
- OISD Guidelines
- Safety SOP
- Incident Reports
- Internal Manuals

Purpose

- Semantic Search
- RAG Assistant
- Compliance Questions

---

# 9. Indexing Strategy

Indexes are created on

- sensor_id
- machine_id
- timestamp
- plant_id
- permit_id
- incident_id
- risk_score

Purpose

- Faster Search
- Real-Time Queries
- Dashboard Performance

---

# 10. Data Retention Policy

| Data | Retention |
|--------|-----------|
| Sensor Readings | 5 Years |
| Alerts | 2 Years |
| Incidents | Permanent |
| Risk Scores | 5 Years |
| Audit Logs | 3 Years |
| Regulations | Permanent |

---

# 11. Database Security

- JWT Authentication
- Role-Based Access Control (RBAC)
- Encrypted Connections (TLS)
- Password Hashing
- Audit Logging
- Daily Backups

---

# 12. Scalability

The database is designed to support

- Multiple Plants
- 1000+ Machines
- Millions of Sensor Readings
- Real-Time AI Predictions
- Concurrent Dashboard Users

---

# End of Document