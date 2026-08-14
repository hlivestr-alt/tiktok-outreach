#!/usr/bin/env python3
"""Standalone TikTok Marketplace Search throttle characterization tool.

This file intentionally uses only the Python standard library and has no
dependency on the Outreach application, its database, Redis, BullMQ, Prisma,
Docker, or environment-provided TikTok credentials.
"""

from __future__ import annotations

import argparse
import csv
import errno
import hashlib
import hmac
import json
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

try:
    import msvcrt
except ImportError:  # pragma: no cover - Windows is the deployment platform
    msvcrt = None
try:
    import fcntl
except ImportError:  # pragma: no cover - Unix fallback is not used on Windows
    fcntl = None


API_BASE = "https://open-api.tiktokglobalshop.com"
MARKETPLACE_PATH = "/affiliate_seller/202508/marketplace_creators/search"
VALIDATION_ENV_FILE = Path(r"C:\Data\tiktok-outreach-validation.env")
PAGE_SIZE = 20
DEFAULT_MAX_PAGES = 20
DEFAULT_DELAY_MS = 3000
RECOVERY_BACKOFF_HOURS = (1, 2, 4, 8)
CONTINUATION_INTERVAL_SECONDS = (3600, 1800, 900, 300, 120, 60, 30, 15, 5, 3)
FRESH_SEARCH_INTERVAL_SECONDS = (3600, 1800, 900, 300, 120, 60)
AUTO_SUCCESSES_PER_TIER = 3
DEFAULT_MAX_RUNTIME_HOURS = 24.0
DEFAULT_MAX_REQUESTS = 100
AUTO_SLEEP_CHUNK_SECONDS = 30.0
AUTO_LOCK_NAME = ".auto-characterize.lock"
RESULTS_ROOT = Path(__file__).resolve().parent / "marketplace-throttle-results"

REQUEST_LOG_FIELDS = (
    "local_timestamp",
    "utc_timestamp",
    "test_run_id",
    "request_number",
    "search_session_id",
    "request_type",
    "page_number",
    "page_size",
    "seconds_since_previous_request",
    "HTTP_status",
    "provider_code",
    "provider_message",
    "request_id",
    "duration_ms",
    "creators_returned",
    "search_key_returned",
    "next_page_token_returned",
    "throttle",
    "retry_performed",
)

SENSITIVE_FIELD_NAMES = {
    "app_key",
    "app_secret",
    "access_token",
    "seller_access_token",
    "x-tts-access-token",
    "shop_cipher",
    "sign",
    "signature",
}

