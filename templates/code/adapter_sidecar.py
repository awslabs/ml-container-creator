#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Adapter Sidecar — SageMaker AI adapter contract implementation.

Lightweight aiohttp HTTP server that sits between SageMaker (port 8080) and the
model server (port 8081). Implements POST /adapters and DELETE /adapters by
translating them into the model server's native LoRA API, while proxying all
other traffic transparently.

Configuration (environment variables):
    MODEL_SERVER_PORT  - Internal model server port (default: 8081)
    MODEL_SERVER_TYPE  - Model server type: vllm or sglang (default: vllm)
    SIDECAR_PORT       - Port sidecar listens on (default: 8080)
    MAX_LORAS          - Maximum concurrent adapters (default: 64)
    HEALTH_POLL_INTERVAL - Seconds between health polls (default: 2)
    HEALTH_TIMEOUT     - Seconds to wait for model server readiness (default: 600)
"""

import asyncio
import os
import tarfile
import time
from datetime import datetime, timezone

from aiohttp import web, ClientSession, ClientTimeout


# ── Configuration ─────────────────────────────────────────────────────────────

MODEL_SERVER_PORT = int(os.environ.get('MODEL_SERVER_PORT', '8081'))
MODEL_SERVER_TYPE = os.environ.get('MODEL_SERVER_TYPE', 'vllm')
SIDECAR_PORT = int(os.environ.get('SIDECAR_PORT', '8080'))
MAX_LORAS = int(os.environ.get('MAX_LORAS', '64'))
HEALTH_POLL_INTERVAL = int(os.environ.get('HEALTH_POLL_INTERVAL', '2'))
HEALTH_TIMEOUT = int(os.environ.get('HEALTH_TIMEOUT', '600'))

MODEL_SERVER_BASE = f'http://localhost:{MODEL_SERVER_PORT}'


# ── Logging ───────────────────────────────────────────────────────────────────

def log(message, stream='stdout'):
    """Emit a log message with ISO 8601 timestamp and [adapter-sidecar] prefix."""
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    line = f'{ts} [adapter-sidecar] {message}'
    if stream == 'stderr':
        import sys
        print(line, file=sys.stderr)
    else:
        print(line)


# ── Artifact Resolution ───────────────────────────────────────────────────────

class ArtifactResolver:
    """Resolves adapter artifacts from a source path.

    Handles three cases:
    1. Path contains a single tar.gz file — extract in place, return directory
    2. Path contains adapter_config.json — use directory directly
    3. Path does not exist or is empty — raise FileNotFoundError
    """

    @staticmethod
    def resolve(src):
        """Resolve the adapter artifact path.

        Args:
            src: Filesystem path where SageMaker placed adapter artifacts.

        Returns:
            Resolved directory path containing adapter files.

        Raises:
            FileNotFoundError: If path does not exist or is empty.
            RuntimeError: If tar.gz extraction fails.
        """
        # Check if path exists
        if not os.path.exists(src):
            raise FileNotFoundError(f'Adapter artifact path does not exist: {src}')

        # If src is a file (direct tar.gz path), extract it
        if os.path.isfile(src) and src.endswith('.tar.gz'):
            extract_dir = os.path.dirname(src)
            ArtifactResolver._extract_tar_gz(src, extract_dir)
            return extract_dir

        # If src is a directory, check contents
        if not os.path.isdir(src):
            raise FileNotFoundError(f'Adapter artifact path is not a directory: {src}')

        # Check if directory is empty
        contents = os.listdir(src)
        if not contents:
            raise FileNotFoundError(f'Adapter artifact path is empty: {src}')

        # Check if directory already contains adapter_config.json (extracted files)
        if 'adapter_config.json' in contents:
            return src

        # Check if directory contains a single tar.gz file
        tar_files = [f for f in contents if f.endswith('.tar.gz')]
        if len(tar_files) == 1:
            tar_path = os.path.join(src, tar_files[0])
            ArtifactResolver._extract_tar_gz(tar_path, src)
            return src

        # If we get here, the path exists but has no recognizable adapter artifacts
        # Check again after potential extraction if adapter_config.json appeared
        if 'adapter_config.json' in os.listdir(src):
            return src

        raise FileNotFoundError(
            f'Adapter artifact path does not contain adapter_config.json or a tar.gz archive: {src}'
        )

    @staticmethod
    def _extract_tar_gz(tar_path, extract_dir):
        """Extract a tar.gz archive to the specified directory.

        Args:
            tar_path: Path to the tar.gz file.
            extract_dir: Directory to extract files into.

        Raises:
            RuntimeError: If extraction fails due to corruption or permission issues.
        """
        try:
            with tarfile.open(tar_path, 'r:gz') as tar:
                # Use filter='data' on Python 3.12+ for security, fall back for older versions
                if hasattr(tarfile, 'data_filter'):
                    tar.extractall(path=extract_dir, filter='data')
                else:
                    tar.extractall(path=extract_dir)
        except (tarfile.TarError, OSError, PermissionError) as e:
            raise RuntimeError(f'Failed to extract tar.gz archive {tar_path}: {e}')


# ── Model Server Client (Strategy Pattern) ────────────────────────────────────

class ModelServerClient:
    """Strategy interface for model server native LoRA API translation.

    Subclasses implement the specific HTTP calls for each model server type.
    """

    def __init__(self, session, base_url):
        self.session = session
        self.base_url = base_url

    async def load_adapter(self, name, path):
        """Load a LoRA adapter into the model server.

        Args:
            name: Adapter identifier.
            path: Resolved filesystem path to adapter artifacts.

        Returns:
            dict with response data from the model server.

        Raises:
            RuntimeError: If the model server returns an error or is unreachable.
        """
        raise NotImplementedError

    async def unload_adapter(self, name):
        """Unload a LoRA adapter from the model server.

        Args:
            name: Adapter identifier.

        Returns:
            dict with response data from the model server.

        Raises:
            RuntimeError: If the model server returns an error or is unreachable.
        """
        raise NotImplementedError


class VLLMClient(ModelServerClient):
    """vLLM-specific adapter API translation.

    Load: POST /v1/load_lora_adapter {"lora_name": name, "lora_path": path}
    Unload: POST /v1/unload_lora_adapter {"lora_name": name}
    """

    async def load_adapter(self, name, path):
        """Load a LoRA adapter via vLLM's native API."""
        url = f'{self.base_url}/v1/load_lora_adapter'
        payload = {'lora_name': name, 'lora_path': path}
        try:
            async with self.session.post(url, json=payload) as resp:
                body = await resp.text()
                if resp.status == 200:
                    return {'status': 'success', 'response': body}
                raise RuntimeError(f'vLLM load_lora_adapter failed (HTTP {resp.status}): {body}')
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f'Failed to connect to vLLM: {e}')

    async def unload_adapter(self, name):
        """Unload a LoRA adapter via vLLM's native API."""
        url = f'{self.base_url}/v1/unload_lora_adapter'
        payload = {'lora_name': name}
        try:
            async with self.session.post(url, json=payload) as resp:
                body = await resp.text()
                if resp.status == 200:
                    return {'status': 'success', 'response': body}
                raise RuntimeError(f'vLLM unload_lora_adapter failed (HTTP {resp.status}): {body}')
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f'Failed to connect to vLLM: {e}')


