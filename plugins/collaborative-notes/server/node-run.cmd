@echo off
rem Run a script with the Node.js that ships with ChatGPT on Windows.
rem Order: CODEX_MCP_NODE_PATH (set for hooks), the runtime copy under
rem %LOCALAPPDATA%\OpenAI\Codex\runtimes, then node on PATH.
setlocal
rem Leave the plugin folder: Windows cannot rename a folder that is a running
rem process's current directory, which breaks plugin updates.
cd /d "%USERPROFILE%" 2>nul
set "CN_NODE="
if defined CODEX_MCP_NODE_PATH if exist "%CODEX_MCP_NODE_PATH%" set "CN_NODE=%CODEX_MCP_NODE_PATH%"
if not defined CN_NODE for /f "delims=" %%N in ('dir /b /s "%LOCALAPPDATA%\OpenAI\Codex\runtimes\node.exe" 2^>nul') do if not defined CN_NODE set "CN_NODE=%%N"
if not defined CN_NODE for /f "delims=" %%N in ('where node 2^>nul') do if not defined CN_NODE set "CN_NODE=%%N"
if not defined CN_NODE (
  echo Collaborative Notes: no Node.js runtime found ^(expected the one bundled with ChatGPT^)>&2
  exit /b 1
)
"%CN_NODE%" %*
exit /b %errorlevel%
