"""Chart tool: render common charts to base64 PNGs for Slack upload."""

from __future__ import annotations

import base64
from io import BytesIO
from typing import Any

import matplotlib
import pandas as pd

matplotlib.use("Agg")

import matplotlib.pyplot as plt

_OKABE_ITO = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#F0E442", "#56B4E9", "#E69F00"]


def _pick_x(df: pd.DataFrame, hint: str | None) -> str:
    if hint and hint in df.columns:
        return hint
    return str(df.columns[0])


def _numeric_columns(df: pd.DataFrame, x_col: str) -> list[str]:
    return [str(col) for col in df.select_dtypes(include="number").columns if col != x_col]


def _pick_y(df: pd.DataFrame, x_col: str, hint: str | list[str] | None) -> list[str]:
    if isinstance(hint, str) and hint in df.columns:
        return [hint]
    if isinstance(hint, list):
        cols = [col for col in hint if col in df.columns]
        if cols:
            return cols
    numeric = _numeric_columns(df, x_col)
    if numeric:
        return numeric[:4]
    return [str(df.columns[1])] if len(df.columns) > 1 else [x_col]


def _style_axes(ax: plt.Axes, title: str, subtitle: str | None, source: str) -> None:
    ax.set_title(title or "Chart", loc="left", fontsize=15, fontweight=700, pad=16)
    if subtitle:
        ax.text(0, 1.02, subtitle, transform=ax.transAxes, ha="left", va="bottom", fontsize=10)
    if source:
        ax.text(
            0,
            -0.18,
            source,
            transform=ax.transAxes,
            ha="left",
            va="top",
            fontsize=8,
            color="#666666",
        )
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.grid(axis="y", color="#E5E7EB", linewidth=0.8)


def _figure_to_base64(fig: plt.Figure) -> str:
    buf = BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


class ChartClient:
    """Chart builder. Public API is intentionally one method: render_chart."""

    def render_chart(
        self,
        chart_type: str,
        data: list[dict[str, Any]],
        title: str = "",
        question: str = "",
        protagonist: str | None = None,
        subtitle: str | None = None,
        source: str = "",
        theme_mode: str = "light",
        x: str | None = None,
        y: str | list[str] | None = None,
        extras: dict[str, Any] | None = None,
    ) -> str:
        """Render a chart and return base64-encoded PNG bytes.

        Args:
            chart_type: Free-form type: line, bar, top, indexed_line, scatter,
                candlestick, drawdown, heatmap, sparkline, etc. Aliases are
                normalized by the router.
            data: Row-oriented records suitable for ``pandas.DataFrame``.
            title: Sentence-case takeaway title.
            question: Optional source question / intent.
            protagonist: Optional series/category to highlight.
            subtitle: Optional units/baseline/range subtitle.
            source: Optional source line.
            theme_mode: light | dark | editorial.
            x/y: Optional column hints; otherwise first/numeric columns are used.
            extras: Optional handler-specific settings.
        """
        if not data:
            return ""

        del question, protagonist, theme_mode
        extras = extras or {}

        df = pd.DataFrame(data)
        if df.empty:
            return ""

        chart_kind = chart_type.lower().replace("_", "-")
        x_col = _pick_x(df, x)
        y_cols = _pick_y(df, x_col, y)

        fig, ax = plt.subplots(figsize=(8, 4.5))
        if chart_kind in {"pie", "pie-chart", "donut", "donut-chart"}:
            value_col = y_cols[0]
            ax.pie(
                df[value_col],
                labels=df[x_col].astype(str),
                autopct="%1.1f%%",
                startangle=90,
                colors=_OKABE_ITO,
                wedgeprops={"linewidth": 1, "edgecolor": "white"},
            )
            ax.set_title(title or "Chart", loc="left", fontsize=15, fontweight=700, pad=16)
            if subtitle:
                ax.text(
                    0,
                    1.02,
                    subtitle,
                    transform=ax.transAxes,
                    ha="left",
                    va="bottom",
                    fontsize=10,
                )
            if source:
                ax.text(
                    0,
                    -0.08,
                    source,
                    transform=ax.transAxes,
                    ha="left",
                    va="top",
                    fontsize=8,
                    color="#666666",
                )
            ax.axis("equal")
            return _figure_to_base64(fig)

        if chart_kind in {"bar", "bar-chart", "top"}:
            width = 0.8 / max(1, len(y_cols))
            positions = range(len(df))
            for idx, col in enumerate(y_cols):
                offsets = [pos + (idx - (len(y_cols) - 1) / 2) * width for pos in positions]
                ax.bar(
                    offsets,
                    df[col],
                    width=width,
                    label=col,
                    color=_OKABE_ITO[idx % len(_OKABE_ITO)],
                )
            ax.set_xticks(list(positions))
            ax.set_xticklabels(
                df[x_col].astype(str),
                rotation=extras.get("x_rotation", 30),
                ha="right",
            )
        elif chart_kind in {"scatter", "scatter-plot"}:
            value_col = y_cols[0]
            ax.scatter(df[x_col], df[value_col], color=_OKABE_ITO[0], alpha=0.75, edgecolors="none")
        else:
            for idx, col in enumerate(y_cols):
                ax.plot(
                    df[x_col],
                    df[col],
                    marker="o",
                    linewidth=1.8,
                    label=col,
                    color=_OKABE_ITO[idx % len(_OKABE_ITO)],
                )
            if len(df) > 6:
                ax.tick_params(axis="x", labelrotation=30)

        ax.set_xlabel(x_col)
        ax.set_ylabel(", ".join(y_cols))
        if len(y_cols) > 1:
            ax.legend(frameon=False)
        _style_axes(ax, title, subtitle, source)
        return _figure_to_base64(fig)


def _client() -> ChartClient:
    return ChartClient()
