---
name: linux-debugging
description: Linux system performance and debugging
tags: [linux, performance, debugging]
---

# Linux Debugging

## High CPU
- `mpstat -P ALL 1 3` — per-core usage
- `perf top -p &lt;pid&gt;` — hotspot analysis
- Check for runaway processes: `ps aux --sort=-%cpu | head`

## High Memory
- `vmstat 1 5` — check si/so (swap activity)
- `slabtop` — kernel slab usage
- `cat /proc/meminfo` — detailed breakdown

## Disk I/O
- `iostat -xz 1 5` — extended stats
- `iotop` — per-process I/O
- Check for disk full: `df -h`

## Network
- `ss -s` — socket summary
- `tcpdump -i any -c 100` — packet capture
- `nstat` — kernel network stats