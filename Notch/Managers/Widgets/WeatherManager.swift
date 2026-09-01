import CoreLocation
import MapKit
import AppKit

/// Weather from Open-Meteo (no key, no account). Location via CoreLocation;
/// fetched on location update and when the unit preference changes.
@MainActor
@Observable
final class WeatherManager: NSObject, CLLocationManagerDelegate {

    private(set) var snapshot: WeatherSnapshot?
    private(set) var authorization: CLAuthorizationStatus = .notDetermined
    /// The last fetch failed and there is no snapshot to show — distinguishes
    /// "couldn't load" (offer Retry) from "still loading" in the widget.
    private(set) var fetchFailed = false

    private let settings: Settings
    private let manager = CLLocationManager()
    private let session = URLSession(configuration: .default)
    private var lastLocation: CLLocation?
    private var unitObserver: Task<Void, Never>?
    private var cadenceTask: Task<Void, Never>?
    private var fetchGeneration = 0

    init(settings: Settings) {
        self.settings = settings
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    func start() {
        authorization = manager.authorizationStatus
        // Fetch when we already have permission, but don't prompt at launch: that
        // stacks a dialog on top of the Focus prompt and reads as a freeze (the
        // reason CalendarManager defers). The widget's "Enable Location" affordance
        // requests access on demand instead.
        if Self.hasLocationAccess(authorization) {
            manager.requestLocation()
        }

        unitObserver = watch(initial: false, { [settings] in settings.temperatureUnit }) { [weak self] _ in
            guard let self, let location = self.lastLocation else { return }
            Task { await self.fetch(for: location) }
        }

        // Weather is otherwise a one-shot at launch: without a cadence the widget
        // presents the launch-time temperature as current forever. Coarse (15 min);
        // .common so it also fires while the run loop is tracking.
        cadenceTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15 * 60))
                self?.refresh()
            }
        }
    }

    /// Re-fetch for the last known location, or retry the location request if an
    /// earlier fix never landed. Driven by the cadence timer and by panel open, so
    /// a single transient CoreLocation failure isn't terminal.
    func refresh() {
        if let location = lastLocation {
            Task { await fetch(for: location) }
        } else if Self.hasLocationAccess(manager.authorizationStatus) {
            manager.requestLocation()
        }
    }

    /// Surface the location prompt on demand (the widget's "Enable" button).
    /// Accessory apps can't present the system prompt while backgrounded, so bring
    /// the app forward first — mirrors `CalendarManager.requestAccess`. Once the
    /// user has denied, macOS won't prompt again, so open the Location Services
    /// pane instead of silently doing nothing.
    func requestAccess() {
        NSApp.activate(ignoringOtherApps: true)
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices") {
                NSWorkspace.shared.open(url)
            }
        default:
            manager.requestLocation()
        }
    }

    // MARK: - CLLocationManagerDelegate

    // CLLocationManager delivers callbacks on the thread that created it (main,
    // since init runs on the main actor), so asserting isolation is safe and lets
    // the delegate conformance stay off the main actor.
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.authorization = status
            if Self.hasLocationAccess(status) {
                self.manager.requestLocation()
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        MainActor.assumeIsolated {
            lastLocation = location
            Task { await fetch(for: location) }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Log.widgets.error("Location error: \(error.localizedDescription)")
    }

    // MARK: - Fetch

    private func fetch(for location: CLLocation) async {
        fetchGeneration += 1
        let generation = fetchGeneration
        let unit = settings.temperatureUnit
        var components = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
        components.queryItems = [
            .init(name: "latitude", value: String(location.coordinate.latitude)),
            .init(name: "longitude", value: String(location.coordinate.longitude)),
            .init(name: "current", value: "temperature_2m,apparent_temperature,weather_code,is_day"),
            .init(name: "daily", value: "weather_code,temperature_2m_max,temperature_2m_min"),
            .init(name: "timezone", value: "auto"),
            .init(name: "forecast_days", value: "5"),
            .init(name: "temperature_unit", value: unit == .celsius ? "celsius" : "fahrenheit"),
        ]
        guard let url = components.url else { return }

        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
                throw URLError(.badServerResponse)
            }
            let forecast = try JSONDecoder().decode(OpenMeteoResponse.self, from: data)
            let placeName = await cityName(for: location)
            guard generation == fetchGeneration else { return }
            apply(forecast, unit: unit, placeName: placeName)
            fetchFailed = false
        } catch {
            guard generation == fetchGeneration else { return }
            // A stale snapshot beats an error tile; only flag when there's nothing to show.
            fetchFailed = snapshot == nil
            Log.widgets.error("Weather fetch failed: \(error.localizedDescription)")
        }
    }

    /// Reverse-geocode to a city label via MapKit (CLGeocoder is deprecated as of
    /// macOS 26). Best-effort: the widget just omits the name when this fails.
    private func cityName(for location: CLLocation) async -> String? {
        guard let request = MKReverseGeocodingRequest(location: location) else { return nil }
        do {
            let items = try await request.mapItems
            return items.first?.addressRepresentations?.cityName ?? items.first?.name
        } catch {
            Log.widgets.error("Reverse geocoding failed: \(error.localizedDescription)")
            return nil
        }
    }

    private func apply(_ response: OpenMeteoResponse, unit: WeatherSnapshot.TemperatureUnit, placeName: String?) {
        let isDay = response.current.is_day == 1
        let dayFormatter = DateFormatter()
        // POSIX locale + Gregorian calendar so "yyyy-MM-dd" parses regardless of the
        // user's system calendar (a non-Gregorian one would parse the year wrong).
        dayFormatter.locale = Locale(identifier: "en_US_POSIX")
        dayFormatter.calendar = Calendar(identifier: .gregorian)
        dayFormatter.dateFormat = "yyyy-MM-dd"

        // Index only across what every parallel array actually holds: a shorter
        // weather_code / min / max array (partial data, API change) would otherwise
        // be an out-of-bounds crash on untrusted network input.
        let daily = response.daily
        let count = min(daily.time.count, daily.weather_code.count,
                        daily.temperature_2m_max.count, daily.temperature_2m_min.count)
        let days: [WeatherDay] = (0..<count).compactMap { index in
            guard let date = dayFormatter.date(from: daily.time[index]) else { return nil }
            let code = daily.weather_code[index]
            return WeatherDay(
                date: date,
                high: daily.temperature_2m_max[index],
                low: daily.temperature_2m_min[index],
                weatherCode: code,
                symbolName: WMO.symbol(for: code, isDay: true)
            )
        }

        snapshot = WeatherSnapshot(
            temperature: response.current.temperature_2m,
            apparentTemperature: response.current.apparent_temperature,
            weatherCode: response.current.weather_code,
            isDay: isDay,
            symbolName: WMO.symbol(for: response.current.weather_code, isDay: isDay),
            conditionText: WMO.text(for: response.current.weather_code),
            locationName: placeName,
            unit: unit,
            daily: days
        )
    }

    nonisolated private static func hasLocationAccess(_ status: CLAuthorizationStatus) -> Bool {
        status == .authorizedAlways
    }
}

