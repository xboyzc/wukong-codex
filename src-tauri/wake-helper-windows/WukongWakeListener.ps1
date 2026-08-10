param(
    [Parameter(Mandatory = $true)]
    [string]$EventFile,
    [switch]$Conversation
)

$ErrorActionPreference = "Stop"

function Write-WukongEvent {
    param([hashtable]$Value)
    $json = $Value | ConvertTo-Json -Compress
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $writer = New-Object System.IO.StreamWriter($EventFile, $true, $utf8)
    try {
        $writer.WriteLine($json)
    }
    finally {
        $writer.Dispose()
    }
}

function Normalize-WukongPhrase {
    param([string]$Phrase)
    return ($Phrase.ToLowerInvariant() -replace '[\s\p{P}\p{S}]', '')
}

try {
    Add-Type -AssemblyName System.Speech
    Write-WukongEvent @{ type = "boot" }

    $recognizerInfo = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
        Where-Object { $_.Culture.Name -eq "zh-CN" } |
        Select-Object -First 1
    if ($null -eq $recognizerInfo) {
        Write-WukongEvent @{
            type = "error"
            message = "Windows 未安装中文（简体）语音识别语言包。请在设置 > 时间和语言 > 语言和区域中添加中文语音。"
        }
        exit 3
    }

    $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new($recognizerInfo)
    if ($Conversation) {
        $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
    }
    else {
        $choices = [System.Speech.Recognition.Choices]::new()
        $choices.Add([string[]]@("嗨悟空", "嘿悟空", "黑悟空"))
        $builder = [System.Speech.Recognition.GrammarBuilder]::new()
        $builder.Culture = $recognizerInfo.Culture
        $builder.Append($choices)
        $recognizer.LoadGrammar([System.Speech.Recognition.Grammar]::new($builder))
    }
    $recognizer.SetInputToDefaultAudioDevice()

    $sourceId = "WukongSpeech-$PID"
    Register-ObjectEvent -InputObject $recognizer -EventName SpeechRecognized -SourceIdentifier $sourceId | Out-Null
    Write-WukongEvent @{ type = "authorization"; status = "authorized" }
    $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
    Write-WukongEvent @{ type = "ready" }

    $complete = $false
    while (-not $complete) {
        $event = Wait-Event -SourceIdentifier $sourceId -Timeout 1
        if ($null -eq $event) {
            continue
        }
        try {
            $result = $event.SourceEventArgs.Result
            $phrase = $result.Text.Trim()
            if ([string]::IsNullOrWhiteSpace($phrase) -or $result.Confidence -lt 0.20) {
                continue
            }
            if ($Conversation) {
                Write-WukongEvent @{ type = "utterance"; phrase = $phrase }
                $complete = $true
                continue
            }
            $normalized = Normalize-WukongPhrase $phrase
            if ($normalized.Contains("嗨悟空") -or $normalized.Contains("嘿悟空") -or $normalized.Contains("黑悟空")) {
                Write-WukongEvent @{ type = "wake"; phrase = $phrase }
                $complete = $true
            }
            else {
                Write-WukongEvent @{ type = "heard"; phrase = $phrase }
            }
        }
        finally {
            Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue
        }
    }
}
catch {
    Write-WukongEvent @{ type = "error"; message = $_.Exception.Message }
    exit 2
}
finally {
    if ($null -ne $recognizer) {
        try { $recognizer.RecognizeAsyncCancel() } catch {}
        try { $recognizer.Dispose() } catch {}
    }
    Unregister-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue
}
