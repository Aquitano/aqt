import SwiftUI
import NotchCore

/// The expanded home dashboard: a compact row of status tiles above a wider row
/// of info panels, both driven by the ordered `Settings.widgetLayout`. Hovering
/// the grid reveals an Edit toggle; edit mode swaps the live widgets for layout
/// tiles that can be dragged to reorder, removed, or added back. Reordering uses
/// a plain drag gesture (never a system drag session) because the panel is a
/// registered tray drop target and a real drag would flip it into drop mode.
struct WidgetGridView: View {
    @Environment(Settings.self) private var settings
    @Environment(BluetoothBatteryManager.self) private var bluetooth
    @Environment(FocusManager.self) private var focus
    @Environment(WeatherManager.self) private var weather
    @Environment(CalendarManager.self) private var calendar
    @Environment(BatteryManager.self) private var battery

    @Environment(\.notchDisplayKey) private var displayKey

    @State private var isEditing = false
    @State private var isHoveringGrid = false
    @State private var draggedKind: WidgetKind?
    @State private var dragOffset: CGFloat = 0

    private let spacing: CGFloat = 10

    var body: some View {
        VStack(spacing: spacing) {
            if isEditing {
                editRow(.status)
                    .frame(height: 80)
                editRow(.info)
                    .frame(maxHeight: .infinity)
            } else {
                liveGrid
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .overlay(alignment: .bottomTrailing) { editToggle }
        .onHover { isHoveringGrid = $0 }
        .contextMenu {
            Button(isEditing ? "Done Editing" : "Edit Widgets…") { toggleEditing() }
        }
        .onAppear {
            bluetooth.refresh()
            focus.refresh()
            weather.refresh()
            calendar.refresh()
        }
    }

    private func toggleEditing() {
        withAnimation(NotchAnimation.reorder) {
            isEditing.toggle()
            draggedKind = nil
            dragOffset = 0
        }
    }

    // MARK: - Live widgets

    @ViewBuilder
    private var liveGrid: some View {
        let status = visibleKinds(in: .status)
        let info = visibleKinds(in: .info)

        if !status.isEmpty {
            HStack(spacing: spacing) {
                ForEach(status) { widgetView($0) }
            }
            .frame(height: 80)
        }
        if info.isEmpty {
            emptyHint
                .frame(maxHeight: .infinity)
        } else {
            HStack(spacing: spacing) {
                ForEach(info) { widgetView($0) }
            }
            .frame(maxHeight: .infinity)
        }
    }

    private func visibleKinds(in row: WidgetKind.Row) -> [WidgetKind] {
        settings.widgetLayout(for: displayKey).filter { $0.row == row && isAvailable($0) }
    }

    /// Hardware-bound tiles stay in the layout but only render when the machine
    /// actually has something to show.
    private func isAvailable(_ kind: WidgetKind) -> Bool {
        switch kind {
        case .battery: battery.hasBattery
        case .bluetooth: !bluetooth.devices.isEmpty
        default: true
        }
    }

    @ViewBuilder
    private func widgetView(_ kind: WidgetKind) -> some View {
        switch kind {
        case .battery: BatteryWidgetView()
        case .clock: ClockWidgetView()
        case .focus: FocusWidgetView()
        case .bluetooth: BluetoothWidgetView()
        case .weather: WeatherWidgetView()
        case .calendar: CalendarWidgetView()
        case .shortcuts: ShortcutsWidgetView()
        case .note: NoteWidgetView()
        }
    }

    private var emptyHint: some View {
        Button {
            toggleEditing()
        } label: {
            VStack(spacing: 6) {
                PixelIcon(systemName: "square.grid.2x2", size: 22,
                          tint: .white.opacity(0.4))
                Text("No widgets enabled")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.7))
                Text("Click to add Weather, Calendar, Shortcuts, or a note.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.45))
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Edit mode

    private var editToggle: some View {
        Button {
            Haptics.tap(.levelChange)
            toggleEditing()
        } label: {
            PixelIcon(systemName: isEditing ? "checkmark" : "pencil", size: 12,
                      tint: .white.opacity(isEditing ? 0.9 : 0.6))
                .frame(width: 24, height: 24)
                .glassEffect(.regular, in: .circle)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isEditing ? "Done editing widgets" : "Edit widgets")
        .opacity(isEditing || isHoveringGrid ? 1 : 0)
        .offset(x: 4, y: 8)
        .animation(.easeOut(duration: 0.15), value: isHoveringGrid)
    }

    /// One row of layout tiles: enabled kinds first (draggable, removable), then
    /// the row's disabled kinds as dimmed add targets. All four kinds of a row
    /// are always present, so slot widths stay stable while editing.
    private func editRow(_ row: WidgetKind.Row) -> some View {
        GeometryReader { geo in
            let enabled = settings.widgetLayout(for: displayKey).filter { $0.row == row }
            let disabled = WidgetKind.allCases.filter { $0.row == row && !enabled.contains($0) }
            let count = enabled.count + disabled.count
            let slot = (geo.size.width - spacing * CGFloat(count - 1)) / CGFloat(count) + spacing

            HStack(spacing: spacing) {
                ForEach(enabled) { kind in
                    editTile(kind, enabled: true)
                        .offset(x: kind == draggedKind ? dragOffset : 0)
                        .offset(x: shift(for: kind, in: enabled, slot: slot))
                        .animation(NotchAnimation.reorder, value: shift(for: kind, in: enabled, slot: slot))
                        .zIndex(kind == draggedKind ? 1 : 0)
                        .gesture(dragGesture(for: kind, in: enabled, slot: slot))
                }
                ForEach(disabled) { kind in
                    editTile(kind, enabled: false)
                }
            }
        }
    }

    private func editTile(_ kind: WidgetKind, enabled: Bool) -> some View {
        Button {
            guard !enabled else { return }
            Haptics.tap(.levelChange)
            withAnimation(NotchAnimation.reorder) { settings.setWidget(kind, enabled: true, on: displayKey) }
        } label: {
            VStack(spacing: 6) {
                PixelIcon(systemName: kind.symbol, size: 18,
                          tint: .white.opacity(enabled ? 0.9 : 0.35))
                Text(kind.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(enabled ? 0.8 : 0.35))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background {
            if enabled {
                RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                    .fill(.white.opacity(0.08))
            } else {
                RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                    .strokeBorder(.white.opacity(0.2), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
        }
        .overlay(alignment: .topTrailing) {
            Button {
                Haptics.tap(.levelChange)
                withAnimation(NotchAnimation.reorder) { settings.setWidget(kind, enabled: !enabled, on: displayKey) }
            } label: {
                PixelIcon(systemName: enabled ? "minus.circle.fill" : "plus.circle.fill",
                          size: 14, tint: .white.opacity(enabled ? 0.7 : 0.5))
                    .padding(5)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(enabled ? "Remove \(kind.title)" : "Add \(kind.title)")
        }
        .accessibilityLabel("\(kind.title) widget, \(enabled ? "enabled" : "disabled")")
    }

    // MARK: - Reordering

    /// How far a non-dragged tile in the dragged tile's row should slide to open
    /// up the slot the drag currently targets.
    private func shift(for kind: WidgetKind, in enabled: [WidgetKind], slot: CGFloat) -> CGFloat {
        guard let dragged = draggedKind, dragged != kind, dragged.row == kind.row,
              let from = enabled.firstIndex(of: dragged),
              let index = enabled.firstIndex(of: kind) else { return 0 }
        let target = targetIndex(from: from, count: enabled.count, slot: slot)
        if from < index, index <= target { return -slot }
        if target <= index, index < from { return slot }
        return 0
    }

    private func targetIndex(from: Int, count: Int, slot: CGFloat) -> Int {
        let slots = Int((dragOffset / slot).rounded())
        return max(0, min(count - 1, from + slots))
    }

    private func dragGesture(for kind: WidgetKind, in enabled: [WidgetKind], slot: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                draggedKind = kind
                dragOffset = value.translation.width
            }
            .onEnded { value in
                let slots = Int((value.translation.width / slot).rounded())
                withAnimation(NotchAnimation.reorder) {
                    settings.moveWidget(kind, by: slots, on: displayKey)
                    draggedKind = nil
                    dragOffset = 0
                }
            }
    }
}
