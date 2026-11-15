# Run at login (optional)

`~/Library/LaunchAgents/com.kungfu-kanban.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.kungfu-kanban</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>  <!-- `which node` -->
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/path/to/kungfu-kanban</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd's PATH is minimal; claude + gh + git must be findable -->
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/kungfu-kanban.log</string>
  <key>StandardErrorPath</key><string>/tmp/kungfu-kanban.log</string>
</dict></plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kungfu-kanban.plist  # load: start now + at login
launchctl kickstart -k gui/$(id -u)/com.kungfu-kanban                            # restart (e.g. after an update)
launchctl bootout   gui/$(id -u)/com.kungfu-kanban                               # unload / stop
```

Gotcha: loading an agent that's **already loaded** fails with the cryptic
`Load failed: 5: Input/output error` — that's launchd for "nothing to do".
`launchctl list | grep kungfu` shows whether it's loaded; use `kickstart -k`
to restart it.

---

[Back to the docs index](README.md)
