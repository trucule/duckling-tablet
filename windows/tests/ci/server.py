# A tiny web server for the shell test: serves test.html (the stand-in for the web app) and the catalog entry the
# test installs, and stores what the page reports. Usage: python server.py <port> <folder>
import json, sys, http.server, os

port, folder = int(sys.argv[1]), sys.argv[2]

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=folder, **k)
    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = self.rfile.read(n)
        name = self.path.strip('/').replace('/', '_') or 'post'
        with open(os.path.join(folder, f'{name}.json'), 'wb') as f: f.write(body)
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass

http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
