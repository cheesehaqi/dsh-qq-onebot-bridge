Add-Type -AssemblyName System.Drawing

$W = 800; $H = 1600
$outDir = "D:\Deepseek\dsh-qq-onebot-bridge\assets"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$font = New-Object System.Drawing.Font("Microsoft YaHei", 28)
$fontSmall = New-Object System.Drawing.Font("Microsoft YaHei", 22)
$fontTitle = New-Object System.Drawing.Font("Microsoft YaHei", 38, [System.Drawing.FontStyle]::Bold)

function New-Image {
  $bmp = New-Object System.Drawing.Bitmap $W, $H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear([System.Drawing.Color]::FromArgb(245, 246, 247))
  return @($bmp, $g)
}

function Draw-Header($g, $title) {
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(18, 150, 219))
  $g.FillRectangle($brush, 0, 0, $W, 150)
  $g.DrawString($title, $fontTitle, [System.Drawing.Brushes]::White, 30, 40)
  $g.DrawString("dsh-qq-onebot-bridge", $fontSmall, [System.Drawing.Brushes]::White, 32, 102)
}

function Draw-Bubble($g, $text, $isUser, [ref]$y) {
  $maxW = 470
  $padX = 24; $padY = 16
  $lines = @(); $cur = ''
  foreach ($ch in $text.ToCharArray()) {
    $test = $cur + [string]$ch
    if ($g.MeasureString($test, $font).Width -gt $maxW) { $lines += $cur; $cur = [string]$ch } else { $cur = $test }
  }
  if ($cur -ne '') { $lines += $cur }
  $tw = ($lines | ForEach-Object { $g.MeasureString($_, $font).Width } | Measure-Object -Maximum).Maximum
  $bw = $tw + $padX * 2
  $lineH = $font.Height + 10
  $bh = $lines.Count * $lineH + $padY * 2
  $bx = if ($isUser) { $W - 40 - $bw } else { 40 }
  $by = $y.Value
  $color = if ($isUser) { [System.Drawing.Color]::FromArgb(149, 236, 105) } else { [System.Drawing.Color]::White }
  $brush = New-Object System.Drawing.SolidBrush($color)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 22
  $path.AddArc($bx, $by, $r * 2, $r * 2, 180, 90)
  $path.AddArc($bx + $bw - $r * 2, $by, $r * 2, $r * 2, 270, 90)
  $path.AddArc($bx + $bw - $r * 2, $by + $bh - $r * 2, $r * 2, $r * 2, 0, 90)
  $path.AddArc($bx, $by + $bh - $r * 2, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()
  $g.FillPath($brush, $path)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 225, 230))
  $g.DrawPath($pen, $path)
  $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 35, 40))
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $g.DrawString($lines[$i], $font, $textBrush, $bx + $padX, $by + $padY + $i * $lineH)
  }
  $y.Value = $by + $bh + 28
}

function Save-Image($bmp, $g, $path) {
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "已生成 $path"
}

# ---- 截图 1：私聊能力 ----
$r = New-Image; $bmp = $r[0]; $g = $r[1]
Draw-Header $g "小鲸鱼 · 私聊"
$y = [ref]190
Draw-Bubble $g "你好呀，我是小鲸鱼 🐋" $false $y
Draw-Bubble $g "30分钟后提醒我喝水" $true $y
Draw-Bubble $g "⏰ 好的，将在 30 分钟后提醒：喝水" $false $y
Draw-Bubble $g "【语音消息 6 秒】" $true $y
Draw-Bubble $g "语音转文字：今晚吃火锅吗？" $false $y
Draw-Bubble $g "【图片】" $true $y
Draw-Bubble $g "识图：一只睡觉的猫，打着呼噜~" $false $y
Draw-Bubble $g "记一下：周五前交周报" $true $y
Draw-Bubble $g "✅ 已添加待办：周五前交周报" $false $y
Save-Image $bmp $g "$outDir\screenshot-private.png"

# ---- 截图 2：群管理 ----
$r2 = New-Image; $bmp2 = $r2[0]; $g2 = $r2[1]
Draw-Header $g2 "小鲸鱼 · 群管理"
$y2 = [ref]190
Draw-Bubble $g2 "投票：今晚吃什么？A 火锅 B 烧烤" $false $y2
Draw-Bubble $g2 "A" $true $y2
Draw-Bubble $g2 "B" $true $y2
Draw-Bubble $g2 "🗳️ 投票结束：A 火锅 1 票，B 烧烤 1 票" $false $y2
Draw-Bubble $g2 "/todo" $true $y2
Draw-Bubble $g2 "待办清单：1. 交周报  2. 买鱼饲料" $false $y2
Draw-Bubble $g2 "/summary" $true $y2
Draw-Bubble $g2 "今天群里聊了：团建、火锅投票、周报安排…" $false $y2
Draw-Bubble $g2 "/kick 需要二次确认，误踢有保护 ✅" $false $y2
Save-Image $bmp2 $g2 "$outDir\screenshot-group.png"
