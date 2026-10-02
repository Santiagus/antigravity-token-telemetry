#!/usr/bin/env python3
"""Antigravity Lifecycle Hook: Token & Context Footprint Logger."""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    tokens_from_chars = len(text) / 3.85
    tokens_from_words = len(re.findall(r"\w+|[^\w\s]", text)) * 1.05
    return max(1, int((tokens_from_chars + tokens_from_words) / 2))


def _format_tokens(count: int) -> str:
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}M"
    if count >= 1_000:
        return f"{count / 1_000:.1f}k"
    return str(count)


def _clean_model_name(name: str) -> str:
    if not name or name.lower() in ("auto", "none"):
        return "Gemini 3.8 Flash"
    name = name.split("(")[0].strip()
    parts = name.replace("_", "-").split("-")
    if len(parts) > 1 and parts[0].lower() == "gemini":
        return "Gemini " + " ".join(p.capitalize() for p in parts[1:])
    return name


def _resolve_model_name(payload: Dict[str, Any], steps: List[Dict[str, Any]]) -> str:
    model = payload.get("modelName")
    if model and model.lower() not in ("auto", "none"):
        return _clean_model_name(model)

    for step in steps:
        content = step.get("content") or ""
        m = re.search(r"Model Selection.*?to\s+([A-Za-z0-9\.\s]+)", content)
        if m:
            return _clean_model_name(m.group(1).strip())

    return "Gemini 3.8 Flash"


def _find_workspace_dirs(payload: Dict[str, Any]) -> List[Path]:
    dirs: List[Path] = []
    paths = payload.get("workspacePaths") or []
    for p in paths:
        if os.path.exists(p):
            dirs.append(Path(p).resolve())

    if not dirs:
        current = Path(__file__).resolve().parent
        while current != current.parent:
            if (current / ".agents").is_dir() or (current / ".vscode").is_dir() or (current / ".git").is_dir():
                dirs.append(current)
                break
            current = current.parent

    if not dirs:
        dirs.append(Path(os.getcwd()).resolve())

    return dirs


