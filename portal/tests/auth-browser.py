#!/usr/bin/env python3
"""Exercise real customer UI against explicit Auth/REST mocks, never the real project."""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'portal' / 'test-results'
URL = 'http://127.0.0.1:4174/'
ORIGIN = 'https://mock-customer.supabase.co'
USER = '11111111-1111-4111-8111-111111111111'
ASSET = '22222222-2222-4222-8222-222222222222'
VERSION = '33333333-3333-4333-8333-333333333333'
TENANT = '44444444-4444-4444-8444-444444444444'
TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjdXN0b21lciJ9.signature'
REPORT = {'status': 'running', 'tests': [], 'page_errors': [], 'unexpected_requests': [], 'source': 'Mock Supabase Auth/REST and local signed-media fixture; no real customer account or database mutation.'}


def main():
    from playwright.sync_api import sync_playwright, expect
    RESULTS.mkdir(parents=True, exist_ok=True)
    log = (RESULTS / 'auth-preview-server.log').open('w', encoding='utf-8')
    server = subprocess.Popen(['node', 'portal/dev-server.mjs', '--host', '127.0.0.1', '--port', '4174'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
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

            def create_page(mode='ready', width=390):
                context = browser.new_context(viewport={'width': width, 'height': 844}, locale='ko-KR', timezone_id='Asia/Seoul', reduced_motion='reduce')
                state = {'mode': mode, 'status': 'pending', 'revision': '', 'approval': False, 'reject_revision': False, 'calls': []}
                page = context.new_page()
                page.on('pageerror', lambda error: REPORT['page_errors'].append(str(error)))
                page.set_default_timeout(10000)

                def fulfill(route, status, data):
                    route.fulfill(status=status, content_type='application/json', body=json.dumps(data))

                page.route('**/api/config', lambda route: fulfill(route, 200, {'supabaseUrl': ORIGIN, 'publishableKey': 'sb_publishable_browser-mock'}))

                def api_media(route):
                    state['calls'].append({'url': route.request.url, 'body': route.request.post_data_json, 'authorization': route.request.headers.get('authorization')})
                    fulfill(route, 200, {'url': f'{ORIGIN}/storage/v1/object/sign/staycut-deliverables/{TENANT}/{ASSET}/{VERSION}/delivery.webm?token=temporary', 'expiresIn': 60})
                page.route('**/api/preview', api_media)
                page.route('**/api/download', api_media)

                def supabase(route):
                    request = route.request
                    state['calls'].append({'url': request.url, 'body': request.post_data_json if request.post_data else None, 'authorization': request.headers.get('authorization')})
                    path = request.url.split(ORIGIN)[1]
                    if path.startswith('/auth/v1/token?grant_type=password'):
                        if request.post_data_json['password'] == 'wrong':
                            fulfill(route, 400, {'error_code': 'invalid_credentials'})
                        else:
                            fulfill(route, 200, {'access_token': TOKEN, 'refresh_token': 'mock-refresh', 'expires_at': int(time.time()) + 3600, 'user': {'id': USER, 'email': 'customer@example.com'}})
                    elif path == '/auth/v1/user':
                        fulfill(route, 200, {'id': USER, 'email': 'customer@example.com'})
                    elif path.startswith('/auth/v1/logout'):
                        fulfill(route, 200, {})
                    elif path.startswith('/storage/v1/object/sign/'):
                        route.fulfill(status=200, content_type='video/webm', body=(ROOT / 'portal/assets/room-preview.webm').read_bytes())
                    elif path.startswith('/rest/v1/rpc/approve_asset_version'):
                        assert request.post_data_json['p_version_id'] == VERSION
                        assert request.post_data_json['p_confirmed'] is True
                        assert request.post_data_json['p_feedback'] == ''
                        state['status'] = 'approved'; state['approval'] = True
                        fulfill(route, 200, {'version_id': VERSION, 'approval_id': ASSET, 'approved_at': '2026-10-16T00:00:00Z'})
                    elif path.startswith('/rest/v1/rpc/request_asset_revision'):
                        if state['reject_revision']:
                            fulfill(route, 409, {'code': '55000'})
                        else:
                            state['status'] = 'revision_requested'; state['revision'] = request.post_data_json['p_message']
                            fulfill(route, 200, {'version_id': VERSION, 'request_id': ASSET, 'requested_at': '2026-10-16T00:00:00Z'})
                    elif path.startswith('/rest/v1/'):
                        if state['mode'] == 'missing':
                            fulfill(route, 404, {'code': 'PGRST205'}); return
                        if state['mode'] == 'empty':
                            fulfill(route, 200, []); return
                        table = path.split('/rest/v1/')[1].split('?')[0]
                        rows = {
                            'tenants': [{'id': TENANT, 'name': '실제 배정 숙소'}],
                            'assets': [{'id': ASSET, 'tenant_id': TENANT, 'title': '실제 고객 객실 영상', 'assigned_approver_id': USER, 'latest_version_id': VERSION, 'rights_status': 'valid', 'rights_start_date': '2020-01-01', 'rights_end_date': '2099-12-31', 'allowed_channels': ['instagram'], 'allowed_purposes': ['organic'], 'final_delivery_paid': True, 'access_end_date': '2099-12-31'}],
                            'asset_versions': [{'id': VERSION, 'asset_id': ASSET, 'tenant_id': TENANT, 'version_number': 2, 'review_status': state['status'], 'change_summary': '실제 고객이 요청한 문구를 반영했어요.', 'preview_available': True, 'delivery_available': True}],
                            'version_approvals': [{'version_id': VERSION, 'approved_at': '2026-10-16T00:00:00Z', 'channel': 'instagram', 'purpose': 'organic'}] if state['approval'] else [],
                            'revision_requests': [{'asset_id': ASSET, 'version_id': VERSION, 'message': state['revision'], 'requested_at': '2026-10-16T00:00:00Z', 'resolved_at': None}] if state['revision'] else [],
                        }
                        if table not in rows:
                            REPORT['unexpected_requests'].append(request.url)
                        fulfill(route, 200, rows.get(table, []))
                    else:
                        REPORT['unexpected_requests'].append(request.url); fulfill(route, 404, {})
                page.route(f'{ORIGIN}/**', supabase)
                page.goto(URL, wait_until='networkidle')
                return context, page, state

            def login(page, password='test-password'):
                page.locator('#account-entry').click()
                expect(page.locator('#customer-login-form button[type=submit]')).to_be_enabled()
                page.locator('#customer-email').fill('customer@example.com')
                page.locator('#customer-password').fill(password)
                page.locator('#customer-login-form button[type=submit]').click()

            def no_overflow(page):
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Horizontal overflow in customer mode'

            def case(name, callback):
                try:
                    callback(); REPORT['tests'].append({'name': name, 'status': 'passed'})
                except Exception as error:
                    REPORT['tests'].append({'name': name, 'status': 'failed', 'error': str(error)}); raise

            def approval_flow():
                context, page, state = create_page()
                login(page)
                expect(page.locator('#customer-portal h2', has_text='실제 고객 객실 영상')).to_be_visible()
                assert not page.locator('#customer-portal').inner_text().find('온유스테이') >= 0
                expect(page.locator('#app-nav')).to_be_hidden()
                expect(page.locator('#customer-approve')).to_be_disabled()
                page.locator('#customer-confirm').check()
                expect(page.locator('#customer-approve')).to_be_disabled()
                page.locator('[data-customer=preview]').click()
                page.wait_for_function("document.querySelector('#customer-player video')?.readyState >= 1")
                expect(page.locator('#customer-approve')).to_be_enabled()
                page.locator('#customer-feedback').fill('아직 보내지 않은 수정사항')
                expect(page.locator('#customer-approve')).to_be_disabled()
                assert not page.locator('#customer-confirm').is_checked()
                page.locator('#customer-feedback').fill('')
                page.locator('#customer-confirm').check()
                page.locator('#customer-approve').click()
                expect(page.locator('#customer-portal .customer-message')).to_contain_text('내용 승인을 서버에 저장')
                assert state['status'] == 'approved'
                assert state['calls'][-1]['authorization'] == f'Bearer {TOKEN}'
                no_overflow(page)
                page.screenshot(path=str(RESULTS / 'customer-mobile-approved.png'), full_page=True)
                page.reload(wait_until='networkidle')
                # The account hash restores this tab's session and verifies its actual user.
                expect(page.locator('#customer-portal')).to_contain_text('내용 승인 완료')
                assert any(call['url'] == f'{ORIGIN}/auth/v1/user' for call in state['calls'])
                page.locator('[data-customer=logout]').click()
                expect(page.locator('#customer-login-form')).to_be_visible()
                assert page.evaluate("sessionStorage.getItem('staycut.customer.session.v1')") is None
                context.close()

            def revision_flow():
                context, page, state = create_page(width=1487)
                login(page)
                expect(page.locator('#customer-feedback')).to_be_visible()
                page.locator('[data-customer=revise]').click()
                expect(page.locator('.customer-error')).to_contain_text('수정할 내용을 입력')
                assert not any('/rpc/' in call['url'] for call in state['calls'])
                page.locator('#customer-feedback').fill('객실명을 바꿔 주세요.')
                state['reject_revision'] = True
                page.locator('[data-customer=revise]').click()
                expect(page.locator('.customer-error')).to_contain_text('작업 상태 또는 사용 조건이 변경')
                expect(page.locator('#customer-feedback')).to_have_value('객실명을 바꿔 주세요.')
                assert state['status'] == 'pending'
                state['reject_revision'] = False
                page.locator('[data-customer=revise]').click()
                expect(page.locator('.customer-message')).to_contain_text('수정 요청을 서버에 저장')
                expect(page.locator('.feedback-saved')).to_contain_text('객실명을 바꿔 주세요.')
                assert state['status'] == 'revision_requested' and not state['approval']
                no_overflow(page)
                page.screenshot(path=str(RESULTS / 'customer-desktop-revision.png'), full_page=True)
                context.close()

            def empty_and_setup_states():
                for mode, expected in [('empty', '아직 배정된 작업이 없어요.'), ('missing', '데이터베이스 설정이 아직 완료되지 않았습니다.')]:
                    context, page, state = create_page(mode)
                    login(page)
                    expect(page.locator('#customer-portal')).to_contain_text(expected)
                    assert not any('/rpc/' in call['url'] for call in state['calls'])
                    no_overflow(page)
                    page.screenshot(path=str(RESULTS / f'customer-mobile-{mode}.png'), full_page=True)
                    page.locator('#account-entry').click()
                    expect(page.locator('#home-heading')).to_be_visible()
                    expect(page.locator('#app-nav')).to_be_visible()
                    context.close()

            def login_error():
                context, page, state = create_page()
                login(page, 'wrong')
                expect(page.locator('.customer-error')).to_contain_text('이메일과 비밀번호를 확인')
                expect(page.locator('#customer-password')).to_have_value('')
                assert not any('/rest/v1/' in call['url'] for call in state['calls'])
                no_overflow(page)
                context.close()

            case('customer-approval-preview-draft-guard-session-signout', approval_flow)
            case('customer-revision-validation-server-failure-and-save', revision_flow)
            case('customer-empty-membership-and-missing-schema-states', empty_and_setup_states)
            case('customer-invalid-login-does-not-read-data', login_error)
            assert not REPORT['page_errors'], REPORT['page_errors']
            assert not REPORT['unexpected_requests'], REPORT['unexpected_requests']
            REPORT['status'] = 'passed'
            print(json.dumps(REPORT, ensure_ascii=False, indent=2))
            browser.close()
            browser = None
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
        (RESULTS / 'auth-browser-results.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
