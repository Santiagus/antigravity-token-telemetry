#!/usr/bin/env python3
"""Simulates various Antigravity telemetry metric scenarios for testing status bar rendering and tooltips."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SCENARIOS = {
    "1": {
        "id": "optimal",
        "name": "🟢 Optimal (All Healthy)",
        "description": "Compact context (44k), 90% cache hit, ~1.0s TTFT",
        "data": {
            "model": "Gemini 3.8 Flash",
            "usageMetadata": {
                "promptTokenCount": 43900,
                "candidatesTokenCount": 100,
                "cachedContentTokenCount": 39500,
                "totalTokenCount": 44000
            },
            "metrics": {
                "turnDelta": 4300,
                "turnDeltaFormatted": "+4.3k",
                "cachePercentage": "90%",
                "cachedFormatted": "39.5k (90%) cached",
                "ttft": "~1.0s",
                "cacheHit": True,
                "stepsCount": 42,
                "updatedAt": datetime.now(timezone.utc).isoformat()
            }
        }
    },
    "2": {
        "id": "dilution",
        "name": "🔴 High Context (Attention Dilution Only)",
        "description": "Tokens > 200k (🔴), but Cache 92% (🟢) and TTFT ~1.1s (🟢)",
        "data": {
            "model": "Gemini 3.8 Flash",
            "usageMetadata": {
                "promptTokenCount": 219100,
                "candidatesTokenCount": 900,
                "cachedContentTokenCount": 201500,
                "totalTokenCount": 220000
            },
            "metrics": {
                "turnDelta": 6100,
                "turnDeltaFormatted": "+6.1k",
                "cachePercentage": "92%",
                "cachedFormatted": "201.5k (92%) cached",
                "ttft": "~1.1s",
                "cacheHit": True,
                "stepsCount": 184,
                "updatedAt": datetime.now(timezone.utc).isoformat()
            }
        }
    },
    "3": {
        "id": "critical_all",
        "name": "🛑 Critical All (High Context + Low Cache + High Latency)",
        "description": "Tokens 245k (🔴), Cache 28% (🔴), TTFT ~5.8s (🔴)",
        "data": {
            "model": "Gemini 3.8 Flash",
            "usageMetadata": {
                "promptTokenCount": 243500,
                "candidatesTokenCount": 1500,
                "cachedContentTokenCount": 68000,
                "totalTokenCount": 245000
            },
            "metrics": {
                "turnDelta": 8500,
                "turnDeltaFormatted": "+8.5k",
                "cachePercentage": "28%",
                "cachedFormatted": "68.0k (28%) cached",
                "ttft": "~5.8s",
                "cacheHit": True,
                "stepsCount": 230,
                "updatedAt": datetime.now(timezone.utc).isoformat()
            }
        }
    },
    "4": {
        "id": "cache_invalidation",
        "name": "🔴 Low KV Cache (Prefix Invalidation)",
        "description": "Tokens 35k (🟢), Cache 18% (🔴), TTFT ~1.2s (🟢)",
        "data": {
            "model": "Gemini 3.8 Flash",
            "usageMetadata": {
                "promptTokenCount": 34800,
                "candidatesTokenCount": 200,
                "cachedContentTokenCount": 6200,
                "totalTokenCount": 35000
            },
            "metrics": {
                "turnDelta": 2200,
                "turnDeltaFormatted": "+2.2k",
                "cachePercentage": "18%",
                "cachedFormatted": "6.2k (18%) cached",
                "ttft": "~1.2s",
                "cacheHit": True,
                "stepsCount": 15,
                "updatedAt": datetime.now(timezone.utc).isoformat()
            }
        }
    },
    "5": {
        "id": "latency_stall",
        "name": "🔴 High Latency Stall (Backend / Reasoning Delay)",
        "description": "Tokens 22k (🟢), Cache 88% (🟢), TTFT ~6.4s (🔴)",
        "data": {
            "model": "Gemini 3.8 Flash",
            "usageMetadata": {
                "promptTokenCount": 21800,
                "candidatesTokenCount": 200,
                "cachedContentTokenCount": 19200,
                "totalTokenCount": 22000
            },
            "metrics": {
                "turnDelta": 1100,
                "turnDeltaFormatted": "+1.1k",
                "cachePercentage": "88%",
                "cachedFormatted": "19.2k (88%) cached",
                "ttft": "~6.4s",
                "cacheHit": True,
                "stepsCount": 10,
                "updatedAt": datetime.now(timezone.utc).isoformat()
            }
        }
    },
    "6": {
        "id": "heavy_context",
        "name": "🟡 Heavy Context (Warning Threshold)",
        "description": "Tokens 135k (🟡), Cache 89% (🟢), TTFT ~1.4s (🟢)",
        "data": {
            "model": "Gemini 3.8 Flash",
            "usageMetadata": {
                "promptTokenCount": 134200,
                "candidatesTokenCount": 800,
                "cachedContentTokenCount": 119500,
                "totalTokenCount": 135000
            },
            "metrics": {
                "turnDelta": 4100,
                "turnDeltaFormatted": "+4.1k",
                "cachePercentage": "89%",
                "cachedFormatted": "119.5k (89%) cached",
                "ttft": "~1.4s",
                "cacheHit": True,
                "stepsCount": 95,
                "updatedAt": datetime.now(timezone.utc).isoformat()
            }
        }
    }
}


def apply_scenario(key: str) -> None:
    scenario = None
    for k, v in SCENARIOS.items():
        if k == key or v["id"] == key:
            scenario = v
            break

    if not scenario:
        print(f"Unknown scenario '{key}'. Available:")
        for k, v in SCENARIOS.items():
            print(f"  [{k}] {v['id']} - {v['name']}")
        sys.exit(1)

    repo_root = Path(__file__).resolve().parent.parent
    vdir = repo_root / ".vscode"
    vdir.mkdir(parents=True, exist_ok=True)

    meta_file = vdir / "usage_metadata.json"
    status_file = vdir / "status.txt"

    data = scenario["data"]
    total = data["usageMetadata"]["totalTokenCount"]
    delta = data["metrics"]["turnDeltaFormatted"]
    cache_pct = data["metrics"]["cachePercentage"].replace("%", "")
    ttft = data["metrics"]["ttft"]

    status_line = f"{data['model']} | Tokens {total // 1000}k ({delta}) | {cache_pct}% cache hit | TTFT {ttft}\n"

    with open(meta_file, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    with open(status_file, "w", encoding="utf-8") as f:
        f.write(status_line)

    print(f"✨ Applied Scenario: {scenario['name']}")
    print(f"   Details: {scenario['description']}")
    print(f"   Target:  {meta_file}")
    print("   👉 Check your VS Code Status Bar and hover tooltip now!")


def main() -> None:
    if len(sys.argv) > 1:
        apply_scenario(sys.argv[1].strip().lower())
        return

    print("Antigravity Telemetry Scenario Simulator")
    print("----------------------------------------")
    for k, v in SCENARIOS.items():
        print(f" [{k}] {v['id']:<20} - {v['name']}")
    print("----------------------------------------")
    choice = input("Select scenario [1-6]: ").strip()
    if choice:
        apply_scenario(choice)
    else:
        print("No selection made.")


if __name__ == "__main__":
    main()
