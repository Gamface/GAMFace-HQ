@echo off
rem Starts GAMFace HQ. Logs go to logs\hq.log when started by the scheduled task.
cd /d "%~dp0\.."
if not exist logs mkdir logs
python -m hq.server
