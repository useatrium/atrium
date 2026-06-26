"""Profile parsing and analysis utilities."""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ThreadSummary:
    """Summary statistics for a thread."""

    tid: str | int
    name: str
    pid: str
    process_name: str
    is_main_thread: bool
    sample_count: int
    marker_count: int
    start_time_ms: float
    end_time_ms: float
    cpu_delta_total_ns: int = 0

    @property
    def duration_ms(self) -> float:
        return self.end_time_ms - self.start_time_ms

    def to_dict(self) -> dict:
        return {
            "tid": self.tid,
            "name": self.name,
            "pid": self.pid,
            "process_name": self.process_name,
            "is_main_thread": self.is_main_thread,
            "sample_count": self.sample_count,
            "marker_count": self.marker_count,
            "start_time_ms": round(self.start_time_ms, 2),
            "end_time_ms": round(self.end_time_ms, 2),
            "duration_ms": round(self.duration_ms, 2),
            "cpu_delta_total_ns": self.cpu_delta_total_ns,
        }


@dataclass
class Sample:
    """A single sample with resolved stack."""

    time_ms: float
    stack: list[str]  # Function names from leaf to root
    weight: int = 1
    cpu_delta_ns: int | None = None
    thread_id: str | int | None = None

    def to_dict(self) -> dict:
        d = {
            "time_ms": round(self.time_ms, 3),
            "stack": self.stack,
            "weight": self.weight,
        }
        if self.cpu_delta_ns is not None:
            d["cpu_delta_ns"] = self.cpu_delta_ns
        if self.thread_id is not None:
            d["thread_id"] = self.thread_id
        return d


@dataclass
class Marker:
    """A marker event."""

    name: str
    category: str
    start_time_ms: float
    end_time_ms: float | None = None
    phase: str = "instant"  # instant, interval, start, end
    data: dict = field(default_factory=dict)
    thread_id: str | int | None = None

    @property
    def duration_ms(self) -> float | None:
        if self.end_time_ms is not None:
            return self.end_time_ms - self.start_time_ms
        return None

    def to_dict(self) -> dict:
        d = {
            "name": self.name,
            "category": self.category,
            "start_ms": round(self.start_time_ms, 3),
        }
        if self.end_time_ms is not None:
            d["end_ms"] = round(self.end_time_ms, 3)
            d["duration_ms"] = round(self.duration_ms, 3)
        if self.phase != "instant":
            d["phase"] = self.phase
        if self.data:
            d["data"] = self.data
        if self.thread_id is not None:
            d["thread_id"] = self.thread_id
        return d


@dataclass
class HotspotEntry:
    """A hotspot (hot function or stack)."""

    name: str
    self_samples: int
    self_weight: int
    total_samples: int
    total_weight: int
    self_pct: float
    total_pct: float

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "self_samples": self.self_samples,
            "self_weight": self.self_weight,
            "total_samples": self.total_samples,
            "total_weight": self.total_weight,
            "self_pct": round(self.self_pct, 2),
            "total_pct": round(self.total_pct, 2),
        }


@dataclass
class TimelineBucket:
    """A time bucket for timeline analysis."""

    start_ms: float
    end_ms: float
    sample_count: int
    total_weight: int
    cpu_delta_ns: int
    top_functions: list[str]

    def to_dict(self) -> dict:
        return {
            "start_ms": round(self.start_ms, 2),
            "end_ms": round(self.end_ms, 2),
            "sample_count": self.sample_count,
            "total_weight": self.total_weight,
            "cpu_delta_ns": self.cpu_delta_ns,
            "top_functions": self.top_functions,
        }


