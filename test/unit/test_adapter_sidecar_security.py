# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Security tests for templates/code/adapter_sidecar.py.

Covers path confinement and the generic error contract of ArtifactResolver,
safe tar.gz extraction, adapter-name validation, proxy path classification,
and MAX_LORAS accounting.

Fully offline. The resolver, extraction and path-classification tests run
everywhere; the HTTP handler tests need aiohttp and are skipped without it.
"""
import asyncio
import importlib.util
import io
import os
import re
import sys
import tarfile
import types

import pytest

_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
_SIDECAR_PATH = os.path.join(_REPO_ROOT, 'templates', 'code', 'adapter_sidecar.py')
_LORA_VLLM_PATH = os.path.join(_REPO_ROOT, 'templates', 'do', 'lib', 'python', 'lora_vllm.py')

try:
    import aiohttp  # noqa: F401
    from aiohttp import web
    from aiohttp.test_utils import TestServer
    HAS_AIOHTTP = True
except ImportError:
    HAS_AIOHTTP = False

needs_aiohttp = pytest.mark.skipif(not HAS_AIOHTTP, reason='aiohttp not installed')


def _load_sidecar():
    """Import the sidecar from its template path.

    The module imports aiohttp at top level; when aiohttp is unavailable a
    throwaway stub is installed just for the import so the pure functions can
    still be tested.
    """
    stubbed = False
    if not HAS_AIOHTTP:
        stub = types.ModuleType('aiohttp')
        stub.web = types.SimpleNamespace()
        stub.ClientSession = object
        stub.ClientTimeout = object
        sys.modules['aiohttp'] = stub
        stubbed = True
    try:
        spec = importlib.util.spec_from_file_location('adapter_sidecar_under_test', _SIDECAR_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if stubbed:
            sys.modules.pop('aiohttp', None)


@pytest.fixture
def sidecar(monkeypatch):
    module = _load_sidecar()
    monkeypatch.setattr(module, 'adapter_registry', {})
    return module


@pytest.fixture
def root(tmp_path, sidecar, monkeypatch):
    """An allowed root (canonicalized, since macOS tmp lives under a symlink)."""
    allowed = tmp_path / 'allowed'
    allowed.mkdir()
    monkeypatch.setattr(sidecar, 'ADAPTER_ALLOWED_ROOTS', (os.path.realpath(str(allowed)),))
    return os.path.realpath(str(allowed))


@pytest.fixture
def outside(tmp_path):
    out = tmp_path / 'outside'
    out.mkdir()
    return os.path.realpath(str(out))


# ── Helpers ──────────────────────────────────────────────────────────────────

def _write_adapter_dir(path):
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, 'adapter_config.json'), 'w') as f:
        f.write('{"peft_type": "LORA"}')
    with open(os.path.join(path, 'adapter_model.safetensors'), 'wb') as f:
        f.write(b'weights')


def _add_bytes(tar, name, data=b'x'):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    tar.addfile(info, io.BytesIO(data))


def _write_good_tar(tar_path):
    with tarfile.open(tar_path, 'w:gz') as tar:
        _add_bytes(tar, 'adapter_config.json', b'{"peft_type": "LORA"}')
        _add_bytes(tar, 'adapter_model.safetensors', b'weights')


def _write_tar_with(tar_path, special):
    """A tar.gz with one benign member followed by one `special` member."""
    with tarfile.open(tar_path, 'w:gz') as tar:
        _add_bytes(tar, 'adapter_config.json', b'{"peft_type": "LORA"}')
        special(tar)


def _snapshot(path):
    """All entries (files, dirs, links) under path, relative to it."""
    found = set()
    for dirpath, dirnames, filenames in os.walk(path):
        for entry in dirnames + filenames:
            found.add(os.path.relpath(os.path.join(dirpath, entry), path))
    return found


def _assert_generic(sidecar, excinfo):
    assert str(excinfo.value) == sidecar.ADAPTER_ARTIFACT_ERROR
    assert isinstance(excinfo.value, sidecar.AdapterArtifactError)


# ── Allowed paths resolve ────────────────────────────────────────────────────

def test_dir_with_adapter_config_resolves(sidecar, root):
    adapter = os.path.join(root, 'adapters', 'a1')
    _write_adapter_dir(adapter)
    assert sidecar.ArtifactResolver.resolve(adapter) == adapter


def test_dir_with_single_tar_gz_extracts_and_resolves(sidecar, root):
    adapter = os.path.join(root, 'a2')
    os.makedirs(adapter)
    _write_good_tar(os.path.join(adapter, 'adapter.tar.gz'))
    assert sidecar.ArtifactResolver.resolve(adapter) == adapter
    assert os.path.isfile(os.path.join(adapter, 'adapter_config.json'))


def test_direct_tar_gz_file_extracts_to_parent(sidecar, root):
    adapter = os.path.join(root, 'a3')
    os.makedirs(adapter)
    tar_path = os.path.join(adapter, 'a3.tar.gz')
    _write_good_tar(tar_path)
    assert sidecar.ArtifactResolver.resolve(tar_path) == adapter
    assert os.path.isfile(os.path.join(adapter, 'adapter_config.json'))


def test_root_itself_is_allowed(sidecar, root):
    _write_adapter_dir(root)
    assert sidecar.ArtifactResolver.resolve(root) == root


def test_symlink_staying_inside_root_is_allowed(sidecar, root):
    real = os.path.join(root, 'real')
    _write_adapter_dir(real)
    link = os.path.join(root, 'link')
    os.symlink(real, link)
    assert sidecar.ArtifactResolver.resolve(link) == real


# ── Rejections all look identical to the client ──────────────────────────────

def test_outside_root_rejected(sidecar, root, outside):
    _write_adapter_dir(outside)
    with pytest.raises(sidecar.AdapterArtifactError) as excinfo:
        sidecar.ArtifactResolver.resolve(outside)
    _assert_generic(sidecar, excinfo)


def test_dotdot_traversal_rejected(sidecar, root, outside):
    _write_adapter_dir(outside)
    sneaky = os.path.join(root, '..', os.path.basename(outside))
    with pytest.raises(sidecar.AdapterArtifactError) as excinfo:
        sidecar.ArtifactResolver.resolve(sneaky)
    _assert_generic(sidecar, excinfo)


def test_symlink_escaping_root_rejected(sidecar, root, outside):
    _write_adapter_dir(outside)
    link = os.path.join(root, 'escape')
    os.symlink(outside, link)
    with pytest.raises(sidecar.AdapterArtifactError) as excinfo:
        sidecar.ArtifactResolver.resolve(link)
    _assert_generic(sidecar, excinfo)


def test_tar_symlink_inside_dir_escaping_root_rejected(sidecar, root, outside):
    """The tar path derived from the directory listing is re-confined."""
    _write_good_tar(os.path.join(outside, 'real.tar.gz'))
    adapter = os.path.join(root, 'a4')
    os.makedirs(adapter)
    os.symlink(os.path.join(outside, 'real.tar.gz'), os.path.join(adapter, 'adapter.tar.gz'))
    with pytest.raises(sidecar.AdapterArtifactError) as excinfo:
        sidecar.ArtifactResolver.resolve(adapter)
    _assert_generic(sidecar, excinfo)
    assert not os.path.exists(os.path.join(adapter, 'adapter_config.json'))


@pytest.mark.parametrize('src', ['relative/path', 'adapters', './x', '', '/opt/ml/\x00x'])
def test_relative_empty_or_nul_rejected(sidecar, root, src):
    with pytest.raises(sidecar.AdapterArtifactError) as excinfo:
        sidecar.ArtifactResolver.resolve(src)
    _assert_generic(sidecar, excinfo)


def test_missing_file_empty_and_unrecognized_inside_root_are_indistinguishable(sidecar, root):
    """No filesystem oracle: every failure inside the root gives the same message."""
    plain_file = os.path.join(root, 'plain.txt')
    with open(plain_file, 'w') as f:
        f.write('x')
    empty_dir = os.path.join(root, 'empty')
    os.makedirs(empty_dir)
    junk_dir = os.path.join(root, 'junk')
    os.makedirs(junk_dir)
    with open(os.path.join(junk_dir, 'notes.txt'), 'w') as f:
        f.write('x')
    corrupt = os.path.join(root, 'corrupt')
    os.makedirs(corrupt)
    with open(os.path.join(corrupt, 'bad.tar.gz'), 'wb') as f:
        f.write(b'not a gzip stream')

    messages = set()
    for src in (os.path.join(root, 'missing'), plain_file, empty_dir, junk_dir, corrupt, '/etc'):
        with pytest.raises(sidecar.AdapterArtifactError) as excinfo:
            sidecar.ArtifactResolver.resolve(src)
        messages.add(str(excinfo.value))
        assert excinfo.value.detail  # specific reason kept for the server log
    assert messages == {sidecar.ADAPTER_ARTIFACT_ERROR}


def test_allowed_roots_parsing():
    module = _load_sidecar()
    parsed = module._parse_allowed_roots(os.pathsep.join(['/opt/ml', 'relative', '', '  ']))
    assert parsed == (os.path.realpath('/opt/ml'),)
    assert module._parse_allowed_roots('') == ()


def test_no_valid_roots_refuses_everything(sidecar, root, monkeypatch):
    _write_adapter_dir(os.path.join(root, 'a'))
    monkeypatch.setattr(sidecar, 'ADAPTER_ALLOWED_ROOTS', ())
    with pytest.raises(sidecar.AdapterArtifactError):
        sidecar.ArtifactResolver.resolve(os.path.join(root, 'a'))


def test_sibling_prefix_is_not_inside_root(sidecar, root):
    """commonpath, not string prefix: <root>-evil is not inside <root>."""
    sibling = root + '-evil'
    _write_adapter_dir(sibling)
    with pytest.raises(sidecar.AdapterArtifactError):
        sidecar.ArtifactResolver.resolve(sibling)


# ── Safe tar extraction ──────────────────────────────────────────────────────

def _dotdot(tar):
    _add_bytes(tar, '../escaped.txt')


def _nested_dotdot(tar):
    _add_bytes(tar, 'sub/../../escaped.txt')


def _absolute(tar):
    _add_bytes(tar, '/tmp/mlcc-sidecar-abs-escape.txt')


def _symlink(tar):
    info = tarfile.TarInfo('link')
    info.type = tarfile.SYMTYPE
    info.linkname = '/etc/passwd'
    tar.addfile(info)


def _hardlink(tar):
    info = tarfile.TarInfo('hard')
    info.type = tarfile.LNKTYPE
    info.linkname = 'adapter_config.json'
    tar.addfile(info)


def _fifo(tar):
    info = tarfile.TarInfo('pipe')
    info.type = tarfile.FIFOTYPE
    tar.addfile(info)


def _chardev(tar):
    info = tarfile.TarInfo('dev')
    info.type = tarfile.CHRTYPE
    tar.addfile(info)


@pytest.mark.parametrize('special', [_dotdot, _nested_dotdot, _absolute, _symlink, _hardlink, _fifo, _chardev])
def test_unsafe_archive_rejected_and_nothing_written(sidecar, root, tmp_path, special):
    adapter = os.path.join(root, 'evil')
    os.makedirs(adapter)
    tar_path = os.path.join(adapter, 'adapter.tar.gz')
    _write_tar_with(tar_path, special)
    before_tmp = _snapshot(str(tmp_path))

    with pytest.raises(sidecar.AdapterArtifactError) as excinfo:
        sidecar.ArtifactResolver.resolve(adapter)
    _assert_generic(sidecar, excinfo)

    # Nothing extracted inside (not even the benign member) or outside.
    assert os.listdir(adapter) == ['adapter.tar.gz']
    assert _snapshot(str(tmp_path)) == before_tmp
    assert not os.path.exists('/tmp/mlcc-sidecar-abs-escape.txt')


def test_unsafe_archive_rejected_by_extract_without_data_filter(sidecar, root, monkeypatch):
    """Member validation does not depend on tarfile.data_filter (Python < 3.12 path)."""
    monkeypatch.delattr(tarfile, 'data_filter', raising=False)
    adapter = os.path.join(root, 'old-python')
    os.makedirs(adapter)
    tar_path = os.path.join(adapter, 'adapter.tar.gz')
    _write_tar_with(tar_path, _symlink)
    with pytest.raises(RuntimeError):
        sidecar.ArtifactResolver._extract_tar_gz(tar_path, adapter)
    assert os.listdir(adapter) == ['adapter.tar.gz']

    good = os.path.join(root, 'old-python-good')
    os.makedirs(good)
    _write_good_tar(os.path.join(good, 'adapter.tar.gz'))
    assert sidecar.ArtifactResolver.resolve(good) == good
    assert os.path.isfile(os.path.join(good, 'adapter_config.json'))


def test_preexisting_symlink_in_extract_dir_cannot_redirect_member(sidecar, root, outside):
    adapter = os.path.join(root, 'redirect')
    os.makedirs(adapter)
    os.symlink(outside, os.path.join(adapter, 'sub'))
    tar_path = os.path.join(adapter, 'adapter.tar.gz')
    with tarfile.open(tar_path, 'w:gz') as tar:
        _add_bytes(tar, 'sub/adapter_config.json')
    # Two entries now (symlink + tar), so call the extractor directly.
    with pytest.raises(RuntimeError):
        sidecar.ArtifactResolver._extract_tar_gz(tar_path, adapter)
    assert os.listdir(outside) == []


def test_member_count_limit(sidecar, root, monkeypatch):
    monkeypatch.setattr(sidecar, 'ADAPTER_MAX_EXTRACT_MEMBERS', 2)
    adapter = os.path.join(root, 'many')
    os.makedirs(adapter)
    with tarfile.open(os.path.join(adapter, 'adapter.tar.gz'), 'w:gz') as tar:
        for i in range(3):
            _add_bytes(tar, f'f{i}')
    with pytest.raises(sidecar.AdapterArtifactError):
        sidecar.ArtifactResolver.resolve(adapter)
    assert os.listdir(adapter) == ['adapter.tar.gz']


def test_uncompressed_size_limit(sidecar, root, monkeypatch):
    monkeypatch.setattr(sidecar, 'ADAPTER_MAX_EXTRACT_BYTES', 10)
    adapter = os.path.join(root, 'big')
    os.makedirs(adapter)
    with tarfile.open(os.path.join(adapter, 'adapter.tar.gz'), 'w:gz') as tar:
        _add_bytes(tar, 'adapter_config.json', b'0' * 11)
    with pytest.raises(sidecar.AdapterArtifactError):
        sidecar.ArtifactResolver.resolve(adapter)
    assert os.listdir(adapter) == ['adapter.tar.gz']


# ── Adapter name validation ──────────────────────────────────────────────────

@pytest.mark.parametrize('name', ['a', 'sft-w6', 'dpo_w6', 'Adapter.v2', '0abc', 'a' * 128])
def test_valid_names(sidecar, name):
    assert sidecar.is_valid_adapter_name(name)


@pytest.mark.parametrize('name', [
    '', '-lead', '.hidden', '_x', 'a' * 129, 'a/b', '../x', 'a b', 'a\n', 'a\x00', 'é', None,
])
def test_invalid_names(sidecar, name):
    assert not sidecar.is_valid_adapter_name(name)


# ── Proxy path classification ────────────────────────────────────────────────

BLOCKED_TARGETS = [
    '/v1/load_lora_adapter',
    '/v1/unload_lora_adapter',
    '//v1/load_lora_adapter',
    '/v1//load_lora_adapter',
    '/v1/./load_lora_adapter',
    '/v1/x/../load_lora_adapter',
    '/V1/LOAD_LORA_ADAPTER',
    '/v1/load_lora_adapter/',
    '/v1/load_lora_adapter?x=1',
    '/v1%2Fload_lora_adapter',
    '/v1%2fload_lora_adapter',
    '%2Fv1%2Fload_lora_adapter',
    '/v1%5Cload_lora_adapter',
    '/v1\\load_lora_adapter',
    '/v1/%2e/load_lora_adapter',
    '/v1/load%5flora%5fadapter',
    '/v1/load_lora_adapter%252F',
    '/load_lora_adapter',
    '/unload_lora_adapter',
    'http://localhost:8081/v1/load_lora_adapter',
]

ALLOWED_TARGETS = [
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/models',
    '/invocations',
    '/invocations?foo=bar',
    '/health',
    '/metrics',
    '/v1/load_lora_adapter_docs',
    '/',
]


@pytest.mark.parametrize('target', BLOCKED_TARGETS)
def test_proxy_blocks_adapter_mutation_paths(sidecar, target):
    assert sidecar.proxy_path_rejection_reason(target) is not None


@pytest.mark.parametrize('target', ALLOWED_TARGETS)
def test_proxy_allows_normal_paths(sidecar, target):
    assert sidecar.proxy_path_rejection_reason(target) is None


def test_blocked_paths_cover_every_server_type(sidecar):
    for server_type, paths in sidecar.MODEL_SERVER_ADAPTER_MUTATION_PATHS.items():
        for path in paths:
            assert path.lower() in sidecar.BLOCKED_PROXY_PATHS, (server_type, path)


def test_blocked_paths_cover_lora_vllm_client_endpoints(sidecar):
    """Drift guard: the vLLM endpoints do/adapter's lora_vllm.py posts to are blocked."""
    with open(_LORA_VLLM_PATH) as f:
        source = f.read()
    endpoints = set(re.findall(r'(/v1/(?:un)?load_lora_adapter)', source))
    assert endpoints == {'/v1/load_lora_adapter', '/v1/unload_lora_adapter'}
    assert endpoints <= set(sidecar.MODEL_SERVER_ADAPTER_MUTATION_PATHS['vllm'])


