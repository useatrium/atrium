"""AWS CloudWatch client for read-only logs, metrics, and alarms.

Mirrors the useful read-only surface of the AWS CloudWatch MCP server using
boto3: browse log groups, tail/filter log events, run CloudWatch Logs Insights
queries, list metrics and pull metric data, and inspect alarms.

AWS auth rides iron-proxy's ``aws_auth`` transform (declared in pyproject.toml):
boto3 signs each request with throwaway *placeholder* credentials, and iron-proxy
reads the region/service from the signature scope, strips it, and re-signs with
the real read-only IAM keys it resolves from the secrets backend. The real keys
never enter this process — the SigV4 analogue of the ``secrets`` placeholder
swap. Only the region is a real value: boto3 needs it to pick the endpoint host
and credential scope, and it isn't a secret.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from typing import Any

_DEFAULT_REGION = "us-east-1"

# boto3 must sign with *some* credentials; iron-proxy's aws_auth transform
# discards this signature and re-signs with the real keys, so the value is
# irrelevant beyond being non-empty.
_PLACEHOLDER_CREDENTIAL = "iron-proxy-resigns-this"


class CloudWatchClient:
    """Read-only client for CloudWatch Logs and Metrics (boto3, SigV4).

    boto3 signs with placeholder credentials; iron-proxy's ``aws_auth`` transform
    re-signs with the real read-only IAM keys (resolved from the secrets backend),
    so credentials never reach this process. The region comes from ``AWS_REGION``
    (a non-secret), defaulting to ``us-east-1``. boto3 clients are built lazily on
    first use so tool discovery never needs network access.
    """

    def __init__(self, region: str | None = None):
        self._region = region
        self.__logs: Any = None
        self.__cw: Any = None

    # -- boto3 plumbing (lazy) ----------------------------------------------

    @property
    def region(self) -> str:
        # Region is non-secret config, read straight from the env (not secret(),
        # whose server-mode StubBackend returns the key name as a placeholder
        # rather than the default). Defaults to us-east-1 when unset.
        return self._region or os.getenv("AWS_REGION") or _DEFAULT_REGION  # noqa: TID251

    def _session(self) -> Any:
        import boto3  # lazy: keeps import cheap and tests boto3-free

        # Placeholder credentials — iron-proxy re-signs on the wire. Passed
        # explicitly so boto3 never reaches for IMDS / ambient AWS config.
        return boto3.session.Session(
            aws_access_key_id=_PLACEHOLDER_CREDENTIAL,
            aws_secret_access_key=_PLACEHOLDER_CREDENTIAL,
            region_name=self.region,
        )

    def _logs(self) -> Any:
        if self.__logs is None:
            self.__logs = self._session().client("logs")
        return self.__logs

    def _cw(self) -> Any:
        if self.__cw is None:
            self.__cw = self._session().client("cloudwatch")
        return self.__cw

    @staticmethod
    def _call(fn: Any, **kwargs: Any) -> dict:
        """Invoke a boto3 call, dropping None args and normalizing errors."""
        clean = {k: v for k, v in kwargs.items() if v is not None}
        try:
            return fn(**clean)
        except Exception as exc:  # botocore.ClientError et al.
            raise RuntimeError(f"CloudWatch API error: {exc}") from exc

    # -- Logs: groups & events ----------------------------------------------

    def list_log_groups(
        self,
        name_prefix: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        """List CloudWatch log groups, optionally filtered by name prefix.

        Use this to discover log group names for filter_log_events / start_query.

        Args:
            name_prefix: Only return groups whose name starts with this string.
            limit: Max groups to return (1-50).
        """
        resp = self._call(
            self._logs().describe_log_groups,
            logGroupNamePrefix=name_prefix,
            limit=max(1, min(limit, 50)),
        )
        return _clean(resp.get("logGroups", []))

    def filter_log_events(
        self,
        log_group_name: str,
        filter_pattern: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
        limit: int = 100,
    ) -> dict:
        """Search log events in a group within a time window.

        The workhorse for grepping logs. ``filter_pattern`` uses CloudWatch Logs
        filter syntax (e.g. 'ERROR', '"timeout"', '{ $.level = "error" }').

        Args:
            log_group_name: Exact log group name (see list_log_groups).
            filter_pattern: CloudWatch Logs filter pattern. Omit to return all events.
            start_time: ISO-8601 timestamp or epoch (s/ms). Defaults to 1h before end.
            end_time: ISO-8601 timestamp or epoch (s/ms). Defaults to now.
            limit: Max events to return (1-10000).
        """
        start_ms, end_ms = _resolve_window_ms(start_time, end_time)
        resp = self._call(
            self._logs().filter_log_events,
            logGroupName=log_group_name,
            filterPattern=filter_pattern,
            startTime=start_ms,
            endTime=end_ms,
            limit=max(1, min(limit, 10000)),
        )
        return {
            "events": _clean(resp.get("events", [])),
            "searched_log_streams": _clean(resp.get("searchedLogStreams", [])),
        }

    # -- Logs Insights -------------------------------------------------------

    def start_query(
        self,
        log_group_names: list[str] | str,
        query_string: str,
        start_time: str | None = None,
        end_time: str | None = None,
        limit: int = 100,
    ) -> dict:
        """Start a CloudWatch Logs Insights query. Returns a query_id to poll.

        Logs Insights is asynchronous: call this to start, then poll
        get_query_results with the returned query_id until status is Complete.

        Args:
            log_group_names: One name or a list of log group names to query.
            query_string: Logs Insights query, e.g.
                'fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc'.
            start_time: ISO-8601 timestamp or epoch (s/ms). Defaults to 1h before end.
            end_time: ISO-8601 timestamp or epoch (s/ms). Defaults to now.
            limit: Max rows the query may return (1-10000).
        """
        names = [log_group_names] if isinstance(log_group_names, str) else list(log_group_names)
        start_ms, end_ms = _resolve_window_ms(start_time, end_time)
        resp = self._call(
            self._logs().start_query,
            logGroupNames=names,
            queryString=query_string,
            startTime=start_ms // 1000,  # Insights wants epoch seconds
            endTime=end_ms // 1000,
            limit=max(1, min(limit, 10000)),
        )
        return _clean(resp)

    def get_query_results(self, query_id: str) -> dict:
        """Get results/status for a Logs Insights query started with start_query.

        Status is one of Scheduled, Running, Complete, Failed, Cancelled, Timeout.
        Poll until status is Complete (or terminal) before trusting the results.

        Args:
            query_id: The query_id returned by start_query.
        """
        resp = self._call(self._logs().get_query_results, queryId=query_id)
        return _clean(resp)

    def stop_query(self, query_id: str) -> dict:
        """Stop a running Logs Insights query.

        Args:
            query_id: The query_id returned by start_query.
        """
        return _clean(self._call(self._logs().stop_query, queryId=query_id))

    # -- Metrics -------------------------------------------------------------

    def list_metrics(
        self,
        namespace: str | None = None,
        metric_name: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        """List available metrics, optionally filtered by namespace/name.

        Use to discover the namespace, metric name, and dimensions to pass to
        get_metric_data.

        Args:
            namespace: e.g. 'AWS/EC2', 'AWS/Lambda', or a custom namespace.
            metric_name: e.g. 'CPUUtilization', 'Errors'.
            limit: Max metrics to return (results are truncated client-side).
        """
        resp = self._call(
            self._cw().list_metrics,
            Namespace=namespace,
            MetricName=metric_name,
        )
        return _clean(resp.get("Metrics", []))[: max(1, limit)]

    def get_metric_data(
        self,
        namespace: str,
        metric_name: str,
        dimensions: dict[str, str] | None = None,
        stat: str = "Average",
        period: int = 300,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> dict:
        """Fetch time-series data points for a single metric.

        Args:
            namespace: Metric namespace, e.g. 'AWS/Lambda'.
            metric_name: Metric name, e.g. 'Errors'.
            dimensions: Dimension name→value map, e.g. {'FunctionName': 'my-fn'}.
            stat: Statistic — Average, Sum, Minimum, Maximum, SampleCount, or p99 etc.
            period: Granularity in seconds (must be a multiple of 60).
            start_time: ISO-8601 timestamp or epoch (s/ms). Defaults to 1h before end.
            end_time: ISO-8601 timestamp or epoch (s/ms). Defaults to now.
        """
        start_dt, end_dt = _resolve_window_dt(start_time, end_time)
        dims = [{"Name": k, "Value": v} for k, v in (dimensions or {}).items()]
        resp = self._call(
            self._cw().get_metric_data,
            MetricDataQueries=[
                {
                    "Id": "m1",
                    "MetricStat": {
                        "Metric": {
                            "Namespace": namespace,
                            "MetricName": metric_name,
                            "Dimensions": dims,
                        },
                        "Period": period,
                        "Stat": stat,
                    },
                    "ReturnData": True,
                }
            ],
            StartTime=start_dt,
            EndTime=end_dt,
        )
        return _clean(resp.get("MetricDataResults", []))

    # -- Alarms --------------------------------------------------------------

    def describe_alarms(
        self,
        state_value: str | None = None,
        alarm_name_prefix: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        """List metric alarms, optionally filtered by state and name prefix.

        Pass state_value='ALARM' to see only currently-firing alarms.

        Args:
            state_value: 'OK', 'ALARM', or 'INSUFFICIENT_DATA'.
            alarm_name_prefix: Only alarms whose name starts with this string.
            limit: Max alarms to return (1-100).
        """
        resp = self._call(
            self._cw().describe_alarms,
            StateValue=state_value,
            AlarmNamePrefix=alarm_name_prefix,
            MaxRecords=max(1, min(limit, 100)),
        )
        return _clean(resp.get("MetricAlarms", []))

    def get_alarm_history(
        self,
        alarm_name: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        """Get state-change history for an alarm (or all alarms).

        Args:
            alarm_name: Restrict to one alarm. Omit for history across all alarms.
            limit: Max history items to return (1-100).
        """
        resp = self._call(
            self._cw().describe_alarm_history,
            AlarmName=alarm_name,
            MaxRecords=max(1, min(limit, 100)),
        )
        return _clean(resp.get("AlarmHistoryItems", []))

    # -- Lifecycle -----------------------------------------------------------

    def close(self):
        self.__logs = None
        self.__cw = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


# -- Helpers -----------------------------------------------------------------


def _to_epoch_ms(value: str | int | float | None) -> int | None:
    """Coerce an ISO-8601 string or epoch (seconds or millis) to epoch millis."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # Heuristic: values past ~2001 in seconds are < 1e12; millis are larger.
        return int(value if value > 1_000_000_000_000 else value * 1000)
    text = str(value).strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return int(dt.timestamp() * 1000)


