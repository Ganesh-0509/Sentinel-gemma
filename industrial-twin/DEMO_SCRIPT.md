# SentinelAI — Demo Video Script

**Target: 3:00 (hard stop 3:20). Optional add-ons at the end stretch it to ~4:45.**

## Before you hit record

1. Backend: `python -m uvicorn sentinel.api.app:app --port 8000` — confirm `http://127.0.0.1:8000/api/v1/health` shows `model_loaded: true`
2. Frontend: `cd frontend && npm run dev` — opens on **http://localhost:8080**
3. Open the browser at **1920x1080**, zoom 100%, hide bookmarks bar
4. Do one silent dry-run click-through so no page is loading cold on camera
5. Numbers below (risk %, LEL) drift because the plant clock is live — say the *band* ("HIGH", "rejected"), not the exact decimal

---

## 0:00 – 0:20 — The hook (Dashboard, `/`)

> "In a steel plant, the gap between a gas reading drifting and a worker getting hurt is measured in minutes. Most systems tell you after the alarm trips. SentinelAI tells you before."

**On screen:** Land on the Dashboard. Slow scroll top to bottom. Let the live zone tiles and risk bands land.

> "Eight live zones across the Visakhapatnam Steel Plant — gas, pressure, temperature, vibration, plus who's actually in the zone and what shift they're on."

---

## 0:20 – 0:50 — It's a real plant, not a mock (`/geospatial`)

**Click:** Geospatial & Vision

> "This isn't a sketch. The site boundary is pulled from OpenStreetMap — the actual RINL Visakhapatnam footprint. Every zone sits at real coordinates, so proximity between hazards is a real distance, not a guess."

**On screen:** Let the map render. Hover a zone marker.

> "And the worker counts aren't typed in. A vision model reads camera frames for people and PPE — helmet, vest, gloves — and that count feeds straight into the risk score."

**Beat:** point at the vision panel / detection overlay.

---

## 0:50 – 1:20 — The 3D twin (`/digital-twin`)

**Click:** Digital Twin

> "Same plant, in three dimensions."

**On screen:** Orbit the scene once, slowly. Click a HIGH-risk zone.

> "Zones are colour-coded by live risk band. Click one and you get the sensor stack behind that colour — and the drivers the model actually weighted."

---

## 1:20 – 1:50 — The alert that matters (`/command-center`)

**Click:** Command Center

> "Here's the part that earns its keep. This isn't a list of every threshold that tripped — it's a ranked queue."

**On screen:** Point at the top CRITICAL alert (currently **Sinter Plant / SIN-1**).

> "Sinter Plant is top of the queue. Not because one number is high — because risk is elevated, six workers are inside, it's night shift so response is slower, and it's a hazardous-area zone. That combination is what makes it critical."

---

## 1:50 – 2:20 — The safety guarantee (`/permit-intelligence`)

**Click:** Permit Intelligence

**On screen:** Request **Hot Work** on **Coke Oven Battery A**. Submit.

> "A supervisor requests hot work on Coke Oven Battery A."

**Wait for the REJECTED result.**

> "Rejected. Combustible gas is above the hot-work LEL limit — and it cites the standard it's enforcing, OISD-STD-105."

**This is your strongest line — deliver it clean:**

> "This decision is deterministic. The machine-learning layer can escalate a risk or reject work. It can never approve work the gas interlock has rejected. The model advises. The rules decide."

---

## 2:20 – 2:45 — Response and paper trail (`/agent-workflow` → `/evidence`)

**Click:** Agent Workflow. Run it on the critical zone.

> "Once something is critical, a multi-agent workflow takes it from detection to response — risk monitor, permit check, compliance lookup, then the actions."

**On screen:** Let the trace populate. **Click:** Evidence Panel.

> "And every step is logged with its reasoning and its citation. When the regulator asks why a decision was made, the answer is on file — not in someone's memory."

---

## 2:45 – 3:00 — Close

**Click:** back to Dashboard, or hold on Command Center.

> "Real plant geometry. Live sensor fusion. Vision-based worker awareness. Regulation-grounded decisions that can't be overridden by a model. That's SentinelAI — it shortens the gap between drift and harm."

**End card:** project name + repo.

---

# Optional extensions (adds ~1:45, total ~4:45)

Insert these only if you want the 5-minute version.

### +0:35 — What-If Simulation (`/simulation`), place after Digital Twin
> "Before you authorise work, you can ask what happens if. Push gas up in one zone and watch the forecast move across the plant — including zones downwind of it."

Drag the gas/LEL slider on one zone, let the projected risk update.

### +0:35 — Compliance Assistant (`/compliance`), place after Permit Intelligence
> "And when someone needs the rule itself, they can just ask."

Type: **"What are the LEL limits for hot work in a confined space?"**
> "The answer comes back grounded in the regulation corpus — DGMS circulars, OISD standards — with the citation attached. It quotes the source. It doesn't improvise."

### +0:35 — Live Replay + Investigation (`/live-replay`, `/incident-investigation`)
> "After an event, you can replay it minute by minute and see exactly what the system knew, when it knew it, and what it recommended."

---

# Recording notes

- **Pace:** ~140 words/minute. The script above is ~430 words for the 3-minute cut — that leaves deliberate silence for the UI to breathe. Don't rush to fill it.
- **Mouse:** move slowly and deliberately. Pause ~1s before every click so the viewer's eye follows.
- **Loading:** the 3D twin and the vision panel are the two slowest. Pre-visit both so assets are warm.
- **The permit rejection is your money shot** — if you only nail one segment, nail that one. Consider recording it twice and keeping the better take.
- **Don't read the risk decimals aloud.** They change between takes and will contradict your voiceover.
- Record system audio off, mic only, so backend logs don't leak in.

# Page-by-page status (all verified working)

| Route | Page | Status |
|---|---|---|
| `/` | Dashboard | OK |
| `/digital-twin` | Digital Twin | OK |
| `/geospatial` | Geospatial & Vision | OK |
| `/live-replay` | Live Replay | OK |
| `/risk-analytics` | Risk Analytics | OK |
| `/command-center` | Command Center | OK |
| `/agent-workflow` | Agent Workflow | OK |
| `/permit-intelligence` | Permit Intelligence | OK |
| `/compliance` | Compliance Assistant | OK |
| `/incident-investigation` | Incident Investigation | OK |
| `/evidence` | Evidence Panel | OK |
| `/simulation` | What-If Simulation | OK |
