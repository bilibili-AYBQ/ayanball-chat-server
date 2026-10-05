import urllib.request, json
base = "http://localhost:3000"
def post(path, body, token=None):
    req = urllib.request.Request(base+path, data=json.dumps(body).encode(), headers={"Content-Type":"application/json"})
    if token: req.add_header("Authorization", "Bearer "+token)
    try:
        r = urllib.request.urlopen(req)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())

s, d = post("/api", {"action":"auth.register","payload":{"username":"testuser","password":"test123","nickname":"测试"}})
print("register", s, (d.get("user") or {}).get("username"), "token=", bool(d.get("token")))

s, d = post("/api", {"action":"auth.login","payload":{"username":"testuser","password":"test123"}})
print("login", s, "token=", bool(d.get("token")), "user=", (d.get("user") or {}).get("nickname"))
token = d.get("token")

# 上传测试文件
data = b"hello ayanball file 0123456789" * 100
req = urllib.request.Request(base+"/upload?name=test.bin&type=application/octet-stream", data=data, method="POST")
req.add_header("Authorization", "Bearer "+token)
up = None
try:
    r = urllib.request.urlopen(req)
    up = json.loads(r.read())
    print("upload", r.status, up.get("fileId"))
except urllib.error.HTTPError as e:
    print("upload", e.code, e.read().decode()[:200])

# 下载（/file 与 /.netlify/functions/file 两种路径）
if up:
    fid = up["fileId"]
    for path in ["/file", "/.netlify/functions/file"]:
        try:
            r = urllib.request.urlopen(base+path+"?id="+fid)
            b = r.read()
            print("download", path, r.status, "len=", len(b), "ok=", b == data)
        except urllib.error.HTTPError as e:
            print("download", path, e.code, e.read().decode()[:100])

# 静态页
r = urllib.request.urlopen(base+"/admin.html")
print("admin.html", r.status, r.getheader("content-type"), "len=", len(r.read()))
