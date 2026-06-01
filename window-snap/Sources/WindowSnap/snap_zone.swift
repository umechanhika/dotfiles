import CoreGraphics

/// スナップ先のゾーン。判定は全て CG global(左上原点・Y下) で行う。
enum SnapZone {
    case top                                        // 上端中央 → visibleFrame 全面（最大化）
    case left, right                                // 左右半分
    case topLeft, topRight, bottomLeft, bottomRight // 1/4

    /// 端到達判定の帯の太さ(pt)。カーソルが画面端からこの距離以内なら「その辺に到達」とみなす。
    /// カーソルは画面の物理端でクランプされるので、6pt あれば端に押し付けたとき確実に反応する。
    static let EDGE_THRESHOLD: CGFloat = 6
    /// 隅の帯の幅(pt)。端に到達したうえで、角からこの距離以内にいれば隅(1/4)に倒す。
    static let CORNER_BAND: CGFloat = 120

    /// カーソル(CG global)と、その画面の frame(CG global)からゾーンを判定する。
    /// どの端にも到達していなければ nil（＝スナップしない）。
    ///
    /// モデル: 「いずれかの端に到達したか」で発動を決め、「その辺に沿ったどの位置か」でゾーンを選ぶ。
    /// これにより隅は CORNER_BAND 幅の扱いやすい領域になる（角ぴったりでなくてよい）。
    static func zone(forCursorGlobal p: CGPoint, screenFrameGlobal f: CGRect) -> SnapZone? {
        let atLeft   = p.x <= f.minX + EDGE_THRESHOLD
        let atRight  = p.x >= f.maxX - EDGE_THRESHOLD
        let atTop    = p.y <= f.minY + EDGE_THRESHOLD   // CG global は上ほど y が小さい
        let atBottom = p.y >= f.maxY - EDGE_THRESHOLD

        // どの端にも到達していなければスナップしない。
        guard atLeft || atRight || atTop || atBottom else { return nil }

        let inTopBand    = p.y <= f.minY + CORNER_BAND
        let inBottomBand = p.y >= f.maxY - CORNER_BAND
        let inLeftBand   = p.x <= f.minX + CORNER_BAND
        let inRightBand  = p.x >= f.maxX - CORNER_BAND

        // 上端に到達: 左寄り→topLeft / 右寄り→topRight / それ以外は全幅で top(最大化)。
        // （上端は隅 120pt を除いて全てを最大化の対象にする＝デッドゾーンを作らない）
        if atTop {
            if inLeftBand  { return .topLeft }
            if inRightBand { return .topRight }
            return .top
        }

        // 下端に到達: 左寄り→bottomLeft / 右寄り→bottomRight / 中央→なし（要件外・Dock 干渉回避）。
        if atBottom {
            if inLeftBand  { return .bottomLeft }
            if inRightBand { return .bottomRight }
            return nil
        }

        // 左端に到達: 上寄り→topLeft / 下寄り→bottomLeft / 中央→left。
        if atLeft {
            if inTopBand    { return .topLeft }
            if inBottomBand { return .bottomLeft }
            return .left
        }

        // 右端に到達: 上寄り→topRight / 下寄り→bottomRight / 中央→right。
        if atRight {
            if inTopBand    { return .topRight }
            if inBottomBand { return .bottomRight }
            return .right
        }

        return nil
    }
}
