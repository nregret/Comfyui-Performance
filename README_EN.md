# ComfyUI Performance Monitor

[中文](README.md) | English

A modern real-time performance monitor for ComfyUI.

## Preview

### Toolbar Dock Bar

Compact toolbar mode showing CPU, RAM, VRAM, disk read/write speed, and the quick VRAM unload button beside ComfyUI's native controls.

![Toolbar dock bar preview](bar.jpeg)

### Detail Panel

Floating detail panel with larger metric cards, history sparklines, GPU detail, storage usage, pause control, and refresh interval selection.

![Detail panel preview](detail.jpeg)

## Features

- Shows a compact performance bar directly in the ComfyUI toolbar.
- Displays CPU, RAM, VRAM, and disk read/write activity in real time.
- Prioritizes GPU memory usage for ComfyUI workflows, with GPU core usage shown as secondary detail.
- Provides a detailed floating panel with larger cards, meters, history sparklines, GPU details, and storage information.
- Includes a one-click VRAM unload button for quickly unloading models and freeing memory.
- Supports dragging the toolbar bar out as a floating widget and docking it back through a placeholder target.
- Click the compact metrics bar to open or close the detailed panel.
- Supports English and Chinese UI text.
- Follows ComfyUI theme colors for light and dark themes.
