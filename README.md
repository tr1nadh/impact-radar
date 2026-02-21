
<p align="center">
  <img src="https://github.com/user-attachments/assets/b775a4a6-6f70-47ca-b0a7-bc4607686ae8" width="400" alt="ImpactRadar Logo"/>
</p>

# 🚨 ImpactRadar

ImpactRadar is an AI-powered Blast Radius Analysis tool for JavaScript/Node.js codebases.

It analyzes a proposed code change and makes its system-wide impact visible **before it is merged**.

This is not about predicting failures.
It is about making impact explicit so engineers can act with confidence.

---

🔗 **Live Demo:** [YouTube Video](https://youtu.be/snfx-d7SZSs)

---

## 🔥 What It Does

Given:

* A target function or API
* A semantic change type (e.g., `validation_change`, `added_throw_statement`)
* A project directory

ImpactRadar:

* Builds a dependency graph
* Traverses direct & indirect dependents
* Calculates blast radius
* Scores risk using architectural weighting
* Performs caller-side safety analysis
* Estimates failure probabilities
* Generates an AI-based predictive risk explanation
* Produces an interactive HTML visualization

---

## 🧠 Core Capabilities

### ✅ File-Level & Function-Level Traversal

Maps how changes propagate across modules and APIs.

---

### ✅ Risk Scoring Engine

Uses:

* Change type profile
* API surface impact
* Propagation depth
* Architectural zones
* Criticality flags

---

### ✅ Caller Safety Analysis

Detects:

* Missing null checks
* Missing try/catch
* Unsafe dereferencing
* Async misuse

---

### ✅ Failure Probability Estimation

Estimates:

* Error spike probability
* Null dereference probability
* Unhandled exception probability
* Data inconsistency probability

---

### ✅ AI Audit Layer

Simulates:

* Deployment impact
* Concrete failure traces
* Risk narratives
* Strategic recommendations

---

### ✅ Interactive Visualization

Generates a Mermaid-based graph with:

* Target node
* Direct dependents
* Risk context
* AI analysis

---

## 📦 Installation

```bash
git clone <repo-url>
cd impact-radar
npm install
```

---

## 🔐 Environment Setup

ImpactRadar uses the OpenAI API.

Set your API key before running:

### Windows (CMD)

```bash
set OPENAI_API_KEY=sk-proj-xxxx
```

### PowerShell

```powershell
$env:OPENAI_API_KEY="sk-proj-xxxx"
```

### Mac/Linux

```bash
export OPENAI_API_KEY=sk-proj-xxxx
```

---

## 🚀 Usage

```bash
node impactRadar.js \
  --project ./path-to-project \
  --target "getUserById" \
  --change_type "validation_change" \
  --visualize
```

---

## ⚙️ CLI Options

| Option                         | Description                                   |
| ------------------------------ | --------------------------------------------- |
| `--project`                    | Path to project directory (required)          |
| `--target`                     | Function or API being changed (required)      |
| `--change_type`                | Semantic change classification (required)     |
| `--visualize`                  | Generate HTML visualization                   |

---

## 🧬 Change Type Examples

* `added_throw_statement`
* `removed_fallback_behavior`
* `stricter_input_constraint`
* `changed_return_type`
* `sync_to_async_change`
* `db_schema_change`
* `validation_change`
* `generic_behavioral_change`

---

## 🏗 Risk Model Formula

```
Base Risk
+ (API_Impacts × Profile_Weight)
+ (Max_Depth × Depth_Impact_Factor)
+ (Zone_Weight_Sum × Zone_Impact_Factor)
× Target_Criticality_Multiplier
```

---

## 📊 Output Structure

ImpactRadar produces:

```json
{
  "analysis_metadata": {},
  "impact_summary": {},
  "risk_model": {},
  "impact_tree": {},
  "ranked_api_impacts": [],
  "caller_safety_analysis_results": [],
  "ai_analysis": {}
}
```

---

## 🖥 HTML Report

When `--visualize` is used:

* Generates `impact-report.html`
* Opens automatically
* Includes:

  * Risk badge
  * Failure probability bars
  * Blast radius graph
  * High-risk endpoints
  * AI impact breakdown
  * Simulated failure trace

---

## 🎯 Why This Matters

Engineers often merge changes without understanding:

* Who depends on this function?
* Which APIs will break?
* Are callers defensively coded?
* What happens if this goes live?

ImpactRadar answers those questions **before production**.

---

## 🛠 Architecture Overview

```
Graph Parser
    ↓
Dependency Graph
    ↓
Blast Radius Traversal
    ↓
Risk Scoring Engine
    ↓
Caller Safety Scanner
    ↓
AI Impact Simulation
    ↓
JSON Report + HTML Visualization
```

---

## ⚠️ Limitations

* Static analysis only (no runtime tracing)
* Partial graph mode when import resolution is low
* AI layer is heuristic-enhanced, not deterministic

---

## 🧪 Intended Use Cases

* Pre-merge validation
* CI/CD integration
* Code review augmentation
* Architecture risk auditing
* Technical debt analysis

---

## 🔮 Future Improvements

* VSCode extension integration
* Git diff auto-detection
* PR comment bot integration
* Animated risk traversal
* Heatmap-based impact graph
* Multi-language support

---

## 🏁 Philosophy

> Given a proposed change, make the blast radius explicit — before the change is merged.

ImpactRadar is not about predicting failures.

It is about reducing uncertainty.

---
