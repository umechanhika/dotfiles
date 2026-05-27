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

    /// ホストアプリ（Android Studio 等）の、該当プロジェクトのウィンドウだけを前面化する。
    ///
    /// ワークツリーは同一チケットの別ブランチでプロジェクト名が前方一致しやすいため、
    /// 単純な部分一致（title contains）だと別ウィンドウへ誤って飛ぶ。これを避けるため:
    ///   1) 対象プロセスの全ウィンドウタイトルを列挙（前面化はまだしない）。
    ///   2) Swift 側で cwd フルパス優先 → 境界考慮の label 一致でベストマッチを厳密選定。
    ///   3) 一意に特定できたタイトルのみを AXRaise。曖昧／不一致なら誤ウィンドウは raise せず、
    ///      アプリ前面化のみに留める（＝勝手に新規プロジェクトを開かない）。
    /// いずれも System Events（アクセシビリティ権限）が必要。未付与時は前面化のみ。
    private static func activateApp(bundleID: String, cwd: String, label: String) {
        // 1) ウィンドウタイトルを列挙。区切りは ASCII RS(0x1e)。タイトルに改行が
        //    含まれても壊れないよう改行以外の制御文字を使う。
        let listScript = """
        tell application "System Events"
          set procs to (application processes whose bundle identifier is "\(bundleID)")
          if procs is {} then return "<no-proc>"
          set p to item 1 of procs
          set out to ""
          repeat with w in windows of p
            set out to out & (title of w) & (ASCII character 30)
          end repeat
          return out
        end tell
        """
        let (status, out, err) = runOsascript(listScript)
        if status != 0 {
            let denied = err.contains("-25211") || err.contains("補助アクセス")
                || err.lowercased().contains("not allowed assistive")
            if denied {
                log("activate \(bundleID) [\(label)] DENIED: アクセシビリティ権限が未付与です。"
                    + "『システム設定 → プライバシーとセキュリティ → アクセシビリティ』で "
                    + "AgentManager.app を有効化してください。 err=\(err)")
            } else {
                log("activate \(bundleID) [\(label)] enumerate failed status=\(status) err=\(err)")
            }
            return
        }
        if out == "<no-proc>" {
            log("activate \(bundleID) [\(label)] skip: プロセスなし（未起動）。")
            return
        }

        let titles = out.split(separator: "\u{1e}", omittingEmptySubsequences: true).map(String.init)
        guard let match = bestMatch(titles: titles, cwd: cwd, label: label) else {
            // 一意に特定できない（0件 or 複数）ときは誤ウィンドウへ飛ばさない。
            log("activate \(bundleID) [\(label)] no unique window match; titles=\(titles)")
            return
        }

        // 2) 完全一致でウィンドウを再特定して前面化（列挙〜raise 間の順序変化に耐える）。
        let safeTitle = match.title.filter { $0 != "\"" && $0 != "\\" }
        let raiseScript = """
        tell application "System Events"
          set procs to (application processes whose bundle identifier is "\(bundleID)")
          if procs is {} then return "no-proc"
          set p to item 1 of procs
          set matched to (windows of p whose title is "\(safeTitle)")
          if (count of matched) > 0 then
            perform action "AXRaise" of (item 1 of matched)
            set frontmost of p to true
            return "raised"
          end if
          return "no-window-match"
        end tell
        """
        let (rStatus, rOut, rErr) = runOsascript(raiseScript)
        log("activate \(bundleID) [\(label)] via=\(match.kind) title=\(match.title): "
            + "raise=\(rOut) status=\(rStatus) err=\(rErr)")
    }

    /// ウィンドウ特定の結果。`kind` はマッチ方式（fullpath/label）。
    private struct WindowMatch { let title: String; let kind: String }

    /// タイトル一覧から、対象プロジェクトのウィンドウを厳密に1件選ぶ。
    /// 一意に決まらない（0件 or 複数）場合は nil を返し、呼び出し側で前面化を見送る。
    ///
    /// Android Studio はウィンドウタイトルに2形式を使う:
    ///   形式A: "<ワークツリー名> – <ファイル> [<ルート名>]"        （プロジェクト名が一意なとき）
    ///   形式B: "<ルート名> [<フルパス>] – <ファイル> [<ルート名>]"  （同名プロジェクトを複数開いたとき）
    /// 同一チケットの別ブランチは形式Bになりやすく、パスは "~" 表記になる。
    /// どちらの形式でも、いずれかの一致が「直後が境界文字」のときだけ採用し、
    /// "feature-MBDEV-82" が "feature-MBDEV-82-..." に巻き込まれる前方一致衝突を防ぐ。
    private static func bestMatch(titles: [String], cwd: String, label: String) -> WindowMatch? {
        // 1) フルパス優先（形式B対応）。cwd の絶対表記とチルダ表記の両方で、
        //    タイトル中に「直後が境界」で現れるものを探す。
        let pathNeedles = [cwd, tildePath(cwd)].filter { !$0.isEmpty }
        let pathHits = titles.filter { title in
            pathNeedles.contains { titleContainsToken(title, $0) }
        }
        if pathHits.count == 1 { return WindowMatch(title: pathHits[0], kind: "fullpath") }
        if pathHits.count > 1 { return nil }   // 同一パスが複数＝特定不能

        // 2) 境界考慮の label 一致（形式A対応）。先頭が label で直後が境界のものだけ。
        guard !label.isEmpty else { return nil }
        let labelHits = titles.filter { title in
            guard title.hasPrefix(label) else { return false }
            let rest = title.dropFirst(label.count)
            guard let next = rest.first else { return true }   // 完全一致
            return isBoundary(next)
        }
        if labelHits.count == 1 { return WindowMatch(title: labelHits[0], kind: "label") }
        return nil
    }

    /// `title` 中に `needle` が「直後が境界文字（または末尾）」で出現するか。
    /// これにより短いパスが長いパスのプレフィックスとして誤一致するのを防ぐ。
    private static func titleContainsToken(_ title: String, _ needle: String) -> Bool {
        guard !needle.isEmpty else { return false }
        var search = title.startIndex
        while let range = title.range(of: needle, range: search..<title.endIndex) {
            if range.upperBound == title.endIndex || isBoundary(title[range.upperBound]) {
                return true
            }
            search = range.lowerBound < title.endIndex
                ? title.index(after: range.lowerBound) : title.endIndex
            if search >= title.endIndex { break }
        }
        return false
    }

    /// 絶対パスのホームディレクトリ部分を "~" に置き換える（AS のタイトル表記に合わせる）。
    private static func tildePath(_ path: String) -> String {
        let home = NSHomeDirectory()
        guard !home.isEmpty, path == home || path.hasPrefix(home + "/") else { return "" }
        return "~" + path.dropFirst(home.count)
    }

    /// プロジェクト名トークンの直後として許容する境界文字か。
    /// 空白類・IntelliJ のセパレータ（en-dash – / em-dash —）・角括弧などを境界とみなす。
    /// ASCII ハイフン '-' は branch 名の一部なので境界に含めない
    /// （含めると "feature-MBDEV-82" が "feature-MBDEV-82-..." に誤マッチする）。
    private static func isBoundary(_ c: Character) -> Bool {
        if c.isWhitespace { return true }
        return "–—[]()|:".contains(c)
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
