@echo off
REM Serves the app on http://localhost:8000 (the microphone needs localhost or https).
cd /d "%~dp0"
start "" http://localhost:8000/
py -m http.server 8000