# ── HTTP handlers (aiohttp) ──────────────────────────────────────────────────

class _FakeModelServer:
    """Upstream stand-in that records what reaches it."""

    def __init__(self):
        self.requests = []
        self.load_status = 200
        self.load_body = 'ok'

    def app(self):
        app = web.Application()
        app.router.add_get('/health', self._health)
        app.router.add_post('/v1/load_lora_adapter', self._load)
        app.router.add_post('/v1/unload_lora_adapter', self._unload)
        app.router.add_route('*', '/{path:.*}', self._echo)
        return app

    async def _health(self, request):
        return web.Response(text='ok')

    async def _load(self, request):
        self.requests.append(('load', request.path, await request.json()))
        return web.Response(status=self.load_status, text=self.load_body)

    async def _unload(self, request):
        self.requests.append(('unload', request.path, await request.json()))
        return web.Response(text='ok')

    async def _echo(self, request):
        self.requests.append(('proxy', request.raw_path, None))
        return web.json_response({'echo': request.raw_path})


async def _raw_http(port, method, target, body=b''):
    """Send an HTTP/1.1 request with the exact request-target bytes given."""
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    head = (
        f'{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n'
        f'Content-Length: {len(body)}\r\nConnection: close\r\n\r\n'
    )
    writer.write(head.encode('latin-1') + body)
    await writer.drain()
    data = await reader.read()
    writer.close()
    status = int(data.split(b' ', 2)[1])
    return status, data.split(b'\r\n\r\n', 1)[1]


