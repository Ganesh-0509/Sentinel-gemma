# Software Requirements Specification (SRS)

# SentinelAI
### AI-Powered Industrial Safety Intelligence Platform

**Version:** 1.0

---

# 1. Introduction

## 1.1 Purpose

SentinelAI is an AI-powered Industrial Safety Intelligence Platform designed to reduce industrial accidents by predicting hazardous situations before they occur. Unlike traditional monitoring systems that only generate isolated alarms, SentinelAI combines data from multiple industrial sources and identifies compound risks using Machine Learning and Explainable AI.

The objective is to assist safety officers in making faster, smarter, and data-driven decisions while minimizing false alarms and improving overall plant safety.

---

## 1.2 Problem Statement

Modern industries already possess numerous digital systems such as:

- SCADA
- Gas Sensors
- Temperature Sensors
- Pressure Sensors
- Permit-to-Work Systems
- Maintenance Logs
- Shift Logs

Although these systems continuously generate valuable data, they operate independently.

As a result,

- Safety officers receive hundreds of individual alarms.
- Dangerous combinations of events remain unnoticed.
- Most accidents are identified only after they occur.
- Historical incidents are not effectively utilized for prediction.

The core problem is not the lack of data, but the absence of an intelligent software layer capable of correlating information from different systems and predicting compound risks in real time.

---

# 2. Project Objectives

The proposed system aims to:

- Integrate industrial safety data into a unified platform.
- Predict industrial risks before accidents occur.
- Prioritize critical alerts over isolated sensor alarms.
- Validate permits against real-time plant conditions.
- Generate AI-based shift handover summaries.
- Provide explainable AI predictions.
- Assist compliance using regulatory document intelligence.

---

# 3. Scope

The project focuses entirely on software.

The system assumes that industries already possess:

- SCADA Systems
- Industrial Sensors
- Permit Management Software
- Maintenance Systems

The proposed platform acts as an intelligence layer above these existing systems.

### Included

- Data Integration
- Machine Learning
- Risk Prediction
- Explainable AI
- Dashboard
- Risk Heatmap
- RAG-based Compliance Assistant

### Excluded

- CCTV Analytics
- PLC Programming
- Hardware Development
- IoT Device Design
- Industrial Automation Hardware

---

# 4. Users

## Safety Officer

- Monitor plant safety
- Receive AI alerts
- View risk heatmap
- Generate reports

---

## Plant Manager

- View plant risk score
- Analyze incidents
- Monitor KPIs

---

## Maintenance Engineer

- Check permit conflicts
- View maintenance risks
- Schedule repairs

---

## Compliance Officer

- Verify regulations
- Generate audit reports
- Track compliance status

---

# 5. Functional Requirements

## FR-01

The system shall collect data from multiple industrial sources.

---

## FR-02

The system shall preprocess incoming sensor and operational data.

---

## FR-03

The system shall calculate a real-time compound risk score.

---

## FR-04

The system shall predict safety risks using Machine Learning.

---

## FR-05

The system shall prioritize alerts based on risk severity.

---

## FR-06

The system shall validate permit-to-work requests against current plant conditions.

---

## FR-07

The system shall generate AI-based shift handover summaries.

---

## FR-08

The system shall visualize plant risk using an interactive heatmap.

---

## FR-09

The system shall explain every AI prediction using SHAP Explainability.

---

## FR-10

The system shall answer compliance-related questions using a RAG-based assistant.

---

# 6. Non-Functional Requirements

## Performance

- Alert generation < 5 seconds
- Dashboard refresh < 2 seconds
- Risk prediction < 3 seconds

---

## Reliability

- System availability: 99%

---

## Scalability

- Support 1000+ sensors
- Support multiple plants

---

## Security

- Role-Based Access Control (RBAC)
- JWT Authentication
- HTTPS Communication
- Encrypted Database Storage

---

## Maintainability

- Modular architecture
- REST APIs
- Independent AI services

---

# 7. Data Sources

The platform receives data from:

- SCADA
- Gas Sensors
- Temperature Sensors
- Pressure Sensors
- Maintenance Logs
- Permit Logs
- Shift Records
- Historical Incident Reports
- Regulatory Documents

---

# 8. Technology Stack

## Frontend

- React
- TypeScript
- Tailwind CSS

## Backend

- FastAPI

## Database

- PostgreSQL
- TimescaleDB

## Machine Learning

- XGBoost
- Isolation Forest
- SHAP

## AI

- Gemini/OpenAI
- LangChain

## Knowledge Graph

- Neo4j

---

# 9. Assumptions

- Existing industrial systems expose data through APIs, CSV exports, or simulated streams.
- Sensor data can be replayed using synthetic datasets.
- Historical incident reports are available for model training.
- Plant layouts are available for heatmap visualization.

---

# 10. Constraints

- No direct PLC programming.
- No hardware integration.
- No CCTV analytics.
- Synthetic datasets will be used where real industrial data is unavailable.
- Predictions are decision-support recommendations and not automatic control actions.

---

# 11. Expected Outputs

The system provides:

- Real-Time Risk Score
- Compound Risk Alerts
- Permit Validation Results
- Shift Summary Reports
- Risk Heatmaps
- Explainable AI Reports
- Compliance Assistance
- Incident Analytics Dashboard

---

# 12. Success Criteria

The project will be considered successful if it can:

- Integrate multiple industrial data sources into one platform.
- Detect compound risks before accidents occur.
- Reduce unnecessary alarms through intelligent prioritization.
- Provide explainable risk predictions.
- Validate permits against operational conditions.
- Demonstrate the complete workflow using synthetic and publicly available datasets.

---

# End of Document