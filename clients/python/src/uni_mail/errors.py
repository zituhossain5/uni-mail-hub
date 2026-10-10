"""Errors with fixed client-safe messages. Server exception text is never mirrored."""

from typing import Any


class UniMailError(Exception):
    def __init__(
        self,
        status_code: int | None,
        code: str,
        message: str,
        details: Any = None,
        idempotency_key: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details
        self.idempotency_key = idempotency_key


class UniMailConnectionError(UniMailError):
    def __init__(self, idempotency_key: str | None = None) -> None:
        super().__init__(None, "NETWORK_ERROR", "Could not reach Uni Mail Hub. Retry with the same idempotency key.", idempotency_key=idempotency_key)


class UniMailTimeoutError(UniMailConnectionError):
    def __init__(self, idempotency_key: str | None = None) -> None:
        UniMailError.__init__(self, None, "TIMEOUT",
                              "Uni Mail Hub did not respond in time. Retry with the same idempotency key.",
                              idempotency_key=idempotency_key)