private struct OpenMeteoResponse: Decodable {
    let current: Current
    let daily: Daily

    struct Current: Decodable {
        let temperature_2m: Double
        let apparent_temperature: Double?
        let weather_code: Int
        let is_day: Int
    }
    struct Daily: Decodable {
        let time: [String]
        let weather_code: [Int]
        let temperature_2m_max: [Double]
        let temperature_2m_min: [Double]
    }
}

/// WMO weather-code → semantic pixel-icon keys + text (no Apple condition enum).
enum WMO {
    static func symbol(for code: Int, isDay: Bool) -> String {
        switch code {
        case 0: return isDay ? "sun.max.fill" : "moon.stars.fill"
        case 1, 2: return isDay ? "cloud.sun.fill" : "cloud.moon.fill"
        case 3: return "cloud.fill"
        case 45, 48: return "cloud.fog.fill"
        case 51, 53, 55, 56, 57: return "cloud.drizzle.fill"
        case 61, 63, 65, 66, 67: return "cloud.rain.fill"
        case 71, 73, 75, 77: return "cloud.snow.fill"
        case 80, 81, 82: return "cloud.heavyrain.fill"
        case 85, 86: return "cloud.snow.fill"
        case 95: return "cloud.bolt.fill"
        case 96, 99: return "cloud.bolt.rain.fill"
        default: return "cloud.fill"
        }
    }

    static func text(for code: Int) -> String {
        switch code {
        case 0: return "Clear"
        case 1, 2: return "Partly cloudy"
        case 3: return "Overcast"
        case 45, 48: return "Fog"
        case 51, 53, 55: return "Drizzle"
        case 56, 57: return "Freezing drizzle"
        case 61, 63, 65: return "Rain"
        case 66, 67: return "Freezing rain"
        case 71, 73, 75, 77: return "Snow"
        case 80, 81, 82: return "Rain showers"
        case 85, 86: return "Snow showers"
        case 95: return "Thunderstorm"
        case 96, 99: return "Thunderstorm, hail"
        default: return "—"
        }
    }
}
