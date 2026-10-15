#!/usr/bin/env python3
"""Browser contract checks and review screenshots. Requires Playwright Chromium.

Run from any directory: python portal/tests/browser.py
This script starts and stops its own local preview server. It never changes app data
outside each browser tab, and writes only portal/test-results/ artifacts.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "portal" / "test-results"
URL = "http://127.0.0.1:4173/"
REPORT = {
    "status": "running",
    "tests": [],
    "screenshots": [],
    "console_errors": [],
    "page_errors": [],
    "failed_http": [],
    "failed_requests": [],
    "aborted_requests": [],
}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def write_report():
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "browser-results.json").write_text(
        json.dumps(REPORT, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def wait_for_server(server):
    deadline = time.monotonic() + 15
    last_error = "no response"
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError(f"Preview server exited with {server.returncode}")
        try:
            with urllib.request.urlopen(URL, timeout=0.5) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError) as error:
            last_error = str(error)
        time.sleep(0.1)
    raise TimeoutError(f"Preview server was not ready within 15 seconds: {last_error}")


def attach_monitoring(page, label):
    page.on("console", lambda message: REPORT["console_errors"].append(
        {"page": label, "text": message.text}
    ) if message.type == "error" else None)
    page.on("pageerror", lambda error: REPORT["page_errors"].append(
        {"page": label, "text": str(error)}
    ))
    page.on("response", lambda response: REPORT["failed_http"].append(
        {"page": label, "status": response.status, "url": response.url}
    ) if response.status >= 400 else None)

    def request_failed(request):
        entry = {"page": label, "url": request.url, "failure": request.failure}
        # Navigating away or replacing a video deliberately aborts its pending read.
        target = "aborted_requests" if request.failure == "net::ERR_ABORTED" else "failed_requests"
        REPORT[target].append(entry)

    page.on("requestfailed", request_failed)


def ready(page):
    page.wait_for_function("document.fonts.status === 'loaded'")
    page.evaluate("""async () => {
      await document.fonts.ready;
      for (const image of document.images) {
        if (image.getClientRects().length) image.loading = 'eager';
      }
    }""")
    page.wait_for_function("""() => [...document.images]
      .filter(image => image.getClientRects().length)
      .every(image => image.complete && image.naturalWidth > 0)""")
    require(page.evaluate("document.fonts.check('400 14px Staycut')"), "Regular local font not loaded")
    require(page.evaluate("document.fonts.check('700 14px Staycut')"), "Bold local font not loaded")


def navigate(page, name):
    page.locator(f'#app-nav [data-nav="{name}"]').click()
    page.locator(f'section[data-page="{name}"]').wait_for(state="visible")
    require(page.locator(f'#app-nav [data-nav="{name}"]').get_attribute("aria-current") == "page",
            f"{name} navigation does not expose its current state")
    ready(page)


def screenshot(page, name, full_page=False):
    ready(page)
    path = RESULTS / name
    page.screenshot(path=str(path), full_page=full_page, animations="disabled")
    require(path.stat().st_size > 0, f"Empty screenshot: {name}")
    REPORT["screenshots"].append(str(path.relative_to(ROOT)))


def card(page, title):
    return page.locator('#library-results article.asset-card').filter(
        has=page.get_by_role("heading", name=title, exact=True)
    )


def library_count(page, expected):
    require(page.locator('#library-results article.asset-card').count() == expected,
            f"Expected {expected} available approved files")
    require(page.locator('.library-list-heading h2 .muted').inner_text().strip() == str(expected),
            "Available count and visible cards differ")


def assert_no_overflow(page, label):
    measurement = page.evaluate("""() => ({
      width: innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      offenders: [...document.querySelectorAll('body *')]
        .filter(element => element.getClientRects().length &&
          (element.getBoundingClientRect().right > innerWidth + 1 ||
           element.getBoundingClientRect().left < -1))
        .slice(0, 8).map(element => element.tagName + '.' + element.className)
    })""")
    require(measurement["document"] <= measurement["width"] + 1 and
            measurement["body"] <= measurement["width"] + 1,
            f"Horizontal overflow at {label}: {measurement}")


def main():
    RESULTS.mkdir(parents=True, exist_ok=True)
    server = None
    server_log = None
    browser = None
    current_page = None
    contexts = []
    try:
        from playwright.sync_api import sync_playwright, expect

        server_log = (RESULTS / "preview-server.log").open("w", encoding="utf-8")
        server = subprocess.Popen(
            ["node", "portal/dev-server.mjs", "--host", "127.0.0.1", "--port", "4173"],
            cwd=ROOT, stdout=server_log, stderr=subprocess.STDOUT,
        )
        wait_for_server(server)
        with sync_playwright() as playwright:
            launch = {"headless": True, "args": ["--no-sandbox"]}
            executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
            if executable:
                launch["executable_path"] = executable
            browser = playwright.chromium.launch(**launch)
            REPORT["browser_version"] = browser.version

            def new_page(label, width=1487, height=1058):
                nonlocal current_page
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1, locale="ko-KR", timezone_id="Asia/Seoul",
                    reduced_motion="reduce", accept_downloads=True,
                )
                contexts.append(context)
                page = context.new_page()
                current_page = page
                page.set_default_timeout(10000)
                attach_monitoring(page, label)
                page.goto(URL, wait_until="networkidle")
                expect(page.locator('#home-heading')).to_be_visible()
                ready(page)
                return page

            def case(name, callback):
                start = time.monotonic()
                result = {"name": name, "status": "running"}
                REPORT["tests"].append(result)
                try:
                    callback()
                    result["status"] = "passed"
                except Exception as error:
                    result.update(status="failed", error=str(error), traceback=traceback.format_exc())
                    if current_page is not None and not current_page.is_closed():
                        try:
                            failure = RESULTS / f"failure-{name}.png"
                            current_page.screenshot(path=str(failure), full_page=True, animations="disabled")
                            result["failure_screenshot"] = str(failure.relative_to(ROOT))
                        except Exception as capture_error:
                            result["screenshot_error"] = str(capture_error)
                finally:
                    result["duration_seconds"] = round(time.monotonic() - start, 3)
                    print(f"{result['status']}: {name}", flush=True)
                    write_report()

            def desktop_screenshots():
                page = new_page("desktop-screenshots")
                expect(page.locator('#home-project-status')).to_have_text('검토 대기 · v2')
                require(page.locator('#home-approved-list article').count() == 3, "Initial approved preview count")
                screenshot(page, "desktop-home.png")
                page.locator('#home-review-button').click()
                expect(page.locator('section[data-page="review"]')).to_be_visible()
                expect(page.locator('#approve-version')).to_be_disabled()
                screenshot(page, "desktop-review.png", full_page=True)
                navigate(page, 'content')
                library_count(page, 3)
                screenshot(page, "desktop-content.png", full_page=True)

            def media_and_revision():
                page = new_page("media-and-revision")
                navigate(page, 'review')
                video = page.locator('#review-content video')
                page.wait_for_function("""() => {
                  const video = document.querySelector('#review-content video');
                  return video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0;
                }""")
                require(video.evaluate('(video) => video.paused'), "Video autoplayed")
                require(video.get_attribute('controls') is not None, "Video lacks user playback controls")
                video.evaluate('async video => { video.muted = true; await video.play(); }')
                page.wait_for_function("document.querySelector('#review-content video').currentTime > 0.05")
                video.evaluate('video => video.pause()')
                require(video.evaluate('video => video.paused'), "Video did not pause")
                expect(page.locator('#approve-version')).to_be_disabled()
                page.locator('#review-confirm').check()
                expect(page.locator('#approve-version')).to_be_enabled()
                page.locator('[data-action="review-feedback"]').click()
                expect(page.locator('#feedback-error')).to_have_text('수정할 내용을 입력해 주세요. 전체 수정사항을 한 번에 보낼 수 있어요.')
                require(page.locator('[role="dialog"]').count() == 0, "Blank feedback opened confirmation")
                page.locator('#review-feedback').fill('12초의 객실명을 온유 1호로 바꿔 주세요.')
                expect(page.locator('#approve-version')).to_be_disabled()
                page.locator('[data-action="review-feedback"]').click()
                dialog = page.get_by_role('dialog', name='수정 요청을 확인해 주세요')
                expect(dialog).to_be_visible()
                expect(dialog.locator('.feedback-saved')).to_have_text('12초의 객실명을 온유 1호로 바꿔 주세요.')
                dialog.get_by_role('button', name='수정 요청 보내기', exact=True).click()
                expect(page.locator('#review-content .approval-panel h3')).to_have_text('v2 수정 요청을 전달했어요.')
                expect(page.locator('#review-content .approval-panel')).to_contain_text('이 버전은 승인되지 않았습니다.')
                require(page.locator('#approve-version').count() == 0, "Revision-requested version still has approval action")
                navigate(page, 'content')
                library_count(page, 3)

            def approve_download_publication_reuse():
                page = new_page("approval-download-publication-reuse")
                page.locator('#home-review-button').click()
                expect(page.locator('#approve-version')).to_be_disabled()
                page.locator('#review-confirm').check()
                expect(page.locator('#approve-version')).to_be_enabled()
                page.locator('#approve-version').click()
                expect(page.locator('#review-content .approval-panel h3')).to_have_text('v2 내용 승인을 남겼어요.')
                expect(page.locator('#review-content .approval-panel')).to_contain_text('온유스테이 운영자')
                page.get_by_role('button', name='게시용 보관함 보기', exact=False).click()
                library_count(page, 4)
                target = card(page, '10월 숙소 소개 영상')
                expect(target).to_contain_text('게시 여부 미확인')
                with page.expect_download() as event:
                    target.get_by_role('button', name='게시용 파일 다운로드', exact=False).click()
                download = event.value
                require(download.failure() is None, f"Download failed: {download.failure()}")
                saved = RESULTS / 'downloaded-sample.mp4'
                download.save_as(str(saved))
                require(saved.stat().st_size > 0, "Downloaded media is empty")
                REPORT['download'] = {'filename': download.suggested_filename, 'bytes': saved.stat().st_size}
                expect(target).to_contain_text('게시 여부 미확인')
                target.get_by_role('button', name='사용 조건·게시 기록', exact=True).click()
                dialog = page.get_by_role('dialog', name='사용 조건과 게시 기록')
                expect(dialog).to_contain_text('게시 여부 미확인')
                dialog.get_by_role('button', name='게시 여부 남기기', exact=True).click()
                page.locator('input[name="publication-status"][value="published"]').check()
                page.locator('#publish-date').fill('2026-10-16')
                page.get_by_role('button', name='게시 응답 기록하기', exact=True).click()
                expect(page.locator('#modal-error')).to_have_text('예시 기준일(2026-10-15)까지의 올바른 게시일을 입력해 주세요.')
                page.locator('#publish-date').fill('2026-10-15')
                page.locator('#publish-url').fill('javascript:alert(1)')
                page.get_by_role('button', name='게시 응답 기록하기', exact=True).click()
                expect(page.locator('#modal-error')).to_have_text('URL은 http:// 또는 https://로 시작해야 합니다. 입력하지 않아도 응답을 남길 수 있어요.')
                page.locator('#publish-url').fill('')
                page.get_by_role('button', name='게시 응답 기록하기', exact=True).click()
                expect(page.get_by_role('dialog')).to_have_count(0)
                expect(card(page, '10월 숙소 소개 영상')).to_contain_text('운영자가 게시했다고 확인')
                card(page, '10월 숙소 소개 영상').get_by_role('button', name='사용 조건·게시 기록', exact=True).click()
                dialog = page.get_by_role('dialog', name='사용 조건과 게시 기록')
                expect(dialog).to_contain_text('2026-10-15 · 운영자 자기신고')
                require('URL 입력됨' not in dialog.inner_text(), 'A URL was invented for an optional blank URL')
                dialog.get_by_role('button', name='이 원본으로 재편집 문의', exact=False).click()
                page.get_by_role('button', name='가능 여부 검토 요청', exact=True).click()
                expect(page.locator('#modal-error')).to_have_text('원하는 주제를 입력해 주세요.')
                page.locator('#reuse-topic').fill('테라스에서 즐기는 느린 아침')
                page.get_by_role('button', name='가능 여부 검토 요청', exact=True).click()
                expect(page.locator('#modal-error')).to_have_text('예시 기준일(2026-10-15) 이후의 희망 기한을 입력해 주세요.')
                page.locator('#reuse-date').fill('2026-10-22')
                page.get_by_role('button', name='가능 여부 검토 요청', exact=True).click()
                expect(page.get_by_role('dialog')).to_have_count(0)
                expect(page.locator('#toast')).to_have_text('데모: 재편집 가능 여부 검토 요청을 기록했어요. 제작이나 결제는 확정되지 않았습니다.')
                library_count(page, 4)
                navigate(page, 'review')
                page.locator('[data-action="select-review"][data-id="october-room"]').click()
                expect(page.locator('#review-content .status-pill')).to_have_text('검토 대기 · v2')
                expect(page.locator('#approve-version')).to_be_disabled()

            def search_modal_keyboard():
                page = new_page('search-modal-keyboard')
                navigate(page, 'content')
                page.locator('#library-search').evaluate("""input => {
                  window.__originalSearchInput = input;
                  input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
                  input.value = '아침';
                  input.dispatchEvent(new InputEvent('input', {bubbles: true, data: '아침', isComposing: true}));
                }""")
                require(page.evaluate("document.querySelector('#library-search') === window.__originalSearchInput"),
                        'Korean IME input element was replaced during composition')
                library_count(page, 3)
                page.locator('#library-search').evaluate("""input => {
                  input.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: '아침'}));
                }""")
                library_count(page, 1)
                expect(card(page, '아침이 다른 온유스테이')).to_be_visible()
                require(page.evaluate("document.querySelector('#library-search') === window.__originalSearchInput"),
                        'Korean IME input element was replaced at composition end')
                page.locator('#library-search').fill('')
                page.locator('#library-search').fill('존재하지않는제목')
                expect(page.locator('#library-results h3')).to_have_text('검색 결과가 없어요.')
                require(page.locator('#library-results article').count() == 0, 'Search did not filter files')
                page.get_by_role('button', name='검색어 지우기', exact=True).click()
                expect(page.locator('#library-search')).to_have_value('')
                library_count(page, 3)
                page.locator('#library-search').fill('테라스')
                library_count(page, 1)
                expect(card(page, '마음이 머무는 테라스')).to_be_visible()
                page.locator('#library-search').fill('')
                origin = card(page, '마음이 머무는 테라스').get_by_role('button', name='사용 조건·게시 기록', exact=True)
                origin.click()
                dialog = page.get_by_role('dialog', name='사용 조건과 게시 기록')
                expect(page.locator('#dialog-title')).to_be_focused()
                page.keyboard.press('Shift+Tab')
                expect(dialog.get_by_role('button', name='이 원본으로 재편집 문의', exact=False)).to_be_focused()
                page.keyboard.press('Tab')
                expect(dialog.get_by_role('button', name='닫기', exact=True)).to_be_focused()
                page.keyboard.press('Shift+Tab')
                expect(dialog.get_by_role('button', name='이 원본으로 재편집 문의', exact=False)).to_be_focused()
                require(page.locator('#main-content').get_attribute('inert') is not None, 'Background main is not inert')
                require(page.locator('#app-nav').get_attribute('inert') is not None, 'Background navigation is not inert')
                page.keyboard.press('Escape')
                expect(page.get_by_role('dialog')).to_have_count(0)
                expect(origin).to_be_focused()
                require(page.locator('#main-content').get_attribute('inert') is None, 'Closing modal leaves background inert')

            def responsive_screenshots_and_overflow():
                for width, height in [(390, 844), (768, 1024)]:
                    page = new_page(f'responsive-{width}', width, height)
                    for section in ['home', 'review', 'content']:
                        if section != 'home':
                            navigate(page, section)
                        ready(page)
                        assert_no_overflow(page, f'{section} at {width}px')
                        if width == 390 and section in ['home', 'review']:
                            screenshot(page, f'mobile-{section}.png', full_page=True)

            case('desktop-screenshots', desktop_screenshots)
            case('media-and-revision', media_and_revision)
            case('approval-download-publication-reuse', approve_download_publication_reuse)
            case('search-modal-keyboard', search_modal_keyboard)
            case('responsive-screenshots-and-overflow', responsive_screenshots_and_overflow)

            def no_runtime_errors():
                for key in ['console_errors', 'page_errors', 'failed_http', 'failed_requests']:
                    require(not REPORT[key], f'{key}: {json.dumps(REPORT[key], ensure_ascii=False)}')

            case('no-runtime-or-http-errors', no_runtime_errors)
            for context in contexts:
                context.close()
            browser.close()
            browser = None
    except Exception as error:
        REPORT['fatal_error'] = {'error': str(error), 'traceback': traceback.format_exc()}
        print(f'failed: browser setup: {error}', file=sys.stderr, flush=True)
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        if server is not None and server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
        if server_log is not None:
            server_log.close()
        failed = bool(REPORT.get('fatal_error')) or any(
            result['status'] != 'passed' for result in REPORT['tests']
        )
        REPORT['status'] = 'failed' if failed else 'passed'
        REPORT['summary'] = {
            'passed': sum(result['status'] == 'passed' for result in REPORT['tests']),
            'failed': sum(result['status'] == 'failed' for result in REPORT['tests']),
        }
        write_report()
    return 1 if REPORT['status'] == 'failed' else 0


if __name__ == '__main__':
    raise SystemExit(main())
