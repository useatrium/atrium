"""Structured JSON logging for Centaur services."""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import UTC, datetime

_RESERVED_LOG_KEYS = {
    "name",
    "msg",
    "args",
    "created",
    "relativeCreated",
    "exc_info",
    "exc_text",
    "stack_info",
    "lineno",
    "funcName",
    "pathname",
    "filename",
    "module",
    "levelno",
    "levelname",
    "msecs",
    "thread",
    "threadName",
    "process",
    "processName",
    "taskName",
    "message",
    "asctime",
}


class JsonFormatter(logging.Formatter):
    """Single-line JSON formatter matching the Centaur logging contract."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self._service = service

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname.lower(),
            "service": self._service,
            "event": getattr(record, "event", record.funcName or record.name),
            "msg": record.getMessage(),
        }
        for k, v in record.__dict__.items():
            if k not in _RESERVED_LOG_KEYS and k not in payload:
                payload[k] = v
        if record.exc_info and record.exc_info[0] is not None:
            payload["stack"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_json_logging(
    service_name: str,
    *,
    level: str | None = None,
    uvicorn: bool = False,
) -> logging.Logger:
    """Configure structured JSON logging for a Centaur service.

    Returns the service logger. When *uvicorn* is ``True``, also redirects
    uvicorn's access/error loggers through the same formatter.
    """
    resolved_level = (level or os.getenv("LOG_LEVEL", "INFO")).upper()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service_name))

    log = logging.getLogger(service_name)
    log.handlers = [handler]
    log.setLevel(getattr(logging, resolved_level, logging.INFO))
    log.propagate = False

    if uvicorn:
        uvi_handler = logging.StreamHandler(sys.stdout)
        uvi_handler.setFormatter(JsonFormatter(service_name))
        for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
            uvi_logger = logging.getLogger(name)
            uvi_logger.handlers = [uvi_handler]
            uvi_logger.propagate = False

    return log
