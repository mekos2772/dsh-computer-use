$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH Computer Use Full Flow Demo'
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.Size = New-Object System.Drawing.Size(680, 430)
$form.MinimumSize = $form.Size
$form.MaximumSize = $form.Size
$form.BackColor = [System.Drawing.Color]::FromArgb(246, 248, 252)
$form.Font = [System.Drawing.Font]::new('Segoe UI', 11)
$form.TopMost = $true

$title = New-Object System.Windows.Forms.Label
$title.Text = 'dsh-computer-use'
$title.Font = [System.Drawing.Font]::new('Segoe UI', 22, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::FromArgb(28, 35, 48)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(42, 38)
$form.Controls.Add($title)

$flow = New-Object System.Windows.Forms.Label
$flow.Text = 'Discover  >  Observe  >  Move cursor  >  Click  >  Verify'
$flow.ForeColor = [System.Drawing.Color]::FromArgb(92, 101, 117)
$flow.AutoSize = $true
$flow.Location = New-Object System.Drawing.Point(46, 94)
$form.Controls.Add($flow)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Waiting for Computer Use'
$status.Name = 'demoStatus'
$status.AccessibleName = 'Waiting for Computer Use'
$status.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$status.Font = [System.Drawing.Font]::new('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$status.ForeColor = [System.Drawing.Color]::FromArgb(61, 72, 90)
$status.BackColor = [System.Drawing.Color]::White
$status.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$status.Location = New-Object System.Drawing.Point(45, 145)
$status.Size = New-Object System.Drawing.Size(574, 72)
$form.Controls.Add($status)

$button = New-Object System.Windows.Forms.Button
$button.Text = 'Click here'
$button.Name = 'demoButton'
$button.AccessibleName = 'Click here'
$button.Font = [System.Drawing.Font]::new('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$button.ForeColor = [System.Drawing.Color]::White
$button.BackColor = [System.Drawing.Color]::FromArgb(30, 111, 230)
$button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$button.FlatAppearance.BorderSize = 0
$button.Location = New-Object System.Drawing.Point(222, 250)
$button.Size = New-Object System.Drawing.Size(220, 70)
$form.Controls.Add($button)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = 'Watch the software cursor move, click, and play the blue ripple.'
$hint.ForeColor = [System.Drawing.Color]::FromArgb(112, 121, 136)
$hint.AutoSize = $true
$hint.Location = New-Object System.Drawing.Point(115, 345)
$form.Controls.Add($hint)

$closeTimer = New-Object System.Windows.Forms.Timer
$closeTimer.Interval = 6500
$closeTimer.Add_Tick({
  $closeTimer.Stop()
  $form.Close()
})

$button.Add_Click({
  $status.Text = 'Click succeeded'
  $status.AccessibleName = 'Click succeeded'
  $status.ForeColor = [System.Drawing.Color]::FromArgb(18, 120, 73)
  $status.BackColor = [System.Drawing.Color]::FromArgb(232, 249, 240)
  $button.Text = 'Completed'
  $button.BackColor = [System.Drawing.Color]::FromArgb(18, 153, 95)
  $closeTimer.Start()
})

[void]$form.ShowDialog()
$closeTimer.Dispose()
$form.Dispose()
