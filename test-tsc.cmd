@echo off
call npx tsc --noEmit %*
if %ERRORLEVEL% neq 0 (
    echo TypeScript compilation failed with exit code %ERRORLEVEL%.
    exit /b %ERRORLEVEL%
)
echo TypeScript compilation passed.
