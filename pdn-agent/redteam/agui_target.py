"""Target of garak's `function` generator: sends each probe prompt to the AG-UI `/chat` endpoint of the agent, as the
first message of a new thread, and returns the text of the answer streamed back."""

import json
import uuid

import requests


def chat(
    prompt: str,
    url: str = "http://localhost:8084/chat",
    model: str | None = None,
    effort: str | None = None,
    timeout: int = 300,
) -> list[str | None]:
    """Answer of the agent to one prompt, without the provenance sub-agent message, None if the run failed"""
    # Model and effort picked as in the chat settings, the defaults of the server when not set
    forwarded = {k: v for k, v in {"model": model, "effort": effort}.items() if v}
    body = {
        "threadId": str(uuid.uuid4()),
        "runId": str(uuid.uuid4()),
        "state": {},
        "messages": [{"id": str(uuid.uuid4()), "role": "user", "content": prompt}],
        "tools": [],
        "context": [],
        "forwardedProps": forwarded,
    }
    answer = ""
    with requests.post(url, json=body, headers={"Accept": "text/event-stream"}, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        # Server-sent events, one JSON AG-UI event per `data:` line
        for line in r.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            event = json.loads(line.removeprefix("data:"))
            # Text of the provenance comes in a sub-agent message, it repeats the prompt and the tool results
            if event["type"] == "TEXT_MESSAGE_CONTENT" and not event.get("subagentRunId"):
                answer += event["delta"]
            elif event["type"] == "RUN_ERROR":
                return [None]
    return [answer]
