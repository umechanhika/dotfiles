import SwiftUI

/// フローティング窓に表示するセッション一覧。
struct ContentView: View {
    @ObservedObject var store: SessionStore

    /// 1 行の固定高さ。行密度を一定に保つために決め打ちする。
    private let rowHeight: CGFloat = 32

    private var waitingCount: Int { store.sessions.filter { $0.needsAttention }.count }

    var body: some View {
        VStack(spacing: 0) {
            HeaderBar(total: store.sessions.count, waiting: waitingCount)

            if store.sessions.isEmpty {
                Text("セッションなし")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 8)
            } else {
                Divider().opacity(0.35)
                // ScrollView は使わない。SwiftUI の ScrollView は内部に NSScrollView を
                // 挿入し、行がその document view 内に入るため、フローティングパネルの
                // 「1回目のクリックを中身へ届ける」acceptsFirstMouse(ClickThroughHostingView)
                // が効かなくなる（1回目＝窓のアクティブ化、2回目＝タップ発火になってしまう）。
                // 素の VStack なら中身がホスティングビュー直下に来るので 1 クリックで反応する。
                // 窓は中身の高さに追従して伸びる（改修前と同じ挙動）。
                VStack(spacing: 0) {
                    ForEach(store.sessions) { session in
                        SessionRow(session: session, height: rowHeight)
                    }
                }
                .padding(.vertical, 2)
            }
        }
        .frame(width: 220)
        .background(.ultraThinMaterial)
    }
}

/// 件数サマリと、ドラッグの掴み所を兼ねたグリップを並べたヘッダ。
private struct HeaderBar: View {
    let total: Int
    let waiting: Int

    var body: some View {
        ZStack {
            // 中央のグリップ。窓は背景ドラッグで動かせるので「掴める」ことを示す。
            Capsule()
                .fill(Color.primary.opacity(0.18))
                .frame(width: 26, height: 3)

            HStack(spacing: 4) {
                Text("\(total) 件")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.secondary)
                if waiting > 0 {
                    Text("· \(waiting) 待ち")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Session.amber)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 5)
        .padding(.bottom, 4)
    }
}

private struct SessionRow: View {
    let session: Session
    let height: CGFloat
    @State private var hovering = false
    @State private var pressed = false
    @State private var flash: Double = 0   // ステータス変化時のハイライト強度（0…1）

    var body: some View {
        HStack(spacing: 8) {
            StatusDot(session: session)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.label)
                    // モノスペースにしてターミナル／パスの文脈と整合させ、走査しやすくする。
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .lineLimit(1)
                // 経過時間は TimelineView で30秒ごとに表示だけ更新する。
                // 基準時刻は「その状態が始まった時刻」(state_since)に固定する。
                // updated_at(=最終活動時刻)を使うと、処理中に hook が連続発火するたび、
                // また done のまま idle_prompt が来るたびに基準が「今」へリセットされ、
                // 経過が 0s から伸びない／途中で 0s に戻ってしまうため。
                // 状態が続く限り state_since は不変なので、ホバー等の再描画でも変わらない。
                TimelineView(.periodic(from: session.stateSinceDate ?? .distantPast, by: 30)) { context in
                    Text(statusText(now: context.date))
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if hovering {
                Text("↗")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: height)
        .background(session.color.opacity(flash * 0.22))          // 変化時の明滅（ステータス色・控えめ）
        .background(hovering ? Color.primary.opacity(0.08) : Color.clear)
        // 確認待ちの行は左端のアクセントストライプで焦点化する。
        .overlay(alignment: .leading) {
            if session.needsAttention {
                Rectangle()
                    .fill(session.color)
                    .frame(width: 2.5)
            }
        }
        .contentShape(Rectangle())
        .scaleEffect(pressed ? 0.97 : 1)
        .onHover { hovering in
            withAnimation(.easeOut(duration: 0.12)) { self.hovering = hovering }
        }
        .onTapGesture {
            // 押した手応えを出してから前面化する。
            withAnimation(.easeOut(duration: 0.08)) { pressed = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                withAnimation(.easeOut(duration: 0.12)) { pressed = false }
            }
            ITermFocus.focus(session: session)
        }
        .onChange(of: session.state) { _ in flashHighlight() }
        .help(session.cwd)
    }

    /// 「待機 · 4m」のように状態名＋経過時間を組み立てる。
    private func statusText(now: Date) -> String {
        guard let since = session.stateSinceDate else { return session.stateLabel }
        return "\(session.stateLabel) · \(Self.shortElapsed(from: since, to: now))"
    }

    /// 経過秒を 30s / 4m / 2h / 1d のように短く整形。
    private static func shortElapsed(from date: Date, to now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(date)))
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return "\(h)h" }
        return "\(h / 24)d"
    }

    /// ステータスが変わった行をステータス色で数回明滅させてから消す。
    private func flashHighlight() {
        flash = 1
        withAnimation(.easeInOut(duration: 0.4).repeatCount(3, autoreverses: true)) {
            flash = 0.15
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4 * 3) {
            withAnimation(.easeOut(duration: 0.35)) { flash = 0 }
        }
    }
}

/// 状態に応じて振る舞いが変わるステータスドット。
/// - 確認待ち: ユーザー操作が必要な唯一の状態なので、広がって消えるハロー（脈動）で注意を引く。
/// - 処理中:   "動いている" ことが伝わる穏やかな呼吸アニメ。
/// - 完了/待機: 静止。
private struct StatusDot: View {
    let session: Session
    @State private var animate = false

    var body: some View {
        ZStack {
            // 確認待ちのときだけ出る、広がって薄くなるハロー。
            if session.needsAttention {
                Circle()
                    .fill(session.color)
                    .frame(width: 8, height: 8)
                    .scaleEffect(animate ? 2.2 : 1)
                    .opacity(animate ? 0 : 0.55)
            }
            Circle()
                .fill(session.color)
                .frame(width: 8, height: 8)
                .scaleEffect(session.isActive && animate ? 0.8 : 1)
                .opacity(session.isActive && animate ? 0.45 : 1)
        }
        .frame(width: 8, height: 8)
        .onAppear { restartAnimation() }
        .onChange(of: session.state) { _ in restartAnimation() }
    }

    private func restartAnimation() {
        // いったん止めてから状態に応じたアニメを張り直す。
        withAnimation(.easeOut(duration: 0.2)) { animate = false }
        if session.needsAttention {
            withAnimation(.easeOut(duration: 1.3).repeatForever(autoreverses: false)) {
                animate = true
            }
        } else if session.isActive {
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                animate = true
            }
        }
    }
}
