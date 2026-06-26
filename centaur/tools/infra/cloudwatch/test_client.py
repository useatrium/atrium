from __future__ import annotations

import importlib.util
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

spec = importlib.util.spec_from_file_location(
    "cloudwatch_client", Path(__file__).with_name("client.py")
)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CloudWatchClient = module.CloudWatchClient


class FakeBotoClient:
    """Records boto3 calls and returns canned responses, no network or boto3."""

    def __init__(self, responses: dict[str, Any] | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.responses = responses or {}

    def __getattr__(self, name: str):
        def _method(**kwargs: Any) -> Any:
            self.calls.append({"op": name, "kwargs": kwargs})
            return self.responses.get(name, {})

        return _method


class RecordingCloudWatchClient(CloudWatchClient):
    """Swaps boto3 logs/cloudwatch clients for recording fakes."""

    def __init__(self, **responses: Any) -> None:
        super().__init__(region="us-west-2")
        self.logs = FakeBotoClient(responses)
        self.cw = FakeBotoClient(responses)

    def _logs(self) -> Any:
        return self.logs

    def _cw(self) -> Any:
        return self.cw


def test_list_log_groups_clamps_limit_and_drops_none() -> None:
    client = RecordingCloudWatchClient(describe_log_groups={"logGroups": [{"logGroupName": "/x"}]})

    out = client.list_log_groups(limit=999)

    assert out == [{"logGroupName": "/x"}]
    call = client.logs.calls[-1]
    assert call["op"] == "describe_log_groups"
    assert call["kwargs"] == {"limit": 50}  # clamped, name_prefix=None dropped


def test_filter_log_events_defaults_to_last_hour() -> None:
    client = RecordingCloudWatchClient()

    client.filter_log_events("/aws/lambda/fn", end_time="2026-05-28T12:00:00Z")

    kwargs = client.logs.calls[-1]["kwargs"]
    assert kwargs["logGroupName"] == "/aws/lambda/fn"
    assert kwargs["endTime"] == int(datetime(2026, 5, 28, 12, tzinfo=UTC).timestamp() * 1000)
    assert kwargs["startTime"] == kwargs["endTime"] - 3_600_000
    assert "filterPattern" not in kwargs  # None dropped


def test_filter_log_events_passes_pattern_and_clamps_limit() -> None:
    client = RecordingCloudWatchClient()

    client.filter_log_events("/g", filter_pattern="ERROR", limit=99999)

    kwargs = client.logs.calls[-1]["kwargs"]
    assert kwargs["filterPattern"] == "ERROR"
    assert kwargs["limit"] == 10000


def test_start_query_normalizes_names_and_uses_epoch_seconds() -> None:
    client = RecordingCloudWatchClient(start_query={"queryId": "q-1"})

    out = client.start_query(
        "/only-one",
        "fields @message",
        start_time="2026-05-28T11:00:00Z",
        end_time="2026-05-28T12:00:00Z",
    )

    assert out == {"queryId": "q-1"}
    kwargs = client.logs.calls[-1]["kwargs"]
    assert kwargs["logGroupNames"] == ["/only-one"]
    assert kwargs["startTime"] == int(datetime(2026, 5, 28, 11, tzinfo=UTC).timestamp())
    assert kwargs["endTime"] == int(datetime(2026, 5, 28, 12, tzinfo=UTC).timestamp())


def test_get_metric_data_builds_single_query() -> None:
    client = RecordingCloudWatchClient(get_metric_data={"MetricDataResults": [{"Id": "m1"}]})

    out = client.get_metric_data(
        "AWS/Lambda",
        "Errors",
        dimensions={"FunctionName": "fn"},
        stat="Sum",
        period=60,
        start_time="2026-05-28T11:00:00Z",
        end_time="2026-05-28T12:00:00Z",
    )

    assert out == [{"Id": "m1"}]
    kwargs = client.cw.calls[-1]["kwargs"]
    q = kwargs["MetricDataQueries"][0]
    assert q["MetricStat"]["Metric"]["Namespace"] == "AWS/Lambda"
    assert q["MetricStat"]["Metric"]["Dimensions"] == [{"Name": "FunctionName", "Value": "fn"}]
    assert q["MetricStat"]["Stat"] == "Sum"
    assert q["MetricStat"]["Period"] == 60
    assert kwargs["StartTime"] == datetime(2026, 5, 28, 11, tzinfo=UTC)
    assert kwargs["EndTime"] == datetime(2026, 5, 28, 12, tzinfo=UTC)


def test_describe_alarms_filters_active() -> None:
    client = RecordingCloudWatchClient(describe_alarms={"MetricAlarms": [{"AlarmName": "a"}]})

    out = client.describe_alarms(state_value="ALARM")

    assert out == [{"AlarmName": "a"}]
    kwargs = client.cw.calls[-1]["kwargs"]
    assert kwargs["StateValue"] == "ALARM"
    assert kwargs["MaxRecords"] == 50
    assert "AlarmNamePrefix" not in kwargs


def test_clean_strips_metadata_and_serializes_datetimes() -> None:
    cleaned = module._clean(
        {
            "ResponseMetadata": {"RequestId": "abc"},
            "MetricAlarms": [{"StateUpdatedTimestamp": datetime(2026, 5, 28, tzinfo=UTC)}],
        }
    )

    assert "ResponseMetadata" not in cleaned
    assert cleaned["MetricAlarms"][0]["StateUpdatedTimestamp"] == "2026-05-28T00:00:00+00:00"


def test_to_epoch_ms_handles_seconds_and_millis() -> None:
    assert module._to_epoch_ms(1_700_000_000) == 1_700_000_000_000  # seconds → ms
    assert module._to_epoch_ms(1_700_000_000_000) == 1_700_000_000_000  # already ms
    assert module._to_epoch_ms(None) is None


def test_api_errors_are_wrapped() -> None:
    client = RecordingCloudWatchClient()

    def boom(**_: Any):
        raise ValueError("AccessDenied")

    client.logs.describe_log_groups = boom  # type: ignore[assignment]

    try:
        client.list_log_groups()
    except RuntimeError as exc:
        assert "CloudWatch API error" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")
