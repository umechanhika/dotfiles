import Foundation
import SwiftUI

/// hook が書き出す 1 セッション分の状態。
struct Session: Identifiable, Decodable {
    let session_id: String
    let cwd: String
    let label: String
    let state: String          // "waiting" | "done" | "processing" | "idle"
    let iterm_session_id: String
    let updated_at: String
    let host_bundle_id: String?  // セッションを起動したアプリ（旧ファイル互換のため optional）
    let created_at: String?      // 初回作成時刻（表示順の固定に使用。旧ファイル互換で optional）

    var id: String { session_id }

    /// 表示の並び順キー（起動順で固定するため created_at、無ければ updated_at）。
    var sortKey: String { created_at ?? updated_at }

    var color: Color {
        switch state {
        case "waiting":    return .yellow    // 明確なアクション待ち
        case "done":       return .green     // 応答完了
        case "processing": return .blue      // 処理中
        default:           return .secondary // 待機
        }
    }

    var stateLabel: String {
        switch state {
        case "waiting":    return "要対応"
        case "done":       return "応答完了"
        case "processing": return "処理中"
        default:           return "待機"
        }
    }
}

/// ~/.claude/agent-manager/sessions/ を監視し、JSON 群を読み込んで公開する。
final class SessionStore: ObservableObject {
    @Published private(set) var sessions: [Session] = []

    private let dir: URL
    private var source: DispatchSourceFileSystemObject?
    private var dirFD: Int32 = -1
    private var refreshTimer: Timer?

    init() {
        dir = FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/agent-manager/sessions", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        reload()
        startWatching()
        // FSEvents を取りこぼした場合の保険として定期的に再読込する。
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.reload()
        }
    }

    deinit {
        source?.cancel()
        if dirFD >= 0 { close(dirFD) }
        refreshTimer?.invalidate()
    }

    private func startWatching() {
        dirFD = open(dir.path, O_EVTONLY)
        guard dirFD >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: dirFD,
            eventMask: [.write, .delete, .rename],
            queue: .main
        )
        src.setEventHandler { [weak self] in self?.reload() }
        src.setCancelHandler { [weak self] in
            if let fd = self?.dirFD, fd >= 0 { close(fd) }
        }
        src.resume()
        source = src
    }

    private func reload() {
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))?
            .filter { $0.pathExtension == "json" } ?? []
        let decoder = JSONDecoder()
        var loaded: [Session] = []
        for url in files {
            guard let data = try? Data(contentsOf: url),
                  let s = try? decoder.decode(Session.self, from: data) else { continue }
            loaded.append(s)
        }
        // 起動順で固定（ステータス変化で並びが動かないように）。同時刻は session_id で安定化。
        loaded.sort {
            $0.sortKey != $1.sortKey ? $0.sortKey < $1.sortKey
                                     : $0.session_id < $1.session_id
        }
        sessions = loaded
    }
}
