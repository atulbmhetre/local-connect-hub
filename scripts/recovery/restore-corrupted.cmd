@echo off
cd /d "%~dp0.."
git checkout HEAD -- src/components/IncomingOrdersSection.tsx tests/helpers/session38.ts
echo Restored IncomingOrdersSection and session38 from HEAD