VALIDATION_ENV_KEYS = {
    "TIKTOK_VALIDATION_APP_KEY": "app_key",
    "TIKTOK_VALIDATION_APP_SECRET": "app_secret",
    "TIKTOK_VALIDATION_ACCESS_TOKEN": "access_token",
    "TIKTOK_VALIDATION_SHOP_CIPHER": "shop_cipher",
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_local(value: datetime) -> str:
    return value.astimezone().isoformat(timespec="milliseconds")


def parse_datetime(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def format_console_timestamp(value: Any) -> str:
    parsed = parse_datetime(value)
    if parsed is None:
        return "UNKNOWN"
    rendered = parsed.astimezone().strftime("%Y-%m-%d %H:%M:%S %z")
    return f"{rendered[:-2]}:{rendered[-2:]}"


def serialize_body(body: Mapping[str, Any]) -> str:
    """Serialize exactly once; this exact text is both signed and transmitted."""
    return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


def sign_tiktok_shop_request(
    path: str,
    query: Mapping[str, Any],
    body_text: str,
    app_secret: str,
    content_type: str = "application/json",
) -> str:
    """TikTok Shop HMAC-SHA256 canonical request signing."""
    parameter_string = "".join(
        f"{key}{value}"
        for key, value in sorted(query.items())
        if key not in {"sign", "access_token"} and value is not None
    )
    included_body = "" if content_type.lower() == "multipart/form-data" else body_text
    canonical = f"{path}{parameter_string}{included_body}"
    wrapped = f"{app_secret}{canonical}{app_secret}"
    return hmac.new(app_secret.encode("utf-8"), wrapped.encode("utf-8"), hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class Credentials:
    app_key: str
    app_secret: str
    access_token: str
    shop_cipher: str


@dataclass
class PhysicalResponse:
    http_status: Optional[int]
    payload: Any
    response_text: str
    response_headers: dict[str, str]
    duration_ms: int
    network_error: Optional[str] = None


Transport = Callable[[Request], tuple[int, bytes, Mapping[str, str]]]


def urllib_transport(request: Request) -> tuple[int, bytes, Mapping[str, str]]:
    try:
        with urlopen(request, timeout=60) as response:  # nosec: URL is the fixed TikTok API base
            return response.status, response.read(), dict(response.headers.items())
    except HTTPError as error:
        return error.code, error.read(), dict(error.headers.items())


class TikTokMarketplaceClient:
    def __init__(
        self,
        credentials: Credentials,
        api_base: str = API_BASE,
        transport: Transport = urllib_transport,
        epoch_seconds: Callable[[], float] = time.time,
    ) -> None:
        self._credentials = credentials
        self._api_base = api_base.rstrip("/")
        self._transport = transport
        self._epoch_seconds = epoch_seconds

    def search(self, body: Mapping[str, Any], page_token: Optional[str] = None) -> PhysicalResponse:
        body_text = serialize_body(body)
        query: dict[str, Any] = {
            "app_key": self._credentials.app_key,
            "page_size": PAGE_SIZE,
            "shop_cipher": self._credentials.shop_cipher,
            "timestamp": int(self._epoch_seconds()),
        }
        if page_token is not None:
            query["page_token"] = page_token
        signature = sign_tiktok_shop_request(
            MARKETPLACE_PATH, query, body_text, self._credentials.app_secret
        )
        url = f"{self._api_base}{MARKETPLACE_PATH}?{urlencode({**query, 'sign': signature})}"
        request = Request(
            url,
            data=body_text.encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "x-tts-access-token": self._credentials.access_token,
            },
        )
        started = time.perf_counter()
        try:
            status, raw_bytes, headers = self._transport(request)
            duration_ms = round((time.perf_counter() - started) * 1000)
            response_text = raw_bytes.decode("utf-8", errors="replace")
            try:
                payload = json.loads(response_text)
            except json.JSONDecodeError:
                payload = None
            return PhysicalResponse(status, payload, response_text, dict(headers), duration_ms)
        except (URLError, OSError, TimeoutError) as error:
            duration_ms = round((time.perf_counter() - started) * 1000)
            return PhysicalResponse(None, None, "", {}, duration_ms, str(error))


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def provider_code(payload: Any) -> Optional[int]:
    raw = _mapping(payload).get("code")
    if isinstance(raw, bool):
        return None
    try:
        return int(raw) if raw is not None and str(raw).strip() else None
    except (TypeError, ValueError):
        return None


def response_data(payload: Any) -> dict[str, Any]:
    return _mapping(_mapping(payload).get("data"))


def response_creators(payload: Any) -> list[Any]:
    creators = response_data(payload).get("creators")
    return creators if isinstance(creators, list) else []


def nonempty_string(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value != "" else None


def is_success(response: PhysicalResponse) -> bool:
    return response.http_status is not None and 200 <= response.http_status < 300 and provider_code(response.payload) == 0


def is_throttle(response: PhysicalResponse) -> bool:
    return response.http_status == 429 or provider_code(response.payload) == 36009002


def strongest_creator_identifier(creator: Any) -> tuple[str, str]:
    if isinstance(creator, dict):
        for field in ("creator_open_id", "creator_id", "creator_user_id", "creator_im_id"):
            value = creator.get(field)
            if isinstance(value, (str, int)) and str(value):
                return field, str(value)
    canonical = json.dumps(creator, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return "object_sha256", hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def contains_sensitive_key(value: Any) -> bool:
    if isinstance(value, dict):
        return any(str(key).lower() in SENSITIVE_FIELD_NAMES or contains_sensitive_key(child) for key, child in value.items())
    if isinstance(value, list):
        return any(contains_sensitive_key(item) for item in value)
    return False


def sanitize_response_for_log(
    value: Any, sensitive_values: tuple[str, ...] = (), preserve_creator: bool = False
) -> Any:
    """Remove credential-shaped provider fields while preserving creator objects verbatim."""
    if preserve_creator:
        return value
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, child in value.items():
            if str(key).lower() in SENSITIVE_FIELD_NAMES:
                cleaned[key] = "[REDACTED]"
            elif key == "creators" and isinstance(child, list):
                cleaned[key] = [sanitize_response_for_log(item, sensitive_values, preserve_creator=True) for item in child]
            else:
                cleaned[key] = sanitize_response_for_log(child, sensitive_values)
        return cleaned
    if isinstance(value, list):
        return [sanitize_response_for_log(item, sensitive_values) for item in value]
    if isinstance(value, str):
        cleaned_text = value
        for secret in sensitive_values:
            if secret:
                cleaned_text = cleaned_text.replace(secret, "[REDACTED]")
        return cleaned_text
    return value


def calculate_recovery_due(last_throttle: datetime, consecutive_throttles: int) -> datetime:
    tier = RECOVERY_BACKOFF_HOURS[min(max(consecutive_throttles, 1) - 1, len(RECOVERY_BACKOFF_HOURS) - 1)]
    return last_throttle + timedelta(hours=tier)


def default_state() -> dict[str, Any]:
    return {
        "last_request_time": None,
        "last_HTTP_status": None,
        "last_request_successful": False,
        "last_request_throttled": False,
        "last_provider_code": None,
        "consecutive_throttle_count": 0,
        "current_search_key": None,
        "current_next_page_token": None,
        "current_page_number": 0,
        "current_search_session": None,
        "recommended_next_recovery_test_time": None,
        "last_throttle_time": None,
        "auto_characterize": None,
    }


def load_latest_state(results_root: Path) -> dict[str, Any]:
    if not results_root.exists():
        return default_state()
    candidates = sorted(results_root.glob("*/session_state.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    for candidate in candidates:
        try:
            loaded = json.loads(candidate.read_text(encoding="utf-8"))
            if isinstance(loaded, dict) and not contains_sensitive_key(loaded):
                return {**default_state(), **loaded}
        except (OSError, json.JSONDecodeError):
            continue
    return default_state()


def find_latest_auto_run(results_root: Path) -> tuple[Optional[Path], Optional[dict[str, Any]]]:
    if not results_root.exists():
        return None, None
    candidates = sorted(results_root.glob("*/session_state.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    for candidate in candidates:
        try:
            loaded = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        auto = loaded.get("auto_characterize") if isinstance(loaded, dict) else None
        if isinstance(auto, dict) and auto.get("version") == 1 and auto.get("phase") != "COMPLETE" and not contains_sensitive_key(loaded):
            return candidate.parent, {**default_state(), **loaded}
    return None, None


class AutoRunLock:
    """Cross-platform advisory lock preventing concurrent unattended processes."""

    def __init__(self, results_root: Path) -> None:
        self.path = results_root / AUTO_LOCK_NAME
        self._handle: Any = None

    def __enter__(self) -> "AutoRunLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = self.path.open("a+b")
        try:
            self._handle.write(b"0")
            self._handle.flush()
            self._handle.seek(0)
            if msvcrt is not None:
                msvcrt.locking(self._handle.fileno(), msvcrt.LK_NBLCK, 1)
            elif fcntl is not None:
                fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:  # pragma: no cover
                raise OSError(errno.ENOSYS, "file locking unavailable")
        except OSError:
            self._handle.close()
            self._handle = None
            raise ValueError("another --auto-characterize process is already running") from None
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self._handle is None:
            return
        try:
            self._handle.seek(0)
            if msvcrt is not None:
                msvcrt.locking(self._handle.fileno(), msvcrt.LK_UNLCK, 1)
            elif fcntl is not None:
                fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        finally:
            self._handle.close()
            self._handle = None


def load_state_from_run(run_directory: Path) -> tuple[Optional[dict[str, Any]], str]:
    """Load and corroborate an exact successful page-1 state from one named run."""
    try:
        resolved = run_directory.expanduser().resolve(strict=True)
    except OSError:
        return None, "the specified run directory does not exist"
    if not resolved.is_dir():
        return None, "the specified path is not a run directory"
    state_path = resolved / "session_state.json"
    request_log_path = resolved / "request_log.csv"
    requests_path = resolved / "requests.jsonl"
    summary_path = resolved / "summary.json"
    if not all(path.is_file() for path in (state_path, request_log_path, requests_path, summary_path)):
        return None, "the specified run is missing required diagnostic evidence files"
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        with request_log_path.open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        request_lines = requests_path.read_text(encoding="utf-8").splitlines()
        requests = [json.loads(line) for line in request_lines if line.strip()]
    except (OSError, UnicodeError, json.JSONDecodeError, csv.Error):
        return None, "the specified run contains unreadable or invalid diagnostic evidence"
    if not isinstance(state, dict) or not isinstance(summary, dict) or contains_sensitive_key(state):
        return None, "the specified run has invalid or unsafe state"
    cursor, reason = resumable_session(state)
    if cursor is None:
        return None, reason
    if cursor["page_number"] != 1:
        return None, "the source state is not the successful page-1 state required by this mode"
    if len(rows) != 1 or len(requests) != 1:
        return None, "the source run is not an exact one-request --single run"
    row = rows[0]
    request_record = requests[0]
    raw_body = _mapping(_mapping(request_record.get("response")).get("raw_body"))
    raw_data = response_data(raw_body)
    try:
        row_http = int(row.get("HTTP_status", ""))
        row_code = int(row.get("provider_code", ""))
        row_page = int(row.get("page_number", ""))
    except (TypeError, ValueError):
        return None, "the source request log does not contain valid success metadata"
    corroborated = (
        summary.get("test_type") == "SINGLE"
        and summary.get("physical_requests") == 1
        and summary.get("successful_requests") == 1
        and summary.get("throttled_requests") == 0
        and row.get("request_type") == "NEW_SEARCH"
        and row_page == 1
        and 200 <= row_http < 300
        and row_code == 0
        and row.get("search_key_returned") == "YES"
        and row.get("next_page_token_returned") == "YES"
        and row.get("search_session_id") == cursor["search_session_id"]
        and request_record.get("request_type") == "NEW_SEARCH"
        and request_record.get("page_number") == 1
        and request_record.get("search_session_id") == cursor["search_session_id"]
        and provider_code(raw_body) == 0
        and nonempty_string(raw_data.get("search_key")) == cursor["search_key"]
        and nonempty_string(raw_data.get("next_page_token")) == cursor["next_page_token"]
    )
    if not corroborated:
        return None, "the source state does not exactly match its successful page-1 evidence"
    return state, ""


def resumable_session(state: Mapping[str, Any]) -> tuple[Optional[dict[str, Any]], str]:
    """Return a validated continuation cursor, or a reason that fails closed."""
    if state.get("last_request_successful") is not True:
        return None, "the saved session's most recent request is not explicitly recorded as successful"
    if state.get("last_request_throttled") is not False:
        return None, "the saved session's most recent request was throttled or has ambiguous throttle state"
    http_status = state.get("last_HTTP_status")
    if isinstance(http_status, bool) or not isinstance(http_status, int) or not 200 <= http_status < 300:
        return None, "the saved session's most recent request has no successful HTTP status"
    code = state.get("last_provider_code")
    try:
        normalized_code = int(code) if code is not None and not isinstance(code, bool) else None
    except (TypeError, ValueError):
        normalized_code = None
    if normalized_code != 0:
        return None, "the saved session's most recent request was not successful (provider code 0)"
    search_key = nonempty_string(state.get("current_search_key"))
    if search_key is None:
        return None, "the saved session has no valid search_key"
    next_page_token = nonempty_string(state.get("current_next_page_token"))
    if next_page_token is None:
        return None, "the saved session has no valid next_page_token"
    search_session_id = nonempty_string(state.get("current_search_session"))
    if search_session_id is None:
        return None, "the saved session has no valid search_session_id"
    page_number = state.get("current_page_number")
    if isinstance(page_number, bool) or not isinstance(page_number, int) or page_number < 1:
        return None, "the saved session has no valid positive page number"
    return {
        "search_key": search_key,
        "next_page_token": next_page_token,
        "search_session_id": search_session_id,
        "page_number": page_number,
    }, ""


def make_output_dir(results_root: Path, now: datetime) -> Path:
    results_root.mkdir(parents=True, exist_ok=True)
    stem = now.astimezone().strftime("%Y-%m-%d_%H%M%S")
    candidate = results_root / stem
    suffix = 2
    while candidate.exists():
        candidate = results_root / f"{stem}_{suffix}"
        suffix += 1
    candidate.mkdir()
    return candidate


class DiagnosticRun:
    def __init__(
        self,
        mode: str,
        client: TikTokMarketplaceClient,
        results_root: Path = RESULTS_ROOT,
        now: Callable[[], datetime] = utc_now,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        initial_state: Optional[dict[str, Any]] = None,
        resume_output_dir: Optional[Path] = None,
    ) -> None:
        self.mode = mode
        self.client = client
        self._now = now
        self._monotonic = monotonic
        self._sleep = sleep
        self.started_at = now()
        self.test_run_id = str(uuid.uuid4())
        self.output_dir = resume_output_dir.resolve() if resume_output_dir else make_output_dir(results_root, self.started_at)
        self.state = {**default_state(), **(initial_state or {})}
        self.request_rows: list[dict[str, Any]] = []
        self.raw_creators: list[dict[str, Any]] = []
        self.dedup: dict[tuple[str, str], dict[str, Any]] = {}
        self.last_request_monotonic: Optional[float] = None
        self.stop_reason = "completed"
        self.first_throttle_request_number: Optional[int] = None
        self.observed_recovery_interval_seconds: Optional[float] = None
        self.configured_spacing_seconds: Optional[float] = None
        credentials = getattr(client, "_credentials", None)
        self._sensitive_values = tuple(
            value
            for value in (
                getattr(credentials, "app_key", ""),
                getattr(credentials, "app_secret", ""),
                getattr(credentials, "access_token", ""),
                getattr(credentials, "shop_cipher", ""),
            )
            if value
        )
        if resume_output_dir:
            self._load_existing_output()
        else:
            (self.output_dir / "requests.jsonl").touch()
            (self.output_dir / "creators_raw.jsonl").touch()
            self._write_request_csv()
            self._write_dedup()
        self.state["test_run_id"] = self.test_run_id
        self._write_state()

    def _load_existing_output(self) -> None:
        if not self.output_dir.is_dir():
            raise ValueError("auto-characterize resume directory is missing")
        try:
            with (self.output_dir / "request_log.csv").open(encoding="utf-8-sig", newline="") as handle:
                self.request_rows = list(csv.DictReader(handle))
            raw_path = self.output_dir / "creators_raw.jsonl"
            self.raw_creators = [json.loads(line) for line in raw_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            dedup_items = json.loads((self.output_dir / "creators_dedup.json").read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError, csv.Error):
            raise ValueError("auto-characterize resume logs are unreadable") from None
        if not isinstance(dedup_items, list):
            raise ValueError("auto-characterize dedup log is invalid")
        self.dedup = {}
        for item in dedup_items:
            if not isinstance(item, dict):
                raise ValueError("auto-characterize dedup log is invalid")
            id_type = nonempty_string(item.get("identifier_type"))
            identifier = nonempty_string(item.get("identifier"))
            if not id_type or not identifier:
                raise ValueError("auto-characterize dedup log is invalid")
            self.dedup[(id_type, identifier)] = item
        persisted_id = nonempty_string(self.state.get("test_run_id"))
        row_ids = {row.get("test_run_id") for row in self.request_rows if row.get("test_run_id")}
        if persisted_id and (not row_ids or row_ids == {persisted_id}):
            self.test_run_id = persisted_id
        elif row_ids and len(row_ids) == 1:
            self.test_run_id = next(iter(row_ids))
        elif self.request_rows:
            raise ValueError("auto-characterize request log has inconsistent run identifiers")

    def _write_json(self, name: str, value: Any) -> None:
        (self.output_dir / name).write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def _append_jsonl(self, name: str, value: Any) -> None:
        with (self.output_dir / name).open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")

    def _write_state(self) -> None:
        if contains_sensitive_key(self.state):
            raise ValueError("Refusing to persist credential-shaped state")
        self._write_json("session_state.json", self.state)

    def _write_request_csv(self) -> None:
        with (self.output_dir / "request_log.csv").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=REQUEST_LOG_FIELDS, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(self.request_rows)

    def _write_dedup(self) -> None:
        self._write_json("creators_dedup.json", list(self.dedup.values()))

    def request(
        self,
        request_type: str,
        page_number: int,
        search_session_id: str,
        body: Mapping[str, Any],
        page_token: Optional[str] = None,
    ) -> PhysicalResponse:
        request_number = len(self.request_rows) + 1
        request_started_mono = self._monotonic()
        if self.last_request_monotonic is None:
            prior_time = parse_datetime(self.state.get("last_request_time"))
            spacing = None if prior_time is None else max(0.0, (self._now() - prior_time).total_seconds())
        else:
            spacing = request_started_mono - self.last_request_monotonic
        self.last_request_monotonic = request_started_mono
        requested_at = self._now()
        response = self.client.search(body, page_token)
        payload = _mapping(response.payload)
        data = response_data(payload)
        creators = response_creators(payload) if is_success(response) else []
        code = provider_code(payload)
        request_id = nonempty_string(payload.get("request_id"))
        if request_id is None:
            request_id = next((v for k, v in response.response_headers.items() if k.lower() == "x-tts-request-id"), None)
        message = payload.get("message")
        if not isinstance(message, str):
            message = response.network_error or ("Non-JSON response" if response.payload is None else "")
        message = sanitize_response_for_log(message, self._sensitive_values)
        throttle = is_throttle(response)
        row = {
            "local_timestamp": iso_local(requested_at),
            "utc_timestamp": iso_utc(requested_at),
            "test_run_id": self.test_run_id,
            "request_number": request_number,
            "search_session_id": search_session_id,
            "request_type": request_type,
            "page_number": page_number,
            "page_size": PAGE_SIZE,
            "seconds_since_previous_request": "" if spacing is None else f"{spacing:.3f}",
            "HTTP_status": "" if response.http_status is None else response.http_status,
            "provider_code": "" if code is None else code,
            "provider_message": message,
            "request_id": request_id or "",
            "duration_ms": response.duration_ms,
            "creators_returned": len(creators),
            "search_key_returned": "YES" if nonempty_string(data.get("search_key")) else "NO",
            "next_page_token_returned": "YES" if nonempty_string(data.get("next_page_token")) else "NO",
            "throttle": "YES" if throttle else "NO",
            "retry_performed": "NO",
        }
        self.request_rows.append(row)
        self._write_request_csv()

        request_record = {
            "local_timestamp": row["local_timestamp"],
            "utc_timestamp": row["utc_timestamp"],
            "test_run_id": self.test_run_id,
            "request_number": request_number,
            "search_session_id": search_session_id,
            "request_type": request_type,
            "page_number": page_number,
            "page_size": PAGE_SIZE,
            "seconds_since_previous_request": spacing,
            "request": {
                "method": "POST",
                "path": MARKETPLACE_PATH,
                "body": dict(body),
                "has_page_token": page_token is not None,
            },
            "response": {
                "http_status": response.http_status,
                "headers": {
                    key: sanitize_response_for_log(value, self._sensitive_values)
                    for key, value in response.response_headers.items()
                    if key.lower() not in SENSITIVE_FIELD_NAMES
                },
                "duration_ms": response.duration_ms,
                "network_error": sanitize_response_for_log(response.network_error, self._sensitive_values),
                "raw_body": sanitize_response_for_log(
                    response.payload if response.payload is not None else response.response_text,
                    self._sensitive_values,
                ),
            },
            "retry_performed": False,
        }
        self._append_jsonl("requests.jsonl", request_record)

        for index, creator in enumerate(creators):
            raw_record = {
                "collected_at": iso_utc(self._now()),
                "test_run_id": self.test_run_id,
                "search_session_id": search_session_id,
                "request_id": request_id,
                "request_number": request_number,
                "page_number": page_number,
                "creator_index_on_page": index,
                "creator": creator,
            }
            self.raw_creators.append(raw_record)
            self._append_jsonl("creators_raw.jsonl", raw_record)
            id_type, id_value = strongest_creator_identifier(creator)
            self.dedup.setdefault(
                (id_type, id_value),
                {
                    "identifier_type": id_type,
                    "identifier": id_value,
                    "first_collected_at": raw_record["collected_at"],
                    "creator": creator,
                },
            )
        self._write_dedup()

        self.state.update(
            {
                "last_request_time": iso_utc(requested_at),
                "last_HTTP_status": response.http_status,
                "last_request_successful": is_success(response),
                "last_request_throttled": throttle,
                "last_provider_code": code,
                "current_search_key": nonempty_string(data.get("search_key")),
                "current_next_page_token": nonempty_string(data.get("next_page_token")),
                "current_page_number": page_number,
                "current_search_session": search_session_id,
            }
        )
        if throttle:
            consecutive = int(self.state.get("consecutive_throttle_count") or 0) + 1
            self.state["consecutive_throttle_count"] = consecutive
            self.state["last_throttle_time"] = iso_utc(requested_at)
            self.state["recommended_next_recovery_test_time"] = iso_utc(
                calculate_recovery_due(requested_at, consecutive)
            )
            if self.first_throttle_request_number is None:
                self.first_throttle_request_number = request_number
        elif is_success(response):
            self.state["consecutive_throttle_count"] = 0
            self.state["recommended_next_recovery_test_time"] = None
        self._write_state()
        return response

    def wait_between_request_starts(self, seconds: float) -> None:
        if self.last_request_monotonic is None:
            return
        remaining = seconds - (self._monotonic() - self.last_request_monotonic)
        if remaining > 0:
            self._sleep(remaining)

    def _handle_stop(self, response: PhysicalResponse) -> bool:
        code = provider_code(response.payload)
        if is_throttle(response):
            self.stop_reason = "throttle"
            due = self.state["recommended_next_recovery_test_time"]
            print(f"Throttle detected; next recommended clean recovery test: {due}")
            return True
        if code == 45101004:
            self.stop_reason = "daily quota reached"
            print("Daily quota reached (45101004).")
            return True
        if code == 106001:
            self.stop_reason = "signature failure"
            print("Signature failure (106001).")
            return True
        if not is_success(response):
            self.stop_reason = "provider or transport error"
            return True
        return False

    def single(self) -> None:
        session_id = str(uuid.uuid4())
        response = self.request("NEW_SEARCH", 1, session_id, {})
        self._handle_stop(response)

    def pagination(self, max_pages: int, delay_ms: int) -> None:
        self.configured_spacing_seconds = delay_ms / 1000.0
        session_id = str(uuid.uuid4())
        response = self.request("NEW_SEARCH", 1, session_id, {})
        if self._handle_stop(response):
            return
        data = response_data(response.payload)
        search_key = nonempty_string(data.get("search_key"))
        page_token = nonempty_string(data.get("next_page_token"))
        if not search_key or not page_token:
            self.stop_reason = "pagination token or search key absent"
            return
        for page_number in range(2, max_pages + 1):
            self.wait_between_request_starts(self.configured_spacing_seconds)
            response = self.request(
                "CONTINUATION", page_number, session_id, {"search_key": search_key}, page_token
            )
            if self._handle_stop(response):
                return
            data = response_data(response.payload)
            next_search_key = nonempty_string(data.get("search_key"))
            next_page_token = nonempty_string(data.get("next_page_token"))
            if not next_search_key or not next_page_token:
                self.stop_reason = "pagination complete or continuation key absent"
                return
            search_key = next_search_key
            page_token = next_page_token
        self.stop_reason = "maximum pages reached"

    def continue_session(self, cursor: Mapping[str, Any], max_pages: int, delay_ms: int) -> None:
        """Continue only the exact validated persisted session; never issue NEW_SEARCH."""
        self.configured_spacing_seconds = delay_ms / 1000.0
        search_key = str(cursor["search_key"])
        page_token = str(cursor["next_page_token"])
        session_id = str(cursor["search_session_id"])
        page_number = int(cursor["page_number"])
        continuation_index = 0
        while page_number < max_pages:
            if continuation_index:
                self.wait_between_request_starts(self.configured_spacing_seconds)
            continuation_index += 1
            page_number += 1
            response = self.request(
                "CONTINUATION",
                page_number,
                session_id,
                {"search_key": search_key},
                page_token,
            )
            if self._handle_stop(response):
                return
            data = response_data(response.payload)
            next_search_key = nonempty_string(data.get("search_key"))
            next_page_token = nonempty_string(data.get("next_page_token"))
            if not next_page_token:
                self.stop_reason = "pagination complete: no next_page_token"
                return
            if not next_search_key:
                self.stop_reason = "continuation search key absent"
                return
            search_key = next_search_key
            page_token = next_page_token
        self.stop_reason = "maximum continuation pages reached"

    def fresh_searches(self, interval_seconds: float, count: int) -> None:
        self.configured_spacing_seconds = interval_seconds
        for index in range(count):
            if index:
                self.wait_between_request_starts(interval_seconds)
            response = self.request("NEW_SEARCH", 1, str(uuid.uuid4()), {})
            if self._handle_stop(response):
                return
        self.stop_reason = "fresh search count reached"

    def recovery_check(self, previous_state: Mapping[str, Any]) -> None:
        last_throttle = parse_datetime(previous_state.get("last_throttle_time"))
        response = self.request("NEW_SEARCH", 1, str(uuid.uuid4()), {})
        if is_success(response) and last_throttle:
            self.observed_recovery_interval_seconds = max(0.0, (self.started_at - last_throttle).total_seconds())
            print(f"Observed recovery interval: {self.observed_recovery_interval_seconds:.0f} seconds")
        self._handle_stop(response)

    def summary(self) -> dict[str, Any]:
        successful = sum(1 for row in self.request_rows if str(row["provider_code"]) == "0" and str(row["HTTP_status"]).isdigit() and 200 <= int(row["HTTP_status"]) < 300)
        throttled = sum(1 for row in self.request_rows if row["throttle"] == "YES")
        summary = {
            "test_type": self.mode,
            "page_size": PAGE_SIZE,
            "physical_requests": len(self.request_rows),
            "successful_requests": successful,
            "throttled_requests": throttled,
            "successful_pages": successful,
            "raw_creator_records": len(self.raw_creators),
            "unique_creators": len(self.dedup),
            "first_request_code": self.request_rows[0]["provider_code"] if self.request_rows else None,
            "last_request_code": self.request_rows[-1]["provider_code"] if self.request_rows else None,
            "configured_spacing_seconds": self.configured_spacing_seconds,
            "search_session_established": any(row["search_key_returned"] == "YES" for row in self.request_rows),
            "first_throttle_request_number": self.first_throttle_request_number,
            "first_throttle_seconds_since_previous_request": next((row["seconds_since_previous_request"] for row in self.request_rows if row["throttle"] == "YES"), None),
            "observed_recovery_interval_seconds": self.observed_recovery_interval_seconds,
            "actual_spacing_seconds": [
                float(row["seconds_since_previous_request"])
                for row in self.request_rows
                if row["seconds_since_previous_request"] != ""
            ],
            "successful_fresh_searches_before_throttle": successful if self.mode == "FRESH_SEARCH_TEST" else None,
            "stop_reason": self.stop_reason,
            "stopped_safely": True,
            "retries": 0,
            "output_directory": str(self.output_dir),
        }
        auto = self.state.get("auto_characterize")
        if isinstance(auto, dict):
            experiment_started = parse_datetime(auto.get("experiment_started_at")) or self.started_at
            summary.update({
                "total_runtime_seconds": max(0.0, (self._now() - experiment_started).total_seconds()),
                "observed_throttle_recovery_intervals_seconds": auto.get("observed_recovery_intervals_seconds", []),
                "fastest_fully_successful_continuation_interval_seconds": auto.get("fastest_fully_successful_continuation_interval_seconds"),
                "first_failed_continuation_interval_seconds": auto.get("first_failed_continuation_interval_seconds"),
                "fastest_fully_successful_new_search_interval_seconds": auto.get("fastest_fully_successful_new_search_interval_seconds"),
                "first_failed_new_search_interval_seconds": auto.get("first_failed_new_search_interval_seconds"),
                "continuation_requests": auto.get("continuation_requests", 0),
                "new_search_requests": auto.get("new_search_requests", 0),
                "results_conclusive": auto.get("phase") == "COMPLETE" and auto.get("result") == "CONCLUSIVE",
                "auto_phase": auto.get("phase"),
                "auto_events": auto.get("events", []),
            })
        self._write_json("summary.json", summary)
        return summary


def recovery_is_due(state: Mapping[str, Any], now: datetime) -> tuple[bool, Optional[datetime]]:
    recommended = parse_datetime(state.get("recommended_next_recovery_test_time"))
    return recommended is None or now >= recommended, recommended


def format_duration(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes}m {secs}s"
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


class AutoCharacterizer:
    """Durable, single-threaded, zero-retry unattended characterization state machine."""

    def __init__(
        self,
        run: DiagnosticRun,
        max_runtime_hours: float,
        max_requests: int,
        now: Callable[[], datetime] = utc_now,
        sleep: Callable[[float], None] = time.sleep,
        sleep_chunk_seconds: float = AUTO_SLEEP_CHUNK_SECONDS,
    ) -> None:
        self.run = run
        self.max_runtime_seconds = max_runtime_hours * 3600
        self.max_requests = max_requests
        self._now = now
        self._sleep = sleep
        self.sleep_chunk_seconds = sleep_chunk_seconds
        self.invocation_started_at = now()
        auto = self.run.state.get("auto_characterize")
        if not isinstance(auto, dict) or auto.get("version") != 1:
            auto = self._new_state()
            self.run.state["auto_characterize"] = auto
            self.run._write_state()
        self.auto = auto

    def _new_state(self) -> dict[str, Any]:
        now = self._now()
        prior_throttle = self.run.state.get("last_request_throttled") is True
        cursor, _ = resumable_session(self.run.state)
        phase = "RECOVERY"
        if prior_throttle:
            due = parse_datetime(self.run.state.get("recommended_next_recovery_test_time")) or now
        elif cursor is not None and cursor["page_number"] < DEFAULT_MAX_PAGES:
            phase = "CONTINUATION"
            last_request = parse_datetime(self.run.state.get("last_request_time")) or now
            due = max(now, last_request + timedelta(seconds=CONTINUATION_INTERVAL_SECONDS[0]))
        else:
            due = now
        return {
            "version": 1,
            "phase": phase,
            "experiment_started_at": iso_utc(now),
            "next_due_time": iso_utc(due or now),
            "pending_action": None,
            "last_applied_request_number": len(self.run.request_rows),
            "continuation_interval_index": 0,
            "continuation_successes_at_tier": 0,
            "fresh_interval_index": 0,
            "fresh_successes_at_tier": 0,
            "fastest_fully_successful_continuation_interval_seconds": None,
            "first_failed_continuation_interval_seconds": None,
            "fastest_fully_successful_new_search_interval_seconds": None,
            "first_failed_new_search_interval_seconds": None,
            "observed_recovery_intervals_seconds": [],
            "recovery_started_at": self.run.state.get("last_throttle_time"),
            "after_recovery": "CONTINUATION",
            "continuation_requests": 0,
            "new_search_requests": 0,
            "session_refreshes": 0,
            "events": [],
            "result": "INCOMPLETE",
        }

    def _persist(self) -> None:
        self.run.state["auto_characterize"] = self.auto
        self.run._write_state()

    def _event(self, name: str, **details: Any) -> None:
        self.auto.setdefault("events", []).append({"at": iso_utc(self._now()), "event": name, **details})

    def _elapsed(self) -> float:
        started = parse_datetime(self.auto.get("experiment_started_at")) or self._now()
        return max(0.0, (self._now() - started).total_seconds())

    def _limit_reached(self) -> bool:
        if len(self.run.request_rows) >= self.max_requests:
            self.run.stop_reason = "maximum physical requests reached"
            return True
        if (self._now() - self.invocation_started_at).total_seconds() >= self.max_runtime_seconds:
            self.run.stop_reason = "maximum runtime reached"
            return True
        return False

    def _wait_until(self, due: datetime) -> bool:
        announced = False
        while self._now() < due:
            if self._limit_reached():
                return False
            remaining_runtime = self.max_runtime_seconds - (self._now() - self.invocation_started_at).total_seconds()
            remaining_due = (due - self._now()).total_seconds()
            if remaining_runtime <= 0:
                self.run.stop_reason = "maximum runtime reached"
                return False
            sleep_for = min(self.sleep_chunk_seconds, remaining_due, remaining_runtime)
            if not announced:
                print(f"Next request in: {format_duration(remaining_due)}")
                announced = True
            self._sleep(max(0.0, sleep_for))
        return not self._limit_reached()

    def _set_due_after(self, seconds: float) -> None:
        self.auto["next_due_time"] = iso_utc(self._now() + timedelta(seconds=seconds))

    def _enter_recovery(self, after_recovery: str) -> None:
        self.auto["phase"] = "RECOVERY"
        self.auto["after_recovery"] = after_recovery
        self.auto["recovery_started_at"] = self.run.state.get("last_throttle_time") or iso_utc(self._now())
        due = parse_datetime(self.run.state.get("recommended_next_recovery_test_time")) or calculate_recovery_due(
            self._now(), int(self.run.state.get("consecutive_throttle_count") or 1)
        )
        self.auto["next_due_time"] = iso_utc(due)

    def _prepare_action(self) -> Optional[dict[str, Any]]:
        phase = self.auto["phase"]
        if phase in {"RECOVERY", "SESSION_REFRESH", "FRESH_SEARCH"}:
            action = {
                "request_number": len(self.run.request_rows) + 1,
                "kind": phase,
                "request_type": "NEW_SEARCH",
                "page_number": 1,
                "search_session_id": str(uuid.uuid4()),
                "body": {},
                "page_token": None,
            }
        elif phase == "CONTINUATION":
            cursor, reason = resumable_session(self.run.state)
            if cursor is None:
                self._event("SEARCH_SESSION_EXHAUSTED", reason=reason)
                self.auto["phase"] = "SESSION_REFRESH"
                safe = self.auto.get("fastest_fully_successful_continuation_interval_seconds") or CONTINUATION_INTERVAL_SECONDS[0]
                self._set_due_after(float(safe))
                self._persist()
                return None
            if cursor["page_number"] >= DEFAULT_MAX_PAGES:
                self._event("SEARCH_SESSION_EXHAUSTED", reason="maximum 20 pages reached")
                self.auto["phase"] = "SESSION_REFRESH"
                safe = self.auto.get("fastest_fully_successful_continuation_interval_seconds") or CONTINUATION_INTERVAL_SECONDS[0]
                self._set_due_after(float(safe))
                self._persist()
                return None
            action = {
                "request_number": len(self.run.request_rows) + 1,
                "kind": phase,
                "request_type": "CONTINUATION",
                "page_number": cursor["page_number"] + 1,
                "search_session_id": cursor["search_session_id"],
                "body": {"search_key": cursor["search_key"]},
                "page_token": cursor["next_page_token"],
            }
        else:
            return None
        self.auto["pending_action"] = action
        self._persist()
        return action

    def _row_success(self, row: Mapping[str, Any]) -> bool:
        try:
            return int(row.get("provider_code", -1)) == 0 and 200 <= int(row.get("HTTP_status", 0)) < 300
        except (TypeError, ValueError):
            return False

    def _row_throttle(self, row: Mapping[str, Any]) -> bool:
        return row.get("throttle") == "YES"

    def _row_session_expired(self, row: Mapping[str, Any]) -> bool:
        message = str(row.get("provider_message") or "").lower()
        names_cursor = any(marker in message for marker in ("search_key", "search key", "page_token", "page token", "session"))
        names_expiry = any(marker in message for marker in ("invalid", "expired", "expire"))
        return names_cursor and names_expiry

    def _print_request_executed(
        self,
        action: Mapping[str, Any],
        row: Mapping[str, Any],
    ) -> None:
        successful = self._row_success(row)
        throttled = self._row_throttle(row)
        if successful:
            result = "SUCCESS"
        elif throttled:
            result = "THROTTLED"
        else:
            result = "ERROR"

        http_status = row.get("HTTP_status")
        provider = row.get("provider_code")
        creators_returned = int(row.get("creators_returned") or 0)
        same_session = (
            successful
            and str(row.get("search_session_id") or "")
            == str(self.run.state.get("current_search_session") or "")
            and bool(self.run.state.get("current_search_key"))
        )

        print("=" * 50)
        print("MARKETPLACE REQUEST EXECUTED")
        print(f"Time: {format_console_timestamp(row.get('local_timestamp'))}")
        print(f"Request #: {row.get('request_number')}")
        print(f"Type: {row.get('request_type')}")
        print(f"Page: {row.get('page_number')}")
        print(f"HTTP: {http_status if http_status not in (None, '') else 'N/A'}")
        print(f"Provider code: {provider if provider not in (None, '') else 'N/A'}")
        print(f"Result: {result}")
        if throttled:
            throttle_count = max(1, int(self.run.state.get("consecutive_throttle_count") or 1))
            recovery_hours = RECOVERY_BACKOFF_HOURS[
                min(throttle_count - 1, len(RECOVERY_BACKOFF_HOURS) - 1)
            ]
            next_due = self.auto.get("next_due_time") or self.run.state.get(
                "recommended_next_recovery_test_time"
            )
            hour_label = "hour" if recovery_hours == 1 else "hours"
            print("Retries: 0")
            print(f"Next recovery tier: {recovery_hours} {hour_label}")
            print(f"Next request: {format_console_timestamp(next_due)}")
        else:
            print(f"Creators returned: {creators_returned}")
            print(f"Raw creators logged: {creators_returned}")
            print(f"Search session preserved: {'YES' if same_session else 'NO'}")
        print("=" * 50)
        print("CUMULATIVE EXPERIMENT STATISTICS")
        print(f"Total physical requests: {len(self.run.request_rows)}")
        print(f"Successful: {sum(1 for item in self.run.request_rows if self._row_success(item))}")
        print(f"Throttled: {sum(1 for item in self.run.request_rows if self._row_throttle(item))}")
        print(f"Raw creators collected: {len(self.run.raw_creators)}")
        print(f"Unique creators collected: {len(self.run.dedup)}")
        print("=" * 50)

    def _apply_outcome(self, action: Mapping[str, Any], row: Mapping[str, Any]) -> None:
        kind = str(action["kind"])
        successful = self._row_success(row)
        throttled = self._row_throttle(row)
        if action["request_type"] == "CONTINUATION":
            self.auto["continuation_requests"] += 1
        else:
            self.auto["new_search_requests"] += 1

        if kind == "RECOVERY":
            if throttled:
                self._enter_recovery(str(self.auto.get("after_recovery") or "CONTINUATION"))
            elif successful:
                started = parse_datetime(self.auto.get("recovery_started_at"))
                if started:
                    self.auto["observed_recovery_intervals_seconds"].append(max(0.0, (self._now() - started).total_seconds()))
                self.auto["recovery_started_at"] = None
                destination = str(self.auto.get("after_recovery") or "CONTINUATION")
                if destination == "COMPLETE":
                    self.auto["phase"] = "COMPLETE"
                    self.auto["result"] = "CONCLUSIVE"
                elif destination == "FRESH_SEARCH":
                    self.auto["phase"] = "FRESH_SEARCH"
                    interval = FRESH_SEARCH_INTERVAL_SECONDS[int(self.auto["fresh_interval_index"])]
                    self._set_due_after(interval)
                else:
                    self.auto["phase"] = "CONTINUATION"
                    interval = CONTINUATION_INTERVAL_SECONDS[int(self.auto["continuation_interval_index"])]
                    self._set_due_after(interval)
            else:
                self.run.stop_reason = "recovery probe provider or transport error"
                self.auto["result"] = "INCOMPLETE"
                self.auto["phase"] = "COMPLETE"

        elif kind == "CONTINUATION":
            interval_index = int(self.auto["continuation_interval_index"])
            interval = CONTINUATION_INTERVAL_SECONDS[interval_index]
            if throttled:
                self.auto["first_failed_continuation_interval_seconds"] = interval
                self._event("CONTINUATION_INTERVAL_FAILED", interval_seconds=interval)
                self._enter_recovery("FRESH_SEARCH")
            elif successful:
                has_cursor = bool(self.run.state.get("current_search_key") and self.run.state.get("current_next_page_token"))
                self.auto["continuation_successes_at_tier"] += 1
                if self.auto["continuation_successes_at_tier"] >= AUTO_SUCCESSES_PER_TIER:
                    self.auto["fastest_fully_successful_continuation_interval_seconds"] = interval
                    self._event("CONTINUATION_INTERVAL_PASSED", interval_seconds=interval)
                    self.auto["continuation_successes_at_tier"] = 0
                    self.auto["continuation_interval_index"] += 1
                    if self.auto["continuation_interval_index"] >= len(CONTINUATION_INTERVAL_SECONDS):
                        self.auto["phase"] = "FRESH_SEARCH"
                        self._set_due_after(FRESH_SEARCH_INTERVAL_SECONDS[0])
                    elif not has_cursor or int(self.run.state.get("current_page_number") or 0) >= DEFAULT_MAX_PAGES:
                        self._event("SEARCH_SESSION_EXHAUSTED", reason="no next_page_token or maximum 20 pages")
                        self.auto["phase"] = "SESSION_REFRESH"
                        self._set_due_after(interval)
                    else:
                        self._set_due_after(CONTINUATION_INTERVAL_SECONDS[int(self.auto["continuation_interval_index"])] )
                elif not has_cursor or int(self.run.state.get("current_page_number") or 0) >= DEFAULT_MAX_PAGES:
                    self._event("SEARCH_SESSION_EXHAUSTED", reason="no next_page_token or maximum 20 pages")
                    self.auto["phase"] = "SESSION_REFRESH"
                    safe = self.auto.get("fastest_fully_successful_continuation_interval_seconds") or interval
                    self._set_due_after(float(safe))
                else:
                    self._set_due_after(interval)
            else:
                if self._row_session_expired(row):
                    self._event("SEARCH_SESSION_EXHAUSTED", reason="invalid or expired continuation response")
                    self.auto["phase"] = "SESSION_REFRESH"
                    safe = self.auto.get("fastest_fully_successful_continuation_interval_seconds") or interval
                    self._set_due_after(float(safe))
                else:
                    self.run.stop_reason = "unexpected continuation provider or transport error"
                    self.auto["result"] = "INCOMPLETE"
                    self.auto["phase"] = "COMPLETE"

        elif kind == "SESSION_REFRESH":
            self.auto["session_refreshes"] += 1
            if successful:
                cursor, reason = resumable_session(self.run.state)
                if cursor is None or cursor["page_number"] >= DEFAULT_MAX_PAGES:
                    self.run.stop_reason = "single permitted session refresh returned no resumable cursor"
                    self._event("SEARCH_SESSION_EXHAUSTED", reason=reason or "maximum 20 pages")
                    self.auto["result"] = "INCOMPLETE"
                    self.auto["phase"] = "COMPLETE"
                else:
                    self.auto["phase"] = "CONTINUATION"
                    interval = CONTINUATION_INTERVAL_SECONDS[int(self.auto["continuation_interval_index"])]
                    self._set_due_after(interval)
            elif throttled:
                self._enter_recovery("CONTINUATION")
            else:
                self.run.stop_reason = "single permitted session refresh failed"
                self.auto["result"] = "INCOMPLETE"
                self.auto["phase"] = "COMPLETE"

        elif kind == "FRESH_SEARCH":
            interval_index = int(self.auto["fresh_interval_index"])
            interval = FRESH_SEARCH_INTERVAL_SECONDS[interval_index]
            if throttled:
                self.auto["first_failed_new_search_interval_seconds"] = interval
                self._event("NEW_SEARCH_INTERVAL_FAILED", interval_seconds=interval)
                self._enter_recovery("COMPLETE")
            elif successful:
                self.auto["fresh_successes_at_tier"] += 1
                if self.auto["fresh_successes_at_tier"] >= AUTO_SUCCESSES_PER_TIER:
                    self.auto["fastest_fully_successful_new_search_interval_seconds"] = interval
                    self._event("NEW_SEARCH_INTERVAL_PASSED", interval_seconds=interval)
                    self.auto["fresh_successes_at_tier"] = 0
                    self.auto["fresh_interval_index"] += 1
                    if self.auto["fresh_interval_index"] >= len(FRESH_SEARCH_INTERVAL_SECONDS):
                        self.auto["phase"] = "COMPLETE"
                        self.auto["result"] = "CONCLUSIVE"
                    else:
                        self._set_due_after(FRESH_SEARCH_INTERVAL_SECONDS[int(self.auto["fresh_interval_index"])] )
                else:
                    self._set_due_after(interval)
            else:
                self.run.stop_reason = "fresh search provider or transport error"
                self.auto["result"] = "INCOMPLETE"
                self.auto["phase"] = "COMPLETE"

        self.auto["last_applied_request_number"] = int(action["request_number"])
        self.auto["pending_action"] = None
        self._persist()

    def _reconcile_or_execute(self) -> None:
        action = self.auto.get("pending_action")
        if not isinstance(action, dict):
            action = self._prepare_action()
            if action is None:
                return
        if action.get("outcome_uncertain") is True:
            self.run.stop_reason = "pending request outcome is uncertain; refusing to repeat"
            self.auto["result"] = "INCOMPLETE"
            self.auto["phase"] = "COMPLETE"
            self._event("REQUEST_OUTCOME_UNCERTAIN", request_number=action.get("request_number"))
            self._persist()
            return
        expected = int(action["request_number"])
        if len(self.run.request_rows) >= expected:
            if len(self.run.request_rows) != expected:
                raise ValueError("auto-characterize log is ahead of its pending action")
            self._apply_outcome(action, self.run.request_rows[expected - 1])
            return
        if len(self.run.request_rows) != expected - 1:
            raise ValueError("auto-characterize pending action does not match request log")
        try:
            self.run.request(
                str(action["request_type"]),
                int(action["page_number"]),
                str(action["search_session_id"]),
                _mapping(action["body"]),
                action.get("page_token"),
            )
        except KeyboardInterrupt:
            action["outcome_uncertain"] = True
            self.auto["pending_action"] = action
            self._persist()
            raise
        row = self.run.request_rows[-1]
        self._apply_outcome(action, row)
        self._print_request_executed(action, row)

    def run_until_exit(self) -> None:
        try:
            while self.auto.get("phase") != "COMPLETE":
                if self._limit_reached():
                    break
                phase = str(self.auto["phase"])
                due = parse_datetime(self.auto.get("next_due_time")) or self._now()
                if phase == "RECOVERY":
                    print("Current state: THROTTLED" if self.auto.get("recovery_started_at") else "Current state: INITIAL_PROBE")
                    print(f"Last result: {self.run.state.get('last_provider_code')}")
                    print(f"Next test: {iso_local(due)}")
                    print(f"Sleeping: {format_duration((due - self._now()).total_seconds())}")
                elif phase == "CONTINUATION":
                    interval = CONTINUATION_INTERVAL_SECONDS[int(self.auto["continuation_interval_index"])]
                    print("Current test: CONTINUATION")
                    print(f"Current interval: {format_duration(interval)}")
                    print(f"Successful at this interval: {self.auto['continuation_successes_at_tier']}/{AUTO_SUCCESSES_PER_TIER}")
                elif phase == "FRESH_SEARCH":
                    interval = FRESH_SEARCH_INTERVAL_SECONDS[int(self.auto["fresh_interval_index"])]
                    print("Current test: NEW_SEARCH")
                    print(f"Current interval: {format_duration(interval)}")
                    print(f"Successful at this interval: {self.auto['fresh_successes_at_tier']}/{AUTO_SUCCESSES_PER_TIER}")
                else:
                    print(f"Current state: {phase}")
                if not self._wait_until(due):
                    break
                self._reconcile_or_execute()
            if self.auto.get("phase") == "COMPLETE" and self.run.stop_reason == "completed":
                self.run.stop_reason = "auto characterization complete"
        except KeyboardInterrupt:
            self.run.stop_reason = "operator interrupted"
            self._event("INTERRUPTED")
            self._persist()
            self.run.summary()
            raise
        finally:
            self._persist()


def _parse_env_value(raw_value: str, line_number: int) -> str:
    value = raw_value.strip()
    if not value:
        return ""
    if value[0] in {'"', "'"}:
        quote = value[0]
        if len(value) < 2 or value[-1] != quote:
            raise ValueError(f"validation env has an unterminated quoted value on line {line_number}")
        return value[1:-1]
    return value


def load_validation_credentials(announce: bool = True) -> Credentials:
    """Read only the fixed external validation file; never consult process environment."""
    path = VALIDATION_ENV_FILE
    try:
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        raise ValueError(f"validation env file is missing: {path}") from None
    except (OSError, UnicodeError):
        raise ValueError(f"validation env file cannot be read: {path}") from None
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if key not in VALIDATION_ENV_KEYS:
            continue
        if key in values:
            raise ValueError(f"validation env contains duplicate required key: {key}")
        values[key] = _parse_env_value(raw_value, line_number)
    missing = [key for key in VALIDATION_ENV_KEYS if key not in values]
    if missing:
        raise ValueError("validation env is missing required key(s): " + ", ".join(missing))
    blank = [key for key in VALIDATION_ENV_KEYS if not values[key].strip()]
    if blank:
        raise ValueError("validation env has blank required value(s): " + ", ".join(blank))
    credentials = Credentials(**{
        field: values[key]
        for key, field in VALIDATION_ENV_KEYS.items()
    })
    if announce:
        print("validation env loaded: YES")
        print("app key present: YES")
        print("app secret present: YES")
        print("access token present: YES")
        print("shop cipher present: YES")
    return credentials


def print_summary(summary: Mapping[str, Any]) -> None:
    labels = (
        ("Test type", "test_type"),
        ("page_size", "page_size"),
        ("physical requests", "physical_requests"),
        ("successful requests", "successful_requests"),
        ("throttled requests", "throttled_requests"),
        ("successful pages", "successful_pages"),
        ("raw creator records", "raw_creator_records"),
        ("unique creators", "unique_creators"),
        ("first request", "first_request_code"),
        ("last request", "last_request_code"),
        ("configured spacing sec", "configured_spacing_seconds"),
        ("actual spacing sec", "actual_spacing_seconds"),
        ("successful fresh searches before throttle", "successful_fresh_searches_before_throttle"),
        ("total runtime sec", "total_runtime_seconds"),
        ("observed throttle recovery intervals sec", "observed_throttle_recovery_intervals_seconds"),
        ("fastest fully successful CONTINUATION interval sec", "fastest_fully_successful_continuation_interval_seconds"),
        ("first failed CONTINUATION interval sec", "first_failed_continuation_interval_seconds"),
        ("fastest fully successful NEW_SEARCH interval sec", "fastest_fully_successful_new_search_interval_seconds"),
        ("first failed NEW_SEARCH interval sec", "first_failed_new_search_interval_seconds"),
        ("results conclusive", "results_conclusive"),
        ("search session established", "search_session_established"),
        ("stopped safely", "stopped_safely"),
        ("retries", "retries"),
    )
    for label, key in labels:
        value = summary.get(key)
        if isinstance(value, bool):
            value = "YES" if value else "NO"
        print(f"{label}: {value}")
    print(f"Output directory: {summary['output_directory']}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    modes = result.add_mutually_exclusive_group(required=True)
    modes.add_argument("--single", action="store_true")
    modes.add_argument("--pagination", action="store_true")
    modes.add_argument("--recovery-check", action="store_true")
    modes.add_argument("--fresh-search-test", action="store_true")
    modes.add_argument("--continue-session", action="store_true")
    modes.add_argument("--continue-from-run", metavar="RUN_DIRECTORY")
    modes.add_argument("--auto-characterize", action="store_true")
    result.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES)
    result.add_argument("--delay-ms", type=int, default=DEFAULT_DELAY_MS)
    result.add_argument("--interval-seconds", type=float)
    result.add_argument("--count", type=int)
    result.add_argument("--max-runtime-hours", type=float, default=DEFAULT_MAX_RUNTIME_HOURS)
    result.add_argument("--max-requests", type=int, default=DEFAULT_MAX_REQUESTS)
    return result


def validate_args(args: argparse.Namespace) -> None:
    if args.max_pages < 1:
        raise ValueError("--max-pages must be at least 1")
    if args.delay_ms < 0:
        raise ValueError("--delay-ms cannot be negative")
    if args.max_runtime_hours <= 0:
        raise ValueError("--max-runtime-hours must be greater than zero")
    if args.max_requests < 1:
        raise ValueError("--max-requests must be at least 1")
    if args.fresh_search_test:
        if args.interval_seconds is None or args.interval_seconds < 0:
            raise ValueError("--fresh-search-test requires --interval-seconds >= 0")
        if args.count is None or args.count < 1:
            raise ValueError("--fresh-search-test requires --count >= 1")


def main(argv: Optional[list[str]] = None) -> int:
    args = parser().parse_args(argv)
    try:
        validate_args(args)
        credentials = load_validation_credentials()
        if args.auto_characterize:
            with AutoRunLock(RESULTS_ROOT):
                resume_dir, resume_state = find_latest_auto_run(RESULTS_ROOT)
                initial_state = resume_state or load_latest_state(RESULTS_ROOT)
                run = DiagnosticRun(
                    "AUTO_CHARACTERIZE",
                    TikTokMarketplaceClient(credentials),
                    initial_state=initial_state,
                    resume_output_dir=resume_dir,
                )
                auto = AutoCharacterizer(run, args.max_runtime_hours, args.max_requests)
                try:
                    auto.run_until_exit()
                except KeyboardInterrupt:
                    print("\nAuto-characterize interrupted safely; state and logs were persisted.", file=sys.stderr)
                    return 130
                print_summary(run.summary())
                return 0
        previous_state = load_latest_state(RESULTS_ROOT)
        continuation_cursor = None
        if args.continue_from_run:
            source_state, reason = load_state_from_run(Path(args.continue_from_run))
            if source_state is None:
                print(f"Continuation unavailable: {reason}.")
                print("No TikTok request was made.")
                return 0
            continuation_cursor, reason = resumable_session(source_state)
            if continuation_cursor is None:
                print(f"Continuation unavailable: {reason}.")
                print("No TikTok request was made.")
                return 0
            previous_state = source_state
        if args.continue_session:
            continuation_cursor, reason = resumable_session(previous_state)
            if continuation_cursor is None:
                print(f"Continuation unavailable: {reason}.")
                print("No TikTok request was made.")
                return 0
        if continuation_cursor is not None and continuation_cursor["page_number"] >= args.max_pages:
            print(
                "Continuation unavailable: the saved page number has already reached "
                "the --max-pages ceiling."
            )
            print("No TikTok request was made.")
            return 0
        if args.recovery_check:
            now = utc_now()
            due, recommended = recovery_is_due(previous_state, now)
            if not due and recommended:
                last = previous_state.get("last_throttle_time") or "unknown"
                remaining = recommended - now
                print("Too early for the next clean recovery measurement.")
                print(f"last throttle: {last}")
                print(f"recommended next test: {iso_utc(recommended)}")
                print(f"remaining wait: {remaining}")
                return 0
        mode = "SINGLE" if args.single else "PAGINATION" if args.pagination else "RECOVERY_CHECK" if args.recovery_check else "CONTINUE_FROM_RUN" if args.continue_from_run else "CONTINUE_SESSION" if args.continue_session else "FRESH_SEARCH_TEST"
        run = DiagnosticRun(mode, TikTokMarketplaceClient(credentials), initial_state=previous_state)
        if args.single:
            run.single()
        elif args.pagination:
            run.pagination(args.max_pages, args.delay_ms)
        elif args.recovery_check:
            run.recovery_check(previous_state)
        elif args.continue_session or args.continue_from_run:
            run.continue_session(continuation_cursor, args.max_pages, args.delay_ms)
        else:
            run.fresh_searches(args.interval_seconds, args.count)
        print_summary(run.summary())
        return 0
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled before another request was made.", file=sys.stderr)
        return 130
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
