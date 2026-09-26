@echo off
rem Open Otoku Navi in the PC browser. Close this window to stop.
cd /d "%~dp0docs"
start "" "http://localhost:8765/#search"
python -m http.server 8765 --bind 127.0.0.1
