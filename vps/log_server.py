ubuntu@213.155.23.208's password: 
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

class LogHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers["Content-Length"])
        post_data = self.rfile.read(content_length)
        try:
            data = json.loads(post_data)
            with open("/home/trading-system/trades_log.json", "a") as f:
                f.write(json.dumps(data) + "\n")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"OK")
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode())

if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 18790), LogHandler)
    print("Log server running on 18790...")
    server.serve_forever()
