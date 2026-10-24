"""Serve the light-chat UI from a FastAPI app."""

import html
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from fastapi.responses import FileResponse, HTMLResponse

from light_chat.log import setup_logging

__all__ = ["chat_router", "setup_logging"]

# Bundled ESM build of the JS package, copied here by `vp run build:py`
JS_FILE = Path(__file__).parent / "static" / "light-chat.js"

PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>{title}</title>{icon}
    <style>
      html,
      body {{
        margin: 0;
        height: 100%;
        color-scheme: light dark;
      }}
    </style>
  </head>
  <body>
    <div id="chat" style="height: 100%"></div>
    <script type="module">
      import {{ Chat }} from "./light-chat.js";
      new Chat("chat", {options});
    </script>
  </body>
</html>
"""


def chat_router(
    path: str = "/", url: str = "chat", title: str = "Chat", favicon: str | None = None, **options: Any
) -> APIRouter:
    """Router serving the chat page at `path`, connected to the AG-UI endpoint at `url`.

    A relative `url` resolves against the page, so it keeps the prefix of an app served behind a reverse proxy,
    e.g. `chat` for a page at `https://example.org/agent/` targets `https://example.org/agent/chat`.
    `favicon` is the URL of the icon of the page, relative to the page like `url`, e.g. `favicon.ico`.
    Extra keyword arguments are passed as options of the JS `Chat`, e.g. `welcome`, `examples`, `settings`.
    The script is served next to the page, e.g. `/light-chat.js` for `/` or `/ui/light-chat.js` for `/ui/`.
    """
    if not JS_FILE.exists():
        raise FileNotFoundError(f"{JS_FILE} is missing, build it from the repo root with `vp run build:py`")
    # Page built once, `<` escaped so option values cannot close the script tag
    options_json = json.dumps({"url": url, **options}).replace("<", "\\u003c")
    icon = f'\n    <link rel="icon" href="{html.escape(favicon)}" />' if favicon else ""
    page = PAGE.format(title=html.escape(title), icon=icon, options=options_json)
    js_path = f"{path.rsplit('/', 1)[0]}/light-chat.js"

    router = APIRouter(include_in_schema=False)

    @router.get(path, response_class=HTMLResponse)
    async def chat_page() -> str:
        return page

    @router.get(js_path)
    async def chat_script() -> FileResponse:
        return FileResponse(JS_FILE, media_type="text/javascript")

    return router
