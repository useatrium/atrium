"""Client for reth log analyzer - wraps parsing and graph generation."""

from pathlib import Path
from typing import Any

import pandas as pd

from .graphs import generate_all_graphs, metrics_to_dataframe
from .parser import parse_log_file


class RethLogAnalyzerClient:
    """Client for parsing reth logs and generating performance analysis."""

    def parse(self, log_file: Path, min_gas: float = 0.0) -> pd.DataFrame:
        """Parse a reth log file and return a DataFrame of block metrics.

        Args:
            log_file: Path to the reth log file.
            min_gas: Minimum gas in Mgas to include (0 = all).

        Returns:
            DataFrame with block metrics.
        """
        blocks = parse_log_file(log_file)
        if not blocks:
            return pd.DataFrame()

        df = metrics_to_dataframe(blocks)
        if min_gas > 0:
            df = df[df["gas_used_mgas"] > min_gas]
        return df

    def generate_graphs(
        self,
        log_file: Path,
        output_dir: Path,
        min_gas: float = 0.0,
        title_suffix: str = "",
    ) -> list[Path]:
        """Generate all performance graphs from a reth log file.

        Args:
            log_file: Path to the reth log file.
            output_dir: Directory to write graph PNGs.
            min_gas: Minimum gas in Mgas to include.
            title_suffix: Suffix to add to graph titles.

        Returns:
            List of paths to generated graph files.
        """
        blocks = parse_log_file(log_file)
        if not blocks:
            return []

        return generate_all_graphs(
            blocks,
            output_dir,
            min_gas_mgas=min_gas,
            title_suffix=title_suffix,
        )

    def summary(self, log_file: Path, min_gas: float = 10.0) -> dict[str, Any]:
        """Generate a summary of block performance stats.

        Args:
            log_file: Path to the reth log file.
            min_gas: Minimum gas in Mgas for "big blocks" analysis.

        Returns:
            Dict with summary statistics.
        """
        blocks = parse_log_file(log_file)
        if not blocks:
            return {}

        df = metrics_to_dataframe(blocks)
        total = len(df)
        empty = int((df["gas_used_mgas"] == 0).sum())
        big_blocks = df[df["gas_used_mgas"] > min_gas]

        result: dict[str, Any] = {
            "total_blocks": total,
            "block_range": (int(df["block_number"].min()), int(df["block_number"].max())),
            "empty_blocks": empty,
            "non_empty_blocks": total - empty,
            "max_gas_mgas": float(df["gas_used_mgas"].max()),
            "max_latency_ms": float(df["elapsed_ms"].max()),
            "categories": {},
        }

        for name, subset in [
            ("empty", df[df["gas_used_mgas"] == 0]),
            ("light", df[(df["gas_used_mgas"] > 0) & (df["gas_used_mgas"] <= 10)]),
            ("medium", df[(df["gas_used_mgas"] > 10) & (df["gas_used_mgas"] <= 50)]),
            ("big", df[(df["gas_used_mgas"] > 50) & (df["gas_used_mgas"] <= 500)]),
            ("huge", df[df["gas_used_mgas"] > 500]),
        ]:
            if len(subset) > 0:
                result["categories"][name] = {
                    "count": len(subset),
                    "avg_latency_ms": float(subset["elapsed_ms"].mean()),
                    "avg_state_root_pct": float(subset["state_root_pct"].mean()),
                    "avg_execution_pct": float(subset["execution_pct"].mean()),
                }

        if len(big_blocks) > 0:
            slowest = big_blocks.loc[big_blocks["elapsed_ms"].idxmax()]
            result["big_blocks"] = {
                "count": len(big_blocks),
                "min_gas_threshold": min_gas,
                "avg_throughput_ggas_s": float(big_blocks["gas_throughput_ggas_s"].mean()),
                "avg_execution_pct": float(big_blocks["execution_pct"].mean()),
                "avg_state_root_pct": float(big_blocks["state_root_pct"].mean()),
                "slowest_block": int(slowest["block_number"]),
                "slowest_latency_ms": float(slowest["elapsed_ms"]),
                "slowest_gas_mgas": float(slowest["gas_used_mgas"]),
            }

        return result


def _client() -> RethLogAnalyzerClient:
    return RethLogAnalyzerClient()
