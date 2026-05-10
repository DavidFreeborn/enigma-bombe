@echo off
cd /d "%~dp0"
echo Starting local server for Enigma + Bombe...
echo.
echo Keep this window open while using the app.
echo If a browser does not open, go to http://127.0.0.1:8131
start "" http://127.0.0.1:8131
py -m http.server 8131 --bind 127.0.0.1
pause