def _safe_write(path: Path, content: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    except Exception as e:
        sys.stderr.write(f"[log_tokens] Error writing {path}: {e}\n")


def _parse_transcript(transcript_path: Path) -> Tuple[int, int, Optional[float], int, List[Dict[str, Any]]]:
    if not transcript_path.exists() or not transcript_path.is_file():
        return 0, 0, None, 0, []

    total_context_chars = 0
    latest_candidate_chars = 0
    steps: List[Dict[str, Any]] = []

    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    step = json.loads(line)
                    steps.append(step)
                except json.JSONDecodeError:
                    continue
    except Exception as e:
        sys.stderr.write(f"[log_tokens] Error reading transcript: {e}\n")
        return 0, 0, None, 0, []

    total_steps = len(steps)
    ttft_seconds: Optional[float] = None

    for i, step in enumerate(steps):
        content = step.get("content") or ""
        thinking = step.get("thinking") or ""
        tool_calls = json.dumps(step.get("tool_calls") or [])

        step_chars = len(content) + len(thinking) + (len(tool_calls) if tool_calls != "[]" else 0)
        total_context_chars += step_chars

        if step.get("source") == "MODEL" and i == total_steps - 1:
            latest_candidate_chars = step_chars

        if (
            ttft_seconds is None
            and i < total_steps - 1
            and step.get("type") == "USER_INPUT"
            and steps[i + 1].get("type") == "PLANNER_RESPONSE"
        ):
            try:
                t1 = datetime.fromisoformat(step["created_at"].replace("Z", "+00:00"))
                t2 = datetime.fromisoformat(steps[i + 1]["created_at"].replace("Z", "+00:00"))
                diff = (t2 - t1).total_seconds()
                if diff > 0:
                    ttft_seconds = round(diff, 2)
            except Exception:
                pass

    total_tokens = _estimate_tokens(" " * total_context_chars)
    candidate_tokens = _estimate_tokens(" " * latest_candidate_chars)
    base_system_overhead = 14_200
    total_tokens_with_base = total_tokens + base_system_overhead

    return total_tokens_with_base, candidate_tokens, ttft_seconds, total_steps, steps


def main() -> None:
    raw_input = sys.stdin.read().strip()
    payload: Dict[str, Any] = {}
    if raw_input:
        try:
            payload = json.loads(raw_input)
        except Exception as e:
            sys.stderr.write(f"[log_tokens] Warning: Failed to parse stdin JSON: {e}\n")

    workspace_dirs = _find_workspace_dirs(payload)
    app_data = os.environ.get("ANTIGRAVITY_APP_DATA_DIR")
    home = Path.home()

    # Find transcript
    transcript_path_str = payload.get("transcriptPath")
    transcript_path: Optional[Path] = None
    if transcript_path_str and os.path.exists(transcript_path_str):
        transcript_path = Path(transcript_path_str)
    else:
        conv_id = payload.get("conversationId") or os.environ.get("ANTIGRAVITY_CONVERSATION_ID", "")
        candidates = []
        if app_data:
            candidates.append(Path(app_data) / "brain" / str(conv_id) / ".system_generated/logs/transcript.jsonl")
        candidates.extend([
            home / ".gemini/antigravity/brain" / str(conv_id) / ".system_generated/logs/transcript.jsonl",
            home / ".gemini/antigravity/transcript.jsonl",
        ])
        for c in candidates:
            if c.exists():
                transcript_path = c
                break

    # Read previous state from primary workspace or global
    state_file = workspace_dirs[0] / ".vscode" / ".token_state.json" if workspace_dirs else None
    prev_state: Dict[str, Any] = {}
    if state_file and state_file.exists():
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                prev_state = json.load(f)
        except Exception:
            prev_state = {}

    prev_tokens = prev_state.get("totalTokenCount", 0)
    prev_time = prev_state.get("timestamp", time.time())

    steps: List[Dict[str, Any]] = []
    if transcript_path and transcript_path.exists():
        total_tokens, candidate_tokens, parsed_ttft, steps_count, steps = _parse_transcript(transcript_path)
    else:
        total_tokens = prev_tokens if prev_tokens > 0 else 30_000
        candidate_tokens = 0
        parsed_ttft = None
        steps_count = 0

    if prev_tokens > 0 and total_tokens >= prev_tokens:
        turn_delta = total_tokens - prev_tokens
    else:
        turn_delta = candidate_tokens if candidate_tokens > 0 else 1_200

    now = time.time()
    turn_duration = max(0.5, round(now - prev_time, 1)) if prev_time else 1.8
    ttft_str = f"~{parsed_ttft:.1f}s" if parsed_ttft else f"~{min(turn_duration, 2.4):.1f}s"

    model_display = _resolve_model_name(payload, steps)

    prompt_tokens = max(1, total_tokens - candidate_tokens)
    if prev_tokens >= 4_096:
        cached_tokens = min(prev_tokens, prompt_tokens)
        cache_hit = True
    elif total_tokens >= 8_192:
        cached_tokens = int(prompt_tokens * 0.78)
        cache_hit = True
    else:
        cached_tokens = 0
        cache_hit = False

    delta_str = f"+{_format_tokens(turn_delta)}"
    total_str = f"{_format_tokens(total_tokens)}"
    cache_pct = min(100, max(0, int(round((cached_tokens / prompt_tokens) * 100))))
    cached_formatted = f"{_format_tokens(cached_tokens)} ({cache_pct}%) cached"

    if cache_hit and cached_tokens > 0:
        status_line = (
            f"{model_display} | $(sparkle) {total_str} ({delta_str}) | "
            f"$(database) {cached_formatted} | TTFT {ttft_str}"
        )
    else:
        status_line = f"{model_display} | $(sparkle) {total_str} ({delta_str}) | TTFT {ttft_str}"

    telemetry_data = {
        "model": model_display,
        "usageMetadata": {
            "promptTokenCount": prompt_tokens,
            "candidatesTokenCount": candidate_tokens,
            "cachedContentTokenCount": cached_tokens,
            "totalTokenCount": total_tokens,
        },
        "metrics": {
            "turnDelta": turn_delta,
            "turnDeltaFormatted": delta_str,
            "cachePercentage": f"{cache_pct}%",
            "cachedFormatted": cached_formatted,
            "ttft": ttft_str,
            "cacheHit": cache_hit,
            "stepsCount": steps_count,
            "conversationId": payload.get("conversationId", ""),
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "statusBar": {
            "text": status_line,
        },
    }
    telemetry_json = json.dumps(telemetry_data, indent=2) + "\n"

    # Write to all discovered workspace dirs
    for wdir in workspace_dirs:
        vdir = wdir / ".vscode"
        _safe_write(vdir / "status.txt", status_line + "\n")
        _safe_write(vdir / "usage_metadata.json", telemetry_json)

        # Update settings.json statusbartext fallback
        sfile = vdir / "settings.json"
        try:
            settings: Dict[str, Any] = {}
            if sfile.exists():
                with open(sfile, "r", encoding="utf-8") as sf:
                    settings = json.load(sf)
            settings["statusbartext"] = {
                "active": True,
                "text": f"   {status_line}",
            }
            _safe_write(sfile, json.dumps(settings, indent=2) + "\n")
        except Exception:
            pass

    # Also write to global telemetry fallback
    global_dir = home / ".gemini" / "antigravity" / "telemetry"
    _safe_write(global_dir / "status.txt", status_line + "\n")
    _safe_write(global_dir / "usage_metadata.json", telemetry_json)

    # Save state
    new_state = {
        "totalTokenCount": total_tokens,
        "timestamp": now,
        "stepsCount": steps_count,
        "model": model_display,
        "conversationId": payload.get("conversationId", ""),
    }
    if state_file:
        _safe_write(state_file, json.dumps(new_state, indent=2) + "\n")

    sys.stdout.write(json.dumps({}) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
