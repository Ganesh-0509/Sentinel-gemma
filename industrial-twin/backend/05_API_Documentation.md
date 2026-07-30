# API Documentation

# SentinelAI
### AI-Powered Industrial Safety Intelligence Platform

Version: 1.0

---

# 1. Overview

The SentinelAI backend exposes REST APIs that allow industrial systems, dashboards, and AI services to exchange data securely.

The APIs are organized into the following modules:

- Authentication
- Sensor Management
- Risk Prediction
- Permit Management
- Maintenance
- Alerts
- Dashboard
- Reports
- AI Assistant

Base URL

```
http://localhost:8000/api/v1
```

---

# 2. Authentication

Authentication Method

```
JWT Bearer Token
```

Header

```
Authorization: Bearer <token>
```

---

# 3. Authentication APIs

## Login

```
POST /auth/login
```

Request

```json
{
  "email":"admin@sentinel.ai",
  "password":"password123"
}
```

Response

```json
{
  "token":"jwt_token",
  "role":"Safety Officer"
}
```

---

## Logout

```
POST /auth/logout
```

---

## Current User

```
GET /auth/me
```

---

# 4. Sensor APIs

## Get All Sensors

```
GET /sensors
```

---

## Get Sensor Details

```
GET /sensors/{sensor_id}
```

---

## Add Sensor

```
POST /sensors
```

```json
{
  "sensor_type":"Gas",
  "machine_id":"M101",
  "threshold":30
}
```

---

## Update Sensor

```
PUT /sensors/{sensor_id}
```

---

## Delete Sensor

```
DELETE /sensors/{sensor_id}
```

---

# 5. Sensor Reading APIs

## Upload Sensor Reading

```
POST /sensor-readings
```

```json
{
  "sensor_id":"S101",
  "timestamp":"2026-07-20T10:30:00",
  "value":18.5
}
```

---

## Get Live Readings

```
GET /sensor-readings/live
```

---

## Historical Readings

```
GET /sensor-readings/history
```

Query Parameters

```
machine_id

start_date

end_date
```

---

# 6. Machine APIs

## Get Machines

```
GET /machines
```

---

## Machine Details

```
GET /machines/{machine_id}
```

---

## Register Machine

```
POST /machines
```

---

# 7. Permit APIs

## Create Permit

```
POST /permits
```

```json
{
  "permit_type":"Hot Work",
  "machine_id":"M102",
  "start_time":"09:00",
  "end_time":"14:00"
}
```

---

## Validate Permit

```
POST /permits/{permit_id}/validate
```

Output

```json
{
    "status":"Rejected",
    "reason":"High Gas Concentration"
}
```

---

## Get Permit

```
GET /permits/{permit_id}
```

---

## Active Permits

```
GET /permits/active
```

---

# 8. Maintenance APIs

## Create Maintenance Record

```
POST /maintenance
```

---

## Maintenance History

```
GET /maintenance/history
```

---

## Maintenance Details

```
GET /maintenance/{maintenance_id}
```

---

# 9. Risk Prediction APIs

## Predict Risk

```
POST /risk/predict
```

Request

```json
{
  "machine_id":"M101"
}
```

Response

```json
{
  "risk_score":92,
  "risk_level":"Critical",
  "prediction":"Explosion Risk"
}
```

---

## Risk Explanation

```
GET /risk/{risk_id}/explanation
```

Response

```json
{
 "Gas Trend":"34%",
 "Pressure":"High",
 "Permit":"Hot Work",
 "Maintenance":"Active"
}
```

---

## Live Risk Score

```
GET /risk/live
```

---

## Historical Risk

```
GET /risk/history
```

---

# 10. Alert APIs

## Get Active Alerts

```
GET /alerts
```

---

## Alert Details

```
GET /alerts/{alert_id}
```

---

## Acknowledge Alert

```
PATCH /alerts/{alert_id}
```

---

## Close Alert

```
DELETE /alerts/{alert_id}
```

---

# 11. Dashboard APIs

## Dashboard Summary

```
GET /dashboard
```

Returns

- Total Machines
- Active Alerts
- Active Permits
- Critical Risks
- Today's Incidents

---

## Risk Heatmap

```
GET /dashboard/heatmap
```

---

## Plant Statistics

```
GET /dashboard/statistics
```

---

# 12. Report APIs

## Incident Report

```
GET /reports/incidents
```

---

## Risk Report

```
GET /reports/risk
```

---

## Daily Summary

```
GET /reports/daily
```

---

## Weekly Summary

```
GET /reports/weekly
```

---

# 13. AI Assistant APIs

## Ask Compliance Question

```
POST /assistant/query
```

Request

```json
{
  "question":"Can Hot Work continue during high gas concentration?"
}
```

Response

```json
{
 "answer":"No...",
 "reference":"OISD Section ..."
}
```

---

## Shift Summary

```
POST /assistant/shift-summary
```

---

## AI Recommendations

```
GET /assistant/recommendations
```

---

# 14. WebSocket APIs

Live Sensor Stream

```
ws://localhost:8000/ws/sensors
```

---

Live Alerts

```
ws://localhost:8000/ws/alerts
```

---

Live Risk Scores

```
ws://localhost:8000/ws/risk
```

---

# 15. HTTP Status Codes

| Code | Meaning |
|------|----------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 409 | Conflict |
| 422 | Validation Error |
| 500 | Internal Server Error |

---

# 16. Error Response

```json
{
    "status":"error",
    "code":400,
    "message":"Invalid Machine ID"
}
```

---

# 17. API Security

- JWT Authentication
- HTTPS
- Role-Based Access Control (RBAC)
- Input Validation
- API Rate Limiting
- Audit Logging

---

# 18. API Versioning

```
/api/v1/
```

Future versions

```
/api/v2/
/api/v3/
```

---

# 19. API Workflow

```
Frontend

↓

REST API

↓

FastAPI

↓

Business Logic

↓

AI Engine

↓

Database

↓

Response

↓

Frontend Dashboard
```

---

# 20. API Modules Summary

| Module | Endpoints |
|---------|-----------|
| Authentication | 3 |
| Sensors | 5 |
| Sensor Readings | 3 |
| Machines | 3 |
| Permits | 4 |
| Maintenance | 3 |
| Risk Prediction | 4 |
| Alerts | 4 |
| Dashboard | 3 |
| Reports | 4 |
| AI Assistant | 3 |
| WebSockets | 3 |

---

# End of Document