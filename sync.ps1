$ErrorActionPreference = 'Stop'

$st = 'C:\Silly-tavern\SillyTavern'
$repo = 'C:\Silly-tavern\SiliTavernKevin'
$xd = @('.git', 'node_modules', '__pycache__')
$log = '/NFL', '/NDL', '/NJH', '/NJS', '/NP'

Write-Host 'Copiando plugin Edge TTS parcheado...'
New-Item -ItemType Directory -Force -Path "$repo\plugins\edge-tts\dist" | Out-Null
Copy-Item "$st\plugins\edge-tts\src\index.ts" "$repo\plugins\edge-tts\index.ts" -Force
Copy-Item "$st\plugins\edge-tts\voice-profiles.json" "$repo\plugins\edge-tts\voice-profiles.json" -Force
Copy-Item "$st\plugins\edge-tts\dist\plugin.js" "$repo\plugins\edge-tts\dist\plugin.js" -Force
Copy-Item "$st\config.yaml" "$repo\config.yaml" -Force

Write-Host 'Copiando parche de voces por hablante...'
New-Item -ItemType Directory -Force -Path "$repo\patches" | Out-Null
Copy-Item "$st\public\scripts\extensions\tts\index.js" "$repo\patches\tts-speakers-index.js" -Force

Write-Host 'Copiando datos del usuario...'
robocopy "$st\data\default-user" "$repo\data\default-user" 'settings.json' @log | Out-Null
robocopy "$st\data\default-user\OpenAI Settings" "$repo\data\default-user\OpenAI Settings" /MIR @log | Out-Null
robocopy "$st\data\default-user\themes" "$repo\data\default-user\themes" /MIR @log | Out-Null
robocopy "$st\data\default-user\worlds" "$repo\data\default-user\worlds" /MIR @log | Out-Null
robocopy "$st\data\default-user\characters" "$repo\data\default-user\characters" /MIR /XD @xd @log | Out-Null
robocopy "$st\data\default-user\extensions" "$repo\data\default-user\extensions" /MIR /XD @xd @log | Out-Null
robocopy "$st\data\default-user\assets" "$repo\data\default-user\assets" /MIR @log | Out-Null

Write-Host 'Subiendo a GitHub...'
Push-Location $repo
try {
    git add -A
    $msg = "Sync SillyTavern - $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    git commit -m $msg
    git push
    Write-Host "Listo: $msg"
} finally {
    Pop-Location
}
