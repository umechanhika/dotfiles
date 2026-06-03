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
    let state_since: String?     // その状態が始まった時刻（経過時間表示の基準。旧ファイル互換で optional）
    let host_bundle_id: String?  // セッションを起動したアプリ（旧ファイル互換のため optional）
    let created_at: String?      // 初回作成時刻（表示順の固定に使用。旧ファイル互換で optional）
    let owner_pid: Int?          // セッションを所有する claude プロセスの PID（孤児掃除に使用。旧ファイル互換で optional）
    let owner_started_at: String? // 所有プロセスの起動時刻（PID 再利用の誤判定回避用）

    var id: String { session_id }

    /// 表示の並び順キー（起動順で固定するため created_at、無ければ updated_at）。
    var sortKey: String { created_at ?? updated_at }

    /// ステータスの分類。色・件数集計（メニューバー）の分類根拠を 1 箇所に集約する。
    enum StatusCategory {
        case waiting     // 確認待ち（許可/プラン承認/選択肢回答）
        case done        // 応答完了
        case processing  // 処理中
        case idle        // 待機（開始直後/未知の state も含む）
    }

    /// `state` 文字列をカテゴリへ写す。未知の state は `.idle` 扱い。
    var category: StatusCategory {
        switch state {
        case "waiting":    return .waiting
        case "done":       return .done
        case "processing": return .processing
        default:           return .idle
        }
    }

    /// ステータス色。システム既定の原色（.yellow/.green/.blue）は彩度がばらつき
    /// "AIっぽい" 見えになりやすいので、彩度・輝度を揃えた落ち着いたアクセントにする。
    var color: Color { Self.color(for: category) }

    /// カテゴリ → 色。フローティング窓とメニューバーで同じ配色を共有する。
    static func color(for category: StatusCategory) -> Color {
        switch category {
        case .waiting:    return amber
        case .done:       return green
        case .processing: return blue
        case .idle:       return slate
        }
    }

    static let amber = Color(red: 0.93, green: 0.69, blue: 0.23)
    static let green = Color(red: 0.36, green: 0.77, blue: 0.50)
    static let blue  = Color(red: 0.36, green: 0.62, blue: 0.94)
    static let slate = Color(red: 0.55, green: 0.57, blue: 0.61)

    var stateLabel: String {
        switch state {
        case "waiting":    return "確認待ち"
        case "done":       return "応答完了"
        case "processing": return "処理中"
        default:           return "待機"
        }
    }

    /// 注意を要する状態（確認待ち）。緊急度の強調に使う。
    var needsAttention: Bool { state == "waiting" }
    /// 動作中（処理中）。穏やかな"生きている"アニメに使う。
    var isActive: Bool { state == "processing" }

    /// `updated_at`（例: 2026-05-31T14:23:01+09:00）を Date 化。最終活動時刻。
    var updatedAtDate: Date? { Self.isoFormatter.date(from: updated_at) }

    /// `state_since`（その状態が始まった時刻）を Date 化。経過時間表示の基準。
    /// 旧ファイル（state_since 無し）は updated_at にフォールバック。
    var stateSinceDate: Date? {
        if let s = state_since, let d = Self.isoFormatter.date(from: s) { return d }
        return updatedAtDate
    }

    private static let isoFormatter = ISO8601DateFormatter()
}

/// ~/.claude/agent-manager/sessions/ を監視し、JSON 群を読み込んで公開する。
final class SessionStore: ObservableObject {
    @Published private(set) var sessions: [Session] = []

    /// 全セッションが終了して 0 件になったときに呼ばれる（アプリ終了の配線用）。
    /// ライフサイクル制御は AppDelegate 側に委ねるため、ここでは直接終了しない。
    var onAllSessionsEnded: (() -> Void)?

    private let dir: URL
    private var source: DispatchSourceFileSystemObject?
    private var dirFD: Int32 = -1
    private var refreshTimer: Timer?

