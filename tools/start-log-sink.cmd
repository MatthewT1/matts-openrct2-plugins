@echo off
REM Starts the OpenRCT2 plugin debug/profiling sink (tools/log-sink.mjs) standalone,
REM so it can run in its own window without tying up an agent/background task.
REM
REM   Double-click this file, or run it from a terminal:
REM     tools\start-log-sink.cmd
REM
REM It listens on 127.0.0.1:7777 and appends every record to tools\rct-debug.log.
REM Leave the window open for the duration of the game session; Ctrl+C to stop.
REM Turn on "Diagnostics" in any plugin window to start streaming to it.

setlocal
cd /d "%~dp0.."
node tools\log-sink.mjs
endlocal
