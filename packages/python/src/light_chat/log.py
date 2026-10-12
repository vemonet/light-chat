"""Logging of all libraries in the style of the FastAPI CLI and uvicorn: `INFO:     message`."""

import logging
import sys

__all__ = ["LogFormatter", "setup_logging"]

# Level colors of uvicorn
COLORS = {"DEBUG": "36", "INFO": "32", "WARNING": "33", "ERROR": "31", "CRITICAL": "91"}
# Loggers of each HTTP request: outgoing ones of httpx (OpenAI, Anthropic, MCP clients...), and the server access log
REQUEST_LOGGERS = ("httpx", "httpx2", "uvicorn.access")


class LogFormatter(logging.Formatter):
    """Level name padded like uvicorn, colored when the output is a terminal"""

    def __init__(self, use_colors: bool | None = None) -> None:
        super().__init__("%(levelprefix)s %(message)s")
        self.use_colors = sys.stderr.isatty() if use_colors is None else use_colors

    def formatMessage(self, record: logging.LogRecord) -> str:
        name = record.levelname
        level = f"\033[{COLORS[name]}m{name}\033[0m" if self.use_colors and name in COLORS else name
        record.levelprefix = f"{level}:" + " " * (8 - len(name))
        return super().formatMessage(record)


def setup_logging(level: int | str = logging.INFO, request_logs: bool = False) -> None:
    """Send the logs of all libraries to stderr in the uvicorn style, replacing handlers set before (e.g. by the MCP
    SDK). Logs of each HTTP request are hidden, unless `request_logs` is set"""
    handler = logging.StreamHandler()
    handler.setFormatter(LogFormatter())
    logging.basicConfig(level=level, handlers=[handler], force=True)
    for name in REQUEST_LOGGERS:
        logging.getLogger(name).setLevel(logging.NOTSET if request_logs else logging.WARNING)
