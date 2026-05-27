import SwiftUI

/// フローティング窓に表示するセッション一覧。
struct ContentView: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if store.sessions.isEmpty {
                Text("セッションなし")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 8)
            } else {
                ForEach(store.sessions) { session in
                    SessionRow(session: session)
                }
            }
        }
        .frame(width: 220)
        .padding(.vertical, 4)
        .background(.ultraThinMaterial)
    }
}

private struct SessionRow: View {
    let session: Session
    @State private var hovering = false
    @State private var flash: Double = 0   // ステータス変化時のハイライト強度（0…1）

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(session.color)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.label)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                Text(session.stateLabel)
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
        .background(session.color.opacity(flash * 0.22))          // 変化時の明滅（ステータス色・控えめ）
        .background(hovering ? Color.primary.opacity(0.08) : Color.clear)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { ITermFocus.focus(session: session) }
        .onChange(of: session.state) { _ in flashHighlight() }
        .help(session.cwd)
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