def _run_with_servers(sidecar, monkeypatch, scenario, upstream=None):
    upstream = upstream or _FakeModelServer()

    async def main():
        up = TestServer(upstream.app())
        await up.start_server()
        monkeypatch.setattr(sidecar, 'MODEL_SERVER_BASE', f'http://127.0.0.1:{up.port}')
        front = TestServer(sidecar.create_app())
        await front.start_server()
        try:
            return await scenario(front.port, upstream)
        finally:
            await front.close()
            await up.close()

    return asyncio.run(main())


@needs_aiohttp
@pytest.mark.parametrize('target', [
    '/v1/load_lora_adapter',
    '//v1/load_lora_adapter',
    '/v1/./load_lora_adapter',
    '/V1/LOAD_LORA_ADAPTER',
    '/v1/load_lora_adapter/',
    '/v1%2Fload_lora_adapter',
    '/v1%2fload_lora_adapter',
    '/v1/unload_lora_adapter',
])
def test_http_proxy_refuses_adapter_mutation(sidecar, monkeypatch, target):
    async def scenario(port, upstream):
        status, body = await _raw_http(port, 'POST', target, b'{"lora_name":"x","lora_path":"/etc"}')
        return status, body, list(upstream.requests)

    status, body, seen = _run_with_servers(sidecar, monkeypatch, scenario)
    assert status == 403
    assert b'Forbidden' in body
    assert seen == []


