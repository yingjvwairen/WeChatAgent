"""Operator-only model loading, separate from speech-plugin credentials."""

import hashlib
import hmac
import json
import os
from pathlib import Path
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.routing import Route


def profile_data(file, fallback=None, *, limit=262144):
    if file:
        with Path(file).open('rb') as source:
            data = source.read(limit + 1)
    else:
        data = json.dumps(fallback, sort_keys=True, ensure_ascii=False, separators=(',', ':'), default=str).encode()
    if len(data) > limit:
        raise ValueError('Profile configuration is too large')
    return data


def profile_revision(data):
    return hashlib.sha256(data).hexdigest()


def selected_profile(file, profiles, fallback=None):
    if file and Path(file).is_file():
        value = json.loads(Path(file).read_text(encoding='utf-8'))
        if isinstance(value, dict) and value.get('profile') in profiles:
            return value['profile']
    return fallback if fallback in profiles else next(iter(profiles))


def save_selection(file, name):
    if not file:
        return
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + '.' + str(os.getpid()) + '.tmp')
    try:
        temporary.write_text(json.dumps({'version': 1, 'profile': name}), encoding='utf-8')
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)


def control_routes(service, key, lock, reload_profiles, revision, loaded_revision, selection_file=None):
    if not key:
        return []
    applying = False

    def authorize(request):
        supplied = request.headers.get('authorization', '').encode('latin-1')
        if request.headers.get('origin') or not hmac.compare_digest(supplied, ('Bearer ' + key).encode('ascii')):
            raise HTTPException(401)

    async def status(request):
        authorize(request)
        return JSONResponse(
            {
                'version': 1,
                'phase': 'loading' if applying else service.phase,
                'selectedProfile': service.selected,
                'loadedProfile': service.current,
                'revision': loaded_revision,
            }
        )

    async def use(request):
        nonlocal applying, loaded_revision
        authorize(request)
        length = request.headers.get('content-length', '')
        if (
            not length.isascii()
            or not length.isdigit()
            or not 0 < int(length) <= 4096
            or request.headers.get('transfer-encoding')
        ):
            raise HTTPException(413)
        try:
            body = await request.json()
        except ValueError:
            raise HTTPException(400) from None
        if not isinstance(body, dict) or set(body) != {'profile', 'revision'} or not isinstance(body['profile'], str):
            raise HTTPException(422)
        async with lock:
            if await request.is_disconnected():
                raise HTTPException(408)
            requested_revision = revision()
            if body['revision'] != requested_revision:
                raise HTTPException(409, 'Profile settings changed')
            previous_profiles = service.profiles
            previous_model = (service.current, service.loaded_signature)
            previous_phase = service.phase

            def rollback(*, disconnected=False):
                service.profiles = previous_profiles
                if (service.current, service.loaded_signature) != previous_model:
                    service.unload()
                    service.phase = 'failed'
                else:
                    service.phase = previous_phase if disconnected else 'failed'

            try:
                profiles, snapshot_revision = reload_profiles()
                if snapshot_revision != requested_revision:
                    raise HTTPException(409, 'Profile settings changed')
                if body['profile'] not in profiles:
                    raise HTTPException(404)
                applying = True
                service.phase = 'loading'
                service.profiles = profiles
                await run_in_threadpool(service.preload, body['profile'])
                if await request.is_disconnected():
                    raise HTTPException(408)
                if revision() != requested_revision:
                    raise HTTPException(409, 'Profile settings changed during loading')
                save_selection(selection_file, body['profile'])
                service.selected = body['profile']
                loaded_revision = requested_revision
                service.phase = 'ready'
            except HTTPException as error:
                if applying:
                    rollback(disconnected=error.status_code == 408)
                raise
            except Exception:
                rollback()
                raise HTTPException(503, 'Local model could not be loaded') from None
            finally:
                applying = False
            return JSONResponse(
                {
                    'version': 1,
                    'phase': 'ready',
                    'selectedProfile': service.selected,
                    'loadedProfile': service.current,
                    'revision': requested_revision,
                    'loaded': True,
                }
            )

    return [Route('/wca/status', status), Route('/wca/load', use, methods=['POST'])]
