@echo off
set PORT=5009
echo Starting Hull Lunch Hub on http://localhost:%PORT%
echo Kitchen dashboard: http://localhost:%PORT%/kitchen
echo.
node server.js
pause