@needs_aiohttp
@pytest.mark.parametrize('method,target', [
    ('POST', '/v1/chat/completions'),
    ('GET', '/v1/models'),
    ('POST', '/invocations'),
])
def test_http_proxy_forwards_normal_paths(sidecar, monkeypatch, method, target):
    async def scenario(port, upstream):
        status, _ = await _raw_http(port, method, target, b'{}' if method == 'POST' else b'')
        return status, list(upstream.requests)

    status, seen = _run_with_servers(sidecar, monkeypatch, scenario)
    assert status == 200
    assert seen == [('proxy', target, None)]


@needs_aiohttp
@pytest.mark.parametrize('method', ['POST', 'DELETE'])
@pytest.mark.parametrize('name', ['../x', '-x', 'a%20b', 'a' * 129])
def test_http_invalid_name_rejected(sidecar, root, monkeypatch, method, name):
    _write_adapter_dir(os.path.join(root, 'ok'))
    target = f'/adapters?name={name}&src={os.path.join(root, "ok")}'

    async def scenario(port, upstream):
        status, _ = await _raw_http(port, method, target)
        return status, list(upstream.requests)

    status, seen = _run_with_servers(sidecar, monkeypatch, scenario)
    assert status == 400
    assert seen == []


@needs_aiohttp
def test_http_resolution_failures_are_generic(sidecar, root, outside, monkeypatch):
    empty = os.path.join(root, 'empty')
    os.makedirs(empty)
    probes = [outside, '/etc/passwd', os.path.join(root, 'missing'), empty, 'relative']

    async def scenario(port, upstream):
        results = []
        for src in probes:
            results.append(await _raw_http(port, 'POST', f'/adapters?name=a1&src={src}'))
        return results, list(upstream.requests)

    results, seen = _run_with_servers(sidecar, monkeypatch, scenario)
    bodies = {body for _, body in results}
    assert {status for status, _ in results} == {404}
    assert len(bodies) == 1
    assert sidecar.ADAPTER_ARTIFACT_ERROR.encode() in bodies.pop()
    assert seen == []