def _resolve_window_ms(start: str | None, end: str | None) -> tuple[int, int]:
    """Resolve a (start, end) window to epoch millis, defaulting to the last hour."""
    end_ms = _to_epoch_ms(end)
    if end_ms is None:
        end_ms = int(datetime.now(UTC).timestamp() * 1000)
    start_ms = _to_epoch_ms(start)
    if start_ms is None:
        start_ms = end_ms - int(timedelta(hours=1).total_seconds() * 1000)
    return start_ms, end_ms


def _resolve_window_dt(start: str | None, end: str | None) -> tuple[datetime, datetime]:
    """Resolve a (start, end) window to tz-aware datetimes (CloudWatch metrics API)."""
    start_ms, end_ms = _resolve_window_ms(start, end)
    return (
        datetime.fromtimestamp(start_ms / 1000, tz=UTC),
        datetime.fromtimestamp(end_ms / 1000, tz=UTC),
    )


def _clean(obj: Any) -> Any:
    """Make a boto3 response JSON-serializable.

    Converts datetimes to ISO-8601, decodes bytes, and strips the boilerplate
    ``ResponseMetadata`` envelope so it doesn't bloat the agent's context.
    """
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items() if k != "ResponseMetadata"}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, (bytes, bytearray)):
        return bytes(obj).decode("utf-8", "replace")
    return obj


def _client() -> CloudWatchClient:
    return CloudWatchClient()
