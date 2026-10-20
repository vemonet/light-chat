"""FastAPI app exposing an AG-UI agent using the ExPASy and Excalidraw MCP servers, and a chat UI."""

import os
from typing import Annotated

from fastapi import FastAPI, HTTPException, Request, Response
from light_chat import chat_router, setup_logging
from light_chat.mcp_apps import PROXIED_REQUEST, UIToolset, proxied_response
from pydantic import BeforeValidator, SecretStr
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.ui.ag_ui import AGUIAdapter
from pydantic_settings import BaseSettings, NoDecode

# Logs of all libraries in the uvicorn style, without a line per HTTP request
setup_logging()
# No first-run banner of Pydantic AI
os.environ["PYDANTIC_AI_NO_BANNER"] = "1"

# Comma-separated list in an environment variable, e.g. `a,b`, instead of the JSON parsed by default
CommaList = Annotated[
    list[str],
    NoDecode,
    BeforeValidator(lambda v: [i.strip() for i in v.split(",") if i.strip()] if isinstance(v, str) else v),
]


class Settings(BaseSettings):
    """Configuration from environment variables, named as the fields in upper case, e.g. `MODELS`"""

    # OpenAI-compatible endpoint, with its tool calling models (the first is the default)
    openai_base_url: str = "https://openrouter.ai/api/v1"
    openai_api_key: SecretStr | None = None
    models: CommaList = [
        "deepseek/deepseek-v4.1-flash-1017",
        "mistralai/mistral-large-4-0",
        "anthropic/claude-haiku-5.5",
        "openai/gpt-6-luna",
    ]


settings = Settings()
provider = OpenAIProvider(
    base_url=settings.openai_base_url,
    api_key=settings.openai_api_key.get_secret_value() if settings.openai_api_key else None,
)

# Agent using the tools of the ExPASy and Excalidraw MCP servers, the model is set per request.
# Results of all tools are sent to the chat, which shows the ones with a UI
ui_toolsets = [
    UIToolset("https://chat.expasy.org/mcp/", id="expasy"),
    UIToolset("https://mcp.excalidraw.com/mcp", id="excalidraw"),
]
# Failed tool calls are sent back to the model a few times, e.g. to fix an invalid UniProt query
agent = Agent(toolsets=ui_toolsets, deps_type=str, retries={"tools": 3})


@agent.instructions
def instructions(ctx: RunContext[str]) -> str:
    """One system prompt (some models reject several), with the context sent by the frontend (AG-UI `context`),
    e.g. the state of a widget edited by the user"""
    prompt = (
        "You are a helpful assistant answering questions about proteins using the UniProt tools, "
        "and the SPARQL tools for UniProt, Rhea, Bgee and other SIB resources. "
        "Some tools display interactive UIs to the user, e.g. protein features, 3D structures, search results tables "
        "or Excalidraw diagrams. Prefer them to show features, structures or long lists of proteins, "
        "and do not repeat in text what they show."
    )
    return f"{prompt}\n\n{ctx.deps}" if ctx.deps else prompt


app = FastAPI(title="UniProt agent")


@app.post("/chat")
async def chat(request: Request) -> Response:
    """AG-UI endpoint streaming the agent response, with the model picked in `forwardedProps.model`"""
    body = await request.json()  # cached, the adapter reads the body again
    forwarded = body.get("forwardedProps") or {}
    # MCP request from a widget, e.g. reading its UI resource or calling a tool of its server
    if PROXIED_REQUEST in forwarded:
        return await proxied_response(body, ui_toolsets)
    model = forwarded.get("model") or settings.models[0]
    if model not in settings.models:
        raise HTTPException(400, f"Unknown model {model}, available: {', '.join(settings.models)}")
    context = "\n\n".join(f"{c['description']}:\n{c['value']}" for c in body.get("context") or [])
    return await AGUIAdapter.dispatch_request(
        request, agent=agent, model=OpenAIChatModel(model, provider=provider), deps=context
    )


@app.get("/models")
async def models() -> list[str]:
    """Models available for `/chat`"""
    return settings.models


# Chat UI at `/`, the model picked in the settings is sent in `forwardedProps.model`
app.include_router(
    chat_router(
        path="/",
        # Relative to the page, so it works behind a reverse proxy serving the app under a prefix
        url="chat",
        title="UniProt agent",
        settings={"models": settings.models},
        themeSwitch=True,
        welcome=(
            "## Ask about proteins\nThe agent queries [UniProt](https://www.uniprot.org), "
            "and shows interactive sequence features, variants, 3D structures, annotation matrices and results tables."
        ),
        placeholder="Ask a question",
        examples=[
            # "What is the function of human insulin?",
            # "Which proteins are involved in the human circadian clock?",
            "Where is the E17K mutation of AKT1 relative to its active site? Show the structure",
            "Explore the pathogenic variants of human TP53: where do they cluster?",
            "Show the domains, PTMs and variants of human AKT1",
            "Find the insulin entries of all mammals in UniProt",
            "Compare the functions of the human DNA damage response genes TP53, MDM2, CDKN1A, ATM, CHEK2 and BRCA1",
            "Look up human insulin, IRS1 and GLUT4 in UniProt, then draw an Excalidraw diagram of the insulin signaling pathway",
            # "Look up human insulin, the insulin receptor, IRS1 and GLUT4 in UniProt, then draw an Excalidraw diagram of the insulin signaling pathway: one box per protein with its accession, gene name and length, and arrows showing how the signal flows to glucose uptake, based on their UniProt function descriptions.",
            # add AKT between IRS1 and GLUT4, look it up in UniProt first
        ],
    )
)
