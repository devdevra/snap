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
CUSTOMER_TWO = '99999999-9999-4999-8999-999999999999'
TENANT = '22222222-2222-4222-8222-222222222222'
ASSET = '33333333-3333-4333-8333-333333333333'
VERSION = '44444444-4444-4444-8444-444444444444'
REVISION = '66666666-6666-4666-8666-666666666666'
REVISION_TWO = '66666666-6666-4666-8666-666666666667'
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

            def create_page(width=1487, denied=False, fail_preview=False, existing=False, legacy=False):
                context = browser.new_context(viewport={'width': width, 'height': 1058 if width > 600 else 844}, locale='ko-KR', timezone_id='Asia/Seoul', reduced_motion='reduce')
                state = {'tenants': [], 'members': [], 'assets': [], 'requests': [], 'reservations': {}, 'uploads': {}, 'counter': 0, 'fail_preview': fail_preview, 'commits': 0, 'conflict_member': False, 'conflict_assign': False, 'change_revision_on_context': False}
                terms = {'access_allowed': True, 'access_start_date': '2026-01-01', 'access_end_date': '2099-12-31', 'rights_status': 'pending', 'rights_start_date': '2026-01-01', 'rights_end_date': '2099-12-31', 'allowed_channels': ['instagram'], 'allowed_purposes': ['organic'], 'final_delivery_paid': False}
                tenant = {'id': TENANT, 'name': '검증 숙소'}
                member = {'tenant_id': TENANT, 'user_id': CUSTOMER, 'email': 'verified-customer@example.com', 'role': 'owner', 'active': True, 'access_allowed': True, 'access_start_date': '2026-01-01', 'access_end_date': '2099-12-31', **({} if legacy else {'revision': 1})}
                if existing:
                    state['tenants'] = [tenant]; state['members'] = [member]
                    state['assets'] = [{'id': ASSET, 'tenant_id': TENANT, 'title': '기존 전달 작업', 'assigned_approver_id': CUSTOMER, 'latest_version_id': VERSION, 'latest_version': {'id': VERSION, 'version_number': 2, 'review_status': 'revision_requested'}, 'open_revision': {'id': REVISION, 'message': '마지막 객실명을 수정해 주세요.', 'version_id': VERSION}, **terms}]
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
                    assert not any(key in body for key in ['actorId', 'operatorId', 'secretKey'])
                    if body['action'] != 'updateMember':
                        assert 'userId' not in body
                    action = body['action']
                    if denied:
                        fulfill(route, 403, {'code': 'OPERATOR_REQUIRED', 'error': '운영자 권한이 필요합니다.'}); return
                    if action == 'context':
                        if state['change_revision_on_context']:
                            state['change_revision_on_context'] = False
                            state['assets'][0]['open_revision'] = {'id': REVISION_TWO, 'message': '새로 도착한 간판 수정 요청입니다.', 'version_id': VERSION}
                        fulfill(route, 200, {'operator': {'user_id': OPERATOR}, 'tenants': state['tenants'], 'members': state['members'], 'assets': state['assets']})
                    elif action == 'createTenant':
                        assert body['customerEmail'] == 'verified-customer@example.com'
                        assert body['accessStartDate'] and body['accessEndDate']
                        state['tenants'] = [{'id': TENANT, 'name': body['name']}]; state['members'] = [member]
                        fulfill(route, 200, {'tenantId': TENANT, 'customerId': CUSTOMER})
                    elif action == 'addMember':
                        assert body['tenantId'] == TENANT and body['customerEmail'] == 'second-customer@example.com'
                        assert type(body['accessAllowed']) is bool
                        assert not any(key in body for key in ['active', 'role', 'operator'])
                        state['members'].append({'tenant_id': TENANT, 'user_id': CUSTOMER_TWO, 'email': body['customerEmail'], 'role': 'member', 'active': True, 'access_allowed': body['accessAllowed'], 'access_start_date': body['accessStartDate'], 'access_end_date': body['accessEndDate'], 'revision': 1})
                        fulfill(route, 200, {'tenantId': TENANT, 'userId': CUSTOMER_TWO, 'revision': 1})
                    elif action == 'updateMember':
                        target = next(item for item in state['members'] if item['user_id'] == body['userId'])
                        if state['conflict_member']:
                            state['conflict_member'] = False; target['revision'] += 1; target['access_end_date'] = '2098-12-31'
                        if body['expectedRevision'] != target['revision']:
                            fulfill(route, 409, {'code': 'STATE_CONFLICT', 'error': '고객 배정이 변경되었습니다. 최신 상태를 확인해 주세요.'}); return
                        assert body['tenantId'] == TENANT and type(body['active']) is bool and type(body['accessAllowed']) is bool
                        target.update({'active': body['active'], 'access_allowed': body['accessAllowed'], 'access_start_date': body['accessStartDate'], 'access_end_date': body['accessEndDate'], 'revision': target['revision'] + 1})
                        fulfill(route, 200, {'tenantId': TENANT, 'userId': body['userId'], 'revision': target['revision']})
                    elif action == 'assignApprover':
                        target = next(item for item in state['assets'] if item['id'] == body['assetId'])
                        if state['conflict_assign']:
                            state['conflict_assign'] = False; target['latest_version_id'] = '44444444-4444-4444-8444-444444444445'; target['latest_version'] = {'id': target['latest_version_id'], 'version_number': 3, 'review_status': 'pending'}
                        if body['expectedAssignedApproverId'] != target['assigned_approver_id'] or body['expectedLatestVersionId'] != target['latest_version_id']:
                            fulfill(route, 409, {'code': 'STATE_CONFLICT', 'error': '작업 상태가 변경되었습니다. 최신 상태를 확인해 주세요.'}); return
                        candidate = next(item for item in state['members'] if item['user_id'] == body['assignedApproverId'])
                        assert candidate['active'] and candidate['access_allowed']
                        target['assigned_approver_id'] = body['assignedApproverId']
                        fulfill(route, 200, {'assetId': target['id'], 'assignedApproverId': target['assigned_approver_id'], 'latestVersionId': target['latest_version_id']})
                    elif action == 'prepareUpload':
                        assert body['delivery']['sha256'] != body['preview']['sha256']
                        assert body['delivery']['mimeType'] == 'video/webm' and body['preview']['mimeType'] == 'video/webm'
                        if body['assetId']:
                            assert not any(key in body for key in ['title', 'assignedApproverId', 'terms'])
                            target = next(item for item in state['assets'] if item['id'] == body['assetId'])
                            if body['expectedRevisionId'] != (target['open_revision']['id'] if target.get('open_revision') else None) or body['expectedLatestVersionId'] != target['latest_version_id']:
                                fulfill(route, 409, {'code': 'UPLOAD_CONFLICT', 'error': '작업의 최신 상태가 변경되었습니다.'}); return
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
                            state['assets'] = [{'id': ASSET, 'tenant_id': TENANT, 'title': prepared['title'], 'assigned_approver_id': CUSTOMER, 'latest_version_id': reservation['response']['versionId'], 'latest_version': {'id': reservation['response']['versionId'], 'version_number': 1, 'review_status': 'pending'}, 'open_revision': None, **new_terms}]
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

            def open_tab(page, label):
                page.get_by_role('tab', name=label, exact=True).click()

            def next_step(page):
                page.locator('[data-operator=upload-next]').click()

            def add_customer(page):
                open_tab(page, '고객 관리')
                page.locator('#operator-member-email').fill('second-customer@example.com')
                page.locator('#operator-add-member-start').fill('2026-01-01')
                page.locator('#operator-add-member-end').fill('2099-12-31')
                page.locator('#operator-member-add-form [name=accessAllowed]').check()
                page.locator('#operator-member-add-form button[type=submit]').click()
                expect(page.locator('.operator-message')).to_contain_text('이 숙소에 배정했습니다.')

            def member_form(page, user_id=CUSTOMER):
                row = page.locator(f'.operator-member[data-member-id="{user_id}"]')
                if not row.evaluate('element => element.open'):
                    row.locator('summary').click()
                return row.locator('form')

            def compare_conflict(form):
                form.locator('[data-operator=review-conflict]').click()
                expect(form.locator('.operator-conflict')).to_contain_text('서버의 최신 상태')
                form.locator('[name=conflictReviewed]').check()
                form.locator('[data-operator=apply-conflict]').click()

            def create_assign_upload():
                context, page, state = create_page(fail_preview=True)
                expect(page.locator('#operator-tenant-form')).to_be_visible()
                page.locator('#operator-tenant-name').fill('검증 숙소')
                page.locator('#operator-customer-email').fill('verified-customer@example.com')
                page.locator('#operator-member-start').fill('2026-01-01')
                page.locator('#operator-member-end').fill('2099-12-31')
                page.locator('#operator-tenant-form button[type=submit]').click()
                expect(page.locator('#operator-panel-overview')).to_be_visible()
                open_tab(page, '영상 전달')
                expect(page.locator('#operator-upload-form')).to_be_visible()
                # A future step cannot bypass visible required job details.
                next_step(page)
                expect(page.locator('[data-upload-stage="0"]')).to_be_visible()
                page.locator('#operator-title').fill('가을 객실 소개 영상')
                page.locator('#operator-approver').select_option(CUSTOMER)
                next_step(page)
                expect(page.locator('[data-upload-stage="1"]')).to_be_visible()
                fill_files(page)
                # Switching tabs and going backward must preserve raw File inputs.
                open_tab(page, '고객 관리')
                open_tab(page, '영상 전달')
                assert page.locator('#operator-delivery').evaluate('input => input.files.length') == 1
                page.locator('[data-operator=upload-back]').click()
                expect(page.locator('#operator-title')).to_have_value('가을 객실 소개 영상')
                next_step(page)
                next_step(page)
                page.locator('#operator-new-access-end').fill('2099-12-31')
                page.locator('#operator-new-rights-end').fill('2099-12-31')
                page.locator('#operator-upload-form [name=accessAllowed]').check()
                assert not page.locator('#operator-upload-form [name=finalDeliveryPaid]').is_checked()
                assert page.locator('#operator-new-rights-status').input_value() == 'pending'
                page.locator('#operator-upload-submit').click()
                expect(page.locator('.operator-error')).to_contain_text('파일 업로드를 완료하지 못했습니다.')
                expect(page.locator('#operator-title')).to_have_value('가을 객실 소개 영상')
                assert page.locator('#operator-delivery').evaluate('input => input.files.length') == 1
                assert page.locator('#operator-preview').evaluate('input => input.files.length') == 1
                assert state['commits'] == 0 and not state['assets']
                page.locator('#operator-upload-submit').click()
                expect(page.locator('.operator-message')).to_contain_text('새 버전을 등록했습니다.')
                assert state['counter'] == 2 and state['commits'] == 1
                assert not state['assets'][0]['final_delivery_paid'] and state['assets'][0]['rights_status'] == 'pending'
                no_overflow(page)
                page.screenshot(path=str(RESULTS / 'operator-desktop-delivery.png'), full_page=True)
                # Contract state is a separate explicit save.
                open_tab(page, '작업 조건')
                expect(page.locator('#operator-terms-form')).to_be_visible()
                page.locator('#operator-edit-rights-status').select_option('valid')
                page.locator('#operator-terms-form [name=rightsConfirmed]').check()
                page.locator('#operator-terms-form [name=finalDeliveryPaid]').check()
                page.locator('#operator-terms-form button[type=submit]').click()
                expect(page.locator('.operator-message')).to_contain_text('수납 조건을 저장했습니다.')
                assert state['assets'][0]['final_delivery_paid'] and state['assets'][0]['rights_status'] == 'valid'
                no_overflow(page)
                context.close()

            def existing_revision_and_mobile():
                context, page, state = create_page(width=390, existing=True)
                page.get_by_role('button', name='수정본 전달', exact=True).click()
                expect(page.locator('#operator-target')).to_have_value(ASSET)
                expect(page.locator('#operator-existing-job')).to_contain_text('마지막 객실명을 수정해 주세요.')
                expect(page.locator('#operator-new-job')).to_be_hidden()
                page.locator('[name=revisionReviewed]').check()
                page.locator('#operator-change-summary').fill('요청한 마지막 객실명을 반영했습니다.')
                no_overflow(page)
                page.screenshot(path=str(RESULTS / 'operator-mobile-revision-review.png'), full_page=True)
                next_step(page)
                fill_files(page)
                next_step(page)
                assert page.locator('#operator-title').is_disabled()
                assert page.locator('#operator-new-access-end').is_disabled()
                page.locator('#operator-upload-submit').click()
                expect(page.locator('.operator-message')).to_contain_text('새 버전을 등록했습니다.')
                assert state['commits'] == 1 and state['assets'][0]['open_revision'] is None
                request = next(item for item in state['requests'] if item['action'] == 'prepareUpload')
                assert request['expectedRevisionId'] == REVISION and request['expectedLatestVersionId'] == VERSION
                assert not state['assets'][0]['final_delivery_paid']
                no_overflow(page)
                context.close()

            def customer_membership_assignment_and_revoke():
                context, page, state = create_page(width=390, existing=True)
                add_customer(page)
                assert len(state['members']) == 2 and state['members'][1]['active'] and state['members'][1]['access_allowed']
                form = member_form(page, CUSTOMER_TWO)
                form.locator('[name=accessEndDate]').fill('2097-12-31')
                form.locator('button[type=submit]').click()
                expect(page.locator('.operator-message')).to_contain_text('접근 기간을 저장했습니다.')
                assert state['members'][1]['revision'] == 2 and state['members'][1]['access_end_date'] == '2097-12-31'
                open_tab(page, '작업 조건')
                page.locator('#operator-new-approver').select_option(CUSTOMER_TWO)
                page.locator('#operator-approver-form button[type=submit]').click()
                expect(page.locator('.operator-message')).to_contain_text('지정 승인자를 변경했습니다.')
                assert state['assets'][0]['assigned_approver_id'] == CUSTOMER_TWO
                open_tab(page, '고객 관리')
                form = member_form(page)
                count_before = len([item for item in state['requests'] if item['action'] == 'updateMember'])
                form.locator('[data-operator=confirm-revoke]').click()
                form.locator('[data-operator=cancel-revoke]').click()
                assert len([item for item in state['requests'] if item['action'] == 'updateMember']) == count_before
                form.locator('[data-operator=confirm-revoke]').click()
                form.locator('[data-operator=revoke-member]').click()
                expect(page.locator('.operator-error')).to_contain_text('접근 회수 확인 항목')
                assert state['members'][0]['active']
                form.locator('[name=revokeConfirmed]').check()
                form.locator('[data-operator=revoke-member]').click()
                expect(page.locator('.operator-message')).to_contain_text('고객 배정과 접근을 회수했습니다.')
                assert not state['members'][0]['active'] and not state['members'][0]['access_allowed']
                assert state['assets'][0]['assigned_approver_id'] == CUSTOMER_TWO
                no_overflow(page)
                page.screenshot(path=str(RESULTS / 'operator-mobile-members.png'), full_page=True)
                context.close()

            def member_stale_edit_and_revoke_intent():
                context, page, state = create_page(existing=True)
                open_tab(page, '고객 관리')
                form = member_form(page)
                form.locator('[name=accessEndDate]').fill('2097-12-31')
                state['conflict_member'] = True
                form.locator('button[type=submit]').click()
                expect(page.locator('.operator-error')).to_contain_text('고객 배정이 변경되었습니다.')
                expect(form.locator('[name=accessEndDate]')).to_have_value('2097-12-31')
                form.locator('[data-operator=review-conflict]').click()
                expect(form.locator('.operator-conflict')).to_contain_text('2098-12-31')
                form.locator('[data-operator=apply-conflict]').click()
                expect(page.locator('.operator-error')).to_contain_text('최신 상태를 비교한 뒤')
                assert len([item for item in state['requests'] if item['action'] == 'updateMember']) == 1
                form.locator('[name=conflictReviewed]').check()
                form.locator('[data-operator=apply-conflict]').click()
                expect(page.locator('.operator-message')).to_contain_text('접근 기간을 저장했습니다.')
                assert state['members'][0]['revision'] == 3 and state['members'][0]['access_end_date'] == '2097-12-31'
                form = member_form(page)
                state['conflict_member'] = True
                form.locator('[data-operator=confirm-revoke]').click()
                form.locator('[name=revokeConfirmed]').check()
                form.locator('[data-operator=revoke-member]').click()
                expect(form.locator('.operator-conflict')).to_be_visible()
                assert not form.locator('[name=active]').is_checked() and not form.locator('[name=accessAllowed]').is_checked()
                compare_conflict(form)
                expect(page.locator('.operator-message')).to_contain_text('고객 배정과 접근을 회수했습니다.')
                updates = [item for item in state['requests'] if item['action'] == 'updateMember']
                assert updates[-1]['active'] is False and updates[-1]['accessAllowed'] is False
                assert not state['members'][0]['active'] and not state['members'][0]['access_allowed']
                no_overflow(page)
                page.screenshot(path=str(RESULTS / 'operator-desktop-members.png'), full_page=True)
                context.close()

            def background_context_never_acknowledges_unseen_revision():
                context, page, state = create_page(existing=True)
                page.get_by_role('button', name='수정본 전달', exact=True).click()
                page.locator('[name=revisionReviewed]').check()
                next_step(page); fill_files(page); next_step(page)
                open_tab(page, '고객 관리')
                form = member_form(page)
                state['conflict_member'] = True
                form.locator('button[type=submit]').click()
                expect(form.locator('.operator-conflict')).to_be_visible()
                state['change_revision_on_context'] = True
                form.locator('[data-operator=review-conflict]').click()
                expect(form.locator('.operator-conflict')).to_contain_text('서버의 최신 상태')
                assert state['assets'][0]['open_revision']['id'] == REVISION_TWO
                open_tab(page, '영상 전달')
                expect(page.locator('#operator-existing-job')).to_contain_text('마지막 객실명을 수정해 주세요.')
                page.locator('#operator-upload-submit').click()
                expect(page.locator('#operator-upload-stale')).to_be_visible()
                expect(page.locator('#operator-upload-submit')).to_be_disabled()
                request = next(item for item in state['requests'] if item['action'] == 'prepareUpload')
                assert request['expectedRevisionId'] == REVISION, 'Must submit the revision actually displayed, never unseen fresh context'
                assert state['commits'] == 0 and state['assets'][0]['open_revision']['id'] == REVISION_TWO
                assert page.locator('#operator-delivery').evaluate('input => input.files.length') == 1
                page.locator('[data-operator=reload-upload]').click()
                expect(page.locator('#operator-existing-job')).to_contain_text('새로 도착한 간판 수정 요청입니다.')
                assert not page.locator('[name=revisionReviewed]').is_checked()
                assert page.locator('#operator-title').is_disabled() and page.locator('#operator-new-access-end').is_disabled()
                assert page.locator('#operator-delivery').evaluate('input => input.files.length') == 1
                page.locator('[name=revisionReviewed]').check()
                next_step(page); next_step(page)
                page.locator('#operator-upload-submit').click()
                expect(page.locator('.operator-message')).to_contain_text('새 버전을 등록했습니다.')
                assert state['commits'] == 1
                requests = [item for item in state['requests'] if item['action'] == 'prepareUpload']
                assert requests[-1]['expectedRevisionId'] == REVISION_TWO
                context.close()

            def approver_stale_snapshot_and_explicit_comparison():
                context, page, state = create_page(existing=True)
                add_customer(page)
                open_tab(page, '작업 조건')
                form = page.locator('#operator-approver-form')
                form.locator('[name=assignedApproverId]').select_option(CUSTOMER_TWO)
                state['conflict_assign'] = True
                form.locator('button[type=submit]').click()
                expect(form.locator('.operator-conflict')).to_be_visible()
                expect(form.locator('[name=assignedApproverId]')).to_have_value(CUSTOMER_TWO)
                assert state['assets'][0]['assigned_approver_id'] == CUSTOMER
                compare_conflict(form)
                expect(page.locator('.operator-message')).to_contain_text('지정 승인자를 변경했습니다.')
                requests = [item for item in state['requests'] if item['action'] == 'assignApprover']
                assert requests[0]['expectedLatestVersionId'] == VERSION
                assert requests[1]['expectedLatestVersionId'] == '44444444-4444-4444-8444-444444444445'
                assert state['assets'][0]['assigned_approver_id'] == CUSTOMER_TWO
                context.close()

            def legacy_schema_keeps_old_features_and_management_disabled():
                context, page, state = create_page(existing=True, legacy=True)
                open_tab(page, '고객 관리')
                expect(page.locator('#operator-member-add-form button[type=submit]')).to_be_disabled()
                expect(page.locator('#operator-panel-members')).to_contain_text('추가 데이터베이스 구성이 필요합니다.')
                open_tab(page, '작업 조건')
                expect(page.locator('#operator-approver-form button[type=submit]')).to_be_disabled()
                page.locator('#operator-terms-form button[type=submit]').click()
                expect(page.locator('.operator-message')).to_contain_text('수납 조건을 저장했습니다.')
                # A success-render followed by setBusy(false) must not enable new-schema controls.
                expect(page.locator('#operator-approver-form button[type=submit]')).to_be_disabled()
                open_tab(page, '고객 관리')
                expect(page.locator('#operator-member-add-form button[type=submit]')).to_be_disabled()
                context.close()

            def dashboard_search_filter_and_keyboard_tabs():
                context, page, state = create_page(existing=True)
                template = state['assets'][0]
                state['assets'].append({**template, 'id': '33333333-3333-4333-8333-333333333334', 'title': '봄 정원 소개', 'open_revision': None, 'latest_version': {'id': VERSION, 'version_number': 1, 'review_status': 'pending'}})
                state['assets'].append({**template, 'id': '33333333-3333-4333-8333-333333333335', 'title': '여름 객실 투어', 'open_revision': None, 'final_delivery_paid': True, 'rights_status': 'valid', 'latest_version': {'id': VERSION, 'version_number': 1, 'review_status': 'approved'}})
                page.locator('[data-operator=refresh]').click()
                expect(page.locator('.operator-job-card')).to_have_count(3)
                page.locator('.operator-stat[data-filter=revision]').click()
                expect(page.locator('.operator-job-card')).to_have_count(1)
                expect(page.locator('.operator-job-card')).to_contain_text('기존 전달 작업')
                page.locator('#operator-filter').select_option('all')
                page.locator('#operator-search').fill('정원')
                expect(page.locator('.operator-job-card')).to_have_count(1)
                expect(page.locator('.operator-job-card')).to_contain_text('봄 정원 소개')
                page.locator('#operator-search').fill('없는 작업')
                expect(page.locator('#operator-job-list')).to_contain_text('조건에 맞는 작업이 없습니다.')
                page.locator('#operator-search').fill('')
                page.get_by_role('tab', name='작업 현황', exact=True).focus()
                page.keyboard.press('ArrowRight')
                expect(page.locator('#operator-panel-delivery')).to_be_visible()
                page.keyboard.press('End')
                expect(page.locator('#operator-panel-terms')).to_be_visible()
                open_tab(page, '작업 현황')
                no_overflow(page)
                page.screenshot(path=str(RESULTS / 'operator-desktop-overview.png'), full_page=True)
                page.set_viewport_size({'width': 390, 'height': 844})
                no_overflow(page)
                page.screenshot(path=str(RESULTS / 'operator-mobile-overview.png'), full_page=True)
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
            case('operator-members-add-period-assign-and-explicit-revoke', customer_membership_assignment_and_revoke)
            case('operator-member-stale-draft-comparison-and-revoke-intent', member_stale_edit_and_revoke_intent)
            case('operator-background-context-preserves-displayed-upload-snapshot', background_context_never_acknowledges_unseen_revision)
            case('operator-approver-stale-snapshot-explicit-comparison', approver_stale_snapshot_and_explicit_comparison)
            case('operator-legacy-schema-keeps-new-management-disabled', legacy_schema_keeps_old_features_and_management_disabled)
            case('operator-dashboard-search-filter-and-keyboard-tabs', dashboard_search_filter_and_keyboard_tabs)
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
