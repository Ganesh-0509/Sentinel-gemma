# System Architecture Document

# SentinelAI
### AI-Powered Industrial Safety Intelligence Platform

Version: 1.0

---

# 1. Overview

SentinelAI is an AI-powered Industrial Safety Intelligence Platform that integrates industrial operational data from multiple sources and predicts compound safety risks before accidents occur.

The system does not replace existing industrial systems. Instead, it acts as an intelligent software layer above them, providing predictive analytics, explainable AI, permit validation, alarm prioritization, and compliance assistance.

---

# 2. Architecture Overview

```text
+------------------------------------------------------------+
|                    Existing Industrial Systems             |
+------------------------------------------------------------+

SCADA
Gas Sensors
Temperature Sensors
Pressure Sensors
Maintenance Logs
Permit Logs
Shift Logs
Incident Reports
Regulatory Documents

                    │
                    ▼

+------------------------------------------------------------+
|                  Data Ingestion Layer                      |
+------------------------------------------------------------+

• REST APIs
• CSV Import
• MQTT Simulator
• Batch Upload

                    │
                    ▼

+------------------------------------------------------------+
|                 Data Processing Layer                      |
+------------------------------------------------------------+

• Validation
• Cleaning
• Missing Value Handling
• Timestamp Synchronization
• Feature Engineering

                    │
                    ▼

+------------------------------------------------------------+
|                Central Data Storage                        |
+------------------------------------------------------------+

PostgreSQL

TimescaleDB

Neo4j

Vector Database

                    │
                    ▼

+------------------------------------------------------------+
|                   AI Intelligence Layer                    |
+------------------------------------------------------------+

Compound Risk Prediction

Isolation Forest

SHAP Explainability

Rule Engine

Knowledge Graph

RAG Assistant

                    │
                    ▼

+------------------------------------------------------------+
|               Decision & Alert Layer                       |
+------------------------------------------------------------+

Risk Score

Alert Prioritization

Permit Validation

Shift Summary

Compliance Response

                    │
                    ▼

+------------------------------------------------------------+
|                Visualization Layer                         |
+------------------------------------------------------------+

Dashboard

Risk Heatmap

Analytics

Incident Timeline

Reports

```

---

# 3. System Components

## 3.1 Data Ingestion Layer

Responsible for collecting data from various industrial sources.

### Inputs

- SCADA Data
- Sensor Data
- Maintenance Logs
- Permit Logs
- Shift Logs
- Historical Incidents
- Safety Regulations

### Output

Unified Event Stream

---

## 3.2 Data Processing Layer

Processes incoming data before AI analysis.

### Functions

- Remove duplicate records
- Handle missing values
- Normalize units
- Convert timestamps
- Generate time-based features
- Validate data quality

---

## 3.3 Feature Engineering Layer

Transforms raw industrial data into AI-ready features.

Examples

```
Current Gas

Gas Average (10 min)

Gas Trend

Pressure Trend

Temperature Trend

Maintenance Active

Permit Active

Workers Nearby

Previous Incidents

Machine Health
```

---

## 3.4 Data Storage Layer

### PostgreSQL

Stores

- Users
- Permits
- Maintenance
- Workers
- Reports

---

### TimescaleDB

Stores

- Sensor Time Series
- Risk Scores
- Alerts
- Historical Trends

---

### Neo4j

Stores relationships between

- Workers
- Machines
- Permits
- Hazards
- Incidents

---

### Vector Database

Stores

- Factory Act
- OISD Guidelines
- SOP Documents
- Incident Reports

Used for RAG.

---

# 4. AI Intelligence Layer

This is the core of SentinelAI.

---

## Module 1

### Compound Risk Prediction Engine

Purpose

Predict industrial risk before accidents occur.

Input

- Sensor Features
- Maintenance Status
- Permit Status
- Shift Information
- Historical Risk

Output

```
Risk Score

0 – 100
```

Technology

- XGBoost

---

## Module 2

### Anomaly Detection

Purpose

Detect unusual sensor behavior.

Technology

Isolation Forest

Examples

- Sudden Gas Spike
- Pressure Jump
- Sensor Drift

---

## Module 3

### Explainable AI

Technology

SHAP

Purpose

Explain why a prediction was made.

Example

```
Risk Score

92

Reason

Gas Trend ↑

Pressure ↑

Maintenance Active

Hot Work Permit
```

---

## Module 4

### Rule Engine

Handles deterministic safety rules.

Example

```
IF

Gas > Threshold

AND

Hot Work Permit

THEN

Reject Permit
```

---

## Module 5

### RAG Assistant

Uses

- Factory Act
- OISD
- SOP Documents

Answers

- Compliance Questions
- Safety Procedures
- Audit Queries

---

# 5. Decision Layer

Responsible for converting AI outputs into actionable decisions.

Functions

- Alert Generation
- Alert Prioritization
- Permit Approval
- Shift Summary
- Compliance Suggestions

---

# 6. Dashboard Layer

The dashboard provides a unified interface for all users.

Modules

- Plant Overview
- Live Risk Score
- Active Alerts
- Risk Heatmap
- Incident Timeline
- AI Explanation
- Permit Status
- Compliance Assistant

---

# 7. Data Flow

```
Industrial Systems

↓

Data Ingestion

↓

Data Cleaning

↓

Feature Engineering

↓

Database

↓

AI Prediction

↓

Explainability

↓

Decision Engine

↓

Dashboard

↓

Safety Officer
```

---

# 8. Technology Stack

## Frontend

- React
- TypeScript
- Tailwind CSS
- Leaflet

---

## Backend

- FastAPI
- Python

---

## Database

- PostgreSQL
- TimescaleDB
- Neo4j

---

## AI

- XGBoost
- Isolation Forest
- SHAP

---

## LLM

- Gemini
- LangChain

---

## Storage

- ChromaDB

---

# 9. Deployment Architecture

```
React Frontend

↓

FastAPI

↓

AI Services

↓

Database

↓

Storage

↓

Dashboard
```

---

# 10. Security

- JWT Authentication
- Role Based Access
- HTTPS
- API Validation
- Audit Logs

---

# 11. Scalability

Designed to support

- Multiple Factories
- Multiple Plants
- Thousands of Sensors
- Millions of Sensor Records
- Real-Time Prediction

---

# 12. Future Scope

- CCTV Analytics
- Drone Inspection
- Edge AI Deployment
- Predictive Maintenance
- Digital Twin Integration
- Autonomous Emergency Response

---

# End of Document