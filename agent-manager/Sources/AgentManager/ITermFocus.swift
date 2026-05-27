import Foundation

/// クリックされたセッションのホストアプリを前面化する。
/// - iTerm2:        AppleScript で該当ペイン(セッション)を選択して activate。
/// - それ以外(Android Studio 等): `open -b <bundleId>` でそのアプリを前面化。
///   （統合ターミナルの特定タブまでは選択できないため、アプリの前面化までを行う）
enum ITermFocus {
    static let itermBundleID = "com.googlecode.iterm2"

    static func focus(session: Session) {
        let host = session.host_bundle_id ?? ""

        if host == itermBundleID && !session.iterm_session_id.isEmpty {
            focusITerm(guid: session.iterm_session_id, label: session.label)
        } else if !host.isEmpty {
            activateApp(bundleID: host, label: session.label)
        } else if !session.iterm_session_id.isEmpty {
            // 旧データ互換（host 未記録だが GUID あり）。
            focusITerm(guid: session.iterm_session_id, label: session.label)
        } else {
            log("skip: no host/guid for \(session.label)")
        }
    }

    /// iTerm2 の該当セッションを選択して前面化。
    private static func focusITerm(guid: String, label: String) {
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
                  return "ok"
                end if
              end repeat
            end repeat
          end repeat
          return "not-found"
        end tell
        """
        let (status, out, err) = runOsascript(script)
        if status == 0 && out == "ok" {
            log("ok: iterm focused \(label) (\(safe))")
        } else {
            log("FAILED iterm \(label) guid=\(safe) status=\(status) out=\(out) err=\(err)")
        }
    }

    /// ホストアプリ（Android Studio 等）を前面化し、可能なら該当プロジェクトの
    /// ウィンドウまで選択する。
    /// 1) `open -b` でアプリを前面化（権限不要・保証された最低限の挙動）。
    /// 2) アクセシビリティ権限があれば、タイトルに label(プロジェクト名)を含む
    ///    ウィンドウを AXRaise で前面化（複数プロジェクトを開いていても狙ったものへ）。
    private static func activateApp(bundleID: String, label: String) {
        // 1) 保証された前面化。
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        proc.arguments = ["-b", bundleID]
        try? proc.run()
        proc.waitUntilExit()

        // 2) ベストエフォートのウィンドウ選択（要アクセシビリティ権限）。
        let safe = label.filter { $0 != "\"" && $0 != "\\" }
        let script = """
        tell application "System Events"
          set procs to (application processes whose bundle identifier is "\(bundleID)")
          if procs is {} then return "no-proc"
          set p to item 1 of procs
          set matched to (windows of p whose title contains "\(safe)")
          if (count of matched) > 0 then
            perform action "AXRaise" of (item 1 of matched)
            set frontmost of p to true
            return "raised"
          end if
          set frontmost of p to true
          return "no-window-match"
        end tell
        """
        let (status, out, err) = runOsascript(script)
        log("activate \(bundleID) title~\(safe): open-b done; raise=\(out) status=\(status) err=\(err)")
    }

    private static func runOsascript(_ script: String) -> (Int32, String, String) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-e", script]
        let outPipe = Pipe(), errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        do {
            try proc.run()
            proc.waitUntilExit()
            let out = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return (proc.terminationStatus, out, err)
        } catch {
            return (-1, "", "\(error)")
        }
    }

    /// デバッグ用ログ。~/.claude/agent-manager/focus.log に追記。
    private static func log(_ message: String) {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/agent-manager", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("focus.log")
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
        if let data = line.data(using: .utf8) {
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: url)
            }
        }
    }
}
