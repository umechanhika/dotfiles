import Foundation
import SwiftUI

/// hook が書き出す 1 セッション分の状態。
struct Session: Identifiable, Decodable {
    let session_id: String
    let cwd: String
    let label: String
    let state: String          // "waiting" | "processing" | "idle"
    let iterm_session_id: String
    let updated_at: String

    var id: String { session_id }

    /// 表示の並び順優先度（確認待ちを最上位に）。
    var sortRank: Int {
        switch state {
        case "waiting":    return 0
        case "processing": return 1
        default:           return 2   // idle
        }
    }

    var color: Color {
        switch state {
        case "waiting":    return .yellow
        case "processing": return .green
        default:           return .secondary
        }
    }

    var stateLabel: String {
        switch state {
        case "waiting":    return "確認待ち"
        case "processing": return "処理中"
        default:           return "待機"
        }
    }

    /// 最終更新が古い（hook 取りこぼし等）かどうか。表示を薄くする目安。
    var isStale: Bool {
        guard let date = ISO8601DateFormatter().date(from: updated_at) else { return false }
        return Date().timeIntervalSince(date) > 30 * 60
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
        // updated_at の経過（isStale 判定）を反映するための定期再描画。
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
        loaded.sort {
            $0.sortRank != $1.sortRank ? $0.sortRank < $1.sortRank
                                       : $0.label.localizedCompare($1.label) == .orderedAscending
        }
        sessions = loaded
    }
}