class SGLangClient(ModelServerClient):
    """SGLang-specific adapter API translation. (Deferred)

    SGLang support is deferred to a follow-up. This placeholder raises
    NotImplementedError for both load and unload operations.
    """

    async def load_adapter(self, name, path):
        """Load a LoRA adapter via SGLang's native API. (Not yet implemented)"""
        raise NotImplementedError('SGLang adapter loading is not yet implemented')

    async def unload_adapter(self, name):
        """Unload a LoRA adapter via SGLang's native API. (Not yet implemented)"""
        raise NotImplementedError('SGLang adapter unloading is not yet implemented')


def create_model_server_client(session, base_url, server_type):
    """Factory function to create the appropriate ModelServerClient.

    Args:
        session: aiohttp.ClientSession for HTTP calls.
        base_url: Model server base URL (e.g., http://localhost:8081).
        server_type: Model server type ('vllm' or 'sglang').

    Returns:
        ModelServerClient instance.
    """
    if server_type == 'vllm':
        return VLLMClient(session, base_url)
    elif server_type == 'sglang':
        return SGLangClient(session, base_url)
    else:
        raise ValueError(f'Unsupported model server type: {server_type}')


# ── State ─────────────────────────────────────────────────────────────────────

adapter_registry = {}
model_server_ready = False


# ── Health Polling (Readiness Gating) ─────────────────────────────────────────

async def poll_model_server_health(app):
    """Background task that polls the model server health endpoint.

    Sets model_server_ready to True once the health endpoint returns 200.
    After HEALTH_TIMEOUT seconds, logs a warning and sets ready to True
    to avoid indefinite blocking.
    """
    global model_server_ready
    session = app['session']
    start_time = time.monotonic()

    log(f'Starting health polling — interval={HEALTH_POLL_INTERVAL}s, timeout={HEALTH_TIMEOUT}s')

    while True:
        elapsed = time.monotonic() - start_time

        # Timeout: log warning and begin accepting requests
        if elapsed >= HEALTH_TIMEOUT:
            log(f'Health timeout reached ({HEALTH_TIMEOUT}s) — model server did not become ready. Accepting requests anyway.', stream='stderr')
            model_server_ready = True
            return

        try:
            async with session.get(f'{MODEL_SERVER_BASE}/health', timeout=ClientTimeout(total=5)) as resp:
                if resp.status == 200:
                    model_server_ready = True
                    log('Model server is ready (health endpoint returned 200)')
                    return
        except Exception:
            pass

        await asyncio.sleep(HEALTH_POLL_INTERVAL)


# ── Handlers ──────────────────────────────────────────────────────────────────