class ProfileAnalyzer:
    """Analyze a Firefox Profiler profile."""

    def __init__(self, profile: dict[str, Any]):
        self.profile = profile
        self.meta = profile.get("meta", {})
        self.threads = profile.get("threads", [])
        self._categories = self._build_category_map()
        # Global string table (shared across threads in newer profiles)
        shared = profile.get("shared", {})
        self._global_strings = shared.get("stringArray", [])

    def _build_category_map(self) -> dict[int, str]:
        """Build a map from category index to name."""
        categories = self.meta.get("categories", [])
        return {i: c.get("name", f"Category{i}") for i, c in enumerate(categories)}

    def get_category_name(self, idx: int | None) -> str:
        if idx is None:
            return "Other"
        return self._categories.get(idx, "Other")

    def get_thread_summaries(self) -> list[ThreadSummary]:
        """Get summary info for all threads."""
        summaries = []

        for thread in self.threads:
            samples = thread.get("samples", {})
            markers = thread.get("markers", {})

            # Get sample times
            sample_times = samples.get("time", [])
            if not sample_times and samples.get("timeDeltas"):
                # Reconstruct times from deltas - each delta is time since previous sample
                deltas = samples.get("timeDeltas", [])
                if deltas:
                    t = 0.0
                    times = []
                    for d in deltas:
                        t += d or 0
                        times.append(t)
                    sample_times = times

            # Calculate CPU delta total
            cpu_deltas = samples.get("threadCPUDelta", [])
            cpu_total = sum(d for d in cpu_deltas if d is not None)

            # Get time range
            start_time = min(sample_times) if sample_times else 0.0
            end_time = max(sample_times) if sample_times else 0.0

            summaries.append(
                ThreadSummary(
                    tid=thread.get("tid", ""),
                    name=thread.get("name", "Unknown"),
                    pid=thread.get("pid", ""),
                    process_name=thread.get("processName", ""),
                    is_main_thread=thread.get("isMainThread", False),
                    sample_count=samples.get("length", len(sample_times)),
                    marker_count=markers.get("length", 0),
                    start_time_ms=start_time,
                    end_time_ms=end_time,
                    cpu_delta_total_ns=cpu_total,
                )
            )

        return summaries

    def find_thread(self, thread_filter: str | None) -> dict | None:
        """Find a thread by TID or name pattern."""
        if not thread_filter:
            # Return first main thread, or first thread
            for t in self.threads:
                if t.get("isMainThread"):
                    return t
            return self.threads[0] if self.threads else None

        # Try exact TID match
        for t in self.threads:
            if str(t.get("tid")) == str(thread_filter):
                return t

        # Try name pattern match (case-insensitive)
        pattern = thread_filter.lower()
        for t in self.threads:
            if pattern in t.get("name", "").lower():
                return t

        return None

    def resolve_stack(self, thread: dict, stack_idx: int | None, max_depth: int = 50) -> list[str]:
        """Resolve a stack index to a list of function names (leaf to root)."""
        if stack_idx is None:
            return []

        stack_table = thread.get("stackTable", {})
        frame_table = thread.get("frameTable", {})
        func_table = thread.get("funcTable", {})
        # Use thread-local string table, fall back to global
        string_table = thread.get("stringTable", [])
        if not string_table:
            string_table = self._global_strings

        frames = stack_table.get("frame", [])
        prefixes = stack_table.get("prefix", [])
        func_indices = frame_table.get("func", [])
        func_names = func_table.get("name", [])

        result = []
        current_idx = stack_idx
        depth = 0

        while current_idx is not None and depth < max_depth:
            if current_idx >= len(frames):
                break

            frame_idx = frames[current_idx]
            if frame_idx < len(func_indices):
                func_idx = func_indices[frame_idx]
                if func_idx < len(func_names):
                    name_idx = func_names[func_idx]
                    if name_idx < len(string_table):
                        result.append(string_table[name_idx])
                    else:
                        result.append(f"<func:{func_idx}>")
                else:
                    result.append(f"<func:{func_idx}>")
            else:
                result.append(f"<frame:{frame_idx}>")

            current_idx = prefixes[current_idx] if current_idx < len(prefixes) else None
            depth += 1

        return result

    def get_samples(
        self,
        thread: dict,
        time_range: tuple[float, float] | None = None,
        max_depth: int = 10,
    ) -> list[Sample]:
        """Extract samples from a thread."""
        samples_table = thread.get("samples", {})
        stacks = samples_table.get("stack", [])
        times = samples_table.get("time", [])
        weights = samples_table.get("weight")
        cpu_deltas = samples_table.get("threadCPUDelta", [])

        # Handle timeDeltas if time array is missing
        if not times and samples_table.get("timeDeltas"):
            deltas = samples_table.get("timeDeltas", [])
            t = 0.0
            times = []
            for d in deltas:
                t += d or 0
                times.append(t)

        results = []
        for i, (stack_idx, time) in enumerate(zip(stacks, times)):
            # Filter by time range
            if time_range:
                if time < time_range[0] or time > time_range[1]:
                    continue

            stack = self.resolve_stack(thread, stack_idx, max_depth)
            weight = weights[i] if weights and i < len(weights) else 1
            cpu_delta = cpu_deltas[i] if cpu_deltas and i < len(cpu_deltas) else None

            results.append(
                Sample(
                    time_ms=time,
                    stack=stack,
                    weight=weight if weight else 1,
                    cpu_delta_ns=cpu_delta,
                    thread_id=thread.get("tid"),
                )
            )

        return results

    def get_markers(
        self,
        thread: dict,
        time_range: tuple[float, float] | None = None,
        marker_type: str | None = None,
        category_filter: str | None = None,
    ) -> list[Marker]:
        """Extract markers from a thread."""
        markers_table = thread.get("markers", {})
        names = markers_table.get("name", [])
        start_times = markers_table.get("startTime", [])
        end_times = markers_table.get("endTime", [])
        phases = markers_table.get("phase", [])
        categories = markers_table.get("category", [])
        data_list = markers_table.get("data", [])
        # Use thread-local string table, fall back to global
        string_table = thread.get("stringTable", [])
        if not string_table:
            string_table = self._global_strings

        # Phase mapping
        phase_map = {0: "instant", 1: "interval", 2: "start", 3: "end"}

        results = []
        for i in range(len(names)):
            name_idx = names[i]
            # Skip if name index is None
            if name_idx is None:
                continue
            name = (
                string_table[name_idx] if name_idx < len(string_table) else f"<marker:{name_idx}>"
            )

            start_time = start_times[i] if i < len(start_times) else None
            end_time = end_times[i] if i < len(end_times) else None

            # Skip if no valid start time
            if start_time is None:
                continue

            # Filter by time range
            if time_range:
                if start_time > time_range[1]:
                    continue
                if end_time is not None and end_time < time_range[0]:
                    continue
                if end_time is None and start_time < time_range[0]:
                    continue

            # Get category
            cat_idx = categories[i] if i < len(categories) else None
            category = self.get_category_name(cat_idx)

            # Filter by category
            if category_filter and category_filter.lower() not in category.lower():
                continue

            # Get phase
            phase_idx = phases[i] if i < len(phases) else 0
            phase = phase_map.get(phase_idx, "instant")

            # Get data
            data = data_list[i] if i < len(data_list) else {}
            if data is None:
                data = {}

            # Filter by marker type (from data.type or name)
            if marker_type:
                data_type = data.get("type", "") if isinstance(data, dict) else ""
                if (
                    marker_type.lower() not in name.lower()
                    and marker_type.lower() not in str(data_type).lower()
                ):
                    continue

            results.append(
                Marker(
                    name=name,
                    category=category,
                    start_time_ms=start_time,
                    end_time_ms=end_time,
                    phase=phase,
                    data=data if isinstance(data, dict) else {"value": data},
                    thread_id=thread.get("tid"),
                )
            )

        return results

    def compute_hotspots(
        self,
        thread: dict,
        time_range: tuple[float, float] | None = None,
        by: str = "function",  # function, frame, stack
        top_n: int = 20,
    ) -> list[HotspotEntry]:
        """Compute hot functions or stacks."""
        samples = self.get_samples(thread, time_range, max_depth=50)

        if not samples:
            return []

        total_samples = len(samples)

        # Count self (leaf) and total occurrences
        self_counts: dict[str, int] = {}
        self_weights: dict[str, int] = {}
        total_counts: dict[str, int] = {}
        total_weights: dict[str, int] = {}

        for sample in samples:
            if not sample.stack:
                continue

            if by == "stack":
                # Use full stack as key
                key = " -> ".join(reversed(sample.stack[:10]))
                self_counts[key] = self_counts.get(key, 0) + 1
                self_weights[key] = self_weights.get(key, 0) + sample.weight
                total_counts[key] = total_counts.get(key, 0) + 1
                total_weights[key] = total_weights.get(key, 0) + sample.weight
            else:
                # by == "function" or "frame"
                # Self = leaf function
                leaf = sample.stack[0]
                self_counts[leaf] = self_counts.get(leaf, 0) + 1
                self_weights[leaf] = self_weights.get(leaf, 0) + sample.weight

                # Total = all functions in stack
                seen = set()
                for func in sample.stack:
                    if func not in seen:
                        total_counts[func] = total_counts.get(func, 0) + 1
                        total_weights[func] = total_weights.get(func, 0) + sample.weight
                        seen.add(func)

        # Build hotspot entries
        all_funcs = set(self_counts.keys()) | set(total_counts.keys())
        entries = []

        for func in all_funcs:
            self_s = self_counts.get(func, 0)
            self_w = self_weights.get(func, 0)
            total_s = total_counts.get(func, 0)
            total_w = total_weights.get(func, 0)

            entries.append(
                HotspotEntry(
                    name=func,
                    self_samples=self_s,
                    self_weight=self_w,
                    total_samples=total_s,
                    total_weight=total_w,
                    self_pct=(self_s / total_samples * 100) if total_samples > 0 else 0,
                    total_pct=(total_s / total_samples * 100) if total_samples > 0 else 0,
                )
            )

        # Sort by self samples (descending)
        entries.sort(key=lambda e: e.self_samples, reverse=True)
        return entries[:top_n]

    def compute_timeline(
        self,
        thread: dict,
        bucket_size_ms: float = 1000.0,
        time_range: tuple[float, float] | None = None,
    ) -> list[TimelineBucket]:
        """Compute time-bucketed analysis."""
        samples = self.get_samples(thread, time_range, max_depth=5)

        if not samples:
            return []

        # Determine time range
        min_time = min(s.time_ms for s in samples)
        max_time = max(s.time_ms for s in samples)

        if time_range:
            min_time = max(min_time, time_range[0])
            max_time = min(max_time, time_range[1])

        # Create buckets
        buckets: dict[int, list[Sample]] = {}
        for sample in samples:
            bucket_idx = int((sample.time_ms - min_time) / bucket_size_ms)
            if bucket_idx not in buckets:
                buckets[bucket_idx] = []
            buckets[bucket_idx].append(sample)

        # Build timeline entries
        results = []
        for bucket_idx in sorted(buckets.keys()):
            bucket_samples = buckets[bucket_idx]
            start = min_time + bucket_idx * bucket_size_ms
            end = start + bucket_size_ms

            # Count top functions
            func_counts: dict[str, int] = {}
            for s in bucket_samples:
                if s.stack:
                    leaf = s.stack[0]
                    func_counts[leaf] = func_counts.get(leaf, 0) + 1

            top_funcs = sorted(func_counts.items(), key=lambda x: x[1], reverse=True)[:3]

            results.append(
                TimelineBucket(
                    start_ms=start,
                    end_ms=end,
                    sample_count=len(bucket_samples),
                    total_weight=sum(s.weight for s in bucket_samples),
                    cpu_delta_ns=sum(s.cpu_delta_ns or 0 for s in bucket_samples),
                    top_functions=[f[0] for f in top_funcs],
                )
            )

        return results
