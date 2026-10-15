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
        return web.json_response({"curSessionId": state["session"], "sessionFinder": [
            {"id": state["session"], "name": "2026-2027秋"}]})
    if request.path.endswith('/session/list'):
        return web.json_response({"sessionVOList": [{"id": state["session"], "year": "2026-2027",
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
    result = await external_api(request)
    return result if result is not None else await base_api(request)


async def external_page(request):
    if request.cookies.get("MY_SESSION") != str(generation):
        return web.HTTPFound("https://sso.cqu.edu.cn/login?" + urlencode({
            "service": "https://my.cqu.edu.cn/authserver/authentication/cas"}))
    record("external_page")
    if state["mode"] == "external_page_forbidden":
        return web.Response(status=403, text="No permission")
    return html(EXTERNAL_PAGE.replace('__PAGE_SESSION__', state['pageSession']))


async def external_api(request):
    path = request.path
    catalogs = {
        '/api/resourceapi/department/list': ('department', [{"id":"11","name":"合成学院"}]),
        '/api/resourceapi/room/roomName-filter': ('room', [{"id":"41","name":"合成教室"}]),
        '/api/timetable/course/LaboratoryId-filter': ('laboratory', [{"id":"42","roomName":"合成实验室"}]),
        '/api/timetable/instructor/filter': ('instructor', [{"id":"51","name":"合成教师","code":"T01","departmentName":"合成学院"}]),
        '/api/timetable/admin-class/dept-admin-classes': ('admin_class', [{"id":"21","className":"合成行政班","departmentName":"合成学院","grade":2026}]),
        '/api/timetable/course/info-by-name-or-code': ('course_catalog', [{"id":"31","name":"合成电路","codeR":"SYN101"}]),
        '/api/timetable/course/search-class-by-courseId': ('teaching_class', [{"id":"61","name":"合成电路01班","classNbr":"01","teacherName":"合成教师"}]),
        '/api/timetable/optionFinder/expr-prj': ('experiment_projects', []),
    }
    if path in catalogs:
        kind, rows = catalogs[path]
        record('catalog_' + kind)
        if state['mode'] in {'course_cache', 'course_cache_other'}:
            if kind == 'course_catalog':
                rows = [*rows, {"id":"32","name":"合成力学","codeR":"SYN102"}]
            if kind == 'teaching_class':
                second = request.query.get('courseId') == '32'
                suffix = '另一用户' if state['mode'] == 'course_cache_other' else ('新学期' if state['session'] == '202611' else '')
                rows = [{"id":"62" if second else "61", "name":('合成力学01班' if second else '合成电路01班')+suffix, "classNbr":"01", "teacherName":"合成教师"}]
        while state['hold']:
            await asyncio.sleep(.05)
        if state['mode'] == 'external_forbidden':
            return web.json_response({"error":"PERMISSION_DENIED"}, status=403)
        if state['mode'] == 'external_unavailable':
            return web.json_response({"error":"UNAVAILABLE"}, status=503)
        if state['mode'] == 'external_schema_error':
            rows = [{"invalid":"not a school candidate"}]
        if state['mode'] == 'external_empty':
            rows = []
        if state['mode'] == 'external_v2':
            rows = [{**row, **{key: row[key]+'新版' for key in ['name','className','roomName'] if key in row}} for row in rows]
        if kind == 'course_catalog':
            return web.json_response({"status":"success","ok":True,"data":rows})
        return web.json_response(rows)
    if '/class/timetable/' in path and path.endswith('/table-detail'):
        kind = path.split('/class/timetable/')[1].split('/')[0]
        if kind not in {'room','instructor','adminClass','course','expr-prj'}:
            return None
        if request.method != 'POST' or request.query.get('sessionId') != state['session']:
            raise web.HTTPBadRequest(text='Unexpected external timetable recipe')
        ids = await request.json()
        if not isinstance(ids, list):
            raise web.HTTPBadRequest(text='Expected target identifiers')
        record('external_table_' + kind)
        if state['mode'] == 'schedule_failure':
            return web.json_response({"error":"UPSTREAM_UNAVAILABLE"}, status=503)
        rows = []
        for target in ids:
            row = {"courseName":"外部电路基础","instructorName":"合成教师-1",
                "roomName":"合成实验室" if target=='42' else "合成教室", "position":"虎溪校区",
                "weekDay":1,"teachingWeek":"11000000000000000000","period":"11000000000000"}
            if kind == 'room': row['roomId'] = target
            elif kind == 'instructor': row['instructorIdList'] = [target]
            elif kind == 'adminClass': row['assignTeachingObject'] = [{"adminClassId":target}]
            elif kind == 'course': row['classId'] = target
            else: continue
            rows.append(row)
            if kind == 'adminClass':
                rows.append({**row, 'courseName':'外部高等数学', 'weekDay':2, 'period':'00110000000000'})
        return web.json_response({"classTimetableVOList": rows, "maxSection": 14,
            **({"roomExamTimeTableVOList":[],"tempActivityTimetableVOList":[]} if kind=='room' else {})})
    return None


async def main():
    app = web.Application()
    app.add_routes([web.route('*', '/login', login), web.post('/sendMailCode', send_code),
        web.get('/tt/AllCourseSchedule', external_page), web.get('/workspace/curriculum', curriculum),
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
