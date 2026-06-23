from aiohttp import web

from server import PromptServer

from .metrics import collect_metrics


@PromptServer.instance.routes.get("/comfyui-performance/metrics")
async def get_performance_metrics(request):
    try:
        return web.json_response(collect_metrics())
    except Exception as exc:
        return web.json_response(
            {
                "ok": False,
                "error": str(exc),
            },
            status=500,
        )
