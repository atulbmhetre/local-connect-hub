# Aaspaas Pro — DB Quick Check Script
# Usage: .\db-check.ps1
# Runs against TEST environment

$BASE = "https://hhdylnhqdzfabsolwxdz.supabase.co/rest/v1"
$KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhoZHlsbmhxZHpmYWJzb2x3eGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NDQ0ODEsImV4cCI6MjA5NjAyMDQ4MX0.CWGB3IcOmFK7NsHIy6bgPulRfVGRuDxXDzdEZ7V777s"
$H    = @{ "Authorization" = "Bearer $KEY"; "apikey" = $KEY }

function Get-Table($table, $query) {
    $uri = "$BASE/${table}?${query}"
    try {
        $r = Invoke-WebRequest -Uri $uri -Headers $H -ErrorAction Stop
        $r.Content | ConvertFrom-Json | Format-Table -AutoSize
    } catch {
        Write-Host "ERROR: $_" -ForegroundColor Red
    }
}

Write-Host "`n=== TEST VENDORS (last 10) ===" -ForegroundColor Cyan
Get-Table "vendors" "select=phone,shop_name,category,is_active,subscription_status&order=last_updated.desc&limit=10"

Write-Host "`n=== ORPHAN TEST VENDORS (phone starts 9800) ===" -ForegroundColor Cyan
Get-Table "vendors" "phone=like.9800*&select=phone,shop_name,category&limit=20"

Write-Host "`n=== OPEN REQUESTS (last 10) ===" -ForegroundColor Cyan
Get-Table "requests" "select=id,user_phone,status,payment_status&order=id.desc&limit=10"

Write-Host "`n=== ADMIN ALERTS (open) ===" -ForegroundColor Cyan
Get-Table "admin_alerts" "resolved_at=is.null&select=function_name,error_type,first_failed_at&limit=10"

Write-Host "`nDone." -ForegroundColor Green
