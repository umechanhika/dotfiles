import AppKit
import Foundation

/// クリックされたセッションのホストアプリを前面化する。
/// - iTerm2:        AppleScript で該当ペイン(セッション)を選択して activate。
///                  ITERM_SESSION_ID(GUID) という一意で不変の値で直接選択できる。
/// - それ以外(Android Studio 等): フック時に記録した cwd（ワークツリーのパス。一意で安定）を
///   ホストアプリのコマンドラインランチャー（AS の実行体 `studio`）に渡し、そのパスのプロジェクトの
///   既存ウィンドウを focus させる。ランチャーは実行中インスタンスへコマンドを転送して即終了し、
///   既に開いているプロジェクトなら新規に開かずそのフレームを前面化する。
///   `open -b <bundleId> <path>` はアプリ前面化のみでフレーム切替できないため使わない（実測確認済み）。
///   AS には iTerm2 の GUID に相当する一意なウィンドウIDが無い（1プロセスで複数プロジェクトを
///   ホストし、AXDocument も空、ウィンドウタイトルの形式も条件で変わり信頼できない）ため、
///   唯一安定な値＝cwd を鍵にする。System Events/アクセシビリティ権限は不要。
enum ITermFocus {
    static let itermBundleID = "com.googlecode.iterm2"

    static func focus(session: Session) {
        let host = session.host_bundle_id ?? ""

        if host == itermBundleID && !session.iterm_session_id.isEmpty {
            focusITerm(guid: session.iterm_session_id, label: session.label)
        } else if !host.isEmpty {
            activateApp(bundleID: host, cwd: session.cwd, label: session.label)
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

    /// ホストアプリ（Android Studio 等）の、cwd のプロジェクトウィンドウを前面化する。
    ///
    /// 起動中なら実行体（AS の `studio` ランチャー）に cwd を渡し、そのパスのプロジェクトの
    /// 既存フレームを focus する。ランチャーは実行中インスタンスへ転送して即 exit する。
    /// 未起動 or cwd 不明のときは `open -b` でアプリ前面化（未起動なら起動）に委ねる。
    private static func activateApp(bundleID: String, cwd: String, label: String) {
        let isRunning = !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
        // 起動中 & cwd 既知 & ランチャー解決OK → ランチャーで該当フレームを focus する。
        // それ以外（未起動 / cwd 不明 / 解決失敗）は open に委ねる（未起動なら起動）。
        guard isRunning, !cwd.isEmpty, let launcher = launcherURL(forBundleID: bundleID) else {
            openActivate(bundleID: bundleID, cwd: cwd, label: label)
            return
        }
        let proc = Process()
        proc.executableURL = launcher
        proc.arguments = [cwd]
        // studio ランチャー(Rust製)は起動時に環境変数 PWD を chdir 先にする。AgentManager は
        // SessionStart フックから起動され起動元セッションの PWD を握り続けるため、その worktree が
        // 削除されると PWD が無効になりランチャーが "Cannot set current directory" で起動失敗する。
        // 常に存在する HOME を渡して、揮発的な起動元 PWD から切り離す（前面化する対象は引数 cwd の
        // 絶対パスで指定済みなので、ランチャー自身の作業ディレクトリは何でもよい）。
        let safeDir = FileManager.default.homeDirectoryForCurrentUser
        proc.currentDirectoryURL = safeDir          // カーネル cwd（HOME は必ず存在＝run は throw しない）
        var env = ProcessInfo.processInfo.environment
        env["PWD"] = safeDir.path                    // ランチャーが実際に読むのはこちら（本質的な修正）
        proc.environment = env
        let errPipe = Pipe()
        proc.standardError = errPipe
        do {
            try proc.run()
            proc.waitUntilExit()   // 実行中インスタンスへ転送して即 exit する（実測確認済み）。
            let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if proc.terminationStatus == 0 {
                log("activate \(bundleID) [\(label)] via=launcher cwd=\(cwd): ok")
            } else {
                log("activate \(bundleID) [\(label)] via=launcher cwd=\(cwd): "
                    + "FAILED status=\(proc.terminationStatus) err=\(err)")
            }
        } catch {
            log("activate \(bundleID) [\(label)] via=launcher cwd=\(cwd): EXEC-ERROR \(error)")
        }
    }

    /// bundleID からアプリの実行体（= AS の `studio` ランチャー）のパスを解決する。
    /// 実行中アプリの `executableURL` は run loop の更新タイミング次第で nil になり得るため、
    /// 安定したバンドル解決（NSWorkspace → Bundle.executableURL）を使う。
    private static func launcherURL(forBundleID id: String) -> URL? {
        guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id),
              let exe = Bundle(url: appURL)?.executableURL else { return nil }
        return exe
    }

    /// `open -b` でアプリを前面化（未起動なら起動）する。特定ウィンドウの focus はしない。
    private static func openActivate(bundleID: String, cwd: String, label: String) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        proc.arguments = cwd.isEmpty ? ["-b", bundleID] : ["-b", bundleID, cwd]
        let errPipe = Pipe()
        proc.standardError = errPipe
        do {
            try proc.run()
            proc.waitUntilExit()
            let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if proc.terminationStatus == 0 {
                log("activate \(bundleID) [\(label)] via=open cwd=\(cwd): ok")
            } else {
                log("activate \(bundleID) [\(label)] via=open cwd=\(cwd): "
                    + "FAILED status=\(proc.terminationStatus) err=\(err)")
            }
        } catch {
            log("activate \(bundleID) [\(label)] via=open cwd=\(cwd): EXEC-ERROR \(error)")
        }
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
