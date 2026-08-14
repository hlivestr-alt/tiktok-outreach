import csv
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse


MODULE_PATH = Path(__file__).with_name("tiktok_marketplace_throttle_test.py")
SPEC = importlib.util.spec_from_file_location("throttle_tool", MODULE_PATH)
tool = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = tool
SPEC.loader.exec_module(tool)


def response(payload, status=200, headers=None):
    return tool.PhysicalResponse(
        status,
        payload,
        json.dumps(payload, separators=(",", ":")),
        headers or {},
        7,
    )


def success(creators=None, search_key="search-exact", next_token=None, request_id="request-1"):
    data = {"creators": creators or [], "search_key": search_key}
    if next_token is not None:
        data["next_page_token"] = next_token
    return response({"code": 0, "message": "Success", "request_id": request_id, "data": data})


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def search(self, body, page_token=None):
        self.calls.append((dict(body), page_token))
        if not self.responses:
            raise AssertionError("unexpected retry/request")
        return self.responses.pop(0)


class FakeClock:
    def __init__(self):
        self.value = 100.0
        self.sleeps = []

    def monotonic(self):
        return self.value

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.value += seconds


class AutoClock:
    def __init__(self, start=None):
        self.current = start or datetime(2026, 8, 13, 12, 0, tzinfo=timezone.utc)
        self.mono = 100.0
        self.sleeps = []

    def now(self):
        return self.current

    def monotonic(self):
        return self.mono

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.current += timedelta(seconds=seconds)
        self.mono += seconds


class ToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.now_value = datetime(2026, 8, 13, 12, 0, tzinfo=timezone.utc)

    def tearDown(self):
        self.temp.cleanup()

    def run_for(self, mode, client, state=None, clock=None):
        clock = clock or FakeClock()
        return tool.DiagnosticRun(
            mode,
            client,
            results_root=self.root,
            now=lambda: self.now_value,
            monotonic=clock.monotonic,
            sleep=clock.sleep,
            initial_state=state,
        )

    def auto_run(self, client, state=None, clock=None, resume_dir=None):
        clock = clock or AutoClock()
        run = tool.DiagnosticRun(
            "AUTO_CHARACTERIZE",
            client,
            results_root=self.root,
            now=clock.now,
            monotonic=clock.monotonic,
            sleep=clock.sleep,
            initial_state=state,
            resume_output_dir=resume_dir,
        )
        auto = tool.AutoCharacterizer(
            run,
            max_runtime_hours=24,
            max_requests=100,
            now=clock.now,
            sleep=clock.sleep,
            sleep_chunk_seconds=30,
        )
        return run, auto, clock

    @staticmethod
    def resumable_state(**overrides):
        state = {
            "last_HTTP_status": 200,
            "last_request_successful": True,
            "last_request_throttled": False,
            "last_provider_code": 0,
            "current_search_key": "key",
            "current_next_page_token": "token",
            "current_page_number": 1,
            "current_search_session": "session",
        }
        state.update(overrides)
        return state

    def make_single_run_evidence(self, name="source", **state_overrides):
        source = self.root / name
        source.mkdir()
        state = self.resumable_state(**state_overrides)
        (source / "session_state.json").write_text(json.dumps(state), encoding="utf-8")
        with (source / "request_log.csv").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=tool.REQUEST_LOG_FIELDS)
            writer.writeheader()
            writer.writerow({
                "HTTP_status": 200,
                "provider_code": 0,
                "request_type": "NEW_SEARCH",
                "page_number": 1,
                "search_session_id": state["current_search_session"],
                "search_key_returned": "YES",
                "next_page_token_returned": "YES",
            })
        request_record = {
            "request_type": "NEW_SEARCH",
            "page_number": 1,
            "search_session_id": state["current_search_session"],
            "response": {"raw_body": {"code": 0, "data": {
                "search_key": state["current_search_key"],
                "next_page_token": state["current_next_page_token"],
                "creators": [],
            }}},
        }
        (source / "requests.jsonl").write_text(json.dumps(request_record) + "\n", encoding="utf-8")
        (source / "summary.json").write_text(json.dumps({
            "test_type": "SINGLE",
            "physical_requests": 1,
            "successful_requests": 1,
            "throttled_requests": 0,
        }), encoding="utf-8")
        return source, state

    def make_validation_env(self, name="validation.env", overrides=None):
        values = {
            "TIKTOK_VALIDATION_APP_KEY": "file-app",
            "TIKTOK_VALIDATION_APP_SECRET": "file-secret",
            "TIKTOK_VALIDATION_ACCESS_TOKEN": "file-token",
            "TIKTOK_VALIDATION_SHOP_CIPHER": "file-cipher",
        }
        if overrides:
            values.update(overrides)
        path = self.root / name
        path.write_text("\n".join(f"{key}={value}" for key, value in values.items()) + "\n", encoding="utf-8")
        return path

    def test_validation_env_loads_all_credentials_and_prints_presence_only(self):
        path = self.make_validation_env()
        output = StringIO()
        with patch.object(tool, "VALIDATION_ENV_FILE", path), redirect_stdout(output):
            credentials = tool.load_validation_credentials()
        self.assertEqual(credentials, tool.Credentials("file-app", "file-secret", "file-token", "file-cipher"))
        self.assertEqual(output.getvalue().splitlines(), [
            "validation env loaded: YES",
            "app key present: YES",
            "app secret present: YES",
            "access token present: YES",
            "shop cipher present: YES",
        ])
        for secret in ("file-app", "file-secret", "file-token", "file-cipher"):
            self.assertNotIn(secret, output.getvalue())

    def test_validation_env_does_not_inherit_windows_environment(self):
        path = self.make_validation_env()
        inherited = {
            "TIKTOK_VALIDATION_APP_KEY": "windows-app",
            "TIKTOK_VALIDATION_APP_SECRET": "windows-secret",
            "TIKTOK_VALIDATION_ACCESS_TOKEN": "windows-token",
            "TIKTOK_VALIDATION_SHOP_CIPHER": "windows-cipher",
            "TIKTOK_APP_KEY": "project-style-app",
        }
        with patch.object(tool, "VALIDATION_ENV_FILE", path), patch.dict(os.environ, inherited, clear=False):
            credentials = tool.load_validation_credentials(announce=False)
        self.assertEqual(credentials, tool.Credentials("file-app", "file-secret", "file-token", "file-cipher"))

    def test_validation_env_missing_file_key_or_blank_value_fails_closed(self):
        with patch.object(tool, "VALIDATION_ENV_FILE", self.root / "missing.env"), self.assertRaisesRegex(ValueError, "is missing"):
            tool.load_validation_credentials(announce=False)
        required = list(tool.VALIDATION_ENV_KEYS)
        for key in required:
            with self.subTest(missing=key):
                path = self.make_validation_env(f"missing-{key}.env")
                lines = [line for line in path.read_text(encoding="utf-8").splitlines() if not line.startswith(f"{key}=")]
                path.write_text("\n".join(lines) + "\n", encoding="utf-8")
                with patch.object(tool, "VALIDATION_ENV_FILE", path), self.assertRaisesRegex(ValueError, "missing required"):
                    tool.load_validation_credentials(announce=False)
            with self.subTest(blank=key):
                path = self.make_validation_env(f"blank-{key}.env", {key: "   "})
                with patch.object(tool, "VALIDATION_ENV_FILE", path), self.assertRaisesRegex(ValueError, "blank required"):
                    tool.load_validation_credentials(announce=False)

    def test_cli_missing_validation_env_constructs_no_client_and_makes_zero_calls(self):
        with patch.object(tool, "VALIDATION_ENV_FILE", self.root / "absent.env"), patch.object(tool, "TikTokMarketplaceClient", side_effect=AssertionError("must not construct client")):
            self.assertEqual(tool.main(["--single"]), 2)

    def test_official_signature_fixture(self):
        actual = tool.sign_tiktok_shop_request(
            "/authorization/202309/shops",
            {"app_key": "29a39d", "timestamp": 1623812664},
            "",
            "e59af819cc",
        )
        self.assertEqual(actual, "b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8")

    def test_first_page_is_literal_empty_body_page_size_20_and_no_filters_or_cursors(self):
        captured = []

        def transport(request):
            captured.append(request)
            return 200, b'{"code":0,"data":{"creators":[]}}', {}

        client = tool.TikTokMarketplaceClient(
            tool.Credentials("app", "secret", "token", "cipher"),
            api_base="https://example.test",
            transport=transport,
            epoch_seconds=lambda: 1700000000,
        )
        client.search({})
        request = captured[0]
        query = parse_qs(urlparse(request.full_url).query)
        self.assertEqual(request.data, b"{}")
        self.assertEqual(query["page_size"], ["20"])
        self.assertNotIn("page_token", query)
        self.assertNotIn("search_key", query)
        for unwanted in ("keyword", "category", "follower", "gmv", "demographic"):
            self.assertNotIn(unwanted, request.full_url.lower())

    def test_pagination_reuses_exact_search_key_and_immediately_previous_token(self):
        client = FakeClient([
            success(next_token="token-A"),
            success(search_key="search-exact", next_token="token-B", request_id="request-2"),
            success(search_key="search-exact", next_token=None, request_id="request-3"),
        ])
        run = self.run_for("PAGINATION", client)
        run.pagination(max_pages=10, delay_ms=3000)
        self.assertEqual(client.calls, [({}, None), ({"search_key": "search-exact"}, "token-A"), ({"search_key": "search-exact"}, "token-B")])

    def test_continue_session_reuses_exact_cursor_page_and_session_without_new_search(self):
        persisted = self.resumable_state(
            current_search_key="persisted-search-key/EXACT==",
            current_next_page_token="persisted-token/+EXACT==",
            current_search_session="same-session-id",
        )
        client = FakeClient([
            success([{"creator_open_id": "p2"}], "persisted-search-key/EXACT==", "next-token", "r-2"),
            success([{"creator_open_id": "p3"}], "persisted-search-key/EXACT==", None, "r-3"),
        ])
        run = self.run_for("CONTINUE_SESSION", client, state=persisted)
        cursor, reason = tool.resumable_session(persisted)
        self.assertEqual(reason, "")
        run.continue_session(cursor, max_pages=20, delay_ms=3000)
        self.assertEqual(client.calls[0], ({"search_key": "persisted-search-key/EXACT=="}, "persisted-token/+EXACT=="))
        self.assertTrue(all(row["request_type"] == "CONTINUATION" for row in run.request_rows))
        self.assertEqual([row["page_number"] for row in run.request_rows], [2, 3])
        self.assertTrue(all(row["search_session_id"] == "same-session-id" for row in run.request_rows))
        state = json.loads((run.output_dir / "session_state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["current_page_number"], 3)
        self.assertEqual(state["current_search_session"], "same-session-id")

    def test_continue_session_respects_total_page_ceiling(self):
        persisted = self.resumable_state(current_next_page_token="token-18", current_page_number=18)
        client = FakeClient([
            success(search_key="key", next_token="token-19", request_id="r19"),
            success(search_key="key", next_token="token-20", request_id="r20"),
            success(search_key="key", next_token="token-21", request_id="r21"),
        ])
        run = self.run_for("CONTINUE_SESSION", client, state=persisted)
        cursor, _ = tool.resumable_session(persisted)
        run.continue_session(cursor, max_pages=20, delay_ms=0)
        self.assertEqual(len(client.calls), 2)
        self.assertEqual([row["page_number"] for row in run.request_rows], [19, 20])
        self.assertEqual(run.stop_reason, "maximum continuation pages reached")

    def test_continue_session_fail_closed_for_missing_or_failed_state(self):
        invalid_states = [
            {},
            self.resumable_state(last_request_successful=False, last_provider_code=36009002),
            self.resumable_state(last_HTTP_status=429, last_request_throttled=True),
            self.resumable_state(current_search_key=""),
            self.resumable_state(current_next_page_token=None),
            self.resumable_state(current_page_number=0),
            self.resumable_state(current_search_session=""),
        ]
        for state in invalid_states:
            with self.subTest(state=state):
                cursor, reason = tool.resumable_session(state)
                self.assertIsNone(cursor)
                self.assertTrue(reason)

    def test_continue_session_cli_invalid_state_neither_prompts_nor_constructs_client(self):
        prior = self.root / "prior"
        prior.mkdir()
        (prior / "session_state.json").write_text(json.dumps({"last_provider_code": 36009002}), encoding="utf-8")
        env_path = self.make_validation_env()
        with patch.object(tool, "VALIDATION_ENV_FILE", env_path), patch.object(tool, "RESULTS_ROOT", self.root), patch("builtins.input", side_effect=AssertionError("must not prompt")), patch.object(tool, "TikTokMarketplaceClient", side_effect=AssertionError("must not create network client")):
            self.assertEqual(tool.main(["--continue-session"]), 0)

    def test_continue_session_throttle_stops_immediately_with_zero_retry(self):
        persisted = self.resumable_state(current_page_number=4, current_search_session="same-session")
        client = FakeClient([response({"code": 36009002, "message": "throttle"}), success()])
        run = self.run_for("CONTINUE_SESSION", client, state=persisted)
        cursor, _ = tool.resumable_session(persisted)
        run.continue_session(cursor, max_pages=20, delay_ms=3000)
        summary = run.summary()
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(run.request_rows[0]["request_type"], "CONTINUATION")
        self.assertEqual(run.request_rows[0]["page_number"], 5)
        self.assertEqual(run.request_rows[0]["search_session_id"], "same-session")
        self.assertEqual(run.stop_reason, "throttle")
        self.assertEqual(summary["retries"], 0)

    def test_continue_from_run_loads_only_exact_corroborated_source_state(self):
        source, expected = self.make_single_run_evidence(
            current_search_key="source-key/EXACT==",
            current_next_page_token="source-token/+EXACT==",
            current_search_session="original-session-id",
        )
        loaded, reason = tool.load_state_from_run(source)
        self.assertEqual(reason, "")
        self.assertEqual(loaded, expected)
        cursor, _ = tool.resumable_session(loaded)
        client = FakeClient([success(search_key="source-key/EXACT==", next_token=None, request_id="page-2")])
        run = self.run_for("CONTINUE_FROM_RUN", client, state=loaded)
        run.continue_session(cursor, max_pages=20, delay_ms=3000)
        self.assertEqual(client.calls, [({"search_key": "source-key/EXACT=="}, "source-token/+EXACT==")])
        self.assertEqual(run.request_rows[0]["request_type"], "CONTINUATION")
        self.assertEqual(run.request_rows[0]["page_number"], 2)
        self.assertEqual(run.request_rows[0]["search_session_id"], "original-session-id")

    def test_continue_from_run_rejects_tampered_or_non_single_evidence(self):
        source, _ = self.make_single_run_evidence()
        request = json.loads((source / "requests.jsonl").read_text(encoding="utf-8"))
        request["response"]["raw_body"]["data"]["next_page_token"] = "different-token"
        (source / "requests.jsonl").write_text(json.dumps(request) + "\n", encoding="utf-8")
        loaded, reason = tool.load_state_from_run(source)
        self.assertIsNone(loaded)
        self.assertIn("does not exactly match", reason)

    def test_continue_from_run_invalid_source_cli_makes_zero_calls(self):
        source, _ = self.make_single_run_evidence()
        (source / "requests.jsonl").write_text("{}\n", encoding="utf-8")
        env_path = self.make_validation_env()
        with patch.object(tool, "VALIDATION_ENV_FILE", env_path), patch("builtins.input", side_effect=AssertionError("must not prompt")), patch.object(tool, "TikTokMarketplaceClient", side_effect=AssertionError("must not create network client")):
            self.assertEqual(tool.main(["--continue-from-run", str(source)]), 0)

    def test_auto_recovery_waits_due_and_makes_only_one_probe_before_next_tier(self):
        clock = AutoClock()
        due = clock.now() + timedelta(hours=1)
        state = self.resumable_state(
            last_request_successful=False,
            last_request_throttled=True,
            last_provider_code=36009002,
            consecutive_throttle_count=1,
            last_throttle_time=tool.iso_utc(clock.now()),
            recommended_next_recovery_test_time=tool.iso_utc(due),
        )
        client = FakeClient([response({"code": 36009002, "message": "throttle"}), success()])
        run, auto, _ = self.auto_run(client, state=state, clock=clock)
        auto.max_runtime_seconds = 3700
        auto.run_until_exit()
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(run.request_rows[0]["request_type"], "NEW_SEARCH")
        self.assertEqual(run.request_rows[0]["throttle"], "YES")
        self.assertEqual(auto.auto["phase"], "RECOVERY")
        self.assertEqual(run.state["consecutive_throttle_count"], 2)
        self.assertEqual(sum(clock.sleeps), 3700)

    def test_auto_successful_recovery_then_three_continuations_advance_tier(self):
        clock = AutoClock()
        creators = [{"creator_open_id": f"creator-{i}"} for i in range(20)]
        client = FakeClient([
            success(creators, "key", "t1", "recovery"),
            success(creators, "key", "t2", "p2"),
            success(creators, "key", "t3", "p3"),
            success(creators, "key", "t4", "p4"),
        ])
        run, auto, _ = self.auto_run(client, clock=clock)
        auto.max_requests = 4
        auto.run_until_exit()
        self.assertEqual([row["request_type"] for row in run.request_rows], ["NEW_SEARCH", "CONTINUATION", "CONTINUATION", "CONTINUATION"])
        self.assertEqual([row["page_number"] for row in run.request_rows], [1, 2, 3, 4])
        self.assertEqual(len({row["search_session_id"] for row in run.request_rows}), 1)
        self.assertEqual(auto.auto["fastest_fully_successful_continuation_interval_seconds"], 3600)
        self.assertEqual(auto.auto["continuation_interval_index"], 1)
        self.assertEqual(len(run.raw_creators), 80)

    def test_auto_new_experiment_reuses_existing_successful_session_conservatively(self):
        clock = AutoClock()
        state = self.resumable_state(last_request_time=tool.iso_utc(clock.now()))
        client = FakeClient([success(search_key="key", next_token=None, request_id="p2")])
        run, auto, _ = self.auto_run(client, state=state, clock=clock)
        auto.max_requests = 1
        auto.run_until_exit()
        self.assertEqual(client.calls, [({"search_key": "key"}, "token")])
        self.assertEqual(run.request_rows[0]["request_type"], "CONTINUATION")
        self.assertEqual(run.request_rows[0]["page_number"], 2)
        self.assertGreaterEqual(sum(clock.sleeps), 3600)

    def test_auto_continuation_throttle_records_failure_and_enters_recovery_without_faster_request(self):
        clock = AutoClock()
        state = self.resumable_state()
        client = FakeClient([response({"code": 36009002, "message": "throttle"}), success()])
        run, auto, _ = self.auto_run(client, state=state, clock=clock)
        auto.auto.update({
            "phase": "CONTINUATION",
            "next_due_time": tool.iso_utc(clock.now()),
            "continuation_interval_index": 3,
            "continuation_successes_at_tier": 1,
        })
        auto.max_runtime_seconds = 10
        auto.run_until_exit()
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(auto.auto["first_failed_continuation_interval_seconds"], 300)
        self.assertEqual(auto.auto["phase"], "RECOVERY")

    def test_auto_prints_success_request_block_and_cumulative_statistics(self):
        clock = AutoClock()
        creators = [{"creator_open_id": f"creator-{index}"} for index in range(20)]
        client = FakeClient([success(creators, "key", "token-2", "page-2")])
        run, auto, _ = self.auto_run(client, state=self.resumable_state(), clock=clock)
        auto.auto.update({"phase": "CONTINUATION", "next_due_time": tool.iso_utc(clock.now())})

        output = StringIO()
        with redirect_stdout(output):
            auto._reconcile_or_execute()

        rendered = output.getvalue()
        self.assertIn("MARKETPLACE REQUEST EXECUTED", rendered)
        self.assertIn("Time: 2026-08-13 20:00:00 +08:00", rendered)
        self.assertIn("Request #: 1", rendered)
        self.assertIn("Type: CONTINUATION", rendered)
        self.assertIn("Page: 2", rendered)
        self.assertIn("HTTP: 200", rendered)
        self.assertIn("Provider code: 0", rendered)
        self.assertIn("Result: SUCCESS", rendered)
        self.assertIn("Creators returned: 20", rendered)
        self.assertIn("Raw creators logged: 20", rendered)
        self.assertIn("Search session preserved: YES", rendered)
        self.assertIn("Total physical requests: 1", rendered)
        self.assertIn("Successful: 1", rendered)
        self.assertIn("Throttled: 0", rendered)
        self.assertIn("Raw creators collected: 20", rendered)
        self.assertIn("Unique creators collected: 20", rendered)

    def test_auto_prints_throttle_recovery_details_and_zero_retries(self):
        clock = AutoClock()
        client = FakeClient([response({"code": 36009002, "message": "throttle"}, status=429)])
        run, auto, _ = self.auto_run(client, state=self.resumable_state(), clock=clock)
        auto.auto.update({"phase": "CONTINUATION", "next_due_time": tool.iso_utc(clock.now())})

        output = StringIO()
        with redirect_stdout(output):
            auto._reconcile_or_execute()

        rendered = output.getvalue()
        self.assertIn("HTTP: 429", rendered)
        self.assertIn("Provider code: 36009002", rendered)
        self.assertIn("Result: THROTTLED", rendered)
        self.assertIn("Retries: 0", rendered)
        self.assertIn("Next recovery tier: 1 hour", rendered)
        self.assertIn("Next request: 2026-08-13 21:00:00 +08:00", rendered)
        self.assertIn("Total physical requests: 1", rendered)
        self.assertIn("Successful: 0", rendered)
        self.assertIn("Throttled: 1", rendered)
        self.assertEqual(len(client.calls), 1)

    def test_auto_console_block_never_exposes_sensitive_values_or_cursor_fields(self):
        clock = AutoClock()
        client = FakeClient([success(search_key="returned-search-secret", next_token="returned-token-secret")])
        client._credentials = tool.Credentials(
            "app-key-secret",
            "app-secret-secret",
            "access-token-secret",
            "shop-cipher-secret",
        )
        state = self.resumable_state(
            current_search_key="persisted-search-secret",
            current_next_page_token="persisted-token-secret",
        )
        run, auto, _ = self.auto_run(client, state=state, clock=clock)
        auto.auto.update({"phase": "CONTINUATION", "next_due_time": tool.iso_utc(clock.now())})

        output = StringIO()
        with redirect_stdout(output):
            auto._reconcile_or_execute()

        rendered = output.getvalue()
        for forbidden in (
            "app-key-secret",
            "app-secret-secret",
            "access-token-secret",
            "shop-cipher-secret",
            "persisted-search-secret",
            "persisted-token-secret",
            "returned-search-secret",
            "returned-token-secret",
            "search_key",
            "page_token",
            "signature",
        ):
            self.assertNotIn(forbidden, rendered)

    def test_auto_reconciliation_does_not_print_execution_block(self):
        clock = AutoClock()
        client = FakeClient([success(search_key="key", next_token="token-2")])
        run, auto, _ = self.auto_run(client, clock=clock)
        action = auto._prepare_action()
        run.request("NEW_SEARCH", 1, action["search_session_id"], {})
        self.assertEqual(len(client.calls), 1)

        resumed_client = FakeClient([])
        resumed_run, resumed_auto, _ = self.auto_run(
            resumed_client,
            state=json.loads((run.output_dir / "session_state.json").read_text(encoding="utf-8")),
            clock=clock,
            resume_dir=run.output_dir,
        )
        output = StringIO()
        with redirect_stdout(output):
            resumed_auto._reconcile_or_execute()

        self.assertNotIn("MARKETPLACE REQUEST EXECUTED", output.getvalue())
        self.assertEqual(len(resumed_client.calls), 0)

    def test_auto_session_exhaustion_waits_safe_interval_then_one_new_search(self):
        clock = AutoClock()
        state = self.resumable_state(current_next_page_token=None, current_page_number=4)
        client = FakeClient([success(search_key="new-key", next_token="new-token", request_id="refresh"), success()])
        run, auto, _ = self.auto_run(client, state=state, clock=clock)
        auto.auto.update({
            "phase": "CONTINUATION",
            "next_due_time": tool.iso_utc(clock.now()),
            "fastest_fully_successful_continuation_interval_seconds": 300,
        })
        auto.max_requests = 1
        auto.run_until_exit()
        self.assertEqual(client.calls, [({}, None)])
        self.assertEqual(run.request_rows[0]["request_type"], "NEW_SEARCH")
        self.assertEqual(auto.auto["session_refreshes"], 1)
        self.assertGreaterEqual(sum(clock.sleeps), 300)
        self.assertTrue(any(event["event"] == "SEARCH_SESSION_EXHAUSTED" for event in auto.auto["events"]))

    def test_auto_single_session_refresh_without_cursor_stops_incomplete(self):
        clock = AutoClock()
        state = self.resumable_state(current_next_page_token=None)
        client = FakeClient([success(search_key="new-key", next_token=None, request_id="refresh"), success()])
        run, auto, _ = self.auto_run(client, state=state, clock=clock)
        auto.auto.update({"phase": "SESSION_REFRESH", "next_due_time": tool.iso_utc(clock.now())})
        auto.run_until_exit()
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(auto.auto["phase"], "COMPLETE")
        self.assertEqual(auto.auto["result"], "INCOMPLETE")

    def test_auto_invalid_session_error_refreshes_but_unexpected_error_fails_closed(self):
        clock = AutoClock()
        invalid_session = response({"code": 999, "message": "Invalid or expired search_key session"}, 400)
        run, auto, _ = self.auto_run(FakeClient([invalid_session]), state=self.resumable_state(), clock=clock)
        auto.auto.update({"phase": "CONTINUATION", "next_due_time": tool.iso_utc(clock.now())})
        auto.max_requests = 1
        auto.run_until_exit()
        self.assertEqual(auto.auto["phase"], "SESSION_REFRESH")
        clock2 = AutoClock()
        invalid_credentials = response({"code": 36009004, "message": "Invalid app_key"}, 400)
        run2, auto2, _ = self.auto_run(FakeClient([invalid_credentials]), state=self.resumable_state(), clock=clock2)
        auto2.auto.update({"phase": "CONTINUATION", "next_due_time": tool.iso_utc(clock2.now())})
        auto2.run_until_exit()
        self.assertEqual(auto2.auto["phase"], "COMPLETE")
        self.assertEqual(auto2.auto["result"], "INCOMPLETE")
        self.assertEqual(run2.stop_reason, "unexpected continuation provider or transport error")

    def test_auto_fresh_search_tiers_are_independent_and_stop_on_first_throttle(self):
        clock = AutoClock()
        client = FakeClient([
            success(request_id="fresh-1"),
            success(request_id="fresh-2"),
            success(request_id="fresh-3"),
            response({"code": 36009002, "message": "throttle"}),
            success(request_id="must-not-run"),
        ])
        run, auto, _ = self.auto_run(client, clock=clock)
        auto.auto.update({
            "phase": "FRESH_SEARCH",
            "next_due_time": tool.iso_utc(clock.now()),
            "fresh_interval_index": 0,
            "fresh_successes_at_tier": 0,
        })
        auto.max_runtime_seconds = 3 * 3600 + 1799
        auto.run_until_exit()
        self.assertEqual(len(client.calls), 4)
        self.assertTrue(all(row["request_type"] == "NEW_SEARCH" for row in run.request_rows))
        self.assertEqual(len({row["search_session_id"] for row in run.request_rows}), 4)
        self.assertEqual(auto.auto["fastest_fully_successful_new_search_interval_seconds"], 3600)
        self.assertEqual(auto.auto["first_failed_new_search_interval_seconds"], 1800)
        self.assertEqual(auto.auto["phase"], "RECOVERY")

    def test_auto_restart_reconciles_logged_pending_action_without_repeat(self):
        clock = AutoClock()
        client = FakeClient([success(search_key="key", next_token="token-2")])
        run, auto, _ = self.auto_run(client, clock=clock)
        action = auto._prepare_action()
        run.request("NEW_SEARCH", 1, action["search_session_id"], {})
        self.assertEqual(len(client.calls), 1)
        resumed_client = FakeClient([success(request_id="must-not-repeat")])
        resumed_run, resumed_auto, _ = self.auto_run(
            resumed_client,
            state=json.loads((run.output_dir / "session_state.json").read_text(encoding="utf-8")),
            clock=clock,
            resume_dir=run.output_dir,
        )
        resumed_auto._reconcile_or_execute()
        self.assertEqual(len(resumed_client.calls), 0)
        self.assertIsNone(resumed_auto.auto["pending_action"])
        self.assertEqual(resumed_auto.auto["last_applied_request_number"], 1)

    def test_auto_interrupt_during_physical_request_marks_uncertain_and_never_repeats(self):
        class InterruptingClient:
            def __init__(self):
                self.calls = []

            def search(self, body, page_token=None):
                self.calls.append((dict(body), page_token))
                raise KeyboardInterrupt()

        clock = AutoClock()
        client = InterruptingClient()
        run, auto, _ = self.auto_run(client, clock=clock)
        with self.assertRaises(KeyboardInterrupt):
            auto.run_until_exit()
        persisted = json.loads((run.output_dir / "session_state.json").read_text(encoding="utf-8"))
        self.assertTrue(persisted["auto_characterize"]["pending_action"]["outcome_uncertain"])
        resumed_client = FakeClient([success(request_id="must-not-run")])
        resumed_run, resumed_auto, _ = self.auto_run(
            resumed_client,
            state=persisted,
            clock=clock,
            resume_dir=run.output_dir,
        )
        resumed_auto.run_until_exit()
        self.assertEqual(len(resumed_client.calls), 0)
        self.assertEqual(resumed_auto.auto["phase"], "COMPLETE")
        self.assertEqual(resumed_run.stop_reason, "pending request outcome is uncertain; refusing to repeat")

    def test_auto_hard_request_and_runtime_limits_make_zero_extra_calls(self):
        clock = AutoClock()
        client = FakeClient([success(), success()])
        run, auto, _ = self.auto_run(client, clock=clock)
        auto.max_requests = 0
        auto.run_until_exit()
        self.assertEqual(len(client.calls), 0)
        self.assertEqual(run.stop_reason, "maximum physical requests reached")
        client2 = FakeClient([success()])
        run2, auto2, _ = self.auto_run(client2, clock=clock)
        auto2.max_runtime_seconds = 0
        auto2.run_until_exit()
        self.assertEqual(len(client2.calls), 0)
        self.assertEqual(run2.stop_reason, "maximum runtime reached")

    def test_auto_runtime_limit_resets_per_resumed_invocation(self):
        clock = AutoClock()
        client = FakeClient([success(search_key="key", next_token="token")])
        run, auto, _ = self.auto_run(client, clock=clock)
        auto.auto["experiment_started_at"] = tool.iso_utc(clock.now() - timedelta(hours=48))
        auto.max_requests = 1
        auto.run_until_exit()
        self.assertEqual(len(client.calls), 1)

    def test_auto_ctrl_c_persists_state_and_summary_without_request(self):
        class InterruptingClock(AutoClock):
            def sleep(self, seconds):
                raise KeyboardInterrupt()

        clock = InterruptingClock()
        state = self.resumable_state(
            last_request_successful=False,
            last_request_throttled=True,
            last_provider_code=36009002,
            last_throttle_time=tool.iso_utc(clock.now()),
            recommended_next_recovery_test_time=tool.iso_utc(clock.now() + timedelta(hours=1)),
        )
        client = FakeClient([success()])
        run, auto, _ = self.auto_run(client, state=state, clock=clock)
        with self.assertRaises(KeyboardInterrupt):
            auto.run_until_exit()
        self.assertEqual(len(client.calls), 0)
        persisted = json.loads((run.output_dir / "session_state.json").read_text(encoding="utf-8"))
        self.assertEqual(persisted["auto_characterize"]["phase"], "RECOVERY")
        self.assertTrue(any(event["event"] == "INTERRUPTED" for event in persisted["auto_characterize"]["events"]))
        self.assertTrue((run.output_dir / "summary.json").is_file())

    def test_find_latest_auto_run_resumes_incomplete_only(self):
        clock = AutoClock()
        run, auto, _ = self.auto_run(FakeClient([]), clock=clock)
        found_dir, found_state = tool.find_latest_auto_run(self.root)
        self.assertEqual(found_dir, run.output_dir)
        self.assertEqual(found_state["auto_characterize"]["phase"], "RECOVERY")
        auto.auto["phase"] = "COMPLETE"
        auto._persist()
        found_dir, found_state = tool.find_latest_auto_run(self.root)
        self.assertIsNone(found_dir)
        self.assertIsNone(found_state)

    def test_auto_cli_defaults_and_configurable_limits(self):
        args = tool.parser().parse_args(["--auto-characterize"])
        self.assertTrue(args.auto_characterize)
        self.assertEqual(args.max_runtime_hours, 24)
        self.assertEqual(args.max_requests, 100)
        custom = tool.parser().parse_args(["--auto-characterize", "--max-runtime-hours", "6", "--max-requests", "12"])
        self.assertEqual(custom.max_runtime_hours, 6)
        self.assertEqual(custom.max_requests, 12)

    def test_auto_summary_distinguishes_conclusive_from_incomplete_terminal_state(self):
        clock = AutoClock()
        run, auto, _ = self.auto_run(FakeClient([]), clock=clock)
        auto.auto["phase"] = "COMPLETE"
        auto.auto["result"] = "INCOMPLETE"
        auto._persist()
        self.assertFalse(run.summary()["results_conclusive"])
        auto.auto["result"] = "CONCLUSIVE"
        auto._persist()
        self.assertTrue(run.summary()["results_conclusive"])

    def test_auto_process_lock_allows_only_one_unattended_owner(self):
        with tool.AutoRunLock(self.root):
            with self.assertRaisesRegex(ValueError, "already running"):
                with tool.AutoRunLock(self.root):
                    self.fail("second lock must never be acquired")
        with tool.AutoRunLock(self.root):
            pass

    def test_raw_creator_logging_preserves_fields_and_duplicates_but_dedup_does_not(self):
        creator = {
            "creator_open_id": "open-1",
            "nested": {"unknown_new_field": [1, {"opaque": True}]},
            "null_field": None,
        }
        client = FakeClient([success([creator, creator])])
        run = self.run_for("SINGLE", client)
        run.single()
        raw_lines = [json.loads(line) for line in (run.output_dir / "creators_raw.jsonl").read_text(encoding="utf-8").splitlines()]
        dedup = json.loads((run.output_dir / "creators_dedup.json").read_text(encoding="utf-8"))
        self.assertEqual([item["creator"] for item in raw_lines], [creator, creator])
        self.assertEqual(len(dedup), 1)
        self.assertEqual(dedup[0]["creator"], creator)

    def test_request_log_metadata_and_no_credentials_in_any_log(self):
        payload = {
            "code": 0,
            "message": "provider echoed secret-value",
            "request_id": "req",
            "app_secret": "secret-value",
            "access_token": "token-value",
            "data": {"creators": [{"creator_open_id": "one", "all": {"fields": True}}]},
        }
        credential_client = FakeClient([response(payload, headers={"X-Diagnostic": "token-value"})])
        credential_client._credentials = tool.Credentials("app-value", "secret-value", "token-value", "cipher-value")
        payload["unexpected_echo"] = "prefix-cipher-value-suffix"
        run = self.run_for("SINGLE", credential_client)
        run.single()
        run.summary()
        with (run.output_dir / "request_log.csv").open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(set(rows[0]), set(tool.REQUEST_LOG_FIELDS))
        self.assertEqual(rows[0]["retry_performed"], "NO")
        self.assertEqual(rows[0]["page_size"], "20")
        all_logs = "\n".join(
            path.read_text(encoding="utf-8-sig")
            for path in run.output_dir.iterdir()
            if path.is_file()
        )
        for secret in ("app-value", "secret-value", "token-value", "cipher-value"):
            self.assertNotIn(secret, all_logs)
        self.assertNotIn("shop_cipher", all_logs)
        self.assertNotIn("app_key", all_logs)

    def test_signature_failure_stops(self):
        client = FakeClient([response({"code": 106001, "message": "bad sign"}), success()])
        run = self.run_for("FRESH_SEARCH_TEST", client)
        run.fresh_searches(interval_seconds=1, count=5)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(run.stop_reason, "signature failure")

    def test_36009002_stops_immediately_with_zero_retry(self):
        client = FakeClient([response({"code": 36009002, "message": "throttle"}, 200), success()])
        run = self.run_for("PAGINATION", client)
        run.pagination(max_pages=20, delay_ms=3000)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(run.summary()["retries"], 0)
        self.assertEqual(run.stop_reason, "throttle")

    def test_http_429_stops_immediately_even_without_json_provider_code(self):
        client = FakeClient([tool.PhysicalResponse(429, None, "too many", {}, 1), success()])
        run = self.run_for("FRESH_SEARCH_TEST", client)
        run.fresh_searches(interval_seconds=300, count=5)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(run.request_rows[0]["throttle"], "YES")

    def test_daily_quota_stops(self):
        client = FakeClient([response({"code": 45101004, "message": "daily"}), success()])
        run = self.run_for("FRESH_SEARCH_TEST", client)
        run.fresh_searches(interval_seconds=1, count=5)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(run.stop_reason, "daily quota reached")

    def test_recovery_check_refuses_before_due(self):
        due = self.now_value + timedelta(hours=1)
        state = {"recommended_next_recovery_test_time": tool.iso_utc(due)}
        allowed, parsed_due = tool.recovery_is_due(state, self.now_value)
        self.assertFalse(allowed)
        self.assertEqual(parsed_due, due)

    def test_recovery_cli_before_due_neither_prompts_nor_constructs_client(self):
        result_dir = self.root / "prior"
        result_dir.mkdir()
        due = self.now_value + timedelta(hours=1)
        (result_dir / "session_state.json").write_text(
            json.dumps({
                "last_throttle_time": tool.iso_utc(self.now_value),
                "recommended_next_recovery_test_time": tool.iso_utc(due),
            }),
            encoding="utf-8",
        )
        env_path = self.make_validation_env()
        with patch.object(tool, "VALIDATION_ENV_FILE", env_path), patch.object(tool, "RESULTS_ROOT", self.root), patch.object(tool, "utc_now", return_value=self.now_value), patch("builtins.input", side_effect=AssertionError("must not prompt")), patch.object(tool, "TikTokMarketplaceClient", side_effect=AssertionError("must not create network client")):
            self.assertEqual(tool.main(["--recovery-check"]), 0)

    def test_recovery_backoff_tiers_and_cap(self):
        base = self.now_value
        self.assertEqual(tool.calculate_recovery_due(base, 1), base + timedelta(hours=1))
        self.assertEqual(tool.calculate_recovery_due(base, 2), base + timedelta(hours=2))
        self.assertEqual(tool.calculate_recovery_due(base, 3), base + timedelta(hours=4))
        self.assertEqual(tool.calculate_recovery_due(base, 4), base + timedelta(hours=8))
        self.assertEqual(tool.calculate_recovery_due(base, 99), base + timedelta(hours=8))

    def test_pagination_respects_max_pages(self):
        client = FakeClient([success(next_token=f"token-{i}", request_id=f"r-{i}") for i in range(1, 6)])
        run = self.run_for("PAGINATION", client)
        run.pagination(max_pages=3, delay_ms=0)
        self.assertEqual(len(client.calls), 3)
        self.assertEqual(run.stop_reason, "maximum pages reached")

    def test_fresh_search_count_cap_and_spacing(self):
        clock = FakeClock()
        client = FakeClient([success(request_id=f"r-{i}") for i in range(5)])
        run = self.run_for("FRESH_SEARCH_TEST", client, clock=clock)
        run.fresh_searches(interval_seconds=300, count=3)
        self.assertEqual(len(client.calls), 3)
        self.assertEqual(clock.sleeps, [300.0, 300.0])
        self.assertEqual(run.stop_reason, "fresh search count reached")

    def test_fresh_search_stops_on_first_throttle(self):
        client = FakeClient([success(), response({"code": 36009002, "message": "throttle"}), success()])
        run = self.run_for("FRESH_SEARCH_TEST", client)
        run.fresh_searches(interval_seconds=0, count=5)
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(run.first_throttle_request_number, 2)


if __name__ == "__main__":
    unittest.main()