    /// 一度でもセッションを観測したか。起動直後のフック書き込み競合で一瞬 0 件に
    /// なることがあり、それを「全終了」と誤判定しないためのガード。
    private var hasSeenSessions = false
    /// 「非空 → 空」遷移を確定させるためのデバウンス用ワンショットタイマー。
    /// 削除→再作成の瞬間的な空状態で誤終了しないよう、発火時に再確認する。
    private var quitTimer: Timer?

    init() {
        dir = FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/agent-manager/sessions", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        startWatching()
        // 起動直後はフックの JSON 書き込み競合で reload が 0件→N件 と往復し、ウィンドウ高さが
        // ガクつく。初回読込だけ短く遅延し、書き込みが落ち着いてから一度に反映する。
        // watching を先に張るので、遅延中の書き込みも FSEvents 側で拾える（取りこぼし無し）。
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.reload()
        }
        // FSEvents を取りこぼした場合の保険として定期的に再読込する。
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.reload()
        }
    }

    deinit {
        source?.cancel()
        if dirFD >= 0 { close(dirFD) }
        refreshTimer?.invalidate()
        quitTimer?.invalidate()
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
            // 所有プロセスが消えた孤児セッションは掃除する。
            // owner_pid を持たない旧ファイルは判定材料がないため従来どおり保持する。
            if let pid = s.owner_pid, !Self.isOwnerAlive(pid: pid, startedAt: s.owner_started_at) {
                try? fm.removeItem(at: url)
                continue
            }
            loaded.append(s)
        }
        // 起動順で固定（ステータス変化で並びが動かないように）。同時刻は session_id で安定化。
        loaded.sort {
            $0.sortKey != $1.sortKey ? $0.sortKey < $1.sortKey
                                     : $0.session_id < $1.session_id
        }
        sessions = loaded
        evaluateLifecycle(isEmpty: loaded.isEmpty)
    }

    /// セッション件数の遷移を見て、全終了時にアプリ終了を促す。
    /// - 非空: 「観測済み」を記録し、保留中の終了予約があれば取り消す。
    /// - 空: 一度でも観測していれば、約1.5秒後に再確認して終了を促す（デバウンス）。
    ///   起動直後にまだ観測していない空（hasSeenSessions==false）では何もしない。
    private func evaluateLifecycle(isEmpty: Bool) {
        if !isEmpty {
            hasSeenSessions = true
            quitTimer?.invalidate()
            quitTimer = nil
            return
        }
        guard hasSeenSessions, quitTimer == nil else { return }
        quitTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.quitTimer = nil
            // 待っている間に新しいセッションが現れていたら終了しない。
            if self.sessions.isEmpty { self.onAllSessionsEnded?() }
        }
    }

    /// 所有プロセスが生きているか。死んでいれば false（＝孤児として掃除対象）。
    /// PID 再利用で別プロセスに化けるのを避けるため、起動時刻が記録されていれば
    /// 現在の同 PID の起動時刻と一致することも要求する。
    private static func isOwnerAlive(pid: Int, startedAt: String?) -> Bool {
        // kill(pid, 0): 生存なら 0、いなければ -1 で errno==ESRCH。
        // EPERM（存在するが権限なし）は同一ユーザー運用では基本起きないが、
        // 生存扱いにして誤掃除を避ける。
        if kill(pid_t(pid), 0) != 0 && errno == ESRCH { return false }

        guard let startedAt = startedAt, !startedAt.isEmpty else { return true }
        return currentStartTime(pid: pid) == startedAt
    }

    /// `ps -o lstart=` で指定 PID の起動時刻文字列を取得（前後空白は除去）。
    private static func currentStartTime(pid: Int) -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/ps")
        proc.arguments = ["-o", "lstart=", "-p", String(pid)]
        // lstart はロケール依存。記録側(hook)と同じ C ロケールに固定し、ホスト端末の
        // ロケール差（Android Studio は LANG 無し等）で文字列が食い違って生存プロセスを
        // 孤児誤判定するのを防ぐ。
        var env = ProcessInfo.processInfo.environment
        env["LC_ALL"] = "C"
        proc.environment = env
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        guard (try? proc.run()) != nil else { return "" }
        proc.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
