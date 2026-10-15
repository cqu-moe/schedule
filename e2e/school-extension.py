"""External school additions to the pinned Auth fixture, inside its real browser container.

The base provides CAS, second-factor mail and expiry controls. These endpoints
provide only school inputs; Schedule must produce subscriptions and calendars.
"""

base_api = api


async def curriculum(request):
    if request.cookies.get("MY_SESSION") != str(generation):
        return web.HTTPFound("https://sso.cqu.edu.cn/login?" + urlencode({
            "service": "https://my.cqu.edu.cn/authserver/authentication/cas"}))
    record("curriculum_page")
    return html('''<html><body>合成个人课表<script>
      localStorage.setItem('cqu_edu_ACCESS_TOKEN', JSON.stringify('synthetic-school-token'));
      fetch('/api/resourceapi/session/info-detail');
      fetch('/api/timetable/class/timetable/student/my-table-detail?sessionId=202610', {
        method:'POST', headers:{'content-type':'application/json'}, body:'{}'
      });
      </script></body></html>''')


async def schedule_api(request):
    if request.cookies.get("MY_SESSION") != str(generation):
        return web.json_response({"error": "SCHOOL_SESSION_EXPIRED"}, status=401)
    if request.path.endswith('/session/info-detail'):
        return web.json_response({"curSessionId": "202610", "sessionFinder": [
            {"id": "202610", "name": "2026-2027秋"}]})
    if request.path.endswith('/session/list'):
        return web.json_response({"sessionVOList": [{"id": "202610", "year": "2026-2027",
            "term": "秋", "beginDate": "2026-09-07", "endDate": "2027-01-17"}]})
    if request.path.endswith('/my-table-detail'):
        if request.method != 'POST' or request.query.get('sessionId') != '202610':
            raise web.HTTPBadRequest(text='Unexpected school timetable recipe')
        record('personal_timetable_requested')
        if state['mode'] == 'schedule_failure':
            return web.json_response({"error": "UPSTREAM_UNAVAILABLE"}, status=503)
        return web.json_response({"classTimetableVOList": [{
            "courseName": "合成电路基础", "instructorName": "合成教师-1", "roomName": "D1144",
            "position": "虎溪校区", "weekDay": 1, "teachingWeek": "11000000000000000000",
            "period": "11000000000000"}]})
    if request.path.endswith('/get-student-exam-list'):
        record('personal_exams_requested')
        return web.json_response({"status": "success", "data": {"content": [{
            "courseName": "合成电路考试", "examDate": "2026-12-21", "startTime": "09:00",
            "endTime": "11:00", "roomName": "D1201", "seatNum": 8}]}})
    return await base_api(request)


async def main():
    app = web.Application()
    app.add_routes([web.route('*', '/login', login), web.post('/sendMailCode', send_code),
        web.get('/tt/AllCourseSchedule', app_page), web.get('/workspace/curriculum', curriculum),
        web.get('/authserver/authentication/cas', cas), web.route('*', '/api/{tail:.*}', schedule_api)])
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain('/fixture/cert.pem', '/fixture/key.pem')
    await web.TCPSite(runner, '127.0.0.1', 443, ssl_context=tls).start()
    controls = web.Application()
    controls.add_routes([web.route('*', '/control', control), web.get('/mail', drain)])
    second = web.AppRunner(controls, access_log=None)
    await second.setup()
    await web.TCPSite(second, '0.0.0.0', 9090).start()
    try:
        await asyncio.Event().wait()
    finally:
        await second.cleanup()
        await runner.cleanup()


asyncio.run(main())