@needs_aiohttp
def test_http_load_success_does_not_echo_path(sidecar, root, monkeypatch):
    adapter = os.path.join(root, 'good')
    _write_adapter_dir(adapter)

    async def scenario(port, upstream):
        status, body = await _raw_http(port, 'POST', f'/adapters?name=good&src={adapter}')
        return status, body, list(upstream.requests)

    status, body, seen = _run_with_servers(sidecar, monkeypatch, scenario)
    assert status == 200
    assert root.encode() not in body
    assert seen == [('load', '/v1/load_lora_adapter', {'lora_name': 'good', 'lora_path': adapter})]
    assert sidecar.adapter_registry == {'good': adapter}


@needs_aiohttp
def test_http_model_server_error_not_echoed(sidecar, root, monkeypatch):
    adapter = os.path.join(root, 'good')
    _write_adapter_dir(adapter)
    upstream = _FakeModelServer()
    upstream.load_status = 400
    upstream.load_body = f'cannot read {adapter}/adapter_model.safetensors'

    async def scenario(port, _upstream):
        return await _raw_http(port, 'POST', f'/adapters?name=good&src={adapter}')

    status, body = _run_with_servers(sidecar, monkeypatch, scenario, upstream=upstream)
    assert status == 500
    assert root.encode() not in body
    assert sidecar.adapter_registry == {}


