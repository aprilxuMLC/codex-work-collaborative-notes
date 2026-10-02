@echo off
rem Start the MCP server on Windows. Codex resolves "./server/launch-mcp" to this file.
call "%~dp0node-run.cmd" "%~dp0mcp.mjs"
exit /b %errorlevel%
