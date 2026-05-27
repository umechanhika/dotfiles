import Foundation

/// クリックされたセッションに対応する iTerm2 のペインを前面化する。
enum ITermFocus {
    /// guid は ITERM_SESSION_ID（wNtMpK:GUID）の GUID 部分。
    static func focus(guid: String) {
        guard !guid.isEmpty else { return }
        // guid をそのまま AppleScript 文字列に埋め込む（GUID は英数とハイフンのみ）。
        let safe = guid.filter { $0.isLetter || $0.isNumber || $0 == "-" }
        let script = """
        tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if id of s is "\(safe)" then
                  select w
                  select t
                  tell s to select
                  activate
                  return
                end if
              end repeat
            end repeat
          end repeat
        end tell
        """
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-e", script]
        try? proc.run()
    }
}