@needs_aiohttp
def test_http_max_loras_reregister_and_limit(sidecar, root, monkeypatch):
    monkeypatch.setattr(sidecar, 'MAX_LORAS', 2)
    for n in ('a1', 'a2', 'a3'):
        _write_adapter_dir(os.path.join(root, n))

    async def scenario(port, upstream):
        post = lambda n: _raw_http(port, 'POST', f'/adapters?name={n}&src={os.path.join(root, n)}')  # noqa: E731
        return [
            (await post('a1'))[0],
            (await post('a2'))[0],
            (await post('a1'))[0],   # re-register at the limit: replaces, no extra slot
            (await post('a3'))[0],   # new name at the limit: refused
        ]

    statuses = _run_with_servers(sidecar, monkeypatch, scenario)
    assert statuses == [200, 200, 200, 507]
    assert set(sidecar.adapter_registry) == {'a1', 'a2'}


@needs_aiohttp
def test_http_max_loras_checked_before_filesystem(sidecar, root, monkeypatch):
    monkeypatch.setattr(sidecar, 'MAX_LORAS', 0)
    calls = []
    monkeypatch.setattr(sidecar.ArtifactResolver, 'resolve', staticmethod(lambda *a, **k: calls.append(a)))

    async def scenario(port, upstream):
        return await _raw_http(port, 'POST', f'/adapters?name=a1&src={root}')

    status, _ = _run_with_servers(sidecar, monkeypatch, scenario)
    assert status == 507
    assert calls == []
