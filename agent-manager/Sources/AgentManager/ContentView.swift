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
        .background(hovering ? Color.primary.opacity(0.08) : Color.clear)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { ITermFocus.focus(session: session) }
        .help(session.cwd)
    }
}
