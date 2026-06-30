import SwiftUI

/// The black "blob": a downward-opening rounded rectangle whose top corners are
/// square (they meet the bezel) and whose bottom corners are animatably rounded.
/// Interpolating `bottomRadius`/`size` is what makes the notch morph feel liquid.
struct NotchShape: Shape {
    var topRadius: CGFloat
    var bottomRadius: CGFloat

    /// Physical notch width. The concave top shoulders inset the body by the top
    /// radius on each side, so the *visible* body is narrower than `rect.width`.
    /// Scaling that inset with the width does two things for the close:
    ///
    /// 1. The body never thins below `notchWidth`, so a collapsing blob can't dangle
    ///    under the bezel as a sliver with wallpaper showing on both sides, and it
    ///    keeps narrowing all the way in (no plateau where the sides freeze while
    ///    the height is still retracting).
    /// 2. It narrows the gap between how fast the width and the height collapse. The
    ///    width travels 540->185 (355pt) while the height travels 329->33 (296pt) in
    ///    the same time, so a fixed shoulder makes the width visibly outrun the
    ///    height. `shoulder = (width - notchWidth)/18` shrinks the *visible* body
    ///    sweep to ~316pt — about halfway to the height's 296pt — so the two edges
    ///    move at closer to the same speed without flaring the expanded top corners
    ///    too far (~20pt at 540 wide). The body still reaches `notchWidth` exactly
    ///    when the width does, so they still land together.
    var notchWidth: CGFloat = 0

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(topRadius, bottomRadius) }
        set { topRadius = newValue.first; bottomRadius = newValue.second }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let tr: CGFloat = notchWidth > 0
            ? NotchMetrics.shoulderInset(width: rect.width, notchWidth: notchWidth)
            : min(topRadius, rect.width / 2)
        let br = min(bottomRadius, min(rect.width, rect.height) / 2)

        // Start under the top-left, flush to the bezel.
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))

        // Small concave shoulder into the notch on the left.
        path.addQuadCurve(
            to: CGPoint(x: rect.minX + tr, y: rect.minY + tr),
            control: CGPoint(x: rect.minX + tr, y: rect.minY)
        )

        // Down the left edge to the bottom-left rounded corner.
        path.addLine(to: CGPoint(x: rect.minX + tr, y: rect.maxY - br))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX + tr + br, y: rect.maxY),
            control: CGPoint(x: rect.minX + tr, y: rect.maxY)
        )

        // Across the bottom to the bottom-right rounded corner.
        path.addLine(to: CGPoint(x: rect.maxX - tr - br, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX - tr, y: rect.maxY - br),
            control: CGPoint(x: rect.maxX - tr, y: rect.maxY)
        )

        // Up the right edge to the concave shoulder.
        path.addLine(to: CGPoint(x: rect.maxX - tr, y: rect.minY + tr))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX, y: rect.minY),
            control: CGPoint(x: rect.maxX - tr, y: rect.minY)
        )

        path.closeSubpath()
        return path
    }
}