async def handle_ping(request):
    """GET /ping — readiness gating.

    Returns 503 until model server health endpoint returns 200.
    Once ready, proxies /ping to the model server.
    """
    if not model_server_ready:
        return web.Response(status=503, text='Service Unavailable')

    # Proxy to model server health endpoint
    session = request.app['session']
    try:
        async with session.get(f'{MODEL_SERVER_BASE}/health') as resp:
            body = await resp.read()
            return web.Response(status=resp.status, body=body,
                                headers={'Content-Type': resp.headers.get('Content-Type', 'text/plain')})
    except Exception as e:
        return web.Response(status=503, text=f'Model server unreachable: {e}')


async def handle_adapters_post(request):
    """POST /adapters — load a LoRA adapter."""
    name = request.query.get('name')
    src = request.query.get('src')

    if not name:
        return web.json_response({'status': 'error', 'error': 'Missing required query parameter: name'}, status=400)
    if not src:
        return web.json_response({'status': 'error', 'error': 'Missing required query parameter: src'}, status=400)

    # Check MAX_LORAS limit
    if len(adapter_registry) >= MAX_LORAS:
        return web.json_response(
            {'status': 'error', 'adapter': name, 'error': f'Maximum concurrent adapters ({MAX_LORAS}) reached'},
            status=507
        )

    # Resolve adapter artifacts
    try:
        resolved_path = ArtifactResolver.resolve(src)
    except FileNotFoundError as e:
        return web.json_response({'status': 'error', 'adapter': name, 'error': str(e)}, status=404)
    except RuntimeError as e:
        return web.json_response({'status': 'error', 'adapter': name, 'error': str(e)}, status=500)

    # Call model server native LoRA API
    client = request.app['model_server_client']
    try:
        await client.load_adapter(name, resolved_path)
    except RuntimeError as e:
        log(f'Adapter load failed — name={name}, src={src}, error={e}', stream='stderr')
        return web.json_response({'status': 'error', 'adapter': name, 'error': str(e)}, status=500)

    # Register adapter and respond
    adapter_registry[name] = resolved_path
    log(f'Adapter loaded — name={name}, src={src}, resolved_path={resolved_path}')
    return web.json_response({'status': 'loaded', 'adapter': name, 'path': resolved_path})


async def handle_adapters_delete(request):
    """DELETE /adapters — unload a LoRA adapter."""
    name = request.query.get('name')

    if not name:
        return web.json_response({'status': 'error', 'error': 'Missing required query parameter: name'}, status=400)

    # Call model server native LoRA API
    client = request.app['model_server_client']
    try:
        await client.unload_adapter(name)
    except RuntimeError as e:
        log(f'Adapter unload failed — name={name}, error={e}', stream='stderr')
        return web.json_response({'status': 'error', 'adapter': name, 'error': str(e)}, status=500)

    # Remove from registry and respond
    adapter_registry.pop(name, None)
    log(f'Adapter unloaded — name={name}')
    return web.json_response({'status': 'unloaded', 'adapter': name})


async def handle_proxy(request):
    """Proxy all non-/adapters requests to the model server transparently."""
    session = request.app['session']
    target_url = f'{MODEL_SERVER_BASE}{request.path_qs}'

    try:
        body = await request.read()
        async with session.request(
            method=request.method,
            url=target_url,
            headers={k: v for k, v in request.headers.items() if k.lower() != 'host'},
            data=body if body else None
        ) as resp:
            resp_body = await resp.read()
            response_headers = {k: v for k, v in resp.headers.items()
                                if k.lower() not in ('transfer-encoding', 'content-encoding', 'content-length')}
            return web.Response(status=resp.status, body=resp_body, headers=response_headers)
    except Exception as e:
        return web.json_response({'status': 'error', 'error': f'Model server unreachable: {e}'}, status=500)


# ── Application Setup ─────────────────────────────────────────────────────────

async def on_startup(app):
    """Create HTTP session, model server client, and start health polling background task."""
    app['session'] = ClientSession()
    app['model_server_client'] = create_model_server_client(app['session'], MODEL_SERVER_BASE, MODEL_SERVER_TYPE)
    app['health_task'] = asyncio.create_task(poll_model_server_health(app))
    log(f'Sidecar started — port={SIDECAR_PORT}, model_server_port={MODEL_SERVER_PORT}, '
        f'model_server_type={MODEL_SERVER_TYPE}, max_loras={MAX_LORAS}')


async def on_cleanup(app):
    """Cleanup HTTP session and cancel background tasks."""
    app['health_task'].cancel()
    try:
        await app['health_task']
    except asyncio.CancelledError:
        pass
    await app['session'].close()


def create_app():
    """Create and configure the aiohttp application."""
    app = web.Application()

    # Register routes
    app.router.add_get('/ping', handle_ping)
    app.router.add_post('/adapters', handle_adapters_post)
    app.router.add_delete('/adapters', handle_adapters_delete)

    # Catch-all proxy for everything else
    app.router.add_route('*', '/{path:.*}', handle_proxy)

    # Lifecycle hooks
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    return app


if __name__ == '__main__':
    app = create_app()
    web.run_app(app, host='0.0.0.0', port=SIDECAR_PORT, print=None)
