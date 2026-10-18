# Lights Out: architecture and solution flow

Three Mermaid diagrams. GitHub draws them below; to edit or export one, paste its code (also in `docs/diagrams/*.mmd`) into https://mermaid.live. PNG renders are next to the code in `docs/diagrams/`.

## System architecture on IBM LinuxONE

Everything that thinks runs on one IBM LinuxONE VM (IBM z17, s390x) in Podman containers. M2 runs on the Telum II on-chip AI accelerator through IBM Snap ML and zDNN, with a CPU fallback; the database volume and the customer records are encrypted with the CPACF crypto unit.

```mermaid
---
config:
  look: classic
  theme: default
---
flowchart LR
  subgraph Players["Players"]
    B["Browser<br/>React + three.js 3D county"]
    BOX["Grid Status Box<br/>Raspberry Pi Pico 2 · MicroPython"]
    BR["USB bridge<br/>Python on the laptop"]
  end
  DATA[("Public data<br/>EIA-930 · Open-Meteo · EAGLE-I<br/>Census · CDC SVI · Texas DSHS")]

  subgraph LX["IBM LinuxONE · IBM z17 (s390x) · Podman containers"]
    subgraph SRV["server container"]
      API["FastAPI + WebSocket<br/>storm clock"]
      ENG["Game engine<br/>(stormgame)"]
      M1["M1 demand forecast<br/>XGBoost"]
      M2["M2 what-if advisor<br/>IBM Snap ML"]
      AN["Turning points +<br/>1,000-storm stress test"]
    end
    LLM["llm container<br/>llama.cpp + IBM Granite 3.3 2B<br/>(big-endian)"]
    DB[("db container<br/>PostgreSQL 16 + pgcrypto<br/>1,000,000 synthetic records")]
    AI["ai container<br/>training jobs"]
    VOL[("LUKS2 AES-XTS volume")]
    TEL{{"Telum II<br/>on-chip AI accelerator"}}
    CPA{{"CPACF<br/>crypto unit"}}
  end

  B <-->|"WebSocket: state out, actions in"| API
  BOX <-->|"USB serial"| BR
  BR <-->|"WebSocket"| API
  API --> ENG
  ENG --> M1
  ENG --> M2
  ENG --> AN
  M2 -->|"zDNN (zdnn_tensors)"| TEL
  API -->|"alert text, debrief"| LLM
  API -->|"encrypted record counts"| DB
  DB --- VOL
  VOL -->|"AES-XTS"| CPA
  DATA --> AI
  AI -->|"trained models"| SRV

  classDef ibm fill:#d0e2ff,stroke:#0f62fe,stroke-width:2px,color:#001141
  class TEL,CPA ibm
```

## Solution flow: one game, start to finish

The AI advises at every critical moment; the player decides. If the cut falls more than 20 percent short of the order, the clock stops until the player cuts enough, so the grid never collapses before anyone can react.

```mermaid
---
config:
  look: classic
  theme: default
---
flowchart TD
  A(["Open the game"]) --> B["Get ready<br/>spend 10 points: generators, warming centers,<br/>gas kept flowing, repair crews, smart switches"]
  B --> C["Start the storm<br/>Sun 18:00 to Fri 12:00 on real Dallas temperatures"]
  C --> D["Engine step: 5 game minutes<br/>cut order, homes cooling, ice, generator fuel"]
  D --> E{"Critical moment?<br/>hospital, water or gas at risk,<br/>order rising, homes getting cold"}
  E -->|yes| F["Decision card, game paused<br/>M2 on Telum: AI pick and effect of each option<br/>IBM Granite: number-checked alert"]
  F --> G["Player decides<br/>click, or the red button on the box"]
  G --> D
  E -->|no| H{"Cut more than 20 percent<br/>short of the order?"}
  H -->|yes| I["Clock stops until<br/>the player cuts enough"]
  I --> D
  H -->|no| J["Player cuts and restores<br/>neighborhoods on the map"]
  J --> K{"Storm over?"}
  K -->|no| D
  K -->|yes| L["Report<br/>estimated deaths vs the 22 confirmed in 2021<br/>turning points from replays · plan on 1,000 storms<br/>IBM Granite debrief"]

  classDef ai fill:#d0e2ff,stroke:#0f62fe,stroke-width:2px,color:#001141
  class F,L ai
```

## From public data to real-time AI

```mermaid
---
config:
  look: classic
  theme: default
---
flowchart LR
  subgraph S1["1 · Public data"]
    D1["EIA-930 ERCOT demand"]
    D2["Open-Meteo temperatures"]
    D3["EAGLE-I outages"]
    D4["Census tracts · CDC SVI"]
    D5["Texas DSHS deaths"]
  end
  subgraph S2["2 · Train on LinuxONE"]
    T1["M1: XGBoost<br/>47,232 hours of demand"]
    T2["M2: IBM Snap ML<br/>60,286 rollouts from 1,500 engine games"]
    T3["IBM Granite 3.3 2B<br/>converted to big-endian GGUF"]
  end
  subgraph S3["3 · Serve in the game"]
    R1["M1: demand every game hour"]
    R2["M2 on Telum: every decision card"]
    R3["Granite: alerts and debrief,<br/>number-checked"]
    R4["Engine replays across all cores"]
  end
  subgraph S4["4 · On screen"]
    O1["AI pick and effect<br/>of each option"]
    O2["Estimated deaths vs 22"]
    O3["Turning points ·<br/>1,000-storm plan test"]
  end
  D1 --> T1
  D2 --> T1
  D3 --> T2
  D4 --> T2
  T1 --> R1
  T2 --> R2
  T3 --> R3
  R1 --> O1
  R2 --> O1
  R3 --> O1
  R4 --> O3
  D5 --> O2
  R4 --> O2

  classDef ibm fill:#d0e2ff,stroke:#0f62fe,stroke-width:2px,color:#001141
  class R2 ibm
```
