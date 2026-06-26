"""Parse reth log files and extract block metrics."""

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


@dataclass
class BlockMetrics:
    """Metrics for a single block."""

    timestamp: datetime
    block_number: int
    hash: str
    txs: int
    gas_used_mgas: float
    gas_throughput_mgas_s: float
    gas_limit_mgas: float
    full_pct: float
    base_fee_gwei: float
    blobs: int
    elapsed_ms: float
    state_root_elapsed_ms: float | None = None


ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*m")

BLOCK_ADDED_RE = re.compile(
    r"(?P<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+"
    r"INFO\s+Block added to canonical chain\s+"
    r"number=(?P<number>\d+)\s+"
    r"hash=(?P<hash>0x[a-f0-9]+)\s+"
    r"peers=\d+\s+"
    r"txs=(?P<txs>\d+)\s+"
    r"gas_used=(?P<gas_used>[\d.]+)(?P<gas_used_unit>[KMG]?)gas\s+"
    r"gas_throughput=(?P<throughput>[\d.]+)(?P<throughput_unit>[KMG]?)gas/second\s+"
    r"gas_limit=(?P<gas_limit>[\d.]+)(?P<gas_limit_unit>[KMG]?)gas\s+"
    r"full=(?P<full>[\d.]+)%\s+"
    r"base_fee=(?P<base_fee>[\d.]+)(?P<base_fee_unit>[KMG]?)wei\s+"
    r"blobs=(?P<blobs>\d+)\s+"
    r".*?"
    r"elapsed=(?P<elapsed>[\d.]+)(?P<elapsed_unit>\w+)"
)

STATE_ROOT_RE = re.compile(
    r"(?P<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+"
    r"INFO\s+State root task finished\s+"
    r"state_root=0x[a-f0-9]+\s+"
    r"elapsed=(?P<elapsed>[\d.]+)(?P<elapsed_unit>\w+)"
)


def _scale_unit(value: float, unit: str) -> float:
    """Convert value to Mgas (base unit for display)."""
    unit = unit.upper()
    if unit == "K":
        return value / 1000.0
    elif unit == "G":
        return value * 1000.0
    elif unit == "M" or unit == "":
        return value
    return value


def _parse_time_to_ms(value: float, unit: str) -> float:
    """Convert time value to milliseconds."""
    unit = unit.lower()
    if unit == "s":
        return value * 1000.0
    elif unit == "ms":
        return value
    elif unit == "µs" or unit == "us":
        return value / 1000.0
    elif unit == "ns":
        return value / 1_000_000.0
    return value


def parse_log_file(path: Path) -> list[BlockMetrics]:
    """Parse a reth log file and extract block metrics."""
    blocks: list[BlockMetrics] = []
    pending_state_root: tuple[datetime, float] | None = None

    with open(path) as f:
        for line in f:
            line = ANSI_ESCAPE.sub("", line)

            state_match = STATE_ROOT_RE.search(line)
            if state_match:
                ts = datetime.fromisoformat(state_match.group("timestamp").replace("Z", "+00:00"))
                elapsed = _parse_time_to_ms(
                    float(state_match.group("elapsed")), state_match.group("elapsed_unit")
                )
                pending_state_root = (ts, elapsed)
                continue

            block_match = BLOCK_ADDED_RE.search(line)
            if block_match:
                ts = datetime.fromisoformat(block_match.group("timestamp").replace("Z", "+00:00"))

                gas_used = _scale_unit(
                    float(block_match.group("gas_used")), block_match.group("gas_used_unit")
                )
                throughput = _scale_unit(
                    float(block_match.group("throughput")), block_match.group("throughput_unit")
                )
                gas_limit = _scale_unit(
                    float(block_match.group("gas_limit")), block_match.group("gas_limit_unit")
                )

                base_fee_raw = float(block_match.group("base_fee"))
                base_fee_unit = block_match.group("base_fee_unit").upper()
                if base_fee_unit == "G":
                    base_fee = base_fee_raw
                elif base_fee_unit == "M":
                    base_fee = base_fee_raw / 1000.0
                elif base_fee_unit == "K":
                    base_fee = base_fee_raw / 1_000_000.0
                else:
                    base_fee = base_fee_raw / 1_000_000_000.0

                elapsed_ms = _parse_time_to_ms(
                    float(block_match.group("elapsed")), block_match.group("elapsed_unit")
                )

                state_root_ms = None
                if pending_state_root is not None:
                    state_root_ms = pending_state_root[1]
                    pending_state_root = None

                blocks.append(
                    BlockMetrics(
                        timestamp=ts,
                        block_number=int(block_match.group("number")),
                        hash=block_match.group("hash"),
                        txs=int(block_match.group("txs")),
                        gas_used_mgas=gas_used,
                        gas_throughput_mgas_s=throughput,
                        gas_limit_mgas=gas_limit,
                        full_pct=float(block_match.group("full")),
                        base_fee_gwei=base_fee,
                        blobs=int(block_match.group("blobs")),
                        elapsed_ms=elapsed_ms,
                        state_root_elapsed_ms=state_root_ms,
                    )
                )

    return blocks
