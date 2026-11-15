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

## Windows

```bash
node scripts\windows\supervise.js --install   # add kungfu-kanban.cmd to your Startup folder
node scripts\windows\supervise.js             # start now
node scripts\windows\supervise.js --status
node scripts\windows\supervise.js --stop      # clean stop: running cards are marked, state is flushed
```

The supervisor is the Windows stand-in for launchd's `KeepAlive`. It runs with
no console window, starts `node server.js` with its output appended to
`data\server.log`, and starts it again whenever it exits (an in-app update
included), backing off for a minute after five exits in two minutes. The server
gets a console with no window, so the `git`, `gh` and `claude` processes it
starts do not flash windows either. `--stop` asks the server to shut down over
IPC, because Windows has no signal to send it: `process.kill` there is a hard
kill that skips the shutdown handler. `--install` keeps an older
`kungfu-kanban.cmd` as `kungfu-kanban.cmd.bak`.

Avoid the old `start /min cmd /c "node server.js"` line: closing that window,
or Ctrl+C in it, ends the board and every card agent with it.

Every exit writes a `board exit: <reason> (code N)` line to the log (`SIGINT`,
`SIGHUP` for a closed console window, `SIGBREAK`, `supervisor: stop requested`,
an uncaught exception, an update). No line at all means the process was killed
from outside.

Cards cut short by a restart land in Review marked "interrupted by server
restart". `PUT /api/settings {"resumeInterrupted": true}` makes the board resume
each one's session when it starts again (off by default, since each resume is a
run). The flag is cleared on every start, so turning the setting on later never
resumes old cards.

---

[Back to the docs index](README.md)
