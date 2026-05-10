from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import webbrowser

PORT = 8131
HOST = "127.0.0.1"
url = f"http://{HOST}:{PORT}"
print(f"Serving Enigma + Bombe at {url}")
print("Keep this terminal open while using the app.")
webbrowser.open(url)
ThreadingHTTPServer((HOST, PORT), SimpleHTTPRequestHandler).serve_forever()
