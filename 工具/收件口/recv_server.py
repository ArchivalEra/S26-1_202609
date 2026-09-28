#!/usr/bin/env python3
"""收件口：只接受上传（PUT/POST），不提供任何读取。用来把手机上的文件传进本机。

用法
    python3 工具/收件口/recv_server.py <token> [port] [dest]
    # 例：python3 工具/收件口/recv_server.py h9k2 8801
    # 不收 dest 时默认落到 <仓库>/工具/收件/（该目录内容默认不入库，见 README）

    另开一个终端把本地端口暴露到公网（本机解析不了外网域名，必须走 2080 的 HTTP 代理）：
    ssh -p 443 -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
        -o ProxyCommand='socat - PROXY:127.0.0.1:%h:%p,proxyport=2080' \
        -R 80:localhost:8801 serveo.net
    输出里的 https://<随机串>.serveousercontent.com 就是手机要打开的域名；
    手机打开 <该域名>/u/<token>/ 上传（页面自动切 2 MB 分片，照片/压缩包都能传）。

分片协议（应对隧道对大请求体的截断）
    PUT /u/<token>/part/<序号>/<文件名>   一次一片，建议 ≤2 MB
    PUT /u/<token>/done/<文件名>/<片数>   片到齐后拼装并落到 <dest>/<文件名>
    PUT /u/<token>/                       小文件单片直传，文件名放 X-Filename 头或 URL 末段

踩过的坑（别再踩）
- **别把收件目录或日志放 /tmp**：本机 /tmp 是 tmpfs，会话重启即空（脚本、日志、收到的文件一起没）。
- **「在不在跑」看端口**：`ss -tln | grep :8801`。不要 `pgrep -f recv_server.py`——`-f` 匹配整条命令行，
  会把你正在跑的那条命令自己匹配上，给出「已在跑」的假象（实测踩过一次）。
- 收件口**只写不读**，token 是唯一门槛；用完就停（杀进程），别长期开着。
- 收到的文件**按材料类型归位**：课堂材料进 `课程/<课>/原始资料/` 并登记；工具/脚本才进 `工具/`。
  别把原件堆在收件目录里——那既不好找，也容易被误提交。
"""
import http.server
import pathlib
import re
import sys
import urllib.parse

TOKEN = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8799
DEST = (
    pathlib.Path(sys.argv[3])
    if len(sys.argv) > 3
    else pathlib.Path(__file__).resolve().parents[2] / "工具" / "收件"
)
PARTS = DEST / ".parts"
DEST.mkdir(parents=True, exist_ok=True)
PARTS.mkdir(parents=True, exist_ok=True)
MAX = 800 * 1024 * 1024

FORM = """<!doctype html><meta charset=utf-8><title>传给 zcode</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<body style="font:16px/1.7 system-ui;max-width:44em;margin:3em auto;padding:0 1em">
<h2>把文件传给我（自动分片）</h2>
<p>临时收件口，<b>只写不读</b>。选文件后点上传；大文件会切成 2 MB 的小片逐片发送，
进度显示在下面，全部传完才算成功。</p>
<input type="file" id="f" multiple>
<button onclick="go()" style="padding:.5em 1.2em;font-size:1em">上传</button>
<pre id="log" style="white-space:pre-wrap"></pre>
<script>
const CHUNK = 2 * 1024 * 1024;
async function put(url, body) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, {method: 'PUT', body});
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((s) => setTimeout(s, 1000 * (i + 1)));
    }
  }
}
async function go() {
  const log = document.getElementById('log');
  for (const file of document.getElementById('f').files) {
    const n = Math.max(1, Math.ceil(file.size / CHUNK));
    log.textContent += `开始 ${file.name}（${(file.size / 1048576).toFixed(1)} MB，${n} 片）\\n`;
    try {
      for (let i = 0; i < n; i++) {
        const part = file.slice(i * CHUNK, (i + 1) * CHUNK);
        await put(`part/${i}/${encodeURIComponent(file.name)}`, part);
        log.textContent += `  第 ${i + 1}/${n} 片 ok\\n`;
      }
      log.textContent += (await put(`done/${encodeURIComponent(file.name)}/${n}`, '')) + '\\n';
    } catch (e) {
      log.textContent += '失败：' + e + '\\n';
    }
  }
  log.textContent += '全部结束。\\n';
}
</script>"""


def safe(name: str) -> str:
    """只留文件名，去路径与危险字符，防目录穿越。"""
    name = urllib.parse.unquote(name or "").strip().replace("\\", "/")
    name = name.split("/")[-1]
    name = re.sub(r'[\x00-\x1f<>:"|?*]', "_", name)
    return name[:120] or "upload.bin"


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, text: str):
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body_to(self, path: pathlib.Path) -> int:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX:
            raise ValueError("too large")
        got = 0
        with open(path, "wb") as fh:
            while got < length:
                chunk = self.rfile.read(min(1024 * 1024, length - got))
                if not chunk:
                    break
                fh.write(chunk)
                got += len(chunk)
        return got

    def do_GET(self):
        if self.path.rstrip("/") == f"/u/{TOKEN}":
            self._send(200, FORM)
        else:
            self._send(404, "not found")

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith(f"/u/{TOKEN}/"):
            self._send(403, "bad token")
            return
        rest = path[len(f"/u/{TOKEN}/"):]
        try:
            m = re.fullmatch(r"part/(\d+)/(.+)", rest)
            if m:
                idx, name = int(m.group(1)), safe(m.group(2))
                n = self._body_to(PARTS / f"{name}.{idx:05d}")
                print(f"[recv] part {name} #{idx} {n}B", flush=True)
                self._send(200, f"片 {idx} 收到（{n} 字节）")
                return
            m = re.fullmatch(r"done/(.+)/(\d+)", rest)
            if m:
                name, count = safe(m.group(1)), int(m.group(2))
                pieces = sorted(PARTS.glob(f"{name}.[0-9]*"))
                if len(pieces) != count:
                    self._send(400, f"片数不符：收到 {len(pieces)}，声明 {count}")
                    return
                out = DEST / name
                with open(out, "wb") as fh:
                    for piece in pieces:
                        fh.write(piece.read_bytes())
                        piece.unlink()
                print(f"[recv] DONE {name} {out.stat().st_size}B -> {out}", flush=True)
                self._send(200, f"已收到 {name}（{out.stat().st_size} 字节）")
                return
            name = safe(urllib.parse.unquote(self.headers.get("X-Filename") or rest))
            n = self._body_to(DEST / name)
            print(f"[recv] {name} {n}B -> {DEST / name}", flush=True)
            self._send(200, f"已收到 {name}（{n} 字节）")
        except Exception as exc:  # 出错也要有回执，前端才看得见
            print(f"[recv] ERROR {exc}", flush=True)
            self._send(500, f"出错：{exc}")

    def do_POST(self):
        self.do_PUT()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as srv:
        print(f"[recv] listening 127.0.0.1:{PORT} token={TOKEN} dest={DEST}", flush=True)
        srv.serve_forever()
