"""Provenance of an answer shown as a collapsed sub-agent after it, from the same LLM response.

The system prompt asks the model to write `MARKER` on its own line between the answer and its provenance (resources
chosen, tool calls, derivations, caveats, sources). The text after the marker is sent as the text message of a
`provenance` AG-UI sub-agent, that the chat shows collapsed below the answer, rendered as markdown.
"""

from collections.abc import AsyncIterator
from uuid import uuid4

from ag_ui.core import (
    BaseEvent,
    SubagentFinishedEvent,
    SubagentStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)

MARKER = "<!--PROVENANCE-->"


def held_back(text: str) -> int:
    """Index of the tail of `text` that could be the start of a marker split across deltas"""
    start = max(0, len(text) - len(MARKER) + 1)
    return next((i for i in range(start, len(text)) if MARKER.startswith(text[i:])), len(text))


async def split_provenance(events: AsyncIterator[BaseEvent]) -> AsyncIterator[BaseEvent]:
    """Turn the text after `MARKER` in each text message into the text message of a provenance sub-agent"""
    buffer = ""
    # Sub-agent run and its message receiving the text, once the marker is found in the current text message
    run_id: str | None = None
    message_id = ""
    async for e in events:
        if isinstance(e, TextMessageStartEvent):
            buffer, run_id = "", None
            yield e
        elif isinstance(e, TextMessageContentEvent) and run_id:
            yield TextMessageContentEvent(message_id=message_id, delta=e.delta, subagent_run_id=run_id)
        elif isinstance(e, TextMessageContentEvent):
            buffer += e.delta
            if MARKER in buffer:
                # End the answer, start the provenance
                answer, _, provenance = buffer.partition(MARKER)
                buffer, run_id, message_id = "", str(uuid4()), str(uuid4())
                if answer.strip():
                    yield TextMessageContentEvent(message_id=e.message_id, delta=answer.rstrip())
                yield TextMessageEndEvent(message_id=e.message_id)
                yield SubagentStartedEvent(subagent_run_id=run_id, name="provenance")
                yield TextMessageStartEvent(message_id=message_id, subagent_run_id=run_id)
                if provenance.strip():
                    yield TextMessageContentEvent(
                        message_id=message_id, delta=provenance.lstrip(), subagent_run_id=run_id
                    )
                continue
            # Stream the text, except a tail that could be the start of the marker
            cut = held_back(buffer)
            if cut:
                yield TextMessageContentEvent(message_id=e.message_id, delta=buffer[:cut])
                buffer = buffer[cut:]
        elif isinstance(e, TextMessageEndEvent) and run_id:
            yield TextMessageEndEvent(message_id=message_id, subagent_run_id=run_id)
            yield SubagentFinishedEvent(subagent_run_id=run_id)
            run_id = None
        elif isinstance(e, TextMessageEndEvent):
            if buffer:
                yield TextMessageContentEvent(message_id=e.message_id, delta=buffer)
                buffer = ""
            yield e
        else:
            yield e
