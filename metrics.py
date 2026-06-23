import csv
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path


try:
    import psutil
except Exception:
    psutil = None


if psutil is not None:
    try:
        psutil.cpu_percent(interval=None)
    except Exception:
        pass


_WINDOWS_CPU_TIMES = None


def _bytes_from_mb(value):
    number = _to_float(value)
    if number is None:
        return None
    return int(number * 1024 * 1024)


def _percent(used, total):
    if used is None or total in (None, 0):
        return None
    return round((used / total) * 100, 1)


def _to_float(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text or text.upper() == "N/A":
        return None
    text = text.replace("%", "").replace("W", "").replace("MiB", "").strip()
    try:
        return float(text)
    except ValueError:
        return None


def _to_int(value):
    number = _to_float(value)
    if number is None:
        return None
    return int(number)


def _collect_cpu():
    if psutil is None:
        percent = _cpu_percent_from_windows_times()
        if percent is None:
            percent = _cpu_percent_from_windows_wmic()
        return {
            "available": percent is not None,
            "percent": percent,
            "logicalCores": os.cpu_count(),
            "physicalCores": None,
            "frequencyMhz": None,
            "temperatureC": None,
            "loadAverage": _safe_load_average(),
        }

    frequency = None
    try:
        current_freq = psutil.cpu_freq()
        frequency = round(current_freq.current, 1) if current_freq else None
    except Exception:
        pass

    temperature = None
    try:
        sensors = getattr(psutil, "sensors_temperatures", lambda: {})()
        for entries in sensors.values():
            if entries:
                temperature = round(entries[0].current, 1)
                break
    except Exception:
        pass

    return {
        "available": True,
        "percent": round(psutil.cpu_percent(interval=None), 1),
        "logicalCores": psutil.cpu_count(logical=True),
        "physicalCores": psutil.cpu_count(logical=False),
        "frequencyMhz": frequency,
        "temperatureC": temperature,
        "loadAverage": _safe_load_average(),
    }


def _safe_load_average():
    try:
        return [round(value, 2) for value in os.getloadavg()]
    except Exception:
        return None


def _subprocess_creationflags():
    if sys.platform.startswith("win"):
        return getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return 0


def _filetime_to_int(value):
    return (value.dwHighDateTime << 32) + value.dwLowDateTime


def _cpu_percent_from_windows_times():
    if not sys.platform.startswith("win"):
        return None
    try:
        import ctypes

        class FileTime(ctypes.Structure):
            _fields_ = [
                ("dwLowDateTime", ctypes.c_ulong),
                ("dwHighDateTime", ctypes.c_ulong),
            ]

        idle = FileTime()
        kernel = FileTime()
        user = FileTime()
        ok = ctypes.windll.kernel32.GetSystemTimes(
            ctypes.byref(idle),
            ctypes.byref(kernel),
            ctypes.byref(user),
        )
        if not ok:
            return None

        current = {
            "idle": _filetime_to_int(idle),
            "kernel": _filetime_to_int(kernel),
            "user": _filetime_to_int(user),
        }

        global _WINDOWS_CPU_TIMES
        previous = _WINDOWS_CPU_TIMES
        _WINDOWS_CPU_TIMES = current

        if previous is None:
            return None

        idle_delta = current["idle"] - previous["idle"]
        total_delta = (current["kernel"] - previous["kernel"]) + (current["user"] - previous["user"])
        if total_delta <= 0:
            return None

        busy_delta = total_delta - idle_delta
        return round(max(0.0, min(100.0, (busy_delta / total_delta) * 100.0)), 1)
    except Exception:
        return None


def _cpu_percent_from_windows_wmic():
    if not sys.platform.startswith("win"):
        return None
    try:
        output = subprocess.check_output(
            ["wmic", "cpu", "get", "loadpercentage", "/value"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=1,
            creationflags=_subprocess_creationflags(),
        )
    except Exception:
        return None

    values = []
    for line in output.splitlines():
        key, _, raw_value = line.partition("=")
        if key.strip().lower() == "loadpercentage":
            number = _to_float(raw_value)
            if number is not None:
                values.append(number)
    if not values:
        return None
    return round(sum(values) / len(values), 1)


def _memory_from_windows_api():
    if not sys.platform.startswith("win"):
        return None
    try:
        import ctypes

        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(MemoryStatus)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
        used = status.ullTotalPhys - status.ullAvailPhys
        return {
            "available": True,
            "total": status.ullTotalPhys,
            "used": used,
            "free": status.ullAvailPhys,
            "percent": float(status.dwMemoryLoad),
        }
    except Exception:
        return None


def _collect_memory():
    if psutil is not None:
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()
        return {
            "memory": {
                "available": True,
                "total": mem.total,
                "used": mem.used,
                "free": mem.available,
                "percent": round(mem.percent, 1),
            },
            "swap": {
                "available": True,
                "total": swap.total,
                "used": swap.used,
                "free": swap.free,
                "percent": round(swap.percent, 1),
            },
        }

    fallback = _memory_from_windows_api()
    return {
        "memory": fallback
        or {
            "available": False,
            "total": None,
            "used": None,
            "free": None,
            "percent": None,
        },
        "swap": {
            "available": False,
            "total": None,
            "used": None,
            "free": None,
            "percent": None,
        },
    }


def _collect_disks():
    disks = []

    if psutil is not None:
        try:
            partitions = psutil.disk_partitions(all=False)
        except Exception:
            partitions = []

        seen = set()
        for partition in partitions:
            mountpoint = partition.mountpoint
            if not mountpoint or mountpoint in seen:
                continue
            seen.add(mountpoint)
            try:
                usage = psutil.disk_usage(mountpoint)
            except Exception:
                continue
            disks.append(
                {
                    "device": partition.device,
                    "mountpoint": mountpoint,
                    "filesystem": partition.fstype,
                    "total": usage.total,
                    "used": usage.used,
                    "free": usage.free,
                    "percent": round(usage.percent, 1),
                }
            )

    if not disks:
        disks = _collect_disks_without_psutil()

    io = None
    if psutil is not None:
        try:
            counters = psutil.disk_io_counters()
            if counters:
                io = {
                    "readBytes": counters.read_bytes,
                    "writeBytes": counters.write_bytes,
                    "readCount": counters.read_count,
                    "writeCount": counters.write_count,
                }
        except Exception:
            pass

    return {
        "items": disks,
        "io": io,
    }


def _collect_disks_without_psutil():
    roots = []
    if sys.platform.startswith("win"):
        try:
            import ctypes

            drive_mask = ctypes.windll.kernel32.GetLogicalDrives()
            for index in range(26):
                if drive_mask & (1 << index):
                    root = f"{chr(65 + index)}:\\"
                    drive_type = ctypes.windll.kernel32.GetDriveTypeW(root)
                    if drive_type in (2, 3):
                        roots.append(root)
        except Exception:
            roots = []

    if not roots:
        roots = [Path.cwd().anchor or str(Path.cwd())]

    disks = []
    for root in roots:
        try:
            usage = shutil.disk_usage(root)
        except Exception:
            continue
        disks.append(
            {
                "device": root,
                "mountpoint": root,
                "filesystem": None,
                "total": usage.total,
                "used": usage.used,
                "free": usage.free,
                "percent": _percent(usage.used, usage.total),
            }
        )
    return disks


def _collect_gpu_from_nvml():
    try:
        import pynvml
    except Exception:
        return []

    try:
        pynvml.nvmlInit()
        count = pynvml.nvmlDeviceGetCount()
    except Exception:
        return []

    gpus = []
    for index in range(count):
        try:
            handle = pynvml.nvmlDeviceGetHandleByIndex(index)
            raw_name = pynvml.nvmlDeviceGetName(handle)
            name = raw_name.decode("utf-8", errors="replace") if isinstance(raw_name, bytes) else str(raw_name)
            memory = pynvml.nvmlDeviceGetMemoryInfo(handle)

            try:
                utilization = pynvml.nvmlDeviceGetUtilizationRates(handle)
                gpu_util = float(utilization.gpu)
                memory_util = float(utilization.memory)
            except Exception:
                gpu_util = None
                memory_util = _percent(memory.used, memory.total)

            try:
                temperature = float(pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU))
            except Exception:
                temperature = None

            try:
                power_draw = round(pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0, 1)
            except Exception:
                power_draw = None

            try:
                power_limit = round(pynvml.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000.0, 1)
            except Exception:
                power_limit = None

            try:
                fan_speed = float(pynvml.nvmlDeviceGetFanSpeed(handle))
            except Exception:
                fan_speed = None

            gpus.append(
                {
                    "index": index,
                    "name": name,
                    "source": "nvml",
                    "utilizationPercent": gpu_util,
                    "memoryUsedPercent": _percent(memory.used, memory.total),
                    "memoryUtilizationPercent": memory_util,
                    "memoryControllerUtilizationPercent": memory_util,
                    "memoryTotal": memory.total,
                    "memoryUsed": memory.used,
                    "memoryFree": memory.free,
                    "temperatureC": temperature,
                    "powerDrawW": power_draw,
                    "powerLimitW": power_limit,
                    "fanSpeedPercent": fan_speed,
                }
            )
        except Exception:
            continue

    return gpus


def _collect_gpu_from_nvidia_smi():
    command = [
        "nvidia-smi",
        "--query-gpu=index,name,utilization.gpu,utilization.memory,memory.total,memory.used,temperature.gpu,power.draw,power.limit,fan.speed",
        "--format=csv,noheader,nounits",
    ]
    try:
        output = subprocess.check_output(
            command,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
            creationflags=_subprocess_creationflags(),
        )
    except Exception:
        return []

    gpus = []
    for row in csv.reader(output.splitlines()):
        if len(row) < 10:
            continue
        row = [item.strip() for item in row]
        memory_total = _bytes_from_mb(row[4])
        memory_used = _bytes_from_mb(row[5])
        gpus.append(
            {
                "index": _to_int(row[0]),
                "name": row[1],
                "source": "nvidia-smi",
                "utilizationPercent": _to_float(row[2]),
                "memoryUsedPercent": _percent(memory_used, memory_total),
                "memoryUtilizationPercent": _to_float(row[3]),
                "memoryControllerUtilizationPercent": _to_float(row[3]),
                "memoryTotal": memory_total,
                "memoryUsed": memory_used,
                "memoryFree": memory_total - memory_used if memory_total is not None and memory_used is not None else None,
                "temperatureC": _to_float(row[6]),
                "powerDrawW": _to_float(row[7]),
                "powerLimitW": _to_float(row[8]),
                "fanSpeedPercent": _to_float(row[9]),
            }
        )

    return gpus


def _collect_gpu_from_torch():
    try:
        import torch
    except Exception:
        return []

    try:
        if not torch.cuda.is_available():
            return []
        count = torch.cuda.device_count()
    except Exception:
        return []

    gpus = []
    for index in range(count):
        try:
            name = torch.cuda.get_device_name(index)
            with torch.cuda.device(index):
                free, total = torch.cuda.mem_get_info()
            used = total - free
            gpus.append(
                {
                    "index": index,
                    "name": name,
                    "source": "torch",
                    "utilizationPercent": None,
                    "memoryUsedPercent": _percent(used, total),
                    "memoryUtilizationPercent": _percent(used, total),
                    "memoryControllerUtilizationPercent": None,
                    "memoryTotal": total,
                    "memoryUsed": used,
                    "memoryFree": free,
                    "temperatureC": None,
                    "powerDrawW": None,
                    "powerLimitW": None,
                    "fanSpeedPercent": None,
                }
            )
        except Exception:
            continue

    return gpus


def _collect_gpus():
    gpus = _collect_gpu_from_nvml()
    if not gpus:
        gpus = _collect_gpu_from_nvidia_smi()
    if not gpus:
        gpus = _collect_gpu_from_torch()
    return gpus


def collect_metrics():
    memory_payload = _collect_memory()
    return {
        "ok": True,
        "timestamp": time.time(),
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "python": platform.python_version(),
        },
        "providers": {
            "psutil": psutil is not None,
        },
        "cpu": _collect_cpu(),
        "memory": memory_payload["memory"],
        "swap": memory_payload["swap"],
        "gpus": _collect_gpus(),
        "disks": _collect_disks(),
    }
