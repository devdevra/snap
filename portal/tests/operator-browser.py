#!/usr/bin/env python3
"""Operator E2E with mocked Auth, operator API and signed Storage PUTs only."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'portal' / 'test-results'
URL = 'http://127.0.0.1:4175/'
ORIGIN = 'https://mock-operator.supabase.co'
OPERATOR = '11111111-1111-4111-8111-111111111111'
CUSTOMER = '55555555-5555-4555-8555-555555555555'
TENANT = '22222222-2222-4222-8222-222222222222'
ASSET = '33333333-3333-4333-8333-333333333333'
VERSION = '44444444-4444-4444-8444-444444444444'
REVISION = '66666666-6666-4666-8666-666666666666'
TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.signature'
REPORT = {'status': 'running', 'tests': [], 'page_errors': [], 'unexpected_requests': [], 'source': 'Mock Auth, operator RPC API and signed Storage. No real account, database, email or Storage writes.'}


def main():
    from playwright.sync_api import sync_playwright, expect
    RESULTS.mkdir(parents=True, exist_ok=True)
    log = (RESULTS / 'operator-preview-server.log').open('w', encoding='utf-8')
    server = subprocess.Popen(['node', 'portal/dev-server.mjs', '--host', '127.0.0.1', '--port', '4175'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    browser = None
    try:
        deadline = time.monotonic() + 15
        while True:
            if server.poll() is not None:
                raise RuntimeError('Preview server exited early')
            try:
                with urllib.request.urlopen(URL, timeout=.5) as response:
                    if response.status == 200:
                        break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(.1)
        with sync_playwright() as p:
            launch = {'headless': True, 'args': ['--no-sandbox']}
            if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
                launch['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
            browser = p.chromium.launch(**launch)

            def create_page(width=1487, denied=False, fail_preview=False, existing=False):
                context = browser.new_context(viewport={'width': width, 'height': 1058 if width > 600 else 844}, locale='ko-KR', timezone_id='Asia/Seoul', reduced_motion='reduce')
                state = {'tenants': [], 'members': [], 'assets': [], 'requests': [], 'reservations': {}, 'uploads': {}, 'counter': 0, 'fail_preview': fail_preview, 'commits': 0}
                terms = {'access_allowed': True, 'access_start_date': '2026-01-01', 'access_end_date': '2099-12-31', 'rights_status': 'pending', 'rights_start_date': '2026-01-01', 'rights_end_date': '2099-12-31', 'allowed_channels': ['instagram'], 'allowed_purposes': ['organic'], 'final_delivery_paid': False}
                tenant = {'id': TENANT, 'name': '검증 숙소'}
                member = {'tenant_id': TENANT, 'user_id': CUSTOMER, 'email': 'verified-customer@example.com', 'active': True, 'access_allowed': True, 'access_start_date': '2026-01-01', 'access_end_date': '2099-12-31'}
                if existing:
                    state['tenants'] = [tenant]; state['members'] = [member]
                    state['assets'] = [{'id': ASSET, 'tenant_id': TENANT, 'title': '기존 전달 작업', 'assigned_approver_id': CUSTOMER, 'latest_version_id': VERSION, 'latest_version': {'id': VERSION, 'version_number': 2}, 'open_revision': {'id': REVISION, 'message': '마지막 객실명을 수정해 주세요.', 'version_id': VERSION}, **terms}]
                page = context.new_page()
                page.on('pageerror', lambda error: REPORT['page_errors'].append(str(error)))
                page.set_default_timeout(15000)
                session = {'origin': ORIGIN, 'access_token': TOKEN, 'refresh_token': 'operator-refresh', 'expires_at': int(time.time()) + 3600, 'user': {'id': OPERATOR, 'email': 'operator@example.com'}}
                page.add_init_script(f"sessionStorage.setItem('staycut.customer.session.v1', {json.dumps(json.dumps(session))})")
                # Chromium's CDP request event omits File-backed XHR bodies. Materialize
                # the identical bytes in this test only, so the intercepted real PUT
                # body remains observable and its exact length/SHA-256 can be checked.
                # Production still sends the File directly; headers, XHR progress,
                # HTTP failures and the commit-after-both-PUTs ordering are unchanged.
                page.add_init_script("""(() => {
                  const send = XMLHttpRequest.prototype.send;
                  XMLHttpRequest.prototype.send = function(body) {
                    if (body instanceof Blob) {
                      body.arrayBuffer().then(bytes => send.call(this, bytes)).catch(() => {
                        this.dispatchEvent(new ProgressEvent('error'));
                      });
                    } else send.call(this, body);
                  };
                })();""")
                def fulfill(route, status, data):
                    route.fulfill(status=status, content_type='application/json', headers={'access-control-allow-origin': URL.rstrip('/'), 'access-control-allow-headers': 'apikey,authorization,content-type,x-upsert', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS'}, body=json.dumps(data))
                page.route('**/api/config', lambda route: fulfill(route, 200, {'supabaseUrl': ORIGIN, 'publishableKey': 'sb_publishable_operator-mock'}))

                def operator_api(route):
                    request = route.request
                    body = request.post_data_json
                    state['requests'].append(body)
                    assert request.headers.get('authorization') == f'Bearer {TOKEN}'
                    assert not any(key in body for key in ['actorId', 'operatorId', 'userId', 'secretKey'])
                    action = body['action']
                    if denied:
                        fulfill(route, 403, {'code': 'OPERATOR_REQUIRED', 'error': '운영자 권한이 필요합니다.'}); return
                    if action == 'context':
                        fulfill(route, 200, {'operator': {'user_id': OPERATOR}, 'tenants': state['tenants'], 'members': state['members'], 'assets': state['assets']})
                    elif action == 'createTenant':
                        assert body['customerEmail'] == 'verified-customer@example.com'
                        assert body['accessStartDate'] and body['accessEndDate']
                        state['tenants'] = [{'id': TENANT, 'name': body['name']}]; state['members'] = [member]
                        fulfill(route, 200, {'tenantId': TENANT, 'customerId': CUSTOMER})
                    elif action == 'prepareUpload':
                        assert body['delivery']['sha256'] != body['preview']['sha256']
                        assert body['delivery']['mimeType'] == 'video/webm' and body['preview']['mimeType'] == 'video/webm'
                        if body['assetId']:
                            assert body['expectedRevisionId'] == REVISION
                            assert body['expectedLatestVersionId'] == VERSION
                            assert not any(key in body for key in ['title', 'assignedApproverId', 'terms'])
                        else:
                            assert body['assignedApproverId'] == CUSTOMER
                            assert body['terms']['rightsStatus'] == 'pending'
                            assert body['terms']['finalDeliveryPaid'] is False
                        state['counter'] += 1
                        session_id = f'77777777-7777-4777-8777-{state["counter"]:012d}'
                        version_id = f'88888888-8888-4888-8888-{state["counter"]:012d}'
                        payload = {'sessionId': session_id, 'tenantId': TENANT, 'assetId': ASSET, 'versionId': version_id, 'status': 'prepared', 'expiresAt': '2099-12-31T00:00:00Z'}
                        for kind in ['delivery', 'preview']:
                            payload[kind] = {**body[kind], 'url': f'{ORIGIN}/storage/v1/object/upload/sign/staycut-deliverables/staging/{session_id}/{kind}.webm?token=temporary'}
                        state['reservations'][session_id] = {'input': body, 'response': payload}
                        fulfill(route, 200, payload)
                    elif action == 'commitUpload':
                        reservation = state['reservations'][body['sessionId']]
                        for kind in ['delivery', 'preview']:
                            uploaded = state['uploads'].get((body['sessionId'], kind))
                            assert uploaded is not None, f'Missing observed PUT bytes for {kind}; keys={list(state["uploads"])}'
                            expected = reservation['input'][kind]
                            assert len(uploaded) == expected['bytes'] and hashlib.sha256(uploaded).hexdigest() == expected['sha256']
                        state['commits'] += 1
                        prepared = reservation['input']
                        if not prepared['assetId']:
                            t = prepared['terms']
                            new_terms = {'access_allowed': t['accessAllowed'], 'access_start_date': t['accessStartDate'], 'access_end_date': t['accessEndDate'], 'rights_status': t['rightsStatus'], 'rights_start_date': t['rightsStartDate'], 'rights_end_date': t['rightsEndDate'], 'allowed_channels': t['allowedChannels'], 'allowed_purposes': t['allowedPurposes'], 'final_delivery_paid': t['finalDeliveryPaid']}
                            state['assets'] = [{'id': ASSET, 'tenant_id': TENANT, 'title': prepared['title'], 'assigned_approver_id': CUSTOMER, 'latest_version_id': reservation['response']['versionId'], 'latest_version': {'id': reservation['response']['versionId'], 'version_number': 1}, 'open_revision': None, **new_terms}]
                        else:
                            state['assets'][0]['latest_version_id'] = reservation['response']['versionId']; state['assets'][0]['open_revision'] = None
                        fulfill(route, 200, {**{key: reservation['response'][key] for key in ['sessionId', 'tenantId', 'assetId', 'versionId']}, 'status': 'committed'})
                    elif action == 'updateAsset':
                        assert body['assetId'] == ASSET
                        state['assets'][0]['final_delivery_paid'] = body['terms']['finalDeliveryPaid']
                        state['assets'][0]['rights_status'] = body['terms']['rightsStatus']
                        fulfill(route, 200, {'assetId': ASSET})
                    else:
                        REPORT['unexpected_requests'].append(action); fulfill(route, 400, {})
                page.route('**/api/operator', operator_api)

                def supabase(route):
                    request = route.request
                    if request.method == 'OPTIONS':
                        fulfill(route, 200, {}); return
                    path = request.url.split(ORIGIN)[1]
                    if path == '/auth/v1/user':
                        fulfill(route, 200, {'id': OPERATOR, 'email': 'operator@example.com'})
                    elif path.startswith('/rest/v1/'):
                        fulfill(route, 200, [])
                    elif path.startswith('/storage/v1/object/upload/sign/staycut-deliverables/staging/'):
                        assert request.method == 'PUT'
                        assert request.headers.get('authorization') is None
                        assert request.headers.get('content-type') == 'video/webm'
                        assert request.headers.get('x-upsert') == 'false'
                        session_id, filename = path.split('/staging/')[1].split('/')
                        kind = filename.split('.')[0]
                        if kind == 'preview' and state['fail_preview']:
                            state['fail_preview'] = False; fulfill(route, 500, {'error': 'test transfer failure'}); return
                        payload = request.post_data_buffer
                        assert payload is not None, f'Chromium did not expose the materialized {kind} PUT body'
                        expected = state['reservations'][session_id]['input'][kind]
                        assert len(payload) == expected['bytes'], f'{kind} PUT byte length differs from its reservation'
                        assert hashlib.sha256(payload).hexdigest() == expected['sha256'], f'{kind} PUT hash differs from its reservation'
                        state['uploads'][(session_id, kind)] = payload
                        fulfill(route, 200, {'Key': f'staging/{session_id}/{filename}'})
                    else:
                        REPORT['unexpected_requests'].append(request.url); fulfill(route, 404, {})
                page.route(f'{ORIGIN}/**', supabase)
                page.goto(URL + '#manage', wait_until='networkidle')
                return context, page, state

            def no_overflow(page):
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Horizontal overflow in operator console'

            def fill_files(page):
                page.locator('#operator-delivery').set_input_files(str(ROOT / 'portal/assets/intro-preview.webm'))
                page.locator('#operator-preview').set_input_files(str(ROOT / 'portal/assets/room-preview.webm'))
                page.locator('#operator-preview-confirm').check()

            def case(name, callback):
                try:
                    callback(); REPORT['tests'].append({'name': name, 'status': 'passed'})
                except Exception as error:
                    REPORT['tests'].append({'name': name, 'status': 'failed', 'error': str(error)}); raise

            def create_assign_upload():
                context, page, state = create_page(fail_preview=True)
                expect(page.locator('#operator-tenant-form')).to_be_visible()
                page.locator('#operator-tenant-name').fill('검증 숙소')
                page.locator('#operator-customer-email').fill('verified-customer@example.com')
                page.locator('#operator-member-start').fill('2026-01-01')
                page.locator('#operator-member-end').fill('2099-12-31')
                page.locator('#operator-tenant-form button[type=submit]').click()
                expect(page.locator('#operator-upload-form')).to_be_visible()
                expect(page.locator('.operator-member-list')).to_contain_text('verified-customer@example.com')
                page.locator('#operator-title').fill('가을 객실 소개 영상')
                page.locator('#operator-approver').select_option(CUSTOMER)
                page.locator('#operator-new-access-end').fill('2099-12-31')
                page.locator('#operator-new-rights-end').fill('2099-12-31')
                page.locator('#operator-upload-form [name=accessAllowed]').check()
                assert not page.locator('#operator-upload-form [name=finalDeliveryPaid]').is_checked()
                assert page.locator('#operator-new-rights-status').input_value() == 'pending'
                fill_files(page)
                page.locator('#operator-upload-submit').click()
                expect(page.locator('.operator-error')).to_contain_text('파일 업로드를 완료하지 못했습니다.')
                expect(page.locator('#operator-title')).to_have_value('가을 객실 소개 영상')
                assert page.locator('#operator-delivery').evaluate('input => input.files.length') == 1
                assert page.locator('#operator-preview').evaluate('input => input.files.length') == 1
                assert state['commits'] == 0 and not state['assets']
                page.locator('#operator-upload-submit').click()
                expect(page.locator('.operator-message')).to_contain_text('새 버전을 등록했습니다.')
                assert state['counter'] == 2 and state['commits'] == 1
                expect(page.locator('#operator-terms-form')).to_be_visible()
                assert not state['assets'][0]['final_delivery_paid'] and state['assets'][0]['rights_status'] == 'pending'
                # Changing contract state is a separate explicit save.
                page.locator('#operator-edit-rights-status').select_option('valid')
                page.locator('#operator-terms-form [name=rightsConfirmed]').check()
                page.locator('#operator-terms-form [name=finalDeliveryPaid]').check()
                page.locator('#operator-terms-form button[type=submit]').click()
                expect(page.locator('.operator-message')).to_contain_text('수납 조건을 저장했습니다.')
                assert state['assets'][0]['final_delivery_paid'] and state['assets'][0]['rights_status'] == 'valid'
                no_overflow(page)
                page.screenshot(path=str(RESULTS / 'operator-desktop-delivery.png'), full_page=True)
                context.close()

            def existing_revision_and_mobile():
                context, page, state = create_page(width=390, existing=True)
                expect(page.locator('#operator-target')).to_be_visible()
                page.locator('#operator-target').select_option(ASSET)
                expect(page.locator('#operator-existing-job')).to_contain_text('마지막 객실명을 수정해 주세요.')
                expect(page.locator('#operator-new-job')).to_be_hidden()
                page.locator('[name=revisionReviewed]').check()
                page.locator('#operator-change-summary').fill('요청한 마지막 객실명을 반영했습니다.')
                fill_files(page)
                no_overflow(page)
                page.screenshot(path=str(RESULTS / 'operator-mobile-revision-review.png'), full_page=True)
                page.locator('#operator-upload-submit').click()
                expect(page.locator('.operator-message')).to_contain_text('새 버전을 등록했습니다.')
                assert state['commits'] == 1 and state['assets'][0]['open_revision'] is None
                request = next(item for item in state['requests'] if item['action'] == 'prepareUpload')
                assert request['expectedRevisionId'] == REVISION and request['expectedLatestVersionId'] == VERSION
                assert not state['assets'][0]['final_delivery_paid']
                no_overflow(page)
                context.close()

            def non_operator_is_denied():
                context, page, state = create_page(width=390, denied=True)
                expect(page.locator('#operator-portal')).to_contain_text('운영자 권한이 필요한 공간입니다.')
                assert page.locator('#operator-upload-form').count() == 0
                assert page.locator('#operator-tenant-form').count() == 0
                assert [item['action'] for item in state['requests']] == ['context']
                no_overflow(page)
                page.get_by_role('button', name='고객 작업으로 돌아가기', exact=True).click()
                expect(page.locator('#customer-portal')).to_be_visible()
                assert page.url.endswith('#account')
                context.close()

            case('operator-customer-assignment-upload-failure-retry-and-terms', create_assign_upload)
            case('operator-existing-revision-snapshot-and-mobile-layout', existing_revision_and_mobile)
            case('operator-denied-without-management-forms', non_operator_is_denied)
            assert not REPORT['page_errors'], REPORT['page_errors']
            assert not REPORT['unexpected_requests'], REPORT['unexpected_requests']
            REPORT['status'] = 'passed'
            print(json.dumps(REPORT, ensure_ascii=False, indent=2))
            browser.close(); browser = None
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill(); server.wait()
        log.close()
        (RESULTS / 'operator-browser-results.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
